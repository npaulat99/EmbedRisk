import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
// Shared DeMarco converter (also a standalone CLI). DataFlowDiagram.xml carries the matching shapes.
import { dfdToDrawio } from "../../tools/dfd-to-drawio.mjs";
import { openWizard } from "./wizard";
import { openKbBrowser } from "./kbBrowser";
import { DfdEditor } from "./dfdEditor";
import { NativeDfdEditor } from "./nativeDfdEditor";
import { AttackTreeEditor } from "./attackTreeEditor";
import { UseCaseEditor } from "./useCaseEditor";

// Isomorphic CommonJS webview model, reused here for the shared threatRefs/threatRef read rule.
const AtModel = require("../media/attacktree-model.js");

interface Node { id: string; label: string; type: string; layer: number; parent?: string | null }
interface Dfd { nodes: Node[]; flows: { id: string; label?: string; from: string; to: string }[]; }

let layer = 1;
const execFileAsync = promisify(execFile);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const find = () => vscode.workspace.findFiles("**/04-dfd/dfd.json", "**/node_modules/**", 1).then((f) => f[0]);
const load = async (u: vscode.Uri): Promise<Dfd> => JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(u)));
const encodeJson = (obj: unknown) => encoder.encode(JSON.stringify(obj, null, 2));
const writeText = (u: vscode.Uri, text: string) => vscode.workspace.fs.writeFile(u, encoder.encode(text));
const pathExists = async (u: vscode.Uri) => { try { await vscode.workspace.fs.stat(u); return true; } catch { return false; } };
const reportsScript = (ctx: vscode.ExtensionContext) => vscode.Uri.joinPath(ctx.extensionUri, "runtime", "tools", "generate-report.mjs");
const projectsRoot = () => vscode.Uri.file(path.join(os.homedir(), "Documents", "EmbedRisk", "projects"));
const importedKbRoot = (ctx: vscode.ExtensionContext) => vscode.Uri.joinPath(ctx.globalStorageUri, "knowledge-base", "imported");

async function resolveWebappLauncher(ctx: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, "webapp", "bin", "embedrisk.js") : "",
    path.join(ctx.extensionUri.fsPath, "..", "webapp", "bin", "embedrisk.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(vscode.Uri.file(candidate))) return candidate;
  }
  return null;
}

async function pickLaunchFolder() {
  if (vscode.workspace.workspaceFolders?.length) return vscode.workspace.workspaceFolders[0].uri;
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: "Open in EmbedRisk webapp" });
  return picked?.[0] || null;
}

async function launchWebappTask(target: vscode.Uri, launcher: string | null) {
  const port = process.env.PORT || "4317";
  const execution = launcher
    ? new vscode.ProcessExecution(process.execPath, [launcher, target.fsPath], {
      cwd: target.fsPath,
      env: { ...process.env, PORT: port },
    })
    : new vscode.ProcessExecution("embedrisk", [target.fsPath], {
      cwd: target.fsPath,
      env: { ...process.env, PORT: port },
    });

  const task = new vscode.Task(
    { type: "embedriskWebapp" },
    vscode.TaskScope.Workspace,
    "Open EmbedRisk webapp",
    "embedrisk",
    execution,
    []
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    focus: false,
    clear: false,
  };
  await vscode.tasks.executeTask(task);
  return port;
}

async function writeJson(u: vscode.Uri, obj: unknown) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(u.fsPath)));
  await vscode.workspace.fs.writeFile(u, encodeJson(obj));
}

async function initGitRepo(dir: vscode.Uri) {
  try {
    await execFileAsync("git", ["init"], { cwd: dir.fsPath });
  } catch {
    vscode.window.showErrorMessage("Git init failed. The project was created and can still be used without a Git repository.");
  }
}

async function generateReport(ctx: vscode.ExtensionContext, projDir: vscode.Uri) {
  const script = reportsScript(ctx);
  if (!(await pathExists(script))) {
    vscode.window.showErrorMessage("The packaged report generator is missing. Reinstall the extension.");
    return;
  }
  try {
    await execFileAsync(process.execPath, [script.fsPath, projDir.fsPath], { cwd: path.dirname(script.fsPath) });
    const report = vscode.Uri.joinPath(projDir, "report", "index.html");
    const act = await vscode.window.showInformationMessage("Report generated successfully.", "Open report", "Reveal folder");
    if (act === "Open report") await vscode.commands.executeCommand("vscode.open", report);
    else if (act === "Reveal folder") await vscode.commands.executeCommand("revealFileInOS", report);
  } catch (err: any) {
    const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
    vscode.window.showErrorMessage(detail ? `Report generation failed: ${detail}` : "Report generation failed.");
  }
}

async function scaffoldProject(dir: vscode.Uri, name: string, slug: string) {
  const project = {
    traVersion: "1.0",
    projectId: slug,
    title: `EmbedRisk: ${name}`,
    device: { name, type: "field device", modelReference: "", purdueLevel: "0-1", version: "" },
    scope: { mode: "graybox", boundary: "", inScope: [], outOfScope: [] },
    slTarget: "SL2",
    riskScoringMethod: "cost-based",
    intendedUse: "",
    foreseeableUse: [],
    repo: { projectBranchUrl: "", kbUrl: "" },
    steps: {
      "01-project-description": "01-project-description/project.json",
      "02-assumptions": "02-assumptions/assumptions.json",
      "03-system-assets": "03-system-assets/system.json",
      "04-dfd": "04-dfd/dfd.json",
      "04b-use-cases": "04b-use-cases/use-cases.json",
      "05-requirements": "05-requirements/requirements.json",
      "06-threats": "06-threats/threats.json",
      "07-attack-trees": "07-attack-trees/attack-trees.json",
      "08-countermeasures": "08-countermeasures/countermeasures.json",
      "09-defects": "09-defects/defects.json"
    },
    status: "draft",
    rigorousMode: false,
    sbom: { mode: "external", format: "spdx" }
  };
  const assumptions = {
    device: [], system: [], environment: [], operational: [],
    attacker: [{ id: "ATK-SLC-2", name: "Threat Actor 2: Simple Intentional Attacks", capability: 2, motivation: "Intentional attack using simple means", resources: "Low resources, general IT knowledge, low motivation", text: "SL-C 2 attacker profile managed by EmbedRisk." }]
  };
  const system = {
    components: [{ id: "C-DEV", name, kind: "device", layer: 1, parent: null, trustZone: "device", provenance: "own" }],
    interfaces: [], trustBoundaries: [],
    assets: [{ id: "AS-1", name: "Primary function", type: "function", storage: "", components: ["C-DEV"], objectives: { confidentiality: 1, integrity: 3, availability: 3, safety: 1 } }]
  };
  const dfd = { nodes: [{ id: "N-DEV", label: name, type: "process", layer: 1, parent: null, componentRef: "C-DEV" }], flows: [] };

  await vscode.workspace.fs.createDirectory(dir);
  await writeJson(vscode.Uri.joinPath(dir, "01-project-description", "project.json"), project);
  await writeJson(vscode.Uri.joinPath(dir, "02-assumptions", "assumptions.json"), assumptions);
  await writeJson(vscode.Uri.joinPath(dir, "03-system-assets", "system.json"), system);
  await writeJson(vscode.Uri.joinPath(dir, "04-dfd", "dfd.json"), dfd);
  await writeJson(vscode.Uri.joinPath(dir, "04b-use-cases", "use-cases.json"), { diagrams: [] });
  await writeJson(vscode.Uri.joinPath(dir, "05-requirements", "requirements.json"), { requirements: [] });
  await writeJson(vscode.Uri.joinPath(dir, "06-threats", "threats.json"), { threats: [] });
  await writeJson(vscode.Uri.joinPath(dir, "07-attack-trees", "attack-trees.json"), { trees: [] });
  await writeJson(vscode.Uri.joinPath(dir, "08-countermeasures", "countermeasures.json"), { countermeasures: [] });
  await writeJson(vscode.Uri.joinPath(dir, "09-defects", "defects.json"), { defects: [] });
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, "documents"));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, "report"));
  await writeText(vscode.Uri.joinPath(dir, "documents", "README.md"), "# Supporting documents\n\nStore device specifications, architecture notes, and audit evidence here.\n");
  await writeText(vscode.Uri.joinPath(dir, ".gitignore"), "report/\n");
}

async function openLayer(target: number) {
  const u = await find();
  if (!u) { vscode.window.showWarningMessage("No 04-dfd/dfd.json in the workspace."); return; }
  const dfd = await load(u);
  const layers = [...new Set(dfd.nodes.map((n) => n.layer))].sort();
  if (!dfd.nodes.some((n) => n.layer === target)) {
    const create = await vscode.window.showInformationMessage(`Layer ${target} has no components yet. Create it?`, "Create", "Cancel");
    if (create !== "Create") return;
    dfd.nodes.push({ id: `N-L${target}-1`, label: `New component (L${target})`, type: "process", layer: target, parent: dfd.nodes[0]?.id ?? null });
    await vscode.workspace.fs.writeFile(u, encodeJson(dfd));
  }
  layer = target;
  const out = vscode.Uri.joinPath(u, "..", "dfd.drawio");
  await writeText(out, dfdToDrawio(await load(u), layer));
  await vscode.commands.executeCommand("vscode.open", out);
  vscode.window.setStatusBarMessage(`DFD layer ${layer} (layers: ${layers.join(", ")})`, 4000);
}

export function activate(ctx: vscode.ExtensionContext) {
  const attackTreeEditor = new AttackTreeEditor(ctx.extensionUri);
  const useCaseEditor = new UseCaseEditor(ctx.extensionUri);
  const openWebappCommand = async () => {
    const target = await pickLaunchFolder();
    if (!target) return;

    const launcher = await resolveWebappLauncher(ctx);
    const port = await launchWebappTask(target, launcher);
    const url = vscode.Uri.parse(`http://localhost:${port}`);
    const action = await vscode.window.showInformationMessage(`EmbedRisk webapp launch requested for ${target.fsPath}.`, "Open webapp", "Show task output");
    if (action === "Open webapp") await vscode.env.openExternal(url);
    if (action === "Show task output") await vscode.commands.executeCommand("workbench.action.tasks.showLog");
  };

  const createProjectCommand = async () => {
    const name = await vscode.window.showInputBox({ prompt: "Device / project name" });
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const root = projectsRoot();
    await vscode.workspace.fs.createDirectory(root);
    const dir = vscode.Uri.joinPath(root, slug);
    if (await pathExists(dir)) {
      const act = await vscode.window.showWarningMessage(`The project '${slug}' already exists at ${dir.fsPath}.`, "Open project", "Cancel");
      if (act === "Open project") await vscode.commands.executeCommand("vscode.openFolder", dir, { forceNewWindow: true });
      return;
    }
    await scaffoldProject(dir, name, slug);
    await initGitRepo(dir);
    const act = await vscode.window.showInformationMessage(`Created project at ${dir.fsPath}.`, "Open project", "Reveal in Explorer");
    if (act === "Reveal in Explorer") await vscode.commands.executeCommand("revealFileInOS", dir);
    else await vscode.commands.executeCommand("vscode.openFolder", dir, { forceNewWindow: true });
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("embedrisk.dfdToDrawio", () => openLayer(layer)),
    vscode.commands.registerCommand("embedrisk.dfdLayerDown", () => openLayer(layer + 1)),
    vscode.commands.registerCommand("embedrisk.dfdLayerUp", () => openLayer(Math.max(1, layer - 1))),
    vscode.commands.registerCommand("embedrisk.report", async () => {
      const u = await find();
      if (!u) { vscode.window.showWarningMessage("No EmbedRisk project (04-dfd/dfd.json) found."); return; }
      const projDir = vscode.Uri.joinPath(u, "..", "..");
      await generateReport(ctx, projDir);
    }),
    vscode.commands.registerCommand("embedrisk.newProject", createProjectCommand),
    vscode.commands.registerCommand("embedrisk.openWebapp", openWebappCommand),
    vscode.commands.registerCommand("embedrisk.wizard", () => openWizard(ctx)),
    vscode.commands.registerCommand("embedrisk.kbBrowse", () => openKbBrowser(ctx)),
    vscode.commands.registerCommand("embedrisk.dfdNative", async () => {
      const u = await find();
      if (!u) { vscode.window.showWarningMessage("No 04-dfd/dfd.json in the workspace."); return; }
      await vscode.commands.executeCommand("vscode.openWith", u, "embedrisk.dfdNative");
    }),
    vscode.commands.registerCommand("embedrisk.useCases", async () => {
      const pf = await vscode.workspace.findFiles("**/01-project-description/project.json", "**/node_modules/**", 1);
      if (!pf[0]) { vscode.window.showWarningMessage("No EmbedRisk project found."); return; }
      const projDir = vscode.Uri.joinPath(pf[0], "..", "..");
      const file = vscode.Uri.joinPath(projDir, "04b-use-cases", "use-cases.json");
      if (!(await pathExists(file))) await writeJson(file, { diagrams: [] });
      await vscode.commands.executeCommand("vscode.openWith", file, "embedrisk.useCases");
    }),
    vscode.commands.registerCommand("embedrisk.newAttackTree", async () => {
      const tf = await vscode.workspace.findFiles("**/06-threats/threats.json", "**/node_modules/**", 1);
      if (!tf[0]) { vscode.window.showWarningMessage("No EmbedRisk project (06-threats/threats.json) found."); return; }
      const projDir = vscode.Uri.joinPath(tf[0], "..", "..");
      const file = vscode.Uri.joinPath(projDir, "07-attack-trees/attack-trees.json");
      const readThreats = async (): Promise<any[]> => { try { return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(tf[0])).toString()).threats || []; } catch { return []; } };
      const readDoc = async (): Promise<any> => { try { const d = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString()); if (!Array.isArray(d.trees)) d.trees = []; return d; } catch { return { trees: [] }; } };
      const writeDoc = (d: any) => vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(d, null, 2)));
      const countNodes = (n: any): number => 1 + (n.children || []).reduce((s: number, c: any) => s + countNodes(c), 0);
      const openTree = async (id?: string) => { attackTreeEditor.pendingTreeId = id; await vscode.commands.executeCommand("vscode.openWith", file, "embedrisk.attackTree"); };

      // Create a new tree, first asking which threat it models (so it carries the threat prefix).
      const createForThreat = async () => {
        const threats = await readThreats();
        const items: any[] = threats.map((t: any) => ({ label: t.id, description: t.title, t }));
        items.push({ label: "$(circle-slash) No specific threat", t: null });
        const pick = await vscode.window.showQuickPick(items, { placeHolder: "Which threat does this attack tree model?" });
        if (!pick) return;
        const t = (pick as any).t;
        const d = await readDoc();
        const ids = new Set(d.trees.map((x: any) => x.id));
        const base = t ? "AT-" + t.id : "AT"; let id = base; let n = 1; while (ids.has(id)) id = `${base}-${++n}`;
        d.trees.push({ id, title: t ? t.title : "New attack goal", ...(t ? { threatRef: t.id } : {}), threatRefs: t ? [t.id] : [], root: { id: "n1", kind: "goal", label: t ? t.title : "Attack goal", gate: "OR", children: [{ id: "n2", kind: "step", label: "Attacker step 1", access: 3, skill: 2, cost: {}, children: [] }] } });
        attackTreeEditor.pendingTreeId = id; // set before writing so the new tree is focused whether or not the editor is already open
        await writeDoc(d);
        await vscode.commands.executeCommand("vscode.openWith", file, "embedrisk.attackTree");
      };

      // Hub: list existing trees (with their threat prefix), open one, delete one, or create a new one.
      const threats = await readThreats();
      const doc0 = await readDoc();
      const threatTitle = (ref: string) => ((threats.find((x: any) => x.id === ref) || {}).title) || "";
      const NEW: any = { label: "$(add) New attack tree\u2026", alwaysShow: true };
      const build = (d: any) => [NEW, ...d.trees.map((t: any) => {
        const refs: string[] = AtModel.threatRefsOf(t);
        const titles = refs.map(threatTitle).filter(Boolean).join(", ");
        return {
          label: (refs.length ? "$(target) " + refs.join(", ") + " \u00b7 " : "") + (t.title || t.id),
          description: t.id,
          detail: (titles ? titles + "  \u00b7  " : "") + countNodes(t.root) + " node(s)",
          treeId: t.id,
          buttons: [{ iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete this attack tree" }],
        };
      })];
      const qp = vscode.window.createQuickPick();
      qp.title = "Attack trees";
      qp.ignoreFocusOut = true;
      qp.placeholder = doc0.trees.length ? "Open an attack tree \u00b7 trash icon deletes \u00b7 or create a new one" : "No attack trees yet \u2014 create one to model a threat";
      qp.items = build(doc0);
      qp.onDidTriggerItemButton(async (e) => {
        const id = (e.item as any).treeId; if (!id) return;
        const cur = await readDoc();
        const idx = cur.trees.findIndex((t: any) => t.id === id); if (idx < 0) return;
        const conf = await vscode.window.showWarningMessage(`Delete attack tree '${cur.trees[idx].title || id}' and all its nodes?`, { modal: true }, "Delete");
        if (conf !== "Delete") return;
        cur.trees.splice(idx, 1);
        await writeDoc(cur);
        qp.items = build(cur);
      });
      qp.onDidAccept(async () => { const sel: any = qp.selectedItems[0]; qp.hide(); if (!sel) return; if (sel.treeId) await openTree(sel.treeId); else await createForThreat(); });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),
    vscode.commands.registerCommand("embedrisk.kbImport", async () => {
      const url = await vscode.window.showInputBox({ prompt: "Git URL of a TRA knowledge base to import", placeHolder: "https://github.com/org/tra-kb.git" });
      if (!url) return;
      const name = (url.split("/").pop() || "kb").replace(/\.git$/, "");
      const root = importedKbRoot(ctx);
      await vscode.workspace.fs.createDirectory(root);
      const target = path.join(root.fsPath, name);
      if (await pathExists(vscode.Uri.file(target))) {
        vscode.window.showWarningMessage(`A knowledge base named '${name}' is already imported.`);
        return;
      }
      try {
        await execFileAsync("git", ["clone", url, target], { cwd: root.fsPath });
        vscode.window.showInformationMessage(`Imported knowledge base into ${target}.`);
      } catch (err: any) {
        const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
        vscode.window.showErrorMessage(detail ? `Knowledge-base import failed: ${detail}` : "Knowledge-base import failed.");
      }
    }),
    vscode.window.registerCustomEditorProvider("embedrisk.dfdNative", new NativeDfdEditor(ctx.extensionUri), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider("embedrisk.attackTree", attackTreeEditor, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider("embedrisk.useCases", useCaseEditor, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider("embedrisk.dfdEditor", new DfdEditor(ctx.extensionUri)),
  );
  // The wizard no longer opens automatically on activation. Run "EmbedRisk: Open guided wizard"
  // (command palette) to open it; the extension still activates on startup only to register its
  // commands and the DFD / attack-tree custom editors.
}
export function deactivate() { }
