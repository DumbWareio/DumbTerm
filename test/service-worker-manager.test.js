/**
 * Unit tests for public/managers/serviceWorker.js (the page side of the service worker).
 * Loads the real ES module with minimal stand-ins for the browser globals it touches.
 */
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MANAGER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'managers', 'serviceWorker.js'), 'utf8');
const BROWSER_GLOBALS = ['window', 'navigator', 'document', 'caches', 'fetch'];
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

// Just enough of an element for the update prompt: markup set with innerHTML becomes one level of children, each
// with its tag, class, id and text, and text set with textContent stays text
class HeadlessElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.className = '';
        this.id = '';
        this.disabled = false;
        this.parent = null;
        this.children = [];
        this.text = '';
        this.listeners = new Map();
    }

    set innerHTML(html) {
        this.children = [...html.matchAll(/<(\w+)([^>]*)>([^<]*)<\/\1>/g)].map(([, tagName, attributes, text]) => {
            const child = new HeadlessElement(tagName);
            child.className = attributes.match(/class="([^"]*)"/)?.[1] ?? '';
            child.id = attributes.match(/id="([^"]*)"/)?.[1] ?? '';
            child.text = text;
            child.parent = this;
            return child;
        });
        this.text = this.children.length ? '' : html;
    }

    set textContent(text) {
        this.children = [];
        this.text = String(text);
    }

    get textContent() {
        return this.children.length ? this.children.map((child) => child.textContent).join(' ') : this.text;
    }

    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
        return this.tagName === selector.toUpperCase();
    }

    querySelectorAll(selector) {
        return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    appendChild(child) {
        child.parent = this;
        this.children.push(child);
    }

    remove() {
        if (!this.parent) return;
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    click() {
        (this.listeners.get('click') ?? []).forEach((listener) => listener());
    }
}

function headlessDocument() {
    const body = new HeadlessElement('body');
    return listeningTarget({
        visibilityState: 'visible',
        body,
        createElement: (tagName) => new HeadlessElement(tagName),
        querySelectorAll: (selector) => body.querySelectorAll(selector),
        getElementById: (id) => body.querySelector(`#${id}`),
    });
}

// The server the page asks for its version: a HEAD request for config.js, answered with the version in a header,
// or going wrong as `server` says
const server = { version: '1.3.0', status: 200, header: true, down: false };
const fetched = [];

async function fetchFromServer(url, options = {}) {
    fetched.push({ url, method: options.method ?? 'GET', cache: options.cache });
    if (server.down) throw new TypeError('Failed to fetch');
    const headers = new Map(server.header && server.version !== undefined ? [['x-dumbterm-version', server.version]] : []);
    return {
        ok: server.status >= 200 && server.status < 300,
        status: server.status,
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    };
}

// The worker controlling the page, keeping the messages the page posts to it
function controllingWorker() {
    return { messages: [], postMessage(message) { this.messages.push(message); } };
}

// Let the manager's promises (the cache lookup, the registration, a request to the server) settle
async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Start a manager on a page running `pageVersion` whose cache still holds `cachedVersion`. `controlled` gives the
// page a worker; `worker: false` is a browser with no service workers at all, as on plain http to a LAN address
async function startManager({ pageVersion, cachedVersion, basePath = '', controlled = false, worker = true }) {
    globalThis.window = listeningTarget({
        appConfig: pageVersion ? { version: pageVersion, basePath } : undefined,
        location: { reloads: 0, reload() { this.reloads++; } },
    });
    const workerListeners = [];
    // Node already defines a read-only `navigator` global, so replace it rather than assign to it
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: worker ? {
            serviceWorker: {
                controller: controlled ? controllingWorker() : null,
                ready: Promise.resolve({ active: { postMessage() {} } }),
                register: async () => ({ scope: '/', addEventListener() {} }),
                addEventListener(type, listener) { if (type === 'message') workerListeners.push(listener); },
            },
        } : {},
    });
    globalThis.document = headlessDocument();
    globalThis.caches = { keys: async () => (cachedVersion ? [`DUMBTERM_CACHE_V${cachedVersion}`] : []) };
    globalThis.fetch = fetchFromServer;

    const displayed = [];
    const ServiceWorkerManager = await loadManager();
    const manager = new ServiceWorkerManager();
    manager.initialize((version, loading) => displayed.push(loading ? 'loading' : version));
    // Let the startup cache lookup resolve
    await settle();
    const fromWorker = (data) => workerListeners.forEach((listener) => listener({ data }));
    return { manager, displayed, fromWorker };
}

// The update prompts and errors on the page, as text
function prompts() {
    return document.querySelectorAll('.update-notification').map((element) => element.textContent.replace(/\s+/g, ' ').trim());
}

async function click(id) {
    document.getElementById(id).click();
    await settle();
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
        Object.assign(server, { version: '1.3.0', status: 200, header: true, down: false });
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

    async function hourPasses() {
        mock.timers.tick(60 * 60 * 1000);
        await settle();
    }

    function performUpdates() {
        return navigator.serviceWorker.controller.messages.filter((message) => message.type === 'PERFORM_UPDATE').length;
    }

    // The checks don't go through the worker, so a page no worker controls yet asks the server too
    for (const [page, options] of [['a lone tab', {}], ['a page no worker controls yet', { controlled: false }]]) {
        for (const [when, check] of [['when a terminal tab reconnects', reconnect],
            ['when the page becomes visible', becomeVisible], ['on the hourly check', hourPasses]]) {
            test(`${page} offers the server's new version ${when}`, async () => {
                await loneTabAcrossUpgrade(options);
                await check();
                assert.deepEqual(prompts(), [PROMPT_1_3_1]);
            });
        }
    }

    // A page should match the server it talks to, so a server rolled back to an older image is offered too
    test('a page newer than the server offers the server\'s version', async () => {
        await loneTabAcrossUpgrade();
        server.version = '1.2.0';
        await reconnect();
        assert.deepEqual(prompts(), ['New version v1.2.0 available! Current: v1.3.0 Update Now Later']);
    });

    // The worker passes requests other than GET to the network and caches none of them, so the answer is never
    // one it kept from before, and it never serves the new version's config.js to the old page offline
    test('asks the server with a HEAD request for config.js, under the base path', async () => {
        await loneTabAcrossUpgrade({ basePath: '/term' });
        await reconnect();
        assert.deepEqual(fetched, [{ url: '/term/config.js', method: 'HEAD', cache: 'no-store' }]);
    });

    // The worker controlling the page caches the release it was registered with, so it can't install the server's
    // new one; a reload loads it, network-first
    test('Update Now on the server\'s new version reloads the page once the server answers', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        await click('update-now');
        assert.equal(window.location.reloads, 1);
        assert.equal(fetched.length, 2, 'it asked the server before reloading');
        assert.equal(performUpdates(), 0);
    });

    // A reload with the server down would leave the page on the worker's offline copy, or on an error page
    test('Update Now while the server is down says so and does not reload', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        server.down = true;
        await click('update-now');
        assert.equal(window.location.reloads, 0);
        assert.deepEqual(prompts(), ['Can\'t reach the server. Try again when it\'s back. Dismiss']);

        server.down = false;
        await reconnect();
        assert.deepEqual(prompts(), [PROMPT_1_3_1], 'the next check offers the update again');
        await click('update-now');
        assert.equal(window.location.reloads, 1);
    });

    test('a prompt put off with Later comes back on the next check', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        await click('update-later');
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

    // A failure while showing the prompt is a bug to report, not a server that could not be reached
    test('only a failed request counts as the server not answering', async () => {
        const { manager } = await loneTabAcrossUpgrade();
        manager.showUpdateNotification = () => { throw new Error('a bug'); };
        await assert.rejects(manager.checkVersion(), /a bug/);
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
        ['sends no version header (one from before it had it)', () => { server.header = false; }],
        ['cannot be reached', () => { server.down = true; }],
        ['answers with an error', () => { server.status = 500; }],
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

    test('a page that does not know its own version shows no prompt', async () => {
        server.version = '1.3.1';
        await startManager({ pageVersion: undefined, cachedVersion: '1.3.0', controlled: true });
        await reconnect();
        await becomeVisible();
        assert.equal(fetched.length >= 2, true, 'it asked the server');
        assert.deepEqual(prompts(), []);
    });

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

    // Guards: a newer worker installed by another tab still tells this one
    test('the new worker\'s word reaches a page on the older version', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
    });

    test('Update Now on the new worker\'s word still asks the worker to update', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        assert.equal(performUpdates(), 1);
        assert.equal(window.location.reloads, 0);
    });

    // The same versions from the worker while the server's prompt is up leave that prompt as it is, so its
    // Update Now still reloads
    test('the new worker\'s word while the server\'s prompt is up leaves that prompt', async () => {
        const { fromWorker } = await loneTabAcrossUpgrade();
        await reconnect();
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
        await click('update-now');
        assert.equal(window.location.reloads, 1);
        assert.equal(performUpdates(), 0);
    });

    test('a worker reporting no change shows no prompt', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.1', newVersion: '1.3.1' });
        assert.deepEqual(prompts(), []);
    });

    test('the new worker\'s word shows no prompt on a page already on the new version', async () => {
        server.version = '1.3.1';
        const { fromWorker } = await startManager({ pageVersion: '1.3.1', cachedVersion: '1.3.1', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        assert.deepEqual(prompts(), []);
    });
});
