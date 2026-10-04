# Theater TCP Module Development Guide

This guide describes how to build, register, and maintain `.tcp` (Theater Control Panel) modules. It covers module structure, framework APIs, strict isolation rules, and best practices for browser automation.

---

## 1. Module File Header

Every `.tcp` file must start with a specific comment header. Without this header, the loader will eject the file as invalid.

```javascript
// @theater-tcp-module
(function() {
    // Module code goes here
})();
```
*Note: Alternatively, `/* @theater-tcp-module */` is also accepted.*

---

## 2. Framework APIs

Dynamic modules register themselves and extend the dashboard's capabilities by invoking functions on the global `window.TheaterController` API.

### `registerModule(moduleId, definition)`
Defines the module meta, configuration fields, lifecycle callbacks, and variable presets.
```javascript
window.TheaterController.registerModule("my_module", {
    name: "My Custom Module",
    description: "Brief summary of what this module does.",
    configFields: [
        {
            id: "api_key",
            label: "API Authentication Key",
            type: "password", // 'text', 'password', or 'number'
            default: ""
        }
    ],
    onLoad(moduleConfig) {
        logMsg("[My Module] Initialized.");
    },
    onUnload() {
        logMsg("[My Module] Unloaded.");
    }
});
```

### `registerCommand(commandId, handler, uiConfig, moduleName)`
Registers a custom action that users can add to triggers.
```javascript
window.TheaterController.registerCommand(
    "my_custom_action",
    async (inputs, matches, payload) => {
        // Implementation logic
        const formattedMsg = window.TheaterController.replaceVariables(inputs.messageText, matches, payload);
        logMsg(`Executing action with message: ${formattedMsg}`);
    },
    {
        label: "Execute Custom Action",
        fields: [
            { id: "messageText", label: "Message Template", type: "text", default: "Hello {username}!" }
        ]
    },
    "my_module"
);
```

### `registerTrigger(triggerId, matcher, uiConfig, moduleName)`
Registers a custom trigger event listener.
```javascript
window.TheaterController.registerTrigger(
    "my_custom_event",
    (triggerConfig, eventData) => {
        // Matcher function: return true to execute commands
        return eventData.type === triggerConfig.eventType;
    },
    {
        label: "My Event Listener",
        fields: [
            { id: "eventType", label: "Event Type", type: "text", default: "chat" }
        ]
    },
    "my_module"
);
```

### `registerContextProvider(providerId, fetcher, uiConfig, moduleName)`
Registers an asynchronous resolver to fetch context data (e.g. looking up user info) before executing a trigger's commands.
```javascript
window.TheaterController.registerContextProvider(
    "fetch_user_details",
    async (inputs, payload) => {
        // Returns an object that is merged into trigger payload
        return { userAge: 25 };
    },
    {
        label: "Fetch User Details",
        fields: []
    },
    "my_module"
);
```

### `replaceVariables(text, matches, payload)`
A built-in utility to parse template variables like `{1}`, `{username}`, `{global.score}`, `{customData.subscriber}`, or inline math like `{{ {1} * 2 + 5 }}`.
```javascript
const parsed = window.TheaterController.replaceVariables(templateString, matches, payload);
```

### `evalMath(expression, matches, payload)`
Evaluates mathematical formulas and algebra (e.g. `{1}*2(2/{2})+7` or `random(1, 20) + {global.bonus}`) with implicit multiplication and built-in functions (`random`, `round`, `floor`, `ceil`, `clamp`, `min`, `max`, `abs`, `sqrt`, `pow`).
```javascript
const resultNumber = window.TheaterController.evalMath("{1}*2(2/{2})+7", matches, payload);
```

### `validateMathSyntax(expression)`
Validates formula syntax without throwing exceptions, returning `{ valid: true }` or `{ valid: false, error: "..." }`.
```javascript
const status = window.TheaterController.validateMathSyntax(userInput);
if (!status.valid) {
    console.warn("Invalid syntax:", status.error);
}
```

### UI Field Type: `global_var_select`
Commands can render an auto-populated select dropdown containing all active Global Variables in the user's dashboard:
```javascript
fields: [
    { id: "var_name", label: "Target Variable", type: "global_var_select", default: "" }
]
```

---

## 3. Browser Automation (Hidden Webviews)

Theater supports driving browser automation (e.g. automating chat commands, metadata updates, or moderator actions) by running hidden webviews in Tauri.

### Invoking Hidden Webviews
To run a script in a hidden background browser session:
```javascript
if (window.__TAURI__) {
    window.__TAURI__.core.invoke('open_hidden_webview', {
        url: "https://dashboard.example.com",
        js: "document.querySelector('#target-button').click();",
        delay_ms: 3000,       // Delay before executing the JS (allow DOM to load)
        close_delay_ms: 1000  // Delay after executing JS before closing window
    });
}
```

### CRITICAL: Sequential Execution & The Webview Lock
1. **Serialized Execution**: In the Rust backend, all hidden webview launches are serialized under a single mutex (`WebviewLock`). Spawning multiple background commands concurrently is completely safe, but they will be executed **sequentially** (one after the other).
2. **Minimize Lock Times**: Because only one hidden webview runs at a time, developers must keep `delay_ms` and `close_delay_ms` as short as possible. Heavy delay settings in one module will block and queue up automations in other modules (e.g. Kick, X, Discord).
3. **Cookie Sharing**: Hidden webviews share cookies and active login sessions with visible service login windows opened via `open_service_login`.

---

## 4. Strict Isolation Rules

To prevent settings corruption or runtime failures:
* **Zero Intertwining**: A module must never reference settings, states, or DOM elements of other modules.
* **Fail-Safe Loading**: Modules must gracefully initialize even if the backend is not connected.
* **Preservation**: The control panel handles preserving configuration settings for triggers/commands when their defining modules are temporarily unloaded or bypassed. Ensure module configuration structures are stable and don't overwrite unrelated namespace parameters.
