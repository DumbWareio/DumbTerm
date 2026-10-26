/**
 * Behavioural tests for how the browser terminal (public/managers/terminal.js) interprets
 * control sequences from the shell. Runs the real TerminalManager.initTerminal against the real
 * @xterm/xterm build the page ships: xterm's parser and buffer work in Node as long as the
 * terminal is never opened into a DOM, so only the DOM, the addons and the WebSocket are stand-ins.
 * Output is fed through the app's own WebSocket message handler and read back from xterm's buffer.
 */
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Terminal: XtermTerminal } = require('@xterm/xterm');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SerializeAddon: RealSerializeAddon } = require('@xterm/addon-serialize');

const MANAGERS_URL = pathToFileURL(path.join(__dirname, '..', 'public', 'managers') + path.sep).href;
const TERMINAL_MANAGER_URL = new URL('terminal.js', MANAGERS_URL).href;

// The page's managers are browser ES modules in a package without "type": "module". Say so, rather
// than let Node guess from the syntax and warn about it (terminal.js imports storage.js the same way).
registerHooks({
    load(url, context, nextLoad) {
        return nextLoad(url, url.startsWith(MANAGERS_URL) ? { ...context, format: 'module' } : context);
    },
});

// The real xterm.js terminal, minus the DOM: open() and focus() need a document, nothing else does
class HeadlessPageTerminal extends XtermTerminal {
    open() {}
    focus() {}
}

class StubAddon {
    activate() {}
    dispose() {}
    fit() {}
}

// No WebGL in Node; the page falls back to the DOM renderer, which is also what it does without a GPU
class FailingWebglAddon extends StubAddon {
    activate() { throw new Error('WebGL is not available'); }
    onContextLoss() {}
}

// Stands in for the page's WebSocket to the server: already connected, and remembers the last one opened
class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static last = null;

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        FakeWebSocket.last = this;
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = FakeWebSocket.CLOSED; }
    addEventListener() {}
}

// Some of these exist in Node already (e.g. WebSocket); put those back afterwards rather than delete them
const BROWSER_GLOBALS = ['window', 'document', 'getComputedStyle', 'MutationObserver', 'WebSocket', 'Terminal',
    'FitAddon', 'WebLinksAddon', 'WebglAddon', 'ImageAddon', 'SearchAddon', 'SerializeAddon', 'Unicode11Addon'];

function installBrowserGlobals() {
    const noop = () => {};
    globalThis.window = {
        location: { protocol: 'http:', host: 'localhost' },
        appConfig: { basePath: '' },
        addEventListener: noop,
    };
    globalThis.document = { documentElement: {}, addEventListener: noop };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
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

describe('terminal control sequences', () => {
    let TerminalManager;
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

    beforeEach(() => {
        // initTerminal arms reconnect, heartbeat and session-save timers; keep them from outliving the test
        mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        // The WebGL fallback warning is expected here
        mock.method(console, 'warn', () => {});

        // initTerminal only needs these from its manager; the constructor builds the whole tab UI
        const manager = { terminalAddons: new Map(), saveSessionState() {} };
        terminal = TerminalManager.prototype.initTerminal.call(manager, {});
    });

    afterEach(() => {
        terminal.dispose();
        mock.timers.reset();
        mock.restoreAll();
    });

    // Deliver shell output the way the server does, then wait for xterm to parse it
    function receiveOutput(data) {
        FakeWebSocket.last.onmessage({ data: JSON.stringify({ type: 'output', data }) });
        return new Promise((resolve) => {
            terminal.write('', resolve);
            mock.timers.runAll();
        });
    }

    function screenLine(row) {
        return terminal.buffer.active.getLine(row).translateToString(true);
    }

    test('insert mode (SM/RM 4, terminfo smir/rmir) inserts text instead of overwriting it', async () => {
        await receiveOutput('abc\x1b[4h\rX\x1b[4l\n');

        assert.equal(screenLine(0), 'Xabc');
        assert.equal(terminal.modes.insertMode, false, 'RM 4 turns insert mode back off');
        await receiveOutput('\x1b[A\x1b[2GY');
        assert.equal(screenLine(0), 'XYbc');
    });

    test('a saved session does not carry the shell\'s terminal modes into the restored tab', async () => {
        // A restored tab runs a fresh shell, so a mode the old program left on (here insert mode) must not return
        const serializeAddon = new RealSerializeAddon();
        terminal.loadAddon(serializeAddon);
        await receiveOutput('x\r\n$ \x1b[4h');
        assert.equal(terminal.modes.insertMode, true);

        let saved;
        const manager = {
            activeTabId: 1,
            tabCounter: 2,
            terminals: new Map([[1, { tab: { querySelector: () => ({ textContent: 'Term1' }) }, terminal }]]),
            terminalAddons: new Map([[terminal, { serializeAddon }]]),
            storageManager: { set: (key, value) => { saved = value; } },
        };
        TerminalManager.prototype.saveSessionState.call(manager);
        const content = saved.terminals[0].content;
        assert.match(content, /x/, 'the session content itself is saved');

        const restored = TerminalManager.prototype.initTerminal.call(
            { terminalAddons: new Map(), saveSessionState() {} }, {}, content);
        try {
            await new Promise((resolve) => {
                restored.write('', resolve);
                mock.timers.runAll();
            });
            assert.equal(restored.buffer.active.getLine(0).translateToString(true), 'x', 'the saved content is restored');
            assert.equal(restored.modes.insertMode, false);
        } finally {
            restored.dispose();
        }
    });

    test('a saved session leaves out the prompt the shell is idle at, whatever it looks like', async () => {
        // macOS zsh's default prompt matches none of the prompt patterns; the shell sitting in its line
        // editor (bracketed paste on) is what marks the last line as a prompt the new shell will redraw
        const serializeAddon = new RealSerializeAddon();
        terminal.loadAddon(serializeAddon);
        await receiveOutput('chris@mbp DumbTerm % ls\r\nfile1\r\nchris@mbp DumbTerm % \x1b[?2004h');

        let saved;
        const manager = {
            activeTabId: 1,
            tabCounter: 2,
            terminals: new Map([[1, { tab: { querySelector: () => ({ textContent: 'Term1' }) }, terminal }]]),
            terminalAddons: new Map([[terminal, { serializeAddon }]]),
            storageManager: { set: (key, value) => { saved = value; } },
        };
        TerminalManager.prototype.saveSessionState.call(manager);

        assert.equal(saved.terminals[0].content, 'chris@mbp DumbTerm % ls\nfile1\n');
    });

    test('alternate screen (DECSET/DECRST 1049) still switches buffers for editors', async () => {
        await receiveOutput('\x1b[?1049h');
        assert.equal(terminal.buffer.active.type, 'alternate');
        assert.equal(terminal.altBuffer, true, 'editor output is kept out of the saved session');

        await receiveOutput('\x1b[?1049l');
        assert.equal(terminal.buffer.active.type, 'normal');
        assert.equal(terminal.altBuffer, false);
    });
});
