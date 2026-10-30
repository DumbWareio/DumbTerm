import StorageManager from './storage.js';

const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');

// Where each terminal's prompt starts (see initTerminal): a marker and the number of rows below it, or no
// marker for the buffer's first row
const promptMarkers = new WeakMap();
// The furthest the cursor gets below that row at a prompt: the tallest prompt plus a little typed input.
// Further down, the row is an app's that left bracketed paste on and kept printing (Claude Code), unless a long
// command typed at the prompt runs on that far (see typedOnPromptRow) or the prompt was redrawn below (see
// redrawnPromptRow)
const PROMPT_MAX_ROWS_BELOW_MARK = 4;
// readline redraws its whole prompt below a completion listing without turning bracketed paste on again, so
// the cursor ends up further below the marked row than that. The redrawn prompt repeats the marked one row for
// row: look for it, from its first line (after a blank one, Starship's) down to the command, starting in the
// rows a prompt reaches above, and on, the cursor's row. The command is the cursor's whole line, wrapped onto
// as many rows as it takes (one that starts above those rows is no command), and may have been typed on (or
// erased back) since the listing, so there one line need only start like the other.
// A prompt that starts with a blank row, like Starship's, is also looked for higher: redrawn under a blank row, with
// the rows above its command (Starship's top line) repeating the marked one's, its command may start as high as it
// is long and, where it was typed on past the marked one's end, run on from a row filled to its last column into
// one not marked as wrapped: readline moves the cursor down a wrapped command with a newline, which unmarks the row
// it moves to. Without the blank rows an app's rows would pass for a prompt (its title redrawn above an input line
// that fills its row), so known limits: a prompt with no blank first row (a plain one) redrawn with a command
// typed past four rows after the listing, or after the cursor moved down across its command's wrap (Ctrl-E, End,
// →), stays in the save, and so does any prompt where that wrap leaves the last column empty or blank (a wide
// character that did not fit, a space) or the marked command filled its row. And the other way: an app that starts
// with a blank row and later draws it, its title and an input line that fills its row (or wraps) again reads as
// such a prompt, so its output from the first blank row on is left out
function redrawnPromptRow(buffer, markedRow, cursorRow) {
    const text = (row) => buffer.getLine(row)?.translateToString(true) ?? '';
    const line = (row) => {
        let joined = text(row);
        for (let next = row + 1; buffer.getLine(next)?.isWrapped; next++) joined += text(next);
        return joined;
    };
    const first = text(markedRow) === '' ? markedRow + 1 : markedRow;
    if (text(first) === '') return null;
    const sameCommand = (a, b) => a === b || (a !== '' && b !== '' && (a.startsWith(b) || b.startsWith(a)));
    const highestTop = cursorRow - PROMPT_MAX_ROWS_BELOW_MARK + 1;
    let commandRow = cursorRow;
    while (commandRow >= highestTop && buffer.getLine(commandRow)?.isWrapped) commandRow--;
    const command = line(commandRow);
    for (let top = commandRow; top >= highestTop; top--) {
        let same = true;
        for (let row = top; same && row <= commandRow; row++) {
            const marked = first + row - top;
            same = row === commandRow ? sameCommand(line(marked), command) : text(marked) === text(row);
        }
        if (same) return markedRow;
    }
    // Whether a row's last cell holds text, or the right half of a wide character (which has none of its own)
    const filled = (row) => {
        const cells = buffer.getLine(row);
        const last = cells?.getCell(cells.length - 1);
        return !!last && (last.getWidth() === 0 || last.getChars().trim() !== '');
    };
    // Whether the line starting on a row ends at its last row's last column
    const lineFilled = (row) => {
        while (buffer.getLine(row + 1)?.isWrapped) row++;
        return filled(row);
    };
    // Whether a command, from its rows listed last row first, starts like the marked one as sameCommand has it: one
    // need only start like the other, and an empty one matches only another. Its rows are compared from the first,
    // down to the first that differs or, past the marked command's end, the first with any text
    const startsLike = (marked, rows) => {
        let length = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i] === '') continue;
            if (length === marked.length) return length > 0;
            const part = rows[i].slice(0, marked.length - length);
            if (!marked.startsWith(part, length)) return false;
            length += part.length;
        }
        return (length > 0) === (marked !== '');
    };
    // The marked command for each number of rows above it, and whether it ends at its last column, read once each
    const markedCommands = [];
    // The redrawn prompt's rows lie wholly below the marked command's first row. A row not marked as wrapped runs
    // on from a filled one only where the command was typed on: the marked one ended short of the last column. The
    // command's rows, from the cursor's line (with the rows it wraps onto) up to the row it starts on, are gathered a
    // row at a time as the search moves up, and only its start is compared: one line starting like the other reads
    // no more of it than the marked command's length
    for (let start = cursorRow, unmarked = false, rows = [line(cursorRow)]; first > markedRow && start > first + 2;
        rows.push(text(--start))) {
        for (let above = 1; above < PROMPT_MAX_ROWS_BELOW_MARK && start - above > first + above; above++) {
            let same = text(start - above - 1) === '';
            for (let row = 0; same && row < above; row++) same = text(first + row) === text(start - above + row);
            if (!same) continue;
            const marked = (markedCommands[above] ??= { line: line(first + above), filled: lineFilled(first + above) });
            if (unmarked && marked.filled) continue;
            if (startsLike(marked.line, rows)) return markedRow;
        }
        if (!buffer.getLine(start)?.isWrapped) {
            if (!filled(start - 1)) break;
            unmarked = true;
        }
    }
    return null;
}

// A command typed at the prompt and not run takes the cursor further below the marked row than that too, once it wraps
// onto enough rows. The terminal wraps it, so every row it runs onto is marked as wrapped, back up to the row it
// starts on. That row starts the prompt's first line, as a one-line prompt's command does, or, after a blank first
// row like Starship's, the line after it, its command's, each line on as many rows as it wraps onto (at 40 columns
// Starship's top line wraps its last space onto a row of its own). No prompt starts with two blank rows. An app's
// output starts new lines as it prints, so its last line starts lower. Known limits: a prompt with no blank first
// row and a line above its command (a two-line plain prompt) stays in the save, as a background job's line printed
// at a one-line prompt, with the command typed under it, looks the same; so does a prompt with two or more lines
// above its command after a blank first row, and a command not marked as wrapped all the way up from the cursor:
// the cursor moved down across its wrap (Ctrl-E, End, →), which readline does with a newline, or a wide character
// that did not fit; and so does Starship's prompt after output with no final newline (printf, curl), whose blank
// first row that output's row takes, as the mark goes on the row below it. And the other way: an app that left bracketed paste on and printed, from its first row, a line
// running past four rows, or a blank row and one line and then such a line, with the cursor at its end, reads as
// such a command, so its output from the first row on is left out. So is a background job's text printed with no
// final newline at a one-line prompt, which the command typed after it runs on from as one line, and a job's line
// under a blank marked row that is no Starship prompt's: output with no final newline puts the mark on the row below,
// which may stay blank. Within four rows of the mark the save leaves all of these out already
function typedOnPromptRow(buffer, markedRow, cursorRow) {
    const blank = (row) => (buffer.getLine(row)?.translateToString(true) ?? '') === '';
    const first = blank(markedRow) ? markedRow + 1 : markedRow;
    if (blank(first)) return null;
    let second = first + 1;
    while (buffer.getLine(second)?.isWrapped) second++;
    let start = cursorRow;
    while (buffer.getLine(start)?.isWrapped) start--;
    return start === first || (first > markedRow && start === second) ? markedRow : null;
}

// How to end each terminal's connection to the server (see initTerminal), for when its tab closes
const connectionEnders = new WeakMap();

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

        // Add search button click handler
        const searchOpenBtn = document.getElementById('search-open');
        if (searchOpenBtn) {
            searchOpenBtn.addEventListener('click', () => this.openSearchBox());
        }

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
            // Command/Control + F: Open search
            else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                this.openSearchBox();
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
            
            // // Also check on scroll events
            // tabList.addEventListener('scroll', () => {
            //     // Update scroll indicators if needed
            // });
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
        tab.addEventListener('auxclick', (e) => {
            // Check if it's a middle click (button 1)
            if (e.button === 1) {
                e.preventDefault();
                this.handleTabClose(id);
            }
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

        // End its connection, so the server ends its shell, then clean up the terminal, and let go of its addons,
        // which would otherwise keep the disposed terminal and its scrollback
        connectionEnders.get(terminal.terminal)?.();
        terminal.terminal.dispose();
        this.terminalAddons.delete(terminal.terminal);
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
                
                // Clear any existing search highlights in the previous tab
                const currentAddons = this.terminalAddons.get(current.terminal);
                if (currentAddons && currentAddons.searchAddon) {
                    currentAddons.searchAddon.clearDecorations();
                }
            }
        }

        // Activate new tab
        const next = this.terminals.get(id);
        if (next) {
            next.tab.classList.add('active');
            next.container.classList.add('active');
            next.terminal.focus();
            this.activeTabId = id;
            
            // Reapply search if search box exists and has a value
            const searchBox = document.getElementById('terminal-search');
            if (searchBox && searchBox.value) {
                const nextAddons = this.terminalAddons.get(next.terminal);
                if (nextAddons && nextAddons.searchAddon) {
                    try {
                        nextAddons.searchAddon.findNext(searchBox.value);
                    } catch (e) {
                        console.warn('Search failed:', e);
                    }
                }
            }
            
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
            macOptionIsMeta: false,
            scrollback: 5000,
            minimumContrastRatio: 50,
            cursorStyle: 'block',
            cursorWidth: 1.5,
            letterSpacing: 0.5,
            lineHeight: 1.2,
            // Add and modify these options
            windowOptions: {
                setWinSize: true,
                getWinSize: true
            },
            allowProposedApi: true,
            rightClickSelectsWord: true,
            convertEol: true,
            termProgram: 'xterm-256color',
            // Add these new options for better control sequence handling
            smoothScrollDuration: 0,
            // xterm.js 6 scrolls 50px per wheel tick. Browsers off macOS report a mouse-wheel notch as one
            // tick, where native scrolling (xterm.js 5) moved ~100px, so double it there; on macOS a tick is
            // 40px of movement, so 50px is already close to native
            scrollSensitivity: IS_MAC ? 1 : 2,
            fastScrollSensitivity: 5,
            // Better handling of alternative screen buffer
            altClickMovesCursor: true,
            screenReaderMode: false
        });

        // Initialize addons
        const fitAddon = new FitAddon.FitAddon();
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        const webglAddon = new WebglAddon.WebglAddon();
        const imageAddon = new ImageAddon.ImageAddon();
        const searchAddon = new SearchAddon.SearchAddon();
        const serializeAddon = new SerializeAddon.SerializeAddon();
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        
        // Store addons for this terminal
        const addons = { fitAddon, webLinksAddon, webglAddon, imageAddon, searchAddon, serializeAddon, unicode11Addon };
        this.terminalAddons.set(terminal, addons);

        // Open terminal in the container first
        terminal.open(container);

        // Load Unicode support first
        terminal.loadAddon(unicode11Addon);
        terminal.unicode.activeVersion = '11';

        // Ignore OSC 133 (shell integration marks). Mode sets and resets (CSI h/l) are left to xterm.js:
        // swallowing them broke insert mode (terminfo smir/rmir), and editors' alternate screen
        // (CSI ? 1049 h/l) is a separate private-mode sequence that xterm.js already handles
        terminal.parser.registerOscHandler(133, () => true);

        // Shells turn bracketed paste on (CSI ? 2004 h) as their line editor takes over: bash before it prints
        // the prompt, zsh after. Mark that row so a saved session can leave the prompt out, or the row below
        // when the cursor is not at the start of a line: the row holds output with no final newline, and a
        // prompt that starts with a newline (Starship's) begins below it. Returns false so xterm.js still sets
        // the mode. In the alternate buffer the mode is an editor's, not the shell's
        terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
            const buffer = terminal.buffer.active;
            if (params.includes(2004) && buffer.type === 'normal') {
                promptMarkers.get(terminal)?.marker?.dispose();
                promptMarkers.set(terminal, { marker: terminal.registerMarker(buffer.cursorX === 0 ? 0 : 1), rowsBelow: 0 });
            }
            return false;
        });

        // Ctrl-L at a prompt clears the screen (CSI 2 J), erasing the marked row, and the shell redraws its whole
        // prompt from the top without turning bracketed paste on again. A marker on the top row would be erased
        // too, so mark the row above it, the end of the scrollback, or with no scrollback the buffer's first row.
        // Returns false so xterm.js still clears the screen. readline's clear-display follows with CSI 3 J, which
        // clears the scrollback and that row with it: the prompt is then on the buffer's first row
        terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
            const buffer = terminal.buffer.active;
            const mark = promptMarkers.get(terminal);
            if (params[0] === 3 && mark?.rowsBelow === 1 && !mark.marker.isDisposed && mark.marker.line === buffer.baseY - 1) {
                mark.marker.dispose();
                promptMarkers.set(terminal, { marker: null, rowsBelow: 0 });
            }
            if (params[0] === 2 && terminal.modes.bracketedPasteMode && buffer.type === 'normal') {
                promptMarkers.get(terminal)?.marker?.dispose();
                promptMarkers.set(terminal, buffer.baseY > 0
                    ? { marker: terminal.registerMarker(-buffer.cursorY - 1), rowsBelow: 1 }
                    : { marker: null, rowsBelow: 0 });
            }
            return false;
        });

        // Then load other addons
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(webLinksAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(serializeAddon);

        // Try to load WebGL first. xterm.js 6 removed the canvas renderer, so if WebGL is
        // unavailable or its context is lost, disposing the addon falls back to the built-in DOM renderer.
        // The ligatures addon is only for WebGL: the DOM renderer already draws ligatures from the font
        // (font-feature-settings in styles.css), and the addon's joined runs overflow its cells.
        let webglActive = false;
        let ligaturesAddon = null;
        try {
            terminal.loadAddon(webglAddon);
            webglActive = true;
            webglAddon.onContextLoss(() => {
                console.warn('WebGL context lost, falling back to DOM renderer');
                webglActive = false;
                ligaturesAddon?.dispose();
                webglAddon.dispose();
            });
        } catch (e) {
            console.warn('WebGL addon could not be loaded, using DOM renderer:', e);
            webglAddon.dispose();
        }

        // Load remaining addons
        terminal.loadAddon(imageAddon);

        // addon-ligatures only ships an ES module build, so it is imported on demand.
        // Ligatures are cosmetic: a failure here must never stop the terminal from working.
        if (webglActive) {
            import('../node_modules/@xterm/addon-ligatures/lib/addon-ligatures.mjs')
                .then(({ LigaturesAddon }) => {
                    // WebGL may have been lost, or the tab closed, while the module was loading
                    if (!webglActive || !terminal.element?.isConnected) return;
                    ligaturesAddon = new LigaturesAddon();
                    terminal.loadAddon(ligaturesAddon);
                })
                .catch(e => console.warn('Ligatures addon could not be loaded:', e));
        }

        // Initial fit
        fitAddon.fit();
        
        // Restore saved content if available
        if (savedContent) {
            try {
                // Saves from before 1.3.0 can hold an open editor's screen after the switch to it; the new
                // shell has no editor open, so restore only what came before. Reset the text attributes before
                // the final newline, so the colours the old program left set neither carry into the new shell's
                // prompt nor fill the row that newline scrolls in
                terminal.write(savedContent.split('\x1b[?1049h')[0].replace(/\n?$/, '\x1b[0m$&'));
            } catch (e) {
                console.warn('Failed to restore terminal content:', e);
            }
        }

        // WebSocket connection management. A tab has one connection underway at a time, a retry waiting on its
        // timer or a socket not yet closed, and nothing starts another until it is over. A socket's events count
        // only while it is the tab's own (ws): one the tab has replaced, or let go of on closing, changes nothing
        let ws;
        let reconnectTimer = null;
        const maxReconnectAttempts = 5;
        const baseReconnectDelay = 1000;
        let reconnectAttempts = 0;
        // Whether the tab has said it is reconnecting since it was last connected: once is enough
        let outageReported = false;
        // Whether the tab has been connected before, so that its next connection is a reconnect
        let connectedBefore = false;
        // Whether the tab's last shell failed to start (1011), so that coming back to the page leaves it for a key
        let shellFailedToStart = false;
        const self = this; // Store reference to 'this' for use in callbacks

        function connectionUnderway() {
            return reconnectTimer !== null || (ws && ws.readyState !== WebSocket.CLOSED);
        }

        function reportOutage(message) {
            if (!outageReported) {
                outageReported = true;
                terminal.writeln(message);
            }
        }

        function connectWebSocket() {
            if (connectionUnderway()) {
                return;
            }
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const basePath = window.appConfig?.basePath || '';
            
            // Create WebSocket connection - cookies will be automatically included
            const socket = new WebSocket(`${protocol}//${window.location.host}${basePath}`);
            ws = socket;

            // Set a generous timeout for the initial connection. Closing a socket that is still connecting fails
            // it, and its close event arranges the retry
            const connectionTimeout = setTimeout(() => {
                if (socket.readyState !== WebSocket.OPEN) {
                    socket.close();
                }
            }, 5000);

            socket.onopen = () => {
                clearTimeout(connectionTimeout);
                reconnectAttempts = 0;
                outageReported = false;

                // Each connection gets a new shell, so an editor open on the old one is gone with it, and so are
                // the modes the old shell's programs set, in either buffer (a picker drawn under the prompt sets
                // them without leaving the normal one): DECSTR shows the cursor and resets the cursor keys and
                // keypad, and the mouse and focus reports are turned off on their own
                if (terminal.buffer.active.type === 'alternate') {
                    terminal.write('\x1b[?1049l');
                }
                // Only the tab in front takes the keyboard: the others are hidden but still in the page, and
                // keys typed into one would run in a shell nobody can see. It takes it once the reset is applied,
                // or a program's focus reports would still be on and the new shell would read one as typed text,
                // and only from nothing or a terminal: the search box or a tab's name being edited keeps it, or
                // what is typed there next would run in the shell
                terminal.write('\x1b[!p\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l', () => {
                    const focused = document.activeElement;
                    if (self.terminals.get(self.activeTabId)?.terminal === terminal
                        && (!focused || focused === document.body || focused.closest('.terminals-container'))) {
                        terminal.focus();
                    }
                });

                // Force an initial resize to ensure proper dimensions, unless the socket closed meanwhile or the
                // tab let go of it
                setTimeout(() => {
                    if (socket === ws && socket.readyState === WebSocket.OPEN) {
                        fitAddon.fit();
                        socket.send(JSON.stringify({
                            type: 'resize',
                            cols: terminal.cols,
                            rows: terminal.rows
                        }));
                    }
                }, 100);
                startHeartbeat(socket);

                // A reconnect can be to a server that was upgraded meanwhile, so the page checks its version. Last,
                // once the new connection is set up
                if (connectedBefore) {
                    window.dispatchEvent(new Event('dumbterm:reconnected'));
                }
                connectedBefore = true;
            };

            socket.onclose = (event) => {
                clearTimeout(connectionTimeout);
                if (socket === ws) {
                    // Focus and mouse reports a program left on would go on reaching the page as input, and count
                    // as keys typed while disconnected, so turn them off with the shell gone; the next connection
                    // resets the rest
                    terminal.write('\x1b[?1004l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l');
                    handleReconnect(event);
                }
            };

            // A socket the tab let go of (closing the tab gives up one still connecting) fails as it closes,
            // which is no error worth logging
            socket.onerror = (error) => {
                if (socket === ws) {
                    console.error('WebSocket error:', error);
                }
                clearTimeout(connectionTimeout);
                socket.close();
            };

            socket.onmessage = (event) => {
                if (socket !== ws) {
                    return;
                }
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'output') {
                        terminal.write(message.data, () => {
                            // Save once the shell's output settles. An editor's redraws neither arm nor postpone
                            // it: the save leaves the editor's screen out, and the timer is shared by every tab
                            if (terminal.buffer.active.type !== 'normal') {
                                return;
                            }
                            clearTimeout(self.saveTimeout);
                            self.saveTimeout = setTimeout(() => {
                                self.saveSessionState();
                            }, 500);
                        });
                    }
                } catch (e) {
                    console.error('Error processing message:', e);
                }
            };
        }

        function handleReconnect(event) {
            // Handle authentication failure (code 1008 is policy violation)
            if (event.code === 1008) {
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n');
                terminal.writeln('Authentication required. Redirecting to login...');
                window.location.href = joinPath('login');
                return;
            }

            // A clean close is final (the shell exited, or failed to start), unless the server is going away
            // (1001, shutting down) or restarting (1012): the tab then reconnects once it is back, as it does
            // after a dropped connection. A shell that failed to start (1011) says why, as retrying would fail
            // the same way
            if (event.wasClean && event.code === 1011) {
                shellFailedToStart = true;
                terminal.writeln(`\r\nThe server could not start a shell: ${event.reason || 'Failed to start terminal'}.`);
                return;
            }
            if (event.wasClean && event.code !== 1001 && event.code !== 1012) {
                terminal.writeln('\r\nConnection closed normally.');
                return;
            }

            if (reconnectAttempts < maxReconnectAttempts) {
                const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts);
                reportOutage('\r\nConnection lost. Attempting to reconnect...');
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    reconnectAttempts++;
                    connectWebSocket();
                }, delay);
            } else {
                // The retries have run out, and the tab waits for a key to start a new round of them, which says
                // that it is reconnecting
                outageReported = false;
                terminal.writeln('\r\nConnection lost. Press any key to reconnect, or refresh the page.');
            }
        }

        // Heartbeat mechanism, for as long as its socket is open
        function startHeartbeat(socket) {
            const heartbeatInterval = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'heartbeat' }));
                } else {
                    clearInterval(heartbeatInterval);
                }
            }, 10000);

            // Clean up interval when connection closes
            socket.addEventListener('close', () => {
                clearInterval(heartbeatInterval);
            });
        }

        // Initialize WebSocket connection
        connectWebSocket();

        // Handle terminal input with connection check. A key typed with no connection is dropped. While one is
        // underway it says nothing, as the close still to come may be final; otherwise it says so and starts one,
        // with its retries renewed: that is how a tab whose shell exited or failed to start gets a new one, and how
        // one whose retries ran out before the server came back reconnects. An attempt a key started after a failed
        // start is like any other: if it meets an outage, coming back to the page reconnects it
        terminal.onData(data => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'input',
                    data: data
                }));
            } else if (!connectionUnderway()) {
                reportOutage('\r\nConnection not available. Attempting to reconnect...');
                reconnectAttempts = 0;
                shellFailedToStart = false;
                connectWebSocket();
            }
            
            // Save session state on terminal input
            this.saveSessionState();
        });

        // Mouse reports in xterm's default encoding (a program that turns them on without ?1006h) come as binary
        // data, a character per byte, which the server writes to the shell as those bytes. They are no keys: with
        // no connection they are dropped, and never start one
        terminal.onBinary(data => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'binary',
                    data: data
                }));
            }
        });

        // Handle terminal resize with connection check
        terminal.onResize(size => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                // Ensure size values are integers and within reasonable bounds
                const cols = Math.max(2, Math.min(500, Math.floor(size.cols)));
                const rows = Math.max(2, Math.min(500, Math.floor(size.rows)));
                
                ws.send(JSON.stringify({
                    type: 'resize',
                    cols: cols,
                    rows: rows
                }));
            }
        });

        // Handle page visibility changes: coming back to the page reconnects a tab whose connection ended, with
        // its retries renewed. A retry waiting out its backoff is called off for it, as the page may have been
        // away (a laptop asleep) for longer than the wait; a socket connecting or open is left to finish. A tab
        // whose shell failed to start is left for a key, as each return would fail the same way
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible' || shellFailedToStart) {
                return;
            }
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
            if (!connectionUnderway()) {
                reconnectAttempts = 0;
                connectWebSocket();
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Handle window resize
        const onWindowResize = () => {
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
        };
        window.addEventListener('resize', onWindowResize);

        // Clean up on page unload
        const onBeforeUnload = () => {
            if (ws) {
                ws.close();
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);

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

        // Closing the tab ends its connection for good: a waiting retry is called off, the page's events no longer
        // reach the tab, and its socket is let go of before it is closed (1000), so neither that close nor one the
        // server sent at the same time reconnects it. The server ends the shell when the socket closes
        connectionEnders.set(terminal, () => {
            clearTimeout(reconnectTimer);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('resize', onWindowResize);
            window.removeEventListener('beforeunload', onBeforeUnload);
            observer.disconnect();
            const socket = ws;
            ws = null;
            socket.close(1000);
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
                        // A restored tab runs a fresh shell, so leave out the modes the old program set
                        // (e.g. insert mode), which would otherwise switch on again in the new session. An open
                        // editor's screen goes too: what is saved is the shell's screen underneath it
                        const serializeOptions = { excludeModes: true, excludeAltBuffer: true };
                        const buffer = terminal.buffer.active;
                        // Bracketed paste is on while the shell sits in its line editor, so it is at a prompt
                        // (with any half-typed command), which the restored tab's new shell prints anew. In the
                        // alternate buffer it is an editor's (vim turns it on)
                        const idleAtPrompt = terminal.modes.bracketedPasteMode && buffer.type === 'normal';
                        if (idleAtPrompt) {
                            // The prompt starts on the row marked when the shell turned bracketed paste on, or on
                            // the cursor's row if that is higher (zsh marks after its prompt), the marked row is
                            // gone (erased by a screen clear, or out of the scrollback) or it is too far up to be
                            // the prompt's, unless a command typed at the prompt runs on that far down or the prompt
                            // was redrawn below. Rows above it are all kept, so no prompt patterns here. Known limit:
                            // zsh turns it on after the prompt, so the upper lines of a multi-line zsh prompt stay in
                            // the save
                            const cursorRow = buffer.baseY + buffer.cursorY;
                            const mark = promptMarkers.get(terminal);
                            const markedRow = !mark ? cursorRow
                                : !mark.marker ? 0
                                : mark.marker.isDisposed ? cursorRow : mark.marker.line + mark.rowsBelow;
                            const promptStart = cursorRow - markedRow <= PROMPT_MAX_ROWS_BELOW_MARK
                                ? Math.min(markedRow, cursorRow)
                                : typedOnPromptRow(buffer, markedRow, cursorRow)
                                    ?? redrawnPromptRow(buffer, markedRow, cursorRow) ?? cursorRow;
                            serializedContent = promptStart > 0
                                ? addons.serializeAddon.serialize({ ...serializeOptions, range: { start: 0, end: promptStart - 1 } })
                                : '';
                        } else {
                            serializedContent = addons.serializeAddon.serialize(serializeOptions);
                        }
                        if (serializedContent) {
                            const lines = serializedContent.split(/\r?\n/);
                            // The serializer ends by moving the cursor back to where it was (and setting its
                            // colours), on a row of its own when the cursor is above the bottom; restored, that
                            // would leave blank rows, or a blank line after the newline added below
                            lines[lines.length - 1] = lines[lines.length - 1].replace(/(?:\u001b\[[\d;]*[ABCDm])+$/, '');
                            let lastContentLineIndex = -1;
                            let seenNonPrompt = false;
                            
                            // Common prompt patterns, matched against the line's text without its colours (a
                            // line is not a prompt for starting with a colour: output often does)
                            const promptPatterns = [
                                // Standard prompt patterns (user@host:path$, root@host:dir#, etc.)
                                /^.*@.*[:~][#$>]\s*$/,
                                // Bash/zsh default prompts
                                /^[^@]+@[^:]+:[^$#>]+[#$>]\s*$/,
                                // Simple $ or # or > prompts
                                /^[$#>]\s*$/,
                                // PS1 with directory
                                /^\w+:\s*[\w/~]+[$#>]\s*$/
                            ];

                            for (let i = lines.length - 1; i >= 0; i--) {
                                const line = lines[i].trimEnd();
                                
                                if (line === '') {
                                    continue;
                                }
                                
                                // At a prompt, the rows kept all come before it; otherwise (a command is
                                // running, or the shell has no bracketed paste) a prompt is found by its look
                                const text = line.replace(/\u001b\[[\d;]*m/g, '');
                                const isPrompt = !idleAtPrompt && promptPatterns.some(pattern => pattern.test(text));
                                
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
                    order: Array.from(this.terminals.keys()).indexOf(id)
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

    // Function to handle opening the search box
    openSearchBox() {
        const activeTerminal = this.terminals.get(this.activeTabId);
        if (!activeTerminal) return;
        
        const activeTerminalAddons = this.terminalAddons.get(activeTerminal.terminal);
        if (!activeTerminalAddons) return;
        
        const searchAddon = activeTerminalAddons.searchAddon;
        if (!searchAddon) return;
        
        let searchBox = document.getElementById('terminal-search');
        if (!searchBox) {
            // Create new search box
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
            
            // Focus and select all text
            input.focus();
            input.select();
            
            let searchTimeout;
            input.addEventListener('input', () => {
                const searchTerm = input.value;
                // Debounce search to avoid performance issues
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    if (searchTerm) {
                        try {
                            const currentTerminal = this.terminals.get(this.activeTabId);
                            if (currentTerminal) {
                                const currentAddons = this.terminalAddons.get(currentTerminal.terminal);
                                if (currentAddons && currentAddons.searchAddon) {
                                    currentAddons.searchAddon.findNext(searchTerm);
                                }
                            }
                        } catch (e) {
                            console.warn('Search failed:', e);
                        }
                    }
                }, 200);
            });
            
            prevBtn.addEventListener('click', () => {
                try {
                    const currentTerminal = this.terminals.get(this.activeTabId);
                    if (currentTerminal) {
                        const currentAddons = this.terminalAddons.get(currentTerminal.terminal);
                        if (currentAddons && currentAddons.searchAddon) {
                            currentAddons.searchAddon.findPrevious(input.value);
                        }
                    }
                } catch (e) {
                    console.warn('Search failed:', e);
                }
            });
            
            nextBtn.addEventListener('click', () => {
                try {
                    const currentTerminal = this.terminals.get(this.activeTabId);
                    if (currentTerminal) {
                        const currentAddons = this.terminalAddons.get(currentTerminal.terminal);
                        if (currentAddons && currentAddons.searchAddon) {
                            currentAddons.searchAddon.findNext(input.value);
                        }
                    }
                } catch (e) {
                    console.warn('Search failed:', e);
                }
            });
            
            closeBtn.addEventListener('click', () => {
                searchContainer.remove();
                
                // Clear search highlights in ALL terminals
                this.terminals.forEach((terminalObj) => {
                    const addons = this.terminalAddons.get(terminalObj.terminal);
                    if (addons && addons.searchAddon) {
                        addons.searchAddon.findNext('');
                    }
                });
                
                // Focus the active terminal
                const currentTerminal = this.terminals.get(this.activeTabId);
                if (currentTerminal) {
                    currentTerminal.terminal.focus();
                }
            });
            
            input.addEventListener('keydown', (e) => {
                switch(e.key) {
                    case 'Enter':
                        e.preventDefault();
                        try {
                            const currentTerminal = this.terminals.get(this.activeTabId);
                            if (currentTerminal) {
                                const currentAddons = this.terminalAddons.get(currentTerminal.terminal);
                                if (currentAddons && currentAddons.searchAddon) {
                                    if (e.shiftKey) {
                                        currentAddons.searchAddon.findPrevious(input.value);
                                    } else {
                                        currentAddons.searchAddon.findNext(input.value);
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn('Search failed:', e);
                        }
                        break;
                    case 'Escape':
                        e.preventDefault();
                        searchContainer.remove();
                        
                        // Clear search highlights in ALL terminals
                        this.terminals.forEach((terminalObj) => {
                            const addons = this.terminalAddons.get(terminalObj.terminal);
                            if (addons && addons.searchAddon) {
                                addons.searchAddon.findNext('');
                            }
                        });
                        
                        // Focus the active terminal
                        const currentTerminal = this.terminals.get(this.activeTabId);
                        if (currentTerminal) {
                            currentTerminal.terminal.focus();
                        }
                        break;
                }
            });
            
            input.focus();
        } else {
            // If search box already exists, focus and select all text
            searchBox.focus();
            searchBox.select();
        }
    }
}