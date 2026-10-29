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

// Load the worker as the browser would register it (service-worker.js?v=<version>).
// `server.manifest` is what assets/asset-manifest.json lists, and `server.manifestStatus` its HTTP status;
// tests can change either between steps, and hold the manifest's answer back by setting `server.manifestHeld`
// to a promise. Messages the worker posts to its one page land in `messages`.
function loadWorker({ version = '1.3.0', network = async () => fakeResponse('network'), cacheNames = [], manifest = [], manifestStatus = 200 } = {}) {
    const store = new Map(cacheNames.map((name) => [name, new Map()]));
    const listeners = {};
    const fetchCalls = [];
    const messages = [];
    const server = { manifest, manifestStatus };
    const fetch = async (request) => {
        const url = typeof request === 'string' ? request : request.url;
        fetchCalls.push(url);
        if (url.endsWith('config.js')) return fakeResponse(`window.appConfig = {"version":"${version}"};`);
        if (url.endsWith('asset-manifest.json')) {
            await server.manifestHeld;
            return fakeResponse(JSON.stringify(server.manifest), { status: server.manifestStatus });
        }
        return network(request);
    };
    const openCache = (name) => {
        if (!store.has(name)) store.set(name, new Map());
        const entries = store.get(name);
        return {
            put: async (request, response) => { entries.set(request.url, response); },
            // As in Chromium: a URL listed twice rejects the whole call, and so does any failed response,
            // in which case nothing is stored
            addAll: async (urls) => {
                if (new Set(urls).size !== urls.length) throw new TypeError("Failed to execute 'addAll' on 'Cache': duplicate requests");
                const responses = await Promise.all(urls.map((url) => fetch(url)));
                if (responses.some((response) => !response.ok)) throw new TypeError('Request failed');
                urls.forEach((url, i) => entries.set(url, responses[i]));
            },
        };
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        URL,
        Response: class { constructor(body, init) { Object.assign(this, { body, ...init }); } },
        setTimeout: (fn) => fn(),
        fetch,
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
            clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message) => messages.push(message) }] },
        },
    };
    vm.runInNewContext(WORKER_SOURCE, sandbox);
    return { listeners, store, fetchCalls, messages, server };
}

// The worker posts some messages from promise callbacks it does not wait for; let those run
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function activate(worker) {
    const pending = [];
    worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    await settle();
}

// What the page sends when the user picks Update Now on the worker's own UPDATE_AVAILABLE
async function performUpdate(worker) {
    await worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
    await settle();
}

const cacheSizes = (worker) => Object.fromEntries([...worker.store].map(([name, entries]) => [name, entries.size]));
const failures = (worker) => worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE' && message.success === false);

// Wait until the worker has asked for the manifest `count` times
async function manifestRequested(worker, count = 1) {
    for (let i = 0; i < 100 && worker.fetchCalls.filter((url) => url.endsWith('asset-manifest.json')).length < count; i++) await settle();
}

// The URLs a cache holds, in a stable order
const cachedUrls = (worker, name) => [...(worker.store.get(name)?.keys() ?? [])].sort();

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

    test('keeps the current version\'s cache and its entries', async () => {
        const worker = loadWorker({ version: '1.3.0', cacheNames: ['DUMBTERM_CACHE_V1.3.0', 'DUMBTERM_CACHE_V1.2.0'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('kept'));
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
        assert.equal(worker.store.get('DUMBTERM_CACHE_V1.3.0')?.get(ORIGIN + 'index.js')?.body, 'kept');
    });

    test('deletes nothing when registered without a release version', async () => {
        // The page falls back to ?v=<timestamp> when config.js could not be read
        const worker = loadWorker({ version: '1730000000000', cacheNames: ['DUMBTERM_CACHE_V1.2.0'] });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
        assert.ok(worker.store.has('DUMBTERM_CACHE_V1.2.0'));
    });

    test('an upgrade fills the new version\'s cache with the manifest\'s assets and deletes the old one', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html', 'index.js'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.1': 2 });
        assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_V1.3.1'), [ORIGIN + 'index.html', ORIGIN + 'index.js']);
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO'
            && message.currentVersion === '1.3.1' && message.cacheName === 'DUMBTERM_CACHE_V1.3.1'));
        // UPDATE_COMPLETE is for Update Now: the page reloads on success and shows a notice on failure
        assert.deepEqual(worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE'), []);
    });

    test('a first install fills its cache', async () => {
        const worker = loadWorker({ version: '1.3.0', manifest: ['index.html', 'index.js'] });
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.0': 2 });
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO' && message.currentVersion === '1.3.0'));
    });

    test('an upgrade whose manifest request fails keeps the old cache and tells no page', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifestStatus: 500 });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.0': 1 });
        assert.deepEqual(failures(worker), []);
        // The page still learns which version it runs
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO' && message.currentVersion === '1.3.1'));
    });

    test('an upgrade whose asset requests fail keeps the old cache and tells no page', async () => {
        const worker = loadWorker({
            version: '1.3.1',
            cacheNames: ['DUMBTERM_CACHE_V1.3.0'],
            manifest: ['index.html', 'index.js'],
            network: async () => fakeResponse('error', { status: 503 }),
        });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await activate(worker);
        assert.equal(worker.store.get('DUMBTERM_CACHE_V1.3.0')?.get(ORIGIN + 'index.js')?.body, 'old');
        assert.deepEqual(failures(worker), []);
    });

    test('a later version deletes every older cache, including one a failed upgrade left behind', async () => {
        // A failed 1.3.1 upgrade kept 1.3.0's cache, and the pages it served started a 1.3.1 cache
        const worker = loadWorker({ version: '1.3.2', cacheNames: ['DUMBTERM_CACHE_V1.3.0', 'DUMBTERM_CACHE_V1.3.1'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('partial'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.2': 1 });
    });

    test('fills the current version\'s cache when older caches show its last fill failed', async () => {
        // The same release activating again (a new worker script) after a failed fill, with the
        // pages having started the current cache since
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0', 'DUMBTERM_CACHE_V1.3.1'], manifest: ['index.html', 'styles.css'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('fetched'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.1': 3 });
    });

    test('does not refill a current cache that is the only one', async () => {
        const worker = loadWorker({ version: '1.3.0', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html'] });
        await activate(worker);
        assert.ok(!worker.fetchCalls.some((url) => url.endsWith('asset-manifest.json')));
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO' && message.currentVersion === '1.3.0'));
    });

    test('keeps the cache it filled when a page sends another version during the fill', async () => {
        // A second tab loading the offline copy of 1.3.2 while 1.3.3 activates
        let release;
        const worker = loadWorker({ version: '1.3.3', cacheNames: ['DUMBTERM_CACHE_V1.3.2'], manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        for (let i = 0; i < 100 && !worker.fetchCalls.some((url) => url.endsWith('asset-manifest.json')); i++) await settle();
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        release();
        await Promise.all(pending);
        await settle();
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.3': 2 });
        // What the fill tells the page describes the cache it filled
        const fillMessages = worker.messages.filter((message) => message.cacheName);
        assert.ok(fillMessages.length > 0);
        for (const message of fillMessages) {
            assert.deepEqual([message.currentVersion, message.cacheName], ['1.3.3', 'DUMBTERM_CACHE_V1.3.3']);
        }
    });

    test('a failed fill that a page\'s version overtook still names its own version', async () => {
        let release;
        const worker = loadWorker({ version: '1.3.3', cacheNames: ['DUMBTERM_CACHE_V1.3.2'], manifestStatus: 500 });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await manifestRequested(worker);
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        release();
        await Promise.all(pending);
        await settle();
        const fillMessages = worker.messages.filter((message) => message.cacheName);
        assert.ok(fillMessages.length > 0);
        for (const message of fillMessages) {
            assert.deepEqual([message.currentVersion, message.cacheName], ['1.3.3', 'DUMBTERM_CACHE_V1.3.3']);
        }
    });

    test('two fills for different versions at once leave a filled cache', async () => {
        // A first visit: 1.3.3 activates while a page still running 1.3.2 starts a fill of its own
        let release;
        const worker = loadWorker({ version: '1.3.3', manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await manifestRequested(worker);
        pending.push(worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } }));
        await manifestRequested(worker, 2);
        release();
        await Promise.all(pending);
        const names = [...worker.store.keys()];
        assert.ok(names.length > 0, 'no cache left');
        for (const name of names) assert.deepEqual(cachedUrls(worker, name), [ORIGIN + 'index.html', ORIGIN + 'index.js'], name);
    });

    test('deletes an older cache whatever its DumbTerm name looks like', async () => {
        // Builds from May 2025 named their cache without the V, and earlier ones DUMBTERM_PWA_CACHE_V<version>
        const worker = loadWorker({
            version: '1.3.1',
            cacheNames: ['DUMBTERM_CACHE_1.2.0', 'DUMBTERM_PWA_CACHE_V1.0.0', 'unrelated-cache'],
            manifest: ['index.html'],
        });
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'unrelated-cache': 0, 'DUMBTERM_CACHE_V1.3.1': 1 });
    });

    test('clears a cache with an older DumbTerm name left beside the current one', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_1.2.0', 'DUMBTERM_CACHE_V1.3.1'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.1').set(ORIGIN + 'index.html', fakeResponse('cached'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.1': 1 });
    });
});

describe('service worker Update Now', () => {
    test('fills the new cache, deletes the old one and reports success', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html'] });
        await performUpdate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.1': 1 });
        assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_V1.3.1'), [ORIGIN + 'index.html']);
        assert.ok(worker.messages.some((message) => message.type === 'UPDATE_COMPLETE' && message.success === true
            && message.version === '1.3.1' && message.cacheName === 'DUMBTERM_CACHE_V1.3.1'));
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO'
            && message.currentVersion === '1.3.1' && message.cacheName === 'DUMBTERM_CACHE_V1.3.1'));
    });

    test('reports a failed manifest request and keeps the old cache', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifestStatus: 500 });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await performUpdate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.0': 1 });
        assert.equal(failures(worker).length, 1);
        assert.match(failures(worker)[0].error, /500/);
        assert.deepEqual([failures(worker)[0].version, failures(worker)[0].cacheName], ['1.3.1', 'DUMBTERM_CACHE_V1.3.1']);
    });

    test('overlapping an activation fill of another version leaves a filled cache and reports success', async () => {
        // 1.3.3 activates; meanwhile a page running 1.3.2 sends its version, then the user picks Update Now
        let release;
        const worker = loadWorker({ version: '1.3.3', cacheNames: ['DUMBTERM_CACHE_V1.3.1'], manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await manifestRequested(worker);
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        pending.push(worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } }));
        await manifestRequested(worker, 2);
        release();
        await Promise.all(pending);
        await settle();
        const names = [...worker.store.keys()];
        assert.ok(names.length > 0, 'no cache left');
        for (const name of names) assert.deepEqual(cachedUrls(worker, name), [ORIGIN + 'index.html', ORIGIN + 'index.js'], name);
        assert.ok(worker.messages.some((message) => message.type === 'UPDATE_COMPLETE' && message.success === true));
    });

    test('clears the cache of a fill that failed earlier in the same worker', async () => {
        // 1.3.1's activation fill fails and its pages start a 1.3.1 cache; a page running 1.3.2 then asks for Update Now
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html'], manifestStatus: 500 });
        await activate(worker);
        await dispatchFetch(worker, get('index.js'));
        worker.server.manifestStatus = 200;
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        await performUpdate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_V1.3.2': 1 });
    });

    test('names the version it filled when a page sends another version during the fill', async () => {
        let release;
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const update = worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
        await manifestRequested(worker);
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        release();
        await update;
        await settle();
        const fillMessages = worker.messages.filter((message) => message.cacheName && message.type !== 'UPDATE_AVAILABLE');
        assert.ok(fillMessages.length > 0);
        for (const message of fillMessages) {
            assert.deepEqual([message.version ?? message.currentVersion, message.cacheName], ['1.3.1', 'DUMBTERM_CACHE_V1.3.1']);
        }
    });

    // The worker tells every tab how a fill went, so each answer names the request it answers, and a tab can tell
    // its own Update Now's answer from another tab's
    for (const [outcome, manifestStatus, success] of [['succeeds', 200, true], ['fails', 500, false]]) {
        test(`names the request it answers when the fill ${outcome}`, async () => {
            const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html'], manifestStatus });
            await worker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'tab-1' } });
            await settle();
            const answers = worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE');
            assert.deepEqual(answers.map((message) => [message.success, message.requestId]), [[success, 'tab-1']]);
        });
    }

    test('names its own request in each of two overlapping fills\' answers', async () => {
        let release;
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifestStatus: 500 });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const first = worker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'tab-1' } });
        await manifestRequested(worker);
        const second = worker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'tab-2' } });
        await manifestRequested(worker, 2);
        release();
        await Promise.all([first, second]);
        await settle();
        assert.deepEqual(failures(worker).map((message) => message.requestId).sort(), ['tab-1', 'tab-2']);
    });

    test('works after the same worker already filled its cache at activation', async () => {
        const worker = loadWorker({ version: '1.3.1', manifest: ['index.html', 'index.js'] });
        await activate(worker);
        await performUpdate(worker);
        assert.deepEqual(failures(worker), []);
        assert.ok(worker.messages.some((message) => message.type === 'UPDATE_COMPLETE' && message.success === true));
    });
});
