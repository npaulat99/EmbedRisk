import * as vscode from "vscode";
import * as path from "node:path";
import { readdir } from "node:fs/promises";

// Shared webapp-compatible id scheme (prefix + lowest free number), from the isomorphic DFD model.
const { nextId } = require("../media/dfd-model.js") as { nextId: (prefix: string, ids: unknown[]) => string };

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const decoder = new TextDecoder();

async function readJson(u: vscode.Uri, def: any) {
  try { return JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(u))); } catch { return def; }
}

async function activeProject(): Promise<vscode.Uri | undefined> {
  const p = await vscode.workspace.findFiles("**/01-project-description/project.json", "**/node_modules/**", 1);
  return p[0] ? vscode.Uri.joinPath(p[0], "..", "..") : undefined;
}

/** Browse the OT knowledge-base catalogues and import entries into the active project. */
export async function openKbBrowser(ctx: vscode.ExtensionContext) {
  const workspaceLibs = await vscode.workspace.findFiles("**/knowledge-base/**/*.json", "**/node_modules/**");
  const runtimeLib = vscode.Uri.joinPath(ctx.extensionUri, "runtime", ".assets", "knowledge-base", "field-device-library.json");
  const importedRoot = vscode.Uri.joinPath(ctx.globalStorageUri, "knowledge-base", "imported");
  const importedLibs: vscode.Uri[] = [];
  try {
    const stack = [importedRoot.fsPath];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) importedLibs.push(vscode.Uri.file(full));
      }
    }
  } catch { }
  const libs = [runtimeLib, ...workspaceLibs, ...importedLibs];
  const threats: any[] = []; const cms: any[] = [];
  for (const u of libs) {
    const j = await readJson(u, {});
    (j.threats || []).forEach((t: any) => threats.push({ ...t, _src: u.path.split("/").pop() }));
    (j.countermeasures || []).forEach((c: any) => cms.push({ ...c, _src: u.path.split("/").pop() }));
  }
  const panel = vscode.window.createWebviewPanel("embedriskKb", "EmbedRisk · Knowledge Base", vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")] });
  const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "tra-ui.css"));
  const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "embedrisk-logo.svg"));
  const nonce = String(Math.random()).slice(2);
  const csp = `default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const tRows = threats.map((t, i) => `<tr><td class=idcell>${esc(t.key)}</td><td>${esc(t.title)}</td><td><span class="chip static">${esc((t.stride || []).join(""))}</span></td><td class=hint>${esc((t.appliesTo || []).join(", "))}</td><td>${esc(t.typicalImpact ?? "")}</td><td><button class="btn sm primary" data-act="threat" data-i="${i}">Add to project</button></td></tr>`).join("");
  const cRows = cms.map((c, i) => `<tr><td class=idcell>${esc(c.key)}</td><td>${esc(c.title)}</td><td class=hint>${esc((c.for || []).join(", "))}</td><td><button class="btn sm primary" data-act="cm" data-i="${i}">Add to project</button></td></tr>`).join("");
  panel.webview.html = `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${cssUri}"></head><body>
  <div class="topbar"><div class="brand"><img class="logo" src="${logoUri}" alt="" width="22" height="22"><span>EmbedRisk <small>· Knowledge base</small></span></div></div>
  <div class="main">
  <p class="hint">Reusable threats and countermeasures for the active project.</p>
  <div class="card"><h2>Threats</h2><table class="grid"><thead><tr><th>Key</th><th>Title</th><th>STRIDE</th><th>Applies to</th><th>Impact</th><th></th></tr></thead><tbody>${tRows || "<tr><td colspan=6 class=hint>No catalogue found.</td></tr>"}</tbody></table></div>
  <div class="card"><h2>Countermeasures</h2><table class="grid"><thead><tr><th>Key</th><th>Title</th><th>For</th><th></th></tr></thead><tbody>${cRows || "<tr><td colspan=4 class=hint>No catalogue found.</td></tr>"}</tbody></table></div>
  </div>
  <script nonce="${nonce}">const v=acquireVsCodeApi();document.addEventListener('click',function(e){var b=e.target.closest('button[data-act]');if(!b)return;v.postMessage({cmd:'import',kind:b.dataset.act,i:+b.dataset.i});});</script>
  </body></html>`;

  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.cmd !== "import") return;
    const proj = await activeProject();
    if (!proj) { vscode.window.showWarningMessage("No active EmbedRisk project found."); return; }
    if (m.kind === "threat") {
      const src = threats[m.i];
      const u = vscode.Uri.joinPath(proj, "06-threats/threats.json");
      const doc = await readJson(u, { threats: [] });
      const id = nextId("T", (doc.threats || []).map((t: any) => t.id));
      doc.threats = doc.threats || [];
      doc.threats.push({ id, title: src.title, stride: src.stride || [], components: [], assets: [], likelihood: 3, impact: src.typicalImpact || 3, status: "open", source: "knowledge-base:" + src.key });
      await vscode.workspace.fs.writeFile(u, Buffer.from(JSON.stringify(doc, null, 2)));
      vscode.window.showInformationMessage(`Imported threat ${id}. Assign affected components in the wizard.`);
    } else {
      const src = cms[m.i];
      const u = vscode.Uri.joinPath(proj, "08-countermeasures/countermeasures.json");
      const doc = await readJson(u, { countermeasures: [] });
      const id = nextId("CM", (doc.countermeasures || []).map((c: any) => c.id));
      doc.countermeasures = doc.countermeasures || [];
      doc.countermeasures.push({ id, title: src.title, type: "preventive", status: "proposed", components: [], addresses: [], source: "knowledge-base:" + src.key });
      await vscode.workspace.fs.writeFile(u, Buffer.from(JSON.stringify(doc, null, 2)));
      vscode.window.showInformationMessage(`Imported countermeasure ${id}. Link it to threats in the wizard.`);
    }
  }, undefined, ctx.subscriptions);
}
