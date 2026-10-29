/**
 * End-to-end smoke tests for the DumbTerm server.
 * Boots server.js as a child process and drives it over HTTP and WebSocket, so the real
 * express, node-pty and ws versions are exercised. Run with `npm test` (Node's built-in runner).
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PIN = '1234';
const PIN_COOKIE = `DUMBTERM_PIN=${PIN}`;

// `npm start` copies the xterm packages into public/ before starting the server; do the same
before(() => {
    execFileSync(process.execPath, ['scripts/copy-xterm.js'], { cwd: ROOT, stdio: 'ignore' });
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

// Start server.js on a free port and resolve once it is listening.
// extraEnv receives the server's base URL so callers can build origin-dependent settings.
async function startServer(extraEnv = () => ({}), nodeArgs = []) {
    const port = await getFreePort();
    const baseUrl = `http://localhost:${port}`;
    const env = {
        ...process.env,
        PORT: String(port),
        BASE_URL: baseUrl,
        DUMBTERM_PIN: PIN,
        NODE_ENV: 'production',
        DEBUG: 'FALSE',
        // A plain POSIX shell keeps the pty test independent of the developer's rc files
        SHELL: '/bin/sh',
        ...extraEnv(baseUrl),
    };
    // A variable set to undefined by extraEnv is removed, e.g. to start without NODE_ENV like the Docker image
    Object.keys(env).forEach((key) => env[key] === undefined && delete env[key]);
    const proc = spawn(process.execPath, [...nodeArgs, 'server.js'], { cwd: ROOT, env });

    let output = '';
    proc.stdout.on('data', (chunk) => { output += chunk; });
    proc.stderr.on('data', (chunk) => { output += chunk; });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);
        proc.stdout.on('data', () => {
            if (output.includes('Server running on')) {
                clearTimeout(timer);
                resolve();
            }
        });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited with code ${code} during startup:\n${output}`));
        });
    });

    const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));

    return {
        port,
        baseUrl,
        exited,
        signal: (name) => proc.kill(name),
        isRunning: () => proc.exitCode === null && proc.signalCode === null,
        output: () => output,
        // SIGKILL, so a broken shutdown handler can't hang the suite
        stop: () => new Promise((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
            proc.once('exit', () => resolve());
            proc.kill('SIGKILL');
        }),
    };
}

// Open a terminal WebSocket and collect everything the server sends until it closes.
function openTerminal(server, headers) {
    const ws = new WebSocket(`ws://localhost:${server.port}/`, { headers });
    const state = { output: '', closeCode: null, closeReason: null, rejectedStatus: null };
    ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'output') state.output += message.data;
    });
    ws.on('unexpected-response', (req, res) => {
        state.rejectedStatus = res.statusCode;
        ws.terminate();
    });
    ws.on('error', () => {});
    const closed = new Promise((resolve) => ws.on('close', (code, reason) => {
        state.closeCode = code;
        state.closeReason = reason.toString();
        resolve(code);
    }));
    return { ws, state, closed };
}

// Resolve with the server's close code, failing fast if the server leaves the socket open
async function closeCodeWithin(terminal, timeoutMs = 5000) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
            `WebSocket still open after ${timeoutMs}ms, output: ${JSON.stringify(terminal.state.output)}`)), timeoutMs);
    });
    try {
        return await Promise.race([terminal.closed, timeout]);
    } finally {
        clearTimeout(timer);
        terminal.ws.terminate();
    }
}

async function waitFor(predicate, timeoutMs, describeFailure) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(describeFailure());
}

// Collect the local scripts, stylesheets and preloads a page loads, resolved against the page URL.
function pageAssetUrls(htmlFile, pageUrl) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, htmlFile), 'utf8');
    const tags = html.match(/<(script|link)\b[^>]*>/g) || [];
    return tags
        .filter((tag) => tag.startsWith('<script') || /rel="(stylesheet|preload)"/.test(tag))
        .map((tag) => (tag.match(/\b(?:src|href)="([^"]+)"/) || [])[1])
        .filter((ref) => ref && !/^https?:/.test(ref))
        .map((ref) => new URL(ref, pageUrl).href);
}

// Fetch every asset the pages load, and every url() inside their stylesheets, and expect each to be served.
async function assertPageAssetsServed(pages) {
    for (const [htmlFile, pageUrl] of pages) {
        for (const url of pageAssetUrls(htmlFile, pageUrl)) {
            const res = await fetch(url, { headers: { Cookie: PIN_COOKIE } });
            assert.equal(res.status, 200, `${htmlFile} references ${url}, which returned ${res.status}`);
            if (url.endsWith('.js')) {
                assert.match(res.headers.get('content-type'), /javascript/, `${url} is not served as JavaScript`);
            }
            if (url.endsWith('.css')) {
                const css = await res.text();
                for (const [, ref] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
                    if (/^(data:|https?:)/.test(ref)) continue;
                    const assetUrl = new URL(ref, url).href;
                    const asset = await fetch(assetUrl, { headers: { Cookie: PIN_COOKIE } });
                    assert.equal(asset.status, 200, `${url} references ${assetUrl}, which returned ${asset.status}`);
                }
            }
        }
    }
}

// Collect every static and dynamic import specifier in the front-end modules, resolved to URLs.
function moduleImportUrls(baseUrl) {
    const moduleFiles = ['index.js', 'login.js', ...fs.readdirSync(path.join(PUBLIC_DIR, 'managers'))
        .filter((file) => file.endsWith('.js'))
        .map((file) => `managers/${file}`)];
    const urls = [];
    for (const file of moduleFiles) {
        const source = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
        const specifiers = [
            ...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm),
            ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
        ].map((match) => match[1]);
        for (const specifier of specifiers) {
            urls.push({ file, url: new URL(specifier, `${baseUrl}/${file}`).href });
        }
    }
    return urls;
}

describe('DumbTerm server', () => {
    let server;

    before(async () => { server = await startServer(); });
    after(async () => { await server.stop(); });

    // An open page asks for the server's version this way: the service worker passes a HEAD request to the network
    // without caching it, and a signed-out page can ask too
    test('answers a HEAD of config.js with the version it runs', async () => {
        const res = await fetch(`${server.baseUrl}/config.js`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-dumbterm-version'), require('../package.json').version);
    });

    test('serves the login page when a PIN is configured', async () => {
        const res = await fetch(`${server.baseUrl}/login`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
    });

    test('redirects an unauthenticated visitor from / to /login', async () => {
        const res = await fetch(`${server.baseUrl}/`, { redirect: 'manual' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/login');
    });

    test('rejects a wrong PIN and accepts the right one with a PIN cookie', async () => {
        // A different client IP per server would be cleaner, but one wrong attempt stays under the lockout
        const wrong = await fetch(`${server.baseUrl}/verify-pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '9999' }),
        });
        assert.equal(wrong.status, 401);

        const right = await fetch(`${server.baseUrl}/verify-pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: PIN }),
            redirect: 'manual',
        });
        assert.equal(right.status, 302);
        assert.match(right.headers.get('set-cookie'), /DUMBTERM_PIN=1234/);
    });

    test('runs shell commands over the terminal WebSocket for an authenticated client', async () => {
        const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
        await new Promise((resolve) => terminal.ws.once('open', resolve));
        // The shell expands $((6*7)), so "smoke-42" can only appear if a real pty ran the command
        terminal.ws.send(JSON.stringify({ type: 'input', data: 'echo smoke-$((6*7))\r' }));
        await waitFor(() => terminal.state.output.includes('smoke-42'), 5000,
            () => `no shell output, got: ${JSON.stringify(terminal.state.output)}`);
        terminal.ws.close();
        await terminal.closed;
    });

    test('closes the terminal WebSocket with 1008 when the PIN cookie is missing', async () => {
        const terminal = openTerminal(server, { Origin: server.baseUrl });
        assert.equal(await closeCodeWithin(terminal), 1008);
    });

    test('closes the terminal WebSocket with 1008 when the PIN cookie is wrong', async () => {
        const terminal = openTerminal(server, { Cookie: 'DUMBTERM_PIN=0000', Origin: server.baseUrl });
        assert.equal(await closeCodeWithin(terminal), 1008);
    });

    test('keeps source maps and TypeScript sources out of the service worker precache', async () => {
        const res = await fetch(`${server.baseUrl}/asset-manifest.json`);
        const assets = await res.json();
        assert.ok(assets.includes('/node_modules/@xterm/xterm/lib/xterm.js'), 'expected the copied xterm bundle in the manifest');
        assert.deepEqual(assets.filter((asset) => /\.(map|ts)$/.test(asset)), []);
    });

    test('serves every script, stylesheet, preload and font the pages reference', async () => {
        await assertPageAssetsServed([['index.html', `${server.baseUrl}/`], ['login.html', `${server.baseUrl}/login`]]);
    });

    test('loads a script for every xterm addon global the terminal manager constructs', async () => {
        // UMD bundles register themselves as a global (e.g. `e.FitAddon=t()`); a missing script tag
        // means `new FitAddon.FitAddon()` throws a ReferenceError and no terminal ever opens.
        const pageUrl = `${server.baseUrl}/`;
        const loadedSource = (await Promise.all(pageAssetUrls('index.html', pageUrl)
            .filter((url) => url.endsWith('.js'))
            .map(async (url) => (await fetch(url, { headers: { Cookie: PIN_COOKIE } })).text()))).join('\n');
        const terminalSource = fs.readFileSync(path.join(PUBLIC_DIR, 'managers', 'terminal.js'), 'utf8');
        const globals = [...new Set([...terminalSource.matchAll(/new (\w+Addon)\.\1\(/g)].map((match) => match[1]))];
        assert.ok(globals.length > 0, 'expected terminal.js to construct at least one addon');
        for (const name of globals) {
            assert.match(loadedSource, new RegExp(`[a-z]\\.${name}=[a-z]\\(\\)`), `no script in index.html defines ${name}`);
        }
    });

    test('serves every module the front-end imports, as JavaScript', async () => {
        const imports = moduleImportUrls(server.baseUrl);
        assert.ok(imports.length > 0, 'expected the front-end to import at least one module');
        for (const { file, url } of imports) {
            const res = await fetch(url, { headers: { Cookie: PIN_COOKIE } });
            assert.equal(res.status, 200, `${file} imports ${url}, which returned ${res.status}`);
            assert.match(res.headers.get('content-type'), /javascript/, `${url} is not served as JavaScript`);
        }
    });
});

// A crash here would take the shared server down with it, so this test gets its own instance.
// The Docker image does not set NODE_ENV, which leaves Express in development mode unless the app overrides it
describe('DumbTerm server without NODE_ENV', () => {
    let server;

    before(async () => { server = await startServer(() => ({ NODE_ENV: undefined })); });
    after(async () => { await server.stop(); });

    test('answers a malformed /verify-pin request with 400 and no stack trace', async () => {
        const requests = [
            { name: 'no body', init: {} },
            { name: 'invalid JSON', init: { headers: { 'Content-Type': 'application/json' }, body: '{"pin":' } },
            { name: 'numeric PIN', init: { headers: { 'Content-Type': 'application/json' }, body: '{"pin":1234}' } },
        ];
        for (const { name, init } of requests) {
            const res = await fetch(`${server.baseUrl}/verify-pin`, { method: 'POST', ...init });
            const text = await res.text();
            assert.equal(res.status, 400, `${name}: expected 400, got ${res.status}`);
            assert.doesNotMatch(text, /server\.js|node_modules/, `${name}: response leaks a stack trace`);
        }
    });
});

describe('DumbTerm server under a BASE_URL sub-path', () => {
    let server;

    before(async () => { server = await startServer((baseUrl) => ({ BASE_URL: `${baseUrl}/dumbterm` })); });
    after(async () => { await server.stop(); });

    test('serves every script, stylesheet, preload and font the pages reference', async () => {
        await assertPageAssetsServed([
            ['index.html', `${server.baseUrl}/dumbterm/`],
            ['login.html', `${server.baseUrl}/dumbterm/login`],
        ]);
    });

    test('answers a HEAD of config.js under the sub-path with the version it runs', async () => {
        const res = await fetch(`${server.baseUrl}/dumbterm/config.js`, { method: 'HEAD' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-dumbterm-version'), require('../package.json').version);
    });

    test('redirects the sub-path without a trailing slash, so relative asset URLs resolve', async () => {
        // Served at /dumbterm, "styles.css" would resolve to /styles.css instead of /dumbterm/styles.css
        const res = await fetch(`${server.baseUrl}/dumbterm?tab=1`, { headers: { Cookie: PIN_COOKIE }, redirect: 'manual' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/dumbterm/?tab=1');
    });

    test('redirects an absolute-form request target (as sent through an HTTP proxy) correctly', async () => {
        const location = await new Promise((resolve, reject) => {
            const req = http.request({
                host: 'localhost',
                port: server.port,
                path: `${server.baseUrl}/dumbterm?tab=1`,
                headers: { Cookie: PIN_COOKIE },
            }, (res) => { res.resume(); resolve(res.headers.location); });
            req.on('error', reject);
            req.end();
        });
        assert.equal(location, '/dumbterm/?tab=1');
    });
});

describe('DumbTerm server with a nameless cookie', () => {
    let server;

    before(async () => { server = await startServer(); });
    after(async () => { await server.stop(); });

    test('keeps running when a WebSocket upgrade carries a cookie without "="', async () => {
        // Browsers send nameless cookies set by other apps on the same host, e.g. "Cookie: theme; DUMBTERM_PIN=1234"
        const terminal = openTerminal(server, { Cookie: `orphan; ${PIN_COOKIE}`, Origin: server.baseUrl });
        await new Promise((resolve) => {
            terminal.ws.once('open', resolve);
            terminal.closed.then(resolve);
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(server.isRunning(), `server crashed:\n${server.output()}`);
        assert.equal(terminal.state.closeCode, null, 'valid PIN cookie next to a nameless cookie should be accepted');
        terminal.ws.close();
        await terminal.closed;
    });
});

describe('DumbTerm server when the pty cannot be spawned', () => {
    let server;

    before(async () => {
        server = await startServer(() => ({}), ['--require', path.join(__dirname, 'fixtures', 'failing-pty.js')]);
    });
    after(async () => { await server.stop(); });

    test('closes the terminal WebSocket with 1011 and keeps running', async () => {
        const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
        assert.equal(await closeCodeWithin(terminal), 1011);
        assert.equal(terminal.state.closeReason, 'Failed to start terminal');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(server.isRunning(), `server crashed:\n${server.output()}`);
        const res = await fetch(`${server.baseUrl}/login`);
        assert.equal(res.status, 200);
    });
});

// A shell that fails to start (#46) mostly does not make spawn() throw: node-pty starts it, prints why it could not
// run it (on Linux; on macOS it prints nothing), and the shell exits with code 1. On macOS spawn() may throw instead,
// and the close says 'Failed to start terminal'; Linux (CI and the Docker image) runs the exit path
for (const [what, env, nodePtyLine] of [
    ['SHELL does not exist', { SHELL: '/nonexistent' }, 'execvp(3) failed.: No such file or directory'],
    ['HOME does not exist', { HOME: '/nonexistent' }, 'chdir(2) failed.: No such file or directory'],
]) {
    describe(`DumbTerm server when the ${what}`, () => {
        let server;

        before(async () => { server = await startServer(() => env); });
        after(async () => { await server.stop(); });

        test('closes the terminal WebSocket with 1011, saying why, and keeps running', async () => {
            const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
            assert.equal(await closeCodeWithin(terminal), 1011);
            if (process.platform === 'linux') {
                assert.ok(terminal.state.output.includes(nodePtyLine),
                    `no "${nodePtyLine}" before the close, got: ${JSON.stringify(terminal.state.output)}`);
                assert.equal(terminal.state.closeReason, 'Shell exited with code 1');
            } else {
                assert.ok(['Shell exited with code 1', 'Failed to start terminal'].includes(terminal.state.closeReason),
                    `unexpected reason ${JSON.stringify(terminal.state.closeReason)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.ok(server.isRunning(), `server crashed:\n${server.output()}`);
        });
    });
}

// Any shell that ends within a second of its spawn without exiting cleanly never started: one that fails late in
// that second, and one killed by a signal (which node-pty reports as code 0 and the signal)
for (const [what, fixture, reason] of [
    ['fails 0.6 s after it starts', 'slow-failing-shell.sh', 'Shell exited with code 2'],
    ['is killed by a signal as it starts', 'self-killing-shell.sh', 'Shell was killed by signal 9'],
]) {
    describe(`DumbTerm server when the shell ${what}`, () => {
        let server;

        before(async () => { server = await startServer(() => ({ SHELL: path.join(__dirname, 'fixtures', fixture) })); });
        after(async () => { await server.stop(); });

        test('closes the terminal WebSocket with 1011, saying why', async () => {
            const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
            assert.equal(await closeCodeWithin(terminal), 1011);
            assert.equal(terminal.state.closeReason, reason);
        });
    });
}

// A shell the user ends closes as it always has, without a status (1005), whatever its exit code once it has been
// up a while (#46)
describe('DumbTerm server when the shell exits', () => {
    let server;

    before(async () => { server = await startServer(); });
    after(async () => { await server.stop(); });

    async function shellEndedWith(command, upForMs) {
        const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
        await new Promise((resolve) => terminal.ws.once('open', resolve));
        await new Promise((resolve) => setTimeout(resolve, upForMs));
        terminal.ws.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
        return closeCodeWithin(terminal);
    }

    test('closes without a status on exit', async () => {
        assert.equal(await shellEndedWith('exit', 0), 1005);
    });

    test('closes without a status on a non-zero exit after the shell has been up a while', async () => {
        assert.equal(await shellEndedWith('exit 3', 1500), 1005);
    });

    test('closes without a status when the shell is killed by a signal after it has been up a while', async () => {
        assert.equal(await shellEndedWith('kill -9 $$', 1500), 1005);
    });

    // The rule is any non-zero code within a second of the spawn, not only node-pty's 1
    test('closes with 1011 and the exit code on a non-zero exit as the shell starts', async () => {
        const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
        await new Promise((resolve) => terminal.ws.once('open', resolve));
        terminal.ws.send(JSON.stringify({ type: 'input', data: 'exit 3\r' }));
        assert.equal(await closeCodeWithin(terminal), 1011);
        assert.equal(terminal.state.closeReason, 'Shell exited with code 3');
    });
});

describe('DumbTerm server shutdown', () => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
        test(`closes open terminals and exits cleanly on ${signal}`, async () => {
            const server = await startServer(() => ({}), ['--require', path.join(__dirname, 'fixtures', 'recording-pty.js')]);
            try {
                const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
                await new Promise((resolve) => terminal.ws.once('open', resolve));
                terminal.ws.send(JSON.stringify({ type: 'input', data: 'echo SHELLPID=$$\r' }));
                await waitFor(() => /SHELLPID=\d+/.test(terminal.state.output), 5000,
                    () => `no shell pid, got: ${JSON.stringify(terminal.state.output)}`);
                const shellPid = Number(terminal.state.output.match(/SHELLPID=(\d+)/)[1]);
                // Both deadlines run from the signal, well under shutdown()'s 2s backstop, so this only
                // passes on the graceful path
                const exitDeadline = new Promise((resolve) => setTimeout(() => resolve('still running'), 1500));
                server.signal(signal);
                // 1001 = going away: the browser can tell a shutdown from a crash (1006)
                assert.equal(await closeCodeWithin(terminal, 1500), 1001);
                const result = await Promise.race([server.exited, exitDeadline]);
                assert.deepEqual(result, { code: 0, signal: null }, `server did not exit cleanly:\n${server.output()}`);
                // The terminal's own close handler must kill its pty, not just the OS hanging it up at exit
                assert.match(server.output(), /PTY_KILLED/, 'shutdown exited before killing the terminal');
                await waitFor(() => {
                    try { process.kill(shellPid, 0); return false; } catch { return true; }
                }, 2000, () => `shell ${shellPid} is still running after shutdown`);
            } finally {
                await server.stop();
            }
        });
    }
});

describe('DumbTerm server shutdown with an unresponsive client', () => {
    test('still exits cleanly when a client never completes the close handshake', async () => {
        const server = await startServer();
        try {
            const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: server.baseUrl });
            await new Promise((resolve) => terminal.ws.once('open', resolve));
            // A paused socket never reads the server's close frame, so it never answers it
            terminal.ws._socket.pause();
            server.signal('SIGTERM');
            const result = await Promise.race([
                server.exited,
                new Promise((resolve) => setTimeout(() => resolve('still running'), 3000)),
            ]);
            assert.deepEqual(result, { code: 0, signal: null }, `server did not exit:\n${server.output()}`);
            terminal.ws.terminate();
        } finally {
            await server.stop();
        }
    });
});

describe('DumbTerm server with ALLOWED_ORIGINS', () => {
    let server;

    before(async () => { server = await startServer((baseUrl) => ({ ALLOWED_ORIGINS: baseUrl })); });
    after(async () => { await server.stop(); });

    test('rejects a WebSocket from a disallowed origin with 403 and keeps running', async () => {
        const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: 'http://evil.example' });
        await closeCodeWithin(terminal);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(server.isRunning(), `server crashed:\n${server.output()}`);
        assert.equal(terminal.state.rejectedStatus, 403);
    });
});
