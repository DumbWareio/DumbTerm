// Core service worker configuration
// The page registers this worker as service-worker.js?v=<app version>, so read the version from there:
// a worker the browser restarts after idling would otherwise start at 1.0.0 and cache into a stray cache
const REGISTERED_VERSION = new URL(self.location.href).searchParams.get('v');
let CACHE_VERSION = /^\d+\.\d+\.\d+/.test(REGISTERED_VERSION || '') ? REGISTERED_VERSION : "1.0.0"; // Default fallback version
let CACHE_NAME = `DUMBTERM_CACHE_V${CACHE_VERSION}`; // Default format, will be overridden
const ASSETS_TO_CACHE = [];
const BASE_PATH = self.registration.scope;

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
            CACHE_NAME = `DUMBTERM_CACHE_V${CACHE_VERSION}`; // Fallback format
            
            // Send a notification to let clients know about this existing version
            setTimeout(() => notifyClients(), 1000);
            
            return existingVersion;
        }
        
        // Try getting from config.js (second priority)
        const appConfig = await getAppConfig();
        if (appConfig) {
            console.log("Got app config:", JSON.stringify(appConfig, null, 2));
            
            if (appConfig.cacheName) {
                console.log(`Found cacheName in config.js: ${appConfig.cacheName}`);
                CACHE_NAME = appConfig.cacheName;
                
                // Extract version from cacheName if possible
                const versionMatch = CACHE_NAME.match(/.*_V(.+)$/);
                if (versionMatch && versionMatch[1]) {
                    CACHE_VERSION = versionMatch[1];
                    console.log(`Extracted version from cacheName: ${CACHE_VERSION}`);
                } else if (appConfig.version) {
                    CACHE_VERSION = appConfig.version;
                    console.log(`Using version from config.js: ${CACHE_VERSION}`);
                }
                
                // If we have an existing version that's different from what we just loaded,
                // we should notify clients about an available update
                if (existingVersion && existingVersion !== CACHE_VERSION) {
                    console.log(`Different version detected: existing=${existingVersion}, new=${CACHE_VERSION}`);
                    setTimeout(() => notifyClients(), 1000);
                }
                
                return CACHE_VERSION;
            } else if (appConfig.version) {
                console.log(`Found version in config.js: ${appConfig.version}`);
                CACHE_VERSION = appConfig.version;
                CACHE_NAME = appConfig.cacheName || `DUMBTERM_CACHE_V${CACHE_VERSION}`; // Fallback format
                
                // If we have an existing version that's different from what we just loaded,
                // we should notify clients about an available update
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
    
    // Find any existing DumbTerm cache - support both formats: DUMBTERM_PWA_CACHE_V* and DUMBTERM_CACHE_V*
    const existingCache = keys.find(key => key === CACHE_NAME) || 
                          keys.find(key => key.startsWith('DUMBTERM_CACHE_V')) ||
                          keys.find(key => key.startsWith('DUMBTERM_PWA_CACHE_V'));
    
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
    
    // Check for old versions - be flexible with the cache naming format
    const oldCaches = keys.filter(key => 
        key !== CACHE_NAME && (key.startsWith('DUMBTERM_') && 
        ((key.includes('_CACHE_') || key.includes('PWA_CACHE')) && key.includes('V'))) 
    );
    
    console.log(
        `Cache check: existingVersion=${existingVersion}, ` +
        `currentCacheExists=${currentCacheExists}, hasOldVersions=${oldCaches.length > 0}`
    );
    
    return {
        currentCacheExists,
        oldCaches,
        existingVersion,
        isFirstInstall: !existingCache
    };
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
 * @returns {Promise<void>}
 */
async function preload() {
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
        await installCache(true); // Pass true to indicate first installation
    }
}

/**
 * Installs or updates the service worker cache
 * @param {boolean} isFirstInstall - Whether this is a first-time installation
 * @returns {Promise<void>}
 */
async function installCache(isFirstInstall = false) {
    console.log(`${isFirstInstall ? 'First-time installation' : 'Updating'} cache to version ${CACHE_VERSION}`);
    const cache = await caches.open(CACHE_NAME);
    
    try {
        // Clear old caches
        const { oldCaches } = await checkCacheVersion();
        if (oldCaches.length > 0) {
            console.log(`Deleting old caches: ${oldCaches}`);
            await Promise.all(
                oldCaches.map(key => caches.delete(key))
            );
        }

        // Fetch and cache assets
        console.log("Fetching asset manifest...");
        const response = await fetch(getAssetPath("assets/asset-manifest.json"));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const assets = await response.json();
        const processedAssets = assets.map(asset => getAssetPath(asset));
        ASSETS_TO_CACHE.push(...processedAssets);
        
        console.log("Caching assets:", ASSETS_TO_CACHE);
        await cache.addAll(ASSETS_TO_CACHE);
        console.log("Assets cached successfully");
        
        // Notify clients
        self.clients.matchAll().then(clients => {
            clients.forEach(client => {
                if (isFirstInstall) {
                    // For first-time installations, just update the version display
                    client.postMessage({
                        type: 'CACHE_VERSION_INFO',
                        currentVersion: CACHE_VERSION,
                        cacheName: CACHE_NAME
                    });
                } else {
                    // For updates, notify about completion and update version display
                    client.postMessage({
                        type: 'UPDATE_COMPLETE',
                        version: CACHE_VERSION,
                        cacheName: CACHE_NAME,
                        success: true
                    });
                    
                    // Also send specific version info message to maintain compatibility
                    client.postMessage({
                        type: 'CACHE_VERSION_INFO',
                        currentVersion: CACHE_VERSION,
                        cacheName: CACHE_NAME
                    });
                }
            });
        });
    } catch (error) {
        console.error("Failed to cache assets:", error);
        
        // Notify clients of failure
        self.clients.matchAll().then(clients => {
            clients.forEach(client => {
                client.postMessage({
                    type: 'UPDATE_COMPLETE',
                    version: CACHE_VERSION,
                    cacheName: CACHE_NAME,
                    success: false,
                    error: error.message
                });
                
                // Still send version info for UI consistency
                client.postMessage({
                    type: 'CACHE_VERSION_INFO',
                    currentVersion: CACHE_VERSION,
                    cacheName: CACHE_NAME
                });
            });
        });
    }
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

                // Fetches are network-first, so pages already run this version and older caches are only
                // dead weight; removing them also stops them being reported as the installed version
                if (CACHE_VERSION !== "1.0.0") {
                    const staleCaches = (await caches.keys())
                        .filter(key => key.startsWith('DUMBTERM_') && key !== CACHE_NAME);
                    await Promise.all(staleCaches.map(key => caches.delete(key)));
                    if (staleCaches.length > 0) {
                        console.log(`Deleted old caches: ${staleCaches}`);
                    }
                }
                
                // Check cache status
                const { isFirstInstall, existingVersion } = await checkCacheVersion();
                
                console.log(`Activation - isFirstInstall: ${isFirstInstall}, existingVersion: ${existingVersion}, CACHE_VERSION: ${CACHE_VERSION}`);
                
                // First-time install: set up cache immediately
                if (isFirstInstall) {
                    console.log("First-time installation detected, setting up cache");
                    await preload();
                } else {
                    // Existing installation: check for updates and notify clients
                    console.log("Existing installation detected, checking for updates");
                    
                    // Refresh CACHE_VERSION from config if needed
                    if (CACHE_VERSION === "1.0.0" || !existingVersion) {
                        try {
                            const appConfig = await getAppConfig();
                            if (appConfig && appConfig.version) {
                                CACHE_VERSION = appConfig.version;
                                CACHE_NAME = appConfig.cacheName || `DUMBTERM_CACHE_V${CACHE_VERSION}`;
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
                        await preload();
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
            await handleSetVersion(data.version, data.cacheName);
            break;
            
        case 'GET_VERSION':
            await handleGetVersion(event);
            break;
            
        case 'PERFORM_UPDATE':
            await handlePerformUpdate();
            break;
            
        case 'CHECK_FOR_UPDATES':
            // Force a check for updates and notify clients
            console.log("Client requested update check");
            setTimeout(() => notifyClients(), 500);
            break;
    }
});

/**
 * Handles SET_VERSION messages from the client
 * @param {string} version - Version sent from client
 * @param {string} cacheName - Optional cache name from client
 */
async function handleSetVersion(version, cacheName) {
    if (!version) return;
    
    console.log(`Received version from client: ${version}${cacheName ? `, cacheName: ${cacheName}` : ''}`);
    
    // Check current cache status
    const { existingVersion, isFirstInstall } = await checkCacheVersion();
    
    // Only update if non-default version and different from current
    if (version !== CACHE_VERSION) {
        const previousVersion = CACHE_VERSION;
        CACHE_VERSION = version;
        
        // Use cacheName if provided directly in the message
        if (cacheName) {
            CACHE_NAME = cacheName;
            console.log(`Using cacheName from message: ${CACHE_NAME}`);
        } else {
            // Try to get cache name from config as fallback
            try {
                const appConfig = await getAppConfig();
                CACHE_NAME = appConfig?.cacheName || `DUMBTERM_CACHE_V${CACHE_VERSION}`;
            } catch (error) {
                // Fall back to constructed cache name on error
                CACHE_NAME = `DUMBTERM_CACHE_V${CACHE_VERSION}`;
                console.log(`Error getting config, using constructed cache name: ${CACHE_NAME}`);
            }
        }
        
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
        console.log(`No version change needed, current: ${CACHE_VERSION}`);
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
            if (appConfig) {
                if (appConfig.cacheName) {
                    console.log(`Using cacheName from config: ${appConfig.cacheName}`);
                    CACHE_NAME = appConfig.cacheName;
                    
                    // Try to extract version from cacheName
                    const versionMatch = CACHE_NAME.match(/.*_V(.+)$/) || CACHE_NAME.match(/DUMBTERM_CACHE_(.+)$/);
                    if (versionMatch && versionMatch[1]) {
                        CACHE_VERSION = versionMatch[1];
                        console.log(`Extracted version from cacheName: ${CACHE_VERSION}`);
                    }
                }
                
                if (appConfig.version && (CACHE_VERSION === "1.0.0" || !appConfig.cacheName)) {
                    CACHE_VERSION = appConfig.version;
                    if (!appConfig.cacheName) {
                        CACHE_NAME = `DUMBTERM_CACHE_V${CACHE_VERSION}`;
                    }
                    console.log(`Using version from config: ${CACHE_VERSION}`);
                }
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
 */
async function handlePerformUpdate() {
    console.log("User confirmed update, installing cache");
    await installCache(false);
}