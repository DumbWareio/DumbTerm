import StorageManager from './storage.js';

// Helper function to join paths with base path
function joinPath(path) {
    const basePath = window.appConfig?.basePath || '';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = basePath.replace(/\/+$/, '');
    return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
}

export default class TerminalManager {
    constructor(isMacOS, setupToolTips) {
        this.terminals = new Map();
        this.activeTabId = null;
        this.tabCounter = 1;
        this.isMacOS = isMacOS;
        this.setupToolTips = setupToolTips;
        this.terminalAddons = new Map(); // Store addon references for each terminal
        
        // Initialize storage manager
        this.storageManager = new StorageManager('dumbterm-');
        
        // Bind event handlers
        this.handleNewTab = this.handleNewTab.bind(this);
        this.handleTabClick = this.handleTabClick.bind(this);
        this.handleTabClose = this.handleTabClose.bind(this);
        this.handleTabRename = this.handleTabRename.bind(this);
        this.checkTabOverflow = this.checkTabOverflow.bind(this);
        this.saveSessionState = this.saveSessionState.bind(this);
        this.loadSessionState = this.loadSessionState.bind(this);
        
        // Set up event listeners
        const newTabButton = document.querySelector('.new-tab-button');
        if (newTabButton) {
            newTabButton.addEventListener('click', this.handleNewTab);
        }

        // Add overflow detection for tabs
        this.initTabOverflowHandling();
        
        // Load any saved sessions or create a default tab
        this.loadSessionState();

        // Add keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ignore shortcuts when in login page
            if (document.getElementById('pinForm')) return;
            
            // Don't handle shortcuts when typing in terminal
            // commenting out but keeping in here in case needed later
            // if (e.target.closest('.xterm')) return;

            const windowsModifier = e.ctrlKey;
            const macModifier = e.metaKey;
            const modifier = isMacOS ? macModifier && e.ctrlKey : windowsModifier && e.altKey;

            // Command/Control + T: New tab
            if (modifier && e.key === 't') {
                e.preventDefault();
                this.handleNewTab();
            }
            // Command/Control + W: Close current tab
            else if (modifier && e.key === 'w') {
                e.preventDefault();
                if (this.activeTabId !== null) {
                    this.handleTabClose(this.activeTabId);
                }
            }
            // Command/Control + Number: Switch to tab
            else if ((modifier && /^[1-9]$/.test(e.key))) {
                e.preventDefault();
                const tabIndex = parseInt(e.key) - 1;
                const tabIds = Array.from(this.terminals.keys());
                if (tabIds[tabIndex]) {
                    this.activateTab(tabIds[tabIndex]);
                }
            }
            // Command/Control + R: Rename active tab
            else if (modifier && e.key === 'r') {
                e.preventDefault();
                if (this.activeTabId !== null) {
                    this.handleTabRename(this.activeTabId);
                }
            }
            // Command/Control + } or ]: Next tab
            else if (modifier && (e.key === '>' || e.key === '.')) {
                e.preventDefault();
                this.cycleToNextTab();
            }
            // Command/Control + { or [: Previous tab
            else if (modifier && (e.key === '<' || e.key === ',')) {
                e.preventDefault();
                this.cycleToPreviousTab();
            }
        });
    }

    // Initialize tab overflow handling
    initTabOverflowHandling() {
        // Initial check
        this.checkTabOverflow();
        
        // Check on window resize
        window.addEventListener('resize', this.checkTabOverflow);
        
        // Add scroll event listener to tab list
        const tabList = document.querySelector('.tab-list');
        if (tabList) {
            // Monitor tab list for overflow changes using ResizeObserver
            if (typeof ResizeObserver !== 'undefined') {
                const resizeObserver = new ResizeObserver(entries => {
                    this.checkTabOverflow();
                });
                resizeObserver.observe(tabList);
            }
            
            // Also check on scroll events
            tabList.addEventListener('scroll', () => {
                // Update scroll indicators if needed
            });
        }
    }
    
    // Check if tabs are overflowing their container
    checkTabOverflow() {
        const tabList = document.querySelector('.tab-list');
        if (!tabList) return;
        
        // Check if tabs overflow horizontally
        const hasOverflow = tabList.scrollWidth > tabList.clientWidth;
        
        // Toggle the no-scroll class based on overflow status
        tabList.classList.toggle('no-scroll', !hasOverflow);
    }

    createTab(id) {
        const tabList = document.querySelector('.tab-list');
        const tab = document.createElement('div');
        tab.className = 'terminal-tab';
        tab.dataset.tabId = id;
        tab.draggable = true; // Make tab draggable
        
        // Add tooltip for double-click rename functionality
        tab.setAttribute('data-tooltip', 'Double-click to rename ({shortcut})');
        tab.setAttribute('data-shortcuts', JSON.stringify({"win": "ctrl+alt+r", "mac": "ctrl+cmd+r"}));

        tab.innerHTML = `
            <span>Term${id}</span>
            <button class="close-tab" aria-label="Close terminal" data-tooltip="Close ({shortcut})" data-shortcuts='{"win": "ctrl+alt+w", "mac": "ctrl+cmd+w"}'></button>
        `;

        // Add drag and drop event listeners
        tab.addEventListener('dragstart', (e) => this.handleDragStart(e, id));
        tab.addEventListener('dragend', (e) => this.handleDragEnd(e));
        tab.addEventListener('dragover', (e) => this.handleDragOver(e));
        tab.addEventListener('dragenter', (e) => this.handleDragEnter(e));
        tab.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        tab.addEventListener('drop', (e) => this.handleDrop(e, id));
        
        tab.addEventListener('click', () => this.handleTabClick(id));
        tab.addEventListener('dblclick', (e) => {
            // Don't trigger rename if clicking on the close button
            if (!e.target.closest('.close-tab')) {
                this.handleTabRename(id);
            }
        });
        tab.querySelector('.close-tab').addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleTabClose(id);
        });

        
        tabList.appendChild(tab);
        // Apply tooltips to both the tab itself and its close button
        this.setupToolTips(document.querySelectorAll(".close-tab, .terminal-tab"));
        return tab;
    }

    handleDragStart(e, id) {
        // Activate the tab first before starting the drag operation
        if (this.activeTabId !== id) {
            this.activateTab(id);
        }
        
        const tab = e.target;
        tab.classList.add('dragging');
        
        // Set data for the drag operation
        e.dataTransfer.setData('text/plain', id.toString());
        
        // Use the actual tab as the drag image with the cursor at the right position
        e.dataTransfer.setDragImage(tab, e.offsetX, e.offsetY);
        
        // Store the dragged tab ID for reference during drag operations
        this.draggedTabId = id;
        
        // Create a smooth opacity transition for the dragged element
        requestAnimationFrame(() => {
            tab.style.opacity = '0.7';
            tab.style.transform = 'scale(1.02)';
        });
        
        // Hide all tooltips during dragging
        const tooltips = document.body.querySelectorAll('.tooltip');
        tooltips.forEach(tooltip => {
            tooltip.classList.remove('show');
            tooltip.style.display = 'none';
        });
        
        // Set a flag to prevent tooltips during dragging
        this.isDragging = true;
    }

    handleDragEnd(e) {
        // Remove dragging class and reset opacity
        const tab = e.target;
        tab.classList.remove('dragging');
        tab.style.opacity = '';
        tab.style.transform = '';
        
        // Update internal data structure to match the visual order
        this.updateTabOrder();
        
        // Save session state to persist the new order
        this.saveSessionState();
        
        // Clean up
        this.draggedTabId = null;
        
        // Reset the dragging flag 
        this.isDragging = false;
        
        // Restore tooltips functionality
        const tooltips = document.body.querySelectorAll('.tooltip');
        tooltips.forEach(tooltip => {
            // Just reset the display property - tooltips will show normally on hover again
            tooltip.style.display = '';
        });
        
        // Focus the active terminal
        const activeTerminal = this.terminals.get(this.activeTabId);
        if (activeTerminal && activeTerminal.terminal) {
            activeTerminal.terminal.focus();
        }
    }

    handleDragOver(e) {
        e.preventDefault();
        
        const tabList = document.querySelector('.tab-list');
        const draggedTab = tabList.querySelector(`.terminal-tab[data-tab-id="${this.draggedTabId}"]`);
        
        if (!draggedTab) return;
        
        // Get all tabs
        const tabs = Array.from(tabList.querySelectorAll('.terminal-tab'));
        
        // Find the tab we're currently hovering over
        const targetTab = tabs.find(tab => {
            if (tab === draggedTab) return false;
            
            const rect = tab.getBoundingClientRect();
            return e.clientX >= rect.left && e.clientX <= rect.right;
        });
        
        if (!targetTab) return;
        
        // Get the dimensions of the target tab
        const targetRect = targetTab.getBoundingClientRect();
        
        const sensitivityFactor = 0.7;
        const triggerPoint = targetRect.left + (targetRect.width * sensitivityFactor);
        const isAfterTriggerPoint = e.clientX > triggerPoint;
        
        const draggedIndex = tabs.indexOf(draggedTab);
        const targetIndex = tabs.indexOf(targetTab);
        
        // Determine if we should move the tab with the more sensitive trigger point
        if ((draggedIndex < targetIndex && isAfterTriggerPoint) || 
            (draggedIndex > targetIndex && !isAfterTriggerPoint)) {
            
            // Remove the highlighting from all tabs
            tabs.forEach(t => t.classList.remove('drag-over'));
            
            // Highlight the target tab with a subtle effect
            targetTab.classList.add('drag-over');
            
            // Track the previously moved tab to reset its animation
            if (this.previouslyMovedTab) {
                this.previouslyMovedTab.classList.remove('just-moved');
            }
            
            // Actually reorder the DOM elements in real-time
            if (isAfterTriggerPoint && draggedIndex < targetIndex) {
                // When moving right, insert after the target
                tabList.insertBefore(draggedTab, targetTab.nextSibling);
                targetTab.classList.add('just-moved');
                this.previouslyMovedTab = targetTab;
            } else if (!isAfterTriggerPoint && draggedIndex > targetIndex) {
                // When moving left, insert before the target
                tabList.insertBefore(draggedTab, targetTab);
                targetTab.classList.add('just-moved');
                this.previouslyMovedTab = targetTab;
            }
        }
    }

    handleDragEnter(e) {
        e.preventDefault();
    }

    handleDragLeave(e) {
        const tab = e.target.closest('.terminal-tab');
        if (tab) {
            tab.classList.remove('drag-over');
        }
    }

    handleDrop(e) {
        e.preventDefault();
        
        // Remove highlighting and animation classes from all tabs
        document.querySelectorAll('.terminal-tab').forEach(tab => {
            tab.classList.remove('drag-over');
            tab.classList.remove('just-moved');
        });
        
        this.previouslyMovedTab = null;
        
        // The tab order has already been updated during drag
        // Just make sure the active tab maintains proper styling
        const sourceId = parseInt(e.dataTransfer.getData('text/plain'));
        if (!isNaN(sourceId) && sourceId === this.activeTabId) {
            const sourceTab = document.querySelector(`.terminal-tab[data-tab-id="${sourceId}"]`);
            if (sourceTab) {
                sourceTab.classList.add('active');
            }
        }
    }

    updateTabOrder() {
        // Create new Map with updated order
        const newOrder = new Map();
        const tabList = document.querySelector('.tab-list');
        
        Array.from(tabList.children).forEach(tab => {
            const id = parseInt(tab.dataset.tabId);
            if (this.terminals.has(id)) {
                newOrder.set(id, this.terminals.get(id));
            }
        });
        
        this.terminals = newOrder;
    }

    createTerminalContainer(id) {
        const container = document.createElement('div');
        container.id = `terminal-${id}`;
        document.querySelector('.terminals-container').appendChild(container);
        return container;
    }

    async handleNewTab() {
        const id = this.tabCounter++;
        const tab = this.createTab(id);
        const container = this.createTerminalContainer(id);
        const terminal = this.initTerminal(container);
        
        this.terminals.set(id, { tab, container, terminal });
        this.activateTab(id, true); // Added parameter to skip saving on initial creation
        
        // Check if tabs overflow after adding a new tab
        this.checkTabOverflow();
    }

    handleTabClick(id) {
        this.activateTab(id);
    }

    handleTabClose(id) {
        const terminal = this.terminals.get(id);
        if (!terminal) return;

        const tooltips = document.body.querySelectorAll('.tooltip');
        tooltips.forEach(tt => tt.classList.remove('show'));
        
        const wasActive = this.activeTabId === id;

        // Clean up terminal first
        terminal.terminal.dispose();
        terminal.tab.remove();
        terminal.container.remove();
        this.terminals.delete(id);

        // If we just closed the active tab and there are other tabs, activate the last remaining tab
        if (wasActive && this.terminals.size > 0) {
            const remainingTabs = Array.from(this.terminals.keys());
            const lastTab = remainingTabs[remainingTabs.length - 1];
            this.activateTab(lastTab);
        }

        // If no tabs left, reset counter and create a new tab
        if (this.terminals.size === 0) {
            this.tabCounter = 1; // Reset counter to 1 so the next tab will be Term1
            this.handleNewTab();
        } else {
            // Update tabCounter based on the highest terminal ID + 1
            const maxId = Math.max(...Array.from(this.terminals.keys()));
            this.tabCounter = maxId + 1;
        }
        
        // After closing a tab, check overflow status
        this.checkTabOverflow();
        
        // Save session state
        this.saveSessionState();
    }

    handleTabRename(id) {
        const terminal = this.terminals.get(id);
        if (!terminal) return;

        const tab = terminal.tab;
        const span = tab.querySelector('span');
        const currentName = span.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'rename-input';

        span.replaceWith(input);
        input.focus();

        // Flag to prevent double-replacement of the input element
        let hasFinishedRename = false;

        const finishRename = () => {
            // Skip if we've already processed this rename
            if (hasFinishedRename) return;
            
            // Mark as finished to prevent duplicate processing
            hasFinishedRename = true;
            
            const newName = input.value.trim() || currentName;
            const newSpan = document.createElement('span');
            newSpan.textContent = newName;
            
            // Only attempt to replace if input is still in the DOM
            if (input.parentElement) {
                input.replaceWith(newSpan);
            }
            
            // Save session state
            this.saveSessionState();

            terminal.terminal.focus();
        };

        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Prevent form submission
                finishRename();
            } else if (e.key === 'Escape') {
                e.preventDefault(); // Prevent dialog closing
                input.value = currentName;
                finishRename();
            }
        });
    }

    getNextTab(currentId) {
        const ids = Array.from(this.terminals.keys());
        const currentIndex = ids.indexOf(currentId);
        
        if (currentIndex === -1) return null;
        
        // Try to get next tab, if not available get previous
        return ids[currentIndex + 1] || ids[currentIndex - 1] || null;
    }

    cycleToNextTab() {
        if (this.terminals.size <= 1 || this.activeTabId === null) return;
        
        const ids = Array.from(this.terminals.keys());
        const currentIndex = ids.indexOf(this.activeTabId);
        
        // Get next index, wrap around to 0 if at the end
        const nextIndex = (currentIndex + 1) % ids.length;
        this.activateTab(ids[nextIndex]);
    }

    cycleToPreviousTab() {
        if (this.terminals.size <= 1 || this.activeTabId === null) return;
        
        const ids = Array.from(this.terminals.keys());
        const currentIndex = ids.indexOf(this.activeTabId);
        
        // Get previous index, wrap around to last if at the beginning
        const previousIndex = (currentIndex - 1 + ids.length) % ids.length;
        this.activateTab(ids[previousIndex]);
    }

    activateTab(id, skipSaving = false) {
        // Deactivate current tab
        if (this.activeTabId !== null) {
            const current = this.terminals.get(this.activeTabId);
            if (current) {
                current.tab.classList.remove('active');
                current.container.classList.remove('active');
            }
        }

        // Activate new tab
        const next = this.terminals.get(id);
        if (next) {
            next.tab.classList.add('active');
            next.container.classList.add('active');
            next.terminal.focus();
            this.activeTabId = id;
            
            // Save session state when changing tabs, unless skipSaving is true
            if (!skipSaving) {
                this.saveSessionState();
            }
        }
    }

    // Terminal initialization
    initTerminal(container, savedContent = null) {
        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 15,
            fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--terminal-font').trim(),
            theme: {
                background: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim(),
                foreground: getComputedStyle(document.documentElement).getPropertyValue('--terminal-text').trim(),
                cursor: getComputedStyle(document.documentElement).getPropertyValue('--terminal-cursor').trim(),
                selectionBackground: getComputedStyle(document.documentElement).getPropertyValue('--terminal-selection').trim(),
                // Warp-like color scheme
                black: '#1C1C1C',
                red: '#FF6B6B',
                green: '#4FD6BE',
                yellow: '#F9C859',
                blue: '#6B95FF',
                magenta: '#FF75B5',
                cyan: '#4FF2F8',
                white: '#E0E0E0',
                brightBlack: '#666666',
                brightRed: '#FF8383',
                brightGreen: '#89FFDD',
                brightYellow: '#FFD866',
                brightBlue: '#89A9FF',
                brightMagenta: '#FF8DC7',
                brightCyan: '#89FFFF',
                brightWhite: '#FFFFFF'
            },
            allowTransparency: true,
            macOptionIsMeta: true,
            scrollback: 5000,
            minimumContrastRatio: 50,
            cursorStyle: 'block',
            cursorWidth: 1.5,
            letterSpacing: 0.5,
            lineHeight: 1.2,
            windowOptions: {
                setWinSize: true
            },
            allowProposedApi: true,
            rightClickSelectsWord: true,
            convertEol: true,
            termProgram: 'xterm-256color'
        });

        // Initialize addons
        const fitAddon = new FitAddon.FitAddon();
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        const webglAddon = new WebglAddon.WebglAddon();
        const canvasAddon = new CanvasAddon.CanvasAddon();
        const imageAddon = new ImageAddon.ImageAddon();
        const ligaturesAddon = new LigaturesAddon.LigaturesAddon();
        const searchAddon = new SearchAddon.SearchAddon();
        const serializeAddon = new SerializeAddon.SerializeAddon();
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        
        // Store addons for this terminal
        const addons = { fitAddon, webLinksAddon, webglAddon, canvasAddon, imageAddon, ligaturesAddon, searchAddon, serializeAddon, unicode11Addon };
        this.terminalAddons.set(terminal, addons);

        // Open terminal in the container first
        terminal.open(container);

        // Load Unicode support first
        terminal.loadAddon(unicode11Addon);
        terminal.unicode.activeVersion = '11';

        // Then load other addons
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(webLinksAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(serializeAddon);

        // Try to load WebGL first, fallback to Canvas if it fails
        try {
            terminal.loadAddon(webglAddon);
            webglAddon.onContextLoss(e => {
                console.warn('WebGL context lost, falling back to canvas renderer');
                terminal.loadAddon(canvasAddon);
            });
        } catch (e) {
            console.warn('WebGL addon could not be loaded, using canvas renderer:', e);
            terminal.loadAddon(canvasAddon);
        }

        // Load remaining addons
        terminal.loadAddon(imageAddon);
        try {
            terminal.loadAddon(ligaturesAddon);
        } catch (e) {
            console.warn('Ligatures addon could not be loaded:', e);
        }

        // Initial fit
        fitAddon.fit();
        
        // Restore saved content if available
        if (savedContent) {
            try {
                terminal.write(savedContent);
            } catch (e) {
                console.warn('Failed to restore terminal content:', e);
            }
        }

        // Add search functionality with Ctrl+Alt+F or Cmd+Alt+F
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                
                let searchBox = document.getElementById('terminal-search');
                if (!searchBox) {
                    const searchContainer = document.createElement('div');
                    searchContainer.className = 'terminal-search-container';
                    searchContainer.innerHTML = `
                        <input type="text" id="terminal-search" placeholder="Search...">
                        <div class="search-buttons">
                            <button id="search-prev">↑</button>
                            <button id="search-next">↓</button>
                            <button id="search-close">×</button>
                        </div>
                    `;
                    document.querySelector('.container').appendChild(searchContainer);
                    
                    const input = searchContainer.querySelector('#terminal-search');
                    const prevBtn = searchContainer.querySelector('#search-prev');
                    const nextBtn = searchContainer.querySelector('#search-next');
                    const closeBtn = searchContainer.querySelector('#search-close');
                    
                    let searchTimeout;
                    input.addEventListener('input', () => {
                        const searchTerm = input.value;
                        // Debounce search to avoid performance issues
                        clearTimeout(searchTimeout);
                        searchTimeout = setTimeout(() => {
                            if (searchTerm) {
                                try {
                                    searchAddon.findNext(searchTerm);
                                } catch (e) {
                                    console.warn('Search failed:', e);
                                }
                            }
                        }, 200);
                    });
                    
                    prevBtn.addEventListener('click', () => {
                        try {
                            searchAddon.findPrevious(input.value);
                        } catch (e) {
                            console.warn('Search failed:', e);
                        }
                    });
                    
                    nextBtn.addEventListener('click', () => {
                        try {
                            searchAddon.findNext(input.value);
                        } catch (e) {
                            console.warn('Search failed:', e);
                        }
                    });
                    
                    closeBtn.addEventListener('click', () => {
                        searchContainer.remove();
                        terminal.focus();
                    });
                    
                    input.addEventListener('keydown', (e) => {
                        switch(e.key) {
                            case 'Enter':
                                e.preventDefault();
                                try {
                                    if (e.shiftKey) {
                                        searchAddon.findPrevious(input.value);
                                    } else {
                                        searchAddon.findNext(input.value);
                                    }
                                } catch (e) {
                                    console.warn('Search failed:', e);
                                }
                                break;
                            case 'Escape':
                                searchContainer.remove();
                                terminal.focus();
                                e.preventDefault();
                                break;
                        }
                    });
                    
                    input.focus();
                } else {
                    searchBox.focus();
                }
            }
        });

        // WebSocket connection management
        let ws;
        const maxReconnectAttempts = 5;
        const baseReconnectDelay = 1000;
        let reconnectAttempts = 0;
        const self = this; // Store reference to 'this' for use in callbacks

        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const basePath = window.appConfig?.basePath || '';
            
            // Create WebSocket connection - cookies will be automatically included
            ws = new WebSocket(`${protocol}//${window.location.host}${basePath}`);

            // Set a generous timeout for the initial connection
            const connectionTimeout = setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    ws.close();
                    handleReconnect();
                }
            }, 5000);

            ws.onopen = () => {
                clearTimeout(connectionTimeout);
                reconnectAttempts = 0;
                // terminal.writeln('Connected to terminal server...'); // add a message here on first connect
                terminal.focus();
                
                // Start sending heartbeats
                startHeartbeat();
            };

            ws.onclose = (event) => {
                handleReconnect(event);
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                ws.close();
            };

            ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'output') {
                        terminal.write(message.data);
                        
                        // Save session state immediately after any terminal output
                        // This ensures we capture the current state including after clear commands
                        // Small delay to ensure terminal has fully processed the output
                        setTimeout(() => {
                            self.saveSessionState();
                        }, 1000);
                    }
                } catch (e) {
                    console.error('Error processing message:', e);
                }
            };
        }

        function handleReconnect(event) {
            // Handle authentication failure (code 1008 is policy violation)
            if (event && event.code === 1008) {
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('Authentication required. Redirecting to login...');
                window.location.href = joinPath('login');
                return;
            }

            if (event && event.wasClean) {
                terminal.writeln('\r\nConnection closed normally.');
                return;
            }

            if (reconnectAttempts < maxReconnectAttempts) {
                const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts);
                terminal.writeln('\r\nConnection lost. Attempting to reconnect...');
                setTimeout(() => {
                    reconnectAttempts++;
                    connectWebSocket();
                }, delay);
            } else {
                terminal.writeln('\r\nConnection lost. Please refresh the page to reconnect.');
            }
        }

        // Heartbeat mechanism
        function startHeartbeat() {
            const heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'heartbeat' }));
                } else {
                    clearInterval(heartbeatInterval);
                }
            }, 10000);

            // Clean up interval when connection closes
            ws.addEventListener('close', () => {
                clearInterval(heartbeatInterval);
            });
        }

        // Initialize WebSocket connection
        connectWebSocket();

        // Handle terminal input with connection check
        terminal.onData(data => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'input',
                    data: data
                }));
            } else {
                terminal.writeln('\r\nConnection not available. Attempting to reconnect...');
                if (reconnectAttempts < maxReconnectAttempts) {
                    connectWebSocket();
                }
            }
            
            // Save session state on terminal input
            this.saveSessionState();
        });

        // Handle terminal resize with connection check
        terminal.onResize(size => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'resize',
                    cols: size.cols,
                    rows: size.rows
                }));
            }
        });

        // Handle page visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                if (!ws || ws.readyState === WebSocket.CLOSED) {
                    reconnectAttempts = 0; // Reset attempts when page becomes visible
                    connectWebSocket();
                }
            }
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            // Delay the resize slightly to ensure container dimensions are settled
            setTimeout(() => {
                // Let FitAddon handle terminal sizing properly
                fitAddon.fit();
                
                // Ensure terminal size is updated after resize
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'resize',
                        cols: terminal.cols,
                        rows: terminal.rows
                    }));
                }
            }, 50); // Small delay to ensure container dimensions are settled
        });

        // Clean up on page unload
        window.addEventListener('beforeunload', () => {
            if (ws) {
                ws.close();
            }
        });

        // Update terminal colors when theme changes
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'data-theme') {
                    const computedStyle = getComputedStyle(document.documentElement);
                    terminal.options.theme = {
                        ...terminal.options.theme,
                        background: computedStyle.getPropertyValue('--terminal-bg').trim(),
                        foreground: computedStyle.getPropertyValue('--terminal-text').trim(),
                        cursor: computedStyle.getPropertyValue('--terminal-cursor').trim(),
                        selectionBackground: computedStyle.getPropertyValue('--terminal-selection').trim(),
                    };
                }
            });
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });

        return terminal;
    }

    saveSessionState() {
        const sessionState = {
            activeTabId: this.activeTabId,
            tabCounter: this.tabCounter,
            terminals: Array.from(this.terminals.entries()).map(([id, { tab, terminal }]) => {
                const addons = this.terminalAddons.get(terminal);
                let serializedContent = null;
                
                if (addons && addons.serializeAddon) {
                    try {
                        serializedContent = addons.serializeAddon.serialize();
                        if (serializedContent) {
                            const lines = serializedContent.split(/\r?\n/);
                            let lastContentLineIndex = -1;
                            let seenNonPrompt = false;
                            
                            // Common prompt patterns
                            const promptPatterns = [
                                // Standard prompt patterns (user@host:path$, root@host:dir#, etc.)
                                /^.*@.*[:~][#$>]\s*$/,
                                // Bash/zsh default prompts
                                /^[^@]+@[^:]+:[^$#>]+[#$>]\s*$/,
                                // Simple $ or # or > prompts
                                /^[$#>]\s*$/,
                                // PS1 with directory
                                /^\w+:\s*[\w/~]+[$#>]\s*$/,
                                // Starship or other ANSI-colored prompts
                                /^\s*\u001b\[\d+(?:;\d+)*m/,
                                // ANSI input mode sequences
                                /\u001b\[\?\d+[hl]/
                            ];
                            
                            for (let i = lines.length - 1; i >= 0; i--) {
                                const line = lines[i].trimEnd();
                                
                                if (line === '') {
                                    continue;
                                }
                                
                                const isPrompt = promptPatterns.some(pattern => pattern.test(line));
                                
                                if (!isPrompt) {
                                    lastContentLineIndex = i;
                                    seenNonPrompt = true;
                                    break;
                                }
                            }
                            
                            if (seenNonPrompt) {
                                serializedContent = lines.slice(0, lastContentLineIndex + 1).join('\n');
                                if (serializedContent.length > 0) {
                                    serializedContent += '\n';
                                }
                            } else {
                                serializedContent = '';
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to serialize terminal content:', e);
                    }
                }
                
                return {
                    id,
                    name: tab.querySelector('span').textContent,
                    content: serializedContent,
                    order: Array.from(this.terminals.keys()).indexOf(id) // Save the order
                };
            })
        };
        this.storageManager.set('sessionState', sessionState);
    }

    loadSessionState() {
        const sessionState = this.storageManager.get('sessionState');
        if (sessionState && sessionState.terminals && sessionState.terminals.length > 0) {
            // Sort terminals by saved order before creating them
            sessionState.terminals.sort((a, b) => (a.order || 0) - (b.order || 0));
            
            // Create all terminals in the sorted order
            sessionState.terminals.forEach(({ id, name, content }) => {
                const tab = this.createTab(id);
                tab.querySelector('span').textContent = name;
                const container = this.createTerminalContainer(id);
                const terminal = this.initTerminal(container, content || '');
                this.terminals.set(id, { tab, container, terminal });
            });
            
            // Calculate the tabCounter based on the highest ID + 1
            const maxId = Math.max(...Array.from(this.terminals.keys()));
            this.tabCounter = maxId + 1;
            
            // Restore active tab, but skip saving since we just loaded the state
            const activeId = sessionState.activeTabId !== null && this.terminals.has(sessionState.activeTabId) 
                ? sessionState.activeTabId 
                : (this.terminals.size > 0 ? Array.from(this.terminals.keys())[0] : null);
            
            if (activeId !== null) {
                this.activateTab(activeId, true);
                
                // Apply focus with increasing delays to handle race conditions
                const focusWithRetry = (attempts = 0) => {
                    setTimeout(() => {
                        const terminal = this.terminals.get(activeId);
                        if (terminal && terminal.terminal) {
                            try {
                                terminal.terminal.focus();
                            } catch (e) {
                                console.warn('Failed to focus terminal:', e);
                                // Retry with longer delay if we haven't exceeded max attempts
                                if (attempts < 3) {
                                    focusWithRetry(attempts + 1);
                                }
                            }
                        }
                    }, 100 * Math.pow(2, attempts)); // Exponential backoff: 100ms, 200ms, 400ms
                };
                
                // Start focus attempts after DOM is fully ready
                if (document.readyState === 'complete') {
                    focusWithRetry();
                } else {
                    window.addEventListener('load', () => focusWithRetry());
                }
                
                // Also focus explicitly when the window gets focus
                window.addEventListener('focus', () => {
                    const terminal = this.terminals.get(this.activeTabId);
                    if (terminal && terminal.terminal) {
                        terminal.terminal.focus();
                    }
                }, { once: true });
            }
        } else {
            // No saved state, create default tab
            this.handleNewTab();
            
            // Ensure new terminal gets focus after page is fully loaded
            if (document.readyState === 'complete') {
                setTimeout(() => {
                    if (this.activeTabId !== null) {
                        const terminal = this.terminals.get(this.activeTabId);
                        if (terminal) terminal.terminal.focus();
                    }
                }, 100);
            } else {
                window.addEventListener('load', () => {
                    setTimeout(() => {
                        if (this.activeTabId !== null) {
                            const terminal = this.terminals.get(this.activeTabId);
                            if (terminal) terminal.terminal.focus();
                        }
                    }, 100);
                });
            }
        }
    }
}