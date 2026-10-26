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

    beforeEach(() => {
        // initTerminal arms reconnect, heartbeat and session-save timers; keep them from outliving the test
        mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        // xterm schedules its parsing with setTimeout(fn) and no delay, which the mock runs out of order (after
        // the page's 500ms session save) once other timers are pending; give it the 0 a browser would
        const mockedSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay = 0, ...args) => mockedSetTimeout(callback, delay, ...args);
        // The WebGL fallback warning is expected here
        mock.method(console, 'warn', () => {});

        // initTerminal only needs these from its manager; the constructor builds the whole tab UI
        manager = { terminalAddons: new Map(), saveSessionState() {} };
        terminal = TerminalManager.prototype.initTerminal.call(manager, {});
    });

    afterEach(() => {
        terminal.dispose();
        mock.timers.reset();
        mock.restoreAll();
    });

    // Deliver shell output the way the server does, wait for xterm to parse it, then run the timers the
    // page armed once it had (the session save)
    async function receiveOutput(data) {
        FakeWebSocket.last.onmessage({ data: JSON.stringify({ type: 'output', data }) });
        await new Promise((resolve) => {
            terminal.write('', resolve);
            mock.timers.runAll();
        });
        mock.timers.runAll();
    }

    // Deliver shell output and let xterm parse it, leaving the page's own timers to mock.timers.tick
    function deliverOutput(data) {
        FakeWebSocket.last.onmessage({ data: JSON.stringify({ type: 'output', data }) });
        mock.timers.tick(0);
    }

    function screenLine(row) {
        return terminal.buffer.active.getLine(row).translateToString(true);
    }

    // Let the terminal's own saves (on a keystroke, and the debounced one after output) run the real
    // saveSessionState with the real SerializeAddon; returns the saved content of each save, in order
    function recordSavedSessions() {
        const serializeAddon = new RealSerializeAddon();
        terminal.loadAddon(serializeAddon);
        const saves = [];
        Object.assign(manager, {
            activeTabId: 1,
            tabCounter: 2,
            terminals: new Map([[1, { tab: { querySelector: () => ({ textContent: 'Term1' }) }, terminal }]]),
            storageManager: { set: (key, value) => { saves.push(value.terminals[0].content); } },
            saveSessionState: TerminalManager.prototype.saveSessionState,
        });
        manager.terminalAddons.set(terminal, { serializeAddon });
        return saves;
    }

    // Open a tab restored from saved content, as loadSessionState does, once xterm has parsed it
    async function restoreSession(content) {
        const restored = TerminalManager.prototype.initTerminal.call(
            { terminalAddons: new Map(), saveSessionState() {} }, {}, content);
        await new Promise((resolve) => {
            restored.write('', resolve);
            mock.timers.runAll();
        });
        return restored;
    }

    function bufferLines(restored) {
        const buffer = restored.buffer.active;
        return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true));
    }

    // Restore saved content, then the new shell prints its prompt; returns the prompt's first cell
    async function restoredPromptCell(content) {
        const restored = await restoreSession(content);
        try {
            await new Promise((resolve) => {
                restored.write('\x1b[?2004h$ ', resolve);
                mock.timers.runAll();
            });
            const buffer = restored.buffer.active;
            return buffer.getLine(buffer.baseY + buffer.cursorY).getCell(0);
        } finally {
            restored.dispose();
        }
    }

    // The shell runs `vim notes.txt`; vim switches to the alternate screen and turns bracketed paste on
    async function openVim() {
        await receiveOutput('$ ls\r\nfile1\r\n\x1b[?2004h$ ');
        await receiveOutput('vim notes.txt\r\n\x1b[?2004l');
        await receiveOutput('\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2JVIM SCREEN\r\n~\r\n~');
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

    test('a saved session keeps the last output line while a command is still running', async () => {
        // The shell turns bracketed paste off before running a command, so its latest output is not a prompt
        const serializeAddon = new RealSerializeAddon();
        terminal.loadAddon(serializeAddon);
        await receiveOutput('\x1b[?2004hchris@mbp DumbTerm % make\r\n\x1b[?2004lbuilding\r\nstep 2 of 9');

        let saved;
        const manager = {
            activeTabId: 1,
            tabCounter: 2,
            terminals: new Map([[1, { tab: { querySelector: () => ({ textContent: 'Term1' }) }, terminal }]]),
            terminalAddons: new Map([[terminal, { serializeAddon }]]),
            storageManager: { set: (key, value) => { saved = value; } },
        };
        TerminalManager.prototype.saveSessionState.call(manager);

        assert.equal(saved.terminals[0].content, 'chris@mbp DumbTerm % make\nbuilding\nstep 2 of 9\n');
    });

    test('alternate screen (DECSET/DECRST 1049) still switches buffers for editors', async () => {
        await receiveOutput('\x1b[?1049h');
        assert.equal(terminal.buffer.active.type, 'alternate');

        await receiveOutput('\x1b[?1049l');
        assert.equal(terminal.buffer.active.type, 'normal');
    });

    test('a session saved while an editor is open keeps the shell screen, not the editor\'s', async () => {
        const saves = recordSavedSessions();
        await openVim();

        const savesBefore = saves.length;
        terminal.input('i');
        assert.equal(saves.length, savesBefore + 1, 'the keystroke saved the session');
        const content = saves.at(-1);
        assert.doesNotMatch(content, /VIM SCREEN/);
        assert.ok(!content.includes('\x1b[?1049h'), 'the switch to the alternate screen is not saved');
        assert.match(content, /^\$ ls\nfile1\n\$ vim notes\.txt/, 'the shell output, including the editor command, is kept');
    });

    test('a session saved while an editor is open restores into the normal screen', async () => {
        const saves = recordSavedSessions();
        await openVim();
        terminal.input('i');

        const restored = await restoreSession(saves.at(-1));
        try {
            assert.equal(restored.buffer.active.type, 'normal');
            assert.equal(restored.buffer.active.getLine(2).translateToString(true), '$ vim notes.txt');
        } finally {
            restored.dispose();
        }
    });

    test('a session saved while an editor is open restores with no blank line before the new prompt', async () => {
        // The serializer ends the screen by moving the cursor back to where it was, here the row below
        const saves = recordSavedSessions();
        await openVim();
        terminal.input('i');

        const restored = await restoreSession(saves.at(-1));
        try {
            await new Promise((resolve) => {
                restored.write('\x1b[?2004h$ ', resolve);
                mock.timers.runAll();
            });
            assert.deepEqual(bufferLines(restored).slice(0, 4), ['$ ls', 'file1', '$ vim notes.txt', '$ ']);
        } finally {
            restored.dispose();
        }
    });

    test('a restored tab\'s new shell does not inherit an open editor\'s text attributes', async () => {
        const saves = recordSavedSessions();
        await openVim();
        await receiveOutput('\x1b[31;7m-- INSERT --');
        terminal.input('i');

        const cell = await restoredPromptCell(saves.at(-1));
        assert.equal(cell.getChars(), '$');
        assert.equal(cell.isInverse(), 0);
        assert.equal(cell.getFgColorMode(), 0, 'default foreground');
    });

    test('a restored tab\'s new shell does not inherit the colour a running command left on', async () => {
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ make\r\n\x1b[?2004l');
        // (colour from the line's start would make the line look like a coloured prompt, which is left out)
        await receiveOutput('ERROR: \x1b[31;7mbuild failed');
        assert.match(saves.at(-1), /build failed/);

        const cell = await restoredPromptCell(saves.at(-1));
        assert.equal(cell.getChars(), '$');
        assert.equal(cell.isInverse(), 0);
        assert.equal(cell.getFgColorMode(), 0, 'default foreground');
    });

    test('output after an editor opens and closes within one message is still saved', async () => {
        const saves = recordSavedSessions();
        await receiveOutput('$ ls\r\nfile1\r\n');
        await receiveOutput('\x1b[?1049h\x1b[HVIM SCREEN\x1b[?1049l');
        await receiveOutput('$ make\r\nbuilding');

        assert.equal(saves.at(-1), '$ ls\nfile1\n$ make\nbuilding\n');
    });

    test('the save after output leaves out an editor whose screen switch arrives split across messages', async () => {
        // The shell's output arms the save, which fires once vim is open
        const saves = recordSavedSessions();
        deliverOutput('$ ls\r\nfile1\r\n$ vim notes.txt\r\n\x1b[?10');
        deliverOutput('49h\x1b[H\x1b[2JVIM SCREEN\r\n~\r\n~');
        assert.equal(terminal.buffer.active.type, 'alternate');
        assert.equal(saves.length, 0);

        mock.timers.tick(500);
        assert.equal(saves.length, 1, 'the save ran with the editor open');
        assert.doesNotMatch(saves[0], /VIM SCREEN/);
    });

    test('the save after output leaves out an editor on the 1047 alternate screen', async () => {
        const saves = recordSavedSessions();
        deliverOutput('$ ls\r\nfile1\r\n$ vim notes.txt\r\n');
        deliverOutput('\x1b[?1047h\x1b[H\x1b[2JVIM SCREEN\r\n~\r\n~');
        assert.equal(terminal.buffer.active.type, 'alternate');
        assert.equal(saves.length, 0);

        mock.timers.tick(500);
        assert.equal(saves.length, 1, 'the save ran with the editor open');
        assert.doesNotMatch(saves[0], /VIM SCREEN/);
    });

    test('the save after an editor exits stores the shell screen', async () => {
        const saves = recordSavedSessions();
        await openVim();
        await receiveOutput('\x1b[?2004l\x1b[?1049l');
        await receiveOutput('\x1b[?2004h$ ');

        assert.equal(terminal.buffer.active.type, 'normal');
        assert.equal(saves.at(-1), '$ ls\nfile1\n$ vim notes.txt\n');
    });

    test('the session is saved 500ms after the shell\'s output stops', async () => {
        const saves = recordSavedSessions();
        deliverOutput('$ make\r\nbuilding\r\n');
        mock.timers.tick(499);
        assert.equal(saves.length, 0);
        mock.timers.tick(1);
        assert.equal(saves.length, 1);

        // More output before the 500ms are up postpones the save
        deliverOutput('step 2\r\n');
        mock.timers.tick(200);
        deliverOutput('BUILD DONE');
        mock.timers.tick(499);
        assert.equal(saves.length, 1);
        mock.timers.tick(1);
        assert.equal(saves.length, 2);
        assert.match(saves[1], /BUILD DONE\n$/);
    });

    test('an editor\'s redraws neither postpone nor repeat the save', async () => {
        // A full-screen program redrawing more often than every 500ms (htop, a progress view) must not
        // keep the debounced save, shared by every tab, from running
        const saves = recordSavedSessions();
        deliverOutput('$ make\r\nBUILD DONE\r\n');
        mock.timers.tick(200);
        deliverOutput('$ htop\r\n\x1b[?1049h\x1b[H\x1b[2JFRAME 0');
        mock.timers.tick(200);
        deliverOutput('\x1b[HFRAME 1');
        mock.timers.tick(99);
        assert.equal(saves.length, 0);
        mock.timers.tick(1);
        assert.equal(saves.length, 1, 'saved 500ms after the shell\'s output');
        assert.match(saves[0], /BUILD DONE\n\$ htop/);

        for (let frame = 2; frame < 10; frame++) {
            deliverOutput(`\x1b[HFRAME ${frame}`);
            mock.timers.tick(200);
        }
        assert.equal(saves.length, 1, 'the redraws arm no save of their own');
    });

    test('reconnecting while an editor is open leaves its screen for the new shell\'s', async () => {
        // The server kills the shell when its socket closes, so a reconnect talks to a new shell
        const saves = recordSavedSessions();
        await openVim();
        const oldSocket = FakeWebSocket.last;
        oldSocket.readyState = FakeWebSocket.CLOSED;
        oldSocket.onclose({ code: 1006, wasClean: false });
        mock.timers.tick(1000);
        assert.notEqual(FakeWebSocket.last, oldSocket, 'the page reconnected');
        FakeWebSocket.last.onopen();

        await receiveOutput('\x1b[?2004h$ ');
        assert.equal(terminal.buffer.active.type, 'normal');
        await receiveOutput('make\r\n\x1b[?2004l');
        await receiveOutput('BUILD DONE');
        assert.match(saves.at(-1), /\$ make\nBUILD DONE\n$/);
    });

    test('a session saved with an editor open by an earlier version restores without the editor', async () => {
        // Before 1.3.0 such a save held the switch to the alternate screen, followed by the editor's screen
        const restored = await restoreSession(
            '$ ls\nfile1\n$ vim notes.txt\x1b[1B\x1b[15D\x1b[?1049h\x1b[HVIM SCREEN\n~\n');
        try {
            assert.equal(restored.buffer.active.type, 'normal');
            assert.deepEqual(bufferLines(restored).slice(0, 3), ['$ ls', 'file1', '$ vim notes.txt']);
            assert.ok(!bufferLines(restored).some((line) => line.includes('VIM SCREEN')));
        } finally {
            restored.dispose();
        }
    });
});
