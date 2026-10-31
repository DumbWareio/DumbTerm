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
    return { body, status, type, redirected, ok: status === 200, clone() { return this; }, text: async () => body, json: async () => JSON.parse(body) };
}

// Load the worker as the browser would register it (service-worker.js?v=<version>) for the install at `scope`.
// `store` is the origin's Cache Storage, which two workers can share; `config` adds fields to config.js, and null
// makes config.js fail.
// `server.manifest` is what assets/asset-manifest.json lists, and `server.manifestStatus` its HTTP status;
// tests can change either between steps, and hold the manifest's answer back by setting `server.manifestHeld`
// to a promise. Setting `cacheStorage.nextKeysHeld` to a promise holds back the answer of the next caches.keys() only.
// Messages the worker posts to its one page land in `messages`.
// `serviceWorker` is this worker as the browser knows it. `registration` is the install's registration as the browser
// keeps it, which two workers of one install share: its `active` is the worker that last activated, and by default
// this one. `bareUrl` registers the worker as plain service-worker.js, as pages did before they added ?v=<version>, so
// that every version has the same script URL. `serviceWorkerObject` gives the worker `self.serviceWorker`, as Chromium
// and Safari do and Firefox does not.
function loadWorker({ version = '1.3.0', scope = '/', store = new Map(), config = {}, network = async () => fakeResponse('network'), cacheNames = [], manifest = [], manifestStatus = 200, registration, bareUrl = false, serviceWorkerObject = false } = {}) {
    cacheNames.forEach((name) => store.set(name, new Map()));
    const scopeUrl = new URL(scope, ORIGIN).href;
    const serviceWorker = { scriptURL: `${scopeUrl}service-worker.js${bareUrl ? '' : `?v=${version}`}` };
    const browserRegistration = registration ?? { active: serviceWorker };
    // Within one worker's realm there is one ServiceWorker object per worker, so the worker's own object is the one
    // its registration's active attribute holds while it is the active worker
    const objects = new Map();
    const objectFor = (worker) => {
        if (!objects.has(worker)) objects.set(worker, { scriptURL: worker.scriptURL });
        return objects.get(worker);
    };
    const listeners = {};
    const fetchCalls = [];
    const messages = [];
    const server = { manifest, manifestStatus };
    const cacheStorage = { nextKeysHeld: undefined };
    const fetch = async (request) => {
        const url = typeof request === 'string' ? request : request.url;
        fetchCalls.push(url);
        if (url.endsWith('config.js')) {
            return config ? fakeResponse(`window.appConfig = ${JSON.stringify({ version, ...config })};`) : fakeResponse('error', { status: 500 });
        }
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
            match: async (request) => entries.get(typeof request === 'string' ? request : request.url),
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
            keys: async () => {
                const held = cacheStorage.nextKeysHeld;
                cacheStorage.nextKeysHeld = undefined;
                await held;
                return [...store.keys()];
            },
            has: async (name) => store.has(name),
            delete: async (name) => store.delete(name),
            // As in the browser: with a cacheName it looks in that cache alone, and makes no cache that isn't there
            match: async (request, { cacheName } = {}) => {
                const url = typeof request === 'string' ? request : request.url;
                const searched = cacheName === undefined ? [...store.values()] : [store.get(cacheName)].filter(Boolean);
                for (const entries of searched) if (entries.has(url)) return entries.get(url);
                return undefined;
            },
        },
        self: {
            location: { href: serviceWorker.scriptURL },
            registration: { scope: scopeUrl, get active() { return browserRegistration.active && objectFor(browserRegistration.active); } },
            ...(serviceWorkerObject && { serviceWorker: objectFor(serviceWorker) }),
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: async () => {},
            clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message) => messages.push(message) }] },
        },
    };
    vm.runInNewContext(WORKER_SOURCE, sandbox);
    return { listeners, store, fetchCalls, messages, server, cacheStorage, serviceWorker };
}

// The worker posts some messages from promise callbacks it does not wait for; let those run
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function activate(worker) {
    const pending = [];
    worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    await settle();
}

async function install(worker) {
    const pending = [];
    worker.listeners.install({ waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
}

// Ask the worker for its versions as the page does with GET_VERSION; resolves with the answer on the message port
async function getVersion(worker) {
    let answer;
    await worker.listeners.message({ data: { type: 'GET_VERSION' }, ports: [{ postMessage: (message) => { answer = message; } }] });
    await settle();
    return answer;
}

// A worker registered without a release version (an old page's bare registration), installed: it takes `version`
// from config.js, and a page's SET_VERSION can change it while a fill runs, so a fill of another version can start
async function installUnversioned(version, options = {}) {
    const worker = loadWorker({ ...options, version: '1730000000000', config: { version } });
    await install(worker);
    // What it tells the pages at install is not what the tests that use it look at
    worker.messages.length = 0;
    return worker;
}

// What the page sends when the user picks Update Now on the worker's own UPDATE_AVAILABLE
async function performUpdate(worker) {
    await worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
    await settle();
}

const cacheSizes = (worker) => Object.fromEntries([...worker.store].map(([name, entries]) => [name, entries.size]));
const failures = (worker) => worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE' && message.success === false);

// Wait until the worker has asked for the manifest `count` times, and fail if it never does
async function manifestRequested(worker, count = 1) {
    const requests = () => worker.fetchCalls.filter((url) => url.endsWith('asset-manifest.json')).length;
    for (let i = 0; i < 100 && requests() < count; i++) await settle();
    assert.ok(requests() >= count, `the manifest was asked for ${requests()} times, not ${count}`);
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
        const worker = loadWorker({ cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'config.js', fakeResponse('stale'));
        const response = await dispatchFetch(worker, get('config.js'));
        assert.notEqual(response.body, 'stale');
    });

    test('caches network responses under the version it was registered with', async () => {
        const worker = loadWorker({ version: '1.3.0' });
        await dispatchFetch(worker, get('index.js'));
        assert.deepEqual([...worker.store.keys()], ['DUMBTERM_CACHE_/_V1.3.0']);
        assert.equal(worker.store.get('DUMBTERM_CACHE_/_V1.3.0').get(ORIGIN + 'index.js').body, 'network');
    });

    test('falls back to the cache when the network fails', async () => {
        const worker = loadWorker({ network: async () => { throw new TypeError('offline'); }, cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('cached'));
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
        const worker = loadWorker({ version: '1.3.0', cacheNames: ['DUMBTERM_CACHE_/_V1.2.0', 'DUMBTERM_CACHE_/_V1.0.0', 'unrelated-cache'] });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
        const names = [...worker.store.keys()].sort();
        assert.deepEqual(names, ['DUMBTERM_CACHE_/_V1.3.0', 'unrelated-cache']);
    });

    test('keeps the current version\'s cache and its entries', async () => {
        const worker = loadWorker({ version: '1.3.0', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0', 'DUMBTERM_CACHE_/_V1.2.0'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('kept'));
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
        assert.equal(worker.store.get('DUMBTERM_CACHE_/_V1.3.0')?.get(ORIGIN + 'index.js')?.body, 'kept');
    });

    test('keeps the old cache when registered without a release version and config.js can\'t be read', async () => {
        // The page falls back to ?v=<timestamp> when config.js could not be read
        const worker = loadWorker({ version: '1730000000000', config: null, cacheNames: ['DUMBTERM_CACHE_/_V1.2.0'] });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await Promise.all(pending);
        assert.ok(worker.store.has('DUMBTERM_CACHE_/_V1.2.0'));
    });

    // config.js can name a release the server moved to since the page registered this worker; that release's page
    // registers a worker of its own
    for (const [when, cacheNames] of [
        ['while its cache exists', ['DUMBTERM_CACHE_/_V1.3.1']],
        ['over an older version\'s cache', ['DUMBTERM_CACHE_/_V1.3.0']],
        ['with no cache yet', []],
    ]) {
        test(`keeps the version it was registered with, whatever config.js says, ${when}`, async () => {
            const worker = loadWorker({ version: '1.3.1', config: { version: '1.3.2' }, cacheNames, manifest: ['index.html'] });
            await install(worker);
            await activate(worker);
            const answer = await getVersion(worker);
            assert.deepEqual([answer.newVersion, answer.cacheName], ['1.3.1', 'DUMBTERM_CACHE_/_V1.3.1']);
            assert.deepEqual(Object.keys(cacheSizes(worker)), ['DUMBTERM_CACHE_/_V1.3.1']);
        });
    }

    for (const [label, version] of [['the default version 1.0.0', '1.0.0'], ['something that is no version', 'garbage']]) {
        test(`registered with ${label}, takes config.js's version as one registered without a version does`, async () => {
            const worker = loadWorker({ version, config: { version: '1.3.2' }, manifest: ['index.html'] });
            await install(worker);
            await activate(worker);
            const answer = await getVersion(worker);
            assert.deepEqual([answer.newVersion, answer.cacheName], ['1.3.2', 'DUMBTERM_CACHE_/_V1.3.2']);
            assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.2': 1 });
        });
    }

    test('an upgrade fills the new version\'s cache with the manifest\'s assets and deletes the old one', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html', 'index.js'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 2 });
        assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_/_V1.3.1'), [ORIGIN + 'index.html', ORIGIN + 'index.js']);
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO'
            && message.currentVersion === '1.3.1' && message.cacheName === 'DUMBTERM_CACHE_/_V1.3.1'));
        // UPDATE_COMPLETE is for Update Now: the page reloads on success and shows a notice on failure
        assert.deepEqual(worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE'), []);
    });

    test('a first install fills its cache', async () => {
        const worker = loadWorker({ version: '1.3.0', manifest: ['index.html', 'index.js'] });
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.0': 2 });
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO' && message.currentVersion === '1.3.0'));
    });

    test('an upgrade whose manifest request fails keeps the old cache and tells no page', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifestStatus: 500 });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.0': 1 });
        assert.deepEqual(failures(worker), []);
        // The page still learns which version it runs
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO' && message.currentVersion === '1.3.1'));
    });

    test('an upgrade whose asset requests fail keeps the old cache and tells no page', async () => {
        const worker = loadWorker({
            version: '1.3.1',
            cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'],
            manifest: ['index.html', 'index.js'],
            network: async () => fakeResponse('error', { status: 503 }),
        });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await activate(worker);
        assert.equal(worker.store.get('DUMBTERM_CACHE_/_V1.3.0')?.get(ORIGIN + 'index.js')?.body, 'old');
        assert.deepEqual(failures(worker), []);
    });

    test('a later version deletes every older cache, including one a failed upgrade left behind', async () => {
        // A failed 1.3.1 upgrade kept 1.3.0's cache, and the pages it served started a 1.3.1 cache
        const worker = loadWorker({ version: '1.3.2', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0', 'DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('partial'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.2': 1 });
    });

    test('fills the current version\'s cache when older caches show its last fill failed', async () => {
        // The same release activating again (a new worker script) after a failed fill, with the
        // pages having started the current cache since
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0', 'DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html', 'styles.css'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('fetched'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 3 });
    });

    test('does not refill a current cache that is the only one', async () => {
        const worker = loadWorker({ version: '1.3.0', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'] });
        await activate(worker);
        assert.ok(!worker.fetchCalls.some((url) => url.endsWith('asset-manifest.json')));
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO' && message.currentVersion === '1.3.0'));
    });

    test('keeps the cache it filled when a page sends another version during the fill', async () => {
        // A second tab loading the offline copy of 1.3.2 while 1.3.3 activates
        let release;
        const worker = await installUnversioned('1.3.3', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.2'], manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        for (let i = 0; i < 100 && !worker.fetchCalls.some((url) => url.endsWith('asset-manifest.json')); i++) await settle();
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        release();
        await Promise.all(pending);
        await settle();
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.3': 2 });
        // What the fill tells the page describes the cache it filled
        const fillMessages = worker.messages.filter((message) => message.cacheName);
        assert.ok(fillMessages.length > 0);
        for (const message of fillMessages) {
            assert.deepEqual([message.currentVersion, message.cacheName], ['1.3.3', 'DUMBTERM_CACHE_/_V1.3.3']);
        }
    });

    test('a failed fill that a page\'s version overtook still names its own version', async () => {
        let release;
        const worker = await installUnversioned('1.3.3', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.2'], manifestStatus: 500 });
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
            assert.deepEqual([message.currentVersion, message.cacheName], ['1.3.3', 'DUMBTERM_CACHE_/_V1.3.3']);
        }
    });

    test('two fills for different versions at once leave one filled cache', async () => {
        // A first visit: 1.3.3 activates while a page still running 1.3.2 starts a fill of its own
        let release;
        const worker = await installUnversioned('1.3.3', { manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await manifestRequested(worker);
        pending.push(worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } }));
        await manifestRequested(worker, 2);
        release();
        await Promise.all(pending);
        const names = [...worker.store.keys()];
        assert.equal(names.length, 1, names.join(', '));
        for (const name of names) assert.deepEqual(cachedUrls(worker, name), [ORIGIN + 'index.html', ORIGIN + 'index.js'], name);
    });

    test('two fills for different versions at once keep the cache of the one that finishes last', async () => {
        // As above, with the page's fill finishing first
        let releaseFirst;
        let releaseSecond;
        const worker = await installUnversioned('1.3.3', { manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { releaseFirst = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await manifestRequested(worker);
        worker.server.manifestHeld = new Promise((resolve) => { releaseSecond = resolve; });
        const second = worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2' } });
        await manifestRequested(worker, 2);
        releaseSecond();
        await second;
        releaseFirst();
        await Promise.all(pending);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.3': 2 });
    });

    test('deletes an older cache whatever its DumbTerm name looks like', async () => {
        // Earlier builds named their cache DUMBTERM_CACHE_V<version>, without the install's path; builds from
        // May 2025 named it without the V, and earlier ones DUMBTERM_PWA_CACHE_V<version>
        const worker = loadWorker({
            version: '1.3.1',
            cacheNames: ['DUMBTERM_CACHE_V1.3.0', 'DUMBTERM_CACHE_1.2.0', 'DUMBTERM_PWA_CACHE_V1.0.0', 'unrelated-cache'],
            manifest: ['index.html'],
        });
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'unrelated-cache': 0, 'DUMBTERM_CACHE_/_V1.3.1': 1 });
    });

    test('clears a cache with an older DumbTerm name left beside the current one', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_1.2.0', 'DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.1').set(ORIGIN + 'index.html', fakeResponse('cached'));
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 1 });
    });

    test('keeps a cache whose name starts with DUMBTERM_ but is no name DumbTerm gave its caches', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_WIDGET_V2.0.0'], manifest: ['index.html'] });
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_WIDGET_V2.0.0': 0, 'DUMBTERM_CACHE_/_V1.3.1': 1 });
    });
});

describe('service worker Update Now', () => {
    test('fills the new cache, deletes the old one and reports success', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'] });
        await performUpdate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 1 });
        assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_/_V1.3.1'), [ORIGIN + 'index.html']);
        assert.ok(worker.messages.some((message) => message.type === 'UPDATE_COMPLETE' && message.success === true
            && message.version === '1.3.1' && message.cacheName === 'DUMBTERM_CACHE_/_V1.3.1'));
        assert.ok(worker.messages.some((message) => message.type === 'CACHE_VERSION_INFO'
            && message.currentVersion === '1.3.1' && message.cacheName === 'DUMBTERM_CACHE_/_V1.3.1'));
    });

    test('reports a failed manifest request and keeps the old cache', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifestStatus: 500 });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.0').set(ORIGIN + 'index.js', fakeResponse('old'));
        await performUpdate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.0': 1 });
        assert.equal(failures(worker).length, 1);
        assert.match(failures(worker)[0].error, /500/);
        assert.deepEqual([failures(worker)[0].version, failures(worker)[0].cacheName], ['1.3.1', 'DUMBTERM_CACHE_/_V1.3.1']);
    });

    test('overlapping an activation fill of another version leaves a filled cache and reports success', async () => {
        // 1.3.3 activates; meanwhile a page running 1.3.2 sends its version, then the user picks Update Now
        let release;
        const worker = await installUnversioned('1.3.3', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html', 'index.js'] });
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
        const worker = await installUnversioned('1.3.1', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'], manifestStatus: 500 });
        await activate(worker);
        await dispatchFetch(worker, get('index.js'));
        worker.server.manifestStatus = 200;
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
        await performUpdate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.2': 1 });
    });

    for (const [outcome, manifestStatus] of [['succeeds', 200], ['fails', 500]]) {
        test(`names the version it filled when a page sends another version during a fill that ${outcome}`, async () => {
            let release;
            const worker = await installUnversioned('1.3.1', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'], manifestStatus });
            worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
            const update = worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
            await manifestRequested(worker);
            await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2', cacheName: 'DUMBTERM_CACHE_V1.3.2' } });
            release();
            await update;
            await settle();
            assert.equal(worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE').length, 1);
            const fillMessages = worker.messages.filter((message) => message.cacheName && message.type !== 'UPDATE_AVAILABLE');
            for (const message of fillMessages) {
                assert.deepEqual([message.version ?? message.currentVersion, message.cacheName], ['1.3.1', 'DUMBTERM_CACHE_/_V1.3.1']);
            }
        });
    }

    test('counts a fill as filling from its start, so another fill that finishes first keeps its cache', async () => {
        // As the "keeps the cache a fill still waiting on the network" test further down, holding Cache Storage's
        // next answer as well as the network's: a fill that looked at Cache Storage before counting itself would
        // leave its cache to the other fill's cleanup meanwhile
        let releaseKeys;
        let releaseManifest;
        const worker = await installUnversioned('1.3.1', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('fetched'));
        worker.cacheStorage.nextKeysHeld = new Promise((resolve) => { releaseKeys = resolve; });
        worker.server.manifestHeld = new Promise((resolve) => { releaseManifest = resolve; });
        const first = worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
        await settle();
        worker.cacheStorage.nextKeysHeld = undefined;
        worker.server.manifestHeld = undefined;
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2' } });
        await performUpdate(worker);
        releaseKeys();
        releaseManifest();
        await first;
        await settle();
        assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_/_V1.3.1'), [ORIGIN + 'index.html', ORIGIN + 'index.js']);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 2 });
    });

    // Three tabs on three versions pick Update Now in turn, and the fill of the version whose cache the pages had
    // started (1.3.1) finishes last: the cleanup of each fill that finishes before it leaves that cache alone
    for (const finishOrder of [['1.3.2', '1.3.3', '1.3.1'], ['1.3.3', '1.3.2', '1.3.1']]) {
        test(`keeps the cache of a fill still waiting while two other fills finish, ${finishOrder.join(' then ')}`, async () => {
            const releases = {};
            const fills = {};
            const worker = await installUnversioned('1.3.2', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html'] });
            worker.store.get('DUMBTERM_CACHE_/_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('fetched'));
            for (const [i, version] of ['1.3.2', '1.3.1', '1.3.3'].entries()) {
                await worker.listeners.message({ data: { type: 'SET_VERSION', version } });
                worker.server.manifestHeld = new Promise((resolve) => { releases[version] = resolve; });
                fills[version] = worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
                await manifestRequested(worker, i + 1);
            }
            for (const version of finishOrder) {
                releases[version]();
                await fills[version];
            }
            await settle();
            assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_/_V1.3.1'), [ORIGIN + 'index.html', ORIGIN + 'index.js']);
            assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 2 });
        });
    }

    test('keeps the cache a fill still waiting on the network is to fill when another fill finishes first', async () => {
        // Update Now of 1.3.1 waits on the server; a page sends 1.3.2 and the user picks Update Now again, and that
        // fill finishes first. What the pages had already cached under 1.3.1 stays for the first fill.
        let release;
        const worker = await installUnversioned('1.3.1', { cacheNames: ['DUMBTERM_CACHE_/_V1.3.1'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_/_V1.3.1').set(ORIGIN + 'index.js', fakeResponse('fetched'));
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const first = worker.listeners.message({ data: { type: 'PERFORM_UPDATE' } });
        await manifestRequested(worker);
        worker.server.manifestHeld = undefined;
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2' } });
        await performUpdate(worker);
        release();
        await first;
        await settle();
        assert.deepEqual(cachedUrls(worker, 'DUMBTERM_CACHE_/_V1.3.1'), [ORIGIN + 'index.html', ORIGIN + 'index.js']);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 2 });
    });

    // The worker tells every tab how a fill went, so each answer names the request it answers, and a tab can tell
    // its own Update Now's answer from another tab's
    for (const [outcome, manifestStatus, success] of [['succeeds', 200, true], ['fails', 500, false]]) {
        test(`names the request it answers when the fill ${outcome}`, async () => {
            const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'], manifestStatus });
            await worker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'tab-1' } });
            await settle();
            const answers = worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE');
            assert.deepEqual(answers.map((message) => [message.success, message.requestId]), [[success, 'tab-1']]);
        });
    }

    test('names its own request in each of two overlapping fills\' answers', async () => {
        let release;
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifestStatus: 500 });
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

// A page sends its version with SET_VERSION when it loads, and a page loaded from the offline copy runs an older one
describe('service worker versions a page sends', () => {
    for (const [which, sent] of [['an older', '1.3.2'], ['a newer', '1.3.4']]) {
        test(`keeps the version it was registered with when a page sends ${which} one`, async () => {
            const worker = loadWorker({ version: '1.3.3', cacheNames: ['DUMBTERM_CACHE_/_V1.3.3'], manifest: ['index.html'] });
            await worker.listeners.message({ data: { type: 'SET_VERSION', version: sent } });
            await settle();
            // It still tells the page which version it runs
            assert.deepEqual(worker.messages.map((message) => [message.type, message.currentVersion]), [['CACHE_VERSION_INFO', '1.3.3']]);
            const answer = await getVersion(worker);
            assert.deepEqual([answer.currentVersion, answer.newVersion, answer.cacheName], ['1.3.3', '1.3.3', 'DUMBTERM_CACHE_/_V1.3.3']);
            assert.ok(!worker.fetchCalls.some((url) => url.endsWith('asset-manifest.json')));
        });
    }

    test('offers its version to a page that sends an older one while only that version\'s cache is there', async () => {
        // A page loaded from 1.3.2's offline copy before 1.3.3's fill succeeded
        const worker = loadWorker({ version: '1.3.3', cacheNames: ['DUMBTERM_CACHE_/_V1.3.2'] });
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2' } });
        await settle();
        const offers = worker.messages.filter((message) => message.type === 'UPDATE_AVAILABLE');
        assert.deepEqual(offers.map((offer) => [offer.currentVersion, offer.newVersion, offer.cacheName]), [['1.3.2', '1.3.3', 'DUMBTERM_CACHE_/_V1.3.3']]);
    });

    test('starts no fill of the version a page sends during its first fill', async () => {
        // A first visit: 1.3.3 activates while a page still running 1.3.2 sends its version
        let release;
        const worker = loadWorker({ version: '1.3.3', manifest: ['index.html', 'index.js'] });
        worker.server.manifestHeld = new Promise((resolve) => { release = resolve; });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await manifestRequested(worker);
        pending.push(worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2' } }));
        release();
        await Promise.all(pending);
        await settle();
        assert.equal(worker.fetchCalls.filter((url) => url.endsWith('asset-manifest.json')).length, 1);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.3': 2 });
    });

    for (const [label, version] of [['without a release version', '1730000000000'], ['with the default version 1.0.0', '1.0.0'], ['with something that is no version', 'garbage']]) {
        test(`registered ${label}, takes the version a page sends`, async () => {
            const worker = loadWorker({ version, config: null, cacheNames: ['DUMBTERM_CACHE_/_V1.3.1'] });
            await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.1' } });
            const answer = await getVersion(worker);
            assert.deepEqual([answer.newVersion, answer.cacheName], ['1.3.1', 'DUMBTERM_CACHE_/_V1.3.1']);
        });
    }
});

// Cache Storage belongs to the origin, not to a worker's scope, so two installs under different paths of one origin
// (behind a reverse proxy, say) see each other's caches
describe('service worker caches on an origin shared by two installs', () => {
    const urlsByCache = (store) => Object.fromEntries([...store].map(([name, entries]) => [name, [...entries.keys()]]));

    for (const [one, other] of [['/a/', '/b/'], ['/', '/a/'], ['/a/', '/'], ['/a/', '/a/_V2/']]) {
        test(`installs at ${one} and ${other} keep their own caches through each other's upgrades`, async () => {
            const store = new Map();
            await activate(loadWorker({ scope: one, version: '1.3.0', store, manifest: ['index.html'] }));
            await activate(loadWorker({ scope: other, version: '1.3.1', store, manifest: ['index.html'] }));
            assert.deepEqual(urlsByCache(store), {
                [`DUMBTERM_CACHE_${one}_V1.3.0`]: [new URL(`${one}index.html`, ORIGIN).href],
                [`DUMBTERM_CACHE_${other}_V1.3.1`]: [new URL(`${other}index.html`, ORIGIN).href],
            });
            await activate(loadWorker({ scope: one, version: '1.3.2', store, manifest: ['index.html'] }));
            assert.deepEqual(urlsByCache(store), {
                [`DUMBTERM_CACHE_${other}_V1.3.1`]: [new URL(`${other}index.html`, ORIGIN).href],
                [`DUMBTERM_CACHE_${one}_V1.3.2`]: [new URL(`${one}index.html`, ORIGIN).href],
            });
        });
    }

    test('does not refill its cache because another install\'s cache is there', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/b/_V1.3.0', 'DUMBTERM_CACHE_/a/_V1.3.1'], manifest: ['index.html'] });
        await activate(worker);
        assert.ok(!worker.fetchCalls.some((url) => url.endsWith('asset-manifest.json')));
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/b/_V1.3.0': 0, 'DUMBTERM_CACHE_/a/_V1.3.1': 0 });
    });

    test('an upgrade deletes the cache an earlier build named without the install\'s path once its own is filled', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'], manifest: ['index.html'] });
        worker.store.get('DUMBTERM_CACHE_V1.3.0').set(ORIGIN + 'a/index.html', fakeResponse('old'));
        await install(worker);
        await activate(worker);
        assert.deepEqual(urlsByCache(worker.store), { 'DUMBTERM_CACHE_/a/_V1.3.1': [ORIGIN + 'a/index.html'] });
    });

    test('offers the upgrade from a cache an earlier build named without the install\'s path', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_V1.3.0'] });
        const answer = await getVersion(worker);
        assert.deepEqual([answer.currentVersion, answer.newVersion, answer.cacheName], ['1.3.0', '1.3.1', 'DUMBTERM_CACHE_/a/_V1.3.1']);
    });

    test('offers the upgrade from a cache a build from May 2025 named without the V', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_1.2.0'] });
        const answer = await getVersion(worker);
        assert.deepEqual([answer.currentVersion, answer.newVersion], ['1.2.0', '1.3.1']);
    });

    test('keeps a cache whose name starts like its own but holds more after the version', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/a/_V1.2.0/misc'], manifest: ['index.html'] });
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/a/_V1.2.0/misc': 0, 'DUMBTERM_CACHE_/a/_V1.3.1': 1 });
    });

    test('does not take another install\'s cache for its own', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/b/_V1.3.0'] });
        const answer = await getVersion(worker);
        assert.equal(answer.currentVersion, '1.3.1');
        assert.deepEqual(worker.messages.filter((message) => message.type === 'UPDATE_AVAILABLE'), []);
    });

    test('reads the version it runs from its newest cache', async () => {
        // Cache Storage lists caches in the order they were made
        const worker = loadWorker({ scope: '/a/', version: '1.3.2', cacheNames: ['DUMBTERM_CACHE_/a/_V1.3.0', 'DUMBTERM_CACHE_/a/_V1.3.1'] });
        const answer = await getVersion(worker);
        assert.equal(answer.currentVersion, '1.3.1');
    });

    test('reads the version it runs from its newest cache when an older version\'s name sorts after it', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.11.0', cacheNames: ['DUMBTERM_CACHE_/a/_V1.9.0', 'DUMBTERM_CACHE_/a/_V1.10.0'] });
        const answer = await getVersion(worker);
        assert.equal(answer.currentVersion, '1.10.0');
    });

    test('reads the version it runs from its own cache before one an earlier build named without the install\'s path', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.2', cacheNames: ['DUMBTERM_CACHE_/a/_V1.3.1', 'DUMBTERM_CACHE_V1.3.0'] });
        const answer = await getVersion(worker);
        assert.equal(answer.currentVersion, '1.3.1');
    });

    test('reads the version it runs from its current cache when an older version\'s cache was made after it', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/a/_V1.3.1', 'DUMBTERM_CACHE_/a/_V1.3.0'] });
        const answer = await getVersion(worker);
        assert.equal(answer.currentVersion, '1.3.1');
    });

    test('reads the version of a cache whose path holds a _V', async () => {
        const worker = loadWorker({ scope: '/tools_V2/', version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/tools_V2/_V1.3.0'] });
        const answer = await getVersion(worker);
        assert.deepEqual([answer.currentVersion, answer.newVersion], ['1.3.0', '1.3.1']);
    });

    test('names its cache after its path whatever cache name config.js gives', async () => {
        // A server from before scoped names sent DUMBTERM_CACHE_V<version>, the same for every install
        const worker = loadWorker({ scope: '/a/', version: '1.3.1', config: { cacheName: 'DUMBTERM_CACHE_V1.3.1' }, manifest: ['index.html'] });
        await install(worker);
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/a/_V1.3.1': 1 });
    });

    test('installed without a version, fills a cache named after its path and config.js\'s version', async () => {
        const worker = loadWorker({ scope: '/a/', version: '1730000000000', config: { version: '1.3.1', cacheName: 'DUMBTERM_CACHE_V1.3.1' }, manifest: ['index.html'] });
        await install(worker);
        await activate(worker);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/a/_V1.3.1': 1 });
    });

    test('activated without a version, offers config.js\'s version under a cache named after its path', async () => {
        const worker = loadWorker({
            scope: '/a/',
            version: '1730000000000',
            config: { version: '1.3.1', cacheName: 'DUMBTERM_CACHE_V1.3.1' },
            cacheNames: ['DUMBTERM_CACHE_/a/_V1.3.0'],
        });
        await activate(worker);
        const offers = worker.messages.filter((message) => message.type === 'UPDATE_AVAILABLE');
        assert.ok(offers.length > 0);
        for (const offer of offers) {
            assert.deepEqual([offer.currentVersion, offer.newVersion, offer.cacheName], ['1.3.0', '1.3.1', 'DUMBTERM_CACHE_/a/_V1.3.1']);
        }
    });

    test('takes only the version from config.js when registered without one', async () => {
        // The page falls back to ?v=<timestamp> when config.js could not be read; it may read it later
        const worker = loadWorker({ scope: '/a/', version: '1730000000000', config: { version: '1.3.1', cacheName: 'DUMBTERM_CACHE_V1.3.1' } });
        const answer = await getVersion(worker);
        assert.deepEqual([answer.newVersion, answer.cacheName], ['1.3.1', 'DUMBTERM_CACHE_/a/_V1.3.1']);
    });
});

// While a new version's worker activates, the worker it replaces can still be filling a cache for an Update Now. The
// two run in sandboxes of their own and share the origin's Cache Storage and the install's registration, whose active
// worker becomes the new one before the new one's activate event, as the browser does it
describe('service worker instances of one install during an upgrade', () => {
    const OLD_CACHE = 'DUMBTERM_CACHE_/_V1.3.1';
    const NEW_CACHE = 'DUMBTERM_CACHE_/_V1.3.2';
    const answers = (worker) => worker.messages.filter((message) => message.type === 'UPDATE_COMPLETE')
        .map((message) => [message.success, message.requestId]);

    // Wait until the worker has asked the network for an asset, which it does once its cache is open
    async function assetRequested(worker) {
        const requested = () => worker.fetchCalls.includes(ORIGIN + 'index.html');
        for (let i = 0; i < 100 && !requested(); i++) await settle();
        assert.ok(requested(), 'the worker never asked for its assets');
    }

    // The active worker of 1.3.1 with its offline copy, and the worker of 1.3.2 installed beside it. Each worker's
    // requests for its asset wait on `held.old` or `held.new` while it is set to a promise; a page's requests don't.
    // With `staleActive`, the old worker's view of the registration never learns the new worker became the active one.
    async function twoWorkers(options, { staleActive = false } = {}) {
        const store = new Map([[OLD_CACHE, new Map([[ORIGIN + 'index.html', fakeResponse('1.3.1')]])]]);
        const registration = { active: null };
        const oldRegistration = staleActive ? { active: null } : registration;
        const held = { old: undefined, new: undefined };
        const workerOf = (version, which, workerRegistration) => loadWorker({
            ...options, version, store, registration: workerRegistration, manifest: ['index.html'],
            network: async (request) => {
                if (request === ORIGIN + 'index.html') await held[which];
                return fakeResponse(version);
            },
        });
        const oldWorker = workerOf('1.3.1', 'old', oldRegistration);
        registration.active = oldWorker.serviceWorker;
        oldRegistration.active = oldWorker.serviceWorker;
        await install(oldWorker);
        const newWorker = workerOf('1.3.2', 'new', registration);
        await install(newWorker);
        oldWorker.messages.length = 0;
        return { store, registration, held, oldWorker, newWorker };
    }

    const hold = () => {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        return { promise, release };
    };

    const BROWSERS = [
        ['registered with their versions', {}],
        ['registered with their versions, in a browser that gives a worker its own ServiceWorker object', { serviceWorkerObject: true }],
        ['registered under one URL, in a browser that gives a worker its own ServiceWorker object', { bareUrl: true, serviceWorkerObject: true }],
        ['registered under one URL, in a browser that gives a worker no ServiceWorker object', { bareUrl: true }],
    ];

    for (const [label, options] of BROWSERS) {
        test(`an old worker's Update Now that ends after the new worker filled its cache reports failure and leaves the new cache, ${label}`, async () => {
            // The new worker's fill deletes the old worker's cache while the old worker still writes to it
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options);
            const oldAssets = hold();
            held.old = oldAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            await activate(newWorker);
            oldAssets.release();
            await update;
            await settle();
            assert.deepEqual(cacheSizes(newWorker), { [NEW_CACHE]: 1 });
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
            assert.deepEqual(answers(oldWorker), [[false, 'old-tab']]);
        });

        // Where the old worker can't tell it was replaced (the two share a script URL and it has no object of its own),
        // its fill deletes the new worker's cache, and the new worker's activation fill fills it once more
        test(`an old worker's Update Now that ends during the new worker's fill leaves the new cache, ${label}`, async () => {
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options);
            const oldAssets = hold();
            const newAssets = hold();
            held.old = oldAssets.promise;
            held.new = newAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            const pending = [];
            newWorker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
            await assetRequested(newWorker);
            oldAssets.release();
            await update;
            await settle();
            // Its own cache was still there when its fill ended
            assert.deepEqual(answers(oldWorker), [[true, 'old-tab']]);
            newAssets.release();
            await Promise.all(pending);
            await settle();
            assert.deepEqual(cacheSizes(newWorker), { [NEW_CACHE]: 1 });
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
        });

        test(`an old worker that never learns it was replaced, ending its Update Now during the new worker's fill, leaves the new cache, ${label}`, async () => {
            // Its cleanup deletes the cache the new worker fills, and that activation fill fills it once more
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options, { staleActive: true });
            const oldAssets = hold();
            const newAssets = hold();
            held.old = oldAssets.promise;
            held.new = newAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            const pending = [];
            newWorker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
            await assetRequested(newWorker);
            oldAssets.release();
            await update;
            newAssets.release();
            await Promise.all(pending);
            await settle();
            assert.deepEqual(cacheSizes(newWorker), { [NEW_CACHE]: 1 });
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
        });

        test(`an old worker's cleanup that deletes the new cache after the new worker's fill checked it leaves the new cache, ${label}`, async () => {
            // The new worker's fill has filled its cache and waits on Cache Storage to clear the older ones; meanwhile
            // the old worker's Update Now ends, and one that can't tell it was replaced deletes the new cache
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options);
            const oldAssets = hold();
            const newAssets = hold();
            const newKeys = hold();
            held.old = oldAssets.promise;
            held.new = newAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            const pending = [];
            newWorker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
            await assetRequested(newWorker);
            newWorker.cacheStorage.nextKeysHeld = newKeys.promise;
            newAssets.release();
            for (let i = 0; i < 10; i++) await settle();
            oldAssets.release();
            await update;
            newKeys.release();
            await Promise.all(pending);
            await settle();
            assert.deepEqual(cacheSizes(newWorker), { [NEW_CACHE]: 1 });
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
        });

        test(`an old worker's cleanup that deletes the new cache after the new worker's fill checked it, which a page's request then makes again, leaves the new cache, ${label}`, async () => {
            // As above, and while the new worker's fill waits on Cache Storage, a page's request to the new worker
            // makes the deleted cache again, holding that response alone
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options);
            const oldAssets = hold();
            const newAssets = hold();
            const newKeys = hold();
            held.old = oldAssets.promise;
            held.new = newAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            const pending = [];
            newWorker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
            await assetRequested(newWorker);
            newWorker.cacheStorage.nextKeysHeld = newKeys.promise;
            newAssets.release();
            for (let i = 0; i < 10; i++) await settle();
            oldAssets.release();
            await update;
            await dispatchFetch(newWorker, get('page.js'));
            newKeys.release();
            await Promise.all(pending);
            await settle();
            assert.deepEqual(Object.keys(cacheSizes(newWorker)), [NEW_CACHE]);
            assert.deepEqual(cachedUrls(newWorker, NEW_CACHE), [ORIGIN + 'index.html', ORIGIN + 'page.js']);
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
        });

        test(`an old worker's Update Now whose deleted cache a page's request made again reports failure and leaves the new cache, ${label}`, async () => {
            // The new worker's fill deletes the old worker's cache; a request the old worker still handles caches its
            // response under the old cache's name, which makes that cache again, holding that response alone
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options);
            const oldAssets = hold();
            held.old = oldAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            await activate(newWorker);
            await dispatchFetch(oldWorker, get('page.js'));
            oldAssets.release();
            await update;
            await settle();
            assert.deepEqual(answers(oldWorker), [[false, 'old-tab']]);
            assert.deepEqual(cachedUrls(newWorker, NEW_CACHE), [ORIGIN + 'index.html']);
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
            assert.deepEqual(cachedUrls(oldWorker, OLD_CACHE), [ORIGIN + 'page.js']);
        });

        test(`a new worker's fill whose deleted cache a page's request made again fills it, ${label}`, async () => {
            // Where the old worker can't tell it was replaced, its fill deletes the cache the new worker fills; a page's
            // request to the new worker then makes that cache again, holding that response alone
            const { store, registration, held, oldWorker, newWorker } = await twoWorkers(options);
            const oldAssets = hold();
            const newAssets = hold();
            held.old = oldAssets.promise;
            held.new = newAssets.promise;
            const update = oldWorker.listeners.message({ data: { type: 'PERFORM_UPDATE', requestId: 'old-tab' } });
            await assetRequested(oldWorker);
            registration.active = newWorker.serviceWorker;
            const pending = [];
            newWorker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
            await assetRequested(newWorker);
            oldAssets.release();
            await update;
            await settle();
            await dispatchFetch(newWorker, get('page.js'));
            newAssets.release();
            await Promise.all(pending);
            await settle();
            assert.deepEqual(Object.keys(cacheSizes(newWorker)), [NEW_CACHE]);
            assert.deepEqual(cachedUrls(newWorker, NEW_CACHE), [ORIGIN + 'index.html', ORIGIN + 'page.js']);
            assert.equal(store.get(NEW_CACHE).get(ORIGIN + 'index.html').body, '1.3.2');
        });

        // With one worker, the active one, every fill clears the older caches as before
        test(`the active worker's activation fill clears an older cache, ${label}`, async () => {
            const worker = loadWorker({ ...options, version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'] });
            await install(worker);
            await activate(worker);
            assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 1 });
        });

        test(`the active worker's Update Now clears an older cache, ${label}`, async () => {
            const worker = loadWorker({ ...options, version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'] });
            await install(worker);
            await performUpdate(worker);
            assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 1 });
            assert.deepEqual(answers(worker), [[true, undefined]]);
        });

        // The activate event fires only at the worker becoming the active one, so its fill clears even in a browser
        // whose registration names that worker late
        const replaced = { scriptURL: `${ORIGIN}service-worker.js${options.bareUrl ? '' : '?v=1.3.0'}` };
        for (const [lag, active] of [['names no worker yet', null], ['still names the worker it replaces', replaced]]) {
            test(`the activation fill clears an older cache while the registration ${lag}, ${label}`, async () => {
                const worker = loadWorker({ ...options, version: '1.3.1', registration: { active }, cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'] });
                await install(worker);
                await activate(worker);
                assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 1 });
            });
        }
    }

    const manifestRequests = (worker) => worker.fetchCalls.filter((url) => url.endsWith('asset-manifest.json')).length;

    test('an activation fill that fails for the network is not tried again', async () => {
        const worker = loadWorker({ version: '1.3.1', cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifestStatus: 500 });
        await activate(worker);
        assert.equal(manifestRequests(worker), 1);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.0': 0 });
    });

    test('an activation fill that loses its cache fills it once more and clears the older cache, even before the registration names the worker', async () => {
        const assets = hold();
        const worker = loadWorker({
            version: '1.3.1', registration: { active: null }, cacheNames: ['DUMBTERM_CACHE_/_V1.3.0'], manifest: ['index.html'],
            network: async () => { await assets.promise; return fakeResponse('1.3.1'); },
        });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await assetRequested(worker);
        worker.store.delete('DUMBTERM_CACHE_/_V1.3.1');
        assets.release();
        await Promise.all(pending);
        await settle();
        assert.equal(manifestRequests(worker), 2);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.1': 1 });
    });

    test('an activation fill whose cache is deleted after a page named another version is not tried again', async () => {
        // A worker registered without a release version fills 1.3.3; a page running 1.3.2 sends its version, and
        // then the cache the fill writes to is deleted. Filling again would fill the page's version, not the one the
        // activation started, with whatever the server now sends.
        const assets = hold();
        const worker = await installUnversioned('1.3.3', {
            cacheNames: ['DUMBTERM_CACHE_/_V1.3.2'], manifest: ['index.html'],
            network: async () => { await assets.promise; return fakeResponse('1.3.3'); },
        });
        const pending = [];
        worker.listeners.activate({ waitUntil(promise) { pending.push(promise); } });
        await assetRequested(worker);
        await worker.listeners.message({ data: { type: 'SET_VERSION', version: '1.3.2' } });
        worker.store.delete('DUMBTERM_CACHE_/_V1.3.3');
        assets.release();
        await Promise.all(pending);
        await settle();
        assert.equal(manifestRequests(worker), 1);
        assert.deepEqual(cacheSizes(worker), { 'DUMBTERM_CACHE_/_V1.3.2': 0 });
    });
});
