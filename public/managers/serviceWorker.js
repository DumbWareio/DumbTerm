/**
 * ServiceWorkerManager.js
 * Manages the registration and communication with the service worker
 * for version checking, updates, and caching.
 */

export default class ServiceWorkerManager {
    constructor() {
        // Tracking variables
        this.updateTimeout = null;
        this.updateNotificationActive = false;
        this.lastCheckedVersionPair = null;
        this._receivedCacheName = null;
        // The version the user put off with Later
        this.dismissedVersion = null;
        // The Update Now under way, which the update timeout and Later call off
        this.updateAttempt = null;
        
        // Initialize with basePath from config
        this.basePath = window.appConfig?.basePath || '';
    }

    /**
     * Initialize the service worker manager
     * @param {Function} updateVersionDisplayCallback - Callback to update the version display in the UI
     */
    initialize(updateVersionDisplayCallback) {
        if (!("serviceWorker" in navigator)) {
            // If service workers are not supported, still update the version display with app config
            if (updateVersionDisplayCallback && window.appConfig?.version) {
                updateVersionDisplayCallback(window.appConfig.version);
            }
            // The page can still ask the server whether it was upgraded, e.g. on plain http to a LAN address,
            // where browsers offer no service workers
            this.setupPeriodicVersionCheck();
            return;
        }
        
        // Pages are fetched network-first, so the page's own config.js is the version it runs. The cache and
        // the worker can report another release during an upgrade, so every display prefers the page's version.
        this.updateVersionDisplayCallback = (version, loading) => updateVersionDisplayCallback(
            loading ? version : (window.appConfig?.version || version), loading);
        
        // Set up the service worker
        this.registerServiceWorker();
        this.setupServiceWorkerMessageHandlers();
        this.setupPeriodicVersionCheck();

        // Immediately check for version in cache and update display, don't wait for service worker
        this.getCurrentCacheVersion().then(cacheInfo => {
            if (cacheInfo.version && this.updateVersionDisplayCallback) {
                this.updateVersionDisplayCallback(cacheInfo.version);
            } else {
                // Otherwise see whether the server runs another version
                this.checkVersion();
            }
        }).catch(() => {
            // If there's an error getting the cache version, fall back to the regular check
            this.checkVersion();
        });
        
        // Set a timeout to ensure the version display is updated even if service worker is delayed
        setTimeout(() => {
            if (this.updateVersionDisplayCallback) {
                const versionDisplay = document.getElementById('version-display');
                if (versionDisplay && versionDisplay.classList.contains('loading')) {
                    console.log('Version display still loading after timeout, using app config version');
                    this.updateVersionDisplayCallback(window.appConfig?.version || "");
                }
            }
        }, 2000); // 2 second timeout
    }

    /**
     * Registers the service worker
     */
    registerServiceWorker() {
        // Set version display to loading state until we have version info
        if (this.updateVersionDisplayCallback) {
            this.updateVersionDisplayCallback(null, true); // true indicates loading state
        }
        
        // Add cache-busting version parameter to service worker URL
        const swVersion = window.appConfig?.version || new Date().getTime();
        const swUrl = this.joinPath(`service-worker.js?v=${swVersion}`);
        console.log(`Registering service worker with version param: ${swVersion}`);
        
        navigator.serviceWorker.register(swUrl)
            .then(registration => {
                console.log("Service Worker registered:", registration.scope);
                
                // Check if a service worker is already controlling the page
                const isFirstLoad = !navigator.serviceWorker.controller;
                
                // Send the app version to any active service worker
                if (window.appConfig?.version) {
                    this.sendVersionToServiceWorker(window.appConfig.version);
                }
                
                // On first load or hard reload, we need to be more proactive
                if (isFirstLoad) {
                    console.log("First load or hard reload detected - checking cache directly");
                    // First immediately try to get version from cache
                    this.getCurrentCacheVersion().then(cacheInfo => {
                        if (cacheInfo.version && this.updateVersionDisplayCallback) {
                            console.log(`Updating version display with cache version: ${cacheInfo.version}`);
                            this.updateVersionDisplayCallback(cacheInfo.version);
                        } else if (window.appConfig?.version && this.updateVersionDisplayCallback) {
                            // If no cache version, fall back to app config version
                            console.log(`No cache version found, using app config version: ${window.appConfig.version}`);
                            this.updateVersionDisplayCallback(window.appConfig.version);
                        }
                    }).catch(error => {
                        console.error("Error getting cache version:", error);
                        // Fall back to app config version on error
                        if (window.appConfig?.version && this.updateVersionDisplayCallback) {
                            this.updateVersionDisplayCallback(window.appConfig.version);
                        }
                    });
                } else {
                    // Normal load (not hard reload), use the regular check
                    this.checkVersion();
                }
            })
            .catch(error => console.error("Service Worker registration failed:", error));
    }

    /**
     * Sets up message event listeners for the service worker
     */
    setupServiceWorkerMessageHandlers() {
        navigator.serviceWorker.addEventListener('message', event => {
            if (!event.data || !event.data.type) return;
            
            switch (event.data.type) {
                case 'UPDATE_AVAILABLE':
                    // Store cacheName if provided in the message
                    if (event.data.cacheName) {
                        console.log(`Received cacheName in update message: ${event.data.cacheName}`);
                        // Use it as a local cached value for later use
                        this._receivedCacheName = event.data.cacheName;
                    }
                    this.showUpdateNotification(event.data.currentVersion, event.data.newVersion);
                    break;
                    
                case 'UPDATE_COMPLETE':
                    this.handleUpdateComplete(event.data);
                    break;
                    
                case 'CACHE_VERSION_INFO':
                    // Store cacheName if provided
                    if (event.data.cacheName) {
                        console.log(`Received cacheName in version info: ${event.data.cacheName}`);
                        this._receivedCacheName = event.data.cacheName;
                    }
                    // Update the version display
                    if (this.updateVersionDisplayCallback) {
                        this.updateVersionDisplayCallback(event.data.currentVersion);
                    }
                    break;
            }
        });
    }

    /**
     * Sets up periodic version checking when page is visible
     */
    setupPeriodicVersionCheck() {
        // Check for updates when the page becomes visible, except for a version put off with Later: switching
        // back to the page happens too often to ask again each time
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.checkVersion({ offerDismissed: false });
            }
        });
        
        // An upgrade restarts the server, so a terminal tab reconnecting is when a page left open can find out
        window.addEventListener('dumbterm:reconnected', () => this.checkVersion());
        
        // Also check periodically for version updates (every hour)
        setInterval(() => this.checkVersion(), 60 * 60 * 1000);
    }

    /**
     * Sends version information to all possible service worker targets
     * @param {string} version - Version to send
     */
    sendVersionToServiceWorker(version) {
        if (!version) return;
        
        // Message to send with version and optional cacheName
        const message = {
            type: 'SET_VERSION',
            version: version
        };
        
        // Include cacheName if available in config
        if (window.appConfig?.cacheName) {
            message.cacheName = window.appConfig.cacheName;
            console.log(`Including cacheName in message to service worker: ${window.appConfig.cacheName}`);
        }
        
        // Try to send to the controller if it exists
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage(message);
        }
        
        // Also send through the ready promise to ensure we reach the active worker
        navigator.serviceWorker.ready.then(registration => {
            if (registration.active) {
                registration.active.postMessage(message);
            }
            if (registration.waiting) {
                registration.waiting.postMessage(message);
            }
        });
    }

    /**
     * Asks the server which version it runs, and offers the update when it is not the page's.
     * The worker can't tell: it was registered as service-worker.js?v=<page version> and goes on reporting that
     * version after the server is upgraded, until another page load registers the new one
     * @param {Object} [options]
     * @param {boolean} [options.offerDismissed=true] - Whether to offer again a version put off with Later
     * @returns {Promise<void>}
     */
    async checkVersion({ offerDismissed = true } = {}) {
        // Skip check if an update notification is already active
        if (this.updateNotificationActive) {
            console.log("Update notification already active, skipping version check");
            return;
        }
        
        let serverVersion;
        try {
            serverVersion = await this.getServerVersion();
        } catch (error) {
            // Offline, or the server is restarting: say nothing, the next check asks again
            console.log("Could not check the server's version:", error);
            return;
        }
        
        const pageVersion = window.appConfig?.version;
        console.log(`Version check: page=${pageVersion}, server=${serverVersion}`);
        if (!offerDismissed && serverVersion === this.dismissedVersion) {
            return;
        }
        if (this.shouldShowUpdateNotification(pageVersion, serverVersion)) {
            this.showUpdateNotification(pageVersion, serverVersion, true);
        }
    }

    /**
     * Asks the server which version it runs, from the header it sends with config.js
     * @param {AbortSignal} [signal] - Calls the request off
     * @returns {Promise<string|null>} The server's version, or null when it doesn't say
     * @throws When the server can't be reached or answers with an error
     */
    async getServerVersion(signal) {
        // A HEAD request: the worker leaves requests other than GET to the network, so the answer is never a copy
        // it kept, and it keeps none (a GET would leave the new config.js in the old version's cache, for the old
        // page to load offline). no-store keeps the browser's HTTP cache out of it too
        const response = await fetch(this.joinPath('config.js'), { method: 'HEAD', cache: 'no-store', signal });
        if (!response.ok) throw new Error(`Failed to reach the server: ${response.status}`);
        return response.headers.get('X-DumbTerm-Version');
    }

    /**
     * Gets the currently installed cache version directly
     * @returns {Promise<Object>} Cache version information
     */
    async getCurrentCacheVersion() {
        try {
            console.log('Attempting to get cache version directly from cache storage');
            
            // First check if we already have a cached version from service worker messages
            if (this._receivedCacheName) {
                console.log(`Using previously received cacheName: ${this._receivedCacheName}`);
                // Try to extract version from the cached cacheName
                const versionMatch = this._receivedCacheName.match(/.*_V(.+)$/) || 
                                    this._receivedCacheName.match(/DUMBTERM_CACHE_(.+)$/);
                
                if (versionMatch && versionMatch[1]) {
                    const version = versionMatch[1];
                    console.log(`Extracted version from cached cacheName: ${version}`);
                    return {
                        version: version,
                        cacheName: this._receivedCacheName,
                        isFirstInstall: false
                    };
                }
            }
            
            // Get version from cache storage
            const configCacheName = window.appConfig?.cacheName;
            
            const cacheKeys = await caches.keys();
            console.log('Available caches:', cacheKeys);
            
            // Support both formats: DUMBTERM_PWA_CACHE_V* and DUMBTERM_CACHE_* or any from config
            const dumbTermCaches = cacheKeys.filter(key => 
                (configCacheName && key === configCacheName) || 
                (key.startsWith('DUMBTERM_') && (key.includes('_V') || key.includes('_CACHE_')))
            );
            
            if (dumbTermCaches.length === 0) {
                console.log('No DumbTerm cache found');
                return {
                    version: window.appConfig?.version || null,
                    cacheName: configCacheName || null,
                    isFirstInstall: true
                };
            }
            
            // If config cacheName exists and is in the list, prioritize it
            let latestCache;
            if (configCacheName && dumbTermCaches.includes(configCacheName)) {
                latestCache = configCacheName;
                console.log(`Using config-specified cacheName: ${latestCache}`);
            } else {
                // Otherwise sort caches by version to get the latest
                dumbTermCaches.sort((a, b) => {
                    // Extract version from different patterns
                    const getVersion = (cacheName) => {
                        const vMatch = cacheName.match(/.*_V(.+)$/) || cacheName.match(/DUMBTERM_CACHE_(.+)$/);
                        return vMatch && vMatch[1] ? vMatch[1] : '';
                    };
                    const versionA = getVersion(a);
                    const versionB = getVersion(b);
                    return versionB.localeCompare(versionA);
                });
                latestCache = dumbTermCaches[0];
                console.log(`Selected latest cache: ${latestCache}`);
            }
            
            // Extract version from cacheName
            let version;
            const versionMatch = latestCache.match(/.*_V(.+)$/) || latestCache.match(/DUMBTERM_CACHE_(.+)$/);
            version = versionMatch && versionMatch[1] ? versionMatch[1] : window.appConfig?.version || null;
            
            console.log(`Found cache version: ${version}, cacheName: ${latestCache}`);
            
            // Store the cacheName for future use
            this._receivedCacheName = latestCache;
            
            return {
                version: version,
                cacheName: latestCache,
                isFirstInstall: false,
                allCaches: dumbTermCaches
            };
        } catch (error) {
            console.error('Error getting cache version:', error);
            
            // On error, fall back to app config
            const fallbackVersion = window.appConfig?.version || null;
            console.log(`Falling back to app config version: ${fallbackVersion}`);
            
            return {
                version: fallbackVersion,
                error: error.message,
                isFirstInstall: true
            };
        }
    }

    /**
     * Determines if an update notification should be shown
     * @param {string} currentVersion - Current version
     * @param {string} newVersion - New version
     * @returns {boolean} True if notification should be shown
     */
    shouldShowUpdateNotification(currentVersion, newVersion) {
        const result = (
            // Both versions must exist
            currentVersion && newVersion && 
            // Versions must be different
            currentVersion !== newVersion &&
            // New version shouldn't be default
            newVersion !== "1.0.0" &&
            // and must look like a version, as the worker requires of the one it is registered with
            /^\d+\.\d+\.\d+/.test(newVersion) &&
            // The service worker fetches network-first, so a page already running the new version
            // (config.js is always fresh) has nothing left to update
            newVersion !== window.appConfig?.version
        );
        
        console.log(`Client shouldShowUpdateNotification check: current=${currentVersion}, new=${newVersion}, result=${result}`);
        return result;
    }

    /**
     * Shows a notification when updates are available
     * @param {string} currentVersion - Current installed version
     * @param {string} newVersion - New available version
     * @param {boolean} [fromServer] - Whether the server reported the new version, rather than a newer worker
     */
    showUpdateNotification(currentVersion, newVersion, fromServer = false) {
        console.log(`Showing update notification: current=${currentVersion}, new=${newVersion}`);
        
        // Validate versions before showing
        if (!this.shouldShowUpdateNotification(currentVersion, newVersion)) {
            console.log("Update notification skipped - invalid version comparison");
            return;
        }
        
        // Check if we're already showing a notification for this version pair
        const versionPair = `${currentVersion}-${newVersion}`;
        if (this.updateNotificationActive && this.lastCheckedVersionPair === versionPair) {
            console.log("Update notification already active for this version pair, skipping duplicate");
            return;
        }
        
        // This prompt replaces the one an Update Now may be waiting on, so that Update Now is over, as with Later
        this.cancelUpdateAttempt();
        
        // Update tracking variables
        this.updateNotificationActive = true;
        this.lastCheckedVersionPair = versionPair;
        
        // Remove any existing notifications
        const existingNotifications = document.querySelectorAll('.update-notification');
        existingNotifications.forEach(notification => notification.remove());
        
        // Create new notification
        const updateNotification = document.createElement('div');
        updateNotification.className = 'update-notification';
        updateNotification.innerHTML = `
            <p></p>
            <p class="update-details"></p>
            <button id="update-now">Update Now</button>
            <button id="update-later" class="secondary">Later</button>
        `;
        // The versions go in as text, whoever reported them
        updateNotification.querySelector('p').textContent = `New version v${newVersion} available!`;
        updateNotification.querySelector('.update-details').textContent = `Current: v${currentVersion}`;
        document.body.appendChild(updateNotification);
        
        // Set up buttons
        document.getElementById('update-now').addEventListener('click', () => {
            this.handleUpdateRequest(updateNotification, fromServer);
        });
        
        document.getElementById('update-later').addEventListener('click', () => {
            this.cancelUpdateAttempt();
            updateNotification.remove();
            this.updateNotificationActive = false;
            this.dismissedVersion = newVersion;
        });
        
        // Log to console for debugging
        console.log(`Update notification displayed for ${currentVersion} → ${newVersion}`);
    }

    /**
     * Handles a user request to update the application
     * @param {HTMLElement} notification - The notification element
     * @param {boolean} [fromServer] - Whether the server reported the new version, rather than a newer worker
     */
    async handleUpdateRequest(notification, fromServer = false) {
        // This attempt replaces any earlier one, and lasts until it ends or the timeout or Later calls it off
        this.cancelUpdateAttempt();
        const attempt = new AbortController();
        this.updateAttempt = attempt;
        
        // Show loading state
        const updateButton = notification.querySelector('#update-now');
        updateButton.innerHTML = 'Updating...';
        updateButton.disabled = true;
        
        // Also update version display to show loading state
        if (this.updateVersionDisplayCallback) {
            this.updateVersionDisplayCallback(null, true); // true indicates loading state
        }
        
        // Set a timeout to handle cases where the update might hang
        this.updateTimeout = setTimeout(() => {
            attempt.abort();
            this.updateAttempt = null;
            
            // Remove any notifications
            const existingNotifications = document.querySelectorAll('.update-notification');
            existingNotifications.forEach(notification => notification.remove());
            
            // Show timeout error
            const errorNotification = document.createElement('div');
            errorNotification.className = 'update-notification error';
            errorNotification.innerHTML = `
                <p>Update timed out. Please try again.</p>
                <button onclick="this.parentElement.remove()">Dismiss</button>
            `;
            document.body.appendChild(errorNotification);
            setTimeout(() => {
                errorNotification.remove();
                this.updateNotificationActive = false;
            }, 5000);
            
            // Restore version display
            if (this.updateVersionDisplayCallback) {
                this.updateVersionDisplayCallback();
            }
        }, 30000); // 30 second timeout
        
        // The worker controlling the page caches the release it was registered with, so only a newer worker can
        // install a new version. When the server reported it, or no worker controls the page, a reload loads it
        // (pages are fetched network-first) and registers the new version's worker
        const controller = navigator.serviceWorker?.controller;
        if (controller && !fromServer) {
            // Request the update via service worker
            controller.postMessage({ type: 'PERFORM_UPDATE' });
            return;
        }
        
        // The reload needs the server: while it is down the page would come back as the worker's offline copy of
        // the old version, or not at all. An answer that comes after the attempt was called off changes nothing
        try {
            await this.getServerVersion(attempt.signal);
        } catch (error) {
            if (attempt.signal.aborted) return;
            this.updateAttempt = null;
            console.log("Not reloading, the server can't be reached:", error);
            this.showUpdateError("Can't reach the server. Try again when it's back.");
            return;
        }
        if (attempt.signal.aborted) return;
        this.updateAttempt = null;
        console.log("Reloading to load the new version");
        this.updateNotificationActive = false;
        window.location.reload(true);
    }

    /**
     * Calls off the Update Now under way, if any: its request to the server and its timeout. The footer, which
     * showed it loading, shows the page's version again
     */
    cancelUpdateAttempt() {
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }
        if (this.updateAttempt) {
            this.updateAttempt.abort();
            this.updateAttempt = null;
            if (this.updateVersionDisplayCallback) {
                this.updateVersionDisplayCallback();
            }
        }
    }

    /**
     * Replaces the update prompt with an error, which goes after 5 seconds or when dismissed. The next version
     * check can offer the update again
     * @param {string} message - What went wrong
     */
    showUpdateError(message) {
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }
        this.updateNotificationActive = false;
        this.lastCheckedVersionPair = null;
        
        const existingNotifications = document.querySelectorAll('.update-notification');
        existingNotifications.forEach(notification => notification.remove());
        
        const errorNotification = document.createElement('div');
        errorNotification.className = 'update-notification error';
        errorNotification.innerHTML = `
            <p></p>
            <button onclick="this.parentElement.remove()">Dismiss</button>
        `;
        errorNotification.querySelector('p').textContent = message;
        document.body.appendChild(errorNotification);
        setTimeout(() => errorNotification.remove(), 5000);
        
        // Restore version display
        if (this.updateVersionDisplayCallback) {
            this.updateVersionDisplayCallback();
        }
    }

    /**
     * Handles update completion messages
     * @param {Object} data - Update completion data
     */
    handleUpdateComplete(data) {
        // Whatever the outcome, the Update Now waiting on the worker is over
        const attemptWaiting = this.updateAttempt !== null;
        this.cancelUpdateAttempt();
        
        // The worker tells every tab when an update fails, so only the tab whose Update Now still waits says so;
        // any other leaves its page, and a prompt that replaced that Update Now, as they are
        if (data.success === false && !attemptWaiting) return;
        
        // Reset notification tracking state
        this.updateNotificationActive = false;
        this.lastCheckedVersionPair = null;
        
        // Remove any existing update notifications
        const existingNotifications = document.querySelectorAll('.update-notification');
        existingNotifications.forEach(notification => notification.remove());
        
        if (data.success === false) {
            this.showUpdateError(`Update failed: ${data.error || 'Unknown error'}`);
        } else {
            // Store cacheName if available for future use
            if (data.cacheName) {
                console.log(`Caching received cacheName in update complete: ${data.cacheName}`);
                this._receivedCacheName = data.cacheName;
            }
            
            // First update the version display if version is available
            if (data.version && this.updateVersionDisplayCallback) {
                this.updateVersionDisplayCallback(data.version);
                
                // Small delay to ensure UI updates before reload
                setTimeout(() => {
                    window.location.reload();
                }, 100);
            } else {
                // Fall back to immediate reload if no version info
                window.location.reload();
            }
        }
    }

    /**
     * Explicitly checks for updates and forces the service worker to look for new versions
     * This can be called when user manually wants to check for updates
     */
    checkForUpdates() {
        console.log("Manual update check requested");
        
        if (!navigator.serviceWorker.controller) {
            console.log("No active service worker, cannot check for updates");
            return false;
        }
        
        // Clear any existing notification first
        if (this.updateNotificationActive) {
            const existingNotifications = document.querySelectorAll('.update-notification');
            existingNotifications.forEach(notification => notification.remove());
            this.updateNotificationActive = false;
            this.lastCheckedVersionPair = null;
        }
        
        // First, update the service worker with the current app version
        if (window.appConfig?.version) {
            this.sendVersionToServiceWorker(window.appConfig.version);
        }
        
        // Then explicitly request an update check
        console.log("Sending CHECK_FOR_UPDATES message to service worker");
        setTimeout(() => {
            navigator.serviceWorker.controller.postMessage({
                type: 'CHECK_FOR_UPDATES'
            });
        }, 300); // Small delay to ensure version is processed first
        
        return true;
    }

    /**
     * Helper function to join paths with base path
     * @param {string} path - Path to join with base path
     * @returns {string} Joined path
     */
    joinPath(path) {
        // Remove any leading slash from path and trailing slash from basePath
        const cleanPath = path.replace(/^\/+/, '');
        const cleanBase = this.basePath.replace(/\/+$/, '');
        
        // Join with single slash
        return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
    }
}
