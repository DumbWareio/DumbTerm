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
    // zsh 5.9 draws a command typed after its prompt past the margin itself: after a row's last character it writes a
    // space, which takes the cursor onto the next row, goes back to that row's start and erases it (which unmarks it as
    // wrapped), writes the row's first character, and from the row's start again the whole row. A command that ends at
    // the last column leaves the cursor at the start of the next row, which zsh moves onto and erases the same way
    const zshTyped = (prompt, command, columns = 80) => {
        const rows = [command.slice(0, columns - prompt.length)];
        for (let at = rows[0].length; at < command.length; at += columns) rows.push(command.slice(at, at + columns));
        const filled = (prompt.length + command.length) % columns === 0 ? ' \r\x1b[K' : '';
        return `${command[0]}\b${rows[0]}${rows.slice(1).map((row) => ` \r\x1b[K${row[0]}\r${row}`).join('')}${filled}`;
    };
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

    test('a saved session keeps the first row of a wrapped line once output pushed a mark put below the cursor out of the scrollback', async () => {
        // The marked row is gone, so the row above it is no prompt's either
        const saves = recordSavedSessions();
        await receiveOutput(zshPrompt('host% '));
        await receiveOutput(`\r\n${Array.from({ length: 5100 }, (_, i) => `line ${i}\r\n`).join('')}${'x'.repeat(100)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ['line 5099', 'x'.repeat(80), '']);
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
        // A space written in the input line's last column runs it on into no other row: only rows marked as wrapped do
        const saves = recordSavedSessions();
        const input = `> ${'x'.repeat(77)}`;
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nr1\r\nr2\r\nr3\r\nTitle\r\n${input} \r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'r1', 'r2', 'r3', 'Title', input, '']);
    });

    test('a saved session keeps the output of an app that draws its first line and a wrapped line again, ending differently on a row of its own', async () => {
        // A row not marked as wrapped starts a line of its own: the cursor's line is compared with the row the first
        // line wrapped onto
        const saves = recordSavedSessions();
        const wide = 'x'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n${wide}abc\r\nr1\r\nr2\r\nr3\r\nTitle\r\n${wide}\r\nzzz`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', `${wide}abc`, 'r1', 'r2', 'r3', 'Title', wide, '']);
    });

    // bash 5.2's output at each keystroke (test/fixtures/bash-completion-listings.json); the terminal takes the
    // width it was captured at, and a step with columns of its own is resized to them first. With typeTabs, a step
    // whose keys end with Tab, Tab has them typed where they were: the first rings the bell, the second lists the
    // completions. Returns the content saved after each step
    const LISTINGS = require('./fixtures/bash-completion-listings.json');
    async function replayCapture(name, stepCount, captures = LISTINGS, { typeTabs = false } = {}) {
        const { columns, steps } = captures[name];
        const saves = recordSavedSessions();
        terminal.resize(columns, terminal.rows);
        const savedAfter = [];
        for (const { keys, output, columns: resized } of steps.slice(0, stepCount)) {
            if (resized) terminal.resize(resized, terminal.rows);
            const bell = output.indexOf('\x07');
            if (typeTabs && keys.endsWith('Tab, Tab') && bell >= 0) {
                await receiveOutput(output.slice(0, bell));
                terminal.input('\t');
                await receiveOutput('\x07');
                terminal.input('\t');
                await receiveOutput(output.slice(bell + 1));
            } else {
                await receiveOutput(output);
            }
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
    // a redrawn prompt's rows match, and a command runs on only into rows the terminal marked as wrapped
    const filledInput = `> ${'x'.repeat(78)}`;
    const wrappedInput = `> ${'x'.repeat(150)}`;
    for (const [shape, output, kept] of [
        ['draws its first line and input line again above a status row',
            'Title\r\n> \r\nr1\r\nr2\r\n\r\nTitle\r\n> hi\r\nstatus', ['Title', '>', 'r1', 'r2', '', 'Title', '> hi']],
        ['draws it, its first line and a filled input line again, then two rows',
            `Title\r\n> \r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n${filledInput}\r\nstatus\r\nmore`, ['Title', '>', 'r1', 'r2', 'r3', '', 'Title', filledInput, 'status']],
        ['draws it, its first line and a wrapped input line ending short of the last column again, then a row',
            `Title\r\n> \r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n${wrappedInput}\r\nstatus`, ['Title', '>', 'r1', 'r2', 'r3', '', 'Title', wrappedInput]],
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

    test('a saved session keeps the output of an app that starts with a blank row and draws it, its first line and a filled input line again', async () => {
        // Under a blank row, the app's title drawn again reads as Starship's top line redrawn below a listing, and its
        // input line as the command typed on there, where the input line it first drew ended short of its last column
        // (here `> `). The row below the input line starts a line of its own, as nothing marked it as wrapped and the
        // cursor never moved up over it, so it is no command's
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n> \r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n${filledInput}\r\nstatus`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Title', '>', 'r1', 'r2', 'r3', '', 'Title', filledInput, '']);
    });

    test('a saved session keeps the output of an app that starts with a blank row and draws it, its first line and a filled input line again, then a filled row and another', async () => {
        // The cursor two rows below the input line: the row between ends at its last column too
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n> \r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n${filledInput}\r\n${'S'.repeat(80)}\r\nmore`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Title', '>', 'r1', 'r2', 'r3', '', 'Title', filledInput, 'S'.repeat(80), '']);
    });

    test('a saved session leaves out the output of an app that starts with a blank row, its first line and a blank row and draws them again above a blank line that wraps', async () => {
        // Known limit: under a blank row, the app's title drawn again above a blank row and a blank line the terminal
        // wraps (EL 1 keeps the wrap), with the cursor on it, reads as Starship's prompt redrawn below a listing: its rows
        // repeat the marked ones' (the title, then blank rows) and its empty command matches the empty row the app first
        // drew there (an empty command matches another empty one, though no other). The terminal wrapped the line itself,
        // so it runs on as a command does, and the save stops above the app's transcript. Pinned so that changing it is
        // deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n\r\n\r\nTitle\r\n${`${'x'.repeat(80)}\x1b[1K`.repeat(5)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    test('a saved session keeps the output of an app that starts with a blank row and draws it, its first line and a filled input line again, then a line wrapped onto them once more', async () => {
        // The cursor's line starts on the row of q's, which the newline before it leaves unmarked as wrapped, so no
        // command is looked for higher: the lower copy's input line does not run on into it
        const saves = recordSavedSessions();
        const top = 'H'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n${top}\r\n${filledInput}\r\nr1\r\nr2\r\nr3\r\n\r\n${top}\r\n${filledInput}\r\n`
            + `${'q'.repeat(80)}${'x'.repeat(80)}\x1b[1K${top}> zzz`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 10), ['$ app', '', top, filledInput, 'r1', 'r2', 'r3', '', top, filledInput]);
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

    // Run a save with its work counted: the rows it reads, its startsWith calls with the characters of both strings, its
    // slice, substring and substr calls with the characters of the strings they cut from, and its join calls with the
    // characters joined. Strings built some other way (with + alone, or a template) go uncounted
    function countedSave() {
        const buffer = terminal.buffer.active;
        const getLine = buffer.getLine.bind(buffer);
        const { startsWith, slice, substring, substr } = String.prototype;
        const { join } = Array.prototype;
        const work = { reads: 0, comparisons: 0, compared: 0, slices: 0, sliced: 0, joins: 0, joined: 0 };
        buffer.getLine = (row) => {
            work.reads++;
            return getLine(row);
        };
        String.prototype.startsWith = function (search, ...rest) {
            work.comparisons++;
            work.compared += this.length + String(search).length;
            return startsWith.call(this, search, ...rest);
        };
        for (const [name, cut] of Object.entries({ slice, substring, substr })) {
            String.prototype[name] = function (...range) {
                work.slices++;
                work.sliced += this.length;
                return cut.apply(this, range);
            };
        }
        Array.prototype.join = function (...separator) {
            const joined = join.apply(this, separator);
            work.joins++;
            work.joined += joined.length;
            return joined;
        };
        try {
            manager.saveSessionState();
        } finally {
            Object.assign(String.prototype, { startsWith, slice, substring, substr });
            Array.prototype.join = join;
            delete buffer.getLine;
        }
        return work;
    }

    test('a save reads a long wrapped line\'s rows a few times each and compares only the start of each command', async () => {
        // An app's line wrapped onto 2,000 rows, every other one erased back to blank (EL 1 keeps the wrap) and the
        // rest repeating the marked prompt's top line: each row there starts a redrawn prompt's command to compare
        // with the marked one. Building that command afresh at each row would read ~500 rows per row, comparing it
        // whole would go through ~80,000 characters each time, and taking its start from every row gathered so far
        // would slice ~500 rows each time, or slice it from them all joined, or added one to the front of the rest;
        // counted, not timed. The save's work is counted with the line half as long too: twice as long, the line
        // takes no count to more than three times as much
        const saves = recordSavedSessions();
        const top = 'H'.repeat(80);
        const appRows = (count) => `${'x'.repeat(80)}\x1b[1K${top}`.repeat(count / 2);
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n${top}\r\n> \r\n${appRows(1000)}`);
        const half = countedSave();
        await receiveOutput(appRows(1000));
        const buffer = terminal.buffer.active;
        const cells = buffer.length * terminal.cols;
        const work = countedSave();

        assert.ok(savedLines(saves.at(-1)).includes(top), 'the app\'s output is kept');
        assert.ok(work.reads < 50 * buffer.length, `${work.reads} row reads for ${buffer.length} rows`);
        assert.ok(work.comparisons > 0, 'the commands are compared');
        assert.ok(work.compared < 20 * work.comparisons, `${work.compared} characters compared in ${work.comparisons} comparisons`);
        assert.ok(work.slices < 10 * work.comparisons, `${work.slices} slices for ${work.comparisons} comparisons`);
        assert.ok(work.sliced < 10 * cells, `${work.sliced} characters sliced from for ${cells} cells`);
        assert.ok(work.joined < 10 * cells, `${work.joined} characters joined in ${work.joins} joins for ${cells} cells`);
        for (const [count, done] of Object.entries(work)) {
            assert.ok(done <= 3 * half[count], `${count}: ${done} for the whole line, ${half[count]} for half of it`);
        }
    });

    test('a save reads a long marked command\'s rows a few times in all and compares each command no further than the row where it differs', async () => {
        // The marked prompt's command wrapped onto 200 rows, under an app's line wrapped onto 2,000 rows, every other one
        // erased back to blank and the rest repeating the prompt's top line: each blank row starts a redrawn prompt's
        // command to compare with the marked one. Reading the marked command afresh for each would read ~200 rows each
        // time, and building the redrawn one's start as long as the marked one would slice ~200 rows each time;
        // counted, not timed. startsWith's characters count the marked command whole each time, so they are not
        // bounded here
        const saves = recordSavedSessions();
        const top = 'H'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\n${top}\r\n> ${'y'.repeat(80 * 200)}\r\n${`${'x'.repeat(80)}\x1b[1K${top}`.repeat(1000)}`);
        const buffer = terminal.buffer.active;
        const cells = buffer.length * terminal.cols;
        const work = countedSave();

        assert.ok(savedLines(saves.at(-1)).includes(top), 'the app\'s output is kept');
        assert.ok(work.reads < 50 * buffer.length, `${work.reads} row reads for ${buffer.length} rows`);
        assert.ok(work.comparisons > 0, 'the commands are compared');
        assert.ok(work.slices < 10 * work.comparisons, `${work.slices} slices for ${work.comparisons} comparisons`);
        assert.ok(work.sliced < 10 * cells, `${work.sliced} characters sliced from for ${cells} cells`);
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

    test('a saved session leaves out a Starship prompt redrawn below a completion listing with a long command erased back', async () => {
        // The redrawn command wraps onto more rows than a prompt reaches, and is shorter than the marked one: it need
        // only start like it
        const saves = recordSavedSessions();
        await receiveOutput(`\r\n\x1b[?2004h\r\n\x1b[1mdir\x1b[0m on main\r\n\u276f echo ${'y'.repeat(500)}\r\nf1  f2  f3\r\n\r\n`
            + `dir on main\r\n\u276f echo ${'y'.repeat(420)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['']);
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

    test('a saved session keeps a Starship prompt redrawn below a completion listing once the terminal\'s columns changed after Ctrl-A and Ctrl-E, as bash prints it', async () => {
        // Known limit: Ctrl-E's newline left the command's second row unmarked as wrapped, so the terminal rewraps the
        // command at 60 columns as two lines, its first row on two rows, and bash, drawing the command again, starts one
        // row lower than the command now does: the old command's first 60 columns stay on a row above it. That row is no
        // redrawn prompt's, so the save keeps the listing and the redrawn prompt, which the tab shows again above its new
        // prompt. Pinned so that changing it is deliberate
        const saved = await replayCapture('starshipCtrlEResized', 7, LISTINGS, { typeTabs: true });

        assert.deepEqual(saved.slice(2, 6), [2, 3, 4, 5].map(() => savedBeforeListing(saved)), 'up to Ctrl-E, it was left out');
        const [, top] = savedLines(savedBeforeListing(saved));
        const firstRow = `\u276f ls /tmp/e/${'a'.repeat(48)}`;
        assert.deepEqual(savedLines(saved[6]).slice(4), ['', top, '\u276f ls /tmp/e/',
            'alpha-a-rather-long-directory-name/ eta-a-rather-long-directory-name/',
            'beta-a-rather-long-directory-name/  gamma-a-rather-long-directory-name/',
            'delta-a-rather-long-directory-name/ theta-a-rather-long-directory-name/',
            'eps-a-rather-long-directory-name/   zeta-a-rather-long-directory-name/', '', top, firstRow, firstRow, '']);
    });

    test('a saved session keeps a plain prompt redrawn below a completion listing once a key was typed in the middle of its command after Ctrl-E, as bash prints it', async () => {
        // Known limit: ← went back across the wrap and X was typed there, in a row Ctrl-A had moved up over and Ctrl-E's
        // newline had unmarked as wrapped. readline draws the rest of the command again from X without moving up over
        // that row, so its record keeps the text it had, which the row no longer starts like, and the command no longer
        // runs on across it. The save keeps the listing and the redrawn prompt, which the tab shows again above its new
        // prompt, as before #64. Pinned so that changing it is deliberate
        const saved = await replayCapture('plainCtrlEEdited', 9, LISTINGS, { typeTabs: true });

        assert.deepEqual(saved.slice(2, 7), [2, 3, 4, 5, 6].map(() => savedBeforeListing(saved)), 'up to ← it was left out');
        const prompt = 'root@box:/app# ';
        assert.deepEqual(savedLines(saved[8]), [`${prompt}echo out`, 'out', `${prompt}ls /tmp/d/`, 'alpha/ beta/  delta/ gamma/',
            `${prompt}ls /tmp/d/${'a'.repeat(55)}`, 'a'.repeat(80), 'a'.repeat(80), 'a'.repeat(80), `${'a'.repeat(5)}X${'a'.repeat(74)}`, '']);
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing at 40 columns after Ctrl-E, erasing back and typing on', async () => {
        // Backspace erased the command back across its wrap (BS, then EL 0 at the cursor) before more was typed: a row
        // recorded when the cursor moved up over it keeps what the erase left of it
        const saved = await replayCapture('starshipNarrow', 6);
        const saves = recordSavedSessions();
        await receiveOutput('zz');

        assert.equal(saves.at(-1), savedBeforeListing(saved));
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

    // bash 5.2 below a listing (captured for issue #64): the command typed on until it wraps, then Ctrl-A and Ctrl-E. Where
    // it wraps, its row's last column is left blank, or the marked command filled its row
    for (const [prompt, name, sessions] of [['a Starship prompt', 'starship', ['WideCtrlE', 'SpaceCtrlE']],
        ['a plain prompt', 'plain', ['WideCtrlE', 'SpaceCtrlE', 'FilledCtrlE']]]) {
        for (const [session, shape] of [['WideCtrlE', 'a wide character that did not fit the row\'s last column'],
            ['SpaceCtrlE', 'a space in the row\'s last column'], ['FilledCtrlE', 'a command whose marked one filled its row']]
            .filter(([session]) => sessions.includes(session))) {
            test(`a saved session leaves out ${prompt} redrawn below a completion listing once the cursor moved down across ${shape}, as bash prints it`, async () => {
                const saved = await replayCapture(`${name}${session}`, 6);

                assert.deepEqual(savedLines(savedBeforeListing(saved)).slice(-3),
                    [name === 'plain' ? 'root@box:/app# echo out' : '\u276f echo out', 'out', '']);
                assert.deepEqual(saved.slice(3), [3, 4, 5].map(() => savedBeforeListing(saved)),
                    'typed on until it wraps, after Ctrl-A and after Ctrl-E');
            });
        }
    }

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command whose marked one filled its row, once typed on, as bash prints it', async () => {
        // bash takes the cursor past a command that fills its row by writing a space at the start of the next row, which
        // the terminal wraps onto. The marked command keeps that space; typed on at the redrawn prompt, the command's
        // next character replaces it. Below the Tab, the marked command is read without the blank rows it ends with
        const saved = await replayCapture('starshipFilledCtrlE', 6, LISTINGS, { typeTabs: true });

        assert.deepEqual(savedLines(savedBeforeListing(saved)).slice(-3), ['\u276f echo out', 'out', '']);
        assert.deepEqual(saved.slice(2), [2, 3, 4, 5].map(() => savedBeforeListing(saved)),
            'listed, typed on, after Ctrl-A and after Ctrl-E');
    });

    test('a saved session leaves out a Starship prompt redrawn below a completion listing for a command whose marked one filled its row, typed on past four rows, as bash prints it', async () => {
        // The redrawn prompt's top line is above the cursor's rows: it is found under the blank row
        const saved = await replayCapture('starshipFilledCtrlE', 3, LISTINGS, { typeTabs: true });
        const saves = recordSavedSessions();
        await receiveOutput('a'.repeat(300));

        assert.equal(saves.at(-1), savedBeforeListing(saved));
    });

    // bash 5.2's plain prompt below a listing four rows tall, for a command that filled its row (built from the captured
    // plainFilledCtrlE, whose listing is one row tall), with Tab typed where bash rang the bell
    const FILLED_PROMPT = 'root@box:/app# ';
    const FILLED_LS = `ls /tmp/${'x'.repeat(56)}/`;
    async function plainFilledListing(saves, typed) {
        await receiveOutput(`\x1b[?2004h${FILLED_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${FILLED_PROMPT}${FILLED_LS} \r`);
        const atPrompt = saves.at(-1);
        terminal.input('\t');
        await receiveOutput(`\x07\r\nl1/\r\nl2/\r\nl3/\r\nl4/\r\n${FILLED_PROMPT}${FILLED_LS} \r${typed}`);
        return atPrompt;
    }

    for (const [length, where] of [[20, 'within the cursor\'s rows'], [400, 'typed on past four rows']]) {
        test(`a saved session leaves out a plain prompt redrawn below a tall completion listing for a command whose marked one filled its row, ${where}`, async () => {
            const saves = recordSavedSessions();
            const atPrompt = await plainFilledListing(saves, 'a'.repeat(length));

            assert.deepEqual(savedLines(atPrompt), [`${FILLED_PROMPT}echo out`, 'out', '']);
            assert.equal(saves.at(-1), atPrompt);
        });
    }

    // An app's input line that fills its row and runs on with blanks onto the next, drawn again with text there
    const paddedInput = `> ${'x'.repeat(78)}${' '.repeat(10)}`;
    for (const [shape, before, redraw, kept] of [
        ['starts with a blank row and draws it, its first line and', `\r\nTitle\r\n${paddedInput}\r\nr1\r\nr2\r\nr3\r\n`,
            `\r\nTitle\r\n> ${'x'.repeat(78)}${'z'.repeat(90)}`, ['', 'Title', `> ${'x'.repeat(78)}`, 'r1', 'r2', 'r3', '', 'Title']],
        ['draws its first line and', `Title\r\n${paddedInput}\r\nr1\r\nr2\r\nr3\r\n`, `Title\r\n> ${'x'.repeat(78)}zzz`,
            ['Title', `> ${'x'.repeat(78)}`, 'r1', 'r2', 'r3', 'Title']],
    ]) {
        test(`a saved session keeps the output of an app that ${shape} an input line again, where it first ran on with blanks past its row`, async () => {
            // With no Tab, the marked command is read whole, the blanks too
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${before}${redraw}`);

            assert.deepEqual(savedLines(saves.at(-1)).slice(0, kept.length + 1), ['$ app', ...kept]);
        });

        test(`a saved session leaves out the output of an app that ${shape} an input line again, where it first ran on with blanks past its row, with Tab typed above its redraw`, async () => {
            // Known limit: below a Tab, the input line the app first drew is read without the blank row it ends with, as a
            // marked command that filled its row is, so the redrawn one reads as typed on from it. Pinned so that changing
            // it is deliberate
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${before}`);
            terminal.input('\t');
            await receiveOutput(redraw);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
        });
    }

    test('a saved session keeps the output of an app that starts with a blank row and draws an input line again, where it first ran on with blanks past its row, with Tab typed below that line', async () => {
        // The Tab lies below the cursor's line, typed on the app's status row before it moved the cursor back up, so the
        // input line the app first drew is read whole
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n${paddedInput}\r\nr1\r\nr2\r\nr3\r\n\r\nTitle\r\n> ${'x'.repeat(78)}${'z'.repeat(90)}\r\nstatus`);
        terminal.input('\t');
        await receiveOutput(`\x1b[A\r\x1b[10C`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 4), ['$ app', '', 'Title', `> ${'x'.repeat(78)}`]);
    });

    for (const [shape, marked, redrawn] of [
        ['without the space its first one ended with on its own row', '> ', `>${'x'.repeat(150)}`],
        ['without a row of blanks inside its first one', `> ${'x'.repeat(78)}${' '.repeat(80)}yyy`, `> ${'x'.repeat(78)}yyy${'z'.repeat(80)}`],
    ]) {
        test(`a saved session keeps the output of an app that starts with a blank row and draws its input line again ${shape}, with Tab typed above its redraw`, async () => {
            // Only the blank rows a marked command ends with on rows it wraps onto are left out of it
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n${marked}\r\nr1\r\nr2\r\nr3\r\n`);
            terminal.input('\t');
            await receiveOutput(`\r\nTitle\r\n${redrawn}`);

            assert.deepEqual(savedLines(saves.at(-1)).slice(0, 4), ['$ app', '', 'Title', marked.trimEnd()]);
        });
    }

    test('a saved session leaves out a Starship prompt redrawn below a completion listing once the cursor moved down across a wide character that did not fit, the last column left empty', async () => {
        // Nothing was written in the row's last column: the wide character that starts the next row counts as reaching it
        const saves = recordSavedSessions();
        await receiveOutput(`${starshipCompletion('ls /tmp/d/')}${'a'.repeat(67)}日bb`);
        await receiveOutput(ctrlA(1, 2));
        await receiveOutput(ctrlE(1, 4));

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

    // A prompt of three lines and its command, with no blank first row
    const THREE_LINE_PROMPT = 'context\r\nuser@box\r\n/app\r\n$ ';

    test('a saved session leaves out a three-line prompt with no blank first row redrawn below a completion listing once the cursor moved down across the command\'s wrap', async () => {
        // Tab was typed at the prompt above the listing, so the redrawn one is looked for higher than the cursor's rows
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}ls /tmp/d/`);
        terminal.input('\t');
        await receiveOutput(`\x07\r\n${COMPLETIONS}${THREE_LINE_PROMPT}ls /tmp/d/${'a'.repeat(70)}`);
        await receiveOutput(ctrlA(1, 2));
        await receiveOutput(ctrlE(1, 2));

        assert.deepEqual(savedLines(saves.at(-1)), ['context', 'user@box', '/app', '$ echo out', 'out', '']);
    });

    test('a saved session keeps a three-line prompt with no blank first row redrawn below a completion listing asked for with no Tab', async () => {
        // Known limit: a listing asked for by another key (M-?, M-=, C-x /) leaves no Tab above it, and the redrawn
        // prompt is then looked for higher than the cursor's rows only under a blank row like Starship's, as an app's
        // rows would pass for a prompt's. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}ls /tmp/d/\r\n${COMPLETIONS}${THREE_LINE_PROMPT}ls /tmp/d/${'a'.repeat(70)}`);
        await receiveOutput(ctrlA(1, 2));
        await receiveOutput(ctrlE(1, 2));

        assert.deepEqual(savedLines(saves.at(-1)), ['context', 'user@box', '/app', '$ echo out', 'out', 'context', 'user@box',
            '/app', `$ ls /tmp/d/`, COMPLETIONS.trimEnd(), 'context', 'user@box', '/app', `$ ls /tmp/d/${'a'.repeat(68)}`, '']);
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing once the cursor moved down across the command\'s wrap', async () => {
        // readline moves the cursor down a wrapped command with a newline, which leaves the row it moves to unmarked as
        // a wrapped one; Ctrl-A moved the cursor up over that row first, which the terminal recorded
        const saved = await replayCapture('plainCtrlE', 6);

        assert.deepEqual(savedLines(savedBeforeListing(saved)), ['root@box:/app# echo out', 'out', '']);
        assert.deepEqual(saved.slice(3), [3, 4, 5].map(() => savedBeforeListing(saved)),
            'typed until it wraps, after Ctrl-A and after Ctrl-E');
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing with a command more than four rows long', async () => {
        // Tab was typed at the prompt above the listing, so the redrawn one is looked for higher than the cursor's rows
        const saved = await replayCapture('plainSixRows', 4, LISTINGS, { typeTabs: true });

        assert.deepEqual(savedLines(savedBeforeListing(saved)), ['root@box:/app# echo out', 'out', '']);
        assert.deepEqual(saved.slice(2), [2, 3].map(() => savedBeforeListing(saved)));
    });

    test('a saved session keeps a plain prompt redrawn below a completion listing asked for with no Tab, with a command more than four rows long', async () => {
        // Known limit: with no Tab above the listing (M-?, M-=, C-x /), the redrawn prompt is looked for no higher than
        // four rows up, and a one-row prompt has no row above its command to anchor a longer one on. Pinned so that
        // changing it is deliberate
        const saved = await replayCapture('plainSixRows', 4);

        const prompt = 'root@box:/app# ';
        assert.deepEqual(savedLines(saved.at(-1)), [`${prompt}echo out`, 'out', `${prompt}ls /tmp/d/`,
            'alpha/ beta/  delta/ gamma/', `${prompt}ls /tmp/d/${'a'.repeat(55 + 4 * 80)}`, '']);
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing with a long command when Tab was last typed on its command below its first row', async () => {
        // The last Tab, typed at the redrawn prompt this time, lies on the redrawn command's rows
        const saved = await replayCapture('plainSixRows', 3, LISTINGS, { typeTabs: true });
        const { output } = LISTINGS.plainSixRows.steps[3];
        await receiveOutput(output.slice(0, 200));
        terminal.input('\t');
        await receiveOutput(`\x07${output.slice(200)}`);
        const saves = recordSavedSessions();
        manager.saveSessionState();

        assert.deepEqual(savedLines(saved[2]), ['root@box:/app# echo out', 'out', '']);
        assert.equal(saves.at(-1), savedBeforeListing(saved));
    });

    test('a saved session keeps a three-line prompt redrawn below a completion listing when Tab was last typed below its command\'s last row', async () => {
        // The command, typed on to four rows, had Tab typed at its end and was then erased back to two rows (readline's
        // newlines down and EL on each row below): a redrawn prompt is looked for higher than the cursor's rows only
        // where the last Tab lies on or above the cursor's line. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}ls /tmp/d/`);
        terminal.input('\t');
        await receiveOutput(`\x07\r\n${COMPLETIONS}${THREE_LINE_PROMPT}ls /tmp/d/${'a'.repeat(300)}`);
        terminal.input('\t');
        await receiveOutput(`\x07\x1b[2A\r\x1b[30C\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[2A\r\x1b[30C`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 10), ['context', 'user@box', '/app', '$ echo out', 'out', 'context', 'user@box',
            '/app', '$ ls /tmp/d/', COMPLETIONS.trimEnd()]);
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing with a long command when keys other than Tab were typed below', async () => {
        // Every key typed reaches the page; only a Tab moves the row the reach starts below
        const saved = await replayCapture('plainSixRows', 4, LISTINGS, { typeTabs: true });
        terminal.input('a');
        terminal.input('\x1b[D');
        const saves = recordSavedSessions();
        manager.saveSessionState();

        assert.deepEqual(savedLines(savedBeforeListing(saved)), ['root@box:/app# echo out', 'out', '']);
        assert.equal(saves.at(-1), savedBeforeListing(saved));
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing with a long command when Tab was last typed on its first row', async () => {
        // A Tab typed at the redrawn prompt while its command is still on the prompt's row (a completion with no listing)
        // lies on the redrawn command's rows
        const saved = await replayCapture('plainSixRows', 3, LISTINGS, { typeTabs: true });
        terminal.input('\t');
        await receiveOutput('\x07');
        await receiveOutput(LISTINGS.plainSixRows.steps[3].output);
        const saves = recordSavedSessions();
        manager.saveSessionState();

        assert.deepEqual(savedLines(saved[2]), ['root@box:/app# echo out', 'out', '']);
        assert.equal(saves.at(-1), savedBeforeListing(saved));
    });

    test('a saved session keeps a plain prompt redrawn below a completion listing with a long command when Tab was typed only at the prompt before', async () => {
        // A new prompt lets go of the Tab typed at the one before
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out`);
        terminal.input('\t');
        await receiveOutput(`\x07\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}ls /tmp/d/\r\nalpha/ beta/  delta/ gamma/\r\n`
            + `${ROOT_PROMPT}ls /tmp/d/${'a'.repeat(390)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(2, 4), [`${ROOT_PROMPT}ls /tmp/d/`, 'alpha/ beta/  delta/ gamma/']);
    });

    test('a saved session keeps a long command that starts like the prompt\'s on the row after it, when the prompt\'s own rows would hold the redrawn one\'s top', async () => {
        // A two-line prompt and its command wrapped onto five rows, the last holding the prompt's first line again; then
        // that command again, typed on. After a Tab, the redrawn prompt's top would be the marked command's last row:
        // it is looked for only below the marked command
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004hP\r\n$ ');
        terminal.input('\t');
        const command = `${'y'.repeat(318)}P`;
        await receiveOutput(`${command}\r\n$ ${command}${'z'.repeat(100)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['P', `$ ${command}`, `$ ${command}${'z'.repeat(100)}`.slice(0, 5 * 80), '']);
    });

    test('a saved session leaves out the output of an app that keeps bracketed paste on, when Tab was typed in it and it draws its first two lines again, the second running on for five rows', async () => {
        // Known limit: after a Tab, the app's first lines drawn again over a line the terminal wraps past four rows read
        // as a prompt redrawn below a listing and typed on, so the save stops above the app's output. With no Tab the
        // app's output is kept (see above). Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hA\r\nB\r\n');
        terminal.input('\t');
        await receiveOutput(`C\r\nA\r\nB${'x'.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    test('a saved session leaves out the output of an app that keeps bracketed paste on, when it draws its first two lines again, the second running on for five rows, and Tab is typed on that line', async () => {
        // Known limit: the same as above, with the Tab typed on the app's last line. Pinned so that changing it is
        // deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004hA\r\nB\r\nC\r\nA\r\nB${'x'.repeat(400)}`);
        terminal.input('\t');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    // An app that keeps bracketed paste on, after a Tab typed in it, draws lines that do not repeat its first ones as a
    // prompt's would, above a line the terminal wraps past four rows
    for (const [shape, before, after, kept] of [
        ['draws a different line between its first two lines and the second one again', 'A\r\nB\r\n', `C\r\nX\r\nB${'x'.repeat(400)}`,
            ['A', 'B', 'C', 'X', `B${'x'.repeat(400)}`.slice(0, 5 * 80)]],
        ['draws its first five lines again, four above the last', 'A\r\nB\r\nC\r\nD\r\nE\r\n', `out\r\nA\r\nB\r\nC\r\nD\r\nE${'x'.repeat(400)}`,
            ['A', 'B', 'C', 'D', 'E', 'out', 'A', 'B', 'C', 'D', `E${'x'.repeat(400)}`.slice(0, 5 * 80)]],
    ]) {
        test(`a saved session keeps the output of an app that keeps bracketed paste on, when Tab was typed in it and it ${shape}`, async () => {
            // A redrawn prompt repeats the marked one row for row, with up to three rows above its command
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${before}`);
            terminal.input('\t');
            await receiveOutput(after);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...kept, '']);
        });
    }

    test('a saved session keeps the output of an app that keeps bracketed paste on, when a paste holding a tab was typed in it and it draws its first two lines again', async () => {
        // Only a Tab key, sent alone, marks the row: a paste with a tab in it is no Tab
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hA\r\nB\r\n');
        terminal.input('\x1b[200~a\tb\x1b[201~');
        await receiveOutput(`C\r\nA\r\nB${'x'.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'A', 'B', 'C', 'A', `B${'x'.repeat(400)}`.slice(0, 5 * 80), '']);
    });

    test('a saved session keeps the output of an app that keeps bracketed paste on, when the row Tab was typed on was erased and it draws its first two lines again', async () => {
        // ED 0 erased the row with its marker: no Tab is left to reach from
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\n\x1b[?2004hA\r\nB\r\nC\r\nD\r\nE\r\n');
        terminal.input('\t');
        await receiveOutput(`\x1b[3A\r\x1b[JA\r\nB${'x'.repeat(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'A', 'B', 'A', `B${'x'.repeat(400)}`.slice(0, 5 * 80), '']);
    });

    // The markers of the screen in use: the prompt's mark is in the normal one
    for (const [where, output, markers] of [['while a command runs', '\x1b[?2004h$ sleep 9\r\n\x1b[?2004l\r', 1],
        ['in an editor\'s screen', '\x1b[?2004h$ vim\r\n\x1b[?2004l\r\x1b[?1049h\x1b[?2004h', 0]]) {
        test(`a Tab typed ${where} leaves no marker`, async () => {
            recordSavedSessions();
            await receiveOutput(output);
            terminal.input('\t');

            assert.equal(terminal.markers.length, markers);
        });
    }

    test('a saved session leaves out a plain prompt redrawn below a completion listing with a long command when Tab was last typed at its end', async () => {
        // The last Tab lies on the command's last row, and stays on its line once Ctrl-A takes the cursor up to its first
        const saved = await replayCapture('plainSixRows', 4, LISTINGS, { typeTabs: true });
        terminal.input('\t');
        await receiveOutput('\x07');
        const saves = recordSavedSessions();
        manager.saveSessionState();
        const atEnd = saves.at(-1);
        await receiveOutput(ctrlA(5, 15));

        assert.equal(atEnd, savedBeforeListing(saved), 'Tab typed at the end');
        assert.equal(saves.at(-1), savedBeforeListing(saved), 'after Ctrl-A');
    });

    test('a saved session leaves out a three-line prompt redrawn below a completion listing when Tab was last typed at the end of its command and the cursor moved up it', async () => {
        // The Tab lies on the command's last row, below the cursor's: the cursor's line is followed down to its end
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}ls /tmp/d/\x07\r\n${COMPLETIONS}${THREE_LINE_PROMPT}ls /tmp/d/${'a'.repeat(300)}`);
        terminal.input('\t');
        await receiveOutput('\x07\x1b[2A');

        assert.deepEqual(savedLines(saves.at(-1)), ['context', 'user@box', '/app', '$ echo out', 'out', '']);
    });

    test('a saved session leaves out a three-line prompt redrawn below a completion listing when Tab was typed at its end, then Ctrl-A, Ctrl-E and ← back across the wrap', async () => {
        // The Tab lies on the command's last row, below the cursor's, which the newlines unmarked: the cursor's line is
        // followed down to its end across the rows the cursor moved up over
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}ls /tmp/d/\x07\r\n${COMPLETIONS}${THREE_LINE_PROMPT}ls /tmp/d/${'a'.repeat(300)}`);
        terminal.input('\t');
        await receiveOutput(`\x07${ctrlA(3, 2)}`);
        await receiveOutput(ctrlE(3, 72));
        await receiveOutput('\r\x1b[A\x1b[79C');

        assert.deepEqual(savedLines(saves.at(-1)), ['context', 'user@box', '/app', '$ echo out', 'out', '']);
    });

    test('a saved session keeps a long command that starts like the prompt\'s on the row after it, when Ctrl-A and Ctrl-E moved over the prompt\'s own command before the Tab', async () => {
        // The marked command's rows count as wrapped across the rows the cursor moved up over, so the redrawn prompt's
        // top would still lie on its last row
        const saves = recordSavedSessions();
        await receiveOutput('\x1b[?2004hP\r\n$ ');
        const command = `${'y'.repeat(318)}P`;
        await receiveOutput(`${command}${ctrlA(4, 2)}${ctrlE(4, 1)}`);
        terminal.input('\t');
        await receiveOutput(`\r\n$ ${command}${'z'.repeat(100)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['P', `$ ${'y'.repeat(78)}`, 'y'.repeat(80), 'y'.repeat(80), 'y'.repeat(80), 'P',
            `$ ${command}${'z'.repeat(100)}`.slice(0, 5 * 80), '']);
    });

    test('a saved session leaves out a plain prompt redrawn below a completion listing with a long command erased back to fewer rows than the marked one', async () => {
        // The marked command, six rows long, had Tab typed at its end; the redrawn one is erased back to five rows, and
        // starts more than three rows above the cursor's: the marked command need only start like it
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        const atPrompt = saves.at(-1);
        const command = `ls /tmp/d/${'a'.repeat(400)}`;
        await receiveOutput(command);
        terminal.input('\t');
        await receiveOutput(`\x07\r\nalpha/ beta/  delta/ gamma/\r\n${ROOT_PROMPT}${command}\x1b[A\r\x1b[5C\x1b[J`);

        assert.equal(saves.at(-1), atPrompt);
    });

    test('a saved session leaves out a three-line prompt redrawn below a completion listing when keys other than Tab were typed below its command\'s last row', async () => {
        // Only a Tab moves the row the reach depends on: here the one typed at the marked prompt, above the listing
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n`);
        await receiveOutput(`\x1b[?2004h${THREE_LINE_PROMPT}ls /tmp/d/`);
        terminal.input('\t');
        await receiveOutput(`\x07\r\n${COMPLETIONS}${THREE_LINE_PROMPT}ls /tmp/d/${'a'.repeat(300)}`);
        terminal.input('\x7f');
        await receiveOutput(`\x1b[2A\r\x1b[30C\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[2A\r\x1b[30C`);

        assert.deepEqual(savedLines(saves.at(-1)), ['context', 'user@box', '/app', '$ echo out', 'out', '']);
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

    // zsh turns bracketed paste on after its prompt, and bash after output with no final newline, so the mark goes on
    // the row below the cursor and a command typed at the prompt runs on onto it from the row above
    for (const [rows, length] of [[2, 70], [6, 400], [8, 560]]) {
        test(`a saved session leaves out a zsh prompt with a half-typed command ${rows} rows long`, async () => {
            const saves = recordSavedSessions();
            await receiveOutput(`${zshPrompt('host% ')}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
            await receiveOutput(`${zshPrompt('host% ')}${zshTyped('host% ', typedCommand(length))}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', '']);
        });

        test(`a saved session leaves out a plain prompt printed after output with no final newline, with a half-typed command ${rows} rows long`, async () => {
            // A save cuts whole rows, so the output goes with the prompt printed on its row, as with a short command
            const saves = recordSavedSessions();
            const prompt = '\x1b[?2004hroot@box:/app# ';
            await receiveOutput(`${prompt}printf hello\r\n\x1b[?2004l\rhello${prompt}${typedCommand(length - 10)}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['root@box:/app# printf hello', '']);
        });
    }

    for (const [shape, typed] of [['', ''], [', with a command typed', 'echo hi']]) {
        test(`a saved session keeps output that filled its row with no final newline above a plain prompt${shape}`, async () => {
            // The wrap is still pending when bash turns bracketed paste on, so the prompt starts the row below, which
            // is marked: the output's row holds no prompt
            const saves = recordSavedSessions();
            const prompt = '\x1b[?2004hroot@box:/app# ';
            await receiveOutput(`${prompt}printf '%080d' 0\r\n\x1b[?2004l\r${'0'.repeat(80)}${prompt}${typed}`);

            assert.deepEqual(savedLines(saves.at(-1)), ["root@box:/app# printf '%080d' 0", '0'.repeat(80), '']);
        });
    }

    for (const [rows, length] of [[2, 71], [6, 400]]) {
        test(`a saved session leaves out a plain prompt printed after output that wrapped with no final newline, with a half-typed command ${rows} rows long`, async () => {
            // The command runs on from the output's first row, above the row the prompt is printed on, which goes with
            // the prompt, as a save cuts whole rows
            const saves = recordSavedSessions();
            const prompt = '\x1b[?2004hroot@box:/app# ';
            await receiveOutput(`${prompt}printf '%0120d' 0\r\n\x1b[?2004l\r${'0'.repeat(120)}${prompt}${typedCommand(length)}`);

            assert.deepEqual(savedLines(saves.at(-1)), ["root@box:/app# printf '%0120d' 0", '0'.repeat(80), '']);
        });
    }

    test('a saved session keeps the first row of a progress line that wrapped, when bash prints its prompt over the start of the row the line wrapped onto', async () => {
        // The progress line goes back to the start of its row with no final newline, so the mark is at the cursor's
        // row, not below it: the line running on onto it from the row above is output, not the prompt's
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004hroot@box:/app# ';
        await receiveOutput(`${prompt}make\r\n\x1b[?2004l\r${'#'.repeat(100)}\r${prompt}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['root@box:/app# make', '#'.repeat(80), '']);
    });

    test('a saved session keeps output with no final newline above a one-line prompt after a blank row', async () => {
        // The prompt's newline ends the output's row, and the cursor's line starts on the marked row
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004h\r\n$ ';
        await receiveOutput(`${prompt}printf hello\r\n\x1b[?2004l\rhello${prompt}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['', '$ printf hello', 'hello', '']);
    });

    test('a saved session leaves out the rows from the cursor\'s down when an app moved it up above the row it turned bracketed paste on in, away from the start of the row', async () => {
        // The prompt starts no lower than the cursor's row, as before
        const saves = recordSavedSessions();
        await receiveOutput('$ app\r\nline 1\r\nline 2\r\nstatus\x1b[?2004h\x1b[2A');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    for (const [rows, length] of [['its first row', 69], ['two rows', 149]]) {
        test(`a saved session leaves out a zsh prompt with a half-typed command that fills ${rows} to the last column`, async () => {
            // The cursor is on the blank row below, the marked one
            const saves = recordSavedSessions();
            await receiveOutput(`${zshPrompt('host% ')}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
            await receiveOutput(`${zshPrompt('host% ')}${zshTyped('host% ', typedCommand(length))}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', '']);
        });
    }

    test('a saved session leaves out a plain prompt printed after output that filled its row with no final newline, with a long half-typed command', async () => {
        // The prompt starts on the marked row, the terminal having wrapped it there from the output's
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004hroot@box:/app# ';
        await receiveOutput(`${prompt}printf '%080d' 0\r\n\x1b[?2004l\r${'0'.repeat(80)}${prompt}${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ["root@box:/app# printf '%080d' 0", '0'.repeat(80), '']);
    });

    test('a saved session leaves out a plain prompt printed after output that filled its row with no final newline, with a long half-typed command after Ctrl-A and Ctrl-E', async () => {
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004hroot@box:/app# ';
        await receiveOutput(`${prompt}printf '%080d' 0\r\n\x1b[?2004l\r${'0'.repeat(80)}${prompt}${typedCommand(400)}`);
        await receiveOutput(`${'\x1b[A'.repeat(5)}${'\b'.repeat(5)}`);
        await receiveOutput(ctrlE(5, 20));

        assert.deepEqual(savedLines(saves.at(-1)), ["root@box:/app# printf '%080d' 0", '0'.repeat(80), '']);
    });

    test('a saved session leaves out a plain prompt printed after output that filled its row with no final newline, with a long half-typed command at the bottom of the screen', async () => {
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004hroot@box:/app# ';
        await receiveOutput(`${SCREENFULS}${prompt}printf '%080d' 0\r\n\x1b[?2004l\r${'0'.repeat(80)}${prompt}${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-3), ["root@box:/app# printf '%080d' 0", '0'.repeat(80), '']);
    });

    for (const [where, before] of [['', ''], [' at the bottom of the screen', SCREENFULS]]) {
        test(`a saved session leaves out a Starship prompt after output that filled its row with no final newline, with a long half-typed command${where}`, async () => {
            // The output's row takes the place of the prompt's blank first row, as after other output with no final
            // newline
            const saves = recordSavedSessions();
            await receiveOutput(`${before}${STARSHIP_PROMPT}printf '%080d' 0\r\n\x1b[?2004l\r${'0'.repeat(80)}`);
            await receiveOutput(`${STARSHIP_PROMPT}${typedCommand(400)}`);

            assert.deepEqual(savedLines(saves.at(-1)).slice(-4), [plain(STARSHIP_TOP_LINE), "❯ printf '%080d' 0", '0'.repeat(80), '']);
        });
    }

    test('a saved session leaves out a notice line under a zsh prompt, with a pasted command under it', async () => {
        // Known limit: the notice lands on the marked row, the row below the prompt's, and reads as the top line of a
        // prompt like Starship's, so the save stops at it and keeps the prompt's row. Before, the save kept the notice
        // and the command's rows above the cursor's. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`${zshPrompt('host% ')}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
        await receiveOutput(`${zshPrompt('host% ')}\r\nnotice\r\n\x1b[7m${typedCommand(400)}\x1b[27m\x1b[K`);

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', 'host%', '']);
    });

    test('a saved session leaves out a zsh prompt with a pasted command six rows long', async () => {
        // zsh draws pasted text straight on, in reverse video, and the terminal wraps it
        const saves = recordSavedSessions();
        await receiveOutput(`${zshPrompt('host% ')}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
        await receiveOutput(`${zshPrompt('host% ')}\x1b[7m${typedCommand(400)}\x1b[27m\x1b[K`);

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', '']);
    });

    test('a saved session leaves out a zsh prompt with a half-typed command six rows long after Ctrl-A and Ctrl-E', async () => {
        // zsh moves the cursor up the command with CSI A and back down with CSI B
        const saves = recordSavedSessions();
        await receiveOutput(`${zshPrompt('host% ')}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
        await receiveOutput(`${zshPrompt('host% ')}${zshTyped('host% ', typedCommand(400))}`);
        await receiveOutput(`\x1b[5A${'\b'.repeat(5)}`);
        await receiveOutput('\x1b[5B\x1b[5C');

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', '']);
    });

    test('a saved session leaves out a zsh prompt with a half-typed command six rows long after ← back across the wrap and Backspace', async () => {
        // zsh moves the cursor up across the wrap with CSI A and CSI C, and for each Backspace blanks the cell the
        // command now ends before on the row below, moving down to it and back up
        const saves = recordSavedSessions();
        await receiveOutput(`${zshPrompt('host% ')}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
        await receiveOutput(`${zshPrompt('host% ')}${zshTyped('host% ', typedCommand(400))}`);
        await receiveOutput(`${'\b'.repeat(10)}\r\x1b[A\x1b[79C${'\b'.repeat(8)}`);
        await receiveOutput('\x1b[1B\x1b[61D \x1b[A\x1b[59C'.repeat(5));

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', '']);
    });

    test('a saved session leaves out a zsh prompt with a half-typed command at 40 columns', async () => {
        const saves = recordSavedSessions();
        terminal.resize(40, terminal.rows);
        const prompt = `${ZSH_PROMPT_SP.replace(' '.repeat(79), ' '.repeat(39))}host% \x1b[K\x1b[?2004h`;
        await receiveOutput(`${prompt}p\bprint out\x1b[?2004l\r\r\nout\r\n`);
        await receiveOutput(`${prompt}${zshTyped('host% ', typedCommand(400), 40)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['host% print out', 'out', '']);
    });

    for (const length of [320, 600]) {
        test(`a saved session leaves out a Starship prompt after output with no final newline, with a half-typed command of ${length} characters`, async () => {
            // The output's row takes the place of the prompt's blank first row, as the mark goes on the row below it
            const saves = recordSavedSessions();
            await receiveOutput(`${STARSHIP_PROMPT}printf hello\r\n\x1b[?2004l\rhello`);
            await receiveOutput(`${STARSHIP_PROMPT}${typedCommand(length)}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['', plain(STARSHIP_TOP_LINE), '❯ printf hello', 'hello', '']);
        });
    }

    test('a saved session leaves out a Starship prompt after output with no final newline, with a long half-typed command at the bottom of the screen', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`${SCREENFULS}${STARSHIP_PROMPT}printf hello\r\n\x1b[?2004l\rhello`);
        await receiveOutput(`${STARSHIP_PROMPT}${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)).slice(-6), ['line 39', '', plain(STARSHIP_TOP_LINE), '❯ printf hello', 'hello', '']);
    });

    test('a saved session leaves out a Starship prompt after output with no final newline, with a long half-typed command at 40 columns', async () => {
        const saves = recordSavedSessions();
        terminal.resize(40, terminal.rows);
        const [{ output: prompt }] = LISTINGS.starshipNarrow.steps;
        await receiveOutput(`${prompt}printf hello\r\n\x1b[?2004l\rhello${prompt}`);
        const savedAtPrompt = saves.at(-1);
        await receiveOutput(typedCommand(200));

        assert.deepEqual(savedLines(savedAtPrompt).slice(-3), ['❯ printf hello', 'hello', '']);
        assert.equal(saves.at(-1), savedAtPrompt);
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

    test('a saved session leaves out a background job\'s text printed with no final newline at a one-line prompt, with a long command typed on after it', async () => {
        // Known limit: the job's text and the command run on as one line from the prompt's row, which reads as a command
        // typed at the prompt, so the save stops above the prompt. With a command short enough to stay within four rows
        // of the marked one, the save leaves the job's text out too. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`kept\r\n\x1b[?2004hroot@box:/app# job done${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['kept', '']);
    });

    test('a saved session leaves out a job\'s line under a blank row marked after output with no final newline, with a long command typed under it', async () => {
        // Known limit: output with no final newline puts the mark on the row below, which can be blank like the first
        // row of Starship's prompt, so the job's line reads as that prompt's top line and the command as its own.
        // Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`kept\r\nout\x1b[?2004h$ \r\n\r\njob done\r\n${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['kept', 'out$', '']);
    });

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

    test('a saved session keeps only the first row of an app\'s line that wrapped before it turned bracketed paste on partway through a row and ran on past four rows', async () => {
        // Known limit: the mark goes on the row below, and the line runs on onto it from higher up, as a command typed
        // after a plain prompt printed after output that wrapped with no final newline does, so the save stops above
        // the row the app turned the mode on in. Before, the save kept the line up to the cursor's row: 720 characters,
        // 9 of its 10 rows. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n${'x'.repeat(130)}\x1b[?2004h${'x'.repeat(600)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'x'.repeat(80), '']);
    });

    test('a saved session leaves out the output of an app that turned bracketed paste on partway through the first row of a line it ran on past four rows', async () => {
        // Known limit: the mark goes on the row below, and the line runs on onto it from the row above, as a command
        // typed at a zsh prompt does, so the save stops above the app's line. Before, the save kept the line up to the
        // cursor's row: 640 characters, 8 of its 9 rows. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n${'x'.repeat(50)}\x1b[?2004h${'x'.repeat(600)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    test('a saved session leaves out the output of an app that turned bracketed paste on partway through the first row of a line it ran on onto one more row', async () => {
        // Known limit: the same as above, however few rows the line runs onto. Before, the save kept the line's first
        // row. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n${'x'.repeat(50)}\x1b[?2004h${'x'.repeat(60)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    test('a saved session leaves out the output of an app that turned bracketed paste on partway through a row, then printed lines filling their rows', async () => {
        // Known limit: zsh draws a command past the margin itself, so a row below the marked one counts as run onto
        // when the row above reaches its last column, and lines that fill their rows, each ending with a newline, read
        // as such a command. The save stops above the row the app turned the mode on in, which it kept before.
        // Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n${'x'.repeat(50)}\x1b[?2004h${'x'.repeat(30)}\r\n${`${'y'.repeat(80)}\r\n`.repeat(3)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '']);
    });

    test('a saved session leaves out the output of an app that turned bracketed paste on with the wrap still pending, then ran a line on onto the next row past four rows', async () => {
        // Known limit: the line starts on the marked row, which the terminal wrapped it onto, as a prompt printed after
        // output that filled its row does, so the save stops at the marked row. Before, the save kept the line's rows
        // above the cursor's. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n${'y'.repeat(80)}\x1b[?2004h${'x'.repeat(450)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'y'.repeat(80), '']);
    });

    test('a saved session keeps the output of an app that turned bracketed paste on away from the start of a row, then printed lines filling their rows', async () => {
        // The lines start below the marked row, and each ends with a newline, so they run on from no prompt there
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\nout\x1b[?2004h\r\n${`${'y'.repeat(80)}\r\n`.repeat(6)}> type`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'out', ...Array(6).fill('y'.repeat(80)), '']);
    });

    test('a saved session leaves out the output of an app that turned bracketed paste on away from the start of a row, then printed a line and a line running past four rows', async () => {
        // Known limit: the first line lands on the marked row, which reads as the top line of a prompt like Starship's
        // printed after output with no final newline, and the long line as its command, so the save stops at the marked
        // row. Before, the save kept the first line and the long line's rows above the cursor's: 400 of its 450
        // characters. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\nout\x1b[?2004h\r\nTitle\r\n${'x'.repeat(450)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'out', '']);
    });

    test('a saved session leaves out a job\'s line that starts with a newline, printed at a plain prompt after output with no final newline, with a long command typed under it', async () => {
        // Known limit: the job's line lands on the marked row, the row below the output's, and reads as the top line of
        // a prompt like Starship's, so the save stops at it. Before, the save kept the job's line and the command's
        // rows above the cursor's: 400 of its 405 characters. Pinned so that changing it is deliberate
        const saves = recordSavedSessions();
        const prompt = '\x1b[?2004hroot@box:/app# ';
        await receiveOutput(`${prompt}printf hello\r\n\x1b[?2004l\rhello${prompt}\r\njob done\r\n${typedCommand(400)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['root@box:/app# printf hello', 'helloroot@box:/app#', '']);
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

    test('a saved session leaves out a Starship prompt with a half-typed command four rows long once Ctrl-A takes the cursor back up to its first row, as bash prints it', async () => {
        // The cursor is back within four rows of the marked one
        const saved = await replayCapture('starshipLongCtrlE', 4, LONG_COMMANDS);

        assert.equal(saved[3], saved[1]);
    });

    for (const [name, prompt] of [['starshipLongCtrlE', 'a Starship prompt with a half-typed command four rows long'],
        ['plainLongCtrlE', 'a plain prompt with a half-typed command six rows long']]) {
        test(`a saved session leaves out ${prompt} after Ctrl-A and Ctrl-E, as bash prints it`, async () => {
            // readline moves the cursor down the command with a newline, which leaves the rows it moves to unmarked as
            // wrapped ones; Ctrl-A moved the cursor up over them first, which the terminal recorded
            const saved = await replayCapture(name, 5, LONG_COMMANDS);

            assert.deepEqual(savedLines(saved[1]).slice(-3), [name === 'plainLongCtrlE' ? 'root@box:/app# echo out' : '\u276f echo out',
                'out', '']);
            assert.deepEqual(saved.slice(2), [2, 3, 4].map(() => saved[1]), 'typed, after Ctrl-A and after Ctrl-E');
        });
    }

    // A plain prompt with a half-typed command six rows long, after readline's Ctrl-A and Ctrl-E: the cursor moved up
    // the command to its first row and back down with newlines, which left none of its rows marked as wrapped. Returns
    // the save at the prompt before the command was typed, which the save after Ctrl-E equals
    const ROOT_PROMPT = 'root@box:/app# ';
    async function plainCommandAfterCtrlAE(saves) {
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        const atPrompt = saves.at(-1);
        await receiveOutput(typedCommand(400));
        await receiveOutput(ctrlA(5, ROOT_PROMPT.length));
        await receiveOutput(ctrlE(5, 20));
        assert.equal(saves.at(-1), atPrompt, 'after Ctrl-E, the prompt is left out');
        return atPrompt;
    }
    // The command's rows as the save keeps them once they no longer run on as one line from the prompt's
    const keptCommand = [`${ROOT_PROMPT}echo out`, 'out', `${ROOT_PROMPT}${typedCommand(400)}`.slice(0, 80)];

    // A plain prompt with a half-typed command eight rows long, after Ctrl-A and Ctrl-E, then Backspace back across
    // the last row's start (readline: BS and EL 0, the last at the row's first column), onto the row above (CSI A, the
    // cursor to its last column, EL 0). Returns the save at the prompt
    async function plainEightRowsErasedOntoSeventh(saves) {
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        const atPrompt = saves.at(-1);
        await receiveOutput(typedCommand(560));
        await receiveOutput(`${ctrlA(7, ROOT_PROMPT.length)}${ctrlE(7, 20)}`);
        await receiveOutput(`${'\b\x1b[K'.repeat(20)}\x1b[A\x1b[79C`);
        return atPrompt;
    }

    for (const [erase, then] of [['EL 0', '\x1b[K'], ['ED 0', '\x1b[J']]) {
        test(`a saved session leaves out a plain prompt with a long command erased back across a row with ${erase} and typed on`, async () => {
            // The erase on the row the cursor moved up onto keeps what lies left of it in the row's record
            const saves = recordSavedSessions();
            const atPrompt = await plainEightRowsErasedOntoSeventh(saves);
            await receiveOutput(`${then}zz`);

            assert.equal(saves.at(-1), atPrompt);
        });
    }

    test('a saved session leaves out a plain prompt with a long command erased back to one character of a row and typed on', async () => {
        const saves = recordSavedSessions();
        const atPrompt = await plainEightRowsErasedOntoSeventh(saves);
        await receiveOutput(`\x1b[K${'\b\x1b[K'.repeat(78)}zz`);

        assert.equal(saves.at(-1), atPrompt);
    });

    test('a saved session leaves out a plain prompt with a long command erased back, then erased again past its end, and typed on', async () => {
        // What lies left of the cursor is the row's text, without the blank cells after it
        const saves = recordSavedSessions();
        const atPrompt = await plainEightRowsErasedOntoSeventh(saves);
        await receiveOutput(`\x1b[K${'\b\x1b[K'.repeat(78)}\x1b[10G\x1b[K\x1b[2Gzz`);

        assert.equal(saves.at(-1), atPrompt);
    });

    test('a saved session no longer follows a long command across a row written over from its start and erased past it', async () => {
        // On the row the cursor moved up onto, what is left of the cursor no longer starts what the row held: the record
        // is not cut to it
        const saves = recordSavedSessions();
        await plainEightRowsErasedOntoSeventh(saves);
        await receiveOutput('\rXYZ\x1b[K');

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 3), keptCommand);
    });

    test('an erase that leaves nothing of a row the cursor moved up onto drops its record, with records below it already erased', async () => {
        // After Ctrl-A and Ctrl-E, the cursor moves up three rows; ED 0 from that row's last column resets the rows below,
        // whose markers go with them, and EL 1 then leaves nothing of the row left of the cursor, so the EL 0 after it
        // drops the row's record
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        await receiveOutput(`${typedCommand(560)}${ctrlA(7, ROOT_PROMPT.length)}${ctrlE(7, 20)}\x1b[3A\x1b[79C`);
        const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
        await receiveOutput('\x1b[J\x1b[1K\x1b[K');

        assert.equal(markersOn(row), 1, `only the marker of the row last moved up onto on row ${row}: ${markedRows()}`);
    });

    test('a change of rows keeps the record of the rows the cursor moved up over after the columns changed once', async () => {
        // The columns the record was last dropped at are what a later change of rows is compared with
        terminal.resize(100, terminal.rows);
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        const atPrompt = saves.at(-1);
        await receiveOutput(`${typedCommand(600)}${ctrlA(6, ROOT_PROMPT.length)}${ctrlE(6, 20)}`);
        terminal.resize(100, 30);
        manager.saveSessionState();

        assert.equal(saves.at(-1), atPrompt);
    });

    for (const [move, up] of [['CSI 5 A', '\x1b[5A'], ['ESC M once a row', '\x1bM'.repeat(5)]]) {
        test(`a saved session leaves out a plain prompt with a half-typed command six rows long after the cursor moved up it by ${move} and back down`, async () => {
            const saves = recordSavedSessions();
            await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
            const atPrompt = saves.at(-1);
            await receiveOutput(`${typedCommand(400)}${up}${ctrlE(5, 20)}`);

            assert.equal(saves.at(-1), atPrompt);
        });
    }

    // The markers of the screen in use: the prompt's mark is in the normal one
    for (const [where, output, markers] of [['while a command runs', `\x1b[?2004h${ROOT_PROMPT}ls\r\n\x1b[?2004l\r`, 1],
        ['in an editor\'s screen', '\x1b[?2004h$ vim\r\n\x1b[?2004l\r\x1b[?1049h\x1b[?2004h', 0]]) {
        test(`the cursor's moves up over wrapped rows ${where} are not recorded`, async () => {
            // Only a prompt's are: the shell's line editor turns bracketed paste on there, in the normal buffer
            recordSavedSessions();
            await receiveOutput(`${output}${'x'.repeat(420)}${ctrlA(5, 0)}${ctrlE(5, 20)}`);

            assert.equal(terminal.markers.length, markers, `markers on rows ${terminal.markers.map((marker) => marker.line)}`);
        });
    }

    // An erase on the command's fourth row, two above the cursor's, after which the rest of the command is written again
    // from that row's first column, so the rows below it are marked as wrapped once more
    for (const [erase, sequence, clearsWrap] of [
        ['EL 0 at the row\'s first column', '\r\x1b[K', true],
        ['EL 2', '\x1b[2K', true],
        ['DECSEL 0 at the row\'s first column (CSI ? K)', '\r\x1b[?K', true],
        ['DECSEL 2 (CSI ? 2 K)', '\x1b[?2K', true],
        ['ED 0 at the row\'s first column', '\r\x1b[J', true],
        ['DECSED 0 at the row\'s first column (CSI ? J)', '\r\x1b[?J', true],
        ['EL 0 past the row\'s first column', '\r\x1b[5C\x1b[K', false],
        ['EL 1', '\r\x1b[5C\x1b[1K', false],
        ['ED 0 past the row\'s first column', '\r\x1b[5C\x1b[J', false],
    ]) {
        test(`a saved session ${clearsWrap ? 'no longer follows' : 'still follows'} a command across a row the cursor moved up over once ${erase} erases it`, async () => {
            // The terminal clears a row's wrap where the erase starts at its first column or takes the whole row; a row the
            // cursor moved up over at a prompt then counts as wrapped no more than any other
            const saves = recordSavedSessions();
            const atPrompt = await plainCommandAfterCtrlAE(saves);
            await receiveOutput(`\x1b[2A${sequence}\r${'a'.repeat(180)}`);

            if (clearsWrap) assert.deepEqual(savedLines(saves.at(-1)).slice(0, 3), keptCommand);
            else assert.equal(saves.at(-1), atPrompt);
        });
    }

    // The rows of the buffer that markers are on, and how many are on a row: besides the prompt's mark and the record
    // of the rows the cursor moved up over, a marker follows the row it last moved up onto (see cutClaim)
    const markedRows = () => terminal.markers.map((marker) => marker.line);
    const markersOn = (row) => markedRows().filter((line) => line === row).length;

    // ED 2 also resets the cursor's row, and the marker of the row last moved up onto with it
    for (const [erase, sequence, left] of [['ED 1', '\x1b[5C\x1b[1J', 1], ['DECSED 1 (CSI ? 1 J)', '\x1b[5C\x1b[?1J', 1],
        ['ED 2', '\x1b[2J', 0], ['DECSED 2 (CSI ? 2 J)', '\x1b[?2J', 0]]) {
        test(`${erase} drops the record of the cursor's row, which it erases`, async () => {
            // The erase takes the prompt's marked row with it, so no save can tell
            const saves = recordSavedSessions();
            await plainCommandAfterCtrlAE(saves);
            const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY - 2;
            await receiveOutput(`\x1b[2A\r${sequence}`);

            assert.equal(markersOn(row), left, `no record of row ${row}: ${markedRows()}`);
        });
    }

    test('ED 1 from the last column drops the record of the row the terminal unmarks as wrapped below the cursor\'s', async () => {
        // xterm.js clears the wrap of the row numbered one past the cursor's row on the screen, counted from the top of
        // the buffer: here, with no scrollback, the row below the cursor's
        const saves = recordSavedSessions();
        await plainCommandAfterCtrlAE(saves);
        const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY - 1;
        await receiveOutput(`\x1b[2A\r\x1b[79C\x1b[1J`);

        assert.ok(!markedRows().includes(row), `no record of row ${row} in ${markedRows()}`);
    });

    test('ED 1 from the last column keeps the record of the row below the cursor\'s once the screen has scrolled', async () => {
        // There the row numbered one past the cursor's row on the screen is in the scrollback, and the row below the
        // cursor's stays marked as wrapped
        const saves = recordSavedSessions();
        await receiveOutput(SCREENFULS);
        await plainCommandAfterCtrlAE(saves);
        const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY - 1;
        await receiveOutput(`\x1b[2A\r\x1b[79C\x1b[1J`);

        assert.ok(markedRows().includes(row), `a record of row ${row} in ${markedRows()}`);
    });

    test('a saved session no longer follows a command across the rows the cursor moved up over once the terminal is resized', async () => {
        // Resized, the terminal rewraps its lines, and the rows move
        const saves = recordSavedSessions();
        await plainCommandAfterCtrlAE(saves);
        terminal.resize(100, terminal.rows);
        manager.saveSessionState();

        assert.deepEqual(savedLines(saves.at(-1)).slice(0, 3), keptCommand);
    });

    test('the rows the cursor moves up over again and again at a prompt are recorded once each', async () => {
        const saves = recordSavedSessions();
        await plainCommandAfterCtrlAE(saves);
        const recorded = markedRows();
        // Each time, the command is drawn again from its first row, as readline does after a key typed there, which marks
        // the rows it runs onto as wrapped once more
        for (let i = 0; i < 20; i++) {
            await receiveOutput(`${ctrlA(5, ROOT_PROMPT.length)}\r${ROOT_PROMPT}${typedCommand(400)}${ctrlA(5, ROOT_PROMPT.length)}${ctrlE(5, 20)}`);
        }

        assert.deepEqual(markedRows().sort(), recorded.sort());
        assert.equal(recorded.length, 7, 'the marked row, the five the command wraps onto, and the one last moved up onto');
    });

    test('an app that keeps bracketed paste on and moves up over a wrapped row again and again leaves a bounded record', async () => {
        // Each time on a new row: the app's line wraps onto it, and the cursor moves up over it and back down. The record
        // keeps the rows nearest the cursor, as many as no screen is tall
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${`${'x'.repeat(90)}\x1b[A\r\n\r\n`.repeat(500)}`);
        const buffer = terminal.buffer.active;
        const cursorRow = buffer.baseY + buffer.cursorY;

        assert.ok(terminal.markers.length <= 202, `${terminal.markers.length} markers`);
        assert.ok(markedRows().includes(cursorRow - 1), 'the last row moved up over is recorded');
        assert.ok(savedLines(saves.at(-1)).includes('$ app'), 'the app\'s output is kept');
    });

    // An app that keeps bracketed paste on prints a line wrapped onto eight rows, moves the cursor up over it with CSI A,
    // then draws each row again as a line of its own, with a newline between: a recorded row no longer holds what it did
    const appRedrawn = (eachRow) => `$ app\r\n\x1b[?2004h${'x'.repeat(80 * 8 - 5)}\x1b[7A${
        Array.from({ length: 8 }, (_, i) => eachRow(`line${i}`)).join('\r\n')}`;
    for (const [how, eachRow, kept] of [
        ['ending each with EL 0', (text) => `\r${text}\x1b[K`, (i) => `line${i}`],
        ['erasing each with EL 1 from the last column first', (text) => `\r\x1b[79C\x1b[1K\r${text}`, (i) => `line${i}`],
        ['writing over each without an erase', (text) => `\r${text}`, (i) => `line${i}${'x'.repeat(75)}`],
        ['ending each with EL 0, then filling it to its last column', (text) => `\r${text}\x1b[K\r\x1b[5C${'-'.repeat(75)}`,
            (i) => `line${i}${'-'.repeat(75)}`],
    ]) {
        test(`a saved session keeps the output of an app that moves up over its wrapped line and draws its rows again as lines, ${how}`, async () => {
            // The rows the cursor moved up over were recorded with what they held: they count as wrapped only while they
            // still hold it, below a row that reaches its last column
            const saves = recordSavedSessions();
            await receiveOutput(appRedrawn(eachRow));

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...Array.from({ length: 7 }, (_, i) => kept(i)), '']);
        });
    }

    test('a saved session keeps the output of an app that moves up over its wrapped line and cuts each of its rows short', async () => {
        // Each row still starts like what it held, but the row above it no longer reaches its last column. (Each row
        // starts at a different place in the text: rows alike would match the rows a prompt reaches above the cursor's)
        const saves = recordSavedSessions();
        const text = 'abcdefghi'.repeat(80);
        await receiveOutput(`$ app\r\n\x1b[?2004h${text.slice(0, 80 * 8 - 5)}\x1b[7A${
            Array.from({ length: 8 }, () => '\r\x1b[5C\x1b[K').join('\r\n')}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...Array.from({ length: 7 }, (_, i) => text.slice(80 * i, 80 * i + 5)), '']);
    });

    test('a saved session leaves out a plain prompt with a half-typed command six rows long after a key typed at its start and Ctrl-E', async () => {
        // readline draws the rest of the command again from the key typed, which shifts every row, then moves the cursor
        // back up over them: the record takes what they hold now
        const saves = recordSavedSessions();
        const command = `echo ${'0123456789'.repeat(40)}`;
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        const atPrompt = saves.at(-1);
        await receiveOutput(command);
        await receiveOutput(ctrlA(5, ROOT_PROMPT.length));
        await receiveOutput(`X${command}${ctrlA(5, ROOT_PROMPT.length + 1)}`);
        await receiveOutput(ctrlE(5, 21));

        assert.equal(saves.at(-1), atPrompt);
    });

    // Letters in an order that repeats every 26, for app lines that wrap onto several rows
    const LETTERS_8 = Array.from({ length: 80 * 8 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(i * 7) % 26]).join('');
    // Wide characters, three-quarters of the CJK block's first part: 40 to a row
    const WIDE = Array.from({ length: 600 }, (_, i) => String.fromCodePoint(0x4e00 + i * 7)).join('');

    test('a saved session keeps the output of an app that moves up over its wrapped line of wide characters and cuts each of its rows short', async () => {
        // A row that starts with a wide character reaches back to the row above only where that row's last cell but one is
        // written: the wide character at the end of the row above did not fit its last column
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${WIDE.slice(0, 40 * 8 - 3)}\x1b[7A${
            Array.from({ length: 8 }, () => '\r\x1b[6C\x1b[K').join('\r\n')}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...Array.from({ length: 7 }, (_, i) => WIDE.slice(40 * i, 40 * i + 3)), '']);
    });

    test('a saved session keeps the output of an app that moves up over its wrapped line of wide characters and draws each row\'s start again as a line', async () => {
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${WIDE.slice(0, 40 * 6 - 3)}\x1b[5A${
            Array.from({ length: 6 }, (_, i) => `\r${WIDE.slice(40 * i, 40 * i + 3)}\x1b[K`).join('\r\n')}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...Array.from({ length: 5 }, (_, i) => WIDE.slice(40 * i, 40 * i + 3)), '']);
    });

    // An app that draws a box at full width, row after row, the terminal wrapping each onto the next, then moves up and,
    // a row at a time, clears the box's inside (past the border, with EL 0) and draws it again
    const boxRow = (text) => `\u2502 ${text}`.padEnd(79) + '\u2502';
    const BOX_EDGE = '\u2500'.repeat(78);
    const BOX = `\u250c${BOX_EDGE}\u2510${Array.from({ length: 5 }, (_, i) => boxRow(`item ${i}`)).join('')}\u2514${BOX_EDGE}\u2518`;
    const boxRedraw = (tag) => `\x1b[5A${Array.from({ length: 5 }, (_, i) => `\r\x1b[2C\x1b[K${`${tag} ${i}`.padEnd(77)}\u2502`).join('\r\n')}\r\n`;
    for (const [times, redraws] of [['once', ['changed']], ['twice', ['changed', 'again']]]) {
        test(`a saved session keeps the output of an app that draws a box and the inside of its rows again ${times}`, async () => {
            // The erase past each row's first column cuts no record: the cursor moved up onto none of those rows, as
            // readline's Backspace does across the wrap
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${BOX}`);
            for (const tag of redraws) await receiveOutput(boxRedraw(tag));

            const tag = redraws.at(-1);
            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', `\u250c${BOX_EDGE}\u2510${boxRow(`${tag} 0`)}`,
                ...[1, 2, 3, 4].map((i) => boxRow(`${tag} ${i}`)), '']);
        });
    }

    // An app's title under a blank row, then a line wrapped onto five rows, the cursor moved up over its last
    const LETTERS = Array.from({ length: 390 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(i * 7) % 26]).join('');
    for (const [erase, sequence] of [['EL 1 from the row\'s end, then EL 0', '\x1b[75C\x1b[1K\x1b[K'],
        ['ECH over the row\'s start, then EL 0 past it', '\x1b[70X\x1b[75C\x1b[K'], ['EL 2', '\x1b[2K'], ['EL 0 from its first column', '\r\x1b[K']]) {
        test(`a saved session keeps the output of an app that erases the last row of its wrapped line with ${erase} and writes a status there`, async () => {
            // An erase that leaves nothing of the row left of the cursor drops the row's record
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n${LETTERS}`);
            await receiveOutput(`\x1b[A\r\n${sequence}\rstatus: done`);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Title', LETTERS.slice(0, 320), '']);
        });
    }

    test('a saved session keeps the output of an app that blanks the last row of its wrapped line, moves up over it, and writes a status there', async () => {
        // EL 1 keeps the row marked as wrapped, so the cursor's move up over it records it with no text: a record with
        // nothing to compare counts for no row
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n${LETTERS}`);
        await receiveOutput('\x1b[80G\x1b[1K\x1b[A\r\n\rstatus: done');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Title', LETTERS.slice(0, 320), '']);
    });

    test('a saved session keeps the output of an app whose line of wide characters it moved up over runs on from a first row it cut short', async () => {
        // The rows below the first still hold what they did, but the first, cut after the move up, no longer holds what it
        // did then, which the second row's record keeps. (Cut before the move up, the first row holds just that, and only
        // its reach keeps the output: see the tests after this one)
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${WIDE.slice(0, 40 * 6 - 3)}\x1b[5A\r\x1b[6C\x1b[K${'\r\n'.repeat(5)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', WIDE.slice(0, 3), ...[1, 2, 3, 4].map((i) => WIDE.slice(40 * i, 40 * i + 40)), '']);
    });

    for (const [chars, line, column, cut] of [['wide characters', WIDE.slice(0, 40 * 8 - 3), 6, (i) => WIDE.slice(40 * i, 40 * i + 3)],
        ['letters, cut at the last column', 'abcdefghi'.repeat(80).slice(0, 80 * 8 - 5), 79, (i) => 'abcdefghi'.repeat(80).slice(80 * i, 80 * i + 79)]]) {
        test(`a saved session keeps the output of an app that cuts short the rows of its line of ${chars}, then moves up over them`, async () => {
            // Recorded after the cut, each row and the one above it hold what they did, but the row above reaches its
            // last column no more: its last cell is empty and, below a wide character, so is the one before
            const saves = recordSavedSessions();
            await receiveOutput(`$ app\r\n\x1b[?2004h${line}\x1b[7A${Array.from({ length: 8 }, () => `\r\x1b[${column}C\x1b[K`).join('\x1b[B')}`);
            await receiveOutput(`\x1b[7A${'\r\n'.repeat(7)}`);

            assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...Array.from({ length: 7 }, (_, i) => cut(i)), '']);
        });
    }

    test('a saved session keeps the output of an app that moves up over its wrapped line and draws its first row again with a status padded to the last column', async () => {
        // The rows below the first still hold what they did, and the first still reaches its last column, but it no longer
        // holds what it did when the cursor moved up over the row below it
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h\r\nTitle\r\n${LETTERS}`);
        await receiveOutput(`\x1b[4A\r${'status: done'.padEnd(80)}${[1, 2, 3, 4].map((i) => `\r\n\r${LETTERS.slice(80 * i, 80 * i + 80)}`).join('')}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', '', 'Title', 'status: done', LETTERS.slice(80, 160), LETTERS.slice(160, 240),
            LETTERS.slice(240, 320), '']);
    });

    // At 40 columns and 12 rows: an app's line wrapped onto eight rows, the cursor moved up over seven of them and back
    // down, six status lines that scroll the screen, then the line's sixth row cut short (CUP, EL 0) and written on
    const NARROW_LINE = Array.from({ length: 40 * 8 - 3 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(i * 7) % 26]).join('');
    for (const [scrollback, lines] of [['full', 5100], ['with room', 30]]) {
        test(`a saved session keeps the output of an app that cuts short a row it moved up over, with the scrollback ${scrollback}`, async () => {
            // The cut applies only on the row the cursor last moved up onto, which a marker follows as the screen scrolls
            // and the scrollback drops its oldest lines; a row number would name another row once those lines go
            terminal.resize(40, 12);
            const saves = recordSavedSessions();
            await receiveOutput(Array.from({ length: lines }, (_, i) => `out ${i}\r\n`).join(''));
            await receiveOutput(`$ app\r\n\x1b[?2004h${NARROW_LINE}\x1b[7A${'\r\n'.repeat(7)}\x1b[37C`);
            await receiveOutput(`\r\n${Array.from({ length: 6 }, (_, i) => `status ${i}`).join('\r\n')}\x1b[5;6H\x1b[KXY`);

            assert.deepEqual(savedLines(saves.at(-1)).slice(-9),
                [`out ${lines - 1}`, '$ app', ...Array.from({ length: 6 }, (_, i) => NARROW_LINE.slice(40 * i, 40 * i + 40)), '']);
        });
    }

    test('a saved session keeps the output of an app that rewrites a row it moved up over, then cuts the row below it', async () => {
        // The cut keeps what is left of its own row in the row's record, and takes nothing new of the row above: that row
        // no longer holds what it did when the cursor moved up over the cut one
        const saves = recordSavedSessions();
        const line = LETTERS_8.slice(0, 80 * 8 - 5);
        await receiveOutput(`$ app\r\n\x1b[?2004h${line}\x1b[7A\x1b[7;1H${'Z'.repeat(80)}`);
        await receiveOutput('\x1b[9;1H\x1b[A\x1b[6G\x1b[K\x1b[7;1H\n\x1b[8;5H');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', `${line.slice(0, 400)}${'Z'.repeat(80)}`, '']);
    });

    test('a saved session keeps the output of an app that cuts short the rows it moved up over, moves up over them again and draws them whole', async () => {
        // A row above recorded cut short counts only while it holds just that: drawn whole again, it holds more
        const saves = recordSavedSessions();
        const line = LETTERS_8.slice(0, 80 * 8 - 5);
        const rows = Array.from({ length: 8 }, (_, i) => line.slice(80 * i, 80 * i + 80));
        await receiveOutput(`$ app\r\n\x1b[?2004h${line}\x1b[7A${Array.from({ length: 8 }, () => '\r\x1b[5C\x1b[K').join('\x1b[B')}`);
        await receiveOutput(`\x1b[7A${rows.map((row) => `\r${row}`).join('\x1b[B')}\x1b[2;1H${'\r\n'.repeat(7)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...rows.slice(0, 7), '']);
    });

    test('a saved session keeps the output of an app whose line of wide characters it moved up over has its empty last cells written', async () => {
        // At 81 columns, forty wide characters fill eighty cells and the next one wraps, so each row's last cell is
        // empty when the row below it is recorded; written later, the row above holds more than it did
        terminal.resize(81, terminal.rows);
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${WIDE.slice(0, 40 * 8 - 3)}\x1b[7A${Array.from({ length: 8 }, () => '\x1b[81G|').join('\x1b[B')}`);
        await receiveOutput(`\x1b[2;1H${'\r\n'.repeat(7)}`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', ...Array.from({ length: 7 }, (_, i) => `${WIDE.slice(40 * i, 40 * i + 40)}|`), '']);
    });

    test('a saved session keeps the output of an app that draws its first line and input line again over a row the cursor moved up over', async () => {
        // A progress line wrapped onto the next row, the cursor moved up over it, then the app's title, input line and
        // status drawn again as lines, the status on the row recorded: it no longer holds what it did
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nlog1\r\nlog2\r\nlog3\r\n`);
        await receiveOutput(`${'p'.repeat(100)}\x1b[A\r\x1b[A\rTitle\x1b[K\r\n> hi\x1b[K\r\nstatus\x1b[K`);

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'log1', 'log2', 'Title', '> hi', '']);
    });

    test('a saved session keeps the output of an app whose scroll region scrolled a row the cursor moved up over', async () => {
        // The record stays on the row while the line it was made for scrolls away: the row no longer holds what it did
        const saves = recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004hTitle\r\n> \r\nlog1\r\nlog2\r\nlog3\r\n`);
        await receiveOutput(`${'p'.repeat(100)}\x1b[A\x1b[7;24r\x1b[24;1H\r\n\r\n\r\n`);
        await receiveOutput('\x1b[r\x1b[6;1HTitle\x1b[K\x1b[7;1H> hi\x1b[K\x1b[8;1Hstatus\x1b[K');

        assert.deepEqual(savedLines(saves.at(-1)), ['$ app', 'Title', '>', 'log1', 'log2', 'Title', '> hi', '']);
    });

    for (const [how, rows] of [['taller', 30], ['shorter', 18]]) {
        test(`a saved session still follows a command across the rows the cursor moved up over once the terminal is made ${how}`, async () => {
            // Only a change of columns rewraps the terminal's lines; with rows alone the lines move whole, into the
            // scrollback or out of it, and their markers with them
            const saves = recordSavedSessions();
            const atPrompt = await plainCommandAfterCtrlAE(saves);
            terminal.resize(terminal.cols, rows);
            manager.saveSessionState();

            assert.equal(saves.at(-1), atPrompt);
        });
    }

    test('a move up by a count past the screen records no more rows than the screen holds', async () => {
        // An app's line wrapped onto more rows than the screen has: the cursor moves up no higher than its top
        recordSavedSessions();
        await receiveOutput(`$ app\r\n\x1b[?2004h${'x'.repeat(80 * 40)}\x1b[65535A`);

        assert.equal(terminal.markers.filter((marker) => !marker.isDisposed).length, 1 + terminal.rows - 1 + 1,
            'the mark, the rows from the cursor\'s up to the screen\'s top, and the one last moved up onto');
    });

    test('a saved session leaves out a plain prompt with a half-typed command twenty-two rows long after Ctrl-A and Ctrl-E', async () => {
        // Each of the twenty-one rows the cursor moved up over is recorded
        const saves = recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}echo out\r\n\x1b[?2004l\rout\r\n\x1b[?2004h${ROOT_PROMPT}`);
        const atPrompt = saves.at(-1);
        await receiveOutput(typedCommand(21 * 80 + 20));
        await receiveOutput(ctrlA(21, ROOT_PROMPT.length));
        await receiveOutput(ctrlE(21, 40));

        assert.equal(saves.at(-1), atPrompt);
    });

    test('a Tab typed again leaves one marker for it, and a new prompt none', async () => {
        recordSavedSessions();
        await receiveOutput(`\x1b[?2004h${ROOT_PROMPT}ls`);
        terminal.input('\t');
        await receiveOutput('\x07');
        terminal.input('\t');
        await receiveOutput('\x07');
        assert.equal(terminal.markers.length, 2, 'the mark and the last Tab\'s row');
        await receiveOutput(`\r\n\x1b[?2004l\rfile\r\n\x1b[?2004h${ROOT_PROMPT}`);

        assert.equal(terminal.markers.length, 1, 'the new mark');
    });

    test('a change of the terminal\'s columns drops the record of the rows the cursor moved up over, and of rows alone does not', async () => {
        const saves = recordSavedSessions();
        await plainCommandAfterCtrlAE(saves);
        terminal.resize(terminal.cols, 30);
        assert.equal(terminal.markers.length, 7, 'the mark, the five rows and the one last moved up onto, after a change of rows');
        terminal.resize(100, 30);

        assert.equal(terminal.markers.length, 2, 'the mark and the row last moved up onto, after a change of columns');
    });

    test('a new prompt drops the record of the rows the cursor moved up over at the one before', async () => {
        const saves = recordSavedSessions();
        await plainCommandAfterCtrlAE(saves);
        await receiveOutput(`\r\n\x1b[?2004l\r${'a'.repeat(400)}\r\n\x1b[?2004h${ROOT_PROMPT}`);

        assert.equal(terminal.markers.length, 1, `markers on rows ${markedRows()}`);
    });

    test('a prompt redrawn by Ctrl-L drops the record of the rows the cursor moved up over above the screen', async () => {
        // The screen is the prompt's eight rows: typed on, the command scrolls its first rows into the scrollback, which
        // clearing the screen leaves
        terminal.resize(80, 8);
        const saves = recordSavedSessions();
        await plainCommandAfterCtrlAE(saves);
        await receiveOutput('a'.repeat(400));
        assert.ok(terminal.buffer.active.baseY > 3, 'the command\'s first rows in the scrollback');
        await receiveOutput(`\x1b[H\x1b[2J${ROOT_PROMPT}`);

        assert.equal(terminal.markers.length, 1, `markers on rows ${markedRows()}`);
    });

    test('a saved session keeps a plain prompt with a half-typed command seven rows long after Ctrl-A, M-c and Ctrl-E, as bash prints it', async () => {
        // Known limit: M-c capitalises the command's first word where it stands, on the prompt's row, which is the row
        // above the first row Ctrl-A moved up over. readline moves up over no row after the edit, so that row's record
        // keeps the text the row above held, which it no longer holds, and the command no longer runs on across it. A
        // same-length edit on that row (M-u, Ctrl-T, a Tab completion in the middle of the line) does the same. The
        // save keeps the prompt and the command's rows, as before #64. Pinned so that changing it is deliberate
        const saved = await replayCapture('plainLongCtrlAEdited', 6, LONG_COMMANDS);

        const words = Array(4).fill('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega').join(' ');
        const line = `${ROOT_PROMPT}Echo ${words}`;
        assert.deepEqual(saved.slice(2, 4), [saved[1], saved[1]], 'typed, and after Ctrl-A, it was left out');
        assert.deepEqual(savedLines(saved[5]), [`${ROOT_PROMPT}echo out`, 'out',
            ...Array.from({ length: 6 }, (_, i) => line.slice(80 * i, 80 * i + 80).trimEnd()), '']);
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
