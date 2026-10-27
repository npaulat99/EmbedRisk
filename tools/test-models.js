// Unit tests for the isomorphic webview models (no VS Code needed). Run: node tools/test-models.js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const DfdModel = require(path.join(root, "vscode-extension/media/dfd-model.js"));
const AtModel = require(path.join(root, "vscode-extension/media/attacktree-model.js"));
const RiskModel = require(path.join(root, "vscode-extension/media/risk-model.js"));
const LayerVisibilityModel = require(path.join(root, "vscode-extension/media/layer-visibility.js"));
const DfdOverviewModel = require(path.join(root, "vscode-extension/media/dfd-overview-model.js"));
const DfdEngine = require(path.join(root, "vscode-extension/media/dfd-engine.js"));
const StrideModel = require(path.join(root, "vscode-extension/media/stride-model.js"));
const ImportedKb = require(path.join(root, "vscode-extension/media/imported-kb.js"));

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

async function runImportedKbTests() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "vscode-extension/package.json"), "utf8"));
  const extensionSource = fs.readFileSync(path.join(root, "vscode-extension/src/extension.ts"), "utf8");
  ok("imported knowledge-base removal command is contributed and registered",
    packageJson.contributes.commands.some((item) => item.command === "embedrisk.kbRemove")
      && extensionSource.includes('registerCommand("embedrisk.kbRemove"'));

  const rootPath = path.join(os.tmpdir(), "embedrisk-imported-kbs");
  const listed = [
    { name: "catalogue-one", isDirectory: true, isSymbolicLink: false },
    { name: "regular-file", isDirectory: false, isSymbolicLink: false },
    { name: "linked-catalogue", isDirectory: true, isSymbolicLink: true },
  ];
  const removed = [];
  let confirmed = 0;
  const io = {
    list: async () => listed,
    choose: async (names) => { assert.deepStrictEqual(names, ["catalogue-one"]); return names[0]; },
    confirm: async () => { confirmed++; return true; },
    remove: async (target) => removed.push(target),
  };
  const result = await ImportedKb.removeImportedCatalogue(rootPath, io);
  ok("removal offers only non-symlink directories and deletes the selected child after confirmation",
    result.status === "removed" && result.name === "catalogue-one" && confirmed === 1
      && removed.length === 1 && removed[0] === path.join(rootPath, "catalogue-one"));

  let deleteCalls = 0;
  const cancel = await ImportedKb.removeImportedCatalogue(rootPath, {
    ...io, choose: async () => "catalogue-one", confirm: async () => false,
    remove: async () => { deleteCalls++; },
  });
  ok("removal cancellation leaves the catalogue untouched", cancel.status === "cancelled" && deleteCalls === 0);

  const empty = await ImportedKb.removeImportedCatalogue(rootPath, {
    ...io, list: async () => [{ name: "file", isDirectory: false, isSymbolicLink: false }],
  });
  ok("removal reports an empty catalogue list when no directories are present", empty.status === "empty");

  await assert.rejects(() => ImportedKb.removeImportedCatalogue(rootPath, {
    ...io, choose: async () => "../outside",
    remove: async () => { deleteCalls++; },
  }), /no longer available/);
  await assert.rejects(() => ImportedKb.removeImportedCatalogue(rootPath, {
    ...io, list: async () => [{ name: "../outside", isDirectory: true, isSymbolicLink: false }],
    choose: async () => "../outside",
    remove: async () => { deleteCalls++; },
  }), /outside the imported/);
  await assert.rejects(() => ImportedKb.removeImportedCatalogue(rootPath, {
    ...io, list: async () => [{ name: "..", isDirectory: true, isSymbolicLink: false }],
    choose: async () => "..",
    remove: async () => { deleteCalls++; },
  }), /outside the imported/);
  ok("removal rejects stale or traversing selections without deleting outside the imported root", deleteCalls === 0);
}

/* ---------- Getting-started walkthrough (EXT-W1) ---------- */
{
  const extDir = path.join(root, "vscode-extension");
  const packageJson = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
  const extensionSource = fs.readFileSync(path.join(extDir, "src/extension.ts"), "utf8");
  const walkthroughId = `${packageJson.publisher}.${packageJson.name}#embedrisk.gettingStarted`;
  ok("getting-started command is contributed and opens the contributed walkthrough",
    packageJson.contributes.commands.some((item) => item.command === "embedrisk.gettingStarted")
      && extensionSource.includes('registerCommand("embedrisk.gettingStarted"')
      && extensionSource.includes(`"workbench.action.openWalkthrough", "${walkthroughId}"`));
  const walkthrough = (packageJson.contributes.walkthroughs || []).find((item) => item.id === "embedrisk.gettingStarted");
  ok("getting-started walkthrough is contributed", !!walkthrough && walkthrough.title && walkthrough.description);
  const stepIds = walkthrough.steps.map((step) => step.id);
  ok("walkthrough covers setup, navigation, DFD, STRIDE, risk, reports and settings",
    JSON.stringify(stepIds) === JSON.stringify(["project", "navigation", "dfd", "threats", "risk", "reports", "settings"]));
  const contributed = new Set(packageJson.contributes.commands.map((item) => item.command));
  const pages = [];
  for (const step of walkthrough.steps) {
    ok(`walkthrough step ${step.id} has a title and markdown media`, step.title && step.description && step.media && step.media.markdown);
    const mdPath = path.resolve(extDir, step.media.markdown);
    ok(`walkthrough step ${step.id} markdown is a bundled file inside the extension`,
      mdPath.startsWith(path.join(extDir, "media", "walkthrough") + path.sep) && fs.existsSync(mdPath));
    const md = fs.readFileSync(mdPath, "utf8");
    pages.push(md);
    ok(`walkthrough page ${step.id} is self-contained (heading, no remote links, images or HTML)`,
      /^# \S/.test(md) && !/https?:\/\/|!\[|<[a-z!/]/i.test(md));
    for (const [, cmd] of step.description.matchAll(/\(command:([\w.]+)/g)) {
      ok(`walkthrough step ${step.id} links to a known command (${cmd})`, contributed.has(cmd) || cmd.startsWith("workbench."));
    }
    for (const event of step.completionEvents || []) {
      const [kind, value] = event.split(":");
      ok(`walkthrough step ${step.id} completion event ${event} is valid`,
        (kind === "onCommand" && contributed.has(value)) || (kind === "onSettingChanged" && packageJson.contributes.configuration.properties[value]));
    }
  }
  const text = pages.join("\n");
  for (const topic of ["New Project", "guided wizard", "trust boundar", "Spoofing", "Elevation of privilege", "likelihood × impact", "countermeasures", "Problems", "Generate report", "SBOM", "embedrisk.project"]) {
    ok(`walkthrough content explains ${topic}`, text.includes(topic));
  }
  ok("walkthrough markdown is not packaged-out", !fs.readFileSync(path.join(extDir, ".vscodeignore"), "utf8").includes("media/walkthrough"));
}

/* ---------- Extension report exports ---------- */
{
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "vscode-extension/package.json"), "utf8"));
  const extensionSource = fs.readFileSync(path.join(root, "vscode-extension/src/extension.ts"), "utf8");
  for (const command of ["embedrisk.exportTraceabilityCsv", "embedrisk.exportTraceabilityJson", "embedrisk.exportSbom"]) {
    ok(`report export command ${command} is contributed and registered`,
      packageJson.contributes.commands.some((item) => item.command === command)
        && extensionSource.includes(`registerCommand("${command}"`));
  }

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedrisk-exports-"));
  const put = (file, value) => {
    const target = path.join(projectDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
  };
  const inputs = {
    "01-project-description/project.json": { projectId: "test-project", title: "Test", customUnknownKey: { keep: true } },
    "02-assumptions/assumptions.json": { device: [], system: [], environment: [], operational: [], attacker: [] },
    "03-system-assets/system.json": {
      assets: [{ id: "A-1", name: "Asset", objectives: { confidentiality: 2, integrity: 3, availability: 4, safety: 1 } }],
      components: [{ id: "C-1", kind: "hardware", name: "Controller" }],
    },
    "06-threats/threats.json": { threats: [{
      id: "T-1", title: 'Threat "quoted"\nline', assets: ["A-1"], components: ["C-1"], stride: ["E", "S"],
      likelihood: 2, impact: 3, assumptionRefs: ["AS-1"], likelihoodRationale: 'because "yes"\nnext',
      status: "accepted", ratedBy: "Reviewer", acceptedBy: "Approver", acceptanceRationale: "accepted",
    }] },
    "05-requirements/requirements.json": { requirements: [{ id: "R-1", standardRef: "IEC 1", derivedFromThreat: ["T-1"], satisfiedByCM: ["CM-1"] }] },
    "08-countermeasures/countermeasures.json": { countermeasures: [{
      id: "CM-1", status: "implemented", addresses: [{ threat: "T-1", residualLikelihood: 1, residualImpact: 2 }],
      ticketUrls: ["https://example.invalid/ticket"],
    }] },
  };
  try {
    Object.entries(inputs).forEach(([file, value]) => put(file, value));
    const sourceSnapshot = Object.fromEntries(Object.keys(inputs).map((file) => [file, fs.readFileSync(path.join(projectDir, file), "utf8")]));
    const generator = path.join(root, "vscode-extension/runtime/tools/generate-report.mjs");
    const run = () => execFileSync(process.execPath, [generator, projectDir], { cwd: path.dirname(generator), stdio: "ignore" });
    run();
    const reportDir = path.join(projectDir, "report");
    const trace = JSON.parse(fs.readFileSync(path.join(reportDir, "traceability.json"), "utf8"));
    ok("traceability JSON matches webapp field order and derived values",
      Object.keys(trace[0]).join(",") === "asset,cias,threat,title,stride,assumptionRefs,likelihoodRationale,impactRationale,initial,initialBand,requirement,control,residual,residualBand,evidence,status,ratedBy,signoff"
        && trace[0].stride === "SE" && trace[0].initial === 6 && trace[0].residual === 2
        && trace[0].requirement === "R-1 [IEC 1] → CM-1" && trace[0].signoff === "by Approver · accepted");
    const csv = fs.readFileSync(path.join(reportDir, "traceability.csv"), "utf8");
    ok("traceability CSV preserves schema and quotes embedded quotes/newlines",
      csv.startsWith('"Asset","C/I/A/S","Threat","Title","STRIDE","Assumptions"')
        && csv.includes('"Threat ""quoted""\nline"') && csv.includes('"L: because ""yes""\nnext"') && csv.endsWith("\r\n"));
    ok("CycloneDX is selected by default and source project files are unchanged",
      fs.existsSync(path.join(reportDir, "sbom.cdx.json"))
        && !fs.existsSync(path.join(reportDir, "sbom.spdx.json"))
        && Object.entries(sourceSnapshot).every(([file, value]) => fs.readFileSync(path.join(projectDir, file), "utf8") === value));
    put("01-project-description/project.json", { ...inputs["01-project-description/project.json"], sbom: { mode: "in-tool", format: "spdx" } });
    run();
    ok("SPDX selection emits only the selected SBOM file",
      fs.existsSync(path.join(reportDir, "sbom.spdx.json")) && !fs.existsSync(path.join(reportDir, "sbom.cdx.json")));
    put("01-project-description/project.json", { ...inputs["01-project-description/project.json"], sbom: { mode: "external", url: "https://example.invalid/sbom" } });
    run();
    ok("external SBOM mode emits no SBOM while retaining traceability",
      !fs.existsSync(path.join(reportDir, "sbom.cdx.json")) && !fs.existsSync(path.join(reportDir, "sbom.spdx.json"))
        && fs.existsSync(path.join(reportDir, "traceability.csv")) && fs.existsSync(path.join(reportDir, "traceability.json")));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

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

/* ---------- Read-only matrix against the actual webapp client risk engine ---------- */
const clientRiskModule = { exports: {} };
require("node:vm").runInNewContext(esbuild.transformSync(
  fs.readFileSync(path.join(root, "webapp/client/src/lib/risk.ts"), "utf8"),
  { loader: "ts", format: "cjs" },
).code, { module: clientRiskModule });
const clientRisk = clientRiskModule.exports;
const matrixThreats = freezeThreatInput([
  { id: "M", likelihood: 5, impact: 5, future: { keep: ["metadata"] } },
  ...[[0, 4], [4, 0], [6, 4], [1.5, 4], [3, 2]].map(([likelihood, impact], n) => ({ id: "E" + n, likelihood, impact })),
  { id: "U", likelihood: 5, impact: 5, status: "unfeasible" },
]);
const matrixCms = freezeThreatInput([
  { addresses: [{ threat: "M", residualLikelihood: 2 }] },
  { addresses: [{ threat: "M", residualImpact: 3 }] },
  { selected: false, addresses: [{ threat: "M", residualLikelihood: 0, residualImpact: 0 }] },
]);
const matrixBefore = JSON.stringify([matrixThreats, matrixCms]);
for (const scheme of [null, { matrix: { bands: [] } }, freezeThreatInput({ matrix: { bands: [{ name: '<Custom & "band">', min: 1, max: 25, color: "#123456" }] } })]) {
  for (const threshold of [undefined, 0, 6, 12, 25]) for (const mode of [undefined, "initial", "residual"]) {
    const m = RiskModel.matrix(matrixThreats, matrixCms, scheme, threshold, mode), limit = threshold ?? 12;
    assert.strictEqual(m.cells.length, 25);
    assert.strictEqual(m.threshold, limit);
    assert.strictEqual(JSON.stringify(m.bands), JSON.stringify(clientRisk.bandsOf(scheme)));
    m.cells.forEach((c, n) => {
      const l = n % 5 + 1, i = 5 - Math.floor(n / 5);
      assert.deepStrictEqual([c.likelihood, c.impact, c.score], [l, i, l * i]);
      assert.strictEqual(JSON.stringify(c.band), JSON.stringify(clientRisk.band(l * i, scheme)));
      assert.deepStrictEqual(c.ids, matrixThreats.filter((t) => {
        const r = clientRisk.riskOf(t, matrixCms, scheme);
        return t.status !== "unfeasible" && (mode === "initial" ? t.likelihood === l && t.impact === i : r.residualLikelihood === l && r.residualImpact === i);
      }).map((t) => t.id));
      assert.strictEqual(c.boundaryTop, i < 5 && (l * i <= limit) !== (l * (i + 1) <= limit));
      assert.strictEqual(c.boundaryRight, l < 5 && (l * i <= limit) !== ((l + 1) * i <= limit));
    });
  }
}
ok("matrix: 25 oriented cells, client parity, modes, bands, thresholds and off-grid exclusions", true);
ok("matrix: frozen threats/controls and unknown metadata remain unchanged", JSON.stringify([matrixThreats, matrixCms]) === matrixBefore);

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

function runDfdEngineTests() {
  const vm = require("node:vm");
  const esbuild = require(path.join(root, "vscode-extension/node_modules/esbuild"));
  const webModule = { exports: {} };
  const source = fs.readFileSync(path.join(root, "webapp/shared/dfdEngine.js"), "utf8");
  vm.runInNewContext(esbuild.transformSync(source, { format: "cjs" }).code, { module: webModule });
  const web = webModule.exports;
  const browser = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "vscode-extension/media/dfd-engine.js"), "utf8"), browser);
  ok("DFD engine browser global exposes API", browser.window.DfdEngine &&
    Object.keys(browser.window.DfdEngine).join(",") === Object.keys(DfdEngine).join(","));

  const obstacles = [{ x: 40, y: -10, w: 20, h: 20 }, { x: 70, y: 25, w: 15, h: 15 }];
  const vectors = [
    ["routeAround", [0, 0, 100, 0, obstacles, 5]],
    ["routeAround", [10, 80, 90, -20, [{ x: 35, y: 20, w: 30, h: 25 }], 4]],
    ["routeAround", [0, 0, 100, 0, obstacles, 5, 5]],
    ["roundedPath", [[[0, 0], [30, 0]], 8]],
    ["roundedPath", [[[0, 0], [30, 0], [30, 40], [50, 40]], 8]],
    ["labelPtOnPolyline", [[[0, 0], [30, 0], [30, 40]]]],
    ["labelPtOnPolyline", [[[0, 0], [0, 0], [15, 0]]]],
    ["borderPoint", [{ x: 10, y: 20, w: 40, h: 20 }, 100, 30]],
    ["borderPoint", [{ x: 10, y: 20, w: 40, h: 20 }, 30, 30]],
  ];
  for (const [name, args] of vectors) {
    const before = JSON.stringify(args);
    const actual = DfdEngine[name](...args);
    const expected = web[name](...args);
    ok("DFD engine parity " + name, JSON.stringify(actual) === JSON.stringify(expected));
    ok("DFD engine does not mutate inputs " + name, JSON.stringify(args) === before);
  }
}

function runStrideTests() {
  const { boundaryPairs, analysisHasContent, anyPairHasContent, STRIDE_KEYS, STRIDE_LABEL } = StrideModel;
  // Execute the actual webapp TypeScript after stripping types, rather than mirroring its rules here.
  const vm = require("node:vm");
  const esbuild = require(path.join(root, "vscode-extension/node_modules/esbuild"));
  const ts = fs.readFileSync(path.join(root, "webapp/client/src/lib/stride.ts"), "utf8");
  const webModule = { exports: {} };
  vm.runInNewContext(esbuild.transformSync(ts, { loader: "ts", format: "cjs" }).code, { module: webModule });
  const webStride = webModule.exports;
  const browser = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "vscode-extension/media/stride-model.js"), "utf8"), browser);
  ok("stride browser global exposes API", browser.window.StrideModel &&
    Object.keys(browser.window.StrideModel).join(",") === Object.keys(StrideModel).join(","));
  ok("stride keys and labels match webapp", JSON.stringify([STRIDE_KEYS, STRIDE_LABEL]) ===
    JSON.stringify([webStride.STRIDE_KEYS, webStride.STRIDE_LABEL]));
  ok("stride keys order", STRIDE_KEYS.join("") === "STRIDE");
  ok("stride labels", STRIDE_LABEL.S === "Spoofing" && STRIDE_LABEL.I === "Information disclosure" && STRIDE_LABEL.E === "Elevation of privilege");
  // Inside set of "tb" = dev (member) + sub (descendant of dev) + deep (descendant of sub).
  const dfd = {
    nodes: [
      { id: "tb", type: "trust-boundary", members: ["dev"] },
      { id: "dev", label: "Device", componentRef: "c-dev" },
      { id: "sub", label: "Sub", parent: "dev" },
      { id: "deep", label: "", parent: "sub" },
      { id: "cloud", label: "Cloud", componentRef: "c-cloud" },
      { id: "other", label: "Other" },
    ],
    flows: [
      { from: "sub", to: "cloud" },     // crossing, inside->outside
      { from: "cloud", to: "sub" },     // reverse duplicate, deduped
      { from: "dev", to: "sub" },       // internal only
      { from: "cloud", to: "other" },   // external only
      { from: "", to: "cloud" },        // missing endpoint
      { from: "if-dev", to: "other" },  // interface endpoint inside via component c-dev -> dev
      { from: "cloud", to: "if-x" },    // if-x component has no DFD node: outside, so external only
      { from: "other", to: "deep" },    // crossing, outside->inside; empty label kept by ??
    ],
  };
  const system = { interfaces: [{ id: "if-dev", name: "BLE", component: "c-dev" }, { id: "if-x", name: "Nameless", component: "c-none" }] };
  const pairs = boundaryPairs(system, dfd, "tb");
  ok("stride crossing pairs match webapp", JSON.stringify(pairs) === JSON.stringify(webStride.boundaryPairs(system, dfd, "tb")));
  ok("stride pair count", pairs.length === 3);
  ok("stride nested member pair", pairs[0].key === "cloud~sub" && pairs[0].inside.id === "sub" && pairs[0].outside.id === "cloud");
  ok("stride node labels", pairs[0].inside.label === "Sub" && pairs[0].outside.label === "Cloud");
  ok("stride interface endpoint inside", pairs[1].key === "if-dev~other" && pairs[1].inside.id === "if-dev" && pairs[1].outside.id === "other");
  ok("stride interface label fallback to name", pairs[1].inside.label === "BLE" && pairs[1].outside.label === "Other");
  ok("stride to-side inside orientation", pairs[2].key === "deep~other" && pairs[2].inside.id === "deep" && pairs[2].outside.id === "other");
  ok("stride empty-string label kept (??)", pairs[2].inside.label === "");
  ok("stride unresolved interface not a crossing", !pairs.some((p) => p.key.includes("if-x")));
  ok("stride missing boundary", boundaryPairs(system, dfd, "nope").length === 0);
  ok("stride non-trust-boundary id", boundaryPairs(system, dfd, "dev").length === 0);
  ok("stride empty inputs", boundaryPairs(undefined, {}, "tb").length === 0);
  const lab = boundaryPairs({}, { nodes: [{ id: "tb", type: "trust-boundary", members: ["a"] }, { id: "a" }], flows: [{ from: "a", to: "zzz" }] }, "tb");
  ok("stride label fallback to id", lab.length === 1 && lab[0].inside.label === "a" && lab[0].outside.label === "zzz");
  const cell = (c) => ({ endpoints: { a: { cells: { S: c } } } });
  ok("stride whitespace-only content is empty", analysisHasContent(cell({ strengths: ["  "], weaknesses: [""] })) === false);
  ok("stride strengths content", analysisHasContent(cell({ strengths: ["x"] })) === true);
  ok("stride weaknesses content on other side", analysisHasContent({ endpoints: { a: null, b: { cells: { T: { weaknesses: [" x "] } } } } }) === true);
  ok("stride endpoints required", analysisHasContent({ cells: { S: { strengths: ["x"] } } }) === false && analysisHasContent(undefined) === false);
  ok("stride any pair true", anyPairHasContent({ p: {}, q: cell({ strengths: ["ok"] }) }) === true);
  ok("stride any pair false", anyPairHasContent({ p: {} }) === false && anyPairHasContent(undefined) === false);
  for (const analysis of [undefined, {}, cell({ strengths: ["\t"] }), cell({ weaknesses: [" x "] }),
    { endpoints: { a: { cells: { S: { strengths: ["ok"], ignored: ["y"] } } } } }]) {
    ok("stride authored content matches webapp", analysisHasContent(analysis) === webStride.analysisHasContent(analysis));
  }
  for (const analyses of [undefined, {}, { p: cell({ strengths: ["\t"] }) }, { p: {}, q: cell({ weaknesses: ["x"] }) }]) {
    ok("stride any authored pair matches webapp", anyPairHasContent(analyses) === webStride.anyPairHasContent(analyses));
  }
}

async function runValidationCoreTests() {
  const { validateCore, validate: validateExtension } = require(path.join(root, "vscode-extension/media/validation-model.js"));
  const { validate } = await import("../webapp/server/src/validate.js");
  const norm = (issues) => issues.map((i) => JSON.stringify([i.severity, i.key, i.message])).sort();
  const webErrors = (input) => validate(input).filter((i) => i.severity === "error");
  const clean = {
    project: { name: "Clean" },
    assumptions: { device: [{ id: "A-DEV-1" }], attacker: [{ id: "ATK-1", capability: 2 }] },
    system: {
      components: [{ id: "C1", name: "MCU" }, { id: "C2", name: "Cloud" }],
      interfaces: [{ id: "IF1", name: "UART" }],
      trustBoundaries: [{ id: "TB1" }],
      assets: [{ id: "AS1" }],
    },
    threats: { threats: [{ id: "T1", components: ["C1"], assets: ["AS1"], attackerRef: "ATK-1", interfaceRefs: ["IF1"], interfaceRef: "IF1", assumptionRefs: ["A-DEV-1", "ATK-1"] }] },
    countermeasures: { countermeasures: [{ id: "CM1", addresses: [{ threat: "T1" }], components: ["C1"] }] },
    requirements: { requirements: [{ id: "R1", derivedFromThreat: ["T1"], satisfiedByCM: ["CM1"] }] },
    dfd: { nodes: [{ id: "N1", type: "process" }, { id: "TB1", type: "trust-boundary", members: ["N1"] }, { id: "TB2", type: "trust-boundary", members: ["N1"] }], flows: [{ id: "F1", crossesBoundary: "TB1" }, { id: "F2", crossesBoundary: "TB2" }] },
    attackTrees: { trees: [{ id: "AT1", threatRef: "T1", threatRefs: ["T1"] }] },
    defects: { defects: [{ id: "D1", component: "C1", threatRef: "T1" }] },
  };
  ok("validation core: clean project has no extension issues", validateCore(clean).length === 0);
  ok("validation core: clean project has no webapp errors", webErrors(clean).length === 0);

  const bad = {
    assumptions: { system: [{ id: "A-SYS-1" }], attacker: [{ id: "ATK-1" }] },
    system: {
      components: [{ id: "C1" }, { id: "T1" }, { id: "N-DUP" }],
      interfaces: [{ id: "IF1" }],
      trustBoundaries: [{ id: "TB1" }],
      assets: [{ id: "AS1" }],
    },
    threats: [
      { id: "T1", components: ["C1", "C-X"], assets: ["AS-X"], attackerRef: "ATK-X", interfaceRefs: ["IF-X"], interfaceRef: "IF-Y", assumptionRefs: ["bad!", "A-NOPE", "A-SYS-1"] },
      { components: ["C1"] },
    ],
    countermeasures: [{ id: "CM1", addresses: [{ threat: "T-X" }, { threat: "T1" }], components: ["C-Y"] }, { addresses: [] }],
    requirements: [{ id: "R1", derivedFromThreat: ["T-Z"], satisfiedByCM: ["CM-Z", "CM1"] }],
    dfd: { nodes: [{ id: "N-DUP", type: "process" }, { id: "TB1", type: "trust-boundary", members: ["N-DUP"] }], flows: [{ id: "F1", crossesBoundary: "TB-X" }, { id: "F2", crossesBoundary: "TB1" }] },
    attackTrees: { trees: [{ id: "AT1", threatRef: "T-Q", threatRefs: ["T-Q", "T1"] }, { id: "AT2", threatRefs: ["T-R"] }] },
    defects: [{ id: "D1", component: "C-D", threatRef: "T-D" }, { component: "C-E" }],
  };
  const snapshot = JSON.stringify(bad);
  const extBad = validateCore(bad);
  ok("validation core: input not mutated", JSON.stringify(bad) === snapshot);
  assert.deepStrictEqual(norm(extBad), norm(webErrors(bad)), "FAIL: validation core bad project matches webapp errors");
  passed++;
  ok("validation core: only error severity", extBad.every((i) => i.severity === "error"));
  ok("validation core: bad project exercises every rule", extBad.length >= 20);
  ok("validation core: trust-boundary DFD alias not a duplicate", !extBad.some((i) => i.message.includes("Duplicate ID 'TB1'")));
  ok("validation core: cross-kind duplicate detected", extBad.some((i) => i.message === "Duplicate ID 'T1' — used by component and threat. IDs must be unique across the project."));
  ok("validation core: DFD node duplicate detected", extBad.some((i) => i.message.includes("Duplicate ID 'N-DUP' — used by component and DFD node.")));
  ok("validation core: attack tree refs deduplicated", extBad.filter((i) => i.message.includes("'T-Q'")).length === 1);
  assert.deepStrictEqual(norm(validateCore(clean)), norm(webErrors(clean)));
  passed++;
  for (const input of [undefined, {}, { threats: {}, countermeasures: {}, requirements: {}, defects: {} }]) {
    assert.deepStrictEqual(norm(validateCore(input)), norm(webErrors(input)), "FAIL: validation core empty input matches webapp");
    passed++;
  }
  ok("validation core: undefined input yields no issues", validateCore().length === 0);

  const dateOffset = (days) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const parityFixture = {
    project: {
      riskScoringMethod: "cost-based",
      costFactorWeights: { time: 0.4 },
      accessProbabilities: { 1: 0.01, 5: 1.1 },
      likelihoodProbabilityThresholds: { 2: 0.8, 3: 0.7, 4: 0.6, 5: 0.5 },
      acceptableRisk: 3,
      slTarget: "SL-C 2",
      rigorousMode: true,
    },
    assumptions: { attacker: [{ id: "ATK-1", access: "remote", capability: 1 }] },
    system: {
      components: [{ id: "C1", name: "Controller" }, { id: "C2", name: "Uncovered" }],
      interfaces: [{ id: "IF1", name: "UART", hidden: "yes" }],
      trustBoundaries: [{ id: "TB1" }],
    },
    threats: { threats: [
      {
        id: "T1", likelihood: 5, impact: 5, stride: ["S"], components: ["C1"], attackerRef: "ATK-1",
        likelihoodFactors: { exposure: 1, exploitability: 1 }, requiredSkill: 4, requiredAccess: 1,
        costFactors: { time: 1 }, costRationales: { time: "reviewed" }, costLikelihoodProposal: 4,
        status: "mitigated", classification: "product-vulnerability", responsibility: "integrator-operator",
        deploymentConstraints: "install securely", reviewDate: dateOffset(-1),
      },
      {
        id: "T2", likelihood: 2, impact: 2, components: ["C1"], status: "accepted",
        reviewDate: dateOffset(1),
      },
    ] },
    countermeasures: { countermeasures: [{
      id: "CM1", addresses: [{ threat: "T1", residualImpact: 4, residualLikelihood: 6 }],
      components: ["C1"], type: "preventive", status: "implemented",
    }] },
    requirements: { requirements: [
      { id: "R1" },
      { id: "R2", derivedFromThreat: ["T1"] },
    ] },
    dfd: {
      nodes: [{ id: "TB1", type: "trust-boundary" }],
      flows: [{ id: "F1", from: "C1", to: "C2", label: "" }],
    },
    useCases: { diagrams: [{ id: "UC1" }] },
    attackTrees: { trees: [] },
    defects: { defects: [{ id: "D1", status: "open", severity: "critical", threatRef: "T1" }] },
  };
  const fixtureSnapshot = JSON.stringify(parityFixture);
  const fixtureIssues = validateExtension(parityFixture);
  const parityNorm = (issues) => issues.map((issue) => JSON.stringify([issue.severity, issue.message, issue.key])).sort();
  assert.deepStrictEqual(parityNorm(fixtureIssues), parityNorm(validate(parityFixture)),
    "FAIL: extension full validator matches complete webapp issues");
  passed++;
  ok("validation parity: full validator does not mutate input", JSON.stringify(parityFixture) === fixtureSnapshot);
  ok("validation parity: cost scoring and attacker-profile rules covered",
    fixtureIssues.some((i) => i.key === "cost-factor-weights") &&
    fixtureIssues.some((i) => i.key === "access-probability:1") &&
    fixtureIssues.some((i) => i.key === "likelihood-thresholds") &&
    fixtureIssues.some((i) => i.key === "slc-attacker-profile"));
  ok("validation parity: risk, completeness, and rigorous rules covered",
    fixtureIssues.some((i) => i.key === "risk-over-acceptable:T1") &&
    fixtureIssues.some((i) => i.message.includes("no STRIDE category")) &&
    fixtureIssues.some((i) => i.message.includes("requires the Bug Bar impact dimensions")) &&
    fixtureIssues.some((i) => i.message.includes("accepted residual risk requires")));
  ok("validation parity: coverage and consistency rules covered",
    fixtureIssues.some((i) => i.message.includes("Coverage: component 'C2'")) &&
    fixtureIssues.some((i) => i.message.includes("Coverage: interface 'IF1'")) &&
    fixtureIssues.some((i) => i.message.includes("preventive control should reduce likelihood")) &&
    fixtureIssues.some((i) => i.message.includes("product-vulnerability with integrator-operator")));

  const noticeKey = "req-standalone:R1";
  const acceptedIssues = validateExtension({
    ...parityFixture,
    project: { ...parityFixture.project, acceptedNotices: [noticeKey] },
  });
  assert.deepStrictEqual(parityNorm(acceptedIssues), parityNorm(fixtureIssues.filter((i) => i.key !== noticeKey)),
    "FAIL: accepting a notice suppresses only that notice key");
  passed++;
  ok("validation parity: notice acceptance leaves other notices and all non-notices intact",
    acceptedIssues.some((i) => i.severity === "notice" && i.key !== noticeKey) &&
    parityNorm(acceptedIssues.filter((i) => i.severity !== "notice")).join() ===
      parityNorm(fixtureIssues.filter((i) => i.severity !== "notice")).join());
  ok("validation parity: dynamic review dates distinguish overdue from future",
    fixtureIssues.some((i) => i.message.includes(`re-assessment overdue (review date ${dateOffset(-1)})`)) &&
    !fixtureIssues.some((i) => i.message.includes(`re-assessment overdue (review date ${dateOffset(1)})`)));
}

async function runValidationDiagnosticsTests() {
  const model = require(path.join(root, "vscode-extension/media/validation-diagnostics.js"));
  const files = new Map([
    ["01-project-description/project.json", { title: "Test", riskScoringMethod: "cost-based", acceptedNotices: [] }],
    ["02-assumptions/assumptions.json", { attacker: [] }],
    ["03-system-assets/system.json", { components: [{ id: "C-1" }], interfaces: [], assets: [], trustBoundaries: [] }],
    ["04-dfd/dfd.json", { nodes: [], flows: [] }],
    ["04b-use-cases/use-cases.json", { diagrams: [{ id: "UC-1" }] }],
    ["06-threats/threats.json", { threats: [
      { id: "T-1", likelihood: 5, impact: 5, components: ["C-MISSING"], stride: ["S"] },
      { likelihood: 1, impact: 1, components: [], stride: [] },
    ] }],
    ["05-requirements/requirements.json", { requirements: [{ id: "R-1", derivedFromThreat: [], satisfiedByCM: [] }] }],
    ["08-countermeasures/countermeasures.json", { countermeasures: [] }],
    ["07-attack-trees/attack-trees.json", { trees: [] }],
    ["09-defects/defects.json", { defects: [] }],
  ]);
  const before = JSON.stringify([...files]);
  const published = new Map();
  let clearCount = 0;
  let projectRoots = ["/workspace/project"];
  const controller = model.createValidationController({
    findProjects: async () => projectRoots,
    readFile: async (_root, relative) => {
      if (!files.has(relative)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return JSON.stringify(files.get(relative));
    },
    clear: () => { clearCount++; published.clear(); },
    publish: async (projectRoot, relative, diagnostics) => published.set(`${projectRoot}/${relative}`, diagnostics),
  });
  assert.strictEqual(model.severityFor("error"), "error");
  assert.strictEqual(model.severityFor("warning"), "warning");
  assert.strictEqual(model.severityFor("notice"), "information");
  await controller.refresh();
  ok("validation diagnostics: maps error to the owning threat file",
    published.get("/workspace/project/06-threats/threats.json").some((d) => d.severity === "error" && d.message.includes("unknown component")));
  ok("validation diagnostics: missing entity ID maps to that entity artifact",
    published.get("/workspace/project/06-threats/threats.json").some((d) => d.message === "A threat is missing its ID."));
  ok("validation diagnostics: maps project-level warning to project file",
    published.get("/workspace/project/01-project-description/project.json").some((d) => d.severity === "warning"));
  ok("validation diagnostics: maps use-case notice to use-case file",
    published.get("/workspace/project/04b-use-cases/use-cases.json").some((d) => d.severity === "information"));
  ok("validation diagnostics: maps standalone requirement notice to requirement file",
    published.get("/workspace/project/05-requirements/requirements.json")?.some((d) => d.severity === "information" && d.key === "req-standalone:R-1"));
  const noticeCount = [...published.values()].flat().filter((d) => d.severity === "information").length;
  files.set("01-project-description/project.json", { ...files.get("01-project-description/project.json"), acceptedNotices: ["req-standalone:R-1"] });
  await controller.refresh();
  ok("validation diagnostics: accepted notice refresh suppresses only that notice",
    [...published.values()].flat().filter((d) => d.severity === "information").length === noticeCount - 1
      && !published.get("/workspace/project/05-requirements/requirements.json")?.some((d) => d.key === "req-standalone:R-1")
      && published.get("/workspace/project/04b-use-cases/use-cases.json")?.some((d) => d.key === "usecases-excluded"));
  files.set("06-threats/threats.json", { threats: [{ id: "T-1", likelihood: 1, impact: 1, components: ["C-1"], stride: ["S"] }] });
  await controller.refresh();
  ok("validation diagnostics: update clears stale diagnostics before publishing current results",
    clearCount === 3 && !published.get("/workspace/project/06-threats/threats.json")?.some((d) => d.message.includes("unknown component")));
  const updatedSnapshot = JSON.stringify([...files]);
  await controller.refresh();
  ok("validation diagnostics: refresh does not mutate project documents", JSON.stringify([...files]) === updatedSnapshot && updatedSnapshot !== before);
  projectRoots = [];
  await controller.refresh();
  ok("validation diagnostics: deleted project refresh clears stale diagnostics", clearCount === 5 && published.size === 0);
}

function runDfdOverviewTests() {
  const input = {
    project: { device: { name: "Overview Device" }, title: "Project title" },
    system: {
      components: [{ id: "C-1", name: "Main component" }],
      interfaces: [
        { id: "I-1", component: "C-1", name: "Ethernet" },
        { id: "I-2", component: "C-1", name: "Hidden port", hidden: true },
      ],
    },
    dfd: { nodes: [
      { id: "N-1", label: "Main", type: "process", layer: 1, parent: null, componentRef: "C-1" },
      { id: "N-2", label: "Storage", type: "store", layer: 2, parent: "N-1" },
      { id: "N-3", label: "Nested", type: "multiprocess", layer: "invalid", parent: "N-2" },
      { id: "N-4", label: "Outside", type: "external-entity", layer: 1, parent: null },
      { id: "TB-1", label: "Boundary", type: "trust-boundary", layer: 1, parent: null, members: ["N-1", "N-2"] },
    ] },
  };
  const before = JSON.stringify(input);
  const result = DfdOverviewModel.buildOverview(input);
  ok("DFD overview: device name and root hierarchy", result.deviceName === "Overview Device" && result.roots.length === 3);
  const main = result.roots.find((node) => node.id === "N-1");
  ok("DFD overview: parent nesting and integer-layer fallback",
    main.children[0].id === "N-2" && main.children[0].children[0].layer === 3);
  ok("DFD overview: type labels and codicon names are mapped",
    result.roots.map((node) => node.typeLabel).join(",") === "Process,External entity,Trust boundary"
      && result.roots.every((node) => typeof node.icon === "string" && node.icon.length > 0)
      && main.children[0].typeLabel === "Data store" && main.children[0].children[0].typeLabel === "Multi-process");
  ok("DFD overview: component, trust-boundary members and visible interfaces",
    main.componentName === "Main component" && main.interfaces.join(",") === "Ethernet"
      && result.roots.find((node) => node.id === "TB-1").memberCount === 2);
  ok("DFD overview: open action maps to the node layer",
    JSON.stringify(DfdOverviewModel.openAction(main.children[0])) === JSON.stringify({ command: "embedrisk.dfdOverviewOpen", args: [2] }));
  ok("DFD overview: model construction does not mutate input", JSON.stringify(input) === before);
  const empty = DfdOverviewModel.buildOverview({ project: { title: "Fallback title" }, dfd: { nodes: [] } });
  ok("DFD overview: empty state has no roots and title fallback", empty.roots.length === 0 && empty.deviceName === "Fallback title");
  const cycle = DfdOverviewModel.buildOverview({ dfd: { nodes: [
    { id: "A", label: "A", type: "process", parent: "B" },
    { id: "B", label: "B", type: "process", parent: "A" },
  ] } });
  ok("DFD overview: cyclic parent references terminate safely", cycle.roots.length === 0);

  const extDir = path.join(root, "vscode-extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
  const extension = fs.readFileSync(path.join(extDir, "src/extension.ts"), "utf8");
  const provider = fs.readFileSync(path.join(extDir, "src/dfdOverview.ts"), "utf8");
  ok("DFD overview: Explorer view and refresh/open commands are contributed",
    manifest.contributes.views.explorer.some((view) => view.id === "embedrisk.dfdOverview")
      && ["embedrisk.dfdOverviewRefresh", "embedrisk.dfdOverviewOpen"].every((id) => manifest.contributes.commands.some((command) => command.command === id)));
  ok("DFD overview: provider is registered with a debounced refresh watcher and read-only IO",
    extension.includes("registerDfdOverview(ctx)") && extension.includes("embedrisk.dfdOverviewOpen")
      && provider.includes("TreeDataProvider") && provider.includes("createFileSystemWatcher")
      && provider.includes("embedrisk.dfdOverviewRefresh") && provider.includes("workspace.fs.readFile")
      && !provider.includes("writeFile"));
}

runImportedKbTests()
  .then(() => runDfdOverviewTests())
  .then(() => checkWebappParity())
  .then(() => runValidationCoreTests())
  .then(() => runValidationDiagnosticsTests())
  .then(async () => {
    const { runLayerVisibilityTests } = await import("../webapp/test/dfd-layer-visibility.test.mjs");
    runLayerVisibilityTests(LayerVisibilityModel);
  })
  .then(() => runDfdEngineTests())
  .then(() => runStrideTests())
  .then(() => console.log("All " + passed + " model assertions passed."))
  .catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
