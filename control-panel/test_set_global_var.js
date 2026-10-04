const fs = require('fs');
const vm = require('vm');

const elements = {};
function createMockEl(id = "", tag = "div") {
    const el = {
        id: id,
        tagName: tag,
        style: {},
        classList: {
            add: (cls) => el.classes.add(cls),
            remove: (cls) => el.classes.delete(cls),
            contains: (cls) => el.classes.has(cls)
        },
        classes: new Set(),
        children: [],
        appendChild: (child) => el.children.push(child),
        innerHTML: "",
        value: "",
        innerText: "",
        setAttribute: () => {},
        getAttribute: () => {},
        focus: () => {},
        select: () => {}
    };
    if (id) elements[id] = el;
    return el;
}

const mockDoc = {
    getElementById: (id) => elements[id] || createMockEl(id),
    createElement: (tag) => createMockEl("", tag),
    querySelectorAll: () => [],
    addEventListener: () => {}
};

const context = {
    window: {},
    console: console,
    Math: Math,
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    parseFloat: parseFloat,
    parseInt: parseInt,
    isNaN: isNaN,
    isFinite: isFinite,
    String: String,
    Array: Array,
    Object: Object,
    RegExp: RegExp,
    document: mockDoc,
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
    },
    OBSWebSocket: class { constructor() { this.on = () => {}; } },
    SplitEngine: class { constructor() {} }
};
context.window = context;
context.addEventListener = () => {};

const html = fs.readFileSync('control_panel.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const code = scriptMatch[1];
vm.createContext(context);
vm.runInContext(code, context);

async function runTests() {
    console.log("=== TESTING GLOBAL VARIABLE COMMANDS ===");

    // Pre-populate global variables
    context.config.global_variables = [
        { name: "death_count", type: "number", value: 10, defaultValue: 0, description: "Deaths" },
        { name: "player_title", type: "string", value: "Novice", defaultValue: "Novice", description: "Title" },
        { name: "gold_points", type: "number", value: 100, defaultValue: 100, description: "Gold" }
    ];

    // Check commands are registered in TheaterController
    const setCmd = context.window.TheaterController.customCommands['set_global_var'];
    const modCmd = context.window.TheaterController.customCommands['modify_global_var'];
    const resetCmd = context.window.TheaterController.customCommands['reset_global_var'];

    if (!setCmd || !modCmd || !resetCmd) {
        console.error("❌ [FAIL] One or more Global Variable commands are not registered in TheaterController!");
        process.exit(1);
    }
    console.log("✅ [PASS] set_global_var, modify_global_var, and reset_global_var are registered in TheaterController");

    // 1. Test set_global_var with a direct number
    await setCmd.handler({ var_name: "death_count", var_value: "25" }, [], {});
    const gv1 = context.config.global_variables.find(v => v.name === "death_count");
    if (gv1.value === 25) {
        console.log("✅ [PASS] set_global_var (direct number): death_count = 25");
    } else {
        console.error("❌ [FAIL] set_global_var failed:", gv1.value);
        process.exit(1);
    }

    // 2. Test set_global_var with a formula and wildcard: {1}*2 + 5
    await setCmd.handler({ var_name: "death_count", var_value: "{1}*2 + 5" }, ["10"], {});
    if (gv1.value === 25) { // 10*2 + 5 = 25
        console.log("✅ [PASS] set_global_var (formula '{1}*2 + 5' with {1}=10): death_count = 25");
    } else {
        console.error("❌ [FAIL] set_global_var formula failed:", gv1.value);
        process.exit(1);
    }

    // 3. Test set_global_var with string variable
    await setCmd.handler({ var_name: "player_title", var_value: "Champion of {username}" }, [], { username: "Morty" });
    const gv2 = context.config.global_variables.find(v => v.name === "player_title");
    if (gv2.value === "Champion of Morty") {
        console.log("✅ [PASS] set_global_var (string template): player_title = Champion of Morty");
    } else {
        console.error("❌ [FAIL] set_global_var string failed:", gv2.value);
        process.exit(1);
    }

    // 4. Test modify_global_var (+5)
    await modCmd.handler({ var_name: "death_count", delta: "5" }, [], {});
    if (gv1.value === 30) {
        console.log("✅ [PASS] modify_global_var (+5): death_count = 30");
    } else {
        console.error("❌ [FAIL] modify_global_var failed:", gv1.value);
        process.exit(1);
    }

    // 5. Test modify_global_var (-10 via math formula)
    await modCmd.handler({ var_name: "death_count", delta: "-({1}*2)" }, ["5"], {});
    if (gv1.value === 20) {
        console.log("✅ [PASS] modify_global_var (-{1}*2 with {1}=5): death_count = 20");
    } else {
        console.error("❌ [FAIL] modify_global_var formula failed:", gv1.value);
        process.exit(1);
    }

    // 6. Test reset_global_var
    await resetCmd.handler({ var_name: "death_count" }, [], {});
    if (gv1.value === 0) {
        console.log("✅ [PASS] reset_global_var: death_count reset to default (0)");
    } else {
        console.error("❌ [FAIL] reset_global_var failed:", gv1.value);
        process.exit(1);
    }

    console.log("\n✨ ALL GLOBAL VARIABLE COMMAND TESTS PASSED! ✨");
}

runTests();
