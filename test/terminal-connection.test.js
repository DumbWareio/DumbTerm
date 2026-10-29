/**
 * Behavioural tests for how a browser terminal tab (public/managers/terminal.js) keeps its connection to the
 * server: which closes it reconnects after, how many sockets it opens while the server is away, what it says
 * meanwhile, and that closing the tab ends it. Runs the real TerminalManager.initTerminal and handleTabClose
 * against the real @xterm/xterm build, on a fake clock, with a stand-in WebSocket whose server the test starts,
 * stops and makes hang.
 */
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Terminal: XtermTerminal } = require('@xterm/xterm');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const MANAGERS_URL = pathToFileURL(path.join(__dirname, '..', 'public', 'managers') + path.sep).href;
const TERMINAL_MANAGER_URL = new URL('terminal.js', MANAGERS_URL).href;

// The page's managers are browser ES modules in a package without "type": "module" (see
// terminal-control-sequences.test.js)
registerHooks({
    load(url, context, nextLoad) {
        return nextLoad(url, url.startsWith(MANAGERS_URL) ? { ...context, format: 'module' } : context);
    },
});

// focus() needs a document. This one keeps whether focus reports were on each time the page focused the
// terminal, and sends one (CSI I) when they were, as the browser's focus event does
class HeadlessPageTerminal extends XtermTerminal {
    focusedWithReports = [];
    open() {}
    focus() {
        this.focusedWithReports.push(this.modes.sendFocusMode);
        if (this.modes.sendFocusMode) this.input('\x1b[I', false);
    }
}

class StubAddon {
    activate() {}
    dispose() {}
    fit() {}
}

class FailingWebglAddon extends StubAddon {
    activate() { throw new Error('WebGL is not available'); }
    onContextLoss() {}
}

// The server the page connects to. While it is up a new socket opens 50ms after it is created, while it is down
// the socket is refused after 50ms, and while it hangs (a proxy in front of a server that is not listening yet)
// the socket is never answered
const server = { up: true, hang: false };

// Milliseconds on the fake clock since the tab's first connection opened (see wait)
let now = 0;

// Stands in for the page's WebSockets the way a browser runs them: a socket starts out connecting, close()
// on one that is still connecting fails it (error, then close 1006), the close event comes after close()
// returns, and what is sent on a socket closing or closed is dropped (the browser logs that it was)
class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static all = [];
    static mostConnecting = 0;

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.sentWhileClosed = 0;
        this.closeListeners = [];
        this.closedWith = undefined;
        this.createdAt = now;
        FakeWebSocket.all.push(this);
        FakeWebSocket.mostConnecting = Math.max(FakeWebSocket.mostConnecting,
            FakeWebSocket.all.filter((socket) => socket.readyState === FakeWebSocket.CONNECTING).length);
        if (!server.hang) setTimeout(() => (server.up ? this.accept() : this.fail()), 50);
    }

    static get last() { return FakeWebSocket.all.at(-1); }
    static get open() { return FakeWebSocket.all.filter((socket) => socket.readyState === FakeWebSocket.OPEN); }

    send(data) {
        if (this.readyState === FakeWebSocket.CONNECTING) throw new Error('InvalidStateError: still connecting');
        if (this.readyState === FakeWebSocket.OPEN) this.sent.push(JSON.parse(data));
        else this.sentWhileClosed++;
    }

    close(code) {
        if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) return;
        const connecting = this.readyState === FakeWebSocket.CONNECTING;
        this.readyState = FakeWebSocket.CLOSING;
        this.closedWith = code ?? null;
        setTimeout(() => (connecting ? this.fail() : this.closes({ code: code ?? 1005, wasClean: true })), 0);
    }

    addEventListener(type, listener) {
        if (type === 'close') this.closeListeners.push(listener);
    }

    // The server's side
    accept() {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    fail() {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.onerror?.(new Error('connection refused'));
        this.dispatchClose({ code: 1006, wasClean: false });
    }

    closes(event) {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchClose(event);
    }

    dispatchClose(event) {
        this.onclose?.(event);
        this.closeListeners.forEach((listener) => listener(event));
    }

    inputs() { return this.sent.filter((message) => message.type === 'input').map((message) => message.data); }
    count(type) { return this.sent.filter((message) => message.type === type).length; }
}

// window and document, keeping the listeners the page adds so a test can fire them and see which are left, and
// the events the page dispatches
function listeningTarget(properties) {
    const listeners = new Map();
    const dispatched = [];
    return {
        ...properties,
        listeners,
        dispatched,
        dispatchEvent(event) {
            dispatched.push(event.type);
            [...(listeners.get(event.type) ?? [])].forEach((listener) => listener(event));
            return true;
        },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        fire(type) { [...(listeners.get(type) ?? [])].forEach((listener) => listener({ type })); },
        listening(type) { return listeners.get(type)?.size ?? 0; },
    };
}

const BROWSER_GLOBALS = ['window', 'document', 'getComputedStyle', 'MutationObserver', 'WebSocket', 'Terminal',
    'FitAddon', 'WebLinksAddon', 'WebglAddon', 'ImageAddon', 'SearchAddon', 'SerializeAddon', 'Unicode11Addon'];

function installBrowserGlobals() {
    globalThis.window = listeningTarget({
        location: { protocol: 'http:', host: 'localhost', href: '' },
        appConfig: { basePath: '' },
    });
    const body = { querySelectorAll: () => [] };
    globalThis.document = listeningTarget({
        documentElement: {},
        body,
        activeElement: body,
        visibilityState: 'visible',
    });
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    // The page's theme observer, which a closed tab no longer needs
    globalThis.MutationObserver = class {
        static all = [];
        constructor() { this.observing = false; MutationObserver.all.push(this); }
        observe() { this.observing = true; }
        disconnect() { this.observing = false; }
    };
    globalThis.WebSocket = FakeWebSocket;
    globalThis.Terminal = HeadlessPageTerminal;
    globalThis.FitAddon = { FitAddon: StubAddon };
    globalThis.WebLinksAddon = { WebLinksAddon: StubAddon };
    globalThis.WebglAddon = { WebglAddon: FailingWebglAddon };
    globalThis.ImageAddon = { ImageAddon: StubAddon };
    globalThis.SearchAddon = { SearchAddon: StubAddon };
    globalThis.SerializeAddon = { SerializeAddon: StubAddon };
    globalThis.Unicode11Addon = { Unicode11Addon };
}

// What can have the keyboard: a terminal's textarea is inside the page's terminals container, the search box
// and the input for renaming a tab are not
const TERMINAL_TEXTAREA = { closest: (selector) => (selector === '.terminals-container' ? {} : null) };
const SEARCH_BOX = { closest: () => null };

const LOST = 'Connection lost. Attempting to reconnect...';
const NOT_AVAILABLE = 'Connection not available. Attempting to reconnect...';
const CLOSED_NORMALLY = 'Connection closed normally.';
const RAN_OUT = 'Connection lost. Press any key to reconnect, or refresh the page.';

describe('terminal connection', () => {
    let TerminalManager;
    let manager;
    let terminal;
    let originalGlobals;

    before(async () => {
        originalGlobals = new Map(BROWSER_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        installBrowserGlobals();
        ({ default: TerminalManager } = await import(TERMINAL_MANAGER_URL));
    });

    after(() => {
        for (const [name, descriptor] of originalGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });

    // Each test opens one tab, Term1, beside a second one so closing it leaves the manager a tab, and lets the
    // tab's first connection open
    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        // xterm parses with setTimeout(fn) and no delay; give it the 0 a browser would (see
        // terminal-control-sequences.test.js)
        const mockedSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay = 0, ...args) => mockedSetTimeout(callback, delay, ...args);
        mock.method(console, 'warn', () => {});
        mock.method(console, 'error', () => {});

        installBrowserGlobals();
        Object.assign(server, { up: true, hang: false });
        FakeWebSocket.all = [];
        manager = {
            terminalAddons: new Map(),
            terminals: new Map(),
            activeTabId: 2,
            saveSessionState() {},
            checkTabOverflow() {},
            activateTab() {},
        };
        terminal = TerminalManager.prototype.initTerminal.call(manager, {});
        manager.terminals.set(1, { tab: { remove() {} }, container: { remove() {} }, terminal });
        manager.terminals.set(2, { tab: { remove() {} }, container: { remove() {} }, terminal: { dispose() {} } });
        wait(50);
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN, 'the tab connected');
        FakeWebSocket.mostConnecting = 0;
        now = 0;
    });

    afterEach(() => {
        if (manager.terminals.has(1)) terminal.dispose();
        mock.timers.reset();
        mock.restoreAll();
    });

    // Let `ms` pass a millisecond at a time. mock.timers.tick(ms) moves the clock to its end first, so a timer
    // armed by one that runs on the way (each retry arms the next) would be due `ms` too late
    function wait(ms) {
        for (let elapsed = 0; elapsed < ms; elapsed++) {
            now++;
            mock.timers.tick(1);
        }
    }

    function closeTab() {
        TerminalManager.prototype.handleTabClose.call(manager, 1);
    }

    function type(data) {
        terminal.input(data, true);
    }

    // Lines of the tab's screen and scrollback that say `text`, once xterm has parsed what the page wrote
    function linesSaying(text) {
        mock.timers.tick(0);
        const buffer = terminal.buffer.active;
        return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true))
            .filter((line) => line.includes(text)).length;
    }

    // A click in the terminal, which xterm reports to the shell as input while a program has mouse reports on
    // in SGR encoding (in the default one it reports them as binary data, which the page does not send)
    function click() {
        terminal._core.coreMouseService.triggerMouseEvent({ col: 0, row: 0, x: 0, y: 0, button: 0, action: 1,
            ctrl: false, alt: false, shift: false });
    }

    // vim turns focus reports and mouse reports on
    function openVim() {
        FakeWebSocket.last.onmessage({ data: JSON.stringify({ type: 'output',
            data: '\x1b[?1049h\x1b[?1004h\x1b[?1000h\x1b[?1006hVIM' }) });
        wait(1);
        assert.equal(terminal.modes.sendFocusMode, true);
        assert.equal(terminal.modes.mouseTrackingMode, 'vt200');
    }

    function socketsSince(socket) {
        return FakeWebSocket.all.slice(FakeWebSocket.all.indexOf(socket) + 1);
    }

    for (const [code, reason] of [[1001, 'shutting down'], [1012, 'restarting']]) {
        test(`a server ${reason} (${code}) gets the tab a new shell once it is back, without a key typed`, () => {
            const first = FakeWebSocket.last;
            server.up = false;
            first.closes({ code, wasClean: true });
            wait(3000);
            server.up = true;
            wait(10000);

            const reconnected = FakeWebSocket.last;
            assert.notEqual(reconnected, first, 'the tab reconnected');
            assert.equal(reconnected.readyState, FakeWebSocket.OPEN);
            assert.equal(reconnected.count('resize'), 1, 'and told the new shell its size');
            assert.equal(linesSaying(CLOSED_NORMALLY), 0);
            assert.equal(linesSaying(LOST), 1, 'said so once');
        });
    }

    // The page checks the server's version when a tab reconnects, as an upgrade restarts the server (#50)
    test('a tab reconnecting after the server went away tells the page once', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1001, wasClean: true });
        wait(3000);
        server.up = true;
        wait(10000);

        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN, 'the tab reconnected');
        assert.ok(socketsSince(first).length > 1, 'after attempts that were refused');
        assert.deepEqual(window.dispatched, ['dumbterm:reconnected']);
    });

    test('a tab\'s first connection does not count as reconnecting', () => {
        assert.deepEqual(window.dispatched, []);
    });

    test('a tab whose shell exited tells the page when a key gets it a new one', () => {
        FakeWebSocket.last.closes({ code: 1005, wasClean: true });
        wait(1000);
        assert.deepEqual(window.dispatched, [], 'not while it waits for a key');
        type('a');
        wait(1000);
        assert.deepEqual(window.dispatched, ['dumbterm:reconnected']);
    });

    // Guards: these closes were final before, and stay final
    for (const [code, what] of [[1005, 'the shell exits'], [1000, 'the server closes normally']]) {
        test(`when ${what} (${code}) the tab stays closed until a key is typed`, () => {
            const first = FakeWebSocket.last;
            first.closes({ code, wasClean: true });
            wait(60000);

            assert.equal(FakeWebSocket.last, first, 'no new socket');
            assert.equal(linesSaying(CLOSED_NORMALLY), 1);
            assert.equal(linesSaying(LOST), 0);
        });
    }

    // A shell that fails to start (#46): the server closes with 1011 and why, which the tab says instead of the line
    // for a shell that exited, and stays closed, as retrying by itself would fail the same way
    for (const [reason, says] of [['Shell exited with code 1', 'Shell exited with code 1'],
        ['Failed to start terminal', 'Failed to start terminal'], ['', 'Failed to start terminal']]) {
        test(`when the shell fails to start (1011, ${JSON.stringify(reason)}) the tab says so and stays closed until a key is typed`, () => {
            const first = FakeWebSocket.last;
            first.closes({ code: 1011, reason, wasClean: true });
            wait(60000);

            assert.equal(FakeWebSocket.last, first, 'no new socket');
            assert.equal(linesSaying(`The server could not start a shell: ${says}.`), 1);
            assert.equal(linesSaying(CLOSED_NORMALLY), 0);
            assert.equal(linesSaying(LOST), 0);
        });
    }

    test('a key after a shell that failed to start makes one new attempt, which ends the same way', () => {
        const first = FakeWebSocket.last;
        first.closes({ code: 1011, reason: 'Shell exited with code 1', wasClean: true });
        wait(1000);
        type('a');
        wait(1000);
        const retry = FakeWebSocket.last;
        assert.deepEqual(socketsSince(first), [retry], 'one new attempt');
        retry.closes({ code: 1011, reason: 'Shell exited with code 1', wasClean: true });
        wait(60000);

        assert.equal(FakeWebSocket.last, retry, 'and no more');
        assert.equal(linesSaying('The server could not start a shell: Shell exited with code 1.'), 2);
        assert.equal(linesSaying(CLOSED_NORMALLY), 0);
    });

    // Guard: only a close the server reports as failed (1011) says the shell could not start, whatever its reason
    test('a shell that exits (1005) with a reason still says it closed normally', () => {
        FakeWebSocket.last.closes({ code: 1005, reason: 'Shell exited with code 1', wasClean: true });
        wait(1000);
        assert.equal(linesSaying(CLOSED_NORMALLY), 1);
        assert.equal(linesSaying('could not start a shell'), 0);
    });

    // Guard
    test('a refused login (1008) sends the page to the login page and does not reconnect', () => {
        const first = FakeWebSocket.last;
        first.closes({ code: 1008, wasClean: true });
        wait(60000);

        assert.equal(window.location.href, 'login');
        assert.equal(FakeWebSocket.last, first, 'no new socket');
    });

    test('an outage of hung and refused attempts ends with one connection, and never more than one connecting', () => {
        const first = FakeWebSocket.last;
        // The server goes, a proxy holds the first attempt until the page gives up on it after 5s, then the
        // server refuses for a while, and is back 12s after the drop
        server.up = false;
        server.hang = true;
        first.closes({ code: 1006, wasClean: false });
        wait(6000);
        server.hang = false;
        wait(6000);
        server.up = true;
        wait(60000);

        // Retries 1s (hung, given up at 6s), 2s later (refused at 8s), 4s later (opens at 12s)
        const after = socketsSince(first);
        assert.equal(after.length, 3, 'three attempts');
        assert.equal(FakeWebSocket.mostConnecting, 1, 'never more than one connecting at a time');
        assert.deepEqual(FakeWebSocket.open, [after.at(-1)], 'exactly one open, the last');
        assert.equal(linesSaying(LOST), 1, 'one line for the whole outage');

        const reconnected = after.at(-1);
        const heartbeats = reconnected.count('heartbeat');
        wait(30000);
        assert.equal(reconnected.count('heartbeat'), heartbeats + 3, 'one heartbeat every 10s');
    });

    test('each outage says once that the tab is reconnecting', () => {
        for (let outage = 1; outage <= 3; outage++) {
            FakeWebSocket.last.closes({ code: 1006, wasClean: false });
            wait(2000);
            assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
            assert.equal(linesSaying(LOST), outage);
        }
    });

    test('an attempt that times out is retried once, on the usual backoff', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        server.hang = true;
        first.closes({ code: 1006, wasClean: false });
        wait(1000);
        const hung = FakeWebSocket.last;
        assert.notEqual(hung, first);

        wait(5000);
        assert.equal(hung.readyState, FakeWebSocket.CLOSED, 'the page gave up on it after 5s');
        wait(2000);
        assert.equal(socketsSince(hung).length, 1, 'and retried 2s later, once');

        wait(60000);
        // Each attempt is given up after 5s, then retried 1, 2, 4, 8 and 16s on
        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt), [1000, 8000, 17000, 30000, 51000]);
        assert.equal(FakeWebSocket.mostConnecting, 1, 'never more than one connecting at a time');
        assert.equal(linesSaying(RAN_OUT), 1);
    });

    test('keys typed while the tab reconnects open no socket of their own and say nothing more', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        type('a');
        wait(1000);
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.CONNECTING);
        type('b');
        type('c');
        wait(100);
        type('d');
        server.up = true;
        wait(2000);

        assert.equal(socketsSince(first).length, 2, 'refused once, then opened');
        assert.equal(FakeWebSocket.mostConnecting, 1);
        assert.equal(FakeWebSocket.open.length, 1);
        assert.deepEqual(FakeWebSocket.last.inputs(), [], 'the keys are dropped, not sent to the new shell');
        assert.equal(linesSaying(LOST) + linesSaying(NOT_AVAILABLE), 1, 'one line for the whole outage');
    });

    test('keys typed while a retry waits leave the backoff as it was', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        // Refused at 1s and 3s; the third retry waits for 7.1s
        wait(4000);
        type('a');
        wait(60000);

        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt), [1000, 3050, 7100, 15150, 31200]);
    });

    test('after the shell exits, the first key reconnects and the next ones open no second socket', () => {
        const first = FakeWebSocket.last;
        first.closes({ code: 1005, wasClean: true });
        type('a');
        type('b');
        wait(10);
        type('c');
        wait(1000);

        assert.equal(socketsSince(first).length, 1);
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
        assert.deepEqual(FakeWebSocket.last.inputs(), []);
        assert.equal(linesSaying(NOT_AVAILABLE), 1);

        type('d');
        assert.deepEqual(FakeWebSocket.last.inputs(), ['d'], 'once connected, keys go to the new shell');
    });

    // The page closing a socket it gave up on, or the server closing one, takes a moment; the socket is still
    // the tab's connection until it has closed
    test('a key typed while the socket is closing opens no second socket and says nothing', () => {
        const first = FakeWebSocket.last;
        first.readyState = FakeWebSocket.CLOSING;
        type('a');
        wait(100);
        assert.equal(FakeWebSocket.last, first, 'no socket while the old one closes');
        assert.equal(linesSaying(NOT_AVAILABLE), 0);

        first.closes({ code: 1006, wasClean: false });
        wait(1100);
        assert.equal(socketsSince(first).length, 1, 'then the retry, 1s after it closed');
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
    });

    // The close that follows can be final, and the tab would have said it was reconnecting
    test('a key typed while the shell\'s close is under way leaves the tab to say only that it closed', () => {
        const first = FakeWebSocket.last;
        first.readyState = FakeWebSocket.CLOSING;
        type('a');
        first.closes({ code: 1005, wasClean: true });
        wait(60000);

        assert.equal(FakeWebSocket.last, first, 'no new socket');
        assert.equal(linesSaying(CLOSED_NORMALLY), 1);
        assert.equal(linesSaying(NOT_AVAILABLE), 0);
    });

    // A server stopped for longer than the retries last, then started again
    test('once the retries run out, a key reconnects the tab when the server is back', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1001, wasClean: true });
        wait(60000);
        assert.equal(socketsSince(first).length, 5, 'five retries');
        assert.equal(linesSaying(RAN_OUT), 1);

        server.up = true;
        type('a');
        type('b');
        wait(60000);
        assert.equal(socketsSince(first).length, 6, 'one more socket');
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
        assert.deepEqual(FakeWebSocket.last.inputs(), [], 'the keys are dropped');
    });

    test('once the retries run out, the first key says once that the tab is reconnecting', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(60000);
        assert.equal(linesSaying(NOT_AVAILABLE), 0);

        type('a');
        type('b');
        wait(10);
        type('c');
        assert.equal(socketsSince(first).length, 6, 'one socket for the keys');
        assert.equal(linesSaying(NOT_AVAILABLE), 1);
        assert.equal(linesSaying(LOST), 1, 'and the round the key started says nothing more');
        wait(60000);
        assert.equal(linesSaying(NOT_AVAILABLE) + linesSaying(LOST), 2);
    });

    test('once the retries run out, a key while the server is still away starts a new round of them', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(60000);

        type('a');
        const keyed = FakeWebSocket.last;
        assert.equal(keyed.createdAt, 60000, 'the key connects at once');
        wait(60000);
        // Retried 1, 2, 4, 8 and 16s after each refusal, as the first round was
        assert.deepEqual(socketsSince(keyed).map((socket) => socket.createdAt - 60000), [1050, 3100, 7150, 15200, 31250]);
        assert.equal(FakeWebSocket.mostConnecting, 1);
        assert.equal(linesSaying(RAN_OUT), 2);
    });

    // The browser sends them as input, but nobody typed them
    test('once the retries run out, focus and mouse reports a program left on are no keys', () => {
        openVim();
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(60000);
        const sockets = FakeWebSocket.all.length;
        terminal.focus();
        wait(1000);
        assert.equal(FakeWebSocket.all.length, sockets, 'no socket for a focus report');
        click();
        wait(1000);
        assert.equal(FakeWebSocket.all.length, sockets, 'nor for a mouse report');
        assert.equal(linesSaying(NOT_AVAILABLE), 0);

        type('a');
        assert.equal(FakeWebSocket.all.length, sockets + 1, 'a key still reconnects');
        assert.equal(linesSaying(NOT_AVAILABLE), 1);
    });

    test('after the shell exits, focus and mouse reports a program left on get the tab no new shell', () => {
        openVim();
        const first = FakeWebSocket.last;
        first.closes({ code: 1005, wasClean: true });
        wait(1000);
        terminal.focus();
        wait(1000);
        assert.equal(FakeWebSocket.last, first, 'no socket for a focus report');
        click();
        wait(1000);
        assert.equal(FakeWebSocket.last, first, 'nor for a mouse report');
        assert.equal(linesSaying(NOT_AVAILABLE), 0);

        type('a');
        wait(1000);
        assert.equal(socketsSince(first).length, 1, 'a key still reconnects');
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
    });

    test('a key typed after a retry is refused opens one socket, and a late close of the old one starts nothing', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1005, wasClean: true });
        type('a');
        const refused = FakeWebSocket.last;
        // The browser reports the refused socket's error, and the page takes a key, before its close event
        wait(49);
        refused.readyState = FakeWebSocket.CLOSED;
        refused.onerror(new Error('connection refused'));
        server.up = true;
        type('b');
        wait(50);
        const reconnected = FakeWebSocket.last;
        assert.equal(reconnected.readyState, FakeWebSocket.OPEN);
        const lines = linesSaying(LOST) + linesSaying(NOT_AVAILABLE);

        refused.dispatchClose({ code: 1006, wasClean: false });
        wait(60000);
        assert.equal(socketsSince(first).length, 2, 'no socket after the reconnected one');
        assert.equal(FakeWebSocket.open.length, 1);
        assert.equal(linesSaying(LOST) + linesSaying(NOT_AVAILABLE), lines, 'nothing said about the old socket');
    });

    // A laptop waking up while the tab waits out its backoff
    test('coming back to the page while a retry waits connects at once, with the retries renewed', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        // Refused at 1s and 3s; the third retry waits for 7.1s
        wait(4000);
        document.fire('visibilitychange');
        wait(60000);

        // Then retried 1, 2, 4, 8 and 16s after each refusal; the retry that waited is called off
        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt),
            [1000, 3050, 4000, 5050, 7100, 11150, 19200, 35250]);
        assert.equal(FakeWebSocket.mostConnecting, 1);
        assert.equal(linesSaying(RAN_OUT), 1);
    });

    test('coming back to the page while a retry waits gets the tab back as soon as the server is', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(4000);
        server.up = true;
        document.fire('visibilitychange');
        wait(60000);

        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt), [1000, 3050, 4000]);
        assert.deepEqual(FakeWebSocket.open, [FakeWebSocket.last]);
    });

    test('coming back to the page while an attempt connects leaves the retries after it as they were', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        // Refused at 1s; the second attempt, at 3s, hangs until the page gives up on it at 8s
        wait(2000);
        server.hang = true;
        wait(2000);
        document.fire('visibilitychange');
        server.hang = false;
        wait(60000);

        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt), [1000, 3050, 12050, 20100, 36150]);
    });

    test('a page that is hidden leaves a waiting retry to its backoff', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(4000);
        document.visibilityState = 'hidden';
        document.fire('visibilitychange');
        wait(60000);

        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt), [1000, 3050, 7100, 15150, 31200]);
    });

    test('coming back to the page while the tab connects or is connected opens no second socket', () => {
        const first = FakeWebSocket.last;
        document.fire('visibilitychange');
        assert.equal(FakeWebSocket.last, first, 'none while connected');

        server.hang = true;
        first.closes({ code: 1006, wasClean: false });
        wait(1000);
        const connecting = FakeWebSocket.last;
        assert.equal(connecting.readyState, FakeWebSocket.CONNECTING);
        document.fire('visibilitychange');
        assert.equal(FakeWebSocket.last, connecting, 'none while connecting');
        assert.equal(FakeWebSocket.mostConnecting, 1);
    });

    test('coming back to the page after the retries ran out starts a new round of them', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(60000);

        document.fire('visibilitychange');
        const reconnecting = FakeWebSocket.last;
        assert.equal(reconnecting.createdAt, 60000, 'the page connects at once');
        wait(60000);
        assert.deepEqual(socketsSince(reconnecting).map((socket) => socket.createdAt - 60000),
            [1050, 3100, 7150, 15200, 31250]);
        assert.equal(FakeWebSocket.mostConnecting, 1);
    });

    test('coming back to the page after the retries ran out says once that the tab is reconnecting', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(60000);
        assert.equal(linesSaying(LOST), 1);

        document.fire('visibilitychange');
        wait(60000);
        assert.equal(linesSaying(LOST), 2, 'one more line for the round coming back started');
        assert.equal(linesSaying(RAN_OUT), 2);
    });

    test('a page that is hidden does not reconnect a tab', () => {
        const first = FakeWebSocket.last;
        first.closes({ code: 1005, wasClean: true });
        document.visibilityState = 'hidden';
        document.fire('visibilitychange');
        wait(60000);

        assert.equal(FakeWebSocket.last, first, 'no new socket');
    });

    // Guard: coming back to the page reconnects a tab whose connection ended
    test('coming back to the page reconnects a tab whose shell exited, once', () => {
        const first = FakeWebSocket.last;
        first.closes({ code: 1005, wasClean: true });
        wait(1000);
        document.fire('visibilitychange');
        document.fire('visibilitychange');
        wait(1000);

        assert.equal(socketsSince(first).length, 1);
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
    });

    // Every tab's terminal sits in the page; the hidden ones are only transparent, and can take the keyboard
    test('a tab behind another one does not take the keyboard when it connects or reconnects', () => {
        FakeWebSocket.last.closes({ code: 1001, wasClean: true });
        wait(2000);

        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN, 'the tab reconnected');
        assert.deepEqual(terminal.focusedWithReports, []);
    });

    // Guard
    test('the tab in front takes the keyboard once it reconnects', () => {
        manager.activeTabId = 1;
        const focused = terminal.focusedWithReports.length;
        FakeWebSocket.last.closes({ code: 1001, wasClean: true });
        wait(2000);

        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN, 'the tab reconnected');
        assert.equal(terminal.focusedWithReports.length, focused + 1);
    });

    // The search box, or the input for renaming a tab, keeps the keyboard: what is typed there next would
    // otherwise run in the shell
    test('the tab in front leaves the keyboard to the search box when it reconnects', () => {
        manager.activeTabId = 1;
        document.activeElement = SEARCH_BOX;
        const focused = terminal.focusedWithReports.length;
        FakeWebSocket.last.closes({ code: 1001, wasClean: true });
        wait(2000);

        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN, 'the tab reconnected');
        assert.equal(terminal.focusedWithReports.length, focused);
    });

    // Guards: from nothing, the page, or a terminal, the tab in front takes it. The terminal can be its own or
    // a hidden tab's (one that had it before a tab switch); either is in the terminals container
    for (const [what, focusedElement] of [['nothing', () => null], ['the page', () => document.body],
        ['a terminal', () => TERMINAL_TEXTAREA]]) {
        test(`the tab in front takes the keyboard from ${what} when it reconnects`, () => {
            manager.activeTabId = 1;
            document.activeElement = focusedElement();
            const focused = terminal.focusedWithReports.length;
            FakeWebSocket.last.closes({ code: 1001, wasClean: true });
            wait(2000);

            assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN, 'the tab reconnected');
            assert.equal(terminal.focusedWithReports.length, focused + 1);
        });
    }

    // vim turns focus reports on; the new shell would read the report as typed text
    test('the tab in front takes the keyboard once the focus reports a program turned on are off', () => {
        manager.activeTabId = 1;
        const first = FakeWebSocket.last;
        first.onmessage({ data: JSON.stringify({ type: 'output', data: '\x1b[?1049h\x1b[?1004hVIM SCREEN' }) });
        wait(1);
        assert.equal(terminal.modes.sendFocusMode, true);
        const focused = terminal.focusedWithReports.length;
        first.closes({ code: 1001, wasClean: true });
        wait(2000);

        const reconnected = FakeWebSocket.last;
        assert.equal(reconnected.readyState, FakeWebSocket.OPEN, 'the tab reconnected');
        assert.deepEqual(terminal.focusedWithReports.slice(focused), [false], 'focused once, with the reports off');
        assert.deepEqual(reconnected.inputs(), [], 'no focus report reached the new shell');
    });

    test('closing a tab closes its socket with 1000', () => {
        const socket = FakeWebSocket.last;
        closeTab();
        assert.equal(socket.closedWith, 1000);
        mock.timers.tick(0);
        assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    });

    // The server's own close can cross the page's: the server shutting down, or the network gone
    for (const [code, wasClean] of [[1001, true], [1006, false]]) {
        test(`a closed tab is not reconnected when its socket's close comes back as ${code}`, () => {
            const socket = FakeWebSocket.last;
            closeTab();
            socket.closes({ code, wasClean });
            wait(60000);
            document.fire('visibilitychange');
            wait(60000);

            assert.equal(FakeWebSocket.last, socket, 'no new socket');
        });
    }

    test('closing a tab while a retry waits cancels the retry', () => {
        const first = FakeWebSocket.last;
        first.closes({ code: 1006, wasClean: false });
        wait(500);
        closeTab();
        wait(60000);

        assert.equal(FakeWebSocket.last, first, 'no new socket');
    });

    test('closing a tab while it connects gives up the attempt', () => {
        const first = FakeWebSocket.last;
        server.hang = true;
        first.closes({ code: 1006, wasClean: false });
        wait(1000);
        const connecting = FakeWebSocket.last;
        closeTab();
        wait(60000);

        assert.equal(connecting.readyState, FakeWebSocket.CLOSED);
        assert.equal(FakeWebSocket.last, connecting, 'no new socket');
    });

    // The browser reports the attempt the page gives up on as an error; it is not one
    test('closing a tab while it connects logs no error', () => {
        server.hang = true;
        FakeWebSocket.last.closes({ code: 1006, wasClean: false });
        wait(1000);
        closeTab();
        wait(1000);

        assert.equal(console.error.mock.callCount(), 0);
    });

    // Guard
    test('an attempt the server refuses is logged', () => {
        server.up = false;
        FakeWebSocket.last.closes({ code: 1006, wasClean: false });
        wait(1100);

        assert.equal(console.error.mock.callCount(), 1);
        assert.equal(console.error.mock.calls[0].arguments[0], 'WebSocket error:');
    });

    // The new shell is told its size 100ms after the socket opens
    test('a socket closed just after it opened is not sent the shell\'s size', () => {
        FakeWebSocket.last.closes({ code: 1006, wasClean: false });
        wait(1070);
        const reconnected = FakeWebSocket.last;
        assert.equal(reconnected.readyState, FakeWebSocket.OPEN);
        reconnected.closes({ code: 1001, wasClean: true });
        wait(1000);

        assert.equal(reconnected.sentWhileClosed, 0);
    });

    test('a tab closed just after its socket opened sends it nothing', () => {
        FakeWebSocket.last.closes({ code: 1006, wasClean: false });
        wait(1070);
        const reconnected = FakeWebSocket.last;
        assert.equal(reconnected.readyState, FakeWebSocket.OPEN);
        closeTab();
        wait(1000);

        assert.equal(reconnected.sentWhileClosed, 0);
    });

    // A socket goes on delivering what the server sent before it saw the close
    test('output that arrives after the tab closed is left alone', () => {
        const socket = FakeWebSocket.last;
        let saves = 0;
        manager.saveSessionState = () => { saves++; };
        closeTab();
        saves = 0;
        socket.onmessage({ data: JSON.stringify({ type: 'output', data: 'still running\r\n' }) });
        wait(1000);

        assert.equal(saves, 0, 'no session save for it');
    });

    test('closing a tab lets go of its terminal\'s addons', () => {
        assert.ok(manager.terminalAddons.has(terminal));
        closeTab();
        assert.equal(manager.terminalAddons.has(terminal), false);
    });

    test('closing a tab removes its listeners from the page', () => {
        closeTab();
        for (const type of ['resize', 'beforeunload']) assert.equal(window.listening(type), 0, `window ${type}`);
        assert.equal(document.listening('visibilitychange'), 0);
        assert.ok(MutationObserver.all.every((observer) => !observer.observing), 'the theme no longer observed');
    });
});
