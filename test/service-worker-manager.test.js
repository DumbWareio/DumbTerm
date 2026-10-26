/**
 * Unit tests for public/managers/serviceWorker.js (the page side of the service worker).
 * Loads the real ES module with minimal stand-ins for the browser globals it touches.
 */
const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MANAGER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'managers', 'serviceWorker.js'), 'utf8');
const ORIGINAL_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

async function loadManager() {
    const { default: ServiceWorkerManager } = await import(`data:text/javascript,${encodeURIComponent(MANAGER_SOURCE)}`);
    return ServiceWorkerManager;
}

// Start a manager on a page running `pageVersion` whose cache still holds `cachedVersion`
async function startManager({ pageVersion, cachedVersion }) {
    globalThis.window = { appConfig: pageVersion ? { version: pageVersion, basePath: '' } : undefined };
    // Node already defines a read-only `navigator` global, so replace it rather than assign to it
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
            serviceWorker: {
                controller: null,
                ready: Promise.resolve({ active: { postMessage() {} } }),
                register: async () => ({ scope: '/', addEventListener() {} }),
                addEventListener() {},
            },
        },
    });
    globalThis.document = { addEventListener() {}, getElementById: () => null, visibilityState: 'visible' };
    globalThis.caches = { keys: async () => (cachedVersion ? [`DUMBTERM_CACHE_V${cachedVersion}`] : []) };

    const displayed = [];
    const ServiceWorkerManager = await loadManager();
    const manager = new ServiceWorkerManager();
    manager.initialize((version, loading) => displayed.push(loading ? 'loading' : version));
    // Let the startup cache lookup resolve
    await new Promise((resolve) => setImmediate(resolve));
    return { manager, displayed };
}

describe('service worker manager version display', () => {
    before(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        // The manager logs every step; keep the test output readable
        for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
    });
    after(() => {
        mock.timers.reset();
        mock.restoreAll();
        for (const key of ['window', 'navigator', 'document', 'caches']) delete globalThis[key];
        if (ORIGINAL_NAVIGATOR) Object.defineProperty(globalThis, 'navigator', ORIGINAL_NAVIGATOR);
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
