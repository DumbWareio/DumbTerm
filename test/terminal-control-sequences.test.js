/**
 * Behavioural tests for how the browser terminal (public/managers/terminal.js) interprets
 * control sequences from the shell. Runs the real TerminalManager.initTerminal against the real
 * @xterm/xterm build the page ships: xterm's parser and buffer work in Node as long as the
 * terminal is never opened into a DOM, so only the DOM, the addons and the WebSocket are stand-ins.
 * Output is fed through the app's own WebSocket message handler and read back from xterm's buffer.
 */
const { describe, test, before, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Terminal: XtermTerminal } = require('@xterm/xterm');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

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

    before(async () => {
        installBrowserGlobals();
        ({ default: TerminalManager } = await import(TERMINAL_MANAGER_URL));
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
