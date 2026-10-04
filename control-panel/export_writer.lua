obs = obslua

local source_name = "ControlPanelExport"
local output_dir = ""
local watched_source = nil

local function on_source_update(calldata)
    if not watched_source then return end
    
    local settings = obs.obs_source_get_settings(watched_source)
    local text = obs.obs_data_get_string(settings, "text")
    obs.obs_data_release(settings)
    
    -- Check if this text is a valid control panel export
    if text and text:match("^%s*{") and text:match("triggers") then
        -- Parse filename from JSON
        local filename = text:match('"filename"%s*:%s*"([^"]+)"') or "Control.panel.json"
        
        -- Save path
        local save_dir = output_dir
        if save_dir == "" then
            save_dir = script_path()
        end
        
        -- Clean trailing slash/backslash
        if save_dir:sub(-1) ~= "/" and save_dir:sub(-1) ~= "\\" then
            save_dir = save_dir .. "/"
        end
        
        local full_path = save_dir .. filename
        
        -- Write file
        local file = io.open(full_path, "w")
        if file then
            file:write(text)
            file:close()
            obs.blog(obs.LOG_INFO, "[Export Writer] Configuration written successfully to " .. full_path)
            
            -- Clear the source text to prevent displaying it on stream
            -- Disconnect to avoid recursion loop, update settings, then reconnect
            local sh = obs.obs_source_get_signal_handler(watched_source)
            obs.signal_handler_disconnect(sh, "update", on_source_update)
            
            local clean_settings = obs.obs_data_create()
            obs.obs_data_set_string(clean_settings, "text", "")
            obs.obs_source_update(watched_source, clean_settings)
            obs.obs_data_release(clean_settings)
            
            obs.signal_handler_connect(sh, "update", on_source_update)
        else
            obs.blog(obs.LOG_WARNING, "[Export Writer] Failed to write file: " .. full_path)
        end
    end
end

local function disconnect_signal()
    if watched_source then
        local sh = obs.obs_source_get_signal_handler(watched_source)
        obs.signal_handler_disconnect(sh, "update", on_source_update)
        obs.obs_source_release(watched_source)
        watched_source = nil
    end
end

local function connect_signal()
    disconnect_signal()
    local source = obs.obs_get_source_by_name(source_name)
    if source then
        watched_source = source
        local sh = obs.obs_source_get_signal_handler(source)
        obs.signal_handler_connect(sh, "update", on_source_update)
    end
end

-- Periodic timer to ensure we are bound to the source if it is created/recreated
local function check_connection()
    if not watched_source then
        connect_signal()
    else
        -- Check if the watched source was renamed or released
        local current_name = obs.obs_source_get_name(watched_source)
        if current_name ~= source_name then
            connect_signal()
        end
    end
end

function script_description()
    return "Listens to a designated Text source (e.g. 'ControlPanelExport'). When the Control Panel writes JSON export data via OBS WebSocket to the source, this script writes it to a local JSON file and clears the source text automatically."
end

function script_properties()
    local props = obs.obs_properties_create()
    
    obs.obs_properties_add_text(props, "source_name", "Text Source Name", obs.OBS_TEXT_DEFAULT)
    obs.obs_properties_add_path(props, "output_dir", "Output Directory (Optional)", obs.OBS_PATH_DIRECTORY, nil, nil)
    
    return props
end

function script_update(settings)
    source_name = obs.obs_data_get_string(settings, "source_name")
    if source_name == "" then
        source_name = "ControlPanelExport"
    end
    output_dir = obs.obs_data_get_string(settings, "output_dir")
    connect_signal()
end

function script_load(settings)
    obs.timer_add(check_connection, 1000)
end

function script_unload()
    disconnect_signal()
end
