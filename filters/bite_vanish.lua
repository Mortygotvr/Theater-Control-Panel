-- bite_vanish.lua
-- OBS Lua Filter & Theater Scene Impact Reaction: Bite Vanish (Contact Chomp)
--
-- At each contact (wall collision bounce, throwable impact, hotkey, or trigger),
-- bite marks are chomped out of the source and vanish (turn transparent),
-- progressively eating away the image until it completely disappears or resets.
--
-- Features:
-- 1. OBS Studio Video Filter (via Tools -> Scripts -> bite_vanish.lua)
-- 2. Theater Scene Impact Reaction (discovered automatically in filters/ folder)
-- 3. DVD-style Auto-Bounce collision (bites vanish on contact with screen borders)
-- 4. Realistic tooth scalloping & bite edge darkening for tactile depth
-- 5. Auto-Reset / Respawn and Hotkey / Trigger support

obs = obslua

local shader_code = [[
uniform float4x4 ViewProj;
uniform texture2d image;

uniform float time;
uniform float scale_factor;
uniform float bite_count;
uniform float max_bites;
uniform float bite_size;
uniform float teeth_count;
uniform float teeth_depth;
uniform float chomp_progress;
uniform float chomp_wobble;
uniform float edge_crumb_width;
uniform float bounce_offset_x;
uniform float bounce_offset_y;
uniform float use_explicit_bites;

uniform float bite_0_x; uniform float bite_0_y;
uniform float bite_1_x; uniform float bite_1_y;
uniform float bite_2_x; uniform float bite_2_y;
uniform float bite_3_x; uniform float bite_3_y;
uniform float bite_4_x; uniform float bite_4_y;
uniform float bite_5_x; uniform float bite_5_y;
uniform float bite_6_x; uniform float bite_6_y;
uniform float bite_7_x; uniform float bite_7_y;
uniform float bite_8_x; uniform float bite_8_y;
uniform float bite_9_x; uniform float bite_9_y;

sampler_state textureSampler {
    Filter    = Linear;
    AddressU  = Border;
    AddressV  = Border;
    BorderColor = 00000000;
};

struct VertData {
    float4 pos : POSITION;
    float2 uv  : TEXCOORD0;
};

struct VertOut {
    float4 pos : POSITION;
    float2 uv  : TEXCOORD0;
};

VertOut VSDefault(VertData v_in) {
    VertOut vert_out;
    vert_out.pos = mul(float4(v_in.pos.xyz, 1.0), ViewProj);
    vert_out.uv  = v_in.uv;
    return vert_out;
}

float2 get_bite_center(int idx) {
    if (use_explicit_bites > 0.5) {
        if (idx == 0) return float2(bite_0_x, bite_0_y);
        if (idx == 1) return float2(bite_1_x, bite_1_y);
        if (idx == 2) return float2(bite_2_x, bite_2_y);
        if (idx == 3) return float2(bite_3_x, bite_3_y);
        if (idx == 4) return float2(bite_4_x, bite_4_y);
        if (idx == 5) return float2(bite_5_x, bite_5_y);
        if (idx == 6) return float2(bite_6_x, bite_6_y);
        if (idx == 7) return float2(bite_7_x, bite_7_y);
        if (idx == 8) return float2(bite_8_x, bite_8_y);
        return float2(bite_9_x, bite_9_y);
    }
    // Procedural distribution along perimeter and inwards using golden angle (2.3999632 rad)
    float angle = float(idx) * 2.3999632;
    float dist = max(0.22, 0.44 - float(idx) * 0.025);
    return float2(0.5 + cos(angle) * dist, 0.5 + sin(angle) * dist);
}

float4 PSDefault(VertOut v_in) : TARGET {
    float2 uv = v_in.uv;

    // Apply bounce translation offset
    uv.x -= bounce_offset_x;
    uv.y -= bounce_offset_y;

    // Apply safe zone scale (zoom out to allow bounce / prevent clipping)
    uv -= 0.5;
    uv = uv / max(scale_factor, 0.001);
    uv += 0.5;

    // Impact recoil wobble on contact
    if (chomp_wobble > 0.0001) {
        uv.x += sin(time * 55.0) * chomp_wobble;
        uv.y += cos(time * 70.0 + 1.2) * chomp_wobble;
    }

    // Hard bounds on the original frame so outer area stays transparent
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return float4(0.0, 0.0, 0.0, 0.0);
    }

    // In Theater Scene impact reaction mode, time drives progress if bite_count is not set
    float active_bites = bite_count;
    if (active_bites < 0.5 && time > 0.0) {
        active_bites = 1.0;
    }

    int total_bites = int(active_bites);
    if (total_bites >= int(max_bites)) {
        return float4(0.0, 0.0, 0.0, 0.0);
    }

    bool is_bitten = false;
    float min_edge_dist = 999.0;

    // Evaluate all active bite cutouts
    for (int i = 0; i < 10; i++) {
        if (i >= total_bites) break;

        float2 b_center = get_bite_center(i);
        float2 diff = uv - b_center;
        float d = length(diff);
        float theta = atan2(diff.y, diff.x);

        // Base bite radius with scalloped tooth marks
        float effective_radius = bite_size;
        if (teeth_depth > 0.0001) {
            float tooth_scallop = cos(theta * teeth_count);
            effective_radius += teeth_depth * bite_size * tooth_scallop;
        }

        // Animate the most recent bite snapping shut
        if (i == total_bites - 1) {
            float current_prog = (chomp_progress > 0.0) ? chomp_progress : min(1.0, time * 10.0);
            effective_radius *= saturate(current_prog);
        }

        if (d < effective_radius) {
            is_bitten = true;
            break;
        }

        float edge_d = d - effective_radius;
        if (edge_d < min_edge_dist) {
            min_edge_dist = edge_d;
        }
    }

    if (is_bitten) {
        // Vanish the bitten chunk
        return float4(0.0, 0.0, 0.0, 0.0);
    }

    float4 color = image.Sample(textureSampler, uv);

    // Subtle dark rim along the bite contour for 3D depth and tooth mark definition
    if (edge_crumb_width > 0.0001 && min_edge_dist < edge_crumb_width) {
        float rim_factor = smoothstep(0.0, edge_crumb_width, min_edge_dist);
        color.rgb *= (0.55 + 0.45 * rim_factor);
    }

    return color;
}

technique Draw {
    pass {
        vertex_shader = VSDefault(v_in);
        pixel_shader  = PSDefault(v_in);
    }
}
]]

-- ─── Filter Definition ───────────────────────────────────────────────────────

local filter_info = {}
filter_info.id = "custom_bite_vanish_filter"
filter_info.type = obs.OBS_SOURCE_TYPE_FILTER
filter_info.output_flags = obs.OBS_SOURCE_VIDEO

filter_info.get_name = function(settings)
    return "Bite Vanish (Contact Chomp)"
end

filter_info.get_defaults = function(settings)
    obs.obs_data_set_default_double(settings, "scale_factor", 0.6)
    obs.obs_data_set_default_double(settings, "bite_size", 0.22)
    obs.obs_data_set_default_double(settings, "teeth_count", 7.0)
    obs.obs_data_set_default_double(settings, "teeth_depth", 0.08)
    obs.obs_data_set_default_double(settings, "max_bites", 8.0)
    obs.obs_data_set_default_double(settings, "bite_count", 0.0)
    obs.obs_data_set_default_double(settings, "chomp_speed", 12.0)
    obs.obs_data_set_default_double(settings, "edge_crumb_width", 0.015)
    obs.obs_data_set_default_double(settings, "bounce_speed_x", 0.35)
    obs.obs_data_set_default_double(settings, "bounce_speed_y", 0.25)
    obs.obs_data_set_default_double(settings, "reset_delay", 2.0)
    obs.obs_data_set_default_bool(settings, "auto_bounce", false)
    obs.obs_data_set_default_bool(settings, "auto_reset", true)
    obs.obs_data_set_default_bool(settings, "bite_on_enable", true)
    obs.obs_data_set_default_double(settings, "auto_contact_interval", 0.0)
end

-- Forward declaration of helper methods
local take_bite, reset_bites

take_bite = function(data, hit_x, hit_y)
    if data.bite_count >= data.max_bites then
        return
    end

    local now = obs.os_gettime_ns()
    data.bite_count = data.bite_count + 1

    -- Record bite coordinate (normalized 0..1)
    if hit_x and hit_y then
        data.bites[data.bite_count] = { x = hit_x, y = hit_y }
    else
        -- Procedural position around edge
        local angle = (data.bite_count - 1) * 2.3999632
        local dist = math.max(0.22, 0.44 - (data.bite_count - 1) * 0.025)
        data.bites[data.bite_count] = {
            x = 0.5 + math.cos(angle) * dist,
            y = 0.5 + math.sin(angle) * dist
        }
    end

    data.chomp_start_time = now
    data.wobble_start_time = now

    if data.bite_count >= data.max_bites then
        data.vanish_time = now
    end
end

reset_bites = function(data)
    data.bite_count = 0
    data.bites = {}
    data.vanish_time = 0
    data.chomp_start_time = 0
    data.wobble_start_time = 0
end

filter_info.create = function(settings, source)
    local data = {}
    data.source = source

    obs.obs_enter_graphics()
    data.effect = obs.gs_effect_create(shader_code, nil, nil)
    obs.obs_leave_graphics()

    if data.effect == nil then
        obs.blog(obs.LOG_ERROR, "[Bite Vanish] Shader compilation failed!")
    end

    data.scale_factor = 0.6
    data.bite_size = 0.22
    data.teeth_count = 7.0
    data.teeth_depth = 0.08
    data.max_bites = 8.0
    data.bite_count = 0.0
    data.chomp_speed = 12.0
    data.edge_crumb_width = 0.015
    data.bounce_speed_x = 0.35
    data.bounce_speed_y = 0.25
    data.reset_delay = 2.0
    data.auto_bounce = false
    data.auto_reset = true
    data.bite_on_enable = true
    data.auto_contact_interval = 0.0

    data.bites = {}
    data.bounce_pos_x = 0.0
    data.bounce_pos_y = 0.0
    data.bounce_vel_x = 0.35
    data.bounce_vel_y = 0.25
    data.chomp_start_time = 0
    data.wobble_start_time = 0
    data.vanish_time = 0
    data.last_auto_contact_time = 0
    data.was_enabled = true
    data.start_time = obs.os_gettime_ns()

    filter_info.update(data, settings)
    return data
end

filter_info.show = function(data)
    if data then
        data.start_time = obs.os_gettime_ns()
        if data.bite_on_enable then
            take_bite(data)
        end
    end
end

filter_info.destroy = function(data)
    if data.effect ~= nil then
        obs.obs_enter_graphics()
        obs.gs_effect_destroy(data.effect)
        data.effect = nil
        obs.obs_leave_graphics()
    end
end

filter_info.update = function(data, settings)
    data.scale_factor = obs.obs_data_get_double(settings, "scale_factor")
    data.bite_size = obs.obs_data_get_double(settings, "bite_size")
    data.teeth_count = obs.obs_data_get_double(settings, "teeth_count")
    data.teeth_depth = obs.obs_data_get_double(settings, "teeth_depth")
    data.max_bites = obs.obs_data_get_double(settings, "max_bites")
    local manual_count = obs.obs_data_get_double(settings, "bite_count")
    if manual_count > 0 and manual_count ~= data.bite_count then
        data.bite_count = manual_count
    end
    data.chomp_speed = obs.obs_data_get_double(settings, "chomp_speed")
    data.edge_crumb_width = obs.obs_data_get_double(settings, "edge_crumb_width")
    data.bounce_speed_x = obs.obs_data_get_double(settings, "bounce_speed_x")
    data.bounce_speed_y = obs.obs_data_get_double(settings, "bounce_speed_y")
    data.reset_delay = obs.obs_data_get_double(settings, "reset_delay")
    data.auto_bounce = obs.obs_data_get_bool(settings, "auto_bounce")
    data.auto_reset = obs.obs_data_get_bool(settings, "auto_reset")
    data.bite_on_enable = obs.obs_data_get_bool(settings, "bite_on_enable")
    data.auto_contact_interval = obs.obs_data_get_double(settings, "auto_contact_interval")
end

filter_info.video_tick = function(data, seconds)
    if not data.source then return end
    local enabled = obs.obs_source_enabled(data.source)
    if not data.was_enabled and enabled then
        data.start_time = obs.os_gettime_ns()
        if data.bite_on_enable then
            take_bite(data)
        end
    end
    data.was_enabled = enabled
end

filter_info.video_render = function(data, effect)
    if not data.effect then
        obs.obs_source_skip_video_filter(data.source)
        return
    end
    if not obs.obs_source_process_filter_begin(data.source, obs.GS_RGBA, obs.OBS_NO_DIRECT_RENDERING) then
        return
    end

    local now = obs.os_gettime_ns()
    if data.last_render_time == nil or (now - data.last_render_time > 200000000) then
        data.start_time = now
    end

    local dt = 0.016
    if data.last_render_time and data.last_render_time > 0 then
        dt = math.min(0.1, (now - data.last_render_time) / 1000000000.0)
    end
    data.last_render_time = now

    local elapsed_s = (now - (data.start_time or now)) / 1000000000.0

    -- 1. DVD-Style Auto-Bounce Collision Detection
    if data.auto_bounce and data.bite_count < data.max_bites then
        local bound_limit_x = math.max(0.05, (1.0 - data.scale_factor) * 0.48)
        local bound_limit_y = math.max(0.05, (1.0 - data.scale_factor) * 0.48)

        data.bounce_pos_x = data.bounce_pos_x + data.bounce_vel_x * dt
        data.bounce_pos_y = data.bounce_pos_y + data.bounce_vel_y * dt

        -- Contact with Left Wall
        if data.bounce_pos_x < -bound_limit_x then
            data.bounce_pos_x = -bound_limit_x
            data.bounce_vel_x = math.abs(data.bounce_speed_x)
            local contact_y = 0.5 + (math.random() - 0.5) * 0.3
            take_bite(data, 0.0, contact_y)
        -- Contact with Right Wall
        elseif data.bounce_pos_x > bound_limit_x then
            data.bounce_pos_x = bound_limit_x
            data.bounce_vel_x = -math.abs(data.bounce_speed_x)
            local contact_y = 0.5 + (math.random() - 0.5) * 0.3
            take_bite(data, 1.0, contact_y)
        end

        -- Contact with Top Wall
        if data.bounce_pos_y < -bound_limit_y then
            data.bounce_pos_y = -bound_limit_y
            data.bounce_vel_y = math.abs(data.bounce_speed_y)
            local contact_x = 0.5 + (math.random() - 0.5) * 0.3
            take_bite(data, contact_x, 0.0)
        -- Contact with Bottom Wall
        elseif data.bounce_pos_y > bound_limit_y then
            data.bounce_pos_y = bound_limit_y
            data.bounce_vel_y = -math.abs(data.bounce_speed_y)
            local contact_x = 0.5 + (math.random() - 0.5) * 0.3
            take_bite(data, contact_x, 1.0)
        end
    elseif not data.auto_bounce then
        data.bounce_pos_x = 0.0
        data.bounce_pos_y = 0.0
    end

    -- 2. Periodic Auto-Contact Timer (if configured)
    if data.auto_contact_interval > 0.1 and data.bite_count < data.max_bites then
        if data.last_auto_contact_time == 0 then
            data.last_auto_contact_time = now
        elseif (now - data.last_auto_contact_time) / 1000000000.0 >= data.auto_contact_interval then
            take_bite(data)
            data.last_auto_contact_time = now
        end
    end

    -- 3. Auto-Reset after vanishing
    if data.auto_reset and data.bite_count >= data.max_bites and data.vanish_time > 0 then
        local vanish_elapsed = (now - data.vanish_time) / 1000000000.0
        if vanish_elapsed >= data.reset_delay then
            reset_bites(data)
        end
    end

    -- 4. Chomp Progress (smooth elastic clamp)
    local chomp_prog = 1.0
    if data.chomp_start_time > 0 then
        local chomp_elapsed = (now - data.chomp_start_time) / 1000000000.0
        local raw_t = math.min(1.0, chomp_elapsed * data.chomp_speed)
        -- Ease-out cubic
        chomp_prog = 1.0 - math.pow(1.0 - raw_t, 3.0)
    end

    -- 5. Impact Recoil Wobble
    local wobble = 0.0
    if data.wobble_start_time > 0 then
        local wobble_elapsed = (now - data.wobble_start_time) / 1000000000.0
        if wobble_elapsed < 0.3 then
            local decay = 1.0 - (wobble_elapsed / 0.3)
            wobble = 0.015 * decay * decay
        end
    end

    -- 6. Pass Uniforms to Shader
    local set_float = function(name, val)
        local param = obs.gs_effect_get_param_by_name(data.effect, name)
        if param then obs.gs_effect_set_float(param, val) end
    end

    set_float("time", elapsed_s)
    set_float("scale_factor", data.scale_factor)
    set_float("bite_count", data.bite_count)
    set_float("max_bites", data.max_bites)
    set_float("bite_size", data.bite_size)
    set_float("teeth_count", data.teeth_count)
    set_float("teeth_depth", data.teeth_depth)
    set_float("chomp_progress", chomp_prog)
    set_float("chomp_wobble", wobble)
    set_float("edge_crumb_width", data.edge_crumb_width)
    set_float("bounce_offset_x", data.bounce_pos_x)
    set_float("bounce_offset_y", data.bounce_pos_y)

    local use_explicit = (#data.bites > 0) and 1.0 or 0.0
    set_float("use_explicit_bites", use_explicit)

    for i = 0, 9 do
        local b = data.bites[i + 1]
        local bx = b and b.x or 0.5
        local by = b and b.y or 0.5
        set_float("bite_" .. i .. "_x", bx)
        set_float("bite_" .. i .. "_y", by)
    end

    obs.obs_source_process_filter_end(data.source, data.effect, 0, 0)
end

-- ─── Filter Properties UI ───────────────────────────────────────────────────

filter_info.get_properties = function(data)
    local props = obs.obs_properties_create()

    -- Section 1: Bite Shape & Geometry
    obs.obs_properties_add_float_slider(props, "bite_size", "Bite Radius", 0.08, 0.45, 0.01)
    obs.obs_properties_add_float_slider(props, "teeth_count", "Teeth Scallops", 3.0, 14.0, 1.0)
    obs.obs_properties_add_float_slider(props, "teeth_depth", "Teeth Depth", 0.0, 0.20, 0.01)
    obs.obs_properties_add_float_slider(props, "edge_crumb_width", "Bite Edge Darkening", 0.0, 0.05, 0.002)
    obs.obs_properties_add_float_slider(props, "chomp_speed", "Chomp Speed", 4.0, 25.0, 1.0)
    obs.obs_properties_add_float_slider(props, "scale_factor", "Safe Zone Scale", 0.2, 1.0, 0.05)

    -- Section 2: Contact & Vanish Controls
    obs.obs_properties_add_float_slider(props, "max_bites", "Max Bites Before Vanish", 1.0, 10.0, 1.0)
    obs.obs_properties_add_float_slider(props, "bite_count", "Active Bites Count", 0.0, 10.0, 1.0)
    obs.obs_properties_add_bool(props, "auto_reset", "Auto-Reset (Heal after Vanishing)")
    obs.obs_properties_add_float_slider(props, "reset_delay", "Respawn Delay (seconds)", 0.5, 10.0, 0.5)
    obs.obs_properties_add_bool(props, "bite_on_enable", "Take Bite on Filter Enable")
    obs.obs_properties_add_float_slider(props, "auto_contact_interval", "Auto-Contact Interval (0=Off)", 0.0, 10.0, 0.5)

    -- Section 3: DVD-Style Auto Bounce
    obs.obs_properties_add_bool(props, "auto_bounce", "Auto-Bounce Mode (Bite at Screen Borders)")
    obs.obs_properties_add_float_slider(props, "bounce_speed_x", "Bounce Speed X", 0.05, 1.5, 0.05)
    obs.obs_properties_add_float_slider(props, "bounce_speed_y", "Bounce Speed Y", 0.05, 1.5, 0.05)

    -- Action Buttons
    obs.obs_properties_add_button(props, "btn_contact", "💥 Take Bite / Contact", function(properties, button)
        if data then
            take_bite(data)
        end
        return true
    end)

    obs.obs_properties_add_button(props, "btn_reset", "🔄 Reset Bites (Restore Whole)", function(properties, button)
        if data then
            reset_bites(data)
        end
        return true
    end)

    return props
end

-- ─── OBS Script Hooks & Hotkeys ─────────────────────────────────────────────

local hotkey_contact_id = obs.OBS_INVALID_HOTKEY_ID
local hotkey_reset_id = obs.OBS_INVALID_HOTKEY_ID
local all_filter_instances = {}

function script_description()
    return [[<h2>Bite Vanish (Contact Chomp) Filter</h2>
<p>At each contact (wall collision bounce, throwable impact, hotkey, or trigger), bite marks are chomped out of the source and vanish, progressively eating away the image until it completely disappears or resets.</p>
<ul>
  <li><b>Auto-Bounce Mode:</b> Bounces like a DVD logo, taking a bite out of the side that makes contact with the screen edge.</li>
  <li><b>Impact / Trigger Mode:</b> Bites vanish upon contact, hotkey, or Theater Scene throwable redeems.</li>
  <li><b>Customizable:</b> Adjust bite size, teeth scallops, chomp speed, and max bites.</li>
</ul>]]
end

local function on_hotkey_contact(pressed)
    if not pressed then return end
    for _, instance in ipairs(all_filter_instances) do
        take_bite(instance)
    end
end

local function on_hotkey_reset(pressed)
    if not pressed then return end
    for _, instance in ipairs(all_filter_instances) do
        reset_bites(instance)
    end
end

function script_load(settings)
    obs.obs_register_source(filter_info)

    hotkey_contact_id = obs.obs_hotkey_register_frontend(
        "bite_vanish_contact",
        "Bite Vanish: Take Bite / Contact",
        on_hotkey_contact
    )
    hotkey_reset_id = obs.obs_hotkey_register_frontend(
        "bite_vanish_reset",
        "Bite Vanish: Reset Bites",
        on_hotkey_reset
    )
end

function script_unload()
    if hotkey_contact_id ~= obs.OBS_INVALID_HOTKEY_ID then
        obs.obs_hotkey_unregister(hotkey_contact_id)
    end
    if hotkey_reset_id ~= obs.OBS_INVALID_HOTKEY_ID then
        obs.obs_hotkey_unregister(hotkey_reset_id)
    end
end
