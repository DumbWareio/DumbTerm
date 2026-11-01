// Core service worker configuration
// The page registers this worker as service-worker.js?v=<app version>, so read the version from there:
// a worker the browser restarts after idling would otherwise start at 1.0.0 and cache into a stray cache
const REGISTERED_VERSION = new URL(self.location.href).searchParams.get('v');
// A worker registered with a release version keeps it, whatever version config.js or a page's SET_VERSION names:
// pages show their own version, and the next release's page registers a worker of its own. A worker registered
// without one (an old page's bare registration, or a page that could not read config.js) takes the version they name.
// 1.0.0 is the version a worker without one starts at, so it counts as none.
const HAS_RELEASE_VERSION = /^\d+\.\d+\.\d+/.test(REGISTERED_VERSION || '') && REGISTERED_VERSION !== "1.0.0";
let CACHE_VERSION = HAS_RELEASE_VERSION ? REGISTERED_VERSION : "1.0.0"; // Default fallback version
const BASE_PATH = self.registration.scope;
// Cache Storage is shared by every install on the origin, so each cache name carries the path this install is
// served under ('/' or '/a/'), and an install deletes only its own caches
const SCOPE_PATH = new URL(BASE_PATH).pathname;
let CACHE_NAME = cacheNameFor(CACHE_VERSION);
// Names of the caches this worker's fills are still filling (a name appears once per fill), so no fill deletes
// another's cache. Other workers of this install can't see the list, so only the active worker clears caches.
const CACHES_BEING_FILLED = [];

/**
 * Names this install's cache for a version: DUMBTERM_CACHE_<scope path>_V<version>
 * @param {string} version - App version
 * @returns {string} Cache name
 */
function cacheNameFor(version) {
    return `DUMBTERM_CACHE_${SCOPE_PATH}_V${version}`;
}

/**
 * Whether a cache is one of this install's. The scope path ends in / and a version holds none, so the last _V
 * splits the name even when the path holds a _V of its own
 * @param {string} key - Cache name
 * @returns {boolean} True if the cache belongs to this install
 */
function isOwnCache(key) {
    const match = key.match(/^DUMBTERM_CACHE_(.*)_V[^/]+$/);
    return !!match && match[1] === SCOPE_PATH;
}

/**
 * Whether a cache has a name DumbTerm used before names carried the install's path: DUMBTERM_CACHE_V<version>,
 * and earlier DUMBTERM_CACHE_<version> and DUMBTERM_PWA_CACHE_V<version>. It can't tell which install made it.
 * @param {string} key - Cache name
 * @returns {boolean} True if the cache has an unscoped DumbTerm name
 */
function isLegacyCache(key) {
    return /^DUMBTERM_(PWA_)?CACHE_V?\d/.test(key);
}

/**
 * Gets app configuration from config.js
 * @returns {Promise<Object|null>} App configuration or null if retrieval fails
 */
async function getAppConfig() {
    try {
        const response = await fetch(getAssetPath('config.js'));
        if (!response.ok) throw new Error(`Failed to fetch config: ${response.status}`);
        
        const configText = await response.text();
        const configJson = configText.match(/window\.appConfig\s*=\s*({[\s\S]*?});/);
        
        if (configJson && configJson[1]) {
            return JSON.parse(configJson[1]);
        }
        throw new Error('Could not extract config from config.js');
    } catch (error) {
        console.error('Error fetching app config:', error);
        return null;
    }
}

/**
 * Initializes service worker version from different sources in order of priority:
 * 1. URL query parameter 
 * 2. App config from config.js
 * 3. Default version (1.0.0)
 * 
 * @returns {Promise<string>} The determined version
 */
async function initializeVersion() {
    console.log("Initializing service worker version...");
    try {
        // Check for existing cache version first
        const { currentCacheExists, existingVersion } = await checkCacheVersion();
        console.log(`Cache check results: currentCacheExists=${currentCacheExists}, existingVersion=${existingVersion}`);
        
        if (currentCacheExists && existingVersion) {
            console.log(`Using existing cache version: ${existingVersion}`);
            CACHE_VERSION = existingVersion;
            CACHE_NAME = cacheNameFor(CACHE_VERSION);
            
            // Send a notification to let clients know about this existing version
            setTimeout(() => notifyClients(), 1000);
            
            return existingVersion;
        }
        
        // Try getting from config.js (second priority)
        const appConfig = await getAppConfig();
        if (appConfig) {
            console.log("Got app config:", JSON.stringify(appConfig, null, 2));
            
            // Take only the version: a server from before scoped names also sends a cacheName, without the path
            if (appConfig.version) {
                console.log(`Found version in config.js: ${appConfig.version}`);
                if (!HAS_RELEASE_VERSION) {
                    CACHE_VERSION = appConfig.version;
                    CACHE_NAME = cacheNameFor(CACHE_VERSION);
                }

                // If the existing cache holds another version than the one this worker caches (config.js's, or
                // the one it was registered with), notify clients about an available update
                if (existingVersion && existingVersion !== CACHE_VERSION) {
                    console.log(`Different version detected: existing=${existingVersion}, new=${CACHE_VERSION}`);
                    setTimeout(() => notifyClients(), 1000);
                }
                
                return CACHE_VERSION;
            }
        }
    } catch (error) {
        console.error("Error initializing version:", error);
    }
    
    // If we reach here, we're using the default version
    console.log(`Using default version: ${CACHE_VERSION}`);
    return CACHE_VERSION;
}

/**
 * Helper to prepend base path to URLs that need it
 * @param {string} url - URL to prepend base path to
 * @returns {string} URL with base path prepended
 */
function getAssetPath(url) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
    }
    return `${BASE_PATH}${url.replace(/^\/+/, '')}`;
}

/**
 * Checks for existing caches and their versions
 * @returns {Promise<Object>} Cache status information
 */
async function checkCacheVersion() {
    const keys = await caches.keys();
    console.log("All cache keys:", keys);
    
    // Find this install's cache: the current one, else its newest (keys come in the order the caches were made),
    // else one named before names carried the install's path, which an upgrade from it migrates. Another install's
    // caches on this origin are not this one's.
    const existingCache = keys.find(key => key === CACHE_NAME) || 
                          keys.filter(isOwnCache).pop() ||
                          keys.find(isLegacyCache);
    
    console.log(`Found existing cache: ${existingCache || 'none'}`);
    
    // Extract version from cache name
    let existingVersion = null;
    if (existingCache) {
        // Try to extract version from different cache name formats
        const versionMatch = existingCache.match(/.*_V(.+)$/) || existingCache.match(/DUMBTERM_CACHE_(.+)$/);
        existingVersion = versionMatch && versionMatch[1] ? versionMatch[1] : null;
        console.log(`Extracted version from cache name: ${existingVersion || 'none'}`);
    }
    
    // Check if current version cache exists
    const currentCacheExists = keys.includes(CACHE_NAME);
    
    console.log(`Cache check: existingVersion=${existingVersion}, currentCacheExists=${currentCacheExists}`);
    
    return {
        currentCacheExists,
        existingVersion,
        isFirstInstall: !existingCache
    };
}

/**
 * Whether a cache is one this install clears: one of its own other than the given one, or one with a name from before
 * names carried the install's path. Another install's caches on this origin are never cleared.
 * @param {string} key - Cache name
 * @param {string} cacheName - The cache to keep
 * @returns {boolean} True if the cache is to be cleared
 */
function isStaleCache(key, cacheName) {
    return key !== cacheName && (isOwnCache(key) || isLegacyCache(key));
}

// Why a fill failed when its cache turned out deleted
const CACHE_LOST = 'The cache was deleted while it was being filled';

/**
 * Whether a cache still holds every asset a fill put in it. A cache deleted while a fill wrote to it took what the
 * fill wrote with it, and one made again under its name since (by the fetch handler, say) holds only what came after.
 * caches.match with a cacheName looks in that cache alone, and makes no cache that isn't there.
 * @param {string} cacheName - The fill's cache
 * @param {string[]} urls - The assets the fill put in it
 * @returns {Promise<boolean>} True if the cache holds each of them
 */
async function holdsAssets(cacheName, urls) {
    // Ignoring Vary: the question is only whether the entry is there
    const found = await Promise.all(urls.map(url => caches.match(url, { cacheName, ignoreVary: true })));
    return found.every(Boolean);
}

/**
 * Whether this worker is still its registration's active worker. While a new version's worker activates, the worker
 * it replaces can still be filling a cache, and each one's cleanup would delete the cache the other fills, so only the
 * active worker clears caches. A worker registered as service-worker.js?v=<version> tells by its script URL. Under one
 * URL for every version (an old page's bare registration) its own ServiceWorker object tells: a worker has one such
 * object per service worker, so self.serviceWorker is the registration's active one only while this worker is. A
 * browser that hands out another object still shows the worker's state, 'activated' only while it is active (a
 * waiting worker is 'installed', a replaced one 'redundant'). A browser without self.serviceWorker (Firefox) can't
 * tell there, and the worker counts as active, as every worker did.
 * A fill the activate event starts doesn't ask (see installCache's activating).
 * @returns {boolean} True if this worker is the registration's active worker, or can't tell it isn't
 */
function isActiveWorker() {
    const active = self.registration.active;
    if (!active || active.scriptURL !== self.location.href) return false;
    const own = self.serviceWorker;
    return !own || own === active || own.state === 'activated';
}

/**
 * Determines if an update notification should be shown
 * @param {string} currentVersion - Current installed version
 * @param {string} newVersion - New available version
 * @returns {boolean} True if update notification should be shown
 */
function shouldShowUpdateNotification(currentVersion, newVersion) {
    console.log(`Checking if update notification should be shown: current=${currentVersion}, new=${newVersion}`);
    
    // Simple case: if we have both versions and they're different, show the notification
    const shouldShow = (
        // Both versions must be valid
        currentVersion && newVersion &&
        // Versions must be different
        currentVersion !== newVersion &&
        // If new version is default, don't show update
        newVersion !== "1.0.0"
    );
    
    console.log(`Should show update notification: ${shouldShow}`);
    return shouldShow;
}

/**
 * Notifies connected clients about version status
 * @returns {Promise<void>}
 */
async function notifyClients() {
    const { existingVersion } = await checkCacheVersion();
    console.log(`Notifying clients - existingVersion: ${existingVersion}, CACHE_VERSION: ${CACHE_VERSION}`);
    
    const clients = await self.clients.matchAll();
    console.log(`Found ${clients.length} clients to notify`);
    
    clients.forEach(client => {
        // Always inform about current version
        client.postMessage({
            type: 'CACHE_VERSION_INFO',
            currentVersion: existingVersion || CACHE_VERSION
        });
        
        // Check if update notification should be shown
        if (shouldShowUpdateNotification(existingVersion, CACHE_VERSION)) {
            console.log(`Sending update notification to client: current=${existingVersion}, new=${CACHE_VERSION}`);
            
            // Wait a brief moment before sending to ensure client is ready
            setTimeout(() => {
                client.postMessage({
                    type: 'UPDATE_AVAILABLE',
                    currentVersion: existingVersion,
                    newVersion: CACHE_VERSION,
                    cacheName: CACHE_NAME
                });
            }, 500); // Increased timeout for better reliability
        }
    });
}

/**
 * Handles initial setup for service worker caching
 * @param {Object} [options]
 * @param {boolean} [options.activating=false] - True when the activate event calls it (see installCache)
 * @returns {Promise<void>}
 */
async function preload({ activating = false } = {}) {
    console.log("Preparing to install web app cache");
    
    // Check cache status
    const { currentCacheExists, existingVersion, isFirstInstall } = await checkCacheVersion();
    
    // If current version cache already exists, no need to reinstall
    if (currentCacheExists) {
        console.log(`Cache ${CACHE_NAME} already exists, using existing cache`);
        await notifyClients(); // Still check if we need to notify about updates
        return;
    }
    
    // For updates (not first-time installations), notify but don't update automatically
    if (!isFirstInstall && existingVersion !== CACHE_VERSION) {
        console.log(`New version ${CACHE_VERSION} available (current: ${existingVersion})`);
        await notifyClients();
        return;
    }
    
    // First-time installation case - no existing cache
    if (isFirstInstall) {
        console.log(`First-time installation: creating cache with version ${CACHE_VERSION}`);
        await installCache(true, undefined, { activating }); // Pass true to indicate first installation
    }
}

/**
 * Installs or updates the service worker cache
 * @param {boolean} isFirstInstall - True for a fill the worker starts itself (activating a version, or the first
 * install a page's SET_VERSION starts), false for one the user asked for with Update Now. Only a failed fill the
 * user asked for is reported to the page.
 * @param {string} [requestId] - The id of the Update Now that asked for this fill. Every tab hears the answer, so it
 * names the request, and the tab that sent it knows the answer is its own
 * @param {Object} [options]
 * @param {boolean} [options.activating=false] - True for a fill the activate event starts. The event fires only at the
 * worker becoming the active one, and no successor activates before the event's work ends, so the fill clears older
 * caches without asking isActiveWorker: a browser can name the worker as the registration's active one late
 * @param {boolean} [options.refilling=false] - True for the one fill a lost fill makes again (see below)
 * @returns {Promise<string>} 'filled' when the fill's cache still holds its assets once the fill is done, 'lost' when
 * it was deleted while the fill filled it or cleared the older ones, 'failed' when the fill failed otherwise
 */
async function installCache(isFirstInstall = false, requestId, { activating = false, refilling = false } = {}) {
    // In a worker registered without a release version, a page's SET_VERSION can change CACHE_VERSION and CACHE_NAME
    // while this fill waits on the network, so fill, keep and report the version this fill started with
    const version = CACHE_VERSION;
    const cacheName = CACHE_NAME;
    console.log(`${isFirstInstall ? 'First-time installation' : 'Updating'} cache to version ${version}`);
    CACHES_BEING_FILLED.push(cacheName);
    let outcome;
    let lostWhileFilling = false;
    let failure;
    let assetsToCache;
    
    try {
        // Fetch and cache assets. The manifest comes first so that a failed request leaves no empty cache behind.
        console.log("Fetching asset manifest...");
        const response = await fetch(getAssetPath("assets/asset-manifest.json"));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        // Build the list for this fill only: addAll rejects a list that names an asset twice, so one
        // kept across fills would fail every fill after the first in this worker's lifetime
        const assets = await response.json();
        assetsToCache = assets.map(asset => getAssetPath(asset));
        
        console.log("Caching assets:", assetsToCache);
        const cache = await caches.open(cacheName);
        await cache.addAll(assetsToCache);
        // What a fill writes into a cache deleted meanwhile (by another worker's cleanup, say) goes with it, so a fill
        // whose cache is gone, or made again without its assets, has failed, and clears nothing: the older caches are
        // what still works offline
        if (!(await holdsAssets(cacheName, assetsToCache))) {
            lostWhileFilling = true;
            throw new Error(CACHE_LOST);
        }
        console.log("Assets cached successfully");
        
        // Clear old caches only now that the new one is filled: until then they are what works offline.
        // A cache another fill is still filling is left alone: that fill keeps it if it succeeds, and the next fill
        // clears it if it fails. Only the active worker clears them: a worker whose successor has activated can't see
        // which caches the successor's fills are filling. What such a worker leaves stays until the active worker's
        // next fill, which may be the next release's activation. One that can't tell it was replaced still clears, and
        // can delete the cache a fill of its successor fills; that fill may then fill it once more (see below).
        if (activating || isActiveWorker()) {
            const oldCaches = (await caches.keys())
                .filter(key => isStaleCache(key, cacheName) && !CACHES_BEING_FILLED.includes(key));
            if (oldCaches.length > 0) {
                console.log(`Deleting old caches: ${oldCaches}`);
                await Promise.all(
                    oldCaches.map(key => caches.delete(key))
                );
            }
        }
        
        outcome = 'filled';
    } catch (error) {
        console.error("Failed to cache assets:", error);
        failure = error;
        outcome = lostWhileFilling ? 'lost' : 'failed';
    } finally {
        CACHES_BEING_FILLED.splice(CACHES_BEING_FILLED.indexOf(cacheName), 1);
    }
    // Another worker's cleanup can delete the cache even after this fill checked it: one that can't tell it was
    // replaced does, when it runs while this fill clears the older caches, and leaves no cache at all
    if (outcome === 'filled' && !(await holdsAssets(cacheName, assetsToCache))) {
        outcome = 'lost';
        failure = new Error(CACHE_LOST);
    }
    // A fill of the activate event that lost its cache, or an Update Now whose cache was deleted after it checked it
    // (by a worker this one replaced that can't tell it was, say), fills it once more and reports how that went. Not
    // an Update Now whose cache was deleted while it filled it: the active worker deleted that cache as an older one,
    // and filling it again would have a worker that can't tell it was replaced clear the active worker's cache. Nor
    // when a page has named another version since: that fill would fill the page's version instead.
    const refills = activating || (!isFirstInstall && !lostWhileFilling);
    if (outcome === 'lost' && refills && !refilling && CACHE_NAME === cacheName) {
        return installCache(isFirstInstall, requestId, { activating, refilling: true });
    }
    
    // Tell the pages how the fill ended, once it has. Only a failed fill the user asked for is reported as failed:
    // nobody is waiting on a fill the worker started itself, and the previous version's cache is still there
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            if (!isFirstInstall) {
                const answer = { type: 'UPDATE_COMPLETE', version, cacheName, requestId };
                client.postMessage(outcome === 'filled'
                    ? { ...answer, success: true }
                    : { ...answer, success: false, error: failure.message });
            }
            client.postMessage({ type: 'CACHE_VERSION_INFO', currentVersion: version, cacheName });
        });
    });
    return outcome;
}

// Service Worker event listeners
self.addEventListener("install", event => {
    console.log("Service Worker installing...");
    
    event.waitUntil(
        // Initialize version first, then skip waiting to activate immediately
        initializeVersion()
            .then(() => self.skipWaiting())
            .catch(error => {
                console.error("Error during service worker installation:", error);
            })
    );
});

self.addEventListener("activate", event => {
    console.log("Service Worker activating...");
    
    event.waitUntil(
        Promise.resolve()
            .then(async () => {
                // Take control of all clients
                await self.clients.claim();
                console.log("Service worker has claimed clients");

                // Fetches are network-first, so pages already run this version: fill its cache now, which also
                // deletes the older caches once it succeeds. A successful fill leaves no older cache of this install
                // (unless another fill was running), so one still there means this version's last fill failed or never
                // ran and is worth another try.
                if (CACHE_VERSION !== "1.0.0") {
                    const keys = await caches.keys();
                    if (!keys.includes(CACHE_NAME) || keys.some(key => isStaleCache(key, CACHE_NAME))) {
                        await installCache(true, undefined, { activating: true });
                    } else {
                        await notifyClients();
                    }
                    return;
                }

                // Check cache status
                const { isFirstInstall, existingVersion } = await checkCacheVersion();
                
                console.log(`Activation - isFirstInstall: ${isFirstInstall}, existingVersion: ${existingVersion}, CACHE_VERSION: ${CACHE_VERSION}`);
                
                // First-time install: set up cache immediately
                if (isFirstInstall) {
                    console.log("First-time installation detected, setting up cache");
                    await preload({ activating: true });
                } else {
                    // Existing installation: check for updates and notify clients
                    console.log("Existing installation detected, checking for updates");
                    
                    // Refresh CACHE_VERSION from config if needed
                    if (CACHE_VERSION === "1.0.0" || !existingVersion) {
                        try {
                            const appConfig = await getAppConfig();
                            if (appConfig && appConfig.version) {
                                CACHE_VERSION = appConfig.version;
                                CACHE_NAME = cacheNameFor(CACHE_VERSION);
                                console.log(`Updated version from config: ${CACHE_VERSION}`);
                            }
                        } catch (error) {
                            console.error("Error getting config version during activation:", error);
                        }
                    }
                    
                    // Always notify clients on activation
                    await notifyClients();
                    
                    // If versions differ, call preload to handle update logic
                    if (existingVersion !== CACHE_VERSION) {
                        console.log(`Version difference detected on activation: existing=${existingVersion}, new=${CACHE_VERSION}`);
                        await preload({ activating: true });
                    }
                }
            })
            .catch(error => {
                console.error("Error during service worker activation:", error);
            })
    );
});

self.addEventListener("fetch", event => {
    // Only GET responses can be cached; let the browser send everything else as normal
    if (event.request.method !== 'GET') return;

    // Network first, cache as the offline fallback. Serving from the cache first meant a returning
    // browser kept getting the previous release's config.js and scripts, so it never noticed an update.
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Keep a copy of valid responses for offline use; a redirected response (e.g. to /login
                // when signed out) would be stored under the wrong URL
                if (response && response.status === 200 && response.type === 'basic' && !response.redirected) {
                    const responseToCache = response.clone();
                    event.waitUntil(
                        caches.open(CACHE_NAME)
                            .then(cache => cache.put(event.request, responseToCache))
                            .catch(error => console.warn('Could not cache response:', error))
                    );
                }
                return response;
            })
            .catch(async () => {
                const cachedResponse = await caches.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }
                // Return fallback for navigation requests
                if (event.request.mode === 'navigate') {
                    return caches.match(getAssetPath('index.html'));
                }
                return new Response('Network error happened', {
                    status: 408,
                    headers: { 'Content-Type': 'text/plain' },
                });
            })
    );
});

// Message handling
self.addEventListener('message', async event => {
    const { data } = event;
    
    if (!data || !data.type) return;
    
    console.log(`Received message from client: ${data.type}`, data);
    
    switch (data.type) {
        case 'SET_VERSION':
            await handleSetVersion(data.version);
            break;
            
        case 'GET_VERSION':
            await handleGetVersion(event);
            break;
            
        case 'PERFORM_UPDATE':
            await handlePerformUpdate(data.requestId);
            break;
            
        case 'CHECK_FOR_UPDATES':
            // Force a check for updates and notify clients
            console.log("Client requested update check");
            setTimeout(() => notifyClients(), 500);
            break;
    }
});

/**
 * Handles SET_VERSION messages from the client. A worker registered with a release version keeps it, so it takes
 * the version only when registered without one (see HAS_RELEASE_VERSION)
 * @param {string} version - Version sent from client. A cacheName beside it (pages before scoped names sent one) is
 * ignored: this install's cache is named after its path
 */
async function handleSetVersion(version) {
    if (!version) return;
    
    console.log(`Received version from client: ${version}`);
    
    // Check current cache status
    const { existingVersion, isFirstInstall } = await checkCacheVersion();
    
    // Only update if different from current, and only in a worker registered without a release version
    if (version !== CACHE_VERSION && !HAS_RELEASE_VERSION) {
        const previousVersion = CACHE_VERSION;
        CACHE_VERSION = version;
        CACHE_NAME = cacheNameFor(CACHE_VERSION);
        
        console.log(`Updated cache version from ${previousVersion} to ${CACHE_VERSION}`);
        
        // For first-time installations, install cache immediately
        if (isFirstInstall) {
            console.log("First-time installation with SET_VERSION - installing cache");
            await installCache(true);
        } 
        // For meaningful version changes, check if update is needed
        else if (previousVersion !== "1.0.0") {
            console.log(`Version change detected: ${previousVersion} → ${CACHE_VERSION}`);
            await preload();
        }
        // Otherwise just update the UI
        else {
            await notifyClients();
        }
    } else {
        console.log(`Keeping version ${CACHE_VERSION}`);
        await notifyClients();
    }
}

/**
 * Handles GET_VERSION messages from the client
 * @param {MessageEvent} event - Original message event with ports
 */
async function handleGetVersion(event) {
    // Get cache status
    const { existingVersion, isFirstInstall } = await checkCacheVersion();
    console.log(`Handling GET_VERSION - existingVersion: ${existingVersion}, isFirstInstall: ${isFirstInstall}, current CACHE_VERSION: ${CACHE_VERSION}`);
    
    // If default version, try to get from config
    if (CACHE_VERSION === "1.0.0") {
        try {
            const appConfig = await getAppConfig();
            if (appConfig && appConfig.version) {
                CACHE_VERSION = appConfig.version;
                CACHE_NAME = cacheNameFor(CACHE_VERSION);
                console.log(`Using version from config: ${CACHE_VERSION}`);
            }
        } catch (error) {
            console.error("Error getting config version:", error);
        }
    }
    
    // For first-time installs, report the current version to avoid update prompts
    const versionToReport = isFirstInstall ? CACHE_VERSION : (existingVersion || CACHE_VERSION);
    
    console.log(`Reporting versions - current: ${versionToReport}, new: ${CACHE_VERSION}`);
    
    // Create a consistent update available message based on version comparison
    const updateMessage = {
        currentVersion: versionToReport,
        newVersion: CACHE_VERSION,
        cacheName: CACHE_NAME
    };
    
    // Send version via message channel if available
    if (event.ports && event.ports[0]) {
        event.ports[0].postMessage(updateMessage);
        console.log("Sent version via message port");
    }
    
    // Also broadcast to all clients
    const clients = await self.clients.matchAll();
    console.log(`Broadcasting to ${clients.length} clients`);
    
    clients.forEach(client => {
        // Send version info
        client.postMessage({
            type: 'CACHE_VERSION_INFO',
            currentVersion: versionToReport,
            cacheName: CACHE_NAME
        });
        
        // Also send update notification if needed
        if (shouldShowUpdateNotification(versionToReport, CACHE_VERSION)) {
            console.log(`Sending direct update notification from GET_VERSION handler`);
            setTimeout(() => {
                client.postMessage({
                    type: 'UPDATE_AVAILABLE',
                    currentVersion: versionToReport,
                    newVersion: CACHE_VERSION,
                    cacheName: CACHE_NAME
                });
            }, 750); // Use a longer timeout to ensure client is ready
        }
    });
}

/**
 * Handles PERFORM_UPDATE messages from the client
 * @param {string} [requestId] - The page's id for this Update Now, named in the answer
 */
async function handlePerformUpdate(requestId) {
    console.log("User confirmed update, installing cache");
    await installCache(false, requestId);
}