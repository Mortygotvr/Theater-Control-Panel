// Theater Split-Pane Window Manager Engine
window.SplitEngine = class {
    constructor(rootElement) {
        this.rootElement = rootElement;
        
        // Default layout: Grid Dashboard, Control Deck, Global Variables, Modules
        this.tree = { 
            id: 'pane-main', 
            tabs: [
                { title: 'Grid Dashboard', contentId: 'grid-mode-container' },
                { title: 'Control Deck', contentId: 'tab-control-deck' },
                { title: 'Global Variables', contentId: 'tab-global-variables' },
                { title: 'Modules', contentId: 'tab-modules' }
            ], 
            activeTabIndex: 0 
        };
        
        this.isDragging = false;
        this.dragContext = null;
        this.webviews = {}; // Track native webviews
        
        this.bindEvents();
        this.loadLayout().then(() => {
            this.render();
        });
        
        // Sync webviews on window resize
        window.addEventListener('resize', () => {
            requestAnimationFrame(() => this.syncAllWebviews());
        });
    }

    hasTab(contentId, node) {
        if (!node) return false;
        if (node.tabs && Array.isArray(node.tabs)) {
            if (node.tabs.some(t => t.contentId === contentId)) return true;
        }
        if (node.children && Array.isArray(node.children)) {
            return node.children.some(child => this.hasTab(contentId, child));
        }
        return false;
    }

    injectBaseTab(tabObj) {
        const findTargetNode = (node) => {
            if (!node) return null;
            if (node.tabs && Array.isArray(node.tabs)) {
                if (node.tabs.some(t => t.contentId === 'tab-control-deck')) return node;
                return node;
            }
            if (node.children) {
                for (const child of node.children) {
                    const res = findTargetNode(child);
                    if (res) return res;
                }
            }
            return null;
        };
        const target = findTargetNode(this.tree);
        if (target && target.tabs) {
            const deckIdx = target.tabs.findIndex(t => t.contentId === 'tab-control-deck');
            if (deckIdx >= 0) {
                target.tabs.splice(deckIdx + 1, 0, tabObj);
            } else {
                target.tabs.push(tabObj);
            }
        }
    }

    async loadLayout() {
        if (!window.__TAURI__) return;
        try {
            const data = await window.__TAURI__.core.invoke('read_config_file', { filename: 'split_layout.json' });
            if (data) {
                const parsed = JSON.parse(data);
                if (parsed && parsed.id) {
                    this.tree = parsed;
                    if (!this.hasTab('tab-global-variables', this.tree)) {
                        this.injectBaseTab({ title: 'Global Variables', contentId: 'tab-global-variables' });
                    }
                    if (this.tree.isLocked && window.__TAURI__) {
                        window.__TAURI__.core.invoke('toggle_window_lock', { locked: true }).catch(e => console.error(e));
                    }
                }
            }
        } catch (e) {
            console.log("No existing layout found. Using default.");
        }
    }

    async saveLayout() {
        if (!window.__TAURI__) return;
        try {
            await window.__TAURI__.core.invoke('save_config_file', {
                filename: 'split_layout.json',
                content: JSON.stringify(this.tree)
            });
        } catch (e) {
            console.error("Failed to save layout:", e);
        }
    }

    bindEvents() {
        document.addEventListener('mousedown', this.onMouseDown.bind(this));
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));
        
        // Use requestAnimationFrame for silky smooth 60fps syncing without lag
        const syncLoop = () => {
            this.syncAllWebviews();
            requestAnimationFrame(syncLoop);
        };
        requestAnimationFrame(syncLoop);
    }

    render() {
        // Create a hidden stash container if it doesn't exist
        if (!window.splitEngineStash) {
            window.splitEngineStash = document.createElement('div');
            window.splitEngineStash.id = 'split-engine-stash';
            window.splitEngineStash.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;';
            document.body.appendChild(window.splitEngineStash);
        }
        
        const contentNodes = {};
        const preserveIds = ['tab-control-deck', 'tab-modules', 'grid-mode-container'];
        preserveIds.forEach(id => {
            let el = (this.contentNodes && this.contentNodes[id]) ? this.contentNodes[id] : document.getElementById(id);
            if (el) {
                contentNodes[id] = el;
                window.splitEngineStash.appendChild(el);
            }
        });
        this.contentNodes = contentNodes;

        this.rootElement.innerHTML = '';
        const frag = this.renderNode(this.tree);
        frag.style.width = '100%';
        frag.style.height = '100%';
        this.rootElement.appendChild(frag);
        this.syncAllWebviews();
        // Re-render grid buttons after DOM is rebuilt
        requestAnimationFrame(() => {
            if (window.renderButtonGrid) window.renderButtonGrid();
        });
    }

    renderNode(node) {
        if (node.tabs) {
            // Leaf node with Tabs
            const el = document.createElement('div');
            el.className = 'split-leaf';
            el.dataset.nodeId = node.id;
            if (node.weight) el.style.flex = `${node.weight} 1 0%`;

            // Tab Bar
            const header = document.createElement('div');
            header.className = 'split-tab-bar';
            
            const tabsContainer = document.createElement('div');
            tabsContainer.className = 'tabs-container';
            
            node.tabs.forEach((tab, index) => {
                const tabEl = document.createElement('div');
                tabEl.className = `split-tab ${index === node.activeTabIndex ? 'active' : ''}`;
                
                const titleSpan = document.createElement('span');
                titleSpan.innerText = tab.title;
                tabEl.appendChild(titleSpan);
                
                // Add close button if it's not a base tab
                const isBaseTab = ['grid-mode-container', 'tab-control-deck', 'tab-modules'].includes(tab.contentId);
                if (!isBaseTab) {
                    const closeBtn = document.createElement('span');
                    closeBtn.innerHTML = '&times;';
                    closeBtn.className = 'tab-close-btn';
                    closeBtn.title = 'Close Tab';
                    closeBtn.onclick = (e) => {
                        e.stopPropagation(); // prevent clicking the tab itself
                        
                        // If it's a native webview, destroy it
                        if (tab.contentId && (tab.contentId.startsWith('tcp://') || tab.contentId.startsWith('webview::'))) {
                            this.destroyWebviewForNode(node.id);
                        }
                        
                        node.tabs.splice(index, 1);
                        
                        if (node.tabs.length === 0) {
                            // If it's the last tab in this node, add an empty dock so the pane doesn't vanish unexpectedly
                            node.tabs.push({ title: 'New Webpage', contentId: 'empty-web-dock' });
                            node.activeTabIndex = 0;
                        } else if (node.activeTabIndex >= node.tabs.length) {
                            node.activeTabIndex = node.tabs.length - 1;
                        } else if (node.activeTabIndex === index) {
                            // If we closed the active tab, just fall back to the first one safely
                            node.activeTabIndex = Math.max(0, index - 1);
                        }
                        
                        this.render();
                        this.saveLayout();
                        if (window.renderButtonGrid) window.renderButtonGrid();
                    };
                    tabEl.appendChild(closeBtn);
                }
                
                tabEl.onclick = () => {
                    node.activeTabIndex = index;
                    this.render();
                    this.saveLayout();
                    if (window.renderButtonGrid) window.renderButtonGrid();
                };
                tabsContainer.appendChild(tabEl);
            });
            
            const addTabBtn = document.createElement('button');
            addTabBtn.className = 'add-tab-btn';
            addTabBtn.innerText = '+';
            addTabBtn.title = 'Add New Tab';
            addTabBtn.onclick = () => {
                node.tabs.push({ title: 'New Webpage', contentId: 'empty-web-dock' });
                node.activeTabIndex = node.tabs.length - 1;
                this.render();
                this.saveLayout();
            };
            tabsContainer.appendChild(addTabBtn);
            
            const controls = document.createElement('div');
            controls.className = 'tab-controls';
            
            // Split buttons
            const splitV = document.createElement('button');
            splitV.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>';
            splitV.title = "Split Vertically (Side-by-Side)";
            splitV.onclick = () => this.splitNode(node, 'horizontal');
            
            const splitH = document.createElement('button');
            splitH.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="12" x2="21" y2="12"></line></svg>';
            splitH.title = "Split Horizontally (Top/Bottom)";
            splitH.onclick = () => this.splitNode(node, 'vertical');

            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = 'âœ•';
            closeBtn.title = "Close Panel";
            closeBtn.onclick = () => this.closeNode(node.id);
            
            controls.appendChild(splitH);
            controls.appendChild(splitV);
            
            const hasBaseTabs = node.tabs.some(t => ['grid-mode-container', 'tab-control-deck', 'tab-modules'].includes(t.contentId));
            
            if (hasBaseTabs) {
                const isMuted = this.tree.isMuted || false;
                const muteBtn = document.createElement('button');
                muteBtn.innerHTML = isMuted ? 'ðŸ”‡' : 'ðŸ”Š';
                muteBtn.title = isMuted ? "Unmute All Webviews" : "Mute All Webviews";
                muteBtn.onclick = () => {
                    this.tree.isMuted = !this.tree.isMuted;
                    this.saveLayout();
                    this.render();
                    if (window.__TAURI__) {
                        window.__TAURI__.core.invoke('toggle_global_mute', { muted: this.tree.isMuted }).catch(e => console.error(e));
                    }
                };
                
                const lockBtn = document.createElement('button');
                const isLocked = this.tree.isLocked || false;
                lockBtn.innerHTML = isLocked ? 'ðŸ”’' : 'ðŸ”“';
                lockBtn.title = isLocked ? "Unlock Layout & Window" : "Lock Layout & Window";
                lockBtn.onclick = () => {
                    this.tree.isLocked = !this.tree.isLocked;
                    this.saveLayout();
                    this.render();
                    if (window.__TAURI__) {
                        window.__TAURI__.core.invoke('toggle_window_lock', { locked: this.tree.isLocked }).catch(e => console.error(e));
                    }
                };
                
                controls.appendChild(muteBtn);
                controls.appendChild(lockBtn);
            }
            
            if (!hasBaseTabs) {
                controls.appendChild(closeBtn);
            }
            
            if (this.tree.isLocked) {
                splitH.style.display = 'none';
                splitV.style.display = 'none';
                closeBtn.style.display = 'none';
            }
            
            header.appendChild(tabsContainer);
            header.appendChild(controls);
            el.appendChild(header);

            // Active Content Body
            const body = document.createElement('div');
            body.className = 'split-body';
            body.id = `container-${node.id}`;
            
            const activeTab = node.tabs[node.activeTabIndex];
            if (activeTab) {
                if (this.contentNodes[activeTab.contentId]) {
                    const contentEl = this.contentNodes[activeTab.contentId];
                    if (contentEl) {
                        // Ensure element is fully visible when re-attached
                        contentEl.style.display = 'block';
                        contentEl.style.visibility = 'visible';
                        contentEl.style.width = '100%';
                        contentEl.style.height = '100%';
                        body.appendChild(contentEl);
                    }
                } else if (activeTab.contentId === 'empty-web-dock') {
                    const wrap = document.createElement('div');
                    wrap.style.cssText = 'padding: 20px; display: flex; flex-direction: column; gap: 15px; align-items: center; justify-content: center; height: 100%; color: #888; text-align: center;';
                    
                    const title = document.createElement('h3');
                    title.innerText = 'Open Webpage';
                    title.style.margin = '0';
                    title.style.color = '#ccc';
                    
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.placeholder = 'https://...';
                    input.style.cssText = 'padding: 10px; border-radius: 4px; border: 1px solid #444; background: #1a1a1a; color: white; width: 80%; max-width: 400px; text-align: center; font-size: 1.1em;';
                    
                    const btn = document.createElement('button');
                    btn.innerText = 'Load Page';
                    btn.style.cssText = 'padding: 10px 30px; background: #007acc; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 1em;';
                    
                    btn.onclick = () => {
                       let url = input.value.trim();
                       if (url.match(/^[a-zA-Z]:\\/) || url.match(/^[a-zA-Z]:\//)) {
                           url = 'file:///' + url.replace(/\\/g, '/');
                       } else if (!url.startsWith('http') && !url.startsWith('tcp://') && !url.startsWith('file://')) {
                           url = 'https://' + url;
                       }
                       activeTab.contentId = 'webview::' + url;
                       activeTab.title = url.replace(/^https?:\/\//, '').split('/')[0];
                       this.render();
                       this.saveLayout();
                    };
                    
                    wrap.appendChild(title);
                    wrap.appendChild(input);
                    wrap.appendChild(btn);
                    body.appendChild(wrap);
                } else if (activeTab.contentId && (activeTab.contentId.startsWith('tcp://') || activeTab.contentId.startsWith('webview::'))) {
                    // Webview will be placed here natively via syncAllWebviews
                    let targetUrl = activeTab.contentId;
                    if (targetUrl.startsWith('tcp://')) targetUrl = targetUrl.replace('tcp://', 'http://');
                    else targetUrl = targetUrl.substring(9);
                    // Webview creation is handled entirely by syncAllWebviews
                }
            }
            
            el.appendChild(body);
            return el;
        } else {
            // Parent node
            const el = document.createElement('div');
            el.className = `split-parent split-${node.type}`;
            el.dataset.nodeId = node.id;
            if (node.weight) {
                el.style.flex = `${node.weight} 1 0%`;
            }

            node.children.forEach((child, index) => {
                el.appendChild(this.renderNode(child));
                // Add divider between children
                if (index < node.children.length - 1) {
                    const divider = document.createElement('div');
                    divider.className = `split-divider divider-${node.type}`;
                    divider.dataset.index = index;
                    divider.dataset.parentId = node.id;
                    
                    const handle = document.createElement('div');
                    handle.className = 'divider-handle';
                    divider.appendChild(handle);
                    
                    el.appendChild(divider);
                }
            });
            return el;
        }
    }

    findNodeAndParent(id, currentNode = this.tree, parent = null) {
        if (currentNode.id === id) return { node: currentNode, parent };
        if (currentNode.children) {
            for (let child of currentNode.children) {
                const res = this.findNodeAndParent(id, child, currentNode);
                if (res) return res;
            }
        }
        return null;
    }

    splitNode(node, type) {
        const tabs = node.tabs;
        const activeTabIndex = node.activeTabIndex;
        delete node.tabs;
        delete node.activeTabIndex;
        node.type = type;
        node.children = [
            { id: node.id + '_a', weight: 50, tabs: tabs, activeTabIndex: activeTabIndex },
            { id: node.id + '_b', weight: 50, tabs: [{ title: 'New Webpage', contentId: 'empty-web-dock' }], activeTabIndex: 0 }
        ];
        this.render();
        this.saveLayout();
    }

    closeNode(id) {
        const res = this.findNodeAndParent(id);
        if (!res) return;
        
        if (!res.parent) {
            // Closing the root pane! Just reset it to a single empty dock.
            this.destroyWebviewForNode(id);
            if (this.tree.children) {
                // Destroy all nested webviews recursively
                const destroyAll = (node) => {
                    this.destroyWebviewForNode(node.id);
                    if (node.children) node.children.forEach(destroyAll);
                };
                this.tree.children.forEach(destroyAll);
            }
            this.tree = { id: 'pane-main', tabs: [{ title: 'New Webpage', contentId: 'empty-web-dock' }], activeTabIndex: 0 };
            this.render();
            this.saveLayout();
            return;
        }
        
        const parent = res.parent;
        const index = parent.children.findIndex(c => c.id === id);
        
        this.destroyWebviewForNode(id);
        parent.children.splice(index, 1);
        
        if (parent.children.length === 1) {
            const onlyChild = parent.children[0];
            if (onlyChild.tabs) {
                parent.tabs = onlyChild.tabs;
                parent.activeTabIndex = onlyChild.activeTabIndex;
            } else {
                parent.type = onlyChild.type;
                parent.children = onlyChild.children;
            }
        } else {
            parent.children.forEach(c => c.weight = 100 / parent.children.length);
        }
        
        this.render();
        this.saveLayout();
    }

    onMouseDown(e) {
        const divider = e.target.closest('.split-divider');
        if (divider) {
            this.isDragging = true;
            const isHorizontal = divider.classList.contains('divider-horizontal');
            const parentId = divider.dataset.parentId;
            const index = parseInt(divider.dataset.index);
            
            this.dragContext = {
                isHorizontal,
                parentId,
                index,
                startX: e.clientX,
                startY: e.clientY
            };
            
            document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
            document.querySelectorAll('.split-body').forEach(el => el.style.pointerEvents = 'none');
            
            // Force hide webviews immediately so they don't swallow mouse events during drag
            this.syncAllWebviews();
        }
    }

    onMouseMove(e) {
        if (!this.isDragging || !this.dragContext) return;
        
        const { isHorizontal, parentId, index } = this.dragContext;
        const parentRes = this.findNodeAndParent(parentId);
        if (!parentRes) return;
        const parentNode = parentRes.node;
        
        const childA = parentNode.children[index];
        const childB = parentNode.children[index + 1];
        
        const domA = document.querySelector(`[data-node-id="${childA.id}"]`);
        const domB = document.querySelector(`[data-node-id="${childB.id}"]`);
        
        if (!domA || !domB) return;
        
        const parentDom = domA.parentElement;
        const totalSize = isHorizontal ? parentDom.clientWidth : parentDom.clientHeight;
        const delta = isHorizontal ? e.movementX : e.movementY;
        
