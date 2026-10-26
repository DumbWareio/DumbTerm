/**
 * Unit tests for public/service-worker.js.
 * Runs the real worker script in a vm sandbox with in-memory stand-ins for caches, fetch and clients,
 * then dispatches fetch and activate events to it.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'service-worker.js'), 'utf8');
const ORIGIN = 'http://dumbterm.test/';

function fakeResponse(body, { status = 200, type = 'basic', redirected = false } = {}) {
    return { body, status, type, redirected, ok: status === 200, clone() { return this; }, json: async () => JSON.parse(body) };
}

// Load the worker as the browser would register it (service-worker.js?v=<version>)
function loadWorker({ version = '1.3.0', network = async () => fakeResponse('network'), cacheNames = [] } = {}) {
    const store = new Map(cacheNames.map((name) => [name, new Map()]));
    const listeners = {};
    const fetchCalls = [];
    const openCache = (name) => {
        if (!store.has(name)) store.set(name, new Map());
        const entries = store.get(name);
        return {
            put: async (request, response) => { entries.set(request.url, response); },
            addAll: async (urls) => urls.forEach((url) => entries.set(url, fakeResponse(url))),
        };
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        URL,
        Response: class { constructor(body, init) { Object.assign(this, { body, ...init }); } },
        setTimeout: (fn) => fn(),
        fetch: async (request) => {
            const url = typeof request === 'string' ? request : request.url;
            fetchCalls.push(url);
            if (url.endsWith('config.js')) return fakeResponse(`window.appConfig = {"version":"${version}"};`);
            if (url.endsWith('asset-manifest.json')) return fakeResponse('[]');
            return network(request);
        },
        caches: {
            open: async (name) => openCache(name),
            keys: async () => [...store.keys()],
            delete: async (name) => store.delete(name),
            match: async (request) => {
                const url = typeof request === 'string' ? request : request.url;
                for (const entries of store.values()) if (entries.has(url)) return entries.get(url);
                return undefined;
            },
        },
        self: {
            location: { href: `${ORIGIN}service-worker.js?v=${version}` },
            registration: { scope: ORIGIN },
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: async () => {},
            clients: { claim: async () => {}, matchAll: async () => [] },
        },
    };
    vm.runInNewContext(WORKER_SOURCE, sandbox);
    return { listeners, store, fetchCalls };
}

// Dispatch a fetch event; resolves with the response the worker chose, or null if it did not respond
async function dispatchFetch(worker, request) {
    let responded = null;
    const pending = [];
    worker.listeners.fetch({
        request,
        respondWith(promise) { responded = promise; },
        waitUntil(promise) { pending.push(promise); },
    });
    const response = responded ? await responded : null;
    await Promise.all(pending);
    return response;
}

const get = (url, extra = {}) => ({ method: 'GET', url: ORIGIN + url, mode: 'cors', ...extra });

describe('service worker fetch handling', () => {
    test('answers from the network even when an older copy is cached', async () => {
        const worker = loadWorker({ cacheNames: ['DUMBTERM_CACHE_V1.3.0'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'config.js', fakeResponse('stale'));
        const response = await dispatchFetch(worker, get('config.js'));
        assert.notEqual(response.body, 'stale');
    });

    test('caches network responses under the version it was registered with', async () => {
        const worker = loadWorker({ version: '1.3.0' });
        await dispatchFetch(worker, get('index.js'));
        assert.deepEqual([...worker.store.keys()], ['DUMBTERM_CACHE_V1.3.0']);
        assert.equal(worker.store.get('DUMBTERM_CACHE_V1.3.0').get(ORIGIN + 'index.js').body, 'network');
    });

    test('falls back to the cache when the network fails', async () => {
        const worker = loadWorker({ network: async () => { throw new TypeError('offline'); }, cacheNames: ['DUMBTERM_CACHE_V1.3.0'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('cached'));
        const response = await dispatchFetch(worker, get('index.js'));
        assert.equal(response.body, 'cached');
    });

    test('does not cache redirected or failed responses', async () => {
        const worker = loadWorker({
            network: async (request) => request.url.endsWith('redirected.js')
                ? fakeResponse('login page', { redirected: true })
                : fakeResponse('error', { status: 500 }),
        });
        await dispatchFetch(worker, get('redirected.js'));
        await dispatchFetch(worker, get('broken.js'));
        const cached = [...worker.store.values()].flatMap((entries) => [...entries.keys()]);
        assert.deepEqual(cached, []);
    });

    test('leaves non-GET requests to the browser', async () => {
        const worker = loadWorker();
        const response = await dispatchFetch(worker, { method: 'POST', url: ORIGIN + 'verify-pin', mode: 'cors' });
        assert.equal(response, null);
        assert.deepEqual(worker.fetchCalls, []);
    });
});

describe('service worker activation', () => {
    test('deletes caches left by earlier versions', async () => {
        const worker = loadWorker({ version: '1.3.0', cacheNames: ['DUMBTERM_CACHE_V1.2.0', 'DUMBTERM_CACHE_V1.0.0', 'unrelated-cache'] });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
        const names = [...worker.store.keys()].sort();
        assert.deepEqual(names, ['DUMBTERM_CACHE_V1.3.0', 'unrelated-cache']);
    });
});
