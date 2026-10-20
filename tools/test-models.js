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

const d3 = JSON.parse(JSON.stringify(dfd));
DfdModel.deleteNode(d3, "N-DEV");
ok("delete removes node + descendants", !d3.nodes.some((n) => ["N-DEV", "N-MCU", "N-BT", "N-HART", "N-CFG", "TB-CORE"].includes(n.id)));
ok("delete removes flows touching removed nodes", !d3.flows.some((f) => ["N-DEV", "N-MCU", "N-CFG"].includes(f.from) || ["N-DEV", "N-MCU"].includes(f.to)));
ok("delete cleans trust-boundary members", d3.nodes.filter((n) => n.id === "TB-ENC").every((tb) => !(tb.members || []).includes("N-DEV")));

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
ok("residual is single most-protective control (5), not min×min (4)", rr.residual === 5 && rr.residualLikelihood === 1 && rr.residualImpact === 5);
ok("no countermeasure ⇒ residual = initial", RiskModel.riskOf(rTh, [], null).residual === 16);

console.log("All " + passed + " model assertions passed.");
