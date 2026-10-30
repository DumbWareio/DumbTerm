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
        dispatchEvent: noop,
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
        manager = { terminalAddons: new Map(), terminals: new Map(), saveSessionState() {} };
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
            { terminalAddons: new Map(), terminals: new Map(), saveSessionState() {} }, {}, content);
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

    // Restore saved content, open the tab's connection and let its new shell print a prompt, then check the tab
    async function withRestoredPrompt(content, check) {
        const restored = await restoreSession(content);
        try {
            FakeWebSocket.last.onopen();
            await new Promise((resolve) => {
                restored.write('\x1b[?2004h$ ', resolve);
                mock.timers.runAll();
            });
            check(restored);
        } finally {
            restored.dispose();
        }
    }

    // The row the cursor is on, counted from the top of the scrollback
    function cursorRow(restored) {
        return restored.buffer.active.baseY + restored.buffer.active.cursorY;
    }

    function cellAt(restored, row, col) {
        return restored.buffer.active.getLine(row).getCell(col);
    }

    // The socket drops and the page reconnects; the server kills a socket's shell when it closes, so the
    // new connection talks to a new shell
    function reconnect() {
        const oldSocket = FakeWebSocket.last;
        oldSocket.readyState = FakeWebSocket.CLOSED;
        oldSocket.onclose({ code: 1006, wasClean: false });
        mock.timers.tick(1000);
        assert.notEqual(FakeWebSocket.last, oldSocket, 'the page reconnected');
        FakeWebSocket.last.onopen();
    }

    // More output than the screen holds, so the rest is in the scrollback
    const SCREENFULS = Array.from({ length: 40 }, (_, i) => `line ${i}\r\n`).join('');

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
            { terminalAddons: new Map(), terminals: new Map(), saveSessionState() {} }, {}, content);
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

    // Prompts as real shells print them (captured for issue #39). bash 5.2 with Starship, the Docker image's
    // default: readline turns bracketed paste on before the prompt, which starts with a blank line
    const STARSHIP_TOP_LINE = '\x1b[38;2;163;174;210m\u2591\u2592\u2593\x1b[48;2;163;174;210;38;2;9;12;12m \uf306 '
        + '\x1b[48;2;118;159;240;38;2;163;174;210m\ue0b4\x1b[38;2;227;229;229m /app \x1b[48;2;57;66;96;38;2;118;159;240m'
        + '\ue0b4\x1b[48;2;33;39;54;38;2;57;66;96m\ue0b4\x1b[38;2;118;159;240m \ue718 v24.22.1 '
        + '\x1b[48;2;29;34;48;38;2;33;39;54m\ue0b4\x1b[38;2;160;169;203m \uf43a 10:55 PM \x1b[0m\x1b[38;2;29;34;48m\ue0b4 \x1b[0m';
    const STARSHIP_PROMPT = `\x1b[?2004h\r\n${STARSHIP_TOP_LINE}\r\n\x1b[1;32m\u276f\x1b[0m `;
    const PRINTF_PASS = 'printf "\\033[32m# pass 12\\033[0m\\n"';
    // zsh 5.9 marks a partial last line (PROMPT_SP), then prints the prompt and turns bracketed paste on after it
    const ZSH_PROMPT_SP = `\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m${' '.repeat(79)}\r \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[J`;
    const zshPrompt = (prompt) => `${ZSH_PROMPT_SP}${prompt}\x1b[K\x1b[?2004h`;
    const ZSH_PRINT_PASS = 'p\bprint -P "%F{green}# pass 12%f"\x1b[?2004l\r\r\n\x1b[32m# pass 12\x1b[39m\r\n';

    // The text of each saved line, without its colours
    function savedLines(content) {
        return content.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '').split('\n').map((line) => line.trimEnd());
    }
    const plain = (text) => savedLines(text)[0];

    test('a saved session keeps the last command and its coloured output under a Starship prompt', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}echo hello\r\n\x1b[?2004l\rhello\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}${PRINTF_PASS}\r\n\x1b[?2004l\r\x1b[32m# pass 12\x1b[0m\r\n`);
        await receiveOutput(STARSHIP_PROMPT);

        const top = plain(STARSHIP_TOP_LINE);
        assert.deepEqual(savedLines(saves.at(-1)),
            ['', top, '\u276f echo hello', 'hello', '', top, `\u276f ${PRINTF_PASS}`, '# pass 12', '']);
        assert.match(saves.at(-1), /\x1b\[32m# pass 12/, 'the output keeps its colour');
    });

    test('a saved session keeps output with no final newline above a Starship prompt', async () => {
        // bash turns bracketed paste on with the cursor still after the output, and Starship's newline follows
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}printf hello\r\n\x1b[?2004l\rhello`);
        await receiveOutput(STARSHIP_PROMPT);

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '❯ printf hello', 'hello', '']);
    });

    test('a saved session keeps output with no final newline above a Starship prompt at the bottom of the screen', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}${STARSHIP_PROMPT}printf hello\r\n\x1b[?2004l\rhello`);
        await receiveOutput(STARSHIP_PROMPT);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-4), [plain(STARSHIP_TOP_LINE), '❯ printf hello', 'hello', '']);
    });

    test('a saved session leaves out a plain prompt printed on the same row as output with no final newline', async () => {
        // The row holds both; it goes, as before
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ls\r\n\x1b[?2004l\rfile1\r\n');
        await receiveOutput('\x1b[?2004h$ printf hello\r\n\x1b[?2004l\rhello\x1b[?2004h$ ');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ ls', 'file1', '$ printf hello', '']);
    });

    test('a saved session leaves out every line of a two-line bash prompt', async () => {
        // A prompt with no blank line first, e.g. PS1='\u@\h \w\n\$ ': bash marks its top line
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004hchris@box ~/app\r\n$ ';
        await receiveOutput(`${prompt}ls\r\n\x1b[?2004l\rfile1\r\n`);
        await receiveOutput(prompt);

        assert.deepEqual(savedLines(saves.at(-1)), ['chris@box ~/app', '$ ls', 'file1', '']);
    });

    test('a saved session leaves out the whole Starship prompt the shell is idle at', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}echo hello\r\n\x1b[?2004l\rhello\r\n`);
        await receiveOutput(STARSHIP_PROMPT);

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '\u276f echo hello', 'hello', '']);
    });

    test('a saved session keeps output that looks like a prompt above the prompt the shell is idle at', async () => {
        // The rows above the prompt are all kept, whatever they look like
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ echo \'>\'\r\n\x1b[?2004l>\r\n\x1b[?2004h$ ');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ echo \'>\'', '>', '']);
    });

    test('a session saved at a Starship prompt restores with the new prompt under the output, in default colours', async () => {
        const saves = recordSavedSessions();
        // The output leaves its background colour on
        await receiveOutput(`${STARSHIP_PROMPT}printf "\\033[41m FAIL\\n"\r\n\x1b[?2004l\r\x1b[41m FAIL\r\n`);
        await receiveOutput(STARSHIP_PROMPT);

        await withRestoredPrompt(saves.at(-1), (restored) => {
            const prompt = cursorRow(restored);
            assert.deepEqual(bufferLines(restored).slice(prompt - 1, prompt + 1), [' FAIL', '$ ']);
            assert.ok(cellAt(restored, prompt - 1, 1).getBgColor() > 0, 'the output keeps its colour');
            assert.ok(cellAt(restored, prompt, 0).isBgDefault(), 'default background');
            assert.ok(cellAt(restored, prompt, 10).isBgDefault(), 'default background across the row');
        });
    });

    test('a saved session keeps a coloured output line above a zsh prompt', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(zshPrompt('host% '));
        await receiveOutput(ZSH_PRINT_PASS);
        await receiveOutput(zshPrompt('host% '));

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print -P "%F{green}# pass 12%f"', '# pass 12', '']);
        assert.match(saves.at(-1), /\x1b\[32m# pass 12/, 'the output keeps its colour');
    });

    test('a saved session keeps the output above a two-line zsh prompt, and that prompt\'s top line', async () => {
        // zsh turns bracketed paste on after its prompt, which marks only the last line of it: the known
        // limit is that the line above stays in the save. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        const twoLinePrompt = zshPrompt('\x1b[34mtop line\x1b[39m\r\n% ');
        await receiveOutput(twoLinePrompt);
        await receiveOutput(ZSH_PRINT_PASS);
        await receiveOutput(twoLinePrompt);

        assert.deepEqual(savedLines(saves.at(-1)),
            ['top line', '% print -P "%F{green}# pass 12%f"', '# pass 12', 'top line', '']);
    });

    test('a saved session keeps a REPL\'s coloured result and leaves out its prompt', async () => {
        // The node REPL does not turn bracketed paste on, so its prompt is found by its look
        const saves = recordSavedSessions();
        await receiveOutput('Welcome to Node.js v24.15.0.\r\nType ".help" for more information.\r\n\x1b[1G\x1b[0J> \x1b[3G6*7\r\r\n');
        await receiveOutput('\x1b[33m42\x1b[39m\r\n\x1b[1G\x1b[0J> ');

        assert.deepEqual(savedLines(saves.at(-1)),
            ['Welcome to Node.js v24.15.0.', 'Type ".help" for more information.', '> 6*7', '42', '']);
        assert.match(saves.at(-1), /\x1b\[33m42/, 'the result keeps its colour');
    });

    test('a saved session leaves out a coloured user@host prompt from a shell without bracketed paste', async () => {
        // e.g. bash before 5.1 with Debian's coloured prompt
        const saves = recordSavedSessions();
        const prompt = '\x1b[01;32muser@host\x1b[00m:\x1b[01;34m~\x1b[00m$ ';
        await receiveOutput(`${prompt}ls\r\nfile1\r\n${prompt}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['user@host:~$ ls', 'file1', '']);
    });

    test('a saved session leaves out a host:dir prompt in several colours from a shell without bracketed paste', async () => {
        // e.g. BusyBox ash with PS1='\[\e[1;32m\]\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
        const saves = recordSavedSessions();
        const prompt = '\x1b[1;32mhost\x1b[0m:\x1b[1;34m~\x1b[0m$ ';
        await receiveOutput(`ls\r\nfile1\r\n${prompt}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['ls', 'file1', '']);
    });

    test('a saved session leaves out a Starship prompt after the cursor is hidden and shown again', async () => {
        // readline hides and shows the cursor (CSI ? 25 l/h) while it sits at the prompt; only 2004 marks it
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}ls\r\n\x1b[?2004l\rfile1\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}\x1b[?25l\x1b[?25h`);

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '\u276f ls', 'file1', '']);
    });

    test('a saved session leaves out the prompt the shell is idle at after a long output', async () => {
        // More output than the scrollback holds: lines leave the top of the buffer as the prompt is printed
        const saves = recordSavedSessions();
        await receiveOutput(Array.from({ length: 5100 }, (_, i) => `line ${i}\r\n`).join(''));
        await receiveOutput(STARSHIP_PROMPT);

        const lines = savedLines(saves.at(-1));
        assert.deepEqual(lines.slice(-3), ['line 5098', 'line 5099', '']);
        assert.ok(!lines.includes(plain(STARSHIP_TOP_LINE)), 'the prompt\'s top line is left out');
    });

    test('a saved session keeps output that pushed the prompt out of the scrollback', async () => {
        // A background job prints while the shell sits at its prompt, until the prompt's row leaves the buffer
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ');
        await receiveOutput(Array.from({ length: 5100 }, (_, i) => `line ${i}\r\n`).join(''));

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 5098', 'line 5099', '']);
    });

    // An app in the normal screen that turns bracketed paste on once and keeps printing below, as Claude Code
    // starts (captured from 2.1.311)
    const APP_START = '\x1b[?2004h$ claude\r\n\x1b[?2004l\r\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h'
        + 'Welcome to Claude Code\r\r\n';
    const appLines = (count) => Array.from({ length: count }, (_, i) => ` transcript line ${i}\r\n`).join('');

    test('a saved session keeps the output of an app that left bracketed paste on', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${APP_START}${appLines(40)}> type here`);

        const lines = savedLines(saves.at(-1));
        assert.ok(lines.includes('Welcome to Claude Code'));
        assert.deepEqual(lines.slice(-3), [' transcript line 38', ' transcript line 39', '']);
    });

    test('a saved session keeps an app\'s output from five rows below where it turned bracketed paste on', async () => {
        // Five rows down is further than a prompt and its typed input reach
        const saves = recordSavedSessions();
        await receiveOutput(`${APP_START}${appLines(4)}> type here`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), [' transcript line 2', ' transcript line 3', '']);
    });

    test('a saved session keeps the output of an app that started with blank rows', async () => {
        // A blank row above the app's input line is no sign of a prompt redrawn there
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n\r\nWelcome\r\n${appLines(40)}\r\n> type here`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), [' transcript line 38', ' transcript line 39', '']);
    });

    test('a saved session leaves out a Starship prompt with a half-typed command three rows long', async () => {
        // The cursor is four rows below the marked row: the prompt's blank and top lines, then three rows of input
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}ls\r\n\x1b[?2004l\rfile1\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}echo ${'x'.repeat(170)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '❯ ls', 'file1', '']);
    });

    // bash 5.2's Tab-Tab under Starship (captured): readline lists the completions under the command, then
    // redraws the whole prompt below them without turning bracketed paste on again
    const STARSHIP_REDRAW = STARSHIP_PROMPT.replace('\x1b[?2004h', '');
    const COMPLETIONS = 'alpha/ beta/  delta/ gamma/ \r\n';
    const starshipCompletion = (command) => `${STARSHIP_PROMPT}${command}\x07\r\n${COMPLETIONS}${STARSHIP_REDRAW}${command}`;

    test('a saved session leaves out a Starship prompt redrawn below a completion listing', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(starshipCompletion('ls /tmp/d/'));

        assert.equal(saves.at(-1), '');
    });

    test('a saved session keeps the scrollback above a Starship prompt redrawn below a completion listing', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}${starshipCompletion('ls /tmp/d/')}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 38', 'line 39', '']);
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a long command', async () => {
        // The redrawn prompt's top line is three rows above the cursor: a command three rows long, the most the
        // marked prompt allows
        const saves = recordSavedSessions();
        await receiveOutput(starshipCompletion(`ls /tmp/${'x'.repeat(160)}/`));

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing', async () => {
        // The prompt's line, with the command as typed, is redrawn on the cursor's row
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ls\r\n\x1b[?2004l\rfile1\r\n');
        await receiveOutput('\x1b[?2004h$ ls /tmp/d/\x07\r\nalpha/\r\nbeta/\r\ndelta/\r\ngamma/\r\n$ ls /tmp/d/');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ ls', 'file1', '']);
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing and typed on', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${starshipCompletion('ls /tmp/d/')}al`);

        assert.equal(saves.at(-1), '');
    });

    // Starship's default prompt under bash 5.2 in the Docker image (captured), with no starship.toml
    const STARSHIP_DEFAULT_TOP_LINE = '\x1b[1;31mroot\x1b[0m in \x1b[1;36m/app\x1b[0m is \x1b[1;38;5;208m\u{1f4e6} v1.3.0\x1b[0m'
        + ' via \x1b[1;32m v24.22.1 \x1b[0m';
    const STARSHIP_DEFAULT_PROMPT = `\x1b[?2004h\r\n${STARSHIP_DEFAULT_TOP_LINE}\r\n\x1b[1;2;31m⬢ [Docker]\x1b[0m \x1b[1;32m❯\x1b[0m `;

    test('a saved session leaves out a Starship prompt redrawn below a completion listing and typed on until it wraps', async () => {
        // Captured from bash 5.2: the command typed at the redrawn prompt wraps, so the cursor is on its second row
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_DEFAULT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`${STARSHIP_DEFAULT_PROMPT}ls /tmp/d/\x07\r\n${COMPLETIONS}`
            + `${STARSHIP_DEFAULT_PROMPT.replace('\x1b[?2004h', '')}ls /tmp/d/`);
        await receiveOutput('a'.repeat(94));

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_DEFAULT_TOP_LINE), '⬢ [Docker] ❯ echo out', 'out', '']);
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a long command typed on onto another row', async () => {
        // The command already wrapped when the listing was printed: it is two rows long above the listing, three below
        const saves = recordSavedSessions();
        await receiveOutput(`${starshipCompletion(`ls /tmp/${'x'.repeat(100)}/`)}${'a'.repeat(70)}`);

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing and typed on until it wraps', async () => {
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ls\r\n\x1b[?2004l\rfile1\r\n');
        await receiveOutput(`\x1b[?2004h$ ls /tmp/d/\x07\r\nalpha/\r\nbeta/\r\ndelta/\r\ngamma/\r\n$ ls /tmp/d/${'a'.repeat(75)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ ls', 'file1', '']);
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing and typed on to four rows', async () => {
        // The command starts three rows above the cursor, as high as a redrawn prompt is looked for
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ls\r\n\x1b[?2004l\rfile1\r\n');
        await receiveOutput(`\x1b[?2004h$ ls /tmp/d/\x07\r\nalpha/\r\nbeta/\r\ndelta/\r\ngamma/\r\n$ ls /tmp/d/${'a'.repeat(300)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ ls', 'file1', '']);
    });

    test('a saved session keeps an app\'s rows five down from a blank row where it turned bracketed paste on', async () => {
        // The rows looked at for a redrawn prompt stop short of the app's own first line
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004h\r\nWelcome\r\nA\r\nB\r\nC\r\n> ');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Welcome', 'A', 'B', 'C', '']);
    });

    test('a saved session keeps the output of an app that starts with two blank rows and prints its input line again', async () => {
        // Only one blank row is skipped to find a prompt's first line
        const saves = recordSavedSessions();
        await receiveOutput('$ chat\r\n\x1b[?2004h\r\n\r\n> hi\r\nhello\r\nhow can I help?\r\n> ');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ chat', '', '', '> hi', 'hello', 'how can I help?', '']);
    });

    test('a saved session keeps the output of an app that starts with two blank rows and ends on blank rows', async () => {
        // A prompt starts with text: blank rows do not make a redrawn one
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n\r\nWelcome\r\n${appLines(5)}\r\n`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), [' transcript line 3', ' transcript line 4', '']);
    });

    test('a saved session keeps a background job\'s output printed at a Starship prompt before a completion listing', async () => {
        // Captured from bash 5.2: the job prints at the idle prompt, then Tab-Tab redraws the prompt below it
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}(for i in 1 2 3 4 5 6; do sleep 0.2; echo job $i; done) &\r\n\x1b[?2004l\r[1] 117\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}job 1\r\njob 2\r\njob 3\r\njob 4\r\njob 5\r\nls /tmp/d/job 6\r\n\x07\r\n`
            + `${COMPLETIONS}${STARSHIP_REDRAW}ls /tmp/d/`);

        const lines = savedLines(saves.at(-1));
        const job = lines.indexOf('\u276f job 1');
        assert.deepEqual(lines.slice(job, job + 6), ['\u276f job 1', 'job 2', 'job 3', 'job 4', 'job 5', 'ls /tmp/d/job 6']);
    });

    test('a saved session keeps a background job\'s output at a plain prompt when its last row starts with a dollar', async () => {
        // The prompt's space counts: `$5.00 total` does not start like `$ `
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ');
        await receiveOutput('\r\n[1] 123\r\napples  2\r\npears   1\r\nplums   3\r\nfigs    1\r\n$5.00 total');

        assert.deepEqual(savedLines(saves.at(-1)), ['$', '[1] 123', 'apples  2', 'pears   1', 'plums   3', 'figs    1', '']);
    });

    test('a saved session keeps a background job\'s output at a root prompt when its last row is a progress bar', async () => {
        // The command starts its row: the `# ` inside a bar of hashes is not the prompt's
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h# ');
        await receiveOutput('\r\n[1] 123\r\nfile 1 of 4\r\nfile 2 of 4\r\nfile 3 of 4\r\nfile 4 of 4\r\n'
            + `\r${'#'.repeat(20)}  50.0%\r${'#'.repeat(40)} 100.0%`);

        assert.deepEqual(savedLines(saves.at(-1)), ['#', '[1] 123', 'file 1 of 4', 'file 2 of 4', 'file 3 of 4', 'file 4 of 4', '']);
    });

    test('a saved session leaves out a background job\'s output at a root prompt when its last row starts like the prompt', async () => {
        // Known limit: with no final newline, the job's last line, wrapped or not, starts with the root prompt's
        // `# `, so it reads as that prompt redrawn below and typed on, and the save stops above the job's output.
        // Telling the two apart would also lose the plain prompt typed on, or erased back, after a completion
        // listing. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h# ');
        await receiveOutput('\r\n[1] 123\r\njob line 1\r\njob line 2\r\njob line 3\r\njob line 4\r\n# done');

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a background job\'s output at a root prompt when its wrapped last line starts like the prompt', async () => {
        // The same known limit, for a last line that wraps: lines are compared whole. Pinned with the one above
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h# ');
        await receiveOutput(`\r\n[1] 123\r\njob line 1\r\njob line 2\r\njob line 3\r\njob line 4\r\n# ${'x'.repeat(100)}`);

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing and typed on', async () => {
        // Captured from bash 5.2: a listing four rows tall, then `al` typed at the redrawn prompt
        const saves = recordSavedSessions();
        const prompt = 'root@6934e2095d8c:/app# ';
        await receiveOutput(`\x1b[?2004h${prompt}ls\r\n\x1b[?2004l\rfile1\r\n`);
        await receiveOutput(`\x1b[?2004h${prompt}ls /tmp/e/\x07\r\n`
            + 'alpha-a-rather-long-directory-name/ eta-a-rather-long-directory-name/\r\n'
            + 'beta-a-rather-long-directory-name/  gamma-a-rather-long-directory-name/\r\n'
            + 'delta-a-rather-long-directory-name/ theta-a-rather-long-directory-name/\r\n'
            + 'eps-a-rather-long-directory-name/   zeta-a-rather-long-directory-name/\r\n'
            + `${prompt}ls /tmp/e/al`);

        assert.deepEqual(savedLines(saves.at(-1)), [`${prompt}ls`, 'file1', '']);
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing and erased back', async () => {
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ ls\r\n\x1b[?2004l\rfile1\r\n');
        await receiveOutput('\x1b[?2004h$ ls /tmp/d/\x07\r\nalpha/\r\nbeta/\r\ndelta/\r\ngamma/\r\n$ ls /tmp/d/\b\x1b[K');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ ls', 'file1', '']);
    });

    test('a saved session keeps the output of an app that draws its first line again above its input line', async () => {
        const saves = recordSavedSessions();
        const rule = '\u2500'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h${rule}\r\n${appLines(5)}${rule}\r\n> `);

        assert.deepEqual(savedLines(saves.at(-1)),
            ['$ app', rule, ...Array.from({ length: 5 }, (_, i) => ` transcript line ${i}`), rule, '']);
    });

    test('a saved session keeps the output of an app that draws its first line again above an empty cursor row', async () => {
        // An empty row is not the start of the line the app first drew below its first one
        const saves = recordSavedSessions();
        const rule = '─'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h${rule}\r\n${appLines(5)}${rule}\r\n`);

        assert.deepEqual(savedLines(saves.at(-1)),
            ['$ app', rule, ...Array.from({ length: 5 }, (_, i) => ` transcript line ${i}`), rule, '']);
    });

    test('a saved session keeps the output of an app that draws its input line again under a different first line', async () => {
        // Every row of a redrawn prompt has to match, not only the cursor's
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nr4\r\nOther\r\n> ');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'r1', 'r2', 'r3', 'r4', 'Other', '']);
    });

    test('a saved session keeps the output of an app that draws its first line again under a longer one', async () => {
        // Only the command may have been typed on: above it, a redrawn prompt's rows equal the marked ones
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hab\r\n> \r\nr1\r\nr2\r\nr3\r\nabc\r\n> ');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'ab', '>', 'r1', 'r2', 'r3', 'abc', '']);
    });

    test('a saved session keeps the output of an app that draws its first line again above a typed row, where it first drew an empty one', async () => {
        // An empty marked row is not a command that the cursor's row was typed on from
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hTitle\r\n\r\nr1\r\nr2\r\nr3\r\nTitle\r\nsomething');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '', 'r1', 'r2', 'r3', 'Title', '']);
    });

    test('a saved session keeps the output of an app that draws its first five lines again', async () => {
        // Five rows are taller than a prompt and its command: the redrawn prompt is looked for no higher
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hA\r\nB\r\nC\r\nD\r\nE\r\nr1\r\nA\r\nB\r\nC\r\nD\r\nE');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'A', 'B', 'C', 'D', 'E', 'r1', 'A', 'B', 'C', 'D', '']);
    });

    test('a saved session keeps the output of an app whose last line starts like its first but differs once it wraps', async () => {
        // A line is compared whole, with the rows it wraps onto
        const saves = recordSavedSessions();
        const fetching = (version) => `fetching https://registry.example.com/packages/a-long-package-name/-/a-long-package-name-${version}.tgz`;
        await receiveOutput(`$ app\r\n\x1b[?2004h${fetching('1.0.0')}\r\nr1\r\nr2\r\nr3\r\nr4\r\n${fetching('2.0.0')}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 6), ['$ app', fetching('1.0.0'), 'r1', 'r2', 'r3', 'r4']);
    });

    test('a saved session keeps the output of an app whose last line wraps up from above the rows a prompt reaches', async () => {
        // The line starts higher than a redrawn prompt is looked for, so its rows there are not a command's first
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${'='.repeat(80)}\r\nr1\r\nr2\r\n${'='.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 4), ['$ app', '='.repeat(80), 'r1', 'r2']);
    });

    test('a saved session keeps the output of an app whose last line starts like its first for two of the three rows it wraps onto', async () => {
        // Every row a line wraps onto counts, not only the first
        const saves = recordSavedSessions();
        const wide = (tail) => `${'x'.repeat(170)}${tail}`;
        await receiveOutput(`$ app\r\n\x1b[?2004h${wide('-old-line-tail')}\r\nr1\r\nr2\r\nr3\r\nr4\r\n${wide('-new-line-tail')}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 6), ['$ app', wide('-old-line-tail'), 'r1', 'r2', 'r3', 'r4']);
    });

    test('a saved session keeps the output of an app that draws a rule, a blank row, its transcript, a rule and its input line', async () => {
        // A row filled to its last column, like the rule above the input line, does not run on into the row below
        const saves = recordSavedSessions();
        const rule = '─'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h${rule}\r\n\r\n r1\r\n r2\r\n r3\r\n${rule}\r\n❯ hi`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', rule, '', ' r1', ' r2', ' r3', rule, '']);
    });

    test('a saved session keeps the output of an app that draws its first line and input line again above a status row', async () => {
        // The rows under a command's first row are its own only where they continue it
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nTitle\r\n> hi\r\nstatus');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'r1', 'r2', 'r3', 'Title', '> hi', '']);
    });

    test('a saved session keeps the output of an app that draws its first line and a rule again above a different row', async () => {
        // A command that fills its row to the last column may run on into the next row only where it was typed on
        // since the listing: the marked one ended short of its row's last column
        const saves = recordSavedSessions();
        const rule = '─'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n${rule}\r\npage 1\r\nr1\r\nr2\r\nTitle\r\n${rule}\r\npage 2`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', rule, 'page 1', 'r1', 'r2', 'Title', rule, '']);
    });

    test('a saved session keeps the output of an app that draws its first line and input line again above a status row, padded to the last column', async () => {
        // Only text in the very last column fills a row; a space written there does not
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(77)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nTitle\r\n${input} \r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'r1', 'r2', 'r3', 'Title', input, '']);
    });

    test('a saved session keeps the output of an app that draws its first line and a wrapped line again, ending differently on a row of its own', async () => {
        // A command that runs on into a row not marked as wrapped is compared whole, with that row
        const saves = recordSavedSessions();
        const wide = 'x'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n${wide}abc\r\nr1\r\nr2\r\nr3\r\nTitle\r\n${wide}\r\nzzz`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', `${wide}abc`, 'r1', 'r2', 'r3', 'Title', wide, '']);
    });

    // bash 5.2's output at each keystroke (test/fixtures/bash-completion-listings.json); the terminal takes the
    // width it was captured at. Returns the content saved after each step
    const LISTINGS = require('./fixtures/bash-completion-listings.json');
    async function replayCapture(name, stepCount, captures = LISTINGS) {
        const { columns, steps } = captures[name];
        const saves = recordSavedSessions();
        terminal.resize(columns, terminal.rows);
        const savedAfter = [];
        for (const { output } of steps.slice(0, stepCount)) {
            await receiveOutput(output);
            savedAfter.push(saves.at(-1));
        }
        return savedAfter;
    }

    // Apps that keep bracketed paste on and draw their first lines again, with no blank row above them: a redrawn
    // prompt is looked for higher than the cursor's rows only under Starship's blank row
    test('a saved session keeps the output of an app that draws its first line again above an input line filled to the last column and a status row', async () => {
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(78)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nTitle\r\n${input}\r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'r1', 'r2', 'r3', 'Title', input, '']);
    });

    test('a saved session keeps the output of an app that draws its first line again above an input line and a full-width footer', async () => {
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(78)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nTitle\r\n${input}\r\n${'='.repeat(80)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 7), ['$ app', 'Title', '>', 'r1', 'r2', 'r3', 'Title']);
    });

    test('a saved session keeps the output of an app that draws its first line again above a progress bar filled to the last column', async () => {
        const saves = recordSavedSessions();
        const bar = `step ${'#'.repeat(75)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004h[build]\r\nstep \r\nr1\r\nr2\r\nr3\r\n[build]\r\n${bar}\r\ndone`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '[build]', 'step', 'r1', 'r2', 'r3', '[build]', bar, '']);
    });

    // An input box between rules with a footer, drawn the way Claude Code 2 draws it
    const RULE = '─'.repeat(80);
    const inputBox = (...input) => `${RULE}\r\n${input.join('\r\n')}\r\n${RULE}\r\n  ? for shortcuts`;

    test('a saved session keeps the output of an app that draws its input box again with an input filled to the last column', async () => {
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(78)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004h${inputBox('> ')}\r\nr1\r\nr2\r\nr3\r\n${inputBox(input)}`);

        assert.deepEqual(savedLines(saves.at(-1)),
            ['$ app', RULE, '>', RULE, '  ? for shortcuts', 'r1', 'r2', 'r3', RULE, input, RULE, '']);
    });

    test('a saved session keeps the output of an app that wraps its own input line onto rows filled to the last column', async () => {
        // The app writes each row with a newline, so none is marked as wrapped
        const saves = recordSavedSessions();
        const rows = [`> ${'x'.repeat(78)}`, 'y'.repeat(80), 'z'.repeat(40)];
        await receiveOutput(`$ app\r\n\x1b[?2004h${inputBox('> ')}\r\nr1\r\nr2\r\nr3\r\n${RULE}\r\n${rows.join('\r\n')}`);

        assert.deepEqual(savedLines(saves.at(-1)),
            ['$ app', RULE, '>', RULE, '  ? for shortcuts', 'r1', 'r2', 'r3', RULE, rows[0], rows[1], '']);
    });

    test('a saved session keeps the output of an app that draws its first two lines again, the second running on for five rows', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004hA\r\nB\r\nC\r\nA\r\nB${'x'.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 5), ['$ app', 'A', 'B', 'C', 'A']);
    });

    test('a saved session keeps the output of an app that draws its first line again under a blank row, above a filled input line', async () => {
        // The blank row above a redrawn prompt counts only where the marked prompt started with one too
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(78)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\n\r\nTitle\r\n${input}\r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'r1', 'r2', '', 'Title', input, '']);
    });

    test('a saved session keeps the output of an app that starts with a blank row and draws its first line again above a filled input line', async () => {
        // ...and where the redrawn one has it as well
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(78)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nTitle\r\n${input}\r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Title', '>', 'r1', 'r2', 'r3', 'Title', input, '']);
    });

    // Apps that start with a blank row, as Starship's prompt does, and draw rows like it again under another: only
    // a redrawn prompt's rows match, and only the rows the command was typed onto run on
    const filledInput = `> ${'x'.repeat(78)}`;
    for (const [shape, output, kept] of [
        ['draws its first line and input line again above a status row',
            'Title\r\n> \r\nr1\r\nr2\r\n\r\nTitle\r\n> hi\r\nstatus', ['Title', '>', 'r1', 'r2', '', 'Title', '> hi']],
        ['draws its first five lines again',
            'A\r\nB\r\nC\r\nD\r\nE\r\nr1\r\n\r\nA\r\nB\r\nC\r\nD\r\nE', ['A', 'B', 'C', 'D', 'E', 'r1', '', 'A', 'B', 'C', 'D']],
        ['draws its input line again under a different first line',
            `Title\r\n> \r\nr1\r\nr2\r\n\r\nOther\r\n${filledInput}\r\nmore`, ['Title', '>', 'r1', 'r2', '', 'Other', filledInput]],
        ['draws its first line again under a longer one',
            `ab\r\n> \r\nr1\r\nr2\r\n\r\nabc\r\n${filledInput}\r\nmore`, ['ab', '>', 'r1', 'r2', '', 'abc', filledInput]],
        ['draws its first line again above a typed row, where it first drew an empty one',
            'Title\r\n\r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\nsomething', ['Title', '', 'r1', 'r2', 'r3', '', 'Title']],
        ['pads its input line with a space to the last column above a status row',
            `Title\r\n> \r\nr1\r\nr2\r\n\r\nTitle\r\n> ${'x'.repeat(77)} \r\nstatus`, ['Title', '>', 'r1', 'r2', '', 'Title', `> ${'x'.repeat(77)}`]],
        ['draws its first line and a rule again above a different row',
            `Title\r\n${RULE}\r\npage 1\r\nr1\r\n\r\nTitle\r\n${RULE}\r\npage 2`, ['Title', RULE, 'page 1', 'r1', '', 'Title', RULE]],
        ['draws its first line again under a row holding a no-break space, above a filled input line',
            `Title\r\n> \r\nr1\r\nr2\r\n \r\nTitle\r\n${filledInput}\r\nstatus`, ['Title', '>', 'r1', 'r2', '', 'Title', filledInput]],
        ['draws its first line again under a row of spaces, above a filled input line',
            `Title\r\n> \r\nr1\r\nr2\r\n${' '.repeat(10)}\r\nTitle\r\n${filledInput}\r\nstatus`, ['Title', '>', 'r1', 'r2', '', 'Title', filledInput]],
    ]) {
        test(`a saved session keeps the output of an app that starts with a blank row and ${shape}`, async () => {
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h\r\n${output}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', ...kept, '']);
        });
    }

    test('a saved session leaves out the output of an app that starts with a blank row and draws it, its first line and a filled input line again', async () => {
        // Known limit: under a blank row, an app's title drawn again above an input line that fills its row (or wraps)
        // reads as Starship's prompt redrawn below a listing and typed on, so the save stops above the app's
        // transcript. Telling the two apart would also keep Starship's redrawn prompt. Pinned so that changing it is
        // deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n> \r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n${filledInput}\r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    test('a saved session keeps the output of an app that starts with a blank row and draws a wrapped line again, the cursor moved up into it', async () => {
        // The cursor's line runs on below it: compared whole, the two lines differ
        const saves = recordSavedSessions();
        const wide = (tail) => `${'x'.repeat(170)}${tail}`;
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n${wide('-old')}\r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n${wide('-new')}\x1b[A`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 8), ['$ app', '', 'Title', wide('-old'), 'r1', 'r2', 'r3', '']);
    });

    test('a saved session keeps the output of an app that starts with a blank row and repeats a line under blank rows, then wraps one onto six rows', async () => {
        // A redrawn prompt's rows lie below the marked command, not over it
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nA\r\n\r\nA\r\n\r\nA${'x'.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 6), ['$ app', '', 'A', '', 'A', '']);
    });

    test('a save reads a long wrapped line\'s rows a few times each and compares only the start of each command', async () => {
        // An app's line wrapped onto 2,000 rows, every other one erased back to blank (EL 1 keeps the wrap) and the
        // rest repeating the marked prompt's top line: each row there starts a redrawn prompt's command to compare
        // with the marked one. Building that command afresh at each row would read ~500 rows per row, comparing it
        // whole would go through ~80,000 characters each time, and taking its start from every row gathered so far
        // would slice ~500 rows each time; counted, not timed
        const saves = recordSavedSessions();
        const top = 'H'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n${top}\r\n> \r\n${`${'x'.repeat(80)}\x1b[1K${top}`.repeat(1000)}`);
        const buffer = terminal.buffer.active;
        const getLine = buffer.getLine.bind(buffer);
        const { startsWith, slice } = String.prototype;
        let reads = 0;
        let slices = 0;
        let comparisons = 0;
        let compared = 0;
        buffer.getLine = (row) => {
            reads++;
            return getLine(row);
        };
        String.prototype.startsWith = function (search, ...rest) {
            comparisons++;
            compared += this.length + String(search).length;
            return startsWith.call(this, search, ...rest);
        };
        String.prototype.slice = function (...range) {
            slices++;
            return slice.apply(this, range);
        };
        try {
            manager.saveSessionState();
        } finally {
            Object.assign(String.prototype, { startsWith, slice });
            delete buffer.getLine;
        }

        assert.ok(savedLines(saves.at(-1)).includes(top), 'the app\'s output is kept');
        assert.ok(reads < 50 * buffer.length, `${reads} row reads for ${buffer.length} rows`);
        assert.ok(comparisons > 0, 'the commands are compared');
        assert.ok(compared < 20 * comparisons, `${compared} characters compared in ${comparisons} comparisons`);
        assert.ok(slices < 10 * comparisons, `${slices} slices for ${comparisons} comparisons`);
    });

    // The save at the prompt after `echo out`, before the listing: what each later save should equal
    const savedBeforeListing = (saved) => saved[1];

    test('a saved session leaves out a Starship prompt redrawn below a completion listing once the cursor moved down across the command\'s wrap', async () => {
        // Ctrl-A moves the cursor up the command, Ctrl-E back down with a newline, which leaves the row it moves to
        // unmarked as a wrapped one
        const saved = await replayCapture('starshipCtrlE', 6);

        assert.deepEqual(savedLines(savedBeforeListing(saved)).slice(2), ['\u276f echo out', 'out', '']);
        assert.deepEqual(saved.slice(3), [3, 4, 5].map(() => savedBeforeListing(saved)),
            'typed until it wraps, after Ctrl-A and after Ctrl-E');
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing once the arrow keys moved the cursor back down across the command\'s wrap', async () => {
        const saved = await replayCapture('starshipArrows', 6);

        assert.equal(saved.at(-1), savedBeforeListing(saved));
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command four rows long', async () => {
        // The redrawn prompt's top line is five rows above the cursor
        const saved = await replayCapture('starshipFourRows', 4);

        assert.equal(saved.at(-1), savedBeforeListing(saved));
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command three rows long at 40 columns', async () => {
        // At 40 columns the prompt's top line wraps its last space onto a row of its own, so the redrawn prompt's top
        // line is five rows above the cursor
        const saved = await replayCapture('starshipNarrow', 4);

        assert.deepEqual(savedLines(savedBeforeListing(saved)).slice(2), ['\u276f echo out', 'out', '']);
        assert.equal(saved.at(-1), savedBeforeListing(saved));
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing at 40 columns after Ctrl-E and erasing back', async () => {
        const saved = await replayCapture('starshipNarrow', 6);

        assert.equal(saved.at(-1), savedBeforeListing(saved));
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command that wrapped before it, after Ctrl-A and Ctrl-E', async () => {
        const saved = await replayCapture('starshipWrappedCtrlE', 6);

        assert.equal(saved.at(-1), savedBeforeListing(saved));
    });

    // readline's cursor moves over a wrapped command, as in the captures: Ctrl-A goes up a row at a time, then to
    // the command's first column; Ctrl-E down a row at a time with a newline, then on to the command's end
    const ctrlA = (rows, column) => `${'\x1b[A'.repeat(rows)}\r${'\x1b[C'.repeat(column)}`;
    const ctrlE = (rows, column) => `${'\r\n'.repeat(rows)}\r${'\x1b[C'.repeat(column)}`;

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command four rows long, after Ctrl-A and Ctrl-E', async () => {
        // The marked command wraps onto four rows; the redrawn one, typed on, is compared whole
        const saves = recordSavedSessions();
        await receiveOutput(`${starshipCompletion(`ls /tmp/${'x'.repeat(240)}/`)}${'a'.repeat(10)}`);
        await receiveOutput(ctrlA(3, 2));
        await receiveOutput(ctrlE(3, 21));

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command that filled its row, typed on to four rows', async () => {
        // Rows marked as wrapped are the command's own, however the marked one ended
        const saves = recordSavedSessions();
        await receiveOutput(`${starshipCompletion(`ls /tmp/${'x'.repeat(69)}/`)}${'a'.repeat(200)}`);

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing once the cursor moved down across a wide character at the wrap', async () => {
        // The wide character fills the row's last two columns: its right half has no text of its own
        const saves = recordSavedSessions();
        await receiveOutput(`${starshipCompletion('ls /tmp/d/')}${'a'.repeat(66)}日bb`);
        await receiveOutput(ctrlA(1, 2));
        await receiveOutput(ctrlE(1, 2));

        assert.equal(saves.at(-1), '');
    });

    test('a saved session leaves out a prompt with a blank row and three lines above its command redrawn below a completion listing once the cursor moved down across the command\'s wrap', async () => {
        // Three rows above the command, the most a prompt has
        const saves = recordSavedSessions();
        const prompt = '\r\ncontext\r\nuser@box\r\n/app\r\n$ ';
        await receiveOutput(`\x1b[?2004h${prompt}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${prompt}ls /tmp/d/\x07\r\n${COMPLETIONS}${prompt}ls /tmp/d/${'a'.repeat(70)}`);
        await receiveOutput(ctrlA(1, 2));
        await receiveOutput(ctrlE(1, 2));

        assert.deepEqual(savedLines(saves.at(-1)), ['', 'context', 'user@box', '/app', '$ echo out', 'out', '']);
    });

    test('a saved session keeps a three-line prompt with no blank first row redrawn below a completion listing once the cursor moved down across the command\'s wrap', async () => {
        // Known limit: the redrawn prompt is looked for higher than the cursor's rows only under a blank row like
        // Starship's, as an app's rows would pass for a prompt's. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        const prompt = 'context\r\nuser@box\r\n/app\r\n$ ';
        await receiveOutput(`\x1b[?2004h${prompt}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${prompt}ls /tmp/d/\x07\r\n${COMPLETIONS}${prompt}ls /tmp/d/${'a'.repeat(70)}`);
        await receiveOutput(ctrlA(1, 2));
        await receiveOutput(ctrlE(1, 2));

        assert.deepEqual(savedLines(saves.at(-1)), ['context', 'user@box', '/app', '$ echo out', 'out', 'context', 'user@box',
            '/app', `$ ls /tmp/d/`, COMPLETIONS.trimEnd(), 'context', 'user@box', '/app', `$ ls /tmp/d/${'a'.repeat(68)}`, '']);
    });

    test('a saved session keeps a plain prompt redrawn below a completion listing once the cursor moved down across the command\'s wrap', async () => {
        // Known limit: readline moves the cursor down a wrapped command with a newline, which leaves the row it
        // moves to unmarked as a wrapped one, and a one-row prompt has no row above its command to anchor the
        // rows below on. The save keeps the listing and the redrawn prompt, which the tab shows again above its new
        // prompt. Pinned so that changing it is deliberate
        const saved = await replayCapture('plainCtrlE', 6);

        const prompt = 'root@box:/app# ';
        assert.deepEqual(savedLines(saved.at(-1)), [`${prompt}echo out`, 'out', `${prompt}ls /tmp/e/`,
            'alpha-a-rather-long-directory-name/ eta-a-rather-long-directory-name/',
            'beta-a-rather-long-directory-name/  gamma-a-rather-long-directory-name/',
            'delta-a-rather-long-directory-name/ theta-a-rather-long-directory-name/',
            'eps-a-rather-long-directory-name/   zeta-a-rather-long-directory-name/',
            `${prompt}ls /tmp/e/${'a'.repeat(55)}`, '']);
        assert.deepEqual(savedLines(saved[4]), [`${prompt}echo out`, 'out', ''], 'before the cursor moved, it was left out');
    });

    test('a saved session keeps a plain prompt redrawn below a completion listing with a command more than four rows long', async () => {
        // Known limit: the redrawn prompt is looked for no higher than four rows up, and a one-row prompt has no
        // row above its command to anchor a longer one on. Pinned so that changing it is deliberate
        const saved = await replayCapture('plainSixRows', 4);

        const prompt = 'root@box:/app# ';
        assert.deepEqual(savedLines(saved.at(-1)), [`${prompt}echo out`, 'out', `${prompt}ls /tmp/d/`,
            'alpha/ beta/  delta/ gamma/', `${prompt}ls /tmp/d/${'a'.repeat(55 + 4 * 80)}`, '']);
    });

    // A command typed at the prompt and not run, long enough to take the cursor more than four rows below the marked
    // row: the terminal wraps it, so its rows run on as one line from the prompt's
    const typedCommand = (length) => `echo ${'a'.repeat(length)}`;

    test('a saved session leaves out a Starship prompt with a half-typed command four rows long', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}${typedCommand(250)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '❯ echo out', 'out', '']);
    });

    test('a saved session leaves out a plain prompt with a half-typed command six rows long', async () => {
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004hroot@box:/app# echo out\r\n\x1b[?2004l\rout\r\n');
        await receiveOutput(`\x1b[?2004hroot@box:/app# ${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['root@box:/app# echo out', 'out', '']);
    });

    test('a saved session leaves out a Starship prompt with a half-typed command at 40 columns', async () => {
        // At 40 columns the prompt's top line wraps its last space onto a row of its own, so the command starts on the
        // prompt's third row and a command three rows long takes the cursor five rows below the marked one
        const saves = recordSavedSessions();
        terminal.resize(40, terminal.rows);
        const [{ output: start }, { output: echoOut }] = LISTINGS.starshipNarrow.steps;
        await receiveOutput(`${start}${echoOut}`);
        const savedAtPrompt = saves.at(-1);
        await receiveOutput(typedCommand(100));

        assert.deepEqual(savedLines(savedAtPrompt).slice(2), ['❯ echo out', 'out', '']);
        assert.equal(saves.at(-1), savedAtPrompt);
    });

    test('a saved session leaves out a Starship prompt with a half-typed command at 20 columns', async () => {
        // At 20 columns the prompt's top line wraps onto two rows more
        const saves = recordSavedSessions();
        terminal.resize(20, terminal.rows);
        const [{ output: start }, { output: echoOut }] = LISTINGS.starshipNarrow.steps;
        await receiveOutput(`${start}${echoOut}`);
        const savedAtPrompt = saves.at(-1);
        await receiveOutput(typedCommand(100));

        assert.deepEqual(savedLines(savedAtPrompt).slice(-3), ['❯ echo out', 'out', '']);
        assert.equal(saves.at(-1), savedAtPrompt);
    });

    test('a saved session leaves out a one-line prompt after a blank row with a half-typed command six rows long', async () => {
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004h\r\n$ ';
        await receiveOutput(`${prompt}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`${prompt}${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['', '$ echo out', 'out', '']);
    });

    test('a saved session keeps a two-line prompt with no blank first row and a half-typed command more than four rows below it', async () => {
        // Known limit: with no blank row first, the prompt's second line could as well be a background job's line at a
        // one-line prompt, with the command typed after it. The save keeps the prompt and the command's rows above the
        // cursor's, which the tab shows again above its new prompt. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004huser@box ~/app\r\n$ ';
        await receiveOutput(`${prompt}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`${prompt}${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)),
            ['user@box ~/app', '$ echo out', 'out', 'user@box ~/app', `$ ${typedCommand(400)}`.slice(0, 5 * 80), '']);
    });

    for (const [shape, firstLine] of [['a first line', 'Title'], ['a first line wrapped onto two rows', 'T'.repeat(100)]]) {
        test(`a saved session keeps the output of an app that left bracketed paste on and printed ${shape}, then a line running past four rows`, async () => {
            // With no blank row first, the line after the first one starts no command
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${firstLine}\r\n${'x'.repeat(400)}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', firstLine, 'x'.repeat(4 * 80), '']);
        });
    }

    for (const [shape, before] of [['a line running past four rows', ''],
        ['a blank row and a first line, then a line running past four rows', '\r\nTitle\r\n']]) {
        test(`a saved session leaves out the output of an app that left bracketed paste on and printed ${shape}`, async () => {
            // Known limit: the line reads as a command typed at a prompt, a one-line one or Starship's, so the save stops
            // above the app's output. An app starts new lines as it prints, so its last line seldom starts that high.
            // Pinned so that changing it is deliberate
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${before}${'x'.repeat(450)}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
        });
    }

    test('a saved session keeps the output of an app whose first line ran past four rows, with the cursor on the row below it', async () => {
        // The line that matters is the cursor's own, which starts on its row
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${'x'.repeat(400)}\r\n`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'x'.repeat(400), '']);
    });

    test('a saved session keeps the output of an app that printed a first line, then a line running past four rows, with the cursor on the row below it', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n${'x'.repeat(400)}\r\n`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', 'x'.repeat(400), '']);
    });

    test('a saved session keeps the output of an app that starts with two blank rows, then a line running past four rows', async () => {
        // No prompt has two blank rows first
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n\r\n${'x'.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', '', 'x'.repeat(320), '']);
    });

    test('a saved session keeps the output of an app that turned bracketed paste on partway through a line it ran on past four rows', async () => {
        // The line starts above the prompt's rows, so it is no command typed there
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n${'x'.repeat(50)}\x1b[?2004h${'x'.repeat(600)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'x'.repeat(8 * 80), '']);
    });

    // bash 5.2's output at each keystroke, a long command typed a key at a time (test/fixtures/bash-long-commands.json)
    const LONG_COMMANDS = require('./fixtures/bash-long-commands.json');
    for (const [name, prompt] of [['starshipLong', 'a Starship prompt'], ['starshipLongNarrow', 'a Starship prompt at 40 columns'],
        ['plainLong', 'a plain prompt']]) {
        test(`a saved session leaves out ${prompt} with a half-typed command more than four rows below it, as bash prints it`, async () => {
            const saved = await replayCapture(name, 3, LONG_COMMANDS);

            assert.deepEqual(savedLines(saved[1]).slice(-3), [name === 'plainLong' ? 'root@box:/app# echo out' : '❯ echo out',
                'out', '']);
            assert.equal(saved[2], saved[1]);
        });
    }

    for (const [name, job, kept] of [
        ['plainAsyncJob', 'a background job\'s line', ['root@box:/app# (sleep 0.5; echo job done) &', '[1] 891', 'root@box:/app# job done']],
        ['plainAsyncNotify', 'bash\'s notice that a background job is done',
            ['root@box:/app# set -b; sleep 0.5 &', '[1] 1328', `root@box:/app# [1]+  Done${' '.repeat(20)}sleep 0.5`]],
    ]) {
        test(`a saved session keeps ${job} printed at a plain prompt, with a long command typed under it, as bash prints it`, async () => {
            // The line lands on the prompt's row and the command starts on the row below, as a two-line prompt's
            // would: with no blank row first, that is no command typed at the prompt
            const saved = await replayCapture(name, 4, LONG_COMMANDS);

            assert.deepEqual(savedLines(saved[3]).slice(0, 3), kept);
        });
    }

    test('a saved session leaves out a Starship prompt with a half-typed command four rows long after Ctrl-A, as bash prints it', async () => {
        const saved = await replayCapture('starshipLongCtrlE', 4, LONG_COMMANDS);

        assert.equal(saved[3], saved[1]);
    });

    test('a saved session keeps a Starship prompt with a half-typed command four rows long after Ctrl-A and Ctrl-E, as bash prints it', async () => {
        // Known limit: readline moves the cursor down the command with a newline, which leaves the rows it moves to
        // unmarked as wrapped ones, so the command no longer runs on as one line from the prompt's. The save keeps the
        // prompt and the command's rows above the cursor's, which the tab shows again above its new prompt. Pinned so
        // that changing it is deliberate
        const saved = await replayCapture('starshipLongCtrlE', 5, LONG_COMMANDS);

        const atPrompt = savedLines(saved[1]);
        assert.deepEqual(savedLines(saved[4]), [...atPrompt.slice(0, -1), '', atPrompt[1], `❯ echo ${'a'.repeat(73)}`,
            'a'.repeat(80), 'a'.repeat(80), '']);
    });

    test('a saved session leaves out the prompt redrawn at the top of a cleared screen', async () => {
        // Ctrl-L clears the screen, and with it the row the shell marked, and redraws the prompt without
        // turning bracketed paste on again
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}\x1b[?2004h$ `);
        await receiveOutput('\x1b[H\x1b[2J$ ');

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 15', 'line 16', '']);
    });

    // bash 5.2's Ctrl-L under Starship (captured): it clears the screen and redraws the whole prompt from the
    // top, without turning bracketed paste on again
    const STARSHIP_CTRL_L = `\x1b[H\x1b[2J${STARSHIP_PROMPT.replace('\x1b[?2004h', '')}`;

    test('a saved session leaves out a Starship prompt redrawn by Ctrl-L', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}ls /app/config\r\n\x1b[?2004l\rstarship.toml\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}${STARSHIP_CTRL_L}`);

        assert.equal(saves.at(-1), '');
    });

    test('a saved session keeps the scrollback above a Starship prompt redrawn by Ctrl-L', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}${STARSHIP_PROMPT}ls /app/config\r\n\x1b[?2004l\rstarship.toml\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}${STARSHIP_CTRL_L}`);

        const lines = savedLines(saves.at(-1));
        assert.deepEqual(lines.slice(-3), ['line 21', 'line 22', '']);
        assert.ok(!lines.includes(plain(STARSHIP_TOP_LINE)), 'the prompt\'s top line is left out');
    });

    test('a saved session leaves out a Starship prompt redrawn by readline\'s clear-display', async () => {
        // M-C-l (captured from bash 5.2) clears the scrollback as well (CSI 3 J), and with it the row above the screen
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}${STARSHIP_PROMPT}echo hi\r\n\x1b[?2004l\rhi\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}\x1b[H\x1b[2J\x1b[3J${STARSHIP_REDRAW}`);

        assert.equal(saves.at(-1), '');
    });

    test('a saved session keeps the output above a Starship prompt when only the scrollback is cleared', async () => {
        // CSI 3 J on its own leaves the screen, and the prompt's mark on it, alone
        const saves = recordSavedSessions();
        await receiveOutput(`${STARSHIP_PROMPT}ls /app/config\r\n\x1b[?2004l\rstarship.toml\r\n`);
        await receiveOutput(`${STARSHIP_PROMPT}\x1b[3J`);

        assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '❯ ls /app/config', 'starship.toml', '']);
    });

    test('a saved session keeps the scrollback above a two-line prompt redrawn by Ctrl-L', async () => {
        // The prompt has no blank line first, so it starts right at the top of the screen
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004huser@host ~/dir\r\n$ ';
        await receiveOutput(`${SCREENFULS}${prompt}ls\r\n\x1b[?2004l\rfile\r\n`);
        await receiveOutput(`${prompt}\x1b[H\x1b[2Juser@host ~/dir\r\n$ `);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 19', 'line 20', '']);
    });

    test('a saved session keeps the scrollback above a Starship prompt redrawn after a clear sent before the cursor goes home', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}${STARSHIP_PROMPT}`);
        await receiveOutput(`\x1b[2J\x1b[H${STARSHIP_REDRAW}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 17', 'line 18', '']);
    });

    test('a saved session keeps the scrollback above a two-line zsh prompt redrawn by Ctrl-L', async () => {
        // zsh 5.9's Ctrl-L (captured) erases below the cursor (CSI J) after clearing the screen, keeping the scrollback
        const saves = recordSavedSessions();
        const twoLinePrompt = zshPrompt('\x1b[34mtop line\x1b[39m\r\n% ');
        await receiveOutput(`${SCREENFULS}${twoLinePrompt}`);
        await receiveOutput('\x1b[H\x1b[2J\x1b[0m\x1b[27m\x1b[24m\x1b[J\x1b[34mtop line\x1b[39m\r\n% \x1b[K');

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 16', 'line 17', '']);
    });

    test('a saved session keeps the output above a zsh prompt that erases below itself', async () => {
        // zsh erases below the prompt (CSI J) to clear away a completion listing
        const saves = recordSavedSessions();
        await receiveOutput(zshPrompt('host% '));
        await receiveOutput(ZSH_PRINT_PASS);
        await receiveOutput(`${zshPrompt('host% ')}\x1b[J`);

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print -P "%F{green}# pass 12%f"', '# pass 12', '']);
    });

    test('a saved session leaves out a prompt redrawn above the row the shell marked', async () => {
        // The cursor is on the prompt, so it starts no lower than the cursor's row, here with the marked row
        // left in place below it
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}\x1b[?2004h$ `);
        await receiveOutput('\x1b[H$ \x1b[K');

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 15', 'line 16', '']);
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

        await withRestoredPrompt(saves.at(-1), (restored) => {
            assert.deepEqual(bufferLines(restored).slice(0, 4), ['$ ls', 'file1', '$ vim notes.txt', '$ ']);
        });
    });

    test('a restored tab\'s new shell does not inherit an open editor\'s text attributes', async () => {
        const saves = recordSavedSessions();
        await openVim();
        await receiveOutput('\x1b[31;7m-- INSERT --');
        terminal.input('i');

        await withRestoredPrompt(saves.at(-1), (restored) => {
            assert.deepEqual(bufferLines(restored).slice(0, 4), ['$ ls', 'file1', '$ vim notes.txt', '$ ']);
            const prompt = cellAt(restored, 3, 0);
            assert.equal(prompt.isInverse(), 0);
            assert.equal(prompt.getFgColorMode(), 0, 'default foreground');
        });
    });

    test('a restored tab\'s new shell does not inherit the colour a running command left on', async () => {
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004h$ make\r\n\x1b[?2004l');
        await receiveOutput('ERROR: \x1b[31;7mbuild failed');

        await withRestoredPrompt(saves.at(-1), (restored) => {
            assert.deepEqual(bufferLines(restored).slice(0, 3), ['$ make', 'ERROR: build failed', '$ ']);
            assert.notEqual(cellAt(restored, 1, 7).isInverse(), 0, 'the output keeps its colours');
            const prompt = cellAt(restored, 2, 0);
            assert.equal(prompt.isInverse(), 0);
            assert.equal(prompt.getFgColorMode(), 0, 'default foreground');
        });
    });

    test('a session saved after the screen was cleared restores without a screen of blank rows', async () => {
        // Ctrl-L clears the screen and keeps the scrollback, leaving the cursor near the top; the serializer
        // then ends the save by moving the cursor back up, on a row of its own below the blank rows
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}\x1b[?2004h$ `);
        await receiveOutput('\x1b[H\x1b[2J$ ');
        await receiveOutput('vim notes.txt\r\n\x1b[?2004l');
        await receiveOutput('\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2JVIM SCREEN\r\n~\r\n~');
        terminal.input('i');

        await withRestoredPrompt(saves.at(-1), (restored) => {
            const lines = bufferLines(restored);
            const prompt = cursorRow(restored);
            assert.deepEqual(lines.slice(prompt - 1, prompt + 1), ['$ vim notes.txt', '$ ']);
        });
    });

    // Restoring a screenful scrolls on the final newline, and xterm fills the new row with the background
    // colour set at that point; the output's last colour must not end up across the new prompt's row
    for (const [kind, output] of [['reset', 'Result: \x1b[41m FAIL \x1b[0m'], ['left on', 'Result: \x1b[41m FAIL']]) {
        test(`a restored tab's new prompt row has the default background (output colour ${kind})`, async () => {
            const saves = recordSavedSessions();
            await receiveOutput(`${SCREENFULS}\x1b[?2004h$ npm test\r\n\x1b[?2004l`);
            await receiveOutput(output);

            await withRestoredPrompt(saves.at(-1), (restored) => {
                for (const col of [8, 20, 40, 79]) {
                    assert.ok(cellAt(restored, cursorRow(restored), col).isBgDefault(), `column ${col}`);
                }
            });
        });
    }

    test('a restored tab keeps a coloured bar the output erased to the end of the bottom row', async () => {
        // With the cursor still on it, the serializer ends the save with the erase (ECH), not a cursor move
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}\x1b[?2004h$ make\r\n\x1b[?2004l`);
        await receiveOutput('status: \x1b[44m building\x1b[K');
        assert.match(saves.at(-1), /\x1b\[63X\n$/);

        await withRestoredPrompt(saves.at(-1), (restored) => {
            const bar = cursorRow(restored) - 1;
            assert.equal(bufferLines(restored)[bar], 'status:  building');
            assert.ok(!cellAt(restored, bar, 40).isBgDefault(), 'the erased cells keep the bar\'s colour');
        });
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
        const saves = recordSavedSessions();
        await openVim();
        reconnect();

        await receiveOutput('\x1b[?2004h$ ');
        assert.equal(terminal.buffer.active.type, 'normal');
        await receiveOutput('make\r\n\x1b[?2004l');
        await receiveOutput('BUILD DONE');
        assert.deepEqual(bufferLines(terminal).slice(0, 5), ['$ ls', 'file1', '$ vim notes.txt', '$ make', 'BUILD DONE'],
            'the new shell carries on under the line that started the editor');
        assert.match(saves.at(-1), /\$ make\nBUILD DONE\n$/);
    });

    test('reconnecting while an editor is open turns off the modes the editor set', async () => {
        await receiveOutput('$ ls\r\nfile1\r\n$ vim notes.txt\r\n');
        await receiveOutput('\x1b[?1049h\x1b[?25l\x1b[?1h\x1b=\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[H\x1b[2JVIM SCREEN');
        reconnect();
        await receiveOutput('\x1b[?2004h$ ');

        // xterm.js has no public read of cursor visibility or the mouse report encoding
        assert.equal(terminal._core.coreService.isCursorHidden, false, 'cursor shown');
        assert.equal(terminal.modes.applicationCursorKeysMode, false);
        assert.equal(terminal.modes.applicationKeypadMode, false);
        assert.equal(terminal.modes.mouseTrackingMode, 'none');
        assert.equal(terminal._core.coreMouseService.activeEncoding, 'DEFAULT', 'SGR mouse encoding off');
        assert.equal(terminal.modes.sendFocusMode, false);
    });

    // Switching to the editor's screen saves the text attributes in use (DECSC), and leaving it restores them:
    // the reset has to come after the switch back, or the new shell would get them
    test('reconnecting while an editor is open gives the new shell none of the colours in use before it', async () => {
        await receiveOutput('$ vim notes.txt\r\n\x1b[31;7m\x1b[?1049h\x1b[H\x1b[2JVIM SCREEN');
        reconnect();
        await receiveOutput('new$ ');

        const row = bufferLines(terminal).indexOf('new$ ');
        assert.notEqual(row, -1, 'the new shell\'s prompt');
        const prompt = terminal.buffer.active.getLine(row).getCell(0);
        assert.equal(prompt.isInverse(), 0);
        assert.equal(prompt.getFgColorMode(), 0, 'default foreground');
    });

    test('reconnecting after a program in the normal buffer turns off the modes it set', async () => {
        // A picker drawn under the prompt (fzf --height) never leaves the normal buffer, yet hides the cursor and
        // turns on application cursor keys and keypad, mouse reports in SGR encoding and focus reports
        await receiveOutput('$ fzf --height 40%\r\n\x1b[?25l\x1b[?1h\x1b=\x1b[?1000h\x1b[?1006h\x1b[?1004h> ');
        assert.equal(terminal.buffer.active.type, 'normal');
        reconnect();
        await receiveOutput('\x1b[?2004hnew$ ');

        assert.equal(terminal._core.coreService.isCursorHidden, false, 'cursor shown');
        assert.equal(terminal.modes.applicationCursorKeysMode, false);
        assert.equal(terminal.modes.applicationKeypadMode, false);
        assert.equal(terminal.modes.mouseTrackingMode, 'none');
        assert.equal(terminal._core.coreMouseService.activeEncoding, 'DEFAULT', 'SGR mouse encoding off');
        assert.equal(terminal.modes.sendFocusMode, false);
        assert.deepEqual(bufferLines(terminal).slice(0, 4),
            ['$ fzf --height 40%', '> ', 'Connection lost. Attempting to reconnect...', 'new$ '],
            'the new shell carries on under what the program left');
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
