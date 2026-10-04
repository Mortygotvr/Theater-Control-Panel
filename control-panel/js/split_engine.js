// Theater Split-Pane Window Manager Engine

// The base tabs, and which of them each page shows (window.CP_VIEW, set in
// control_panel.html). Inside OBS the Control Panel is two pages: the dock
// (button grid + web tabs) and the settings window (everything else).
const CP_BASE_TABS = {
    grid: { id: 'tab_grid_dashboard', title: 'Grid Dashboard', contentId: 'grid-mode-container' },
    deck: { id: 'tab_control_deck', title: 'Control Deck', contentId: 'tab-control-deck' },
    vars: { id: 'tab_global_vars', title: 'Global Variables', contentId: 'tab-global-variables' },
    modules: { id: 'tab_modules_list', title: 'Modules', contentId: 'tab-modules' },
    // the plugin's options: only inside OBS
    perf: { id: 'tab_performance', title: '⚡ Performance', contentId: 'tab-performance' }
};
const CP_VIEW_TABS = {
    full: ['grid', 'deck', 'vars', 'modules'],
    dock: ['grid'],
    settings: ['deck', 'vars', 'modules', 'perf']
};
const cpViewTabs = () => (CP_VIEW_TABS[window.CP_VIEW] || CP_VIEW_TABS.full).map(key => ({ ...CP_BASE_TABS[key] }));
// Each page keeps its own layout.
const cpLayoutFile = () => window.CP_VIEW === 'settings' ? 'split_layout_settings.json' : 'split_layout.json';
// The settings window's layout is fixed: one locked panel with its tabs, and
// no split, lock, close or add-web-tab controls (those are the dock's).
const cpFixedLayout = () => window.CP_VIEW === 'settings';

window.SplitEngine = class {
    constructor(rootElement) {
        this.rootElement = rootElement;

        // Default layout: this page's base tabs
        this.tree = {
            id: 'pane-main',
            tabs: cpViewTabs(),
            activeTabIndex: 0
        };
        
        this.isDragging = false;
        this.dragContext = null;
        this.webviews = {}; // Track native webviews by stable tab.id: { [tabId]: { label, url, isHidden, isCreating, lastRect } }
        this.creationQueue = [];
        this.isProcessingQueue = false;
        this._initialRender = true;
        this.isModalOpen = false;
        
        this.bindEvents();
        this.loadLayout().then(() => {
            this.applyViewTabs();
            this.ensureTabIds();
            this.render();
        });
        
        // Sync webviews on window resize and fullscreen events
        window.addEventListener('resize', () => {
            requestAnimationFrame(() => this.syncAllWebviews());
        });

        // ResizeObserver tracks root container sizing changes (maximize, restore, fullscreen)
        if (window.ResizeObserver && this.rootElement) {
            this.resizeObserver = new ResizeObserver(() => {
                requestAnimationFrame(() => this.syncAllWebviews());
            });
            this.resizeObserver.observe(this.rootElement);
        }
    }

    ensureTabIds(node = this.tree) {
        if (!node) return;
        if (node.tabs && Array.isArray(node.tabs)) {
            node.tabs.forEach(tab => {
                if (!tab.id) {
                    tab.id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
                }
            });
        }
        if (node.children && Array.isArray(node.children)) {
            node.children.forEach(child => this.ensureTabIds(child));
        }
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
            if (!tabObj.id) {
                tabObj.id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
            }
            const deckIdx = target.tabs.findIndex(t => t.contentId === 'tab-control-deck');
            if (deckIdx >= 0) {
                target.tabs.splice(deckIdx + 1, 0, tabObj);
            } else {
                target.tabs.push(tabObj);
            }
        }
    }

    // Makes the layout show exactly this page's base tabs: drops the ones that
    // belong to the other page (and panes left empty), and adds missing ones.
    applyViewTabs() {
        const wanted = cpViewTabs();
        const wantedIds = wanted.map(t => t.contentId);
        const baseIds = Object.values(CP_BASE_TABS).map(t => t.contentId);

        if (cpFixedLayout()) {
            // One panel with this page's tabs; only the open tab is remembered
            const leaf = (node) => node.tabs ? node : (node.children || []).map(leaf).find(Boolean);
            const saved = leaf(this.tree);
            const open = saved && saved.tabs[saved.activeTabIndex || 0];
            const index = open ? wantedIds.indexOf(open.contentId) : -1;
            this.tree = { id: 'pane-main', tabs: wanted, activeTabIndex: Math.max(0, index), isLocked: true };
            return;
        }

        // Returns false when nothing is left in `node`. Checks `tabs` before
        // `children`, like renderNode.
        const prune = (node) => {
            if (node.tabs) {
                node.tabs = node.tabs.filter(t => !baseIds.includes(t.contentId) || wantedIds.includes(t.contentId));
                node.activeTabIndex = Math.min(node.activeTabIndex || 0, Math.max(0, node.tabs.length - 1));
                return node.tabs.length > 0;
            }
            if (node.children) {
                node.children = node.children.filter(prune);
                if (node.children.length === 1) {
                    // A split with one pane left becomes that pane.
                    const kept = { weight: node.weight, isLocked: node.isLocked, isMuted: node.isMuted };
                    const only = node.children[0];
                    Object.keys(node).forEach(key => delete node[key]);
                    Object.assign(node, only);
                    Object.entries(kept).forEach(([key, value]) => {
                        if (value === undefined) delete node[key];
                        else node[key] = value;
                    });
                }
                return !node.children || node.children.length > 0;
            }
            return false;
        };
        if (!prune(this.tree)) {
            this.tree = { id: 'pane-main', tabs: [], activeTabIndex: 0, isLocked: this.tree.isLocked, isMuted: this.tree.isMuted };
        }

        const firstLeaf = (node) => node.tabs ? node : (node.children || []).map(firstLeaf).find(Boolean);
        const target = firstLeaf(this.tree);
        wanted.forEach(tab => {
            if (target && !this.hasTab(tab.contentId, this.tree)) target.tabs.push(tab);
        });
    }

    async loadLayout() {
        if (!window.__TAURI__) return;
        try {
            const data = await window.__TAURI__.core.invoke('read_config_file', { filename: cpLayoutFile() });
            if (data) {
                const parsed = JSON.parse(data);
                if (parsed && parsed.id) {
                    this.tree = parsed;
                    this.ensureTabIds();
                    if (this.tree.isLocked && window.__TAURI__) {
                        window.__TAURI__.core.invoke('toggle_window_lock', { locked: true }).catch(e => console.error(e));
                    }
                    if (this.tree.isMuted && window.__TAURI__) {
                        window.__TAURI__.core.invoke('toggle_global_mute', { muted: true }).catch(e => console.error(e));
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
            this.ensureTabIds();
            await window.__TAURI__.core.invoke('save_config_file', {
                filename: cpLayoutFile(),
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
        
        if (window.__TAURI__) {
            window.__TAURI__.event.listen('child-zoom-changed', (e) => {
                const { label, zoom } = e.payload;
                for (const [tabId, webviewData] of Object.entries(this.webviews)) {
                    if (webviewData.label === label) {
                        const findTabInNode = (node) => {
                            if (node.tabs) {
                                const tab = node.tabs.find(t => t.id === tabId);
                                if (tab) return tab;
                            }
                            if (node.children) {
                                for (const child of node.children) {
                                    const res = findTabInNode(child);
                                    if (res) return res;
                                }
                            }
                            return null;
                        };
                        const tab = findTabInNode(this.tree);
                        if (tab && tab.zoom !== zoom) {
                            tab.zoom = zoom;
                            this.saveLayout();
                        }
                    }
                }
            });
        }
        
        document.addEventListener('wheel', this.onWheel.bind(this), { passive: false });

        // Continuous sync loop to keep webview positions locked to DOM containers
        const syncLoop = () => {
            this.syncAllWebviews();
            requestAnimationFrame(syncLoop);
        };
        requestAnimationFrame(syncLoop);
    }

    onWheel(e) {
        if (e.ctrlKey) {
            const splitBody = e.target.closest('.split-body');
            if (splitBody) {
                const nodeId = splitBody.id.replace('container-', '');
                const res = this.findNodeAndParent(nodeId);
                if (res && res.node && res.node.tabs) {
                    const activeTab = res.node.tabs[res.node.activeTabIndex];
                    if (activeTab && !activeTab.contentId.startsWith('webview::') && !activeTab.contentId.startsWith('tcp://')) {
                        e.preventDefault();
                        
                        let currentZoom = activeTab.zoom || 1.0;
                        if (e.deltaY < 0) {
                            currentZoom += 0.05;
                        } else {
                            currentZoom -= 0.05;
                        }
                        currentZoom = Math.min(Math.max(currentZoom, 0.25), 2.5);
                        currentZoom = Math.round(currentZoom * 100) / 100;
                        
                        if (activeTab.zoom !== currentZoom) {
                            activeTab.zoom = currentZoom;
                            const contentEl = this.contentNodes[activeTab.contentId];
                            if (contentEl) {
                                contentEl.style.zoom = currentZoom;
                            }
                            this.saveLayout();
                        }
                    }
                }
            }
        }
    }

    render() {
        this.ensureTabIds();

        // Create a hidden stash container if it doesn't exist
        if (!window.splitEngineStash) {
            window.splitEngineStash = document.createElement('div');
            window.splitEngineStash.id = 'split-engine-stash';
            window.splitEngineStash.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;';
            document.body.appendChild(window.splitEngineStash);
        }
        
        const contentNodes = {};
        const preserveIds = ['tab-control-deck', 'tab-global-variables', 'tab-modules', 'tab-performance', 'grid-mode-container'];
        preserveIds.forEach(id => {
            let el = (this.contentNodes && this.contentNodes[id]) ? this.contentNodes[id] : document.getElementById(id);
            if (el) {
                contentNodes[id] = el;
                window.splitEngineStash.appendChild(el);
            }
        });
        this.contentNodes = contentNodes;

        this.rootElement.innerHTML = '';
        // Locked: panel sizes are fixed (the dividers ignore the mouse; see split_engine.css).
        this.rootElement.classList.toggle('layout-locked', !!this.tree.isLocked);
        const frag = this.renderNode(this.tree);
        frag.style.width = '100%';
        frag.style.height = '100%';
        this.rootElement.appendChild(frag);

        if (this._initialRender) {
            requestAnimationFrame(() => {
                setTimeout(() => {
                    this._initialRender = false;
                    this.syncAllWebviews();
                }, 150);
            });
        } else {
            requestAnimationFrame(() => {
                this.syncAllWebviews();
            });
        }

        requestAnimationFrame(() => {
            if (window.renderButtonGrid) window.renderButtonGrid();
        });
    }

    getActiveWebviewForNode(nodeId) {
        if (!this.webviews) return null;
        const res = this.findNodeAndParent(nodeId);
        if (!res || !res.node || !res.node.tabs) return null;
        const activeTab = res.node.tabs[res.node.activeTabIndex];
        if (!activeTab || !activeTab.id) return null;
        return this.webviews[activeTab.id] || null;
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
                if (!tab.id) {
                    tab.id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
                }

                const tabEl = document.createElement('div');
                tabEl.className = `split-tab ${index === node.activeTabIndex ? 'active' : ''}`;
                
                const titleSpan = document.createElement('span');
                titleSpan.innerText = tab.title;
                tabEl.appendChild(titleSpan);
                
                const isBaseTab = ['grid-mode-container', 'tab-control-deck', 'tab-global-variables', 'tab-modules', 'tab-performance'].includes(tab.contentId);
                if (!isBaseTab) {
                    const closeBtn = document.createElement('span');
                    closeBtn.innerHTML = '&times;';
                    closeBtn.className = 'tab-close-btn';
                    closeBtn.title = 'Close Tab';
                    closeBtn.onclick = (e) => {
                        e.stopPropagation();
                        
                        this.destroyWebviewForTab(tab.id);
                        node.tabs.splice(index, 1);
                        
                        if (node.tabs.length === 0) {
                            node.tabs.push({ id: 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8), title: 'New Webpage', contentId: 'empty-web-dock' });
                            node.activeTabIndex = 0;
                        } else if (node.activeTabIndex >= node.tabs.length) {
                            node.activeTabIndex = node.tabs.length - 1;
                        } else if (node.activeTabIndex === index) {
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
                node.tabs.push({ id: 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8), title: 'New Webpage', contentId: 'empty-web-dock' });
                node.activeTabIndex = node.tabs.length - 1;
                this.render();
                this.saveLayout();
            };
            if (!cpFixedLayout()) tabsContainer.appendChild(addTabBtn);

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
            closeBtn.innerHTML = '✕';
            closeBtn.title = "Close Panel";
            closeBtn.onclick = () => this.closeNode(node.id);
            
            controls.appendChild(splitH);
            controls.appendChild(splitV);
            
            const hasBaseTabs = node.tabs.some(t => ['grid-mode-container', 'tab-control-deck', 'tab-global-variables', 'tab-modules', 'tab-performance'].includes(t.contentId));
            
            if (hasBaseTabs) {
                const lockBtn = document.createElement('button');
                const isLocked = this.tree.isLocked || false;
                lockBtn.innerHTML = isLocked ? '🔒' : '🔓';
                lockBtn.title = isLocked ? "Unlock Layout & Window" : "Lock Layout & Window";
                lockBtn.onclick = () => {
                    this.tree.isLocked = !this.tree.isLocked;
                    this.saveLayout();
                    this.render();
                    if (window.__TAURI__) {
                        window.__TAURI__.core.invoke('toggle_window_lock', { locked: this.tree.isLocked }).catch(e => console.error(e));
                    }
                };
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
            if (!cpFixedLayout()) header.appendChild(controls);
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
                        contentEl.style.display = 'block';
                        contentEl.style.visibility = 'visible';
                        contentEl.style.width = '100%';
                        contentEl.style.height = '100%';
                        contentEl.style.zoom = activeTab.zoom || 1.0;
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
                    input.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };

                    const btn = document.createElement('button');
                    btn.innerText = 'Load Page';
                    btn.style.cssText = 'padding: 10px 30px; background: #007acc; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 1em;';
                    
                    btn.onclick = () => {
                        let url = input.value.trim();
                        if (!url) return;
                        if (url.match(/^[a-zA-Z]:\\/) || url.match(/^[a-zA-Z]:\//)) {
                            url = 'file:///' + url.replace(/\\/g, '/');
                        } else if (!url.startsWith('http') && !url.startsWith('tcp://') && !url.startsWith('file://')) {
                            url = 'https://' + url;
                        }
                        activeTab.contentId = 'webview::' + url;
                        let titleVal = url;
                        if (url.startsWith('file://') || url.match(/^[a-zA-Z]:[\\/]/)) {
                            titleVal = url.replace(/^file:\/\/\//, '').split('/').pop().split('#')[0].split('?')[0];
                        } else {
                            titleVal = url.replace(/^https?:\/\//, '').split('/')[0];
                        }
                        activeTab.title = titleVal || "Webpage";
                        this.render();
                        this.saveLayout();
                    };
                    
                    wrap.appendChild(title);
                    wrap.appendChild(input);
                    wrap.appendChild(btn);

                    // Quick launch presets
                    const presetsWrap = document.createElement('div');
                    presetsWrap.className = 'quick-launch-presets';
                    presetsWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; justify-content:center; max-width:440px; margin-top:10px;';

                    const presets = [
                        { name: '🟣 Twitch Chat', url: 'https://www.twitch.tv/popout/modern/chat' },
                        { name: '🟢 Kick Chat', url: 'https://kick.com' },
                        { name: '🔴 YouTube Studio', url: 'https://studio.youtube.com' },
                        { name: '💬 Discord Web', url: 'https://discord.com/app' },
                        { name: '⚡ StreamElements', url: 'https://streamelements.com/dashboard' },
                        { name: '📊 OBS Stats', url: 'http://127.0.0.1:4455' }
                    ];

                    presets.forEach(p => {
                        const pBtn = document.createElement('button');
                        pBtn.className = 'preset-dock-btn';
                        pBtn.innerText = p.name;
                        pBtn.style.cssText = 'background:#252526; border:1px solid #444; color:#ccc; padding:6px 12px; border-radius:4px; font-size:0.85em; cursor:pointer; transition:all 0.2s ease;';
                        pBtn.onmouseenter = () => { pBtn.style.background = '#007acc'; pBtn.style.color = '#fff'; };
                        pBtn.onmouseleave = () => { pBtn.style.background = '#252526'; pBtn.style.color = '#ccc'; };
                        pBtn.onclick = () => {
                            activeTab.contentId = 'webview::' + p.url;
                            activeTab.title = p.name.replace(/^[^\s]+\s*/, '');
                            this.render();
                            this.saveLayout();
                        };
                        presetsWrap.appendChild(pBtn);
                    });
                    wrap.appendChild(presetsWrap);

                    body.appendChild(wrap);
                } else if (activeTab.contentId && (activeTab.contentId.startsWith('tcp://') || activeTab.contentId.startsWith('webview::'))) {
                    let targetUrl = activeTab.contentId;
                    if (targetUrl.startsWith('tcp://')) targetUrl = targetUrl.replace('tcp://', 'http://');
                    else targetUrl = targetUrl.substring(9);

                    const toolbar = document.createElement('div');
                    toolbar.className = 'dock-web-toolbar';
                    
                    // Back Button
                    const backBtn = document.createElement('button');
                    backBtn.className = 'toolbar-btn';
                    backBtn.innerHTML = '‹';
                    backBtn.title = 'Back';
                    backBtn.onclick = () => {
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('navigate_child_webview_back', { label: wv.label });
                        }
                    };

                    // Forward Button
                    const fwdBtn = document.createElement('button');
                    fwdBtn.className = 'toolbar-btn';
                    fwdBtn.innerHTML = '›';
                    fwdBtn.title = 'Forward';
                    fwdBtn.onclick = () => {
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('navigate_child_webview_forward', { label: wv.label });
                        }
                    };

                    // Reload Button
                    const reloadBtn = document.createElement('button');
                    reloadBtn.className = 'toolbar-btn';
                    reloadBtn.innerHTML = '↻';
                    reloadBtn.title = 'Reload Page';
                    reloadBtn.onclick = () => {
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('reload_child_webview', { label: wv.label });
                        }
                    };

                    // URL Address Display / Editor
                    const urlInput = document.createElement('input');
                    urlInput.className = 'toolbar-url-input';
                    urlInput.type = 'text';
                    urlInput.value = targetUrl;
                    urlInput.title = 'Press Enter to Navigate';
                    urlInput.onkeydown = (e) => {
                        if (e.key === 'Enter') {
                            let newUrl = urlInput.value.trim();
                            if (!newUrl) return;
                            if (!newUrl.startsWith('http') && !newUrl.startsWith('file://')) {
                                newUrl = 'https://' + newUrl;
                            }
                            activeTab.contentId = 'webview::' + newUrl;
                            let titleVal = newUrl.replace(/^https?:\/\//, '').split('/')[0];
                            activeTab.title = titleVal || "Webpage";
                            this.render();
                            this.saveLayout();
                        }
                    };

                    // Zoom Out Button
                    const zoomOutBtn = document.createElement('button');
                    zoomOutBtn.className = 'toolbar-btn zoom-btn';
                    zoomOutBtn.innerHTML = '−';
                    zoomOutBtn.title = 'Zoom Out (-10%)';
                    zoomOutBtn.onclick = () => {
                        let currentZoom = activeTab.zoom || 1.0;
                        currentZoom = Math.max(0.3, Math.round((currentZoom - 0.1) * 10) / 10);
                        activeTab.zoom = currentZoom;
                        zoomLabel.innerText = Math.round(currentZoom * 100) + '%';
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('set_child_webview_zoom', { label: wv.label, zoom: currentZoom });
                        }
                        this.saveLayout();
                    };

                    // Zoom Label / Reset
                    const zoomLabel = document.createElement('span');
                    zoomLabel.className = 'toolbar-zoom-label';
                    zoomLabel.innerText = Math.round((activeTab.zoom || 1.0) * 100) + '%';
                    zoomLabel.title = 'Click to Reset Zoom (100%)';
                    zoomLabel.onclick = () => {
                        activeTab.zoom = 1.0;
                        zoomLabel.innerText = '100%';
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('set_child_webview_zoom', { label: wv.label, zoom: 1.0 });
                        }
                        this.saveLayout();
                    };

                    // Zoom In Button
                    const zoomInBtn = document.createElement('button');
                    zoomInBtn.className = 'toolbar-btn zoom-btn';
                    zoomInBtn.innerHTML = '+';
                    zoomInBtn.title = 'Zoom In (+10%)';
                    zoomInBtn.onclick = () => {
                        let currentZoom = activeTab.zoom || 1.0;
                        currentZoom = Math.min(3.0, Math.round((currentZoom + 0.1) * 10) / 10);
                        activeTab.zoom = currentZoom;
                        zoomLabel.innerText = Math.round(currentZoom * 100) + '%';
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('set_child_webview_zoom', { label: wv.label, zoom: currentZoom });
                        }
                        this.saveLayout();
                    };

                    // Mute Audio Toggle
                    const muteBtn = document.createElement('button');
                    muteBtn.className = 'toolbar-btn mute-btn';
                    muteBtn.innerHTML = activeTab.isMuted ? '🔇' : '🔊';
                    muteBtn.title = activeTab.isMuted ? 'Unmute Audio' : 'Mute Audio';
                    muteBtn.onclick = () => {
                        activeTab.isMuted = !activeTab.isMuted;
                        muteBtn.innerHTML = activeTab.isMuted ? '🔇' : '🔊';
                        muteBtn.title = activeTab.isMuted ? 'Unmute Audio' : 'Mute Audio';
                        const wv = this.getActiveWebviewForNode(node.id);
                        if (wv && window.__TAURI__) {
                            window.__TAURI__.core.invoke('toggle_child_webview_mute', { label: wv.label, muted: activeTab.isMuted });
                        }
                        this.saveLayout();
                    };

                    toolbar.appendChild(backBtn);
                    toolbar.appendChild(fwdBtn);
                    toolbar.appendChild(reloadBtn);
                    toolbar.appendChild(urlInput);
                    toolbar.appendChild(zoomOutBtn);
                    toolbar.appendChild(zoomLabel);
                    toolbar.appendChild(zoomInBtn);
                    toolbar.appendChild(muteBtn);

                    body.appendChild(toolbar);
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
            { id: node.id + '_b', weight: 50, tabs: [{ id: 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8), title: 'New Webpage', contentId: 'empty-web-dock' }], activeTabIndex: 0 }
        ];
        this.render();
        this.saveLayout();
    }

    closeNode(id) {
        const res = this.findNodeAndParent(id);
        if (!res) return;
        
        if (!res.parent) {
            this.destroyWebviewForNode(id);
            if (this.tree.children) {
                const destroyAll = (node) => {
                    this.destroyWebviewForNode(node.id);
                    if (node.children) node.children.forEach(destroyAll);
                };
                this.tree.children.forEach(destroyAll);
            }
            this.tree = { id: 'pane-main', tabs: [{ id: 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8), title: 'New Webpage', contentId: 'empty-web-dock' }], activeTabIndex: 0 };
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
        if (divider && !this.tree.isLocked) {
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
        
        const deltaPercent = (delta / totalSize) * 100;
        
        childA.weight += deltaPercent;
        childB.weight -= deltaPercent;
        
        if (childA.weight < 5) { childB.weight += childA.weight - 5; childA.weight = 5; }
        if (childB.weight < 5) { childA.weight += childB.weight - 5; childB.weight = 5; }
        
        domA.style.flex = `${childA.weight} 1 0%`;
        domB.style.flex = `${childB.weight} 1 0%`;
        
        this.syncAllWebviews();
    }

    onMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.dragContext = null;
            document.body.style.cursor = '';
            document.querySelectorAll('.split-body').forEach(el => el.style.pointerEvents = 'auto');
            this.syncAllWebviews();
            this.saveLayout();
        }
    }

    async loadUrlInNode(nodeId, url) {
        const res = this.findNodeAndParent(nodeId);
        if (res && res.node && res.node.tabs) {
            const activeTab = res.node.tabs[res.node.activeTabIndex];
            if (activeTab) {
                activeTab.contentId = 'webview::' + url;
                let titleVal = url;
                if (url.startsWith('file://') || url.match(/^[a-zA-Z]:[\\/]/)) {
                    titleVal = url.replace(/^file:\/\/\//, '').split('/').pop().split('#')[0].split('?')[0];
                } else {
                    titleVal = url.replace(/^https?:\/\//, '').split('/')[0];
                }
                activeTab.title = titleVal || "Webpage";
                this.saveLayout();
                const tabEl = document.querySelector(`.split-leaf[data-node-id="${nodeId}"] .split-tab.active span`);
                if (tabEl) tabEl.innerText = activeTab.title;
            }
        }
        this.syncAllWebviews();
    }

    syncAllWebviews() {
        if (!window.__TAURI__ || this._initialRender) return;
        this.ensureTabIds();

        const currentWebviewTabs = new Map();
        const forceHide = this.isDragging || this.isModalOpen;

        const scanTree = (node) => {
            if (node.tabs) {
                node.tabs.forEach((tab, index) => {
                    if (tab.contentId && (tab.contentId.startsWith('tcp://') || tab.contentId.startsWith('webview::'))) {
                        let url = tab.contentId;
                        if (url.startsWith('tcp://')) url = url.replace('tcp://', 'http://');
                        else url = url.substring(9);
                        const isActive = (index === node.activeTabIndex) && !forceHide;
                        currentWebviewTabs.set(tab.id, {
                            tab,
                            url,
                            nodeId: node.id,
                            isActive
                        });
                    }
                });
            } else if (node.children) {
                node.children.forEach(scanTree);
            }
        };
        scanTree(this.tree);

        // Pass 1: Destroy webviews for tabs that were removed
        for (const [tabId, webviewData] of Object.entries(this.webviews)) {
            if (!currentWebviewTabs.has(tabId)) {
                if (!webviewData.isCreating) {
                    window.__TAURI__.core.invoke('destroy_child_webview', { label: webviewData.label })
                        .catch(e => console.warn('destroy_child_webview failed:', e));
                }
                delete this.webviews[tabId];
                this.creationQueue = this.creationQueue.filter(item => item.tabId !== tabId);
            }
        }

        // Pass 2: Update existing tracked webviews
        for (const [tabId, info] of currentWebviewTabs.entries()) {
            const webviewData = this.webviews[tabId];
            if (!webviewData) continue;

            if (webviewData.url !== info.url && !webviewData.isCreating) {
                webviewData.url = info.url;
                window.__TAURI__.core.invoke('navigate_child_webview_url', {
                    label: webviewData.label,
                    url: info.url
                }).catch(e => console.warn('navigate_child_webview_url failed:', e));
            }

            const bodyEl = document.getElementById(`container-${info.nodeId}`);
            if (webviewData.isCreating) continue;

            if (info.isActive && bodyEl) {
                let focusRequested = false;
                if (webviewData.isHidden) {
                    webviewData.isHidden = false;
                    webviewData.lastRect = null;
                    focusRequested = true;
                }
                const rect = bodyEl.getBoundingClientRect();
                const physWidth = Math.max(0, rect.width);
                const physHeight = Math.max(0, rect.height);
                if (rect.width === 0 || rect.height === 0) continue;

                const toolbarEl = bodyEl.querySelector('.dock-web-toolbar');
                const tbHeight = toolbarEl ? toolbarEl.offsetHeight : 0;
                const x = Math.round(rect.left);
                const y = Math.round(rect.top + tbHeight);
                const w = Math.round(physWidth);
                const h = Math.max(50, Math.round(physHeight - tbHeight));

                if (!focusRequested &&
                    webviewData.lastRect &&
                    webviewData.lastRect.x === x &&
                    webviewData.lastRect.y === y &&
                    webviewData.lastRect.width === w &&
                    webviewData.lastRect.height === h) {
                    continue;
                }
                webviewData.lastRect = { x, y, width: w, height: h };
                window.__TAURI__.core.invoke('update_child_webview', {
                    label: webviewData.label,
                    x, y, width: w, height: h,
                    focus: focusRequested
                }).catch(() => {});
            } else {
                if (webviewData.isHidden) continue;
                webviewData.isHidden = true;
                webviewData.lastRect = null;
                window.__TAURI__.core.invoke('hide_child_webview', { label: webviewData.label })
                    .catch(e => console.warn('hide_child_webview failed:', e));
            }
        }

        // Pass 3: Queue creation for new webviews
        for (const [tabId, info] of currentWebviewTabs.entries()) {
            if (this.webviews[tabId]) continue;

            const bodyEl = document.getElementById(`container-${info.nodeId}`);
            if (!bodyEl) continue;

            const rect = bodyEl.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const physWidth = Math.max(0, rect.width);
            const physHeight = Math.max(0, rect.height);
            const newLabel = `webview_${tabId}`;

            const toolbarEl = bodyEl.querySelector('.dock-web-toolbar');
            const tbHeight = toolbarEl ? toolbarEl.offsetHeight : 0;
            const x = Math.round(rect.left);
            const y = Math.round(rect.top + tbHeight);
            const w = Math.max(100, Math.round(physWidth));
            const h = Math.max(50, Math.round(physHeight - tbHeight));

            this.webviews[tabId] = {
                label: newLabel,
                url: info.url,
                isHidden: !info.isActive,
                isCreating: true,
                lastRect: null
            };

            const queueItem = {
                tabId,
                nodeId: info.nodeId,
                url: info.url,
                tab: info.tab,
                active: info.isActive,
                label: newLabel,
                x, y, w, h
            };

            if (info.isActive) {
                this.creationQueue.unshift(queueItem);
            } else {
                this.creationQueue.push(queueItem);
            }
        }

        this.processCreationQueue();
    }

    processCreationQueue() {
        if (this.isProcessingQueue || this.creationQueue.length === 0) return;
        this.isProcessingQueue = true;

        const processNext = async () => {
            if (this.creationQueue.length === 0) {
                this.isProcessingQueue = false;
                return;
            }

            const item = this.creationQueue.shift();
            const { tabId, nodeId, url, tab, active, label, x, y, w, h } = item;

            if (!this.webviews[tabId]) {
                processNext();
                return;
            }

            const isMuted = !!(tab.isMuted || (this.tree && this.tree.isMuted));
            console.log(`[Frontend] ProcessQueue: Creating webview for URL: ${url} (visible: ${active}) with zoom: ${tab.zoom} (muted: ${isMuted})`);
            try {
                await window.__TAURI__.core.invoke('create_child_webview', {
                    label, url,
                    x, y, width: w, height: h,
                    zoom: tab.zoom || null,
                    visible: active,
                    muted: isMuted
                });

                if (this.webviews[tabId]) {
                    this.webviews[tabId].isCreating = false;
                    if (active) {
                        window.__TAURI__.core.invoke('update_child_webview', {
                            label, x, y, width: w, height: h, focus: true
                        }).catch(() => {});
                    }
                } else {
                    window.__TAURI__.core.invoke('destroy_child_webview', { label })
                        .catch(e => console.warn('destroy_child_webview after late deletion failed:', e));
                }
            } catch (e) {
                console.error('Failed to create child webview in queue:', e);
                window.__TAURI__.core.invoke('save_config_file', {
                    filename: 'frontend_error.log',
                    content: `Failed to create child webview in queue: ${e.message || e}\n`
                }).catch(() => {});

                if (this.webviews[tabId]) {
                    delete this.webviews[tabId];
                }
            }

            setTimeout(processNext, 100);
        };

        processNext();
    }

    async destroyWebviewForTab(tabId) {
        this.creationQueue = this.creationQueue.filter(item => item.tabId !== tabId);
        if (this.webviews[tabId]) {
            const label = this.webviews[tabId].label;
            if (window.__TAURI__) {
                await window.__TAURI__.core.invoke('destroy_child_webview', { label }).catch(() => {});
            }
            delete this.webviews[tabId];
        }
    }

    async destroyWebviewForNode(nodeId) {
        const res = this.findNodeAndParent(nodeId);
        if (res && res.node && res.node.tabs) {
            for (const tab of res.node.tabs) {
                if (tab.id) {
                    await this.destroyWebviewForTab(tab.id);
                }
            }
        }
    }
}
window.setModalActive = function(isOpen) {
    if (window.splitEngine) {
        window.splitEngine.isModalOpen = !!isOpen;
        window.splitEngine.syncAllWebviews();
    }
};
window.TheaterSplitEngine = SplitEngine;
