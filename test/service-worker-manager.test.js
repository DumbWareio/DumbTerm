/**
 * Unit tests for public/managers/serviceWorker.js (the page side of the service worker).
 * Loads the real ES module with minimal stand-ins for the browser globals it touches.
 */
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MANAGER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'managers', 'serviceWorker.js'), 'utf8');
const BROWSER_GLOBALS = ['window', 'navigator', 'document', 'caches', 'fetch', 'MessageChannel'];
const ORIGINAL_GLOBALS = new Map(BROWSER_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function restoreBrowserGlobals() {
    for (const [name, descriptor] of ORIGINAL_GLOBALS) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    }
}

async function loadManager() {
    const { default: ServiceWorkerManager } = await import(`data:text/javascript,${encodeURIComponent(MANAGER_SOURCE)}`);
    return ServiceWorkerManager;
}

// window and document, keeping the listeners the page adds so a test can fire them
function listeningTarget(properties) {
    const listeners = new Map();
    return {
        ...properties,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        dispatchEvent(event) {
            [...(listeners.get(event.type) ?? [])].forEach((listener) => listener(event));
            return true;
        },
    };
}

// A document just big enough for the update prompt: the elements appended to the body, and the prompt's buttons
function headlessDocument() {
    const shown = [];
    const buttons = new Map();
    return listeningTarget({
        visibilityState: 'visible',
        shown,
        buttons,
        body: { appendChild(element) { shown.push(element); } },
        createElement() {
            const element = {
                className: '',
                innerHTML: '',
                remove() {
                    const index = shown.indexOf(element);
                    if (index >= 0) shown.splice(index, 1);
                },
            };
            return element;
        },
        querySelectorAll(selector) {
            return selector === '.update-notification'
                ? shown.filter((element) => element.className.split(' ').includes('update-notification'))
                : [];
        },
        getElementById(id) {
            if (id !== 'update-now' && id !== 'update-later') return null;
            const button = { addEventListener(type, listener) { if (type === 'click') button.click = listener; } };
            buttons.set(id, button);
            return button;
        },
    });
}

// The server's config.js, as the page fetches it: the version the server runs, or how the request goes wrong
const server = { version: '1.3.0', status: 200, body: null, down: false };
const fetched = [];

async function fetchFromServer(url, options) {
    fetched.push({ url, options });
    if (server.down) throw new TypeError('Failed to fetch');
    const body = server.body ?? `
        window.appConfig = ${JSON.stringify({ basePath: '', version: server.version, cacheName: `DUMBTERM_CACHE_V${server.version}` })};
    `;
    return { ok: server.status >= 200 && server.status < 300, status: server.status, text: async () => body };
}

// The worker controlling a lone tab was registered as service-worker.js?v=<page version>, so after an upgrade it
// still answers GET_VERSION with the page's version (the probe behind #50 saw 1.3.0 / 1.3.0)
function loneTabWorker(pageVersion) {
    return {
        messages: [],
        postMessage(message, ports) {
            this.messages.push(message);
            if (message.type === 'GET_VERSION') ports[0].postMessage({ currentVersion: pageVersion, newVersion: pageVersion });
        },
    };
}

class FakeMessageChannel {
    constructor() {
        this.port1 = {};
        this.port2 = { postMessage: (data) => this.port1.onmessage?.({ data }) };
    }
}

// Let the manager's promises (the cache lookup, the registration, a fetch of config.js) settle
async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Start a manager on a page running `pageVersion` whose cache still holds `cachedVersion`. `controlled` gives the
// page a lone tab's worker
async function startManager({ pageVersion, cachedVersion, basePath = '', controlled = false }) {
    globalThis.window = listeningTarget({
        appConfig: pageVersion ? { version: pageVersion, basePath } : undefined,
        location: { reload() {} },
    });
    const workerListeners = [];
    // Node already defines a read-only `navigator` global, so replace it rather than assign to it
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
            serviceWorker: {
                controller: controlled ? loneTabWorker(pageVersion) : null,
                ready: Promise.resolve({ active: { postMessage() {} } }),
                register: async () => ({ scope: '/', addEventListener() {} }),
                addEventListener(type, listener) { if (type === 'message') workerListeners.push(listener); },
            },
        },
    });
    globalThis.document = headlessDocument();
    globalThis.caches = { keys: async () => (cachedVersion ? [`DUMBTERM_CACHE_V${cachedVersion}`] : []) };
    globalThis.fetch = fetchFromServer;
    globalThis.MessageChannel = FakeMessageChannel;

    const displayed = [];
    const ServiceWorkerManager = await loadManager();
    const manager = new ServiceWorkerManager();
    manager.initialize((version, loading) => displayed.push(loading ? 'loading' : version));
    // Let the startup cache lookup resolve
    await settle();
    const fromWorker = (data) => workerListeners.forEach((listener) => listener({ data }));
    return { manager, displayed, fromWorker };
}

// The update prompts on the page, as text
function prompts() {
    return document.querySelectorAll('.update-notification')
        .map((element) => element.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

const PROMPT_1_3_1 = 'New version v1.3.1 available! Current: v1.3.0 Update Now Later';

describe('service worker manager version display', () => {
    before(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        // The manager logs every step; keep the test output readable
        for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
    });
    after(() => {
        mock.timers.reset();
        mock.restoreAll();
        restoreBrowserGlobals();
    });

    test('shows the version the page runs, not an older cached release', async () => {
        const { manager, displayed } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.2.0' });
        // A tab open during an upgrade can also hear about the new release from the worker
        manager.updateVersionDisplayCallback('1.4.0');
        manager.updateVersionDisplayCallback();
        const versions = displayed.filter((entry) => entry !== 'loading');
        assert.ok(versions.length >= 3, `expected the startup lookup and both reports to update the footer, got ${JSON.stringify(displayed)}`);
        assert.deepEqual([...new Set(versions)], ['1.3.0']);
    });

    test('falls back to the reported version when the page has no config', async () => {
        const { manager, displayed } = await startManager({ pageVersion: undefined, cachedVersion: '1.2.0' });
        manager.updateVersionDisplayCallback('1.2.0');
        assert.equal(displayed.filter((entry) => entry !== 'loading').pop(), '1.2.0');
    });

    test('still shows the loading state', async () => {
        const { manager, displayed } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0' });
        manager.updateVersionDisplayCallback(null, true);
        assert.equal(displayed.at(-1), 'loading');
    });
});

// A tab left open on 1.3.0 while the server is upgraded to 1.3.1 (#50)
describe('service worker manager update prompt', () => {
    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
        Object.assign(server, { version: '1.3.0', status: 200, body: null, down: false });
        fetched.length = 0;
    });
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
        restoreBrowserGlobals();
    });

    // The tab, alone on 1.3.0 and controlled by its worker, then the server's upgrade
    async function loneTabAcrossUpgrade(options = {}) {
        const started = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true, ...options });
        assert.deepEqual(prompts(), [], 'no prompt while the page runs the server\'s version');
        server.version = '1.3.1';
        fetched.length = 0;
        return started;
    }

    async function becomeVisible() {
        document.visibilityState = 'visible';
        document.dispatchEvent({ type: 'visibilitychange' });
        await settle();
    }

    async function reconnect() {
        window.dispatchEvent({ type: 'dumbterm:reconnected' });
        await settle();
    }

    test('a lone tab offers the server\'s new version when a terminal tab reconnects', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('a lone tab offers the server\'s new version when the page becomes visible', async () => {
        await loneTabAcrossUpgrade();
        await becomeVisible();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('a lone tab offers the server\'s new version on the hourly check', async () => {
        await loneTabAcrossUpgrade();
        mock.timers.tick(60 * 60 * 1000);
        await settle();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    // A page should match the server it talks to, so a server rolled back to an older image is offered too
    test('a page newer than the server offers the server\'s version', async () => {
        await loneTabAcrossUpgrade();
        server.version = '1.2.0';
        await reconnect();
        assert.deepEqual(prompts(), ['New version v1.2.0 available! Current: v1.3.0 Update Now Later']);
    });

    test('a page no worker controls yet still asks the server', async () => {
        await loneTabAcrossUpgrade({ controlled: false });
        await becomeVisible();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('asks the server itself for config.js, under the base path', async () => {
        await loneTabAcrossUpgrade({ basePath: '/term' });
        await reconnect();
        assert.equal(fetched.length, 1);
        assert.equal(fetched[0].url, '/term/config.js');
        assert.equal(fetched[0].options?.cache, 'no-store', 'not from the browser\'s HTTP cache');
    });

    test('a prompt put off with Later comes back on the next check', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        document.buttons.get('update-later').click();
        assert.deepEqual(prompts(), []);
        await becomeVisible();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('several tabs reconnecting at once show one prompt', async () => {
        await loneTabAcrossUpgrade();
        window.dispatchEvent({ type: 'dumbterm:reconnected' });
        window.dispatchEvent({ type: 'dumbterm:reconnected' });
        window.dispatchEvent({ type: 'dumbterm:reconnected' });
        await settle();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    // Guards: no prompt unless the server is known to run another version
    test('a page already running the server\'s version shows no prompt', async () => {
        server.version = '1.3.1';
        await startManager({ pageVersion: '1.3.1', cachedVersion: '1.3.1', controlled: true });
        await reconnect();
        await becomeVisible();
        assert.ok(fetched.length >= 2, 'it asked the server');
        assert.deepEqual(prompts(), []);
    });

    for (const [what, setUp] of [
        ['says the default 1.0.0', () => { server.version = '1.0.0'; }],
        ['reports something that is no version', () => { server.version = 'latest'; }],
        ['reports no version', () => { server.version = undefined; }],
        ['cannot be reached', () => { server.down = true; }],
        ['answers with an error', () => { server.status = 500; }],
        ['sends a config.js the page cannot read', () => { server.body = 'window.appConfig = {version: 1.3.1};'; }],
        ['sends something other than config.js', () => { server.body = '<!DOCTYPE html><title>Login</title>'; }],
    ]) {
        test(`no prompt when the server ${what}`, async () => {
            await loneTabAcrossUpgrade();
            setUp();
            await reconnect();
            await becomeVisible();
            assert.equal(fetched.length, 2, 'it asked the server each time');
            assert.deepEqual(prompts(), []);
        });
    }

    test('no second request while the prompt is up', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        assert.equal(fetched.length, 1);
        await becomeVisible();
        await reconnect();
        assert.equal(fetched.length, 1);
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('a page that is hidden does not check', async () => {
        await loneTabAcrossUpgrade();
        document.visibilityState = 'hidden';
        document.dispatchEvent({ type: 'visibilitychange' });
        await settle();
        assert.equal(fetched.length, 0);
    });

    // Guards: a newer worker installed by another tab still tells this one (the probe's second-tab case)
    test('the new worker\'s word reaches a page on the older version', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('the new worker\'s word shows no prompt on a page already on the new version', async () => {
        server.version = '1.3.1';
        const { fromWorker } = await startManager({ pageVersion: '1.3.1', cachedVersion: '1.3.1', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        assert.deepEqual(prompts(), []);
    });
});
