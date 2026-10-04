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

console.log("=== TESTING GLOBAL VARIABLES BUTTONS & HANDLERS ===");

// 1. Check window functions exist
const fns = [
    'renderGlobalVariables', 'openAddGlobalVarModal', 'closeAddGlobalVarModal',
    'confirmAddGlobalVariable', 'addGlobalVariableRow', 'deleteGlobalVariable',
    'saveGlobalVariables', 'modifyGlobalVarLive', 'resetGlobalVarLive',
    'updateGlobalVarValue', 'openTutorialGuide', 'closeTutorialGuide'
];

fns.forEach(fn => {
    if (typeof context.window[fn] === 'function') {
        console.log(`✅ [PASS] window.${fn} is defined`);
    } else {
        console.error(`❌ [FAIL] window.${fn} is NOT defined`);
        process.exit(1);
    }
});

// 2. Test Add Variable Modal Flow
context.window.openAddGlobalVarModal();
const modal = elements['create-global-var-modal'];
console.log("Modal display state:", modal.style.display);
if (modal.style.display === 'flex') {
    console.log("✅ [PASS] openAddGlobalVarModal displays modal");
} else {
    console.error("❌ [FAIL] openAddGlobalVarModal did not set display to flex");
    process.exit(1);
}

// 3. Test Confirm Add Variable
elements['new-gvar-name'].value = "boss_hp";
elements['new-gvar-type'].value = "number";
elements['new-gvar-value'].value = "1000";
elements['new-gvar-desc'].value = "Current Boss HP";

context.window.confirmAddGlobalVariable();

const added = context.config.global_variables.find(v => v.name === "boss_hp");
if (added && added.value === 1000 && added.defaultValue === 1000 && added.type === "number") {
    console.log("✅ [PASS] confirmAddGlobalVariable created variable successfully:", added);
} else {
    console.error("❌ [FAIL] Variable was not created properly:", added);
    process.exit(1);
}

// 4. Test Live Modification
context.window.modifyGlobalVarLive("boss_hp", -50);
if (added.value === 950) {
    console.log("✅ [PASS] modifyGlobalVarLive: 1000 - 50 = 950");
} else {
    console.error("❌ [FAIL] modifyGlobalVarLive failed:", added.value);
    process.exit(1);
}

// 5. Test Live Reset
context.window.resetGlobalVarLive("boss_hp");
if (added.value === 1000) {
    console.log("✅ [PASS] resetGlobalVarLive restored default 1000");
} else {
    console.error("❌ [FAIL] resetGlobalVarLive failed:", added.value);
    process.exit(1);
}

// 6. Test Delete
const initialCount = context.config.global_variables.length;
const idx = context.config.global_variables.findIndex(v => v.name === "boss_hp");
// Simulate confirm dialog click OK
elements['panel-dialog-ok-btn'] = { onclick: null };
context.window.deleteGlobalVariable(idx);
// Trigger the dialog OK callback
const okBtn = elements['panel-dialog-ok-btn'];
if (okBtn && typeof okBtn.onclick === 'function') {
    okBtn.onclick();
    if (context.config.global_variables.length === initialCount - 1) {
        console.log("✅ [PASS] deleteGlobalVariable deleted variable successfully");
    } else {
        console.error("❌ [FAIL] deleteGlobalVariable failed to remove item");
        process.exit(1);
    }
}

console.log("\n✨ ALL GLOBAL VARIABLES BUTTON TESTS PASSED SUCCESSFULLY! ✨");
