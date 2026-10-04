# 🎛️ Theater Control Panel

**Theater Control Panel** is a modular, high-performance web and desktop dashboard designed for live streamers and content creators. It provides customizable dock layouts, multi-platform integrations, and overlay controls for live stream production.

---

## 💡 Recommendation & Disclaimer

> [!TIP]
> **Recommended Pairing with [Theater Reader](https://github.com/Mortygotvr/Theater-reader)**:
> While Theater Control Panel can operate standalone, using it alongside **Theater Reader** is **strongly recommended**. Certain platform APIs (especially **Kick live chat**) can be difficult to connect directly; Theater Reader handles background connection stability, avatar caching, and WebSocket relaying seamlessly.

---

## ✨ Features

- 🧩 **Modular Dock Layout System**: Customize docks for chat streams, OBS controls, social media feeds, and web docks.
- 💬 **Multi-Platform Modules**: Pre-built TCP modules for Twitch, Kick, Discord, Bluesky, Patreon, X (Twitter), and BeatSaber.
- 🖥️ **Desktop Application**: Run directly as a desktop application (`ControlPanel.exe`).
- 🎭 **Custom Overlays**: Includes pre-packaged HTML overlays and Lua script integration for OBS Studio.

---

## 📦 Included TCP Modules

Theater Control Panel comes pre-packaged with 16 `.tcp` modules located in the `modules/` directory:

| Module | Description | Notes & Requirements |
| :--- | :--- | :--- |
| **Beat Saber** (`beatsaber.tcp`) | Live Beat Saber song stats, performance metrics, and HUD overlay. | ⚠️ **Requires [Sira HTTP Status Mod](https://github.com/hryu/DataPuller) installed in Beat Saber.** |
| **Twitch Chat** (`twitch_chat.tcp`) | Live Twitch chat dock with message controls and moderation tools. | |
| **Twitch API** (`twitch_api.tcp`) | Twitch Helix API, Channel Points rewards, and subscription event triggers. | |
| **Kick Chat** (`kick_chat.tcp`) | Live Kick chat stream dock with viewer count tracking. | |
| **Kick API** (`kick_api.tcp`) | Kick platform API integration and follower/sub triggers. | |
| **Kick Commands** (`kick_command.tcp`) | Kick chat command triggers and automated moderation actions. | |
| **OBS Controls** (`obs_controls.tcp`) | OBS Studio scene switcher, source visibility toggle, and stream/recording controls. | Requires OBS WebSocket enabled. |
| **Discord** (`discord.tcp`) | Discord bot integration, webhook triggers, and status updates. | |
| **Bluesky** (`bsky.tcp`) | Bluesky social network feed integration and post triggers. | |
| **Patreon** (`patreon.tcp`) | Patreon supporter alerts and subscription tier status. | |
| **Ko-fi** (`kofi.tcp`) | Ko-fi donations, recurring memberships, shop orders, and commission alerts. | Supports Webhook Relay proxy or direct push. |
| **X (Twitter)** (`x.tcp`) | X (Twitter) social integration and automated post triggers. | |
| **Theatre 360** (`theatre360.tcp`) | Panoramic and 3D camera controls for 3D stream overlays. | |
| **WebSocket Connector** (`websocket_connector.tcp`) | Custom WebSocket client/server connector to relay events to external apps. | |
| **HTML Widget** (`html.tcp`) | Render custom HTML/CSS widgets and dynamic status panels directly in your layout. | |
| **JSON Viewer** (`json_viewer.tcp`) | Live JSON data inspector and event payload debugger. | |

---

## 🚀 Quick Start

1. Download and run `ControlPanel.exe`.
2. Drag, dock, and customize your layout modules.
3. Connect your stream accounts or local WebSocket servers (e.g. Theater Reader & OBS Studio).

---

## 🧩 Creating Your Own TCP Module

You can extend Theater Control Panel by building custom `.tcp` JavaScript modules placed inside the `modules/` directory.

### Quick Example (`modules/my_module.tcp`):

```javascript
// @theater-tcp-module
(function() {
    window.TheaterController.registerModule("my_module", {
        name: "My Custom Module",
        description: "Custom stream integration and trigger actions.",
        configFields: [
            { id: "api_key", label: "API Key", type: "password", default: "" }
        ],
        onLoad(config) {
            console.log("[My Module] Loaded with config:", config);
        },
        onUnload() {
            console.log("[My Module] Unloaded.");
        }
    });

    // Register a custom action trigger command
    window.TheaterController.registerCommand(
        "my_action",
        async (inputs, matches, payload) => {
            const msg = window.TheaterController.replaceVariables(inputs.messageText, matches, payload);
            console.log("Executed action:", msg);
        },
        {
            label: "Send Custom Alert",
            fields: [
                { id: "messageText", label: "Message", type: "text", default: "Hello {username}!" }
            ]
        },
        "my_module"
    );
})();
```

For full documentation on registering triggers, context providers, template variables (`{username}`, `{1}`), and hidden browser webview automation, see the **[TCP Module Development Guide](https://github.com/Mortygotvr/Theater-Control-panel/blob/main/modules/README.md)**.

---

## 📐 Mathematical Formulas & Algebraic Expressions

All numeric input fields (such as delays, durations, multipliers, counters) and text messages support rich algebraic mathematics:

- **Implicit Multiplication**: Write algebraic equations naturally without tedious asterisks (e.g. `{1}*2(2/{2})+7` or `3{1}`).
- **Math Functions**:
  - `random(min, max)`: Generate random integers for giveaways, dice rolls, or loot minigames.
  - `round(x, [decimals])`: Round numbers to clean precision.
  - `floor(x)` / `ceil(x)`: Round down / up.
  - `clamp(val, min, max)`: Bound values within safe ranges.
  - `min(a, b)` / `max(a, b)`: Find extremes.
  - `abs(x)` / `sqrt(x)` / `pow(b, e)` (or `b^e`).
- **Inline Text Math**: Evaluate math formulas directly in chat or overlay texts via `{{ ... }}` (e.g. `"You rolled {{ random(1, 20) + {global.bonus} }}!"`).
- **Real-Time Error Callouts**: Invalid math syntax (e.g. unclosed parentheses `(5+2`) is highlighted with a real-time red border and warning badge.
- **Non-Invasive Autocomplete**: Quick autocomplete suggestions appear only when typing function letters (e.g. typing `r` suggests `random` and `round`).

---

## 🌐 Global Variables System

The dedicated **Global Variables** tab lets you create persistent counters and variables across your entire streaming session:

- **Reference Anywhere**: Access values using `{global.death_count}`, `{global.points}`, or `{death_count}` in overlays, triggers, and math expressions.
- **Live Controls**: Increment/decrement (+1, -1, +5, -5) or reset counters directly from the dashboard in real-time.
- **Built-in Actions**: Modify global variables dynamically via trigger commands (`set_global_var`, `modify_global_var`, `reset_global_var`).

---

## 🔒 License

Licensed under the **MIT License (with Non-Commercial / No-Resale Restriction)**. See [LICENSE](https://github.com/Mortygotvr/Theater-Control-panel/blob/main/LICENSE) for details.
