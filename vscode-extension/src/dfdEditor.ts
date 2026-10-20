import * as vscode from "vscode";
import { dfdToDrawio } from "../../tools/dfd-to-drawio.mjs";
import { drawioToDfd } from "../../tools/drawio-to-dfd.mjs";

// Shared webapp-compatible id scheme (prefix + lowest free number), from the isomorphic DFD model.
const { nextId } = require("../media/dfd-model.js") as { nextId: (prefix: string, ids: unknown[]) => string };

// Custom editor for dfd.json: embeds the real draw.io editor (embed protocol) and syncs both ways.
// Uses a locally vendored draw.io (media/drawio) when present (offline); otherwise the hosted embed.
export class DfdEditor implements vscode.CustomTextEditorProvider {
  layer = 1;
  constructor(private extUri: vscode.Uri) {}
  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const media = vscode.Uri.joinPath(this.extUri, "media", "drawio");
    const q = "?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&autosave=1";
    let base = "https://embed.diagrams.net/" + q;
    let local = "";
    try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(media, "index.html")); base = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "index.html")).toString() + q; local = media.toString(); } catch { /* use hosted */ }
    panel.webview.options = { enableScripts: true, localResourceRoots: local ? [media] : [] };
    const dfd = () => JSON.parse(doc.getText() || '{"nodes":[],"flows":[]}');
    const writeDfd = async (obj: any) => { const ed = new vscode.WorkspaceEdit(); ed.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(obj, null, 2)); await vscode.workspace.applyEdit(ed); };
    let focus: string | null = null;
    const path: string[] = [];                                  // drill-down stack of component ids
    const parent = () => (path.length ? path[path.length - 1] : null);
    const lbl = (id: string | null) => (dfd().nodes as any[]).find((n) => n.id === id)?.label ?? id;
    const sibs = () => (dfd().nodes as any[]).filter((n) => (n.parent ?? null) === parent() && n.type !== "trust-boundary");
    const ensureFocus = () => { if (!focus) { const s = sibs(); if (s.length) focus = s[0].id; } };  // auto-select first component
    const push = () => { ensureFocus(); panel.webview.postMessage({ type: "load", xml: dfdToDrawio(dfd(), path.length + 1, focus as any, parent() as any) }); };
    const status = () => { ensureFocus(); const crumb = ["root", ...path.map((id) => lbl(id))].join(" / "); const cur = sibs().find((n) => n.id === focus); panel.webview.postMessage({ type: "status", layer: crumb, label: cur ? cur.label : "(none)" }); };
    const csp = `default-src 'none'; img-src ${panel.webview.cspSource} https: data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource} 'unsafe-inline'; frame-src ${panel.webview.cspSource} https://embed.diagrams.net;`;
    panel.webview.html = `<!doctype html><meta charset=utf8><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{height:100%;margin:0}#f{position:absolute;top:30px;left:0;right:0;bottom:0;width:100%;border:0}#bar{height:30px;box-sizing:border-box;background:#222;color:#fff;padding:5px 8px;font:12px system-ui}button{font:11px system-ui;margin:0 2px}</style>
    <div id=bar><b id=l>root</b> <button title="parent" onclick="nav(-1)">&#9650;</button><button title="into component" onclick="nav(1)">&#9660;</button> &middot; component <b id=c>(none)</b> <button onclick="sib(-1)">&#9664;</button><button onclick="sib(1)">&#9654;</button> &middot; Ctrl+Alt+arrows &middot; autosaves</div>
    <iframe id=f src="${base}"></iframe>
    <script>const v=acquireVsCodeApi(),f=document.getElementById('f'),lEl=document.getElementById('l'),cEl=document.getElementById('c');let xml='';
    function nav(d){v.postMessage({type:'nav',dir:d});}function sib(d){v.postMessage({type:'sib',dir:d});}
    addEventListener('message',e=>{const d=e.data;if(d&&d.type==='load'){xml=d.xml;f.contentWindow.postMessage(JSON.stringify({action:'load',xml}),'*');return;}if(d&&d.type==='status'){lEl.textContent=d.layer;cEl.textContent=d.label;return;}let p=d;if(typeof d==='string'){try{p=JSON.parse(d);}catch{return;}}if(!p||!p.event)return;if(p.event==='init')f.contentWindow.postMessage(JSON.stringify({action:'load',xml}),'*');if(p.event==='autosave'||p.event==='save')v.postMessage({type:'save',xml:p.xml});});
    onkeydown=e=>{if(e.ctrlKey&&e.altKey){if(e.key==='ArrowDown'){nav(1);e.preventDefault();}if(e.key==='ArrowUp'){nav(-1);e.preventDefault();}if(e.key==='ArrowRight'){sib(1);e.preventDefault();}if(e.key==='ArrowLeft'){sib(-1);e.preventDefault();}}};</script>`;
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "save") {
        await writeDfd(drawioToDfd(m.xml, dfd(), path.length + 1, parent() as any));
      } else if (m.type === "nav" && m.dir > 0) {                // descend into the focused component
        if (!focus) { vscode.window.showInformationMessage("Select a component with \u25C0 \u25B6 first, then descend."); return; }
        const kids = (dfd().nodes as any[]).filter((n) => (n.parent ?? null) === focus);
        if (!kids.length) {
          const c = await vscode.window.showInformationMessage(`'${lbl(focus)}' has no sub-components. Create one?`, "Create", "Cancel");
          if (c !== "Create") return;
          const d = dfd(); d.nodes.push({ id: nextId("N-", (d.nodes as any[]).map((n) => n.id)), label: `Sub-component of ${lbl(focus)}`, type: "process", parent: focus, layer: path.length + 2 }); await writeDfd(d);
        }
        path.push(focus); focus = null; push(); status();
      } else if (m.type === "nav") {                             // up to parent
        if (path.length) { path.pop(); focus = null; push(); status(); }
      } else if (m.type === "sib") {
        const s = sibs(); if (s.length) { let i = s.findIndex((n) => n.id === focus); i = (i + (m.dir > 0 ? 1 : -1) + s.length) % s.length; focus = s[i].id; push(); status(); }
      }
    });
    setTimeout(() => { push(); status(); }, 1200);
  }
}
