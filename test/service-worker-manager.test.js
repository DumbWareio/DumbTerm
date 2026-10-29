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
// or going wrong as `server` says. `held` keeps requests waiting until releaseHeld(), which answers them as the
// server is then, whether or not the page has given up on them. `offlineCopy` is a server that is down while the
// worker still answers a GET from its cache
const server = { version: '1.3.0', status: 200, header: true, down: false, held: false, offlineCopy: false };
const fetched = [];
const signals = [];
const held = [];

function releaseHeld() {
    held.splice(0).forEach((release) => release());
}

async function fetchFromServer(url, options = {}) {
    const method = options.method ?? 'GET';
    fetched.push({ url, method, cache: options.cache });
    signals.push(options.signal);
    if (server.held) await new Promise((resolve) => held.push(resolve));
    if (server.down || (server.offlineCopy && method !== 'GET')) throw new TypeError('Failed to fetch');
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
const PROMPT_1_3_2 = 'New version v1.3.2 available! Current: v1.3.0 Update Now Later';

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
        Object.assign(server, { version: '1.3.0', status: 200, header: true, down: false, held: false, offlineCopy: false });
        fetched.length = 0;
        signals.length = 0;
        held.length = 0;
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

    // The id the page sent with its last Update Now to the worker, which the worker's answer to it names
    function requestSent() {
        return navigator.serviceWorker.controller.messages.filter((message) => message.type === 'PERFORM_UPDATE').at(-1)?.requestId;
    }

    // The checks don't go through the worker, so a page no worker controls yet, or a browser without service
    // workers, asks the server too
    for (const [page, options] of [['a lone tab', {}], ['a page no worker controls yet', { controlled: false }],
        ['a page in a browser without service workers', { worker: false }]]) {
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

    test('shows the versions as text', async () => {
        await loneTabAcrossUpgrade();
        server.version = '1.3.1<b>beta</b>';
        await reconnect();
        assert.deepEqual(prompts(), ['New version v1.3.1<b>beta</b> available! Current: v1.3.0 Update Now Later']);
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

    test('Update Now asks the server with a HEAD request for config.js, under the base path', async () => {
        await loneTabAcrossUpgrade({ basePath: '/term' });
        await reconnect();
        await click('update-now');
        assert.deepEqual(fetched.at(-1), { url: '/term/config.js', method: 'HEAD', cache: 'no-store' });
    });

    test('Update Now when the server answers with an error says so and does not reload', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        server.status = 503;
        await click('update-now');
        assert.equal(window.location.reloads, 0);
        assert.deepEqual(prompts(), ['Can\'t reach the server. Try again when it\'s back. Dismiss']);
    });

    // A GET of config.js would get the worker's copy while the server is down
    test('Update Now does not take the worker\'s offline copy for the server', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        server.offlineCopy = true;
        await click('update-now');
        assert.equal(window.location.reloads, 0);
    });

    // An attempt the update timeout or Later gave up on is over: its request is called off, and an answer that
    // comes anyway changes nothing
    test('Update Now does not reload after the update timed out', async () => {
        const { displayed } = await loneTabAcrossUpgrade();
        await reconnect();
        server.held = true;
        await click('update-now');
        mock.timers.tick(30000);
        assert.deepEqual(prompts(), ['Update timed out. Please try again. Dismiss']);
        assert.equal(signals.at(-1)?.aborted, true, 'the request was called off');
        assert.equal(displayed.at(-1), '1.3.0', 'the footer is no longer loading');
        releaseHeld();
        await settle();
        assert.equal(window.location.reloads, 0);
    });

    test('Update Now that fails after the update timed out shows no second error', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        server.held = true;
        await click('update-now');
        mock.timers.tick(30000);
        server.down = true;
        releaseHeld();
        await settle();
        assert.deepEqual(prompts(), ['Update timed out. Please try again. Dismiss']);
    });

    // The prompt that replaces the timeout notice is not taken down by that notice's own 5 s timer
    test('Update Now that timed out leaves a prompt shown in the next 5 seconds up', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        server.held = true;
        await click('update-now');
        mock.timers.tick(30000);
        server.held = false;
        mock.timers.tick(1000);
        await reconnect();
        assert.deepEqual(prompts(), [PROMPT_1_3_1], 'the next check offers the update again');
        mock.timers.tick(5000);
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
        const requests = fetched.length;
        await reconnect();
        assert.equal(fetched.length, requests, 'no second request while the prompt is up');
    });

    test('Later while Update Now waits for the server calls the update off, with no error then or later', async () => {
        const { displayed } = await loneTabAcrossUpgrade();
        await reconnect();
        server.held = true;
        await click('update-now');
        await click('update-later');
        assert.equal(signals.at(-1)?.aborted, true, 'the request was called off');
        assert.equal(displayed.at(-1), '1.3.0', 'the footer is no longer loading');
        releaseHeld();
        await settle();
        mock.timers.tick(40000);
        assert.equal(window.location.reloads, 0);
        assert.deepEqual(prompts(), []);
    });

    // A worker's word for other versions can replace the prompt while its Update Now waits for the server
    test('Update Now on a prompt that replaced a waiting one calls the waiting one off', async () => {
        const { fromWorker } = await loneTabAcrossUpgrade({ controlled: false });
        await reconnect();
        server.held = true;
        await click('update-now');
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.2' });
        await click('update-now');
        assert.equal(signals.at(-2)?.aborted, true, 'the first request was called off');
        releaseHeld();
        await settle();
        assert.equal(window.location.reloads, 1);
    });

    // The worker's word for other versions can replace the prompt while its Update Now waits for the server: that
    // Update Now is over, as with Later, and whatever the server answers later changes nothing
    for (const [outcome, answer] of [['fails', () => { server.down = true; }], ['answers', () => {}]]) {
        test(`Update Now on a prompt the new worker's word replaced is called off, and a request that then ${outcome} changes nothing`, async () => {
            const { displayed, fromWorker } = await loneTabAcrossUpgrade();
            await reconnect();
            server.held = true;
            await click('update-now');
            fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.2' });
            assert.deepEqual(prompts(), [PROMPT_1_3_2]);
            assert.equal(displayed.at(-1), '1.3.0', 'the footer is no longer loading');
            assert.equal(signals.at(-1)?.aborted, true, 'the request was called off');
            answer();
            releaseHeld();
            await settle();
            assert.equal(window.location.reloads, 0);
            assert.deepEqual(prompts(), [PROMPT_1_3_2], 'the new prompt stays, with no error');
            mock.timers.tick(30000);
            assert.deepEqual(prompts(), [PROMPT_1_3_2], 'no "Update timed out" later on');
        });
    }

    // The worker tells every tab when an update another tab asked it for fails, and an older worker names no
    // request; this tab's Update Now asked the server, not the worker, so it goes on waiting for the server
    for (const [whose, requestId] of [['another tab\'s', 'tab-2'], ['an older worker\'s', undefined]]) {
        test(`Update Now waiting for the server is left alone when ${whose} update fails`, async () => {
            const { fromWorker } = await loneTabAcrossUpgrade();
            await reconnect();
            server.held = true;
            await click('update-now');
            fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId, success: false, error: 'boom' });
            fromWorker({ type: 'CACHE_VERSION_INFO', currentVersion: '1.3.1' });
            assert.deepEqual(prompts(), ['New version v1.3.1 available! Current: v1.3.0 Updating... Later']);
            assert.equal(signals.at(-1)?.aborted, false, 'the request goes on');
            releaseHeld();
            await settle();
            assert.equal(window.location.reloads, 1);
        });
    }

    test('a new Update Now after one called off with Later still reloads', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        server.held = true;
        await click('update-now');
        await click('update-later');
        server.held = false;
        await reconnect();
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
        await click('update-now');
        assert.equal(window.location.reloads, 1);
        releaseHeld();
        await settle();
        assert.equal(window.location.reloads, 1, 'the request called off changes nothing');
    });

    test('the error goes by itself, the footer shows the page\'s version again, and the update timeout is off', async () => {
        const { displayed } = await loneTabAcrossUpgrade();
        await reconnect();
        server.down = true;
        await click('update-now');
        assert.equal(displayed.at(-1), '1.3.0', 'no longer loading');
        mock.timers.tick(5000);
        assert.deepEqual(prompts(), []);
        mock.timers.tick(30000);
        assert.deepEqual(prompts(), [], 'no "Update timed out" later on');
    });

    test('Update Now in a browser without service workers reloads the page', async () => {
        await loneTabAcrossUpgrade({ worker: false });
        await reconnect();
        await click('update-now');
        assert.equal(window.location.reloads, 1);
    });

    // Later puts off the version it offered: switching back to the page doesn't bring it back, but the checks that
    // come with a reconnect or every hour do
    test('a version put off with Later is not offered again when the page becomes visible', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        await click('update-later');
        assert.deepEqual(prompts(), []);
        await becomeVisible();
        assert.deepEqual(prompts(), []);
    });

    for (const [when, check] of [['when a terminal tab reconnects', reconnect], ['on the hourly check', hourPasses]]) {
        test(`a version put off with Later is offered again ${when}`, async () => {
            await loneTabAcrossUpgrade();
            await reconnect();
            await click('update-later');
            await check();
            assert.deepEqual(prompts(), [PROMPT_1_3_1]);
        });
    }

    test('a version newer than the one put off with Later is offered when the page becomes visible', async () => {
        await loneTabAcrossUpgrade();
        await reconnect();
        await click('update-later');
        server.version = '1.3.2';
        await becomeVisible();
        assert.deepEqual(prompts(), ['New version v1.3.2 available! Current: v1.3.0 Update Now Later']);
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

    test('the new worker\'s versions are shown as text', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0<i>beta</i>', newVersion: '1.3.1<b>beta</b>' });
        assert.deepEqual(prompts(), ['New version v1.3.1<b>beta</b> available! Current: v1.3.0<i>beta</i> Update Now Later']);
    });

    test('Update Now on the new worker\'s word still asks the worker to update', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        assert.equal(performUpdates(), 1);
        assert.equal(window.location.reloads, 0);
    });

    // The worker tells every tab when an update it was asked for fails; only the tab whose Update Now waits says so
    test('Update Now on the new worker\'s word that fails says so, and the footer shows the page\'s version again', async () => {
        const { manager, displayed, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        assert.equal(displayed.at(-1), 'loading');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: requestSent(), success: false, error: 'boom' });
        assert.deepEqual(prompts(), ['Update failed: boom Dismiss']);
        assert.equal(displayed.at(-1), '1.3.0', 'the footer is no longer loading');
        assert.equal(manager.updateAttempt, null, 'the attempt is over');
        mock.timers.tick(5000);
        assert.deepEqual(prompts(), []);
        mock.timers.tick(30000);
        assert.deepEqual(prompts(), [], 'no "Update timed out" later on');
        assert.equal(displayed.at(-1), '1.3.0');
    });

    test('Update Now on the new worker\'s word shows the worker\'s error as text', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: requestSent(), success: false, error: '<b>x</b>' });
        assert.deepEqual(prompts(), ['Update failed: <b>x</b> Dismiss']);
    });

    // A worker from before the request ids names none: its failure still ends the Update Now waiting on it, rather
    // than leave it to time out
    test('Update Now on the new worker\'s word says so when an older worker\'s update fails', async () => {
        const { manager, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', success: false, error: 'boom' });
        assert.deepEqual(prompts(), ['Update failed: boom Dismiss']);
        assert.equal(manager.updateAttempt, null, 'the attempt is over');
    });

    // An Update Now called off by a newer prompt goes on in the worker, and its answer can come after the next one
    // started
    test('Update Now on a newer prompt goes on waiting when the update it replaced fails', async () => {
        const { manager, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        const replaced = requestSent();
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.2' });
        await click('update-now');
        assert.notEqual(requestSent(), replaced, 'each Update Now sends its own id');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: replaced, success: false, error: 'old' });
        fromWorker({ type: 'CACHE_VERSION_INFO', currentVersion: '1.3.1' });
        assert.deepEqual(prompts(), ['New version v1.3.2 available! Current: v1.3.0 Updating... Later']);
        assert.notEqual(manager.updateTimeout, null, 'its timeout still runs');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.2', requestId: requestSent(), success: false, error: 'new' });
        assert.deepEqual(prompts(), ['Update failed: new Dismiss']);
    });

    // With no worker in control when the user clicks, Update Now asks the server, even on the worker's prompt
    test('Update Now on the new worker\'s word with no worker in control is left alone when a worker\'s update fails', async () => {
        const { manager, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        navigator.serviceWorker.controller = null;
        server.held = true;
        await click('update-now');
        assert.equal(fetched.at(-1)?.method, 'HEAD', 'it asked the server');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', success: false, error: 'boom' });
        assert.deepEqual(prompts(), ['New version v1.3.1 available! Current: v1.3.0 Updating... Later']);
        assert.notEqual(manager.updateAttempt, null, 'the attempt still waits');
        assert.notEqual(manager.updateTimeout, null, 'its timeout still runs');
        releaseHeld();
        await settle();
        assert.equal(window.location.reloads, 1);
    });

    // The worker's word for the versions already offered leaves the prompt and its waiting Update Now as they are
    test('Update Now on the new worker\'s word goes on waiting when the worker offers the same versions again', async () => {
        const { manager, displayed, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        assert.notEqual(manager.updateAttempt, null, 'the attempt still waits');
        assert.equal(displayed.at(-1), 'loading');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: requestSent(), success: false, error: 'boom' });
        assert.deepEqual(prompts(), ['Update failed: boom Dismiss']);
    });

    test('Update Now on the new worker\'s word that fails after the update timed out shows no second error', async () => {
        const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        mock.timers.tick(30000);
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: requestSent(), success: false, error: 'boom' });
        assert.deepEqual(prompts(), ['Update timed out. Please try again. Dismiss']);
    });

    test('Update Now on the new worker\'s word that a newer prompt replaced shows no error when it fails', async () => {
        const { displayed, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        await click('update-now');
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.2' });
        assert.equal(displayed.at(-1), '1.3.0', 'the footer is no longer loading');
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: requestSent(), success: false, error: 'boom' });
        assert.deepEqual(prompts(), [PROMPT_1_3_2]);
    });

    test('an update that fails in another tab leaves this tab\'s prompt as it is', async () => {
        const { displayed, fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
        fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
        const footer = displayed.length;
        fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', requestId: 'tab-2', success: false, error: 'boom' });
        assert.deepEqual(prompts(), [PROMPT_1_3_1]);
        assert.equal(displayed.length, footer, 'the footer is left as it is');
    });

    // A finished update reloads every tab, whether or not it asked, to the version the server now runs
    for (const [tab, clickUpdateNow] of [['the tab that asked', true], ['a tab that did not ask', false]]) {
        test(`an update the worker finished reloads ${tab}`, async () => {
            const { fromWorker } = await startManager({ pageVersion: '1.3.0', cachedVersion: '1.3.0', controlled: true });
            fromWorker({ type: 'UPDATE_AVAILABLE', currentVersion: '1.3.0', newVersion: '1.3.1' });
            if (clickUpdateNow) await click('update-now');
            fromWorker({ type: 'UPDATE_COMPLETE', version: '1.3.1', success: true });
            mock.timers.tick(100);
            assert.equal(window.location.reloads, 1);
        });
    }

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
