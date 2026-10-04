
    // Global Error Diagnostic Logger
    window.onerror = function(message, source, lineno, colno, error) {
        const errorDetails = `Error: ${message}\nSource: ${source}\nLine: ${lineno}\nColumn: ${colno}\nStack: ${error ? error.stack : 'N/A'}\n`;
        if (window.__TAURI__) {
            window.__TAURI__.core.invoke('save_config_file', {
                filename: 'frontend_error.log',
                content: errorDetails
            }).catch(function() {});
        }
    };
    window.onunhandledrejection = function(event) {
        const errorDetails = `Unhandled Rejection: ${event.reason ? (event.reason.stack || event.reason.split ? event.reason : JSON.stringify(event.reason)) : event}\n`;
        if (window.__TAURI__) {
            window.__TAURI__.core.invoke('save_config_file', {
                filename: 'frontend_error.log',
                content: errorDetails
            }).catch(function() {});
        }
    };

    // Check Safe Mode immediately
    const isSafeMode = window.location.search.includes("safemode=1") || localStorage.getItem("safe_mode") === "true";
    
    // Listen for Shift key during F5 / Reload to trigger Safe Mode
    document.addEventListener("keydown", function(e) {
        if (e.shiftKey && (e.key === "R" || e.key === "r" || e.key === "F5")) {
            localStorage.setItem("safe_mode", "true");
        }
    });

    const STORAGE_KEY = "obs_bridge_config";
    let SAWebSocket = null;
    const obs = new OBSWebSocket();
    window.obs = obs;
    let config = { obs_url: "ws://127.0.0.1:4455", obs_pass: "", triggers: [], loaded_modules: [], modules: {}, modules_code: {} };
    window.config = config;

    let obsScenes = [];
    let obsSources = {};
    let obsTextSources = [];

    // Controller API for dynamic tcp modules
    window.TheaterController = {
        modules: {},
        customCommands: {},
        customTriggers: {},
        contextProviders: {},
        loadingPath: "",
        registeredPresets: [],
        
        registerVariablePreset(id, label, optgroupLabel, samplePayload, moduleName) {
            // Remove existing preset with same ID to avoid duplicates
            this.registeredPresets = this.registeredPresets.filter(p => p.id !== id);
            this.registeredPresets.push({ id, label, optgroupLabel, moduleName });
            if (typeof VAR_HELPER_PRESETS !== 'undefined') {
                VAR_HELPER_PRESETS[id] = samplePayload;
            }
            populateVarHelperSelect();
        },

        unregisterPresetsForModule(moduleName) {
            if (!moduleName) return;
            this.registeredPresets = this.registeredPresets.filter(p => {
                if (p.moduleName === moduleName) {
                    if (typeof VAR_HELPER_PRESETS !== 'undefined') {
                        delete VAR_HELPER_PRESETS[p.id];
                    }
                    return false;
                }
                return true;
            });
            populateVarHelperSelect();
        },
        
        registerContextProvider(providerId, fetcher, uiConfig, moduleName) {
            this.contextProviders[providerId] = { fetcher, uiConfig, moduleName };
            logMsg(`[Modules] Registered custom context provider "${providerId}"`);
            renderTriggers();
        },

        registerModule(moduleName, definition) {
            const path = this.loadingPath;
            
            // Clean up existing module if it exists to prevent leaked intervals or connections
            const existingMod = this.modules[moduleName];
            if (existingMod) {
                this.unregisterPresetsForModule(moduleName);
                if (existingMod.definition && existingMod.definition.onUnload) {
                    try {
                        logMsg(`[Modules] Unloading existing instance of "${moduleName}" before re-registration...`);
                        existingMod.definition.onUnload();
                    } catch (e) {
                        logMsg(`[Module Error] Error unloading existing "${moduleName}": ${e.message || e}`, true);
                    }
                }
            }

            this.modules[moduleName] = {
                definition,
                config: {},
                path: path
            };

            // Register variable presets from definition
            if (definition.variablePresets && Array.isArray(definition.variablePresets)) {
                definition.variablePresets.forEach(preset => {
                    this.registerVariablePreset(preset.id, preset.label, preset.optgroupLabel, preset.samplePayload, moduleName);
                });
            }

            // Fetch saved config for this module if it exists
            if (config.modules && config.modules[moduleName]) {
                this.modules[moduleName].config = config.modules[moduleName];
            } else {
                // Apply defaults
                (definition.configFields || []).forEach(f => {
                    this.modules[moduleName].config[f.id] = f.default;
                });
            }

            // Call module onLoad hook
            if (definition.onLoad) {
                try {
                    definition.onLoad(this.modules[moduleName].config);
                } catch (e) {
                    logMsg(`[Module Error] Error loading module "${moduleName}": ${e.message || e}`, true);
                }
            }

            logMsg(`[Modules] Registered module "${definition.name || moduleName}"`);
            renderModulesUI();
        },

        registerCommand(cmdType, handler, uiConfig, moduleName) {
            this.customCommands[cmdType] = { handler, uiConfig, moduleName };
            logMsg(`[Modules] Registered custom command type "${cmdType}"`);
        },

        registerTrigger(triggerType, matcher, uiConfig, moduleName) {
            this.customTriggers[triggerType] = { matcher, uiConfig, moduleName };
            logMsg(`[Modules] Registered custom trigger type "${triggerType}"`);
            renderTriggers();
        },

        dispatchTrigger(triggerType, eventData, payload) {
            if (payload) {
                window.lastReceivedPayload = payload;
                window.lastReceivedTriggerName = `${triggerType}:${eventData.eventType || ''}`;
                const opt = document.querySelector('#var-helper-event-select option[value="last-live"]');
                if (opt) {
                    opt.innerText = `🔴 Last Received Live Event (${window.lastReceivedTriggerName})`;
                }
            }

            const trigInfo = this.customTriggers[triggerType];
            if (!trigInfo) return;

            config.triggers.forEach((t, index) => {
                if (t.triggerType === triggerType) {
                    try {
                        const matched = trigInfo.matcher(t, eventData);
                        if (matched) {
                            if (t.suspended) {
                                logMsg(`[Trigger] Skipped suspended trigger "${triggerType}:${eventData.eventType || ''}"`);
                                return;
                            }
                            // Check conditions (Subscriber, Whitelist, Blacklist)
                            if (!t.isStartup) {
                                const username = (payload && payload.username) ? payload.username.trim().toLowerCase() : "";
                                // 1. Subscriber filter
                                if (t.subFilter === "sub" || t.subFilter === "nonsub") {
                                    let isSubscriber = false;
                                    if (payload && payload.customData) {
                                        isSubscriber = (payload.customData.subscriber === true || payload.customData.subscriber === "true" || payload.customData.subscriber === 1 || payload.customData.subscriber === "1");
                                    }
                                    if (t.subFilter === "sub" && !isSubscriber) return;
                                    if (t.subFilter === "nonsub" && isSubscriber) return;
                                }
                                // 2. User Whitelist
                                if (t.userWhitelist) {
                                    const whitelist = t.userWhitelist.split(',').map(u => u.trim().toLowerCase()).filter(u => u);
                                    if (whitelist.length > 0 && !whitelist.includes(username)) return;
                                }
                                // 3. User Blacklist
                                if (t.userBlacklist) {
                                    const blacklist = t.userBlacklist.split(',').map(u => u.trim().toLowerCase()).filter(u => u);
                                    if (blacklist.length > 0 && blacklist.includes(username)) return;
                                }
                            }
                            enqueueObsAction(index, t, `${triggerType}:${eventData.eventType || ''}`, [], payload);
                        }
                    } catch (e) {
                        logMsg(`[Trigger Error] Matcher for "${triggerType}" failed: ${e.message}`, true);
                    }
                }
            });
        }
    };

    let isLogPaused = false;
    let pausedLogBuffer = [];

    function logMsg(msg, isError = false) {
        const d = new Date().toLocaleTimeString();
        if (isLogPaused) {
            pausedLogBuffer.push({ msg, isError, time: d });
            updatePauseCheckboxLabel();
            return;
        }
        const win = document.getElementById('log-window');
        if (!win) return;
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = `<span class="log-time">[${d}]</span> <span style="color: ${isError ? '#ff5252' : '#fff'}">${msg}</span>`;
        win.appendChild(div);
        win.scrollTop = win.scrollHeight;
    }

    function togglePauseLog() {
        const checkbox = document.getElementById('pause-log-checkbox');
        if (!checkbox) return;
        isLogPaused = checkbox.checked;
        if (!isLogPaused) {
            // Flush buffer
            const win = document.getElementById('log-window');
            if (win && pausedLogBuffer.length > 0) {
                pausedLogBuffer.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'log-entry';
                    div.innerHTML = `<span class="log-time">[${item.time}]</span> <span style="color: ${item.isError ? '#ff5252' : '#fff'}">${item.msg}</span>`;
                    win.appendChild(div);
                });
                win.scrollTop = win.scrollHeight;
            }
            pausedLogBuffer = [];
        }
        updatePauseCheckboxLabel();
    }

    function updatePauseCheckboxLabel() {
        const labelText = document.getElementById('pause-log-label-text');
        if (!labelText) return;
        if (isLogPaused) {
            labelText.innerText = `⏸️ Pause Logs (${pausedLogBuffer.length} pending)`;
            labelText.style.color = '#ff9800';
        } else {
            labelText.innerText = '⏸️ Pause Logs';
            labelText.style.color = '#aaa';
        }
    }

    function clearLogWindow() {
        const win = document.getElementById('log-window');
        if (win) {
            win.innerHTML = '';
        }
        pausedLogBuffer = [];
        updatePauseCheckboxLabel();
        logMsg("[System] Log cleared.");
    }



    window.onload = async () => {
        // Initialize Split Engine
        window.splitEngine = new SplitEngine(document.getElementById('split-engine-container'));
        
        logMsg("[Startup] Initializing Control Panel Dashboard...");
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                logMsg(`[Startup] Loaded config from localStorage: URL="${parsed.obs_url || ''}", Triggers=${parsed.triggers ? parsed.triggers.length : 0}, Loaded Modules=${parsed.loaded_modules ? parsed.loaded_modules.length : 0}`);
                // Deep merge or copy to preserve module fields
                config = Object.assign({ obs_url: "ws://127.0.0.1:4455", obs_pass: "", triggers: [], loaded_modules: [], modules: {}, modules_code: {}, grid_rows: 3, grid_cols: 4 }, parsed);
                window.config = config;
                
                if (!config.trigger_tabs) {
                    config.trigger_tabs = [{ id: "default", name: "General" }];
                }
                if (!config.active_trigger_tab) {
                    config.active_trigger_tab = "default";
                }
                
                const urlEl = document.getElementById('obs-url');
                const passEl = document.getElementById('obs-pass');
                if (urlEl) urlEl.value = config.obs_url || "ws://127.0.0.1:4455";
                if (passEl) passEl.value = config.obs_pass || "";
                
                const rowsInput = document.getElementById('grid-rows-input');
                const colsInput = document.getElementById('grid-cols-input');
                if (rowsInput) rowsInput.value = config.grid_rows || 3;
                if (colsInput) colsInput.value = config.grid_cols || 4;
            } catch(e) {
                logMsg(`[Startup Error] Failed to parse localStorage config: ${e.message}`, true);
            }
        } else {
            logMsg("[Startup] No saved config found, using defaults.");
            config.grid_rows = 3;
            config.grid_cols = 4;
            config.trigger_tabs = [{ id: "default", name: "General" }];
            config.active_trigger_tab = "default";
        }
        
        if (!config.triggers || config.triggers.length === 0) {
            config.triggers = [
                {
                    trigger: "Startup",
                    isStartup: true,
                    commands: []
                },
                { 
                    trigger: "Twitch * sub", 
                    commands: [
                        { type: "toggle_source", scene: "Main Scene", source: "Sub Alert", delay: 0, duration: 5000 },
                        { type: "update_text", textScene: "", textSource: "", textContent: "Thanks {1} for the sub!", delay: 0, duration: 5000 }
                    ] 
                }
            ];
        } else {
            let hasStartup = false;
            config.triggers.forEach(t => {
                if (t.isStartup || t.trigger === "Startup") {
                    hasStartup = true;
                    t.isStartup = true;
                    t.trigger = "Startup";
                }
                if (!t.commands) {
                    t.commands = [];
                    if (t.scene || t.source) {
                        t.commands.push({ type: "toggle_source", scene: t.scene || "", source: t.source || "", delay: 0, duration: t.duration || 5000 });
                    }
                    if (t.textSource || t.textContent) {
                        t.commands.push({ type: "update_text", textScene: t.textScene || "", textSource: t.textSource || "", textContent: t.textContent || "", delay: 0, duration: t.duration || 5000 });
                    }
                    delete t.scene; delete t.source; delete t.duration; delete t.textScene; delete t.textSource; delete t.textContent;
                } else {
                    t.commands.forEach(cmd => {
                        if (cmd.delay === undefined) cmd.delay = 0;
                    });
                }
            });
            if (!hasStartup) {
                config.triggers.unshift({
                    trigger: "Startup",
                    isStartup: true,
                    commands: []
                });
            }
        }

        // 1. Autoload saved modules first, registering all custom commands immediately
        if (isSafeMode) {
            logMsg("[Safe Mode] Safe Mode is ACTIVE. Skipping dynamic module loading.", true);
            setTimeout(showSafeModeBanner, 500);
            renderModulesUI();
        } else if (config.loaded_modules && config.loaded_modules.length > 0) {
            let skippedAny = false;
            for (const path of config.loaded_modules) {
                const crashFlag = `module_crash_${path}`;
                if (localStorage.getItem(crashFlag) === "loading") {
                    logMsg(`[Safe Mode] Warning: Module "${path}" failed to load on the previous run. Skipping to prevent freeze.`, true);
                    localStorage.setItem("safe_mode", "true");
                    skippedAny = true;
                    continue;
                }

                try {
                    logMsg(`[Modules] Loading fresh "${path}" from disk...`);
                    localStorage.setItem(crashFlag, "loading");
                    window.TheaterController.loadingPath = path;
                    
                    const response = await fetch(path + '?t=' + Date.now(), { cache: "no-store" });
                    if (!response.ok) throw new Error(`HTTP status: ${response.status}`);
                    const code = await response.text();
                    
                    const trimmed = code.trim();
                    const hasHeader = trimmed.startsWith('// @theater-tcp-module') || 
                                      trimmed.startsWith('/* @theater-tcp-module */');
                    if (!hasHeader) throw new Error("Invalid header.");
                    
                    const runModule = new Function(code);
                    runModule();
                    
                    localStorage.setItem(crashFlag, "success");
                    
                    // Update cache
                    if (!config.modules_code) config.modules_code = {};
                    config.modules_code[path] = code;
                    saveConfig();
                } catch (e) {
                    logMsg(`[Modules Warning] Failed to load fresh "${path}" (${e.message}). Trying cache...`);
                    const cachedCode = config.modules_code ? config.modules_code[path] : null;
                    if (cachedCode) {
                        try {
                            const runModule = new Function(cachedCode);
                            runModule();
                            localStorage.setItem(crashFlag, "success");
                            logMsg(`[Modules] Loaded cached "${path}" fallback.`);
                        } catch (cacheErr) {
                            localStorage.setItem(crashFlag, "error");
                            logMsg(`[Loader Error] Cached fallback for "${path}" also failed: ${cacheErr.message}`, true);
                        }
                    } else {
                        localStorage.setItem(crashFlag, "error");
                        logMsg(`[Loader Error] No cache available for "${path}".`, true);
                    }
                }
            }
            if (skippedAny) {
                setTimeout(showSafeModeBanner, 500);
            }
        } else {
            logMsg("[Modules] No loaded modules to restore.");
            renderModulesUI();
        }

        // 2. Render trigger configurations (custom command inputs will render correctly because commands are now registered)
        renderTriggers();
        
        // 3. Set up event listeners for trigger auto-saving (avoids race condition triggers before module loading completes)
        const triggersCont = document.getElementById('triggers-container');
        if (triggersCont) {
            triggersCont.addEventListener('input', () => {
                const hasErrors = validateGridCoordinates();
                saveTriggersToArray();
                if (!hasErrors) {
                    saveConfig();
                }
            });
            triggersCont.addEventListener('change', () => {
                const hasErrors = validateGridCoordinates();
                saveTriggersToArray();
                if (!hasErrors) {
                    saveConfig();
                }
            });
        }
        
        // 4. Connect to background servers
        connectSA();
        if (config.obs_url) connectOBS();

        // 5. Fire Startup trigger automatically after 1.5 seconds
        setTimeout(triggerStartupOnce, 1500);
        
        // 6. Initialize grid button deck
        renderButtonGrid();

        window.addEventListener('resize', renderButtonGrid);
        
        // 7. Restore always on top state
        const savedAlwaysOnTop = localStorage.getItem("always_on_top") === "true";
        if (savedAlwaysOnTop) {
            setTimeout(() => {
                window.toggleAlwaysOnTop(true);
            }, 200);
        } else {
            window.toggleAlwaysOnTop(false);
        }
    };

    async function connectOBS() {
        const urlInput = document.getElementById('obs-url');
        const passInput = document.getElementById('obs-pass');
        const url = urlInput ? urlInput.value : (config.obs_url || "ws://127.0.0.1:4455");
        const pass = passInput ? passInput.value : (config.obs_pass || "");
        const btn = document.getElementById('btn-obs-connect');
        if (btn) btn.innerText = "Connecting...";
        try {
            await obs.connect(url, pass, { rpcVersion: 1 });
            const dot = document.getElementById('obs-dot');
            if (dot) dot.classList.add('connected');
            const hudDot = document.getElementById('hud-obs-dot');
            if (hudDot) hudDot.classList.add('connected');
            if (btn) btn.innerText = "Connected";
            logMsg("Successfully connected to OBS!");
            config.obs_url = url; config.obs_pass = pass; saveConfig();
            await fetchObsData();
        } catch (error) {
            const dot = document.getElementById('obs-dot');
            if (dot) dot.classList.remove('connected');
            const hudDot = document.getElementById('hud-obs-dot');
            if (hudDot) hudDot.classList.remove('connected');
            if (btn) btn.innerText = "Connect OBS";
            logMsg(`OBS Connection failed: ${error.message || error.error || error}`, true);
        }
    }

    obs.on('ConnectionClosed', () => {
        const dot = document.getElementById('obs-dot');
        if (dot) dot.classList.remove('connected');
        const hudDot = document.getElementById('hud-obs-dot');
        if (hudDot) hudDot.classList.remove('connected');
        const btn = document.getElementById('btn-obs-connect');
        if (btn) btn.innerText = "Connect OBS";
        logMsg("OBS Disconnected.", true);
        obsScenes = []; obsSources = {}; obsTextSources = [];
        renderTriggers();
    });

    async function fetchObsData() {
        try {
            const scenesResponse = await obs.call('GetSceneList');
            obsScenes = scenesResponse.scenes.map(s => s.sceneName).reverse();
            obsSources = {};
            for (const s of obsScenes) {
                const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: s });
                obsSources[s] = sceneItems.map(item => item.sourceName).sort();
            }
            const inputsResponse = await obs.call('GetInputList');
            obsTextSources = inputsResponse.inputs.filter(i => i.inputKind.includes('text')).map(i => i.inputName).sort();
            logMsg(`Loaded ${obsScenes.length} scenes.`);
            renderTriggers();
        } catch (e) { logMsg("Error fetching OBS data: " + (e.error || e.message), true); }
    }

    function executeCommand(cmd, triggerString, matches, payload) {
        return new Promise((resolve) => {
            const delayMs = cmd.delay || 0;
            setTimeout(async () => {
                try {
                    if (cmd.type === 'update_text') {
                        if (cmd.textSource) {
                            let finalTxt = replaceTemplateVariables(cmd.textContent || '', matches, payload);
                            await obs.call('SetInputSettings', { inputName: cmd.textSource, inputSettings: { text: finalTxt } });
                            logMsg(`[TEXT] Updated "${cmd.textSource}" → "${finalTxt.substring(0, 60)}${finalTxt.length > 60 ? '…' : ''}"`)
                        }
                        let textSceneItemId = null;
                        if (cmd.textScene && cmd.textSource) {
                            try {
                                const textRes = await obs.call('GetSceneItemId', { sceneName: cmd.textScene, sourceName: cmd.textSource });
                                textSceneItemId = textRes.sceneItemId;
                                await obs.call('SetSceneItemEnabled', { sceneName: cmd.textScene, sceneItemId: textSceneItemId, sceneItemEnabled: true });
                            } catch (e) { logMsg(`Could not enable text source: ` + (e.error || e), true); }
                        }
                        if (cmd.duration && cmd.duration > 0) {
                            setTimeout(async () => {
                                if (cmd.textScene && textSceneItemId !== null) {
                                    try { await obs.call('SetSceneItemEnabled', { sceneName: cmd.textScene, sceneItemId: textSceneItemId, sceneItemEnabled: false }); }
                                    catch(err) { logMsg(`[TEXT] Failed to hide "${cmd.textSource}" after duration: ` + (err.error || err), true); }
                                }
                                resolve();
                            }, cmd.duration);
                        } else { resolve(); }
                    } else if (cmd.type === 'toggle_source') {
                        let mainSceneItemId = null;
                        if (cmd.scene && cmd.source) {
                            try {
                                const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: cmd.scene, sourceName: cmd.source });
                                mainSceneItemId = sceneItemId;
                                await obs.call('SetSceneItemEnabled', { sceneName: cmd.scene, sceneItemId: mainSceneItemId, sceneItemEnabled: true });
                                logMsg(`[ACTIVATE] Enabled "${cmd.source}"`);
                            } catch (e) { logMsg(`Could not enable main source: ` + (e.error || e), true); }
                        }
                        if (cmd.duration && cmd.duration > 0) {
                            setTimeout(async () => {
                                 if (cmd.scene && mainSceneItemId !== null) {
                                     try {
                                         await obs.call('SetSceneItemEnabled', { sceneName: cmd.scene, sceneItemId: mainSceneItemId, sceneItemEnabled: false });
                                         logMsg(`[DEACTIVATE] Disabled "${cmd.source}"`);
                                     } catch(err) { logMsg(`Failed to disable "${cmd.source}": ` + (err.error || err), true); }
                                 }
                                 resolve();
                            }, cmd.duration);
                        } else { resolve(); }
                    } else if (window.TheaterController.customCommands[cmd.type]) {
                        const cmdInfo = window.TheaterController.customCommands[cmd.type];
                        try {
                            await cmdInfo.handler(cmd, matches, payload);
                        } catch (e) {
                            logMsg(`[Command Error] Custom command "${cmd.type}" failed: ${e.message || e}`, true);
                        }
                        resolve();
                    } else { resolve(); }
                } catch (err) { logMsg(`OBS Action Error: ` + (err.error || err), true); resolve(); }
            }, delayMs);
        });
    }

    let hasStartupFired = false;
    function triggerStartupOnce() {
        if (hasStartupFired) return;
        hasStartupFired = true;
        logMsg("[Startup] Firing Startup trigger...");
        checkTriggers("Startup", null);
    }

    function connectSA() {
        SAWebSocket = new WebSocket('ws://localhost:41837');
        SAWebSocket.onopen = () => { 
            const dot = document.getElementById('sa-dot');
            if (dot) dot.classList.add('connected');
            const hudDot = document.getElementById('hud-sa-dot');
            if (hudDot) hudDot.classList.add('connected');
            logMsg("Connected to StreamerAssistant."); 
            // Request the initial config state from backend config.json
            try {
                SAWebSocket.send(JSON.stringify({ type: "request_config_state" }));
            } catch (err) {
                logMsg(`[SA Warning] Failed to request config state: ${err.message}`, true);
            }
        };
        SAWebSocket.onclose = () => { 
            const dot = document.getElementById('sa-dot');
            if (dot) dot.classList.remove('connected');
            const hudDot = document.getElementById('hud-sa-dot');
            if (hudDot) hudDot.classList.remove('connected');
            setTimeout(connectSA, 5000); 
        };
        SAWebSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'status') {
                    logMsg(`[SA] ${data.message}`, !!data.error);
                } else if (data.type === 'moderation') {
                    const payload = data.payload;
                    if (payload && payload.trigger) {
                        logMsg(`[WebSocket Trigger] Received event "${payload.trigger}"`);
                        checkTriggers(payload.trigger, payload);
                    }
                } else if (data.type === 'kick_reward_redeemed') {
                    if (window.TheaterController && window.TheaterController.dispatchTrigger) {
                        window.TheaterController.dispatchTrigger("kick_event", {
                            eventType: "reward_redeemed",
                            username: data.payload.username,
                            message: data.payload.message,
                            customData: data.payload.customData
                        }, data.payload);
                    }
                } else if (data.type === 'config_state' || data.type === 'config_updated') {
                    const payload = data.payload;
                    if (payload && payload.obs_bridge) {
                        const ob = payload.obs_bridge;
                        const obsUrl = ob.obs_url || `ws://${ob.ip || '127.0.0.1'}:${ob.port || '4455'}`;
                        const obsPass = ob.obs_pass || ob.password || "";
                        
                        const urlInput = document.getElementById('obs-url');
                        const passInput = document.getElementById('obs-pass');
                        
                        const currentUrl = urlInput ? urlInput.value : "";
                        const currentPass = passInput ? passInput.value : "";
                        
                        const isConnected = document.getElementById('obs-dot').classList.contains('connected');
                        
                        if (urlInput) urlInput.value = obsUrl;
                        if (passInput) passInput.value = obsPass;
                        
                        if (obsUrl !== currentUrl || obsPass !== currentPass || !isConnected) {
                            logMsg(`[SA] Received OBS settings from config.json: URL="${obsUrl}"`);
                            config.obs_url = obsUrl;
                            config.obs_pass = obsPass;
                            saveConfig();
                            
                            logMsg("[SA] Auto-connecting to OBS with credentials from config.json...");
                            connectOBS();
                        }
                    }
                }
            } catch(e) {}
        };
    }

    function matchWildcard(pattern, target) {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regexStr = "^" + escaped.replace(/\*/g, '(.*)') + "$";
        const regex = new RegExp(regexStr, 'i');
        return target.match(regex);
    }


    function renderButtonGrid() {
        const gridContainer = document.getElementById('button-grid');
        if (!gridContainer) return;
        gridContainer.innerHTML = "";
        
        const rows = config.grid_rows || 3;
        const cols = config.grid_cols || 4;
        
        gridContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
        gridContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        
        // Find all triggers mapped to grid buttons
        const gridTriggers = {};
        if (config.triggers) {
            config.triggers.forEach(t => {
                if (t.triggerType === "grid" && t.trigger) {
                    gridTriggers[t.trigger.toUpperCase()] = t;
                }
            });
        }
        
        const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f43f5e', '#6366f1'];
        
        // Approximate dimensions of a cell to compute adaptive font size
        const approxCellWidth = (window.innerWidth - 30 - (cols - 1) * 15) / cols;
        const approxCellHeight = (window.innerHeight - 30 - (rows - 1) * 15 - 30) / rows;
        const cellMinDim = Math.min(approxCellWidth, approxCellHeight);
        
        for (let r = 0; r < rows; r++) {
            const rowLabel = String.fromCharCode(65 + r); // A, B, C...
            for (let c = 1; c <= cols; c++) {
                const coord = `${rowLabel}${c}`; // A1, A2...
                const btn = document.createElement('button');
                
                btn.style.width = "100%";
                btn.style.height = "100%";
                btn.style.display = "flex";
                btn.style.flexDirection = "column";
                btn.style.alignItems = "center";
                btn.style.justifyContent = "center";
                btn.style.padding = "10px";
                btn.style.borderRadius = "8px";
                btn.style.cursor = "pointer";
                btn.style.transition = "all 0.2s ease";
                btn.style.position = "relative";
                btn.style.overflow = "hidden";
                btn.style.outline = "none";
                btn.style.boxSizing = "border-box";

                
                    const trig = gridTriggers[coord];
                    const trigColor = trig ? (trig.color || (() => {
                        const idx = config.triggers.indexOf(trig);
                        return colors[idx >= 0 ? (idx % colors.length) : 0];
                    })()) : null;
                    
                    btn.style.border = trig ? `2px solid ${trigColor}` : "1px dashed #444";
                    btn.style.background = trig ? `${trigColor}26` : "#1e1e1e";
                    btn.style.color = trig ? trigColor : "#888";
                    
                    // Coordination badge
                    const badge = document.createElement('span');
                    badge.innerText = coord;
                    badge.style.position = "absolute";
                    badge.style.top = "6px";
                    badge.style.left = "6px";
                    badge.style.fontSize = "0.75em";
                    badge.style.color = trig ? `${trigColor}aa` : "#555";
                    badge.style.fontWeight = "bold";
                    btn.appendChild(badge);
                    
                    // Button Label Text
                    const labelText = trig ? (trig.buttonLabel || trig.trigger) : "";
                    const textLength = labelText.length || 1;
                    
                    let scaleFactor = 0.14;
                    if (textLength > 8) scaleFactor = 0.11;
                    if (textLength > 15) scaleFactor = 0.08;
                    if (textLength > 25) scaleFactor = 0.06;
                    
                    const adaptiveFontSize = Math.max(10, Math.min(32, cellMinDim * scaleFactor));
                    
                    const textSpan = document.createElement('span');
                    textSpan.innerText = labelText;
                    textSpan.style.fontSize = `${adaptiveFontSize}px`;
                    textSpan.style.fontWeight = trig ? "600" : "normal";
                    textSpan.style.textAlign = "center";
                    textSpan.style.marginTop = "8px";
                    btn.appendChild(textSpan);
                    
                    btn.onmouseenter = () => {
                        btn.style.transform = "scale(1.03)";
                        btn.style.boxShadow = trig ? `0 0 15px ${trigColor}66` : "0 0 10px rgba(255,255,255,0.05)";
                        if (trig) {
                            btn.style.borderColor = trigColor;
                            btn.style.color = "#fff";
                            btn.style.background = trigColor;
                            badge.style.color = "#fff";
                        } else {
                            btn.style.borderColor = "#666";
                        }
                    };
                    btn.onmouseleave = () => {
                        btn.style.transform = "scale(1)";
                        btn.style.boxShadow = "none";
                        btn.style.borderColor = trig ? trigColor : "#444";
                        btn.style.color = trig ? trigColor : "#888";
                        btn.style.background = trig ? `${trigColor}26` : "#1e1e1e";
                        badge.style.color = trig ? `${trigColor}aa` : "#555";
                    };
                    
                    btn.addEventListener('animationend', () => {
                        btn.classList.remove('btn-flash-active');
                        btn.classList.remove('btn-flash-empty');
                    });
                    btn.onclick = () => {
                        if (trig) {
                            logMsg(`[Grid Click] Executing actions for button ${coord}...`);
                            btn.classList.remove('btn-flash-active');
                            void btn.offsetWidth;
                            btn.classList.add('btn-flash-active');
                            checkTriggers(coord, { username: "GridController", message: "", customData: { subscriber: true } });
                        } else {
                            logMsg(`[Grid Deck] Button ${coord} is empty. Open settings menu to bind actions.`, true);
                            btn.classList.remove('btn-flash-empty');
                            void btn.offsetWidth;
                            btn.classList.add('btn-flash-empty');
                        }
                    };

                
                gridContainer.appendChild(btn);
            }
        }
    }

    function updateGridDimensions() {
        const rowsInput = document.getElementById('grid-rows-input');
        const colsInput = document.getElementById('grid-cols-input');
        if (rowsInput && colsInput) {
            config.grid_rows = Math.max(1, parseInt(rowsInput.value) || 1);
            config.grid_cols = Math.max(1, parseInt(colsInput.value) || 1);
            rowsInput.value = config.grid_rows;
            colsInput.value = config.grid_cols;
            saveConfig();
            renderButtonGrid();
        }
    }

    let modalMode = ""; // "export" or "import"
    let importedTempConfig = null; // Store temp config during import selection

    function openBackupModal(mode, configData) {
        modalMode = mode;
        const modal = document.getElementById('backup-modal');
        const title = document.getElementById('backup-modal-title');
        const desc = document.getElementById('backup-modal-desc');
        const actionBtn = document.getElementById('backup-modal-action-btn');
        const listCont = document.getElementById('backup-modal-list');
        const optionsDiv = document.getElementById('backup-modal-options');
        const filenameDiv = document.getElementById('backup-modal-filename-container');
        
        listCont.innerHTML = "";
        modal.style.display = "flex";
        
        if (mode === "export") {
            title.innerText = "Partial Export Settings";
            desc.innerText = "Select which tabs and triggers you would like to export.";
            actionBtn.innerText = "Export Selected";
            optionsDiv.style.display = "none";
            if (filenameDiv) filenameDiv.style.display = "block";
            actionBtn.onclick = () => confirmExportSelected();
            renderModalList(configData);
        } else if (mode === "import") {
            title.innerText = "Partial Import Settings";
            desc.innerText = "Select which tabs and triggers from the file you would like to import.";
            actionBtn.innerText = "Import Selected";
            optionsDiv.style.display = "block";
            if (filenameDiv) filenameDiv.style.display = "none";
            actionBtn.onclick = () => confirmImportSelected();
            importedTempConfig = configData;
            renderModalList(configData);
        }
    }

    function closeBackupModal() {
        document.getElementById('backup-modal').style.display = "none";
        importedTempConfig = null;
    }

    function selectBackupModalAll(select) {
        document.querySelectorAll('.modal-item-checkbox').forEach(cb => {
            cb.checked = select;
        });
    }

    function renderModalList(configData) {
        const listCont = document.getElementById('backup-modal-list');
        const tabs = configData.trigger_tabs || [{ id: "default", name: "General" }];
        const triggers = configData.triggers || [];
        
        // Find which modules are needed by the triggers in configData
        const neededModuleNames = new Set();
        triggers.forEach(t => {
            if (t.triggerType && window.TheaterController.customTriggers[t.triggerType]) {
                const trigInfo = window.TheaterController.customTriggers[t.triggerType];
                if (trigInfo.moduleName) neededModuleNames.add(trigInfo.moduleName);
            }
            if (t.contextProviderType && window.TheaterController.contextProviders[t.contextProviderType]) {
                const cpInfo = window.TheaterController.contextProviders[t.contextProviderType];
                if (cpInfo.moduleName) neededModuleNames.add(cpInfo.moduleName);
            }
            if (t.commands && Array.isArray(t.commands)) {
                t.commands.forEach(cmd => {
                    if (cmd.type && window.TheaterController.customCommands[cmd.type]) {
                        const cmdInfo = window.TheaterController.customCommands[cmd.type];
                        if (cmdInfo.moduleName) neededModuleNames.add(cmdInfo.moduleName);
                    }
                });
            }
        });

        tabs.forEach((tab, tabIdx) => {
            const tabTriggers = triggers.filter(t => (t.tabId === tab.id || (!t.tabId && tab.id === "default")));
            
            const tabDiv = document.createElement('div');
            tabDiv.style.display = "flex";
            tabDiv.style.alignItems = "center";
            tabDiv.style.gap = "8px";
            tabDiv.style.fontWeight = "bold";
            tabDiv.style.borderBottom = "1px solid #333";
            tabDiv.style.paddingBottom = "5px";
            tabDiv.style.marginTop = tabIdx > 0 ? "10px" : "0";
            
            const tabCheckbox = document.createElement('input');
            tabCheckbox.type = "checkbox";
            tabCheckbox.className = "modal-item-checkbox modal-tab-checkbox";
            tabCheckbox.dataset.tabId = tab.id;
            tabCheckbox.checked = true;
            tabCheckbox.style.cursor = "pointer";
            tabCheckbox.style.width = "auto";
            tabCheckbox.style.margin = "0";
            
            const tabLabel = document.createElement('span');
            tabLabel.innerText = `📂 Tab: ${tab.name || 'General'}`;
            
            tabDiv.appendChild(tabCheckbox);
            tabDiv.appendChild(tabLabel);
            listCont.appendChild(tabDiv);
            
            tabCheckbox.onchange = () => {
                const isChecked = tabCheckbox.checked;
                document.querySelectorAll(`.modal-trigger-checkbox[data-parent-tab-id="${tab.id}"]`).forEach(cb => {
                    cb.checked = isChecked;
                });
            };
            
            tabTriggers.forEach((trig, trigIdx) => {
                const trigDiv = document.createElement('div');
                trigDiv.style.display = "flex";
                trigDiv.style.alignItems = "center";
                trigDiv.style.gap = "8px";
                trigDiv.style.paddingLeft = "20px";
                trigDiv.style.fontSize = "0.95em";
                
                const trigCheckbox = document.createElement('input');
                trigCheckbox.type = "checkbox";
                trigCheckbox.className = "modal-item-checkbox modal-trigger-checkbox";
                trigCheckbox.dataset.parentTabId = tab.id;
                trigCheckbox.dataset.triggerIndex = triggers.indexOf(trig);
                trigCheckbox.checked = true;
                trigCheckbox.style.cursor = "pointer";
                trigCheckbox.style.width = "auto";
                trigCheckbox.style.margin = "0";
                
                trigCheckbox.onchange = () => {
                    if (!trigCheckbox.checked) {
                        tabCheckbox.checked = false;
                    } else {
                        const total = document.querySelectorAll(`.modal-trigger-checkbox[data-parent-tab-id="${tab.id}"]`).length;
                        const checked = document.querySelectorAll(`.modal-trigger-checkbox[data-parent-tab-id="${tab.id}"]:checked`).length;
                        if (total === checked) {
                            tabCheckbox.checked = true;
                        }
                    }
                };
                
                const labelText = trig.trigger || trig.triggerType || "Startup";
                const displayType = trig.triggerType ? `[${trig.triggerType.toUpperCase()}] ` : "";
                
                const trigLabel = document.createElement('span');
                trigLabel.innerHTML = `<span style="color: ${trig.color || '#4fc3f7'}; font-weight: 600;">${displayType}</span>${labelText}`;
                
                trigDiv.appendChild(trigCheckbox);
                trigDiv.appendChild(trigLabel);
                listCont.appendChild(trigDiv);
            });
            
            if (tabTriggers.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.paddingLeft = "20px";
                emptyDiv.style.fontSize = "0.85em";
                emptyDiv.style.color = "#666";
                emptyDiv.style.fontStyle = "italic";
                emptyDiv.innerText = "No triggers in this tab.";
                listCont.appendChild(emptyDiv);
            }
        });

        if (neededModuleNames.size > 0) {
            const modulesDiv = document.createElement('div');
            modulesDiv.style.marginTop = "15px";
            modulesDiv.style.padding = "10px";
            modulesDiv.style.background = "#1a1a1c";
            modulesDiv.style.borderRadius = "4px";
            modulesDiv.style.border = "1px solid #333";
            modulesDiv.style.fontSize = "0.85em";
            modulesDiv.style.color = "#aaa";
            
            const moduleLabels = [];
            neededModuleNames.forEach(moduleName => {
                const mod = window.TheaterController.modules[moduleName];
                moduleLabels.push(mod ? (mod.definition.name || moduleName) : moduleName);
            });
            
            modulesDiv.innerHTML = `⚙️ <strong>Required Modules</strong> (will be bundled/restored automatically):<br><span style="color: #4fc3f7; font-weight: bold;">${moduleLabels.join(', ')}</span>`;
            listCont.appendChild(modulesDiv);
        }
    }

    async function confirmExportSelected() {
        const checkedTriggerCbs = document.querySelectorAll('.modal-trigger-checkbox:checked');
        const checkedTabCbs = document.querySelectorAll('.modal-tab-checkbox:checked');
        
        if (checkedTriggerCbs.length === 0 && checkedTabCbs.length === 0) {
            alert("Please select at least one tab or trigger to export.");
            return;
        }
        
        const exportedTabs = [];
        const exportedTriggers = [];
        const activeTabIds = new Set();
        checkedTabCbs.forEach(cb => activeTabIds.add(cb.dataset.tabId));
        checkedTriggerCbs.forEach(cb => activeTabIds.add(cb.dataset.parentTabId));
        
        config.trigger_tabs.forEach(tab => {
            if (activeTabIds.has(tab.id)) {
                exportedTabs.push(tab);
            }
        });
        
        checkedTriggerCbs.forEach(cb => {
            const idx = parseInt(cb.dataset.triggerIndex);
            if (config.triggers[idx]) {
                exportedTriggers.push(config.triggers[idx]);
            }
        });

        // Find which modules are needed by the exported triggers
        const neededModuleNames = new Set();
        exportedTriggers.forEach(t => {
            if (t.triggerType && window.TheaterController.customTriggers[t.triggerType]) {
                const trigInfo = window.TheaterController.customTriggers[t.triggerType];
                if (trigInfo.moduleName) neededModuleNames.add(trigInfo.moduleName);
            }
            if (t.contextProviderType && window.TheaterController.contextProviders[t.contextProviderType]) {
                const cpInfo = window.TheaterController.contextProviders[t.contextProviderType];
                if (cpInfo.moduleName) neededModuleNames.add(cpInfo.moduleName);
            }
            if (t.commands && Array.isArray(t.commands)) {
                t.commands.forEach(cmd => {
                    if (cmd.type && window.TheaterController.customCommands[cmd.type]) {
                        const cmdInfo = window.TheaterController.customCommands[cmd.type];
                        if (cmdInfo.moduleName) neededModuleNames.add(cmdInfo.moduleName);
                    }
                });
            }
        });

        // Collect modules data
        const exportedLoadedModules = [];
        const exportedModulesConfig = {};
        const exportedModulesCode = {};

        neededModuleNames.forEach(moduleName => {
            const mod = window.TheaterController.modules[moduleName];
            if (mod) {
                if (mod.path) {
                    exportedLoadedModules.push(mod.path);
                    if (config.modules_code && config.modules_code[mod.path]) {
                        exportedModulesCode[mod.path] = config.modules_code[mod.path];
                    }
                }
                exportedModulesConfig[moduleName] = config.modules[moduleName] || mod.config || {};
            }
        });

        const fileInput = document.getElementById('backup-modal-filename');
        let filename = fileInput ? fileInput.value.trim() : "Control.panel";
        if (!filename.toLowerCase().endsWith('.json')) {
            filename += ".json";
        }
        
        const exportData = {
            filename: filename,
            grid_rows: config.grid_rows,
            grid_cols: config.grid_cols,
            trigger_tabs: exportedTabs,
            active_trigger_tab: exportedTabs.length > 0 ? exportedTabs[0].id : "default",
            triggers: exportedTriggers,
            loaded_modules: exportedLoadedModules,
            modules: exportedModulesConfig,
            modules_code: exportedModulesCode
        };

        if (window.__TAURI__) {
            try {
                const savedPath = await window.__TAURI__.core.invoke('save_config_file', {
                    filename: filename,
                    content: JSON.stringify(exportData, null, 4)
                });
                logMsg(`Configuration exported successfully via Tauri to: ${savedPath}`);
                closeBackupModal();
                return;
            } catch (err) {
                logMsg(`Tauri native save failed: ${err}`, true);
            }
        }

        if (SAWebSocket && SAWebSocket.readyState === WebSocket.OPEN) {
            SAWebSocket.send(JSON.stringify({
                type: "native_export_config",
                filename: filename,
                content: JSON.stringify(exportData, null, 4)
            }));
            logMsg("Export request sent to backend...");
            closeBackupModal();
            return;
        }
        
        // Try exporting via OBS WebSocket if connected
        const obsConnected = document.getElementById('obs-dot') && document.getElementById('obs-dot').classList.contains('connected');
        if (obsConnected) {
            try {
                await obs.call('SetInputSettings', {
                    inputName: 'ControlPanelExport',
                    inputSettings: {
                        text: JSON.stringify(exportData, null, 4)
                    }
                });
                logMsg(`Export JSON sent to OBS Text Source "ControlPanelExport" for "${filename}".`);
                closeBackupModal();
                return;
            } catch (err) {
                logMsg(`OBS WebSocket export failed (ensure 'ControlPanelExport' text source exists and script is loaded): ${err.message || err}`, true);
            }
        }
        
        // Fallback for when neither backend nor OBS WebSocket is available/successful (e.g. running standalone HTML)
        const blob = new Blob([JSON.stringify(exportData, null, 4)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        logMsg(`Backend not connected. Exported via browser fallback as "${filename}".`);
        closeBackupModal();
    }

    function exportConfig() {
        saveTriggersToArray();
        openBackupModal("export", config);
    }

    function triggerImportConfig() {
        document.getElementById('import-config-file').click();
    }

    function confirmImportSelected() {
        if (!importedTempConfig) return;
        
        const checkedTriggerCbs = document.querySelectorAll('.modal-trigger-checkbox:checked');
        const checkedTabCbs = document.querySelectorAll('.modal-tab-checkbox:checked');
        const importedHasModules = importedTempConfig.loaded_modules && importedTempConfig.loaded_modules.length > 0;
        
        if (checkedTriggerCbs.length === 0 && checkedTabCbs.length === 0 && !importedHasModules) {
            alert("Please select at least one tab or trigger to import.");
            return;
        }
        
        const importedTabs = [];
        const importedTriggers = [];
        const activeTabIds = new Set();
        checkedTabCbs.forEach(cb => activeTabIds.add(cb.dataset.tabId));
        checkedTriggerCbs.forEach(cb => activeTabIds.add(cb.dataset.parentTabId));
        
        const fileTabs = importedTempConfig.trigger_tabs || [{ id: "default", name: "General" }];
        fileTabs.forEach(tab => {
            if (activeTabIds.has(tab.id)) {
                importedTabs.push(tab);
            }
        });
        
        const fileTriggers = importedTempConfig.triggers || [];
        checkedTriggerCbs.forEach(cb => {
            const idx = parseInt(cb.dataset.triggerIndex);
            if (fileTriggers[idx]) {
                importedTriggers.push(fileTriggers[idx]);
            }
        });
        
        const importMode = document.querySelector('input[name="import-mode-radio"]:checked').value;
        
        if (importMode === "overwrite") {
            const confirmOverwrite = confirm(importedHasModules ? 
                "Are you sure you want to overwrite your active configuration? All current tabs, triggers, and modules will be replaced." :
                "Are you sure you want to overwrite your active configuration? All current tabs and triggers will be replaced."
            );
            if (!confirmOverwrite) return;
            
            config.grid_rows = importedTempConfig.grid_rows || config.grid_rows || 3;
            config.grid_cols = importedTempConfig.grid_cols || config.grid_cols || 4;
            config.trigger_tabs = importedTabs.length > 0 ? importedTabs : [{ id: "default", name: "General" }];
            config.active_trigger_tab = importedTabs.length > 0 ? importedTabs[0].id : "default";
            config.triggers = importedTriggers;
            
            if (importedHasModules) {
                config.loaded_modules = importedTempConfig.loaded_modules;
                config.modules = importedTempConfig.modules || {};
                config.modules_code = importedTempConfig.modules_code || {};
            }
        } else {
            if (!config.trigger_tabs) config.trigger_tabs = [{ id: "default", name: "General" }];
            importedTabs.forEach(newTab => {
                const exists = config.trigger_tabs.some(t => t.id === newTab.id);
                if (!exists) {
                    config.trigger_tabs.push(newTab);
                }
            });
            
            if (!config.triggers) config.triggers = [];
            importedTriggers.forEach(newTrig => {
                if (newTrig.isStartup || newTrig.trigger === "Startup") {
                    const existingStartup = config.triggers.find(t => t.isStartup);
                    if (existingStartup) {
                        existingStartup.commands = existingStartup.commands.concat(newTrig.commands || []);
                    } else {
                        config.triggers.push(newTrig);
                    }
                } else {
                    config.triggers.push(newTrig);
                }
            });

            if (importedHasModules) {
                if (!config.loaded_modules) config.loaded_modules = [];
                if (!config.modules) config.modules = {};
                if (!config.modules_code) config.modules_code = {};

                importedTempConfig.loaded_modules.forEach(path => {
                    if (!config.loaded_modules.includes(path)) {
                        config.loaded_modules.push(path);
                    }
                });

                if (importedTempConfig.modules) {
                    for (const modName in importedTempConfig.modules) {
                        config.modules[modName] = Object.assign(config.modules[modName] || {}, importedTempConfig.modules[modName]);
                    }
                }

                if (importedTempConfig.modules_code) {
                    Object.assign(config.modules_code, importedTempConfig.modules_code);
                }
            }
        }
        
        const rowsInput = document.getElementById('grid-rows-input');
        const colsInput = document.getElementById('grid-cols-input');
        if (rowsInput) rowsInput.value = config.grid_rows;
        if (colsInput) colsInput.value = config.grid_cols;
        
        saveConfig();
        if (importedHasModules) {
            logMsg("[Import] Reloading application to initialize imported modules and settings...");
            location.reload();
        } else {
            renderTriggers();
            renderButtonGrid();
            renderModulesUI();
            logMsg(`Imported ${importedTriggers.length} triggers across ${importedTabs.length} tabs (Mode: ${importMode}).`);
            closeBackupModal();
        }
    }

    function importConfig(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                if (!imported.triggers || !Array.isArray(imported.triggers)) {
                    throw new Error("Invalid configuration file: 'triggers' field is missing or not an array.");
                }
                
                openBackupModal("import", imported);
            } catch (err) {
                logMsg(`[Import Error] Failed to parse config file: ${err.message}`, true);
                alert(`Import failed: ${err.message}`);
            }
            event.target.value = "";
        };
        reader.onerror = () => {
            logMsg("[Import Error] Failed to read configuration file.", true);
        };
        reader.readAsText(file);
    }

    const triggerQueues = {};
    const triggerExecuting = {};

    function checkTriggers(incomingTrigger, payload) {
        if (payload) {
            window.lastReceivedPayload = payload;
            window.lastReceivedTriggerName = incomingTrigger;
            const opt = document.querySelector('#var-helper-event-select option[value="last-live"]');
            if (opt) {
                opt.innerText = `🔴 Last Received Live Event (${incomingTrigger})`;
            }
        }
        config.triggers.forEach((t, index) => {
            if (t.trigger && t.commands && t.commands.length > 0) {
                let matched = false;
                let wildcards = [];
                const triggerType = t.triggerType || "event";
                
                if (triggerType === "grid") {
                    if (incomingTrigger && (t.trigger || "").toUpperCase() === incomingTrigger.toUpperCase()) {
                        matched = true;
                    }
                } else if (triggerType === "command") {
                    if (payload && payload.message) {
                        const msg = payload.message.trim();
                        const cmdName = (t.trigger || "").trim();
                        if (cmdName && msg.toLowerCase().startsWith(cmdName.toLowerCase())) {
                            const remainder = msg.substring(cmdName.length);
                            if (remainder === "" || remainder.startsWith(" ")) {
                                matched = true;
                                wildcards = remainder.trim().split(/\s+/).filter(arg => arg);
                            }
                        }
                    }
                } else {
                    const triggerPatterns = t.trigger.split(',').map(s => s.trim()).filter(s => s);
                    for (let pattern of triggerPatterns) {
                        const matchResult = matchWildcard(pattern, incomingTrigger);
                        if (matchResult) { matched = true; wildcards = matchResult.slice(1); break; }
                    }
                }
                if (matched) {
                    if (t.suspended) {
                        logMsg(`[Trigger] Skipped suspended trigger "${t.trigger || t.triggerType || 'Startup'}"`);
                        return; // Skip this trigger
                    }
                    // Check subscriber & user conditions
                    if (!t.isStartup) {
                        const username = (payload && payload.username) ? payload.username.trim().toLowerCase() : "";
                        
                        // 1. Subscriber filter
                        if (t.subFilter === "sub" || t.subFilter === "nonsub") {
                            let isSubscriber = false;
                            if (payload && payload.customData) {
                                isSubscriber = (payload.customData.subscriber === true || payload.customData.subscriber === "true" || payload.customData.subscriber === 1 || payload.customData.subscriber === "1");
                            }
                            
                            if (t.subFilter === "sub" && !isSubscriber) {
                                logMsg(`[Trigger Filter] Ignored trigger "${t.trigger}" because sender "${payload?.username || 'unknown'}" is not a subscriber.`);
                                return; // Skip this trigger
                            }
                            if (t.subFilter === "nonsub" && isSubscriber) {
                                logMsg(`[Trigger Filter] Ignored trigger "${t.trigger}" because sender "${payload?.username || 'unknown'}" is a subscriber.`);
                                return; // Skip this trigger
                            }
                        }
                        
                        // 2. User Whitelist
                        if (t.userWhitelist) {
                            const whitelist = t.userWhitelist.split(',').map(u => u.trim().toLowerCase()).filter(u => u);
                            if (whitelist.length > 0 && !whitelist.includes(username)) {
                                logMsg(`[Trigger Filter] Ignored trigger "${t.trigger}" because sender "${payload?.username || 'unknown'}" is not whitelisted.`);
                                return; // Skip this trigger
                            }
                        }
                        
                        // 3. User Blacklist
                        if (t.userBlacklist) {
                            const blacklist = t.userBlacklist.split(',').map(u => u.trim().toLowerCase()).filter(u => u);
                            if (blacklist.length > 0 && blacklist.includes(username)) {
                                logMsg(`[Trigger Filter] Ignored trigger "${t.trigger}" because sender "${payload?.username || 'unknown'}" is blacklisted.`);
                                return; // Skip this trigger
                            }
                        }
                    }
                    enqueueObsAction(index, t, incomingTrigger, wildcards, payload);
                }
            }
        });
    }

    function enqueueObsAction(index, triggerConfig, triggerString, matches, payload) {
        if (!triggerQueues[index]) triggerQueues[index] = [];
        triggerQueues[index].push({ 
            commands: triggerConfig.commands, 
            triggerConfig: triggerConfig,
            triggerString, 
            matches, 
            payload: JSON.parse(JSON.stringify(payload || {})) 
        });
        processQueue(index);
    }

    async function processQueue(index) {
        if (triggerExecuting[index]) return;
        if (!triggerQueues[index] || triggerQueues[index].length === 0) return;
        triggerExecuting[index] = true;
        const task = triggerQueues[index].shift();

        // Resolve context providers if configured
        if (task.triggerConfig && task.triggerConfig.contextProviderType) {
            const cpType = task.triggerConfig.contextProviderType;
            const cpInfo = window.TheaterController.contextProviders[cpType];
            if (cpInfo && cpInfo.fetcher) {
                logMsg(`[Context Engine] Fetching context data via "${cpInfo.uiConfig.label}"...`);
                try {
                    const inputs = task.triggerConfig.contextProviderInputs || {};
                    const contextData = await cpInfo.fetcher(inputs, task.payload);
                    if (contextData && typeof contextData === 'object') {
                        Object.assign(task.payload, contextData);
                        logMsg(`[Context Engine] Context data successfully fetched and merged.`);
                    }
                } catch(err) {
                    logMsg(`[Context Engine Error] Failed to resolve context: ${err.message || err}`, true);
                }
            }
        }

        logMsg(`Matched Trigger: "${task.triggerString}". Executing ${task.commands.length} commands...`);
        try {
            const promises = task.commands.map(cmd => executeCommand(cmd, task.triggerString, task.matches, task.payload));
            await Promise.all(promises);
        } catch (err) {
            logMsg(`[Queue Error] Unhandled error in trigger "${task.triggerString}": ${err.message || err}`, true);
        } finally {
            triggerExecuting[index] = false;
            processQueue(index);
        }
    }

    function getSceneSelectHTML(value, className) {
        if (document.getElementById('obs-dot').classList.contains('connected') && obsScenes.length > 0) {
            let sOpt = `<option value="">-- Select Scene --</option>`;
            obsScenes.forEach(s => { sOpt += `<option value="${s}" ${s === value ? 'selected' : ''}>${s}</option>`; });
            if (value && !obsScenes.includes(value)) { sOpt += `<option value="${value}" selected>${value} (Not Found)</option>`; }
            return `<select class="${className}">${sOpt}</select>`;
        } else return `<input type="text" class="${className}" value="${value || ''}" placeholder="Main Scene">`;
    }

    function getSourceSelectHTML(sceneValue, sourceValue, className) {
        if (document.getElementById('obs-dot').classList.contains('connected') && obsScenes.length > 0) {
            let availableSources = [];
            if (sceneValue && obsSources[sceneValue]) availableSources = obsSources[sceneValue];
            else {
                let allArr = new Set();
                Object.values(obsSources).forEach(arr => arr.forEach(src => allArr.add(src)));
                availableSources = Array.from(allArr).sort();
            }
            let mOpt = `<option value="">-- Select Source --</option>`;
            availableSources.forEach(s => { mOpt += `<option value="${s}" ${s === sourceValue ? 'selected' : ''}>${s}</option>`; });
            if (sourceValue && !availableSources.includes(sourceValue)) { mOpt += `<option value="${sourceValue}" selected>${sourceValue} (Not Found)</option>`; }
            return `<select class="${className}">${mOpt}</select>`;
        } else return `<input type="text" class="${className}" value="${sourceValue || ''}" placeholder="Source Name">`;
    }

    function getTextSourceSelectHTML(value, className) {
        if (document.getElementById('obs-dot').classList.contains('connected') && obsTextSources.length > 0) {
            let tOpt = `<option value="">-- Blank / None --</option>`;
            obsTextSources.forEach(s => { tOpt += `<option value="${s}" ${s === value ? 'selected' : ''}>${s}</option>`; });
            if (value && !obsTextSources.includes(value)) { tOpt += `<option value="${value}" selected>${value} (Not Found)</option>`; }
            return `<select class="${className}">${tOpt}</select>`;
        } else return `<input type="text" class="${className}" value="${value || ''}" placeholder="Text Source GDI+">`;
    }

    function updateCommandSourcesDropdown(sceneSelectElement) {
        const selectedScene = sceneSelectElement.value;
        const commandRow = sceneSelectElement.closest('.command-row');
        const sourceSelect = commandRow.querySelector('.cmd-source');
        if (!sourceSelect) return;
        sourceSelect.innerHTML = `<option value="">-- Select Source --</option>`;
        const availableSources = (selectedScene && obsSources[selectedScene]) ? obsSources[selectedScene] : [];
        availableSources.forEach(s => { sourceSelect.innerHTML += `<option value="${s}">${s}</option>`; });
    }

    function getModuleAssetsDir() {
        if (config.modules) {
            for (const modName in config.modules) {
                const modConfig = config.modules[modName];
                if (modConfig && modConfig.assets_dir) {
                    let dir = modConfig.assets_dir.trim();
                    if (dir) {
                        if (!dir.endsWith('/') && !dir.endsWith('\\')) {
                            dir += '/';
                        }
                        return dir;
                    }
                }
            }
        }
        return "";
    }

    function browseFilePath(button) {
        const input = button.parentElement.querySelector('input');
        logMsg(`[Browse] browseFilePath clicked. Input element found: ${input ? 'YES' : 'NO'}`);
        if (!input) return;

        let wsSent = false;
        try {
            if (window.TheaterController && window.TheaterController.requestNativeBrowse) {
                wsSent = window.TheaterController.requestNativeBrowse(input);
            }
        } catch (e) {
            logMsg(`[Browse Warning] Native browse request failed: ${e.message}`);
        }

        if (wsSent) {
            logMsg("[Browse] Requested native absolute file dialog from Bevy...");
            return;
        }

        logMsg("[Browse] Bevy CMD not connected. Falling back to local browser file dialog...");
        const fileSelector = document.createElement('input');
        fileSelector.type = 'file';
        
        fileSelector.style.position = 'absolute';
        fileSelector.style.top = '-9999px';
        fileSelector.style.left = '-9999px';
        
        document.body.appendChild(fileSelector);
        fileSelector.onchange = (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                logMsg(`[Browse] File selected (Fallback): ${file.name}`);
                const currentVal = input.value.trim();
                let directory = getModuleAssetsDir();
                const lastSlash = Math.max(currentVal.lastIndexOf('/'), currentVal.lastIndexOf('\\'));
                if (lastSlash !== -1) {
                    const extractedDir = currentVal.substring(0, lastSlash + 1);
                    if (extractedDir.toLowerCase() !== "assets/" && extractedDir.toLowerCase() !== "assets\\") {
                        directory = extractedDir;
                    }
                }
                input.value = directory + file.name;
                logMsg(`[Browse] Updated input value in DOM to: ${input.value}`);
                saveTriggersToArray();
                saveConfig();
            } else {
                logMsg(`[Browse] File selection cancelled or empty.`);
            }
            document.body.removeChild(fileSelector);
        };
        fileSelector.click();
    }

    function browseModulePath(button) {
        const input = button.parentElement.querySelector('input');
        logMsg(`[Browse] browseModulePath clicked. Input element found: ${input ? 'YES' : 'NO'}`);
        const fileSelector = document.createElement('input');
        fileSelector.type = 'file';
        
        fileSelector.style.position = 'absolute';
        fileSelector.style.top = '-9999px';
        fileSelector.style.left = '-9999px';
        
        document.body.appendChild(fileSelector);
        fileSelector.onchange = (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                logMsg(`[Browse] Module selected: ${file.name}`);
                
                const reader = new FileReader();
                reader.onload = (event) => {
                    const code = event.target.result;
                    const path = `./modules/${file.name}`;
                    if (input) {
                        input.value = path;
                        logMsg(`[Browse] Updated module path input to: ${input.value}`);
                    }
                    logMsg(`[Browse] Reading module content directly...`);
                    loadModuleFromContent(code, path);
                };
                reader.onerror = () => {
                    logMsg(`[Browse Error] Failed to read file: ${file.name}`, true);
                };
                reader.readAsText(file);
            } else {
                logMsg(`[Browse] Module selection cancelled or empty.`);
            }
            document.body.removeChild(fileSelector);
        };
        fileSelector.click();
    }

    function loadModuleFromContent(code, path) {
        const trimmed = code.trim();
        const hasHeader = trimmed.startsWith('// @theater-tcp-module') || 
                          trimmed.startsWith('/* @theater-tcp-module */');

        if (!hasHeader) {
            logMsg("[Loader Error] Missing mandatory header: '// @theater-tcp-module'", true);
            return;
        }

        if (!config.loaded_modules) config.loaded_modules = [];
        if (!config.loaded_modules.includes(path)) {
            config.loaded_modules.push(path);
        }

        // Cache the script content for offline/file:// persistence
        if (!config.modules_code) config.modules_code = {};
        config.modules_code[path] = code;
        saveConfig();

        const crashFlag = `module_crash_${path}`;
        try {
            localStorage.setItem(crashFlag, "loading");
            window.TheaterController.loadingPath = path;
            const runModule = new Function(code);
            runModule();
            localStorage.setItem(crashFlag, "success");
            logMsg(`[Modules] Loaded script: "${path}"`);
        } catch (error) {
            localStorage.setItem(crashFlag, "error");
            logMsg(`[Loader Error] Failed to load "${path}": ${error.message}`, true);
        }
    }

    function showSafeModeBanner() {
        if (document.getElementById("safe-mode-banner")) return;
        const banner = document.createElement("div");
        banner.id = "safe-mode-banner";
        banner.style.cssText = `
            background: #d32f2f;
            color: white;
            padding: 10px 20px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-family: 'Outfit', sans-serif;
            z-index: 999999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
            position: sticky;
            top: 0;
        `;
        banner.innerHTML = `
            <span>⚠️ Safe Mode Active: Custom modules are disabled. Use this mode to unload corrupt modules.</span>
            <div style="display: flex; gap: 10px;">
                <button onclick="clearAllModules()" style="background: white; color: #d32f2f; border: none; padding: 4px 10px; border-radius: 4px; font-weight: bold; cursor: pointer;">Clear All Modules</button>
                <button onclick="exitSafeMode()" style="background: rgba(255,255,255,0.2); color: white; border: 1px solid white; padding: 4px 10px; border-radius: 4px; font-weight: bold; cursor: pointer;">Exit Safe Mode</button>
            </div>
        `;
        document.body.insertBefore(banner, document.body.firstChild);
        
        window.clearAllModules = function() {
            if (confirm("Are you sure you want to clear/unload all custom modules?")) {
                config.loaded_modules = [];
                config.modules_code = {};
                saveConfig();
                localStorage.removeItem("safe_mode");
                location.reload();
            }
        };
        window.exitSafeMode = function() {
            localStorage.removeItem("safe_mode");
            window.location.href = window.location.pathname;
        };
    }

    async function autoloadModule(path) {
        try {
            const crashFlag = `module_crash_${path}`;
            if (localStorage.getItem(crashFlag) === "loading") {
                logMsg(`[Safe Mode] Warning: Module "${path}" failed to load on the previous run. Skipping to prevent freeze.`, true);
                localStorage.setItem("safe_mode", "true");
                return;
            }

            const response = await fetch(path + '?t=' + Date.now(), { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP status: ${response.status}`);
            
            const code = await response.text();
            const trimmed = code.trim();
            const hasHeader = trimmed.startsWith('// @theater-tcp-module') || 
                              trimmed.startsWith('/* @theater-tcp-module */');

            if (hasHeader) {
                localStorage.setItem(crashFlag, "loading");
                window.TheaterController.loadingPath = path;
                const runModule = new Function(code);
                runModule();
                localStorage.setItem(crashFlag, "success");
                
                // Cache the script content
                if (!config.modules_code) config.modules_code = {};
                config.modules_code[path] = code;
                saveConfig();
            } else {
                throw new Error("Invalid theater-tcp-module header.");
            }
        } catch (e) {
            logMsg(`[Loader Warning] Failed to autoload "${path}": ${e.message}`, true);
        }
    }

    function unloadModuleByPath(path) {
        if (config.loaded_modules) {
            config.loaded_modules = config.loaded_modules.filter(p => p !== path);
        }
        if (config.modules_code) {
            delete config.modules_code[path];
        }
        localStorage.removeItem(`module_crash_${path}`);
        saveConfig();

        logMsg(`[Modules] Ejected module: ${path}`);
        renderModulesUI();
        renderTriggers();
    }

    function unloadModule(moduleName, path) {
        const mod = window.TheaterController.modules[moduleName];
        if (mod && mod.definition.onUnload) {
            try { mod.definition.onUnload(); } catch(e) {}
        }

        delete window.TheaterController.modules[moduleName];

        // Clean up presets registered by this module
        if (window.TheaterController.unregisterPresetsForModule) {
            window.TheaterController.unregisterPresetsForModule(moduleName);
        }

        // Clean up commands registered by this module
        for (const cmdType in window.TheaterController.customCommands) {
            if (window.TheaterController.customCommands[cmdType].moduleName === moduleName) {
                delete window.TheaterController.customCommands[cmdType];
            }
        }

        // Clean up triggers registered by this module
        for (const trigType in window.TheaterController.customTriggers) {
            if (window.TheaterController.customTriggers[trigType].moduleName === moduleName) {
                delete window.TheaterController.customTriggers[trigType];
            }
        }

        if (config.loaded_modules) {
            config.loaded_modules = config.loaded_modules.filter(p => p !== path);
        }
        if (config.modules_code) {
            delete config.modules_code[path];
        }
        localStorage.removeItem(`module_crash_${path}`);
        saveConfig();

        logMsg(`[Modules] Unloaded module "${moduleName}"`);
        renderModulesUI();
        renderTriggers();
    }

    function saveModuleConfig(moduleName) {
        const mod = window.TheaterController.modules[moduleName];
        if (!mod) return;

        const inputs = document.querySelectorAll(`.mod-field-${moduleName}`);
        inputs.forEach(input => {
            const fieldId = input.getAttribute('data-field-id');
            const val = input.value;
            mod.config[fieldId] = input.type === 'number' ? (parseFloat(val) || 0) : val;
        });

        if (!config.modules) config.modules = {};
        config.modules[moduleName] = mod.config;
        saveConfig();

        logMsg(`[Modules] Config updated for "${moduleName}"`);

        // Refresh connection / lifecycle
        if (mod.definition.onUnload) {
            try { mod.definition.onUnload(); } catch(e) {}
        }
        if (mod.definition.onLoad) {
            try { mod.definition.onLoad(mod.config); } catch(e) {}
        }

        renderModulesUI();
        renderTriggers();
    }

    function renderModulesUI() {
        const container = document.getElementById('loaded-modules-container');
        container.innerHTML = "";

        const loadedKeys = Object.keys(window.TheaterController.modules);
        
        // Find bypassed/inactive modules that are registered in config but not active in window.TheaterController.modules
        const inactiveModules = (config.loaded_modules || []).filter(path => {
            return !loadedKeys.some(key => window.TheaterController.modules[key].path === path);
        });

        if (loadedKeys.length === 0 && inactiveModules.length === 0) {
            container.innerHTML = `<p style="color: #888; font-style: italic; margin: 0;">No modules currently loaded.</p>`;
            return;
        }

        // Render active modules
        loadedKeys.forEach(key => {
            const mod = window.TheaterController.modules[key];
            const def = mod.definition;

            let fieldsHTML = "";
            if (def.configFields && def.configFields.length > 0) {
                fieldsHTML += `<div style="margin-top: 12px; padding: 12px; background: #1a1a1a; border-radius: 4px; border: 1px solid #333; display: flex; flex-direction: column; gap: 10px;">`;
                fieldsHTML += `<h3 style="margin: 0; font-size: 0.85em; text-transform: uppercase; color: #888; font-weight: bold; letter-spacing: 0.05em;">Module Settings</h3>`;
                
                def.configFields.forEach(f => {
                    const val = mod.config[f.id] !== undefined ? mod.config[f.id] : f.default;
                    fieldsHTML += `
                        <div class="input-group" style="margin: 0;">
                            <label style="font-size: 0.8em; margin-bottom: 3px;">${f.label}</label>
                            <input type="${f.type === 'number' ? 'number' : (f.type === 'password' ? 'password' : 'text')}" class="mod-field-${key}" data-field-id="${f.id}" value="${val}">
                        </div>
                    `;
                });
                
                fieldsHTML += `<div style="text-align: right; margin-top: 5px;"><button class="btn-green" onclick="saveModuleConfig('${key}')" style="font-size: 0.8em; padding: 4px 12px;">Save & Apply Settings</button></div>`;
                fieldsHTML += `</div>`;
            }

            const card = document.createElement('div');
            card.className = 'command-row';
            card.style.borderLeftColor = '#4caf50';
            card.innerHTML = `
                <div class="command-row-header">
                    <div>
                        <strong style="font-size: 1.15em; color: #fff;">${def.name || key}</strong>
                        <div style="font-size: 0.85em; color: #aaa; margin-top: 4px;">${def.description || ""}</div>
                    </div>
                    <button class="btn-red" onclick="unloadModule('${key}', '${mod.path}')" style="padding: 4px 12px; font-size: 0.8em;">Unload</button>
                </div>
                ${fieldsHTML}
            `;
            container.appendChild(card);
        });

        // Render inactive/bypassed modules
        inactiveModules.forEach(path => {
            const card = document.createElement('div');
            card.className = 'command-row';
            card.style.borderLeftColor = '#ff5252';
            card.style.opacity = '0.85';
            
            const fileName = path.split('/').pop();
            
            card.innerHTML = `
                <div class="command-row-header">
                    <div>
                        <strong style="font-size: 1.15em; color: #ff5252;">${fileName} (Disabled)</strong>
                        <div style="font-size: 0.85em; color: #aaa; margin-top: 4px;">Path: ${path} | This module was bypassed to prevent a startup freeze or crash.</div>
                    </div>
                    <button class="btn-red" onclick="unloadModuleByPath('${path}')" style="padding: 4px 12px; font-size: 0.8em;">Eject / Unload</button>
                </div>
            `;
            container.appendChild(card);
        });
    }

    function renderTriggerTabs() {
        const tabsBar = document.getElementById('trigger-tabs-bar');
        if (!tabsBar) return;
        tabsBar.innerHTML = "";
        
        if (!config.trigger_tabs || config.trigger_tabs.length === 0) {
            config.trigger_tabs = [{ id: "default", name: "General" }];
        }
        if (!config.active_trigger_tab) {
            config.active_trigger_tab = config.trigger_tabs[0].id;
        }

        config.trigger_tabs.forEach((tab, index) => {
            const isActive = tab.id === config.active_trigger_tab;
            const tabBtn = document.createElement('div');
            tabBtn.className = 'trigger-tab-item';
            tabBtn.style.display = 'inline-flex';
            tabBtn.style.alignItems = 'center';
            tabBtn.style.gap = '8px';
            tabBtn.style.padding = '6px 12px';
            tabBtn.style.background = isActive ? 'var(--accent)' : 'rgba(255, 255, 255, 0.05)';
            tabBtn.style.color = isActive ? '#fff' : '#aaa';
            tabBtn.style.border = isActive ? '1px solid var(--accent)' : '1px solid #444';
            tabBtn.style.borderRadius = '4px';
            tabBtn.style.cursor = 'pointer';
            tabBtn.style.fontSize = '0.9em';
            tabBtn.style.fontWeight = isActive ? 'bold' : 'normal';
            tabBtn.style.transition = 'all 0.2s ease';

            // Tab Text (Click to switch, double click to rename)
            const textSpan = document.createElement('span');
            textSpan.innerText = tab.name ? tab.name : `Tab ${index + 1}`;
            textSpan.style.cursor = 'pointer';
            textSpan.onclick = (e) => {
                e.stopPropagation();
                switchTriggerTab(tab.id);
            };
            textSpan.ondblclick = (e) => {
                e.stopPropagation();
                renameTriggerTab(tab.id);
            };
            tabBtn.appendChild(textSpan);

            // Rename Icon Button
            const renameBtn = document.createElement('span');
            renameBtn.innerText = "✏️";
            renameBtn.title = "Rename Tab";
            renameBtn.style.opacity = '0.5';
            renameBtn.style.cursor = 'pointer';
            renameBtn.style.fontSize = '0.85em';
            renameBtn.onmouseover = () => renameBtn.style.opacity = '1';
            renameBtn.onmouseout = () => renameBtn.style.opacity = '0.5';
            renameBtn.onclick = (e) => {
                e.stopPropagation();
                renameTriggerTab(tab.id);
            };
            tabBtn.appendChild(renameBtn);

            // Delete Icon Button (if > 1 tab)
            if (config.trigger_tabs.length > 1) {
                const deleteBtn = document.createElement('span');
                deleteBtn.innerText = "✕";
                deleteBtn.title = "Delete Tab (moves triggers to first tab)";
                deleteBtn.style.opacity = '0.5';
                deleteBtn.style.cursor = 'pointer';
                deleteBtn.style.fontWeight = 'bold';
                deleteBtn.style.fontSize = '0.85em';
                deleteBtn.onmouseover = () => deleteBtn.style.opacity = '1';
                deleteBtn.onmouseout = () => deleteBtn.style.opacity = '0.5';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteTriggerTab(tab.id);
                };
                tabBtn.appendChild(deleteBtn);
            }

            tabsBar.appendChild(tabBtn);
        });

        // Add Tab Button
        const addTabBtn = document.createElement('button');
        addTabBtn.innerText = "+ Add Tab";
        addTabBtn.style.padding = '6px 12px';
        addTabBtn.style.background = 'transparent';
        addTabBtn.style.border = '1px dashed #666';
        addTabBtn.style.color = '#888';
        addTabBtn.style.borderRadius = '4px';
        addTabBtn.style.cursor = 'pointer';
        addTabBtn.style.fontSize = '0.9em';
        addTabBtn.onclick = () => addTriggerTab();
        tabsBar.appendChild(addTabBtn);
    }

    function addTriggerTab() {
        saveTriggersToArray();
        const tabId = "tab_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        const name = prompt("Enter tab name (optional):", "");
        if (name === null) return; // Cancelled
        const tabName = name.trim();
        
        config.trigger_tabs.push({
            id: tabId,
            name: tabName
        });
        config.active_trigger_tab = tabId;
        saveConfig();
        renderTriggers();
    }

    function renameTriggerTab(tabId) {
        saveTriggersToArray();
        const tab = config.trigger_tabs.find(t => t.id === tabId);
        if (!tab) return;
        
        const newName = prompt("Rename Tab:", tab.name || "");
        if (newName === null) return; // Cancelled
        
        tab.name = newName.trim();
        saveConfig();
        renderTriggers();
    }

    function deleteTriggerTab(tabId) {
        if (config.trigger_tabs.length <= 1) return;
        
        const confirmDelete = confirm("Are you sure you want to delete this tab?");
        if (!confirmDelete) return;

        saveTriggersToArray();
        
        const firstTabId = config.trigger_tabs[0].id;
        const deleteTriggers = confirm("Would you like to delete all triggers inside this tab? (Click Cancel to move them to the first tab instead)");
        
        if (deleteTriggers) {
            config.triggers = config.triggers.filter(t => !(t.tabId === tabId || (!t.tabId && tabId === "default")));
        } else {
            config.triggers.forEach(t => {
                if (!t.tabId || t.tabId === tabId) {
                    t.tabId = firstTabId;
                }
            });
        }

        config.trigger_tabs = config.trigger_tabs.filter(t => t.id !== tabId);
        if (config.active_trigger_tab === tabId) {
            config.active_trigger_tab = firstTabId;
        }

        saveConfig();
        renderTriggers();
    }

    function switchTriggerTab(tabId) {
        saveTriggersToArray();
        config.active_trigger_tab = tabId;
        saveConfig();
        renderTriggers();
    }

    function renderTriggers() {
        const cont = document.getElementById('triggers-container');
        cont.innerHTML = "";
        if (!config.triggers || config.triggers.length === 0) {
            config.triggers = [{ trigger: "Twitch * sub", commands: [{ type: "toggle_source", scene: "", source: "", delay: 0, duration: 5000 }] }];
        }
        
        renderTriggerTabs();
        const activeTabId = config.active_trigger_tab || "default";
        
        config.triggers.forEach((t, i) => {
            if (!t.tabId) t.tabId = "default";
            const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f43f5e', '#6366f1'];
            const color = t.color || colors[i % colors.length];
            const isCollapsed = !!t.collapsed;

            const card = document.createElement('div');
            card.className = 'trigger-card' + (isCollapsed ? ' collapsed' : '') + (t.suspended ? ' suspended' : '');
            card.style.border = `2px solid ${color}`;
            card.style.boxShadow = `0 4px 15px rgba(0, 0, 0, 0.2), inset 0 0 10px ${color}0d`;
            card.setAttribute('data-trigger-index', i);
            card.setAttribute('data-tab-id', t.tabId);
            if (t.tabId !== activeTabId) {
                card.style.display = 'none';
            }
            let commandsHTML = `<div class="commands-list">`;
            
            t.commands.forEach((cmd, j) => {
                let bodyHTML = "";
                if (cmd.type === 'toggle_source') {
                    bodyHTML = `
                        <div>
                            <label>Scene Name</label>
                            ${getSceneSelectHTML(cmd.scene, 'cmd-scene')}
                        </div>
                        <div>
                            <label>Source Name</label>
                            ${getSourceSelectHTML(cmd.scene, cmd.source, 'cmd-source')}
                        </div>
                        <div>
                            <label>Delay (ms)</label>
                            <input type="number" class="cmd-delay" value="${cmd.delay || 0}" step="100">
                        </div>
                        <div>
                            <label>Duration (ms)</label>
                            <input type="number" class="cmd-duration" value="${cmd.duration || 5000}" step="100">
                        </div>
                    `;
                } else if (cmd.type === 'update_text') {
                    bodyHTML = `
                        <div>
                            <label>Text Scene (Optional)</label>
                            ${getSceneSelectHTML(cmd.textScene, 'cmd-textscene')}
                        </div>
                        <div>
                            <label>Text Source Name</label>
                            ${getTextSourceSelectHTML(cmd.textSource, 'cmd-textsource')}
                        </div>
                        <div>
                            <label>Delay (ms)</label>
                            <input type="number" class="cmd-delay" value="${cmd.delay || 0}" step="100">
                        </div>
                        <div>
                            <label>Duration (ms, 0 for infinite)</label>
                            <input type="number" class="cmd-duration" value="${cmd.duration !== undefined ? cmd.duration : 5000}" step="100">
                        </div>
                        <div style="grid-column: 1 / -1;">
                            <label>Text to Apply</label>
                            <textarea class="cmd-textcontent" placeholder="Welcome {username}!" rows="2" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; resize: vertical;">${cmd.textContent || ''}</textarea>
                        </div>
                    `;
                } else if (window.TheaterController.customCommands[cmd.type]) {
                    const cmdInfo = window.TheaterController.customCommands[cmd.type];
                    bodyHTML = `
                        <div>
                            <label>Delay (ms)</label>
                            <input type="number" class="cmd-delay" value="${cmd.delay || 0}" step="100">
                        </div>
                    `;
                    cmdInfo.uiConfig.fields.forEach(f => {
                        const val = cmd[f.id] !== undefined ? cmd[f.id] : f.default;
                        const divStyle = f.style || '';
                        if (f.type === 'select') {
                            let sOpt = "";
                            f.options.forEach(o => {
                                sOpt += `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`;
                            });
                            bodyHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    <select class="cmd-custom-${f.id}">${sOpt}</select>
                                </div>
                            `;
                        } else if (f.type === 'file') {
                            bodyHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    <div style="display: flex; gap: 5px; align-items: center;">
                                        <input type="text" class="cmd-custom-${f.id}" value="${val}" style="flex-grow: 1;">
                                        <button type="button" onclick="browseFilePath(this)" style="padding: 8px 12px; background: #333; border: 1px solid #444; white-space: nowrap;" title="Browse local model (maps to assets/ folder)">Browse</button>
                                    </div>
                                </div>
                            `;
                        } else if (f.id === 'assetId') {
                            if (window.TheaterAssets && window.TheaterAssets.length > 0) {
                                let sOpt = `<option value="">-- Select Asset ID --</option>`;
                                window.TheaterAssets.forEach(a => {
                                    sOpt += `<option value="${a.id}" ${a.id === val ? 'selected' : ''}>${a.id} (${a.asset_type.toUpperCase()})</option>`;
                                });
                                bodyHTML += `
                                    <div style="${divStyle}">
                                        <label>${f.label}</label>
                                        <select class="cmd-custom-${f.id}">${sOpt}</select>
                                    </div>
                                `;
                            } else {
                                bodyHTML += `
                                    <div style="${divStyle}">
                                        <label>${f.label}</label>
                                        <input type="text" class="cmd-custom-${f.id}" value="${val}" placeholder="e.g. vrm_avatar">
                                    </div>
                                `;
                            }
                        } else if (f.type === 'obs_scene') {
                            bodyHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    ${getSceneSelectHTML(val, `cmd-custom-${f.id} cmd-obs-scene`)}
                                </div>
                            `;
                        } else if (f.type === 'obs_source') {
                            const sceneField = cmdInfo.uiConfig.fields.find(sf => sf.type === 'obs_scene');
                            const sceneVal = sceneField ? (cmd[sceneField.id] || '') : '';
                            bodyHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    ${getSourceSelectHTML(sceneVal, val, `cmd-custom-${f.id} cmd-obs-source`)}
                                </div>
                            `;
                        } else if (f.type === 'obs_filter') {
                            // Find the sibling source field to know which source to query filters for
                            const srcField = cmdInfo.uiConfig.fields.find(sf => sf.type === 'obs_source');
                            const srcVal = srcField ? (cmd[srcField.id] || '') : '';
                            // Render with saved value pre-seeded so it persists before OBS populates
                            const filterPreload = val ? `<option value="${val}" selected>${val}</option>` : `<option value="">-- Select Filter --</option>`;
                            bodyHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    <select class="cmd-custom-${f.id} cmd-obs-filter" data-obs-source="${srcVal}">${filterPreload}</select>
                                </div>
                            `;
                        } else {
                            const inputType = f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text';
                            bodyHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    <input type="${inputType}" class="cmd-custom-${f.id}" value="${val}" autocomplete="off">
                                </div>
                            `;
                        }
                    });
                } else {
                    // Unknown command fallback (e.g. module was unloaded)
                    bodyHTML = `<div style="grid-column: 1 / -1; color: #ff5252; font-style: italic;">Command module not loaded (Type: "${cmd.type}")</div>`;
                }

                // Type select options
                let optionsHTML = `
                    <option value="toggle_source" ${cmd.type === 'toggle_source' ? 'selected' : ''}>Toggle Source (OBS)</option>
                    <option value="update_text" ${cmd.type === 'update_text' ? 'selected' : ''}>Update Text (OBS)</option>
                `;
                for (const [cmdType, cmdInfo] of Object.entries(window.TheaterController.customCommands)) {
                    optionsHTML += `<option value="${cmdType}" ${cmd.type === cmdType ? 'selected' : ''}>${cmdInfo.uiConfig.label}</option>`;
                }

                let pasteBtnHTML = "";
                if (window.copiedCommand) {
                    pasteBtnHTML = `<button class="btn-green" onclick="pasteCommandOver(${i}, ${j}, event)" style="padding: 2px 6px; font-size: 0.85em; background: #10b981; margin-right: 4px;" title="Paste Over Command">📋 Paste</button>`;
                }
                
                commandsHTML += `
                    <div class="command-row" data-command-index="${j}" style="border-left-color: ${color};">
                        <div class="command-row-header">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <label style="margin: 0; font-size: 0.85em; font-weight: bold;">Type:</label>
                                <select class="cmd-type" onchange="changeCommandType(${i}, ${j}, this)" style="width: auto; padding: 4px 8px;">
                                    ${optionsHTML}
                                </select>
                            </div>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <button class="btn-green" onclick="copyCommand(${i}, ${j}, event)" style="padding: 2px 6px; font-size: 0.85em; background: #6366f1;" title="Copy Command">📄 Copy</button>
                                ${pasteBtnHTML}
                                <button class="btn-red" onclick="removeCommandRow(${i}, ${j})" style="padding: 2px 8px; font-size: 0.85em;" title="Remove Command">✕</button>
                            </div>
                        </div>
                        <div class="command-row-body">${bodyHTML}</div>
                    </div>
                `;
            });
            commandsHTML += `</div>`;
            
            let triggerHeaderHTML = "";
            let conditionsHTML = "";
            if (t.isStartup) {
                triggerHeaderHTML = `
                    <div class="trigger-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 10px;">
                        <input type="hidden" class="t-trigger" value="Startup" data-is-startup="true">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span class="collapse-arrow" onclick="toggleCollapse(${i}, this)" style="margin-right: 4px; ${isCollapsed ? 'transform: rotate(-90deg);' : ''}">▼</span>
                            <span class="copy-trigger-btn" onclick="copyTrigger(${i}, event)" style="margin-right: 4px;" title="Copy Trigger Card">📋</span>
                            <input type="color" class="t-color" value="${color}" onchange="changeTriggerColor(${i}, this)" style="width: 28px; height: 28px; border: 1px solid #444; border-radius: 4px; cursor: pointer; padding: 0; background: #1a1a1a; box-sizing: border-box; outline: none; vertical-align: middle;">
                            <div style="font-size: 1.1em; font-weight: bold; color: ${color}; display: inline-block;">
                                ⚡ On Startup / Refresh (Runs Automatically)
                            </div>
                            <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer; margin-left: 15px; font-size: 0.9em; user-select: none;">
                                <input type="checkbox" class="t-suspended" ${t.suspended ? 'checked' : ''} style="cursor: pointer; width: auto; margin: 0;">
                                <span style="color: #ffa726; font-weight: bold;">⏸️ Suspend</span>
                            </label>
                        </div>
                        <button class="btn-green" onclick="testTriggerRow(${i})" style="height: 32px; font-size: 0.85em; padding: 4px 12px; border-radius: 4px;">⚡ Test</button>
                    </div>
                `;
            } else {
                const triggerType = t.triggerType || "event";
                let triggerInputHTML = "";
                let triggerSecondRowInputHTML = "";
                
                if (triggerType === "grid") {
                    triggerInputHTML = `
                        <div style="display: flex; gap: 15px; flex-grow: 1;">
                            <div style="flex-grow: 1;">
                                <label class="t-trigger-label">Grid Coordinate</label>
                                <input type="text" class="t-trigger" value="${t.trigger || ''}" placeholder="e.g. B1" style="height: 38px;" oninput="validateGridCoordinates()">
                                <div class="coord-error-msg" style="color: #ff5252; font-size: 0.8em; margin-top: 4px; display: none;"></div>
                            </div>
                            <div style="flex-grow: 1;">
                                <label>Button Label Text</label>
                                <input type="text" class="t-button-label" value="${t.buttonLabel || ''}" placeholder="e.g. Play Sound" style="height: 38px; width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;">
                            </div>
                        </div>
                    `;
                } else if (triggerType === "event" || triggerType === "command") {
                    triggerInputHTML = `
                        <div style="flex-grow: 1;">
                            <label class="t-trigger-label">${triggerType === 'command' ? 'Command Name' : 'Trigger Pattern(s)'}</label>
                            <input type="text" class="t-trigger" value="${t.trigger || ''}" placeholder="${triggerType === 'command' ? 'e.g. !shock' : 'e.g. Twitch * sub'}" style="height: 38px;">
                        </div>
                    `;
                } else if (window.TheaterController.customTriggers[triggerType]) {
                    const trigInfo = window.TheaterController.customTriggers[triggerType];
                    
                    // Split fields: first field stays on first row, rest wrap on second row
                    const firstField = trigInfo.uiConfig.fields[0];
                    const otherFields = trigInfo.uiConfig.fields.slice(1);
                    
                    let firstFieldHTML = "";
                    if (firstField) {
                        const val = t[firstField.id] !== undefined ? t[firstField.id] : firstField.default;
                        if (firstField.type === 'select') {
                            let sOpt = "";
                            firstField.options.forEach(o => {
                                sOpt += `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`;
                            });
                            firstFieldHTML = `
                                <div style="flex-grow: 1; min-width: 180px;">
                                    <label>${firstField.label}</label>
                                    <select class="t-custom-${firstField.id}" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; height: 38px;">
                                        ${sOpt}
                                    </select>
                                </div>
                            `;
                        } else {
                            firstFieldHTML = `
                                <div style="flex-grow: 1; min-width: 180px;">
                                    <label>${firstField.label}</label>
                                    <input type="${firstField.type === 'number' ? 'number' : 'text'}" class="t-custom-${firstField.id}" value="${val}" style="height: 38px; width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;">
                                </div>
                            `;
                        }
                    }
                    
                    triggerInputHTML = `<input type="hidden" class="t-trigger" value="${triggerType}">${firstFieldHTML}`;
                    
                    let secondRowFieldsHTML = "";
                    otherFields.forEach(f => {
                        const val = t[f.id] !== undefined ? t[f.id] : f.default;
                        const flexBasis = f.flexBasis || "200px";
                        const divStyle = `flex-grow: 1; flex-basis: ${flexBasis};`;
                        if (f.type === 'select') {
                            let sOpt = "";
                            f.options.forEach(o => {
                                sOpt += `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`;
                            });
                            secondRowFieldsHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    <select class="t-custom-${f.id}" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; height: 38px;">
                                        ${sOpt}
                                    </select>
                                </div>
                            `;
                        } else {
                            secondRowFieldsHTML += `
                                <div style="${divStyle}">
                                    <label>${f.label}</label>
                                    <input type="${f.type === 'number' ? 'number' : 'text'}" class="t-custom-${f.id}" value="${val}" style="height: 38px; width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;">
                                </div>
                            `;
                        }
                    });
                    
                    if (secondRowFieldsHTML) {
                        triggerSecondRowInputHTML = `
                            <div style="display: flex; gap: 15px; flex-grow: 1; flex-wrap: wrap; width: 100%; margin-top: 10px; padding-left: 243px; box-sizing: border-box;">
                                ${secondRowFieldsHTML}
                            </div>
                        `;
                    }
                }
                
                let triggerOptionsHTML = `
                    <option value="event" ${triggerType === 'event' ? 'selected' : ''}>Event Pattern</option>
                    <option value="command" ${triggerType === 'command' ? 'selected' : ''}>Chat Command (!)</option>
                    <option value="grid" ${triggerType === 'grid' ? 'selected' : ''}>Grid Button</option>
                `;
                for (const [trigKey, trigInfo] of Object.entries(window.TheaterController.customTriggers)) {
                    triggerOptionsHTML += `<option value="${trigKey}" ${triggerType === trigKey ? 'selected' : ''}>${trigInfo.uiConfig.label}</option>`;
                }
                
                triggerHeaderHTML = `
                    <div class="trigger-header" style="display: flex; flex-direction: column; border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 10px;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-end; width: 100%;">
                            <div style="display: flex; gap: 15px; flex-grow: 1; margin-right: 15px; align-items: flex-end;">
                                <div style="display: flex; align-items: center; height: 38px; margin-right: -5px; gap: 8px;">
                                    <span class="collapse-arrow" onclick="toggleCollapse(${i}, this)" style="${isCollapsed ? 'transform: rotate(-90deg);' : ''}">▼</span>
                                    <span class="copy-trigger-btn" onclick="copyTrigger(${i}, event)" title="Copy Trigger Card">📋</span>
                                </div>
                                <div style="display: flex; flex-direction: column; gap: 5px; width: 45px; align-items: center;">
                                    <label style="font-size: 0.8em; color: #888; text-align: center; width: 100%;">Color</label>
                                    <input type="color" class="t-color" value="${color}" onchange="changeTriggerColor(${i}, this)" style="width: 38px; height: 38px; border: 1px solid #444; border-radius: 6px; cursor: pointer; padding: 0; background: #1a1a1a; box-sizing: border-box; outline: none;">
                                </div>
                                <div style="width: 150px;">
                                    <label>Trigger Type</label>
                                    <select class="t-trigger-type" onchange="changeTriggerType(${i}, this)" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; height: 38px;">
                                        ${triggerOptionsHTML}
                                    </select>
                                </div>
                                ${triggerInputHTML}
                                <div style="display: flex; flex-direction: column; gap: 5px; align-items: center; justify-content: flex-end; height: 38px; margin-bottom: 5px;">
                                    <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; margin: 0;">
                                        <input type="checkbox" class="t-suspended" ${t.suspended ? 'checked' : ''} style="cursor: pointer; width: auto; margin: 0;">
                                        <span style="color: #ffa726; font-weight: bold; font-size: 0.9em; white-space: nowrap;">⏸️ Suspend</span>
                                    </label>
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px; align-self: flex-end;">
                                <button class="btn-green" onclick="testTriggerRow(${i})" style="height: 38px; border-radius: 4px;">⚡ Test</button>
                                <button class="btn-red" onclick="removeTriggerRow(${i})" title="Remove Trigger Card" style="height: 38px; border-radius: 4px;">✕ Delete</button>
                            </div>
                        </div>
                        ${triggerSecondRowInputHTML || ''}
                    </div>
                `;

                conditionsHTML = `
                    <div class="trigger-conditions" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 15px; padding: 10px; background: #222; border-radius: 4px; border: 1px solid #333;">
                        <div>
                            <label style="font-size: 0.8em; color: #aaa;">Subscriber Filter</label>
                            <select class="t-sub-filter" style="width: 100%; padding: 6px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px;">
                                <option value="ignore" ${(!t.subFilter || t.subFilter === 'ignore') ? 'selected' : ''}>Ignore Sub Status</option>
                                <option value="sub" ${t.subFilter === 'sub' ? 'selected' : ''}>Only Subscribers</option>
                                <option value="nonsub" ${t.subFilter === 'nonsub' ? 'selected' : ''}>Only Non-Subscribers</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-size: 0.8em; color: #aaa;">User Whitelist (Optional)</label>
                            <input type="text" class="t-user-whitelist" value="${t.userWhitelist || ''}" placeholder="e.g. user1, user2" style="width: 100%; padding: 6px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;">
                        </div>
                        <div>
                            <label style="font-size: 0.8em; color: #aaa;">User Blacklist (Optional)</label>
                            <input type="text" class="t-user-blacklist" value="${t.userBlacklist || ''}" placeholder="e.g. user3, user4" style="width: 100%; padding: 6px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;">
                        </div>
                    </div>
                `;
            }

            // Render Context / Get Command section
            let contextHTML = "";
            if (!t.isStartup) {
                let cpOptions = `<option value="">-- No Extra Context / Data Fetch --</option>`;
                for (const [cpId, cpInfo] of Object.entries(window.TheaterController.contextProviders)) {
                    cpOptions += `<option value="${cpId}" ${t.contextProviderType === cpId ? 'selected' : ''}>${cpInfo.uiConfig.label}</option>`;
                }

                let fieldsHTML = "";
                const activeCp = window.TheaterController.contextProviders[t.contextProviderType];
                if (activeCp && activeCp.uiConfig && activeCp.uiConfig.fields) {
                    fieldsHTML += `<div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px;">`;
                    activeCp.uiConfig.fields.forEach(f => {
                        const savedVal = (t.contextProviderInputs && t.contextProviderInputs[f.id] !== undefined) ? 
                            t.contextProviderInputs[f.id] : f.default;
                        fieldsHTML += `
                            <div style="flex-grow: 1; min-width: 150px;">
                                <label style="font-size: 0.8em; color: #bbb; display: block; margin-bottom: 2px;">${f.label}</label>
                                <input type="${f.type === 'number' ? 'number' : 'text'}" class="cp-field" data-field-id="${f.id}" value="${savedVal}" style="width: 100%; padding: 6px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; height: 32px;">
                            </div>
                        `;
                    });
                    fieldsHTML += `</div>`;
                }

                contextHTML = `
                    <div class="trigger-context-provider" style="margin-bottom: 15px; padding: 10px; background: #1c1c1e; border-radius: 6px; border: 1px solid #3a3a3c; box-shadow: inset 0 1px 3px rgba(0,0,0,0.4);">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 15px;">
                            <div style="flex-grow: 1;">
                                <label style="font-size: 0.8em; color: #a1a1a6; font-weight: bold; margin-bottom: 4px; display: block;">Context Data Resolver / Get Command</label>
                                <div style="display: flex; gap: 8px;">
                                    <select class="t-context-provider-type" onchange="changeContextProvider(${i}, this)" style="flex-grow: 1; padding: 6px; background: #2c2c2e; border: 1px solid #48484a; color: white; border-radius: 4px; height: 34px; outline: none;">
                                        ${cpOptions}
                                    </select>
                                    <button type="button" class="btn-green" onclick="openContextProviderVarHelper('${i}')" style="height: 34px; padding: 0 12px; font-size: 0.85em; border-radius: 4px; white-space: nowrap; ${t.contextProviderType ? '' : 'display: none;'}" id="cp-var-btn-${i}">🔍 Variables</button>
                                    <button type="button" class="btn-green" onclick="openGetJsonHelper('${i}')" style="height: 34px; padding: 0 12px; font-size: 0.85em; border-radius: 4px; white-space: nowrap; background: #6366f1; ${t.contextProviderType ? '' : 'display: none;'}" id="cp-json-btn-${i}">📋 JSON Helper</button>
                                </div>
                            </div>
                        </div>
                        ${fieldsHTML}
                    </div>
                `;
            }

            let pasteCommandBtnHTML = "";
            if (window.copiedCommand) {
                pasteCommandBtnHTML = `<button onclick="pasteCommand(${i})" style="padding: 4px 10px; font-size: 0.85em; background: #10b981; border: 1px solid #059669; margin-left: 8px;">📋 Paste Command</button>`;
            }

            card.innerHTML = `
                ${triggerHeaderHTML}
                <div class="trigger-body">
                    ${conditionsHTML}
                    ${contextHTML}
                    ${commandsHTML}
                    <div style="margin-top: 5px;">
                        <button onclick="addCommandRow(${i})" style="padding: 4px 10px; font-size: 0.85em; background: #333; border: 1px solid #444;">+ Add Command</button>
                        ${pasteCommandBtnHTML}
                    </div>
                </div>
            `;
            cont.appendChild(card);
        });
        document.querySelectorAll('.cmd-scene').forEach(select => select.addEventListener('change', (e) => updateCommandSourcesDropdown(e.target)));
        // Cascade: custom obs_scene → obs_source repopulate
        document.querySelectorAll('select.cmd-obs-scene').forEach(sceneSelect => {
            sceneSelect.addEventListener('change', () => {
                const row = sceneSelect.closest('.command-row');
                if (!row) return;
                const sourceSelect = row.querySelector('select.cmd-obs-source');
                if (!sourceSelect) return;
                const selectedScene = sceneSelect.value;
                const availableSources = (selectedScene && obsSources[selectedScene]) ? obsSources[selectedScene] :
                    Array.from(new Set(Object.values(obsSources).flat())).sort();
                let opts = `<option value="">-- Select Source --</option>`;
                availableSources.forEach(s => { opts += `<option value="${s}">${s}</option>`; });
                sourceSelect.innerHTML = opts;
            });
        });
        // Helper: populate a filter select from OBS for the given source name
        async function populateFilterSelect(filterSelect, sourceName) {
            if (!sourceName || !window.obs) return;
            const isConnected = document.getElementById('obs-dot') && document.getElementById('obs-dot').classList.contains('connected');
            if (!isConnected) return;
            try {
                const savedVal = filterSelect.value;
                const { filters } = await window.obs.call('GetSourceFilterList', { sourceName });
                let opts = `<option value="">-- Select Filter --</option>`;
                (filters || []).forEach(f => {
                    opts += `<option value="${f.filterName}" ${f.filterName === savedVal ? 'selected' : ''}>${f.filterName}</option>`;
                });
                filterSelect.innerHTML = opts;
                if (savedVal) filterSelect.value = savedVal;
            } catch (e) {
                // OBS not ready or source has no filters — keep existing content
            }
        }
        // Cascade: custom obs_source → obs_filter repopulate
        document.querySelectorAll('select.cmd-obs-source').forEach(sourceSelect => {
            sourceSelect.addEventListener('change', () => {
                const row = sourceSelect.closest('.command-row');
                if (!row) return;
                const filterSelect = row.querySelector('select.cmd-obs-filter');
                if (!filterSelect) return;
                populateFilterSelect(filterSelect, sourceSelect.value);
            });
        });
        // On initial load: populate filter selects that already have a source
        document.querySelectorAll('select.cmd-obs-filter').forEach(filterSelect => {
            const sourceName = filterSelect.dataset.obsSource || '';
            if (sourceName) populateFilterSelect(filterSelect, sourceName);
        });
        
        // Run coordinate validation to highlight any active issues
        validateGridCoordinates();
    }

    function validateGridCoordinates() {
        const cards = document.querySelectorAll('.trigger-card');
        let hasErrors = false;
        const coordinatesSeen = {}; // { coord: [{ card, input, errorDiv }] }
        
        // Clear all previous errors first
        cards.forEach(card => {
            const tInput = card.querySelector('.t-trigger');
            if (!tInput) return;
            const errorDiv = card.querySelector('.coord-error-msg');
            if (errorDiv) {
                errorDiv.style.display = 'none';
                errorDiv.innerText = '';
            }
            tInput.style.borderColor = '#444';
            tInput.style.boxShadow = 'none';
        });

        // First pass: collect coordinate occurrences and check A1
        cards.forEach((card) => {
            const triggerTypeSelect = card.querySelector('.t-trigger-type');
            const triggerType = triggerTypeSelect ? triggerTypeSelect.value : "event";
            
            const tInput = card.querySelector('.t-trigger');
            if (!tInput || triggerType !== "grid") return;

            const coord = tInput.value.trim().toUpperCase();
            if (!coord) return;

            const errorDiv = card.querySelector('.coord-error-msg');

            // 1. Check A1
            
                // 2. Track coordinates for duplicate check
                if (!coordinatesSeen[coord]) {
                    coordinatesSeen[coord] = [];
                }
                coordinatesSeen[coord].push({ card, input: tInput, errorDiv });

        });

        // Second pass: flag duplicates
        Object.entries(coordinatesSeen).forEach(([coord, occs]) => {
            if (occs.length > 1) {
                hasErrors = true;
                occs.forEach(occ => {
                    occ.input.style.borderColor = '#ff5252';
                    occ.input.style.boxShadow = '0 0 5px rgba(255, 82, 82, 0.5)';
                    if (occ.errorDiv) {
                        occ.errorDiv.innerText = '⚠️ Duplicate coordinate detected.';
                        occ.errorDiv.style.display = 'block';
                    }
                });
            }
        });

        return hasErrors;
    }

    function changeTriggerType(triggerIndex, selectElement) {
        saveTriggersToArray();
        config.triggers[triggerIndex].triggerType = selectElement.value;
        renderTriggers();
        saveConfig();
    }

    function changeContextProvider(triggerIndex, selectElement) {
        saveTriggersToArray();
        config.triggers[triggerIndex].contextProviderType = selectElement.value;
        config.triggers[triggerIndex].contextProviderInputs = {};
        
        // Dynamically toggle the Variables button visibility
        const varBtn = document.getElementById(`cp-var-btn-${triggerIndex}`);
        if (varBtn) {
            varBtn.style.display = selectElement.value ? '' : 'none';
        }
        const jsonBtn = document.getElementById(`cp-json-btn-${triggerIndex}`);
        if (jsonBtn) {
            jsonBtn.style.display = selectElement.value ? '' : 'none';
        }
        
        renderTriggers();
        saveConfig();
    }

    function changeTriggerColor(triggerIndex, inputElement) {
        saveTriggersToArray();
        config.triggers[triggerIndex].color = inputElement.value;
        renderTriggers();
        saveConfig();
    }

    function toggleCollapse(triggerIndex, arrowElement) {
        const card = arrowElement.closest('.trigger-card');
        if (!card) return;
        
        const isCollapsed = card.classList.toggle('collapsed');
        arrowElement.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
        
        saveTriggersToArray();
        saveConfig();
    }

    function copyTrigger(triggerIndex, event) {
        if (event) {
            event.stopPropagation();
        }
        saveTriggersToArray();
        
        const trig = config.triggers[triggerIndex];
        if (!trig) return;
        
        window.copiedTrigger = JSON.parse(JSON.stringify(trig));
        
        const pasteBtn = document.getElementById('paste-trigger-btn');
        if (pasteBtn) {
            pasteBtn.style.display = 'inline-block';
        }
        
        logMsg(`[UI] Copied trigger card: "${trig.trigger || trig.triggerType || 'Startup'}"`);
    }

    function pasteTrigger() {
        if (!window.copiedTrigger) return;
        saveTriggersToArray();
        
        const newTrigger = JSON.parse(JSON.stringify(window.copiedTrigger));
        // Reset tab ID to active tab
        newTrigger.tabId = config.active_trigger_tab || "default";
        
        // Prevent duplicate Startup triggers
        if (newTrigger.isStartup) {
            newTrigger.isStartup = false;
            newTrigger.trigger = "Copy of Startup";
            newTrigger.triggerType = "event";
        }
        
        config.triggers.push(newTrigger);
        renderTriggers();
        saveConfig();
        
        logMsg(`[UI] Pasted trigger card: "${newTrigger.trigger || newTrigger.triggerType || 'Startup'}"`);
    }

    function addTriggerRow() { 
        saveTriggersToArray(); 
        const activeTabId = config.active_trigger_tab || "default";
        config.triggers.push({ 
            trigger: "", 
            triggerType: "event", 
            tabId: activeTabId,
            commands: [{ type: "toggle_source", scene: "", source: "", delay: 0, duration: 5000 }] 
        }); 
        renderTriggers(); 
        saveConfig(); 
    }
    function addCommandRow(triggerIndex) { saveTriggersToArray(); config.triggers[triggerIndex].commands.push({ type: "toggle_source", scene: "", source: "", delay: 0, duration: 5000 }); renderTriggers(); saveConfig(); }
    function removeCommandRow(triggerIndex, commandIndex) { saveTriggersToArray(); config.triggers[triggerIndex].commands.splice(commandIndex, 1); renderTriggers(); saveConfig(); }
    
    function copyCommand(triggerIndex, commandIndex, event) {
        if (event) event.stopPropagation();
        saveTriggersToArray();
        const cmd = config.triggers[triggerIndex].commands[commandIndex];
        if (!cmd) return;
        window.copiedCommand = JSON.parse(JSON.stringify(cmd));
        logMsg(`[UI] Copied command: "${cmd.type}"`);
        renderTriggers();
    }

    function pasteCommand(triggerIndex) {
        if (!window.copiedCommand) return;
        saveTriggersToArray();
        config.triggers[triggerIndex].commands.push(JSON.parse(JSON.stringify(window.copiedCommand)));
        renderTriggers();
        saveConfig();
        logMsg(`[UI] Pasted command into trigger.`);
    }

    function pasteCommandOver(triggerIndex, commandIndex, event) {
        if (event) event.stopPropagation();
        if (!window.copiedCommand) return;
        saveTriggersToArray();
        config.triggers[triggerIndex].commands[commandIndex] = JSON.parse(JSON.stringify(window.copiedCommand));
        renderTriggers();
        saveConfig();
        logMsg(`[UI] Pasted command over existing command.`);
    }

    function changeCommandType(triggerIndex, commandIndex, selectElement) {
        saveTriggersToArray();
        const type = selectElement.value;
        let newCmd = { type, delay: 0 };
        if (type === 'toggle_source') {
            newCmd.scene = ""; newCmd.source = ""; newCmd.duration = 5000;
        } else if (type === 'update_text') {
            newCmd.textScene = ""; newCmd.textSource = ""; newCmd.textContent = ""; newCmd.duration = 5000;
        } else if (window.TheaterController.customCommands[type]) {
            const cmdInfo = window.TheaterController.customCommands[type];
            cmdInfo.uiConfig.fields.forEach(f => {
                newCmd[f.id] = f.default;
            });
        }
        config.triggers[triggerIndex].commands[commandIndex] = newCmd;
        renderTriggers();
        saveConfig();
    }
    
    function removeTriggerRow(index) {
        if (config.triggers[index] && config.triggers[index].isStartup) {
            logMsg("[UI Warning] Startup trigger cannot be deleted.", true);
            return;
        }
        saveTriggersToArray();
        config.triggers.splice(index, 1);
        renderTriggers();
        saveConfig();
    }
    
    function testTriggerRow(index) {
        saveTriggersToArray();
        const t = config.triggers[index];
        if (!t) return;
        
        logMsg(`[UI Test] Manually testing trigger row ${index + 1} ("${t.trigger || t.triggerType || 'Startup'}")...`);
        if (t.suspended) {
            logMsg(`[UI Test] Note: Trigger is suspended in configuration, but manual testing will bypass suspension.`);
        }
        
        // Mock payload structure (includes standard twitch fields and deep beat saber fields for verification)
        const mockPayload = {
            username: "TestUser",
            message: "Test Message",
            customData: {
                subscriber: true,
                test: true,
                event: "noteMissed",
                status: {
                    beatmap: {
                        songName: "Test Beatmap",
                        songAuthorName: "Test Artist",
                        difficulty: "ExpertPlus"
                    },
                    performance: {
                        score: 125000,
                        combo: 15,
                        energy: 0.8
                    }
                }
            }
        };
        
        enqueueObsAction(index, t, t.trigger || t.triggerType || "Test", ["TestValue"], mockPayload);
    }
    
    function saveTriggersToArray() {
        try {
            const cards = document.querySelectorAll('.trigger-card');
            const oldTriggers = config.triggers || [];
            config.triggers = [];
            cards.forEach(card => {
                const tInput = card.querySelector('.t-trigger');
                const triggerPattern = tInput ? tInput.value.trim() : "";
                const isStartup = tInput ? (tInput.getAttribute('data-is-startup') === 'true') : false;
                const tabId = card.getAttribute('data-tab-id') || "default";
                const colorInput = card.querySelector('.t-color');
                const color = colorInput ? colorInput.value : "";
                
                // Fetch origIndex from DOM and matching oldTrig
                const origIndexAttr = card.getAttribute('data-trigger-index');
                const origIndex = origIndexAttr !== null ? parseInt(origIndexAttr) : -1;
                const oldTrig = (origIndex >= 0 && origIndex < oldTriggers.length) ? oldTriggers[origIndex] : null;
                
                // Read conditions
                const triggerTypeSelect = card.querySelector('.t-trigger-type');
                const triggerType = triggerTypeSelect ? triggerTypeSelect.value : "event";
                const buttonLabelInput = card.querySelector('.t-button-label');
                const buttonLabel = buttonLabelInput ? buttonLabelInput.value.trim() : "";
                const subFilterSelect = card.querySelector('.t-sub-filter');
                const subFilter = subFilterSelect ? subFilterSelect.value : "ignore";
                const userWhitelistInput = card.querySelector('.t-user-whitelist');
                const userWhitelist = userWhitelistInput ? userWhitelistInput.value.trim() : "";
                const userBlacklistInput = card.querySelector('.t-user-blacklist');
                const userBlacklist = userBlacklistInput ? userBlacklistInput.value.trim() : "";
                
                const commands = [];
                card.querySelectorAll('.command-row').forEach(row => {
                    const typeSelect = row.querySelector('.cmd-type');
                    const type = typeSelect ? typeSelect.value : "";
                    const cmd = { type };
                    
                    const delayInput = row.querySelector('.cmd-delay');
                    cmd.delay = delayInput ? (parseInt(delayInput.value) || 0) : 0;
                    
                    if (type === 'toggle_source') {
                        const sceneInput = row.querySelector('.cmd-scene');
                        const sourceInput = row.querySelector('.cmd-source');
                        const durationInput = row.querySelector('.cmd-duration');
                        cmd.scene = sceneInput ? sceneInput.value.trim() : "";
                        cmd.source = sourceInput ? sourceInput.value.trim() : "";
                        cmd.duration = durationInput ? (parseInt(durationInput.value) || 5000) : 5000;
                    } else if (type === 'update_text') {
                        const textSceneInput = row.querySelector('.cmd-textscene');
                        const textSourceInput = row.querySelector('.cmd-textsource');
                        const textContentInput = row.querySelector('.cmd-textcontent');
                        const durationInput = row.querySelector('.cmd-duration');
                        cmd.textScene = textSceneInput ? textSceneInput.value.trim() : "";
                        cmd.textSource = textSourceInput ? textSourceInput.value.trim() : "";
                        cmd.textContent = textContentInput ? textContentInput.value : "";
                        cmd.duration = durationInput ? (parseInt(durationInput.value) || 0) : 5000;
                    } else if (window.TheaterController.customCommands[type]) {
                        const cmdInfo = window.TheaterController.customCommands[type];
                        if (cmdInfo && cmdInfo.uiConfig && cmdInfo.uiConfig.fields) {
                            cmdInfo.uiConfig.fields.forEach(f => {
                                const input = row.querySelector(`.cmd-custom-${f.id}`);
                                if (input) {
                                    if (f.type === 'number') {
                                        cmd[f.id] = parseFloat(input.value) || 0;
                                    } else if (f.type === 'boolean' || f.type === 'checkbox') {
                                        cmd[f.id] = input.type === 'checkbox' ? input.checked : (input.value === 'true');
                                    } else {
                                        cmd[f.id] = input.value;
                                    }
                                }
                            });
                        }
                    } else {
                        // Command module not loaded, preserve old settings!
                        const cmdIdxAttr = row.getAttribute('data-command-index');
                        const cmdIdx = cmdIdxAttr !== null ? parseInt(cmdIdxAttr) : -1;
                        if (oldTrig && oldTrig.commands && cmdIdx >= 0 && cmdIdx < oldTrig.commands.length) {
                            const oldCmd = oldTrig.commands[cmdIdx];
                            if (oldCmd && oldCmd.type === type) {
                                Object.assign(cmd, oldCmd);
                            }
                        }
                    }
                    commands.push(cmd);
                });
                // Read context provider settings
                const cpTypeSelect = card.querySelector('.t-context-provider-type');
                const cpType = cpTypeSelect ? cpTypeSelect.value : "";
                let cpInputs = {};
                if (cpType && window.TheaterController.contextProviders[cpType]) {
                    const activeCp = window.TheaterController.contextProviders[cpType];
                    if (activeCp.uiConfig && activeCp.uiConfig.fields) {
                        activeCp.uiConfig.fields.forEach(f => {
                            const input = card.querySelector(`.cp-field[data-field-id="${f.id}"]`);
                            if (input) {
                                cpInputs[f.id] = f.type === 'number' ? (parseFloat(input.value) || 0) : input.value;
                            }
                        });
                    }
                } else if (cpType) {
                    // Context provider module not loaded, preserve settings!
                    if (oldTrig && oldTrig.contextProviderType === cpType && oldTrig.contextProviderInputs) {
                        cpInputs = Object.assign({}, oldTrig.contextProviderInputs);
                    }
                }

                const collapsed = card.classList.contains('collapsed');
                const suspendedInput = card.querySelector('.t-suspended');
                const suspended = suspendedInput ? suspendedInput.checked : false;
                if (suspended) {
                    card.classList.add('suspended');
                } else {
                    card.classList.remove('suspended');
                }

                const triggerObj = { 
                    trigger: triggerPattern, 
                    triggerType: triggerType, 
                    buttonLabel: buttonLabel, 
                    isStartup: isStartup, 
                    color: color, 
                    subFilter: subFilter, 
                    userWhitelist: userWhitelist, 
                    userBlacklist: userBlacklist, 
                    contextProviderType: cpType,
                    contextProviderInputs: cpInputs,
                    commands: commands, 
                    tabId: tabId, 
                    collapsed: collapsed,
                    suspended: suspended
                };
                if (window.TheaterController.customTriggers[triggerType]) {
                    const trigInfo = window.TheaterController.customTriggers[triggerType];
                    trigInfo.uiConfig.fields.forEach(f => {
                        const input = card.querySelector(`.t-custom-${f.id}`);
                        if (input) {
                            triggerObj[f.id] = f.type === 'number' ? (parseFloat(input.value) || 0) : input.value;
                        }
                    });
                } else {
                    // Custom trigger module not loaded, preserve custom fields!
                    if (oldTrig && oldTrig.triggerType === triggerType) {
                        const standardKeys = [
                            'trigger', 'triggerType', 'buttonLabel', 'isStartup', 'color', 
                            'subFilter', 'userWhitelist', 'userBlacklist', 'contextProviderType', 
                            'contextProviderInputs', 'commands', 'tabId', 'collapsed', 'suspended'
                        ];
                        Object.keys(oldTrig).forEach(key => {
                            if (!standardKeys.includes(key)) {
                                triggerObj[key] = oldTrig[key];
                            }
                        });
                    }
                }
                config.triggers.push(triggerObj);
            });
        } catch (e) {
            logMsg(`[Error] saveTriggersToArray failed: ${e.message}`, true);
        }
    }

    function saveTriggers() {
        if (validateGridCoordinates()) {
            alert("Please resolve all grid coordinate errors (marked in red) before saving.");
            logMsg("[Error] Cannot save actions due to active grid coordinate errors.", true);
            return;
        }
        saveTriggersToArray();
        saveConfig();
        logMsg("Actions saved securely.");
    }
    function saveConfig() { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); }

    window.addEventListener('theater-assets-updated', (e) => {
        const selects = document.querySelectorAll('select.cmd-custom-assetId');
        selects.forEach(select => {
            const currentVal = select.value;
            let sOpt = `<option value="">-- Select Asset ID --</option>`;
            e.detail.forEach(a => {
                sOpt += `<option value="${a.id}" ${a.id === currentVal ? 'selected' : ''}>${a.id} (${a.asset_type.toUpperCase()})</option>`;
            });
            select.innerHTML = sOpt;
        });

        const textInputs = document.querySelectorAll('input.cmd-custom-assetId');
        if (textInputs.length > 0) {
            saveTriggersToArray();
            renderTriggers();
        }
    });

    // ─── Unified Template Variable Replacement ──────────────────────────────
    function replaceTemplateVariables(text, matches, payload) {
        let result = text || "";
        
        // 1. Matches: {1}, {2}, etc.
        if (matches && Array.isArray(matches)) {
            matches.forEach((val, idx) => {
                result = result.replace(new RegExp(`\\{${idx + 1}\\}`, 'g'), val !== undefined ? val : "");
            });
        }
        
        if (!payload) return result;

        // 2. Resolve nested path replacements: {abc.def} or {abc[0].def} with optional fallback e.g. {abc.def|fallback}
        return result.replace(/\{([a-zA-Z0-9_\.\[\]]+)(?:\s*\|\s*([^}]+))?\}/g, (match, path, fallback) => {
            let val = getNestedValue(payload, path);
            if (val === undefined && payload.customData) {
                // Try resolving directly inside customData as well
                val = getNestedValue(payload.customData, path);
            }
            if (val !== undefined && val !== null && typeof val !== 'object') {
                return val;
            }
            if (fallback !== undefined) {
                return fallback.trim();
            }
            
            // If no fallback is provided but the root key exists in the payload, return empty string
            const rootKey = path.split('.')[0].replace(/\[\d+\]/g, '');
            if (payload[rootKey] !== undefined || (payload.customData && payload.customData[rootKey] !== undefined)) {
                return "";
            }
            return match; // Keep original {variable} if root key not found (typo)
        });
    }

    function getNestedValue(obj, path) {
        if (obj === null || obj === undefined) return undefined;
        const cleanPath = path.replace(/\[(\d+)\]/g, '.$1');
        return cleanPath.split('.').reduce((acc, part) => {
            return (acc && acc[part] !== undefined) ? acc[part] : undefined;
        }, obj);
    }

    // Expose replace variables helper to custom modules
    window.TheaterController.replaceVariables = replaceTemplateVariables;

    // ─── Variable Helper Presets & Logic ────────────────────────────────────
    const VAR_HELPER_PRESETS = {};

    window.lastReceivedPayload = null;
    window.lastReceivedTriggerName = "";

    function createVariableHelperModal() {
        if (document.getElementById('var-helper-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'var-helper-modal';
        modal.style.cssText = `
            display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.8); z-index: 10000; align-items: center; justify-content: center;
            backdrop-filter: blur(5px); box-sizing: border-box; padding: 20px;
        `;
        
        modal.innerHTML = `
            <div style="background: #1e1e1e; border: 2px solid var(--accent, #007acc); border-radius: 12px; width: 900px; max-width: 95%; height: 80vh; padding: 25px; box-shadow: 0 15px 35px rgba(0,0,0,0.6); display: flex; flex-direction: column; gap: 15px; box-sizing: border-box; color: #fff; font-family: 'Outfit', sans-serif;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 15px;">
                    <h2 style="margin:0; font-size: 1.4rem; display: flex; align-items: center; gap: 8px;">📋 Event Variables Helper</h2>
                    <button onclick="closeVariableHelper()" style="background: transparent; border: none; color: #aaa; font-size: 1.5rem; cursor: pointer; line-height: 1; outline: none;">✕</button>
                </div>
                
                <div style="display: flex; gap: 15px; align-items: center;">
                    <label style="font-weight: bold; min-width: 100px;">Choose Event:</label>
                    <select id="var-helper-event-select" onchange="loadVarHelperEvent()" style="flex-grow: 1; padding: 8px 12px; background: #252526; border: 1px solid #444; color: #fff; border-radius: 6px; height: 38px; outline: none; font-family: inherit;">
                    </select>
                </div>
                
                <div style="display: flex; gap: 20px; flex-grow: 1; min-height: 0; box-sizing: border-box;">
                    <!-- Left Side: Parsed Variables -->
                    <div style="flex: 1.3; display: flex; flex-direction: column; gap: 10px; min-height: 0;">
                        <h3 style="margin: 0; font-size: 1.1rem; color: var(--accent, #007acc);">Available Variables</h3>
                        <p style="margin: 0; font-size: 0.82rem; color: #aaa;">Click any variable name to copy it. Paste it into your messages/texts directly (e.g. <code>{username}</code>).</p>
                        <div id="var-helper-list" style="flex-grow: 1; overflow-y: auto; background: #151515; border: 1px solid #333; border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; scrollbar-width: thin;">
                            <!-- Variable Rows Rendered Here -->
                        </div>
                    </div>
                    
                    <!-- Right Side: JSON View -->
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 10px; min-height: 0;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <h3 style="margin: 0; font-size: 1.1rem; color: #888;" id="var-helper-right-title">Payload JSON</h3>
                            <span id="var-json-error" style="color: #ff5252; font-size: 0.8rem; display: none;">Invalid JSON</span>
                        </div>
                        <div style="flex-grow: 1; position: relative; min-height: 0; display: flex; flex-direction: column;">
                            <pre id="var-helper-json" style="flex-grow: 1; overflow: auto; background: #111; border: 1px solid #333; border-radius: 6px; padding: 15px; margin: 0; font-family: monospace; font-size: 0.85em; color: #4fc3f7; box-sizing: border-box; white-space: pre-wrap; word-break: break-all; scrollbar-width: thin;"></pre>
                            <textarea id="var-helper-json-input" placeholder="Paste your API/Get JSON response here..." style="display: none; flex-grow: 1; background: #111; border: 1px solid #333; border-radius: 6px; padding: 15px; margin: 0; font-family: monospace; font-size: 0.85em; color: #4fc3f7; box-sizing: border-box; resize: none; outline: none; scrollbar-width: thin;"></textarea>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        populateVarHelperSelect();
        
        const jsonInput = modal.querySelector('#var-helper-json-input');
        if (jsonInput) {
            jsonInput.addEventListener('input', () => {
                parseCustomJsonInput();
            });
        }
    }

    window.openVariableHelper = function() {
        createVariableHelperModal();
        populateVarHelperSelect();
        const modal = document.getElementById('var-helper-modal');
        modal.style.display = 'flex';
        
        const opt = document.querySelector('#var-helper-event-select option[value="last-live"]');
        if (opt) {
            if (window.lastReceivedPayload) {
                opt.innerText = `🔴 Last Received Live Event (${window.lastReceivedTriggerName || 'Active'})`;
            } else {
                opt.innerText = `🔴 Last Received Live Event (None yet)`;
            }
        }
        
        loadVarHelperEvent();
    }

    window.openContextProviderVarHelper = function(triggerIndex) {
        saveTriggersToArray();
        const t = config.triggers[triggerIndex];
        if (!t || !t.contextProviderType) return;
        
        let presetVal = "";
        if (t.contextProviderType === "twitch_user_info") {
            presetVal = "twitch-get-user-info";
        } else if (t.contextProviderType === "twitch_channel_info") {
            presetVal = "twitch-get-channel-info";
        } else if (t.contextProviderType === "kick_channel_info") {
            presetVal = "kick-get-channel-info";
        }
        
        if (presetVal) {
            openVariableHelper();
            const select = document.getElementById('var-helper-event-select');
            if (select) {
                select.value = presetVal;
                loadVarHelperEvent();
            }
        } else {
            openVariableHelper();
        }
    }

    window.openGetJsonHelper = function(triggerIndex) {
        saveTriggersToArray();
        const t = config.triggers[triggerIndex];
        if (!t || !t.contextProviderType) return;
        
        openVariableHelper();
        
        const select = document.getElementById('var-helper-event-select');
        if (select) {
            select.value = 'custom-json';
            
            // Look up sample payload
            let samplePayload = null;
            if (t.contextProviderType === "twitch_user_info") {
                samplePayload = VAR_HELPER_PRESETS["twitch-get-user-info"];
            } else if (t.contextProviderType === "twitch_channel_info") {
                samplePayload = VAR_HELPER_PRESETS["twitch-get-channel-info"];
            } else if (t.contextProviderType === "kick_channel_info") {
                samplePayload = VAR_HELPER_PRESETS["kick-get-channel-info"];
            } else {
                const activeCp = window.TheaterController.contextProviders[t.contextProviderType];
                if (activeCp && activeCp.uiConfig && activeCp.uiConfig.samplePayload) {
                    samplePayload = activeCp.uiConfig.samplePayload;
                }
            }
            
            if (!samplePayload) {
                samplePayload = {
                    "example_get_response": {
                        "status": "success",
                        "data": {
                            "id": "123",
                            "name": "channel_name"
                        }
                    }
                };
            }
            
            const jsonInput = document.getElementById('var-helper-json-input');
            if (jsonInput) {
                jsonInput.value = JSON.stringify(samplePayload, null, 4);
            }
            
            loadVarHelperEvent();
        }
    }
    
    function populateVarHelperSelect() {
        const select = document.getElementById('var-helper-event-select');
        if (!select) return;
        
        const defaultGroups = {
            "Kick Presets": {
                label: "Kick Presets",
                options: []
            },
            "Twitch Presets": {
                label: "Twitch Presets",
                options: []
            },
            "Get Command Presets": {
                label: "Get Command Presets",
                options: []
            }
        };

        const dynamicPresets = window.TheaterController.registeredPresets || [];
        dynamicPresets.forEach(preset => {
            const grp = preset.optgroupLabel || "Other Presets";
            if (!defaultGroups[grp]) {
                defaultGroups[grp] = {
                    label: grp,
                    options: []
                };
            }
            const exists = defaultGroups[grp].options.some(o => o.value === preset.id);
            if (!exists) {
                defaultGroups[grp].options.push({ value: preset.id, text: preset.label });
            }
        });

        let html = `<option value="last-live">🔴 Last Received Live Event (None yet)</option>`;
        for (const [key, grp] of Object.entries(defaultGroups)) {
            if (grp.options.length === 0) continue;
            html += `<optgroup label="${grp.label}">`;
            grp.options.forEach(opt => {
                html += `<option value="${opt.value}">${opt.text}</option>`;
            });
            html += `</optgroup>`;
        }
        
        html += `
            <optgroup label="Custom Input">
                <option value="custom-json">📋 Custom JSON (Paste raw JSON...)</option>
            </optgroup>
        `;
        
        const currentVal = select.value;
        select.innerHTML = html;
        if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
            select.value = currentVal;
        }
    }

    window.closeVariableHelper = function() {
        const modal = document.getElementById('var-helper-modal');
        if (modal) modal.style.display = 'none';
    }

    window.parseCustomJsonInput = function() {
        const jsonInput = document.getElementById('var-helper-json-input');
        const errorSpan = document.getElementById('var-json-error');
        if (!jsonInput) return;
        
        const text = jsonInput.value.trim();
        if (!text) {
            if (errorSpan) errorSpan.style.display = 'none';
            renderVarHelperList([]);
            return;
        }
        
        try {
            const parsed = JSON.parse(text);
            if (errorSpan) errorSpan.style.display = 'none';
            const vars = getAvailableVariables(parsed);
            renderVarHelperList(vars);
        } catch (e) {
            if (errorSpan) {
                errorSpan.innerText = "Invalid JSON";
                errorSpan.style.display = 'inline';
            }
            renderVarHelperList([]);
        }
    }
    
    window.loadVarHelperEvent = function() {
        const select = document.getElementById('var-helper-event-select');
        const val = select.value;
        
        const jsonView = document.getElementById('var-helper-json');
        const jsonInput = document.getElementById('var-helper-json-input');
        const errorSpan = document.getElementById('var-json-error');
        const rightTitle = document.getElementById('var-helper-right-title');
        
        if (val === 'custom-json') {
            if (jsonView) jsonView.style.display = 'none';
            if (jsonInput) jsonInput.style.display = 'block';
            if (rightTitle) rightTitle.innerText = "Paste Payload JSON";
            parseCustomJsonInput();
            return;
        } else {
            if (jsonView) jsonView.style.display = 'block';
            if (jsonInput) jsonInput.style.display = 'none';
            if (errorSpan) errorSpan.style.display = 'none';
            if (rightTitle) rightTitle.innerText = "Payload JSON";
        }
        
        let payload = null;
        if (val === 'last-live') {
            payload = window.lastReceivedPayload;
        } else {
            payload = VAR_HELPER_PRESETS[val];
        }
        
        if (val === 'last-live' && !payload) {
            jsonView.innerText = "{\n    \"info\": \"No live events received since page load. Trigger an event in chat or choose an event preset from the dropdown.\"\n}";
            renderVarHelperList([]);
            return;
        }

        if (payload) {
            jsonView.innerText = JSON.stringify(payload, null, 4);
            const vars = getAvailableVariables(payload);
            renderVarHelperList(vars);
        } else {
            jsonView.innerText = "// No event payload data available.";
            renderVarHelperList([]);
        }
    }

    window.copyVarToClipboard = function(text, btnElement) {
        navigator.clipboard.writeText(text).then(() => {
            const originalText = btnElement.innerText;
            btnElement.innerText = "Copied!";
            const oldBg = btnElement.style.background;
            const oldColor = btnElement.style.color;
            btnElement.style.background = "#4caf50";
            btnElement.style.color = "#fff";
            setTimeout(() => {
                btnElement.innerText = originalText;
                btnElement.style.background = oldBg;
                btnElement.style.color = oldColor;
            }, 1000);
        });
    }

    function getAvailableVariables(payload) {
        const vars = [];
        if (typeof payload !== 'object' || payload === null) return vars;
        
        function traverse(obj, prefix = "", isCustomData = false) {
            if (obj === null || obj === undefined) return;
            
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const val = obj[key];
                    const fullPath = prefix ? `${prefix}.${key}` : key;
                    
                    if (val !== null && typeof val === 'object') {
                        if (Array.isArray(val)) {
                            val.forEach((item, idx) => {
                                if (item !== null && typeof item === 'object') {
                                    traverse(item, `${fullPath}[${idx}]`, isCustomData || key === 'customData');
                                } else {
                                    vars.push({
                                        path: `${fullPath}[${idx}]`,
                                        val: item,
                                        isCustomData: isCustomData || fullPath.startsWith('customData')
                                    });
                                }
                            });
                        } else {
                            traverse(val, fullPath, isCustomData || key === 'customData');
                        }
                    } else {
                        vars.push({
                            path: fullPath,
                            val: val,
                            isCustomData: isCustomData || fullPath.startsWith('customData')
                        });
                    }
                }
            }
        }
        
        traverse(payload);
        return vars;
    }

    function renderVarHelperList(vars) {
        const listDiv = document.getElementById('var-helper-list');
        if (!listDiv) return;
        listDiv.innerHTML = "";
        
        if (vars.length === 0) {
            listDiv.innerHTML = '<div style="color: #666; font-style: italic; text-align: center; padding: 20px;">No variables available for this selection.</div>';
            return;
        }
        
        vars.forEach(v => {
            const row = document.createElement('div');
            row.style.cssText = `
                display: flex; justify-content: space-between; align-items: center;
                background: #1e1e1e; border: 1px solid #333; padding: 8px 12px;
                border-radius: 6px; gap: 10px;
            `;
            let pathDisplay = `{${v.path}}`;
            let extraHTML = "";
            
            if (v.isCustomData && v.path.startsWith('customData.')) {
                const shortPath = v.path.substring(11);
                extraHTML = `
                    <div style="display: flex; align-items: center; gap: 5px; margin-top: 4px;">
                        <span style="color: #888; font-size: 0.75rem;">Short form:</span>
                        <code style="background: #252526; color: #4fc3f7; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; font-family: monospace; font-weight: bold; cursor: pointer;" onclick="copyVarToClipboard('{${shortPath}}', this)">{${shortPath}}</code>
                    </div>
                `;
            }
            
            row.innerHTML = `
                <div style="flex-grow: 1; display: flex; flex-direction: column;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <code style="background: #2b2b2b; color: var(--accent, #007acc); padding: 4px 8px; border-radius: 4px; font-size: 0.9em; font-family: monospace; font-weight: bold; cursor: pointer;" onclick="copyVarToClipboard('${pathDisplay}', this)" title="Click to copy full path">${pathDisplay}</code>
                        <span style="color: #888; font-size: 0.8em; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px;" title="${String(v.val)}">value: "${v.val}"</span>
                    </div>
                    ${extraHTML}
                </div>
                <button onclick="copyVarToClipboard('${pathDisplay}', this)" style="padding: 4px 10px; font-size: 0.8em; background: #2d2d2d; border: 1px solid #444; border-radius: 4px; color: #ccc; cursor: pointer; font-weight: bold;">Copy</button>
            `;
            listDiv.appendChild(row);
        });
    }
    window.showRawJsonConfig = function() {
        saveTriggersToArray();
        const textarea = document.getElementById('raw-json-textarea');
        if (textarea) {
            textarea.value = JSON.stringify(config, null, 4);
        }
        const modal = document.getElementById('raw-json-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
    };

    window.closeRawJsonConfigModal = function() {
        const modal = document.getElementById('raw-json-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    };

    window.copyRawJsonToClipboard = function() {
        const textarea = document.getElementById('raw-json-textarea');
        if (textarea) {
            navigator.clipboard.writeText(textarea.value).then(() => {
                alert("Configuration copied to clipboard!");
            }).catch(err => {
                alert("Failed to copy configuration: " + err);
            });
        }
    };

    window.importRawJson = function() {
        const textarea = document.getElementById('raw-json-textarea');
        if (!textarea) return;
        
        const content = textarea.value.trim();
        if (!content) {
            alert("Please paste configuration JSON in the box first.");
            return;
        }

        try {
            const imported = JSON.parse(content);
            if (!imported.triggers || !Array.isArray(imported.triggers)) {
                throw new Error("Invalid configuration structure: 'triggers' field is missing or not an array.");
            }
            
            window.closeRawJsonConfigModal();
            openBackupModal("import", imported);
        } catch (e) {
            alert("Failed to parse JSON: " + e.message);
        }
    };

    window.simulateEventSubPayload = function() {
        const text = document.getElementById('eventsub-sim-json').value.trim();
        if (!text) {
            alert("Please paste a JSON payload first.");
            return;
        }
        try {
            const parsed = JSON.parse(text);
            if (window.twitchEventSubSimulate) {
                window.twitchEventSubSimulate(parsed);
                logMsg("[Simulator] Simulated EventSub payload passed to twitch_api.");
            } else {
                logMsg("[Simulator Error] twitch_api module is not loaded or does not support simulation.", true);
            }
        } catch (e) {
            alert("Invalid JSON: " + e.message);
        }
    };

    let isPinned = false;
    window.toggleAlwaysOnTop = async function(forceState = null) {
        if (forceState !== null) {
            isPinned = forceState;
        } else {
            isPinned = !isPinned;
        }
        
        localStorage.setItem("always_on_top", isPinned ? "true" : "false");
        
        const pinBtn = document.getElementById('pin-btn');
        if (pinBtn) {
            const pinText = pinBtn.querySelector('.pin-text');
            if (isPinned) {
                pinBtn.classList.add('pinned');
                if (pinText) pinText.innerText = "Pinned";
            } else {
                pinBtn.classList.remove('pinned');
                if (pinText) pinText.innerText = "Pin Window";
            }
        }
        
        if (window.__TAURI__) {
            try {
                const w = window.__TAURI__.window;
                const currentWindow = (w.getCurrentWindow ? w.getCurrentWindow() : (w.getCurrent ? w.getCurrent() : null));
                if (currentWindow && currentWindow.setAlwaysOnTop) {
                    await currentWindow.setAlwaysOnTop(isPinned);
                    logMsg(`[Window] Set always on top to: ${isPinned}`);
                } else {
                    logMsg(`[Window Warning] Tauri window API not fully available.`, true);
                }
            } catch (err) {
                logMsg(`[Window Error] Failed to set always on top: ${err.message || err}`, true);
            }
        } else {
            logMsg(`[Window Warning] Not running in Tauri. Mocking always on top: ${isPinned}`);
        }
    };

    // ────────────────────────────────────────────────────────────────────────
    
    // Initialize Split Engine layout
    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            if (window.TheaterSplitEngine) {
                window.splitEngine = new TheaterSplitEngine(document.body);
            }
        }, 500);
    });
</script>
<script src="js/split_engine.js">
