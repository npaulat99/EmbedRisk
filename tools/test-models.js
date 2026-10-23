// Unit tests for the isomorphic webview models (no VS Code needed). Run: node tools/test-models.js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const DfdModel = require(path.join(root, "vscode-extension/media/dfd-model.js"));
const AtModel = require(path.join(root, "vscode-extension/media/attacktree-model.js"));
const RiskModel = require(path.join(root, "vscode-extension/media/risk-model.js"));

function hasTraFixtures(projectDir) {
  return fs.existsSync(path.join(projectDir, "04-dfd/dfd.json")) && fs.existsSync(path.join(projectDir, "07-attack-trees/attack-trees.json"));
}

function discoverProjectDir() {
  const candidates = [
    process.argv[2],
    process.env.EMBEDRISK_PROJECT_DIR,
  ].filter(Boolean).map((p) => (path.isAbsolute(p) ? p : path.join(root, p)));

  for (const c of candidates) {
    if (hasTraFixtures(c)) return c;
  }

  const searchRoots = [
    path.join(root, "projects"),
    path.join(root, "webapp", "projects"),
  ];
  for (const dir of searchRoots) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (hasTraFixtures(full)) return full;
    }
  }

  throw new Error(
    "No TRA project fixture found. Pass a project directory as argv[2] or EMBEDRISK_PROJECT_DIR."
  );
}

let passed = 0;
function ok(name, cond) { assert.ok(cond, "FAIL: " + name); passed++; }

/* ---------- Optional fixture smoke checks ---------- */
let projectDir = null;
try {
  projectDir = discoverProjectDir();
} catch {
  // Synthetic fixtures below keep this test deterministic even when no sample project is present.
}

if (projectDir) {
  const fixtureDfd = JSON.parse(fs.readFileSync(path.join(projectDir, "04-dfd/dfd.json"), "utf8"));
  ok("fixture dfd has nodes array", Array.isArray(fixtureDfd.nodes));
  ok("fixture dfd has flows array", Array.isArray(fixtureDfd.flows));

  const fixtureTrees = JSON.parse(fs.readFileSync(path.join(projectDir, "07-attack-trees/attack-trees.json"), "utf8"));
  ok("fixture attack-trees has trees array", Array.isArray(fixtureTrees.trees));
}

/* ---------- DFD model ---------- */
const dfd = {
  nodes: [
    { id: "TB-ENC", label: "Device housing", type: "trust-boundary", layer: 1, parent: null, members: ["N-DEV"] },
    { id: "N-DCS", label: "DCS", type: "external-entity", layer: 1, parent: null },
    { id: "N-PHONE", label: "Phone", type: "external-entity", layer: 1, parent: null },
    { id: "N-DEV", label: "Device", type: "process", layer: 1, parent: null },
    { id: "N-MCU", label: "MCU", type: "process", layer: 2, parent: "N-DEV" },
    { id: "N-BT", label: "BLE", type: "process", layer: 2, parent: "N-DEV" },
    { id: "N-HART", label: "HART", type: "store", layer: 2, parent: "N-DEV" },
    { id: "N-CFG", label: "Config", type: "store", layer: 2, parent: "N-DEV" },
    { id: "TB-CORE", label: "Core", type: "trust-boundary", layer: 2, parent: "N-DEV", members: ["N-MCU", "N-CFG"] },
  ],
  flows: [
    { id: "F1", from: "N-DCS", to: "N-DEV", label: "cmd" },
    { id: "F2", from: "N-DEV", to: "N-PHONE", label: "status" },
    { id: "F3", from: "N-MCU", to: "N-CFG", label: "load" },
  ],
};

const rootSibs = DfdModel.siblings(dfd, null).map((n) => n.id);
ok("root siblings exclude trust boundary", JSON.stringify(rootSibs) === JSON.stringify(["N-DCS", "N-PHONE", "N-DEV"]));

const devKids = DfdModel.children(dfd, "N-DEV").map((n) => n.id).sort();
ok("N-DEV has 5 children", devKids.length === 5 && devKids.includes("N-MCU") && devKids.includes("TB-CORE"));

ok("layerOf root is 1", DfdModel.layerOf(dfd, null) === 1);
ok("layerOf into N-DEV is 2", DfdModel.layerOf(dfd, "N-DEV") === 2);

const laidOut = DfdModel.layout(dfd, null).filter((n) => n.type !== "trust-boundary");
ok("layout assigns numeric x/y", laidOut.every((n) => typeof n.x === "number" && typeof n.y === "number"));

const svgRoot = DfdModel.render(dfd, null, "N-DEV");
ok("render emits process ellipse", svgRoot.includes("<ellipse"));
ok("render emits external rect", svgRoot.includes("<rect"));
ok("render tags nodes with data-id", svgRoot.includes("data-id='N-DEV'"));
ok("render highlights focus", svgRoot.includes("#1565c0"));
ok("render draws boundary dashes", svgRoot.includes("stroke-dasharray"));

// multiprocess must be a DOUBLE concentric ellipse (per DataFlowDiagram.xml), not an ellipse+line
const mpDfd = { nodes: [{ id: "MP", label: "x", type: "multiprocess", layer: 1, parent: null }], flows: [] };
const mpSvg = DfdModel.render(mpDfd, null, null);
ok("multiprocess renders two concentric ellipses", (mpSvg.match(/<ellipse/g) || []).length === 2);
ok("multiprocess has no stray vertical line", !mpSvg.includes("<line"));

// mutation tests on a deep copy
const d2 = JSON.parse(JSON.stringify(dfd));
const before = d2.nodes.length;
const added = DfdModel.addNode(d2, null, "process", "Test node");
ok("addNode adds a node with parent null/layer1", added.parent === null && added.layer === 1 && d2.nodes.length === before + 1);
const fl = DfdModel.addFlow(d2, "N-DCS", added.id, "x");
ok("addFlow adds a flow", d2.flows.some((f) => f.id === fl.id && f.from === "N-DCS"));

// Id scheme mirrors the webapp's uid(): prefix + lowest free positive integer among <prefix><digits> ids.
ok("nextId starts at 1 with no ids", DfdModel.nextId("AD-", []) === "AD-1");
ok("nextId fills the lowest gap", DfdModel.nextId("T", ["T1", "T3"]) === "T2");
ok("nextId ignores ids of other forms", DfdModel.nextId("T", ["T-1", "TB-1", "T1a", "AT1", "T"]) === "T1");
ok("nextId treats zero-padded numbers by value", DfdModel.nextId("AD-", ["AD-01"]) === "AD-2");
ok("nextId tolerates non-string ids", DfdModel.nextId("N-", [null, undefined, 7, "N-1"]) === "N-2");
ok("addNode uses webapp node prefix N-", added.id === "N-1");
ok("addFlow uses webapp flow prefix F and skips existing", fl.id === "F4");
const d4 = { nodes: [{ id: "N-1", label: "a", type: "process", layer: 1, parent: null }, { id: "TB-1", label: "b", type: "trust-boundary", layer: 1, parent: null }], flows: [] };
const tbNode = DfdModel.addNode(d4, null, "trust-boundary", "TB", ["TB-2"]);
ok("addNode gives trust boundaries TB- ids avoiding reserved system TB ids", tbNode.id === "TB-3");
const pNode = DfdModel.addNode(d4, null, "external-entity", "EE");
ok("addNode numbers N- nodes after existing ones", pNode.id === "N-2");
ok("addNode never rewrites existing ids", d4.nodes.slice(0, 2).map((n) => n.id).join() === "N-1,TB-1");

const d3 = JSON.parse(JSON.stringify(dfd));
DfdModel.deleteNode(d3, "N-DEV");
ok("delete removes node + descendants", !d3.nodes.some((n) => ["N-DEV", "N-MCU", "N-BT", "N-HART", "N-CFG", "TB-CORE"].includes(n.id)));
ok("delete removes flows touching removed nodes", !d3.flows.some((f) => ["N-DEV", "N-MCU", "N-CFG"].includes(f.from) || ["N-DEV", "N-MCU"].includes(f.to)));
ok("delete cleans trust-boundary members", d3.nodes.filter((n) => n.id === "TB-ENC").every((tb) => !(tb.members || []).includes("N-DEV")));

// Webapp-owned layout fields and future metadata must survive extension edits and JSON saves.
const roundTripDfd = {
  nodes: [
    { id: "N-KEEP", type: "process", layer: 1, parent: null, componentRef: "C1", width: 240, height: 100, x: 17, y: 23, extra: { tags: ["node"] } },
    { id: "N-CHILD", type: "store", layer: 2, parent: "N-KEEP", componentRef: "C2", width: 180, height: 80, x: 31, y: 47 },
  ],
  flows: [{ id: "F1", from: "N-KEEP", to: "N-CHILD", sourceHandle: "r", targetHandle: "l", extra: { tags: ["flow"] } }],
  ifacePos: { "root:IF1": { x: 10, y: 20 }, "N-KEEP:IF1": { x: 30, y: 40 } },
  ifaceRot: { "root:IF1": 90, "N-KEEP:IF1": 180 },
  ifaceLink: { "N-KEEP:IF1": { sourceHandle: "b", targetHandle: "t" } },
  portPos: { "N-KEEP:N-CHILD": { x: 50, y: 60 } },
  extra: { version: 1, tags: ["diagram"] },
};
const expectedRoundTrip = JSON.parse(JSON.stringify(roundTripDfd));
function assertDfdPreserved(operation) {
  const saved = JSON.parse(JSON.stringify(roundTripDfd));
  saved.nodes = saved.nodes.filter((n) => expectedRoundTrip.nodes.some((original) => original.id === n.id));
  saved.flows = saved.flows.filter((f) => expectedRoundTrip.flows.some((original) => original.id === f.id));
  assert.deepStrictEqual(saved, expectedRoundTrip, operation + " preserves existing DFD metadata");
  passed++;
}
const unrelated = DfdModel.addNode(roundTripDfd, null, "process", "Unrelated");
assertDfdPreserved("addNode");
DfdModel.addFlow(roundTripDfd, "N-KEEP", unrelated.id, "Unrelated flow");
assertDfdPreserved("addFlow");
DfdModel.layout(roundTripDfd, null);
DfdModel.layout(roundTripDfd, "N-KEEP");
assertDfdPreserved("layout");
DfdModel.deleteNode(roundTripDfd, unrelated.id);
assertDfdPreserved("deleteNode");
assert.deepStrictEqual(roundTripDfd, expectedRoundTrip, "deleting the unrelated node removes only its node and flow");

const orphanDfd = JSON.parse(JSON.stringify(dfd));
orphanDfd.nodes.push({ id: "N-DEEP", type: "store", parent: "N-MCU", layer: 3 });
const layoutValues = {
  ifacePos: { x: 10, y: 20 },
  ifaceRot: 90,
  ifaceLink: { sourceHandle: "r", targetHandle: "l" },
  portPos: { x: 30, y: 40 },
};
const orphanKeys = ["N-DEV:IF1", "N-MCU:IF1", "N-DEEP:IF1", "root:N-DEV", "N-DCS:N-MCU", "root:N-DEEP"];
const retainedKeys = ["root:IF1", "N-DCS:IF1", "N-DEV-OTHER:IF1", "root:N-DEV-OTHER", "constructor:IF1", "root:toString"];
for (const [field, value] of Object.entries(layoutValues)) {
  orphanDfd[field] = Object.fromEntries([...orphanKeys, ...retainedKeys].map((key) => [key, value]));
}
DfdModel.deleteNode(orphanDfd, "N-DEV");
for (const [field, value] of Object.entries(layoutValues)) {
  assert.deepStrictEqual(orphanDfd[field], Object.fromEntries(retainedKeys.map((key) => [key, value])),
    "deleteNode cleans " + field + " for the node and descendants without removing unrelated keys");
  passed++;
}
ok("delete removes deeply nested descendants", !orphanDfd.nodes.some((n) => n.id === "N-DEEP"));
ok("delete does not introduce absent layout maps", Object.keys(layoutValues).every((field) => !Object.hasOwn(d3, field)));
const emptyLayoutDfd = { nodes: [], flows: [], ifacePos: {}, ifaceRot: {}, ifaceLink: {}, portPos: {} };
DfdModel.deleteNode(emptyLayoutDfd, "N-MISSING");
assert.deepStrictEqual(emptyLayoutDfd, { nodes: [], flows: [], ifacePos: {}, ifaceRot: {}, ifaceLink: {}, portPos: {} });

/* ---------- Attack-defense tree model (schema-identical to the webapp) ---------- */
const tree = {
  id: "AT-1",
  title: "Unauthorized firmware change",
  root: {
    id: "g1",
    kind: "goal",
    label: "Compromise firmware",
    gate: "OR",
    children: [
      {
        id: "s1",
        kind: "step",
        label: "Access internal wiring",
        gate: "AND",
        access: 5,
        skill: 3,
        children: [
          { id: "ss1", kind: "substep", label: "Probe wiring", access: 4, skill: 3, children: [] },
          { id: "cm1", kind: "countermeasure", label: "Tamper seal", countermeasureRef: "CM1", children: [] },
        ],
      },
      {
        id: "s2",
        kind: "step",
        label: "Exploit update channel",
        gate: "AND",
        access: 3,
        skill: 4,
        children: [],
      },
    ],
  },
};

ok("root is a goal node", tree.root.kind === "goal");
ok("find locates a node", AtModel.find(tree.root, "ss1").label.includes("wiring"));
ok("parentOf is correct", AtModel.parentOf(tree.root, "ss1").id === "s1");
ok("parentOf root is null", AtModel.parentOf(tree.root, "g1") === null);

const t2 = JSON.parse(JSON.stringify(tree));
const child = AtModel.addChild(t2.root, "s1", "substep");
ok("addChild appends a kinded node under parent", child.kind === "substep" && AtModel.parentOf(t2.root, child.id).id === "s1");
const sib = AtModel.addSibling(t2.root, "ss1", "step");
ok("addSibling shares parent", AtModel.parentOf(t2.root, sib.id).id === "s1");
ok("addSibling on root returns null", AtModel.addSibling(t2.root, "g1", "step") === null);

const t3 = JSON.parse(JSON.stringify(tree));
ok("cycleGate OR->SAND", AtModel.cycleGate(t3.root, "g1") === "SAND");
ok("cycleGate on a defence node is null", AtModel.cycleGate(t3.root, "cm1") === null);
ok("setKind to countermeasure drops gate", (AtModel.setKind(t3.root, "s1", "countermeasure"), !AtModel.find(t3.root, "s1").gate));
const t3b = JSON.parse(JSON.stringify(tree));
ok("remove deletes a node", AtModel.remove(t3b.root, "ss1") === true && AtModel.find(t3b.root, "ss1") === null);
ok("remove root returns false", AtModel.remove(t3b.root, "g1") === false);

// deterministic metrics
const cmMap = { CM1: { status: "implemented" } };
const met = AtModel.evaluate(tree.root, cmMap);
ok("evaluate returns a probability in [0,1]", met.prob >= 0 && met.prob <= 1);
ok("evaluate derives required access from leaf attack steps", AtModel.evaluate(AtModel.find(tree.root, "s1"), cmMap).accessReq === 4);
ok("likelihoodFromProb maps to 1-5", AtModel.likelihoodFromProb(1) === 5 && AtModel.likelihoodFromProb(0.01) === 1);
ok("custom likelihood thresholds remap probability bands", AtModel.likelihoodFromProb(0.6, { 2: 0.2, 3: 0.4, 4: 0.6, 5: 0.8 }) === 4);

const all = (value) => ({ time: value, exploitability: value, window: value, detection: value, notoriety: value, prep: value, abort: value });
const structuralGoal = { id: "g", kind: "goal", label: "Goal", gate: "AND", children: [{ id: "s", kind: "step", label: "Unassessed", children: [] }] };
ok("goal and unassessed step contribute probability 1", AtModel.evaluate(structuralGoal, {}).prob === 1);
const andTree = { id: "g", kind: "goal", label: "Goal", gate: "AND", children: [{ id: "a", kind: "step", label: "A", cost: all(2), children: [] }, { id: "b", kind: "step", label: "B", cost: all(4), children: [] }] };
ok("AND multiplies sequential step probabilities", Math.abs(AtModel.evaluate(andTree, {}).prob - 0.32) < 1e-9);
const derivedParent = { id: "p", kind: "step", label: "Parent", cost: all(5), access: 5, skill: 5, children: [{ id: "c", kind: "substep", label: "Child", cost: all(2), access: 2, skill: 3, children: [] }] };
const derivedParentMetrics = AtModel.evaluate(derivedParent, {});
ok("non-leaf steps derive probability and requirements from child steps", derivedParentMetrics.prob === 0.8 && derivedParentMetrics.accessReq === 2 && derivedParentMetrics.skillReq === 3);
const legacyLevels = { id: "s", kind: "step", label: "Legacy", access: "local", skill: "expert", children: [] };
ok("legacy text access and skill do not poison aggregation", AtModel.evaluate(legacyLevels, {}).accessReq === 0 && AtModel.evaluate(legacyLevels, {}).skillReq === 0);
const categoryTree = { id: "c", kind: "category", label: "Alternatives", gate: "AND", children: [{ id: "a", kind: "step", label: "Easy", cost: all(1), children: [] }, { id: "b", kind: "step", label: "Hard", cost: all(5), children: [] }] };
ok("categories are OR containers regardless of stored gate", AtModel.evaluate(categoryTree, {}).prob === 1);
const orWithVulnerability = { id: "g", kind: "goal", label: "Goal", gate: "OR", children: [{ id: "likely", kind: "step", label: "Likely path", cost: all(2), children: [] }, { id: "unlikely", kind: "step", label: "Unlikely path", cost: all(5), children: [] }, { id: "v", kind: "vulnerability", label: "Low-probability vulnerability", residualCost: all(5), children: [] }] };
ok("a low vulnerability does not suppress the best OR path", AtModel.evaluate(orWithVulnerability, {}).prob === 0.8);
const orWithCriticalVulnerability = { id: "g", kind: "goal", label: "Goal", gate: "OR", children: [{ id: "likely", kind: "step", label: "Likely path", cost: all(2), children: [] }, { id: "v", kind: "vulnerability", label: "Critical vulnerability", residualCost: all(1), access: 1, skill: 1, children: [] }] };
ok("a critical vulnerability overrides lower OR paths", AtModel.evaluate(orWithCriticalVulnerability, {}).prob === 1);
const substepParent = { id: "s", kind: "substep", label: "Sub-step", children: [] };
ok("substeps cannot receive structural attack children", AtModel.addChild(substepParent, "s", "step") === null);
const residualTree = { id: "s", kind: "step", label: "Protected", cost: all(2), children: [{ id: "d", kind: "countermeasure", label: "Defence", residualCost: all(5), children: [] }, { id: "v", kind: "vulnerability", label: "Bypass", residualCost: all(1), skill: 4, access: 5, children: [] }] };
const residualMetrics = AtModel.evaluate(residualTree, {});
ok("vulnerability residual cost overrides defence residual cost", residualMetrics.prob === 1 && residualMetrics.skillReq === 4 && residualMetrics.accessReq === 5);
const defenceAssessment = { id: "d", kind: "countermeasure", label: "Defence", access: 4, skill: 3, residualCost: all(5), children: [] };
const defenceMetrics = AtModel.evaluate(defenceAssessment, {});
ok("defence residual assessment retains configured access and skill", defenceMetrics.prob === 0.2 && defenceMetrics.accessReq === 4 && defenceMetrics.skillReq === 3);

// Compare against the actual webapp evaluator without adding a runtime dependency to the model.
const esbuild = require(path.join(root, "vscode-extension/node_modules/esbuild"));
const referenceModule = { exports: {} };
require("node:vm").runInNewContext(esbuild.transformSync(
  fs.readFileSync(path.join(root, "webapp/client/src/lib/attackTree.ts"), "utf8"),
  { loader: "ts", format: "cjs" },
).code, { module: referenceModule });
const reference = referenceModule.exports;
const timeOnly = { ...all(0), time: 1 }, exploitOnly = { ...all(0), exploitability: 1 };
const weightCases = [undefined, null, {}, { time: 2 }, timeOnly, exploitOnly, all(0),
  all(-1), { time: -2, window: null, prep: undefined }, { time: "2", abort: "invalid" }];
const costCases = [undefined, null, {}, { time: 1 }, all(5), { time: -10, exploitability: 20 },
  { time: 2, window: null, prep: undefined }, { time: 2, detection: "4" }];
for (const weights of weightCases) {
  assert.strictEqual(AtModel.costWeightTotal(weights), reference.costWeightTotal(weights));
  assert.deepStrictEqual(AtModel.normalizedCostWeights(weights), { ...reference.normalizedCostWeights(weights) });
  for (const cost of costCases) {
    assert.strictEqual(AtModel.weightedCost(cost, weights), reference.weightedCost(cost, weights));
    if (cost && Object.values(cost).some((v) => typeof v === "number")) {
      assert.strictEqual(AtModel.stepProb(cost, weights), reference.stepProb(cost, weights));
    }
  }
}
ok("weight helpers match webapp defaults, normalization, zero/negative/nullish weights and cost clamps", true);
ok("public stepProb retains unassessed=1 while weightedCost uses default cost=3",
  AtModel.stepProb() === 1 && AtModel.stepProb({}) === 1 && Math.abs(AtModel.weightedCost() - 3) < 1e-9);

// Execute the actual calculator's pre-effect body and update callback, not copied formulas.
// Loud anchors deliberately fail if the source moves: the React auto-effect is NOT our read API.
const ThreatModel = require(path.join(root, "vscode-extension/media/threat-model.js"));
const vm = require("node:vm");
const calculatorSource = fs.readFileSync(path.join(root, "webapp/client/src/components/panels/RiskCalculator.tsx"), "utf8");
const calculatorStart = calculatorSource.indexOf("function CostRiskCalculator(");
const calculatorEnd = calculatorSource.indexOf("    useEffect(() => {", calculatorStart);
assert(calculatorStart >= 0 && calculatorEnd > calculatorStart, "CostRiskCalculator pre-effect anchors changed");
const calculatorBody = calculatorSource.slice(calculatorStart, calculatorEnd);
assert(calculatorBody.includes("const update = (patch: Partial<Threat>) => {") &&
  calculatorBody.includes("upd({ ...patch, status, costLikelihood:"), "CostRiskCalculator update anchor changed");
const calculatorModule = { exports: {} };
let calculatorState;
vm.runInNewContext(esbuild.transformSync(
  calculatorBody + "\nreturn { feasible, costProbability, probability, proposal, update };\n}\nexport { CostRiskCalculator };",
  { loader: "ts", format: "cjs" },
).code, {
  module: calculatorModule, useStore: (selector) => selector(calculatorState),
  stepProb: reference.stepProb, accessProbability: reference.accessProbability, likelihoodFromProb: reference.likelihoodFromProb,
});
function compareThreat(threat, patch, project, attacker, model = ThreatModel) {
  calculatorState = { data: { project: project || {}, assumptions: { attacker: attacker ? [attacker] : [] } } };
  let referencePatch;
  const expected = calculatorModule.exports.CostRiskCalculator({ t: threat, upd: (value) => { referencePatch = value; } });
  assert.deepStrictEqual({ ...model.calculate(threat, project, attacker) }, {
    feasible: expected.feasible, costProbability: expected.costProbability, probability: expected.probability, proposal: expected.proposal,
  });
  expected.update(patch);
  const updated = model.applyUpdate(threat, patch, project, attacker);
  assert.deepStrictEqual({ ...updated }, { ...threat, ...referencePatch });
  return updated;
}
for (const weights of weightCases) {
  for (const costFactors of costCases) {
    compareThreat({ costFactors }, {}, { costFactorWeights: weights });
    compareThreat({ costFactors }, { costFactors: {} }, { costFactorWeights: weights });
    compareThreat({}, { costFactors }, { costFactorWeights: weights });
  }
}
compareThreat({}, {});
ok("threat defaults, partial costs, edits/clears and zero/negative weights match actual webapp calculator", true);

const accessCases = [undefined, null, 0, -2, 1, 2.49, 2.5, 3, 4, 5, 6, NaN];
for (const accessProbabilities of [undefined, null, {}, { 1: 0, 2: -1, 3: 2, 4: null, 5: 0.275 }]) {
  for (const requiredAccess of accessCases) {
    assert.strictEqual(ThreatModel.accessProbability(requiredAccess, accessProbabilities),
      reference.accessProbability(requiredAccess, accessProbabilities));
    compareThreat({ requiredAccess }, {}, { accessProbabilities });
    compareThreat({ requiredAccess: 4 }, { requiredAccess }, { accessProbabilities });
  }
}
ok("access defaults, rounding, missing levels, nullish overrides and probability clamps match webapp", true);

for (const attacker of [undefined, null, { capability: 0 }, { capability: 1 }, { capability: 3 }, { capability: 5 }, {}]) {
  for (const status of [undefined, "open", "unfeasible", "mitigated", "accepted", "custom"]) {
    for (const requiredSkill of [undefined, null, 0, 1, 3, 4, 5]) {
      compareThreat({ status, requiredSkill }, {}, undefined, attacker);
      compareThreat({ status, requiredSkill: 4 }, { requiredSkill, status: "ignored-by-calculator" }, {}, attacker);
    }
  }
}
ok("capability equality/missing attacker, skill defaults, gating and all status transitions match webapp", true);

for (const thresholds of [undefined, {}, { 3: 0.45 }, { 2: 0.2, 3: 0.4, 4: 0.6, 5: 0.8 }]) {
  const boundaries = { ...reference.DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS, ...thresholds };
  for (const probability of [0, Number.EPSILON, ...Object.values(boundaries).flatMap((p) => [p - 1e-8, p, p + 1e-8])]) {
    assert.strictEqual(AtModel.likelihoodFromProb(probability, thresholds), reference.likelihoodFromProb(probability, thresholds));
    compareThreat({ costFactors: all(1), requiredAccess: 1 }, {}, {
      accessProbabilities: { 1: probability }, likelihoodProbabilityThresholds: thresholds,
    });
  }
  compareThreat({ requiredSkill: 5 }, {}, { likelihoodProbabilityThresholds: thresholds }, { capability: 1 });
}
ok("default, partial and configured thresholds match webapp below/at/above boundaries, including L0", true);

function freezeThreatInput(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeThreatInput);
    Object.freeze(value);
  }
  return value;
}
const savedThreat = freezeThreatInput({
  id: "T-model", likelihood: 5, costLikelihood: 0.123, costLikelihoodProposal: 1, status: "unfeasible",
  requiredSkill: 4, requiredAccess: 2, costFactors: { time: 5, vendor: { confidence: 0.8 } },
  costRationales: { time: "Slow", vendor: { review: "retained" } }, vendor: { tags: ["keep"] },
});
const savedSnapshot = JSON.stringify(savedThreat);
const savedProject = freezeThreatInput({ costFactorWeights: { time: 2 }, accessProbabilities: { 2: 0.8 } });
const savedAttacker = freezeThreatInput({ capability: 4 });
const emptyThreat = Object.freeze({});
ThreatModel.calculate(emptyThreat);
assert.deepStrictEqual(emptyThreat, {});
for (const likelihood of [0, 5]) {
  const manual = Object.freeze({ ...savedThreat, likelihood });
  ThreatModel.calculate(manual, savedProject, savedAttacker);
  assert.strictEqual(manual.likelihood, likelihood);
  assert.strictEqual(manual.costLikelihood, 0.123);
  assert.strictEqual(manual.costLikelihoodProposal, 1);
  assert.strictEqual(manual.status, "unfeasible");
}
const patches = [
  {}, { requiredAccess: 5 }, { requiredSkill: 5 }, { costFactors: { time: 1 } },
  { costFactors: {}, costRationales: {} }, { costRationales: { time: "" } },
  { costFactors: null, requiredSkill: null, requiredAccess: null },
  { costFactors: undefined, requiredSkill: undefined, requiredAccess: undefined },
  { requiredSkill: 0, requiredAccess: 0 }, { likelihood: 5, costLikelihood: 1, costLikelihoodProposal: 5 },
];
for (const patch of patches) {
  freezeThreatInput(patch);
  const updated = compareThreat(savedThreat, patch, savedProject, savedAttacker);
  assert.notStrictEqual(updated, savedThreat);
  assert.strictEqual(updated.vendor, savedThreat.vendor);
  if (!Object.hasOwn(patch, "costFactors")) assert.strictEqual(updated.costFactors, savedThreat.costFactors);
  if (!Object.hasOwn(patch, "costRationales")) assert.strictEqual(updated.costRationales, savedThreat.costRationales);
}
const cleared = ThreatModel.applyUpdate(savedThreat, { costFactors: {}, costRationales: {} });
assert.deepStrictEqual(cleared.costFactors, {});
assert.deepStrictEqual(cleared.costRationales, {});
assert.strictEqual(JSON.stringify(savedThreat), savedSnapshot);
const accepted = ThreatModel.applyUpdate(savedThreat, {}, savedProject, savedAttacker);
assert.strictEqual(accepted.likelihood, ThreatModel.calculate(savedThreat, savedProject, savedAttacker).proposal);
assert.notStrictEqual(accepted.likelihood, savedThreat.likelihood);
ok("reads preserve accepted likelihood/absent fields; explicit immutable updates retain metadata and honor clears/nullish patches", true);

const threatBrowser = { window: {} };
for (const filename of ["attacktree-model.js", "threat-model.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, "vscode-extension/media", filename), "utf8"), threatBrowser);
}
for (const patch of patches) compareThreat(savedThreat, patch, savedProject, savedAttacker, threatBrowser.window.ThreatModel);
for (const weights of weightCases) {
  for (const costFactors of costCases) compareThreat({ costFactors }, {}, { costFactorWeights: weights }, undefined, threatBrowser.window.ThreatModel);
}
for (const access of accessCases) {
  assert.strictEqual(threatBrowser.window.ThreatModel.accessProbability(access), ThreatModel.accessProbability(access));
}
ok("browser script-order API and CommonJS threat model both match the actual webapp", true);

const weightedA = { id: "a", kind: "step", cost: { time: 1, exploitability: 5 }, skill: 5, access: 1 };
const weightedB = { id: "b", kind: "substep", cost: { time: 5, exploitability: 1 }, skill: 1, access: 5 };
const weightedDefs = [weightedA, weightedB].map((n) => ({ ...n, kind: "countermeasure", residualCost: n.cost }));
const weightedVulns = [weightedA, weightedB].map((n) => ({ ...n, kind: "vulnerability", residualCost: n.cost }));
const weightedOr = { kind: "goal", gate: "OR", children: [weightedA, weightedB] };
const weightedResidual = { ...weightedA, children: [...weightedDefs, ...weightedVulns] };
const parityTrees = [
  structuralGoal, derivedParent, legacyLevels, weightedA, weightedB, defenceAssessment,
  ...costCases.map((cost) => ({ ...weightedA, cost })),
  ...["AND", "SAND", "OR"].map((gate) => ({ kind: "goal", gate, children: [weightedOr, weightedB] })),
  weightedOr, { ...weightedOr, kind: "category", gate: "AND" },
  { ...weightedOr, children: [weightedB, weightedVulns[0]] },
  { ...weightedOr, children: [weightedA, { kind: "vulnerability" }] },
  { ...weightedA, children: weightedDefs }, weightedResidual,
  { ...weightedA, children: [weightedVulns[1], { ...weightedVulns[1], skill: 4, access: 2 }] },
  ...["proposed", "planned", "implemented", "verified", "unknown", undefined].map((status) => ({
    ...weightedResidual, children: [...weightedResidual.children,
      { kind: "countermeasure", countermeasureRef: status }, { kind: "vulnerability" }],
  })),
];
const statuses = Object.fromEntries(["proposed", "planned", "implemented", "verified", "unknown"].map((status) => [status, { status }]));
for (const weights of weightCases) {
  for (const node of parityTrees) {
    assert.deepStrictEqual(AtModel.evaluate(node, statuses, weights),
      { ...reference.evaluate(node, new Map(Object.entries(statuses)), weights) },
      `evaluation parity: ${JSON.stringify({ node, weights })}`);
  }
}
ok("weighted evaluation matches webapp gates, recursive paths, residual min/max, ties and legacy modifiers", true);
assert.deepStrictEqual(AtModel.evaluate(weightedOr, {}, timeOnly),
  { prob: 1, skillReq: 5, accessReq: 1, defenses: 0, vulns: 0 });
assert.deepStrictEqual(AtModel.evaluate(weightedOr, {}, exploitOnly),
  { prob: 1, skillReq: 1, accessReq: 5, defenses: 0, vulns: 0 });
ok("OR selects both axes from the weighted winning path and keeps first path on ties",
  AtModel.evaluate(weightedOr, {}, all(0)).skillReq === 5);

const aggregationFixture = JSON.parse(fs.readFileSync(path.join(root, "tools/fixtures/attack-tree-aggregation.json"), "utf8"));
const aggregationById = Object.fromEntries(aggregationFixture.trees.map((fixture) => [fixture.id, fixture]));
const fixtureOr = AtModel.evaluate(aggregationById["AT-TEST-OR"].root, {});
ok("fixture OR chooses critical vulnerability vector", fixtureOr.prob === 1 && fixtureOr.accessReq === 1 && fixtureOr.skillReq === 1);
const fixtureAnd = AtModel.evaluate(aggregationById["AT-TEST-AND"].root, {});
ok("fixture AND multiplies and takes max requirements", Math.abs(fixtureAnd.prob - 0.32) < 1e-9 && fixtureAnd.accessReq === 4 && fixtureAnd.skillReq === 3);
const fixtureSand = AtModel.evaluate(aggregationById["AT-TEST-SAND"].root, {});
ok("fixture SAND multiplies and takes max requirements", Math.abs(fixtureSand.prob - 0.32) < 1e-9 && fixtureSand.accessReq === 5 && fixtureSand.skillReq === 5);
const fixtureResidual = AtModel.evaluate(aggregationById["AT-TEST-RESIDUAL"].root, {});
ok("fixture vulnerability overrides defence residual at leaf step", fixtureResidual.prob === 1 && fixtureResidual.accessReq === 5 && fixtureResidual.skillReq === 4);

const html = AtModel.toHtml(tree.root);
ok("toHtml nests gates", html.includes("[OR]") && html.includes("[AND]"));
const r = AtModel.render(tree, "s1");
ok("render returns sized svg", r.width > 0 && r.height > 0 && r.svg.includes("data-id='s1'"));
ok("render shows gate label", r.svg.includes(">OR<") || r.svg.includes(">AND<"));

/* ---------- Attack tree threat links (threatRefs[] preferred, threatRef legacy) ---------- */
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok("threatRefsOf threatRefs only", sameList(AtModel.threatRefsOf({ threatRefs: ["T1", "T2"] }), ["T1", "T2"]));
ok("threatRefsOf legacy threatRef only", sameList(AtModel.threatRefsOf({ threatRef: "T3" }), ["T3"]));
ok("threatRefsOf unions threatRefs with a threatRef not already listed", sameList(AtModel.threatRefsOf({ threatRefs: ["T1", "T2"], threatRef: "T9" }), ["T1", "T2", "T9"]));
ok("threatRefsOf does not duplicate a threatRef already in threatRefs", sameList(AtModel.threatRefsOf({ threatRefs: ["T1", "T2"], threatRef: "T2" }), ["T1", "T2"]));
ok("threatRefsOf includes threatRef when threatRefs is empty", sameList(AtModel.threatRefsOf({ threatRefs: [], threatRef: "T3" }), ["T3"]));
ok("threatRefsOf de-duplicates", sameList(AtModel.threatRefsOf({ threatRefs: ["T1", "T2", "T1", "T2"] }), ["T1", "T2"]));
ok("threatRefsOf neither set", sameList(AtModel.threatRefsOf({ id: "AT1" }), []) && sameList(AtModel.threatRefsOf({ threatRef: "" }), []) && sameList(AtModel.threatRefsOf(null), []));
const linkTree = { id: "AT1", threatRef: "T1", threatRefs: ["T1", "T2"], root: { id: "g", kind: "goal", label: "g", children: [] } };
AtModel.setThreatRefs(linkTree, ["T2", "T3", "T2"]);
ok("setThreatRefs writes threatRefs and syncs threatRef to the first link", sameList(linkTree.threatRefs, ["T2", "T3"]) && linkTree.threatRef === "T2");
AtModel.addChild(linkTree.root, "g", "step");
ok("editing tree nodes preserves threat links", sameList(AtModel.threatRefsOf(linkTree), ["T2", "T3"]));
AtModel.setThreatRefs(linkTree, []);
ok("setThreatRefs with no links keeps empty threatRefs and removes threatRef", sameList(linkTree.threatRefs, []) && !("threatRef" in linkTree));

/* ---------- Risk model ---------- */
ok("band Low", RiskModel.band(3, null).name === "Low");
ok("band High", RiskModel.band(16, null).name === "High");
ok("band Critical", RiskModel.band(25, null).name === "Critical");
ok("deriveImpact is Bug Bar max(C/I/A/S)", RiskModel.deriveImpact({ confidentiality: 1, integrity: 5, availability: 3, safety: 2 }) === 5);
ok("deriveLikelihood geo-mean diagonal", RiskModel.deriveLikelihood({ exposure: 3, exploitability: 3 }) === 3);
ok("deriveLikelihood clamps to 5", RiskModel.deriveLikelihood({ exposure: 5, exploitability: 5 }) === 5);
const rTh = { id: "T1", likelihood: 4, impact: 4 };
const rCms = [
  { id: "A", addresses: [{ threat: "T1", residualLikelihood: 2, residualImpact: 4 }] },
  { id: "B", addresses: [{ threat: "T1", residualLikelihood: 1, residualImpact: 5 }] },
];
const rr = RiskModel.riskOf(rTh, rCms, null);
ok("initial risk 16 High", rr.initial === 16 && rr.initialBand.name === "High");
ok("residual is per-axis minimum across controls (1×4=4)", rr.residual === 4 && rr.residualLikelihood === 1 && rr.residualImpact === 4 && rr.residualBand.name === "Low");
ok("no countermeasure ⇒ residual = initial", RiskModel.riskOf(rTh, [], null).residual === 16);
const rDeselected = RiskModel.riskOf(rTh, [rCms[0], { id: "C", selected: false, addresses: [{ threat: "T1", residualLikelihood: 1, residualImpact: 1 }] }], null);
ok("selected:false countermeasure is skipped", rDeselected.residualLikelihood === 2 && rDeselected.residualImpact === 4 && rDeselected.residual === 8);
const rUnfeasible = RiskModel.riskOf({ id: "T1", likelihood: 4, impact: 4, status: "unfeasible" }, rCms, null);
ok("unfeasible ⇒ initial 0 and residual 0/0", rUnfeasible.initial === 0 && rUnfeasible.residual === 0 && rUnfeasible.residualLikelihood === 0 && rUnfeasible.residualImpact === 0 && rUnfeasible.initialBand.name === "None");
ok("band(0) is None", RiskModel.band(0, null).name === "None");

/* ---------- Threat schema: cost-based feasibility includes unfeasible L0 ---------- */
const Ajv2020 = require(path.join(root, "vscode-extension/node_modules/ajv/dist/2020"));
const threatSchema = JSON.parse(fs.readFileSync(path.join(root, "vscode-extension/runtime/.assets/schema/threats.schema.json"), "utf8"));
const validateThreats = new Ajv2020().compile(threatSchema);
const schemaThreat = { id: "T-SCHEMA", title: "Schema boundary", stride: ["S"], components: ["C1"], likelihood: 1, impact: 3 };
for (const likelihood of [0, 1, 2, 3, 4, 5]) {
  ok("threat schema accepts likelihood " + likelihood,
    validateThreats({ threats: [{ ...schemaThreat, likelihood }] }));
}
for (const likelihood of [-1, 6, 1.5, "0", null]) {
  ok("threat schema rejects likelihood " + JSON.stringify(likelihood),
    !validateThreats({ threats: [{ ...schemaThreat, likelihood }] }));
  assert.ok(validateThreats.errors.some((error) => error.instancePath === "/threats/0/likelihood"));
}
for (const status of ["open", "mitigated", "accepted", "transferred", "unfeasible"]) {
  ok("threat schema accepts status " + status,
    validateThreats({ threats: [{ ...schemaThreat, status, likelihood: status === "unfeasible" ? 0 : 3 }] }));
}
ok("threat schema still rejects unknown status",
  !validateThreats({ threats: [{ ...schemaThreat, status: "unknown" }] }));
ok("threat schema still requires likelihood",
  !validateThreats({ threats: [{ ...schemaThreat, likelihood: undefined }] }));

/* ---------- Bundled knowledge-base drift (extension runtime vs webapp) ---------- */
["risk-scheme.json", "bug-bar.json", "field-device-library.json"].forEach((file) => {
  const webappFile = path.join(root, "webapp/.assets/knowledge-base", file);
  const extFile = path.join(root, "vscode-extension/runtime/.assets/knowledge-base", file);
  const inSync = fs.existsSync(extFile) && fs.readFileSync(webappFile).equals(fs.readFileSync(extFile));
  ok("bundled knowledge-base " + file + " drifted from webapp copy; re-sync with: cp webapp/.assets/knowledge-base/" + file + " vscode-extension/runtime/.assets/knowledge-base/" + file, inSync);
});

/* ---------- Parity with webapp/server/src/risk.js (ESM) ---------- */
async function checkWebappParity() {
  const { pathToFileURL } = require("node:url");
  const webappRisk = await import(pathToFileURL(path.join(root, "webapp/server/src/risk.js")).href);
  const scheme = JSON.parse(fs.readFileSync(path.join(root, "webapp/.assets/knowledge-base/risk-scheme.json"), "utf8"));
  const threats = [
    { id: "P1", likelihood: 4, impact: 4 },
    { id: "P2", likelihood: 5, impact: 3 },
    { id: "P3", likelihood: 3, impact: 5, status: "unfeasible" },
    { id: "P4", likelihood: 2, impact: 2 },
    { id: "P5", likelihood: 5, impact: 5 },
  ];
  const cms = [
    { id: "CA", addresses: [{ threat: "P1", residualLikelihood: 2, residualImpact: 4 }, { threat: "P2", residualImpact: 2 }] },
    { id: "CB", addresses: [{ threat: "P1", residualLikelihood: 1, residualImpact: 5 }, { threat: "P3", residualLikelihood: 1, residualImpact: 1 }] },
    { id: "CC", selected: false, addresses: [{ threat: "P1", residualLikelihood: 1, residualImpact: 1 }, { threat: "P5", residualLikelihood: 1, residualImpact: 1 }] },
    { id: "CD", addresses: [{ threat: "P5" }] },
  ];
  const webapp = webappRisk.computeRisk(scheme, threats, cms);
  threats.forEach((t, i) => {
    const ext = RiskModel.riskOf(t, cms, scheme);
    const web = webapp[i];
    // webapp/server computeRisk does not zero the initial risk of unfeasible threats (the client's riskOf does),
    // so initial parity is only checked for feasible threats; RiskModel follows the client.
    if (t.status !== "unfeasible") {
      ok("parity initial " + t.id, ext.initial === web.initial && ext.initialBand.name === web.initialBand.name);
    }
    ok("parity residual " + t.id, ext.residual === web.residual && ext.residualBand.name === web.residualBand.name);
    ok("parity residual L/I " + t.id, ext.residualLikelihood === web.residualLikelihood && ext.residualImpact === web.residualImpact);
  });
}

checkWebappParity()
  .then(() => console.log("All " + passed + " model assertions passed."))
  .catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
