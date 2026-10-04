const fs = require('fs');
const vm = require('vm');

// Create mock browser window context
const context = {
    window: {},
    console: console,
    Math: Math,
    parseFloat: parseFloat,
    parseInt: parseInt,
    isNaN: isNaN,
    isFinite: isFinite,
    String: String,
    Array: Array,
    Object: Object,
    RegExp: RegExp,
    OBSWebSocket: class {
        constructor() { this.on = () => {}; }
    },
    SplitEngine: class {
        constructor() {}
    },
    document: {
        querySelectorAll: () => [],
        getElementById: () => null,
        createElement: () => ({ style: {}, classList: { add: ()=>{}, remove: ()=>{} }, appendChild: ()=>{} }),
        addEventListener: () => {}
    },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
    }
};
context.window = context;
context.addEventListener = () => {};

const html = fs.readFileSync('control_panel.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
    console.error("Could not find <script> tag in control_panel.html");
    process.exit(1);
}
const code = scriptMatch[1];
vm.createContext(context);
vm.runInContext(code, context);

console.log("=== THEATER MATH & VARIABLES TEST SUITE ===");

const Theater = context.window.TheaterController;
const config = context.config;

// Set up mock global variables
config.global_variables = [
    { name: "death_count", type: "number", value: 12, defaultValue: 0 },
    { name: "points", type: "number", value: 500, defaultValue: 100 },
    { name: "bonus", type: "number", value: 5, defaultValue: 0 },
    { name: "streamer_title", type: "string", value: "Grandmaster", defaultValue: "Novice" }
];

let passed = 0;
let failed = 0;

function assertEqual(testName, actual, expected) {
    if (actual === expected) {
        console.log(`✅ [PASS] ${testName}: ${actual}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${testName}: Expected ${expected}, got ${actual}`);
        failed++;
    }
}

// 1. User's exact requested formula: {1}*2(2/{2})+7
// With {1} = 5, {2} = 2: 5 * 2 * (2 / 2) + 7 = 17
const formula1 = "{1}*2(2/{2})+7";
const res1 = Theater.evalMath(formula1, [5, 2], null);
assertEqual("User Formula: {1}*2(2/{2})+7 with {1}=5, {2}=2", res1, 17);

// 2. Implicit Multiplications
assertEqual("Implicit mult: 2(3)", Theater.evalMath("2(3)", [], null), 6);
assertEqual("Implicit mult: (2)(3)", Theater.evalMath("(2)(3)", [], null), 6);
assertEqual("Implicit mult: 3{1} with {1}=4", Theater.evalMath("3{1}", [4], null), 12);
assertEqual("Implicit mult: ({1})2 with {1}=4", Theater.evalMath("({1})2", [4], null), 8);
assertEqual("Implicit mult: {1}{2} with {1}=3, {2}=5", Theater.evalMath("{1}{2}", [3, 5], null), 15);

// 3. Math functions
assertEqual("Function: round(3.14159, 2)", Theater.evalMath("round(3.14159, 2)", [], null), 3.14);
assertEqual("Function: floor(4.9)", Theater.evalMath("floor(4.9)", [], null), 4);
assertEqual("Function: ceil(4.1)", Theater.evalMath("ceil(4.1)", [], null), 5);
assertEqual("Function: clamp(150, 0, 100)", Theater.evalMath("clamp(150, 0, 100)", [], null), 100);
assertEqual("Function: clamp(-10, 0, 100)", Theater.evalMath("clamp(-10, 0, 100)", [], null), 0);
assertEqual("Function: min(5, 2, 8)", Theater.evalMath("min(5, 2, 8)", [], null), 2);
assertEqual("Function: max(5, 2, 8)", Theater.evalMath("max(5, 2, 8)", [], null), 8);
assertEqual("Function: abs(-15)", Theater.evalMath("abs(-15)", [], null), 15);
assertEqual("Function: sqrt(16)", Theater.evalMath("sqrt(16)", [], null), 4);
assertEqual("Operator: 2^3", Theater.evalMath("2^3", [], null), 8);
assertEqual("Operator: 2**3", Theater.evalMath("2**3", [], null), 8);
assertEqual("Function: pow(2, 3)", Theater.evalMath("pow(2, 3)", [], null), 8);

// Random function range check
const randVal = Theater.evalMath("random(10, 20)", [], null);
console.log(`✅ [PASS] random(10, 20) returned: ${randVal}`);
if (randVal >= 10 && randVal <= 20) passed++; else failed++;

// 4. Global Variables & Template Substitutions
const t1 = Theater.replaceVariables("Deaths: {global.death_count}, Points: {points}, Title: {streamer_title}", [], null);
assertEqual("Global Variable Substitution", t1, "Deaths: 12, Points: 500, Title: Grandmaster");

// 5. Inline Math inside Text: {{ ... }}
const t2 = Theater.replaceVariables("Score: {{ {global.death_count} * 10 + 5 }}", [], null);
assertEqual("Inline Math in Text: {{ {global.death_count} * 10 + 5 }}", t2, "Score: 125");

const t3 = Theater.replaceVariables("Attack roll: {{ 10 + {global.bonus} }} damage!", [], null);
assertEqual("Inline Math with Bonus", t3, "Attack roll: 15 damage!");

// 6. Syntax Validation (Red border logic)
const valValid1 = Theater.validateMathSyntax("{1}*2(2/{2})+7");
assertEqual("Syntax Valid for User Formula", valValid1.valid, true);

const valValid2 = Theater.validateMathSyntax("random(1, 100) + {global.death_count} * 2");
assertEqual("Syntax Valid for Random + Global", valValid2.valid, true);

const valInvalid1 = Theater.validateMathSyntax("(5 + 2");
assertEqual("Syntax Invalid for unclosed paren", valInvalid1.valid, false);
console.log(`   (Error message caught: "${valInvalid1.error}")`);

const valInvalid2 = Theater.validateMathSyntax("unknownFn(10)");
assertEqual("Syntax Invalid for unknown function", valInvalid2.valid, false);
console.log(`   (Error message caught: "${valInvalid2.error}")`);

console.log(`\n========================================`);
console.log(`TOTAL RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log(`========================================`);
if (failed > 0) process.exit(1);
