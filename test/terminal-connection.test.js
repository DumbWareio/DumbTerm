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
// on one that is still connecting fails it (error, then close 1006), and the close event comes after close()
// returns
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

// window and document, keeping the listeners the page adds so a test can fire them and see which are left
function listeningTarget(properties) {
    const listeners = new Map();
    return {
        ...properties,
        listeners,
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
    globalThis.document = listeningTarget({
        documentElement: {},
        body: { querySelectorAll: () => [] },
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

const LOST = 'Connection lost. Attempting to reconnect...';
const NOT_AVAILABLE = 'Connection not available. Attempting to reconnect...';
const CLOSED_NORMALLY = 'Connection closed normally.';
const REFRESH = 'Connection lost. Please refresh the page to reconnect.';

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

    // Guards: these closes were final before, and stay final
    for (const [code, what] of [[1005, 'the shell exits'], [1000, 'the server closes normally'],
        [1011, 'the shell fails to start']]) {
        test(`when ${what} (${code}) the tab stays closed until a key is typed`, () => {
            const first = FakeWebSocket.last;
            first.closes({ code, wasClean: true });
            wait(60000);

            assert.equal(FakeWebSocket.last, first, 'no new socket');
            assert.equal(linesSaying(CLOSED_NORMALLY), 1);
            assert.equal(linesSaying(LOST), 0);
        });
    }

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
        assert.equal(linesSaying(REFRESH), 1);
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
    test('a key typed while the socket is closing opens no second socket', () => {
        const first = FakeWebSocket.last;
        first.readyState = FakeWebSocket.CLOSING;
        type('a');
        wait(100);
        assert.equal(FakeWebSocket.last, first, 'no socket while the old one closes');

        first.closes({ code: 1006, wasClean: false });
        wait(1100);
        assert.equal(socketsSince(first).length, 1, 'then the retry, 1s after it closed');
        assert.equal(FakeWebSocket.last.readyState, FakeWebSocket.OPEN);
    });

    test('once the retries run out, keys open no socket and say nothing more', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        wait(60000);
        assert.equal(socketsSince(first).length, 5, 'five retries');
        assert.equal(linesSaying(REFRESH), 1);

        type('a');
        type('b');
        wait(60000);
        assert.equal(socketsSince(first).length, 5);
        assert.equal(linesSaying(LOST) + linesSaying(NOT_AVAILABLE), 1);
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

    test('coming back to the page while a retry waits leaves it to that retry', () => {
        const first = FakeWebSocket.last;
        server.up = false;
        first.closes({ code: 1006, wasClean: false });
        // Refused at 1s and 3s; the third retry waits for 7.1s
        wait(4000);
        document.fire('visibilitychange');
        wait(60000);

        // Retried 1, 2, 4, 8 and 16s after each refusal, as if the page had never been away
        assert.deepEqual(socketsSince(first).map((socket) => socket.createdAt), [1000, 3050, 7100, 15150, 31200]);
        assert.equal(FakeWebSocket.mostConnecting, 1);
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

    test('closing a tab removes its listeners from the page', () => {
        closeTab();
        for (const type of ['resize', 'beforeunload']) assert.equal(window.listening(type), 0, `window ${type}`);
        assert.equal(document.listening('visibilitychange'), 0);
        assert.ok(MutationObserver.all.every((observer) => !observer.observing), 'the theme no longer observed');
    });
});
