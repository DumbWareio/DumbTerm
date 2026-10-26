/**
 * End-to-end smoke tests for the DumbTerm server.
 * Boots server.js as a child process and drives it over HTTP and WebSocket, so the real
 * express, node-pty and ws versions are exercised. Run with `npm test` (Node's built-in runner).
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PIN = '1234';
const PIN_COOKIE = `DUMBTERM_PIN=${PIN}`;

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
    const proc = spawn(process.execPath, [...nodeArgs, 'server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            BASE_URL: baseUrl,
            DUMBTERM_PIN: PIN,
            NODE_ENV: 'production',
            DEBUG: 'FALSE',
            // A plain POSIX shell keeps the pty test independent of the developer's rc files
            SHELL: '/bin/sh',
            ...extraEnv(baseUrl),
        },
    });

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

    return {
        port,
        baseUrl,
        isRunning: () => proc.exitCode === null && proc.signalCode === null,
        output: () => output,
        // SIGKILL: server.js traps SIGTERM without exiting
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
    const state = { output: '', closeCode: null, rejectedStatus: null };
    ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'output') state.output += message.data;
    });
    ws.on('unexpected-response', (req, res) => {
        state.rejectedStatus = res.statusCode;
        ws.terminate();
    });
    ws.on('error', () => {});
    const closed = new Promise((resolve) => ws.on('close', (code) => {
        state.closeCode = code;
        resolve(code);
    }));
    return { ws, state, closed };
}

async function waitFor(predicate, timeoutMs, describeFailure) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(describeFailure());
}

// Collect the local script and stylesheet URLs a page loads, resolved against the page URL.
function pageAssetUrls(htmlFile, pageUrl) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, htmlFile), 'utf8');
    const tags = html.match(/<(script|link)\b[^>]*>/g) || [];
    return tags
        .filter((tag) => tag.startsWith('<script') || /rel="stylesheet"/.test(tag))
        .map((tag) => (tag.match(/\b(?:src|href)="([^"]+)"/) || [])[1])
        .filter((ref) => ref && !/^https?:/.test(ref))
        .map((ref) => new URL(ref, pageUrl).href);
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
        assert.equal(await terminal.closed, 1008);
    });

    test('serves every script and stylesheet the pages reference', async () => {
        const pages = [['index.html', `${server.baseUrl}/`], ['login.html', `${server.baseUrl}/login`]];
        for (const [htmlFile, pageUrl] of pages) {
            for (const url of pageAssetUrls(htmlFile, pageUrl)) {
                const res = await fetch(url, { headers: { Cookie: PIN_COOKIE } });
                assert.equal(res.status, 200, `${htmlFile} references ${url}, which returned ${res.status}`);
                if (url.endsWith('.js')) {
                    assert.match(res.headers.get('content-type'), /javascript/, `${url} is not served as JavaScript`);
                }
            }
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
        assert.equal(await terminal.closed, 1011);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(server.isRunning(), `server crashed:\n${server.output()}`);
        const res = await fetch(`${server.baseUrl}/login`);
        assert.equal(res.status, 200);
    });
});

describe('DumbTerm server with ALLOWED_ORIGINS', () => {
    let server;

    before(async () => { server = await startServer((baseUrl) => ({ ALLOWED_ORIGINS: baseUrl })); });
    after(async () => { await server.stop(); });

    test('rejects a WebSocket from a disallowed origin with 403 and keeps running', async () => {
        const terminal = openTerminal(server, { Cookie: PIN_COOKIE, Origin: 'http://evil.example' });
        await terminal.closed;
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(server.isRunning(), `server crashed:\n${server.output()}`);
        assert.equal(terminal.state.rejectedStatus, 403);
    });
});
