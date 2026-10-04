        // Hide inactive webviews and move active ones
        const forceHide = this.isDragging; // Prevent webviews from stealing mouse events
        
        // Ensure this.webviews exists as tabId -> webviewData mapping
        if (!this.webviews) this.webviews = {};
        
        for (const [tabId, webviewData] of Object.entries(this.webviews)) {
            const activeData = activeWebviews[tabId];
            
            // If the URL changed for this tab, or it is no longer active
            if (activeData && activeData.url === webviewData.url && !forceHide) {
                // It is active
                const bodyEl = document.getElementById(`container-${activeData.nodeId}`);
                if (!bodyEl) continue;
                
                const rect = bodyEl.getBoundingClientRect();
                const physWidth = Math.max(0, rect.width - 4);
                const physHeight = Math.max(0, rect.height - 4);
                
                // Only send IPC if it actually moved or resized, or was previously hidden
                if (webviewData.lastRect && 
                    webviewData.lastRect.x === rect.left && 
                    webviewData.lastRect.y === rect.top && 
                    webviewData.lastRect.width === physWidth && 
                    webviewData.lastRect.height === physHeight) {
                    continue;
                }
                
                webviewData.lastRect = { x: rect.left, y: rect.top, width: physWidth, height: physHeight };
                
                window.__TAURI__.core.invoke('update_child_webview', {
                    label: webviewData.label,
                    x: rect.left,
                    y: rect.top,
                    width: physWidth,
                    height: physHeight
                });
                
            } else {
                // It is inactive or URL changed. Hide it by calling hide_child_webview.
                if (webviewData.lastRect && webviewData.lastRect.x === -10000) continue;
                
                webviewData.lastRect = { x: -10000, y: -10000, width: 0, height: 0 };
                
                window.__TAURI__.core.invoke('hide_child_webview', {
                    label: webviewData.label
                }).catch(e => console.warn(e));
            }
        }
        
        // Create new active webviews if they don't exist
        for (const [tabId, activeData] of Object.entries(activeWebviews)) {
            if (!this.webviews[tabId] || this.webviews[tabId].url !== activeData.url) {
                // Destroy old webview for this tab if URL changed
                if (this.webviews[tabId]) {
                    window.__TAURI__.core.invoke('destroy_child_webview', { label: this.webviews[tabId].label }).catch(e=>console.warn(e));
                }
                
                const bodyEl = document.getElementById(`container-${activeData.nodeId}`);
                if (bodyEl) {
                    const rect = bodyEl.getBoundingClientRect();
                    const physWidth = Math.max(0, rect.width - 4);
                    const physHeight = Math.max(0, rect.height - 4);
                    const newLabel = `webview_${tabId}_${Date.now()}`;
                    
                    window.__TAURI__.core.invoke('create_child_webview', {
                        label: newLabel,
                        url: activeData.url,
                        x: rect.left,
                        y: rect.top,
                        width: physWidth,
                        height: physHeight,
                        muted: this.tree.isMuted || false
                    }).catch(e => {
                        console.error("Failed to create child webview", e);
                    });
                    
                    this.webviews[tabId] = { 
                        label: newLabel,
                        url: activeData.url, 
                        contentId: `webview::${activeData.url}`,
                        lastRect: { x: rect.left, y: rect.top, width: physWidth, height: physHeight }
                    };
                    
                    // Force a physical OS-level size jiggle to wake up WebView2 compositor
                    [150, 400].forEach(delay => {
                        setTimeout(() => {
                            if (this.webviews[tabId] && this.webviews[tabId].lastRect) {
                                const w = this.webviews[tabId];
                                window.__TAURI__.core.invoke('update_child_webview', {
                                    label: w.label,
                                    x: w.lastRect.x,
                                    y: w.lastRect.y,
                                    width: w.lastRect.width - 1,
                                    height: w.lastRect.height
                                }).catch(e=>console.warn(e));
                                w.lastRect = null; // force syncAllWebviews to restore the correct size on the next frame
                            }
                        }, delay);
                    });
                }
            }
        }
    }

    async destroyWebviewForNode(nodeId) {
        // Find any tabs in this node and destroy them
        const res = this.findNodeAndParent(nodeId);
        if (!res || !res.node || !res.node.tabs) return;
        for (let tab of res.node.tabs) {
            if (this.webviews[tab.id]) {
                const label = this.webviews[tab.id].label;
                if (window.__TAURI__) {
                    await window.__TAURI__.core.invoke('destroy_child_webview', { label: label }).catch(e=>console.warn(e));
                }
                delete this.webviews[tab.id];
            }
        }
    }
}
window.TheaterSplitEngine = SplitEngine;
