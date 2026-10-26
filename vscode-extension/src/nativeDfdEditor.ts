import * as vscode from "vscode";

// Native DFD canvas: renders dfd.json directly in a webview (no iframe), so keyboard navigation works
// and only DeMarco shapes exist. Recursive layers via parent drill-down. A right-hand inspector edits
// the selected node/boundary (label, type, linked component, trust-boundary members, data flows).
// Two-way sync with the JSON file. The schema is identical to the tra-webapp so projects interchange.
export class NativeDfdEditor implements vscode.CustomTextEditorProvider {
  constructor(private extUri: vscode.Uri) { }

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const media = vscode.Uri.joinPath(this.extUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const modelUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "dfd-model.js"));
    const riskUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "risk-model.js"));
    const visibilityUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "layer-visibility.js"));
    const strideUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "stride-model.js"));
    const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "tra-ui.css"));
    const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "embedrisk-logo.svg"));
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource};`;

    const projRoot = vscode.Uri.joinPath(doc.uri, "..", "..");
    const readSystemData = async () => {
      try {
        const sys = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "03-system-assets/system.json"))).toString());
        return {
          system: sys,
          components: (sys.components || []).map((c: any) => ({ id: c.id, name: c.name, kind: c.kind, parent: c.parent })),
          interfaces: (sys.interfaces || []).map((itf: any) => ({
            id: itf.id, name: itf.name, tag: itf.tag || '',
            component: itf.component || '', exposure: itf.exposure || '',
            protocol: itf.protocol || '', category: itf.category || '',
            hidden: !!itf.hidden,
          })),
          trustBoundaryIds: (sys.trustBoundaries || []).map((b: any) => b.id).filter((id: any) => typeof id === "string"),
        };
      } catch { return { system: {}, components: [], interfaces: [], trustBoundaryIds: [] }; }
    };

    let lastText = "";
    const readMatrixData = async () => {
      try {
        const threatsDoc = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "06-threats/threats.json"))).toString());
        const cmsDoc = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "08-countermeasures/countermeasures.json"))).toString());
        const project = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "01-project-description/project.json"))).toString());
        const scheme = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extUri, "runtime/.assets/knowledge-base/risk-scheme.json"))).toString());
        return { threats: threatsDoc.threats || [], cms: cmsDoc.countermeasures || [], acceptableRisk: project.acceptableRisk, scheme };
      } catch { return { threats: [], cms: [], acceptableRisk: undefined, scheme: null }; }
    };
    const readRiskData = async (): Promise<Record<string, string>> => {
      try {
        const threats = (JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "06-threats/threats.json"))).toString())).threats || [];
        const cms = (JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "08-countermeasures/countermeasures.json"))).toString())).countermeasures || [];
        const BANDS = [{ min: 1, max: 5, color: '#2e7d32' }, { min: 6, max: 11, color: '#f9a825' }, { min: 12, max: 19, color: '#ef6c00' }, { min: 20, max: 25, color: '#c62828' }];
        // Same rules as riskOf in webapp/client/src/lib/risk.ts: score <= 0 is the grey "None" band, unfeasible threats
        // have no residual risk, and deselected countermeasures (selected === false) are ignored.
        const NONE_COLOR = '#6b7280';
        const getBandColor = (score: number) => score <= 0 ? NONE_COLOR : (BANDS.find(b => score >= b.min && score <= b.max) || BANDS[0]).color;
        const selectedCms = cms.filter((c: any) => c.selected !== false);
        const compWorst: Record<string, { score: number; color: string }> = {};
        threats.forEach((t: any) => {
          let rl = t.likelihood, ri = t.impact;
          if (t.status === 'unfeasible') {
            rl = 0; ri = 0;
          } else {
            const links = selectedCms.flatMap((c: any) => (c.addresses || []).filter((a: any) => a.threat === t.id));
            for (const a of links) {
              rl = Math.min(rl, a.residualLikelihood ?? t.likelihood);
              ri = Math.min(ri, a.residualImpact ?? t.impact);
            }
          }
          const score = (rl || 0) * (ri || 0);
          const color = getBandColor(score);
          (t.components || []).forEach((cid: string) => {
            if (!compWorst[cid] || score > compWorst[cid].score) compWorst[cid] = { score, color };
          });
        });
        return Object.fromEntries(Object.entries(compWorst).map(([k, v]) => [k, v.color]));
      } catch { return {}; }
    };
    const post = async () => {
      const sys = await readSystemData();
      const riskData = await readRiskData();
      const matrixData = await readMatrixData();
      panel.webview.postMessage({ type: "load", dfd: doc.getText() || '{"nodes":[],"flows":[]}', system: sys.system, components: sys.components, interfaces: sys.interfaces, trustBoundaryIds: sys.trustBoundaryIds, riskData, ...matrixData });
    };
    let strideWriteQueue = Promise.resolve();
    let lastStrideWriteText: string | undefined;
    const saveStrideEdit = async (m: any) => {
      if (typeof m.pairKey !== "string" || typeof m.endpointId !== "string") return;
      const systemUri = vscode.Uri.joinPath(projRoot, "03-system-assets/system.json");
      const system = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(systemUri)).toString());
      const analyses = system.strideAnalyses || (system.strideAnalyses = {});
      const analysis = analyses[m.pairKey] || (analyses[m.pairKey] = {});
      const endpoints = analysis.endpoints || (analysis.endpoints = {});
      const endpoint = endpoints[m.endpointId] || (endpoints[m.endpointId] = {});
      if (m.kind === "label" && typeof m.value === "string") {
        const label = m.value.trim();
        if (label) endpoint.label = label;
        else delete endpoint.label;
      } else if (m.kind === "cell" && typeof m.strideKey === "string" &&
          ["S", "T", "R", "I", "D", "E"].includes(m.strideKey) &&
          (m.field === "strengths" || m.field === "weaknesses") && typeof m.value === "string") {
        const cells = endpoint.cells || (endpoint.cells = {});
        const cell = cells[m.strideKey] || (cells[m.strideKey] = {});
        const lines = m.value.split("\n");
        cell[m.field] = lines.length === 1 && lines[0] === "" ? [] : lines;
      } else return;
      const text = JSON.stringify(system, null, 2);
      await vscode.workspace.fs.writeFile(systemUri, Buffer.from(text));
      lastStrideWriteText = text;
    };
    const refreshSystem = async () => {
      if (lastStrideWriteText !== undefined) {
        try {
          const current = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, "03-system-assets/system.json"))).toString();
          if (current === lastStrideWriteText) return;
        } catch { /* a deleted file should still refresh the editor's system view */ }
      }
      await post();
    };
    const save = async (text: string) => {
      lastText = text;
      const ed = new vscode.WorkspaceEdit();
      ed.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
      await vscode.workspace.applyEdit(ed);
    };

    panel.webview.html = this.html(modelUri, riskUri, visibilityUri, strideUri, cssUri, logoUri, csp, nonce);

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === doc.uri.toString() && e.document.getText() !== lastText) post();
    });
    const systemWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projRoot, "03-system-assets/system.json"));
    systemWatcher.onDidChange(refreshSystem);
    systemWatcher.onDidCreate(refreshSystem);
    systemWatcher.onDidDelete(refreshSystem);
    panel.onDidDispose(() => { sub.dispose(); systemWatcher.dispose(); });

    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "ready") { await post(); }
      else if (m.type === "save") { await save(m.dfd); }
      else if (m.type === "strideEdit") {
        strideWriteQueue = strideWriteQueue.then(() => saveStrideEdit(m));
        await strideWriteQueue;
      }
      else if (m.type === "navigateThreat" && typeof m.threatId === "string") {
        await vscode.commands.executeCommand("embedrisk.wizard", m.threatId);
      }
    });
  }

  private html(modelUri: vscode.Uri, riskUri: vscode.Uri, visibilityUri: vscode.Uri, strideUri: vscode.Uri, cssUri: vscode.Uri, logoUri: vscode.Uri, csp: string, nonce: string): string {
    return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
<style>
html,body{height:100%;margin:0;font:13px system-ui;color:var(--text);background:var(--bg)}
body{display:flex;flex-direction:column}
#bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:var(--surface);color:var(--text);border-bottom:1px solid var(--border);flex:0 0 auto;z-index:2}
#bar b{margin-right:6px}
#bar button{font:12px system-ui;padding:4px 9px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:7px;cursor:pointer}
#bar button:hover{background:var(--surface-2)}
#bar button.on{background:var(--accent);border-color:var(--accent);color:#fff}
#bar button:disabled{opacity:.4;cursor:default}
#bar button:disabled:hover{background:var(--surface)}
#bar .brand{display:flex;align-items:center;gap:6px;margin-right:2px}
#bar .brand .logo{width:18px;height:18px;display:block}
#bar select{font:12px system-ui;padding:3px 6px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:7px;max-width:190px}
#crumb{color:var(--accent);margin-right:8px}
#status{color:var(--accent-2);font-size:11px}
#hint{margin-left:auto;color:var(--text-faint);font-size:11px}
#body{flex:1 1 auto;display:flex;min-height:0}
#wrap{flex:1 1 auto;min-height:0;overflow:auto;position:relative;color:var(--text)}
#insp{flex:0 0 300px;border-left:1px solid var(--border);background:var(--surface);overflow:auto;padding:12px}
#insp h3{font-size:13px;margin:0 0 8px}
.risk-matrix{margin:14px 0 6px;max-width:none}
.risk-matrix table{width:100%;border-spacing:2px;table-layout:fixed;margin-top:6px}
.risk-matrix th{font-weight:normal;color:var(--text-dim)}
.risk-matrix td[data-l]{position:relative;height:30px;text-align:center;border:2px solid transparent;font-size:10px}
.risk-matrix td>.matrix-colour{position:absolute;inset:0;opacity:.42;border-radius:3px}
.risk-matrix td.hit{color:#fff;text-shadow:0 1px 2px #000}
.risk-matrix td.hit>.matrix-colour{opacity:1}
.risk-matrix td>.matrix-colour+span,.risk-matrix small,.risk-matrix b{position:relative}
.risk-matrix .bandmark{margin-left:1px;font-size:8px}
.risk-matrix .n{display:block;font-size:10px;min-height:11px}
.risk-matrix td.boundary-top{border-top-color:var(--text)}
.risk-matrix td.boundary-right{border-right-color:var(--text)}
.risk-matrix .matrix-legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;font-size:10px}
.risk-matrix .matrix-legend i{display:inline-block;width:9px;height:9px;border-radius:2px}
.risk-matrix .matrix-legend .threshold-key{border-top:2px solid var(--text);height:0;vertical-align:middle}
#insp .matrix-modes{display:flex;gap:4px}
#insp .matrix-modes button{font:11px system-ui;padding:3px 7px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:6px}
#insp .matrix-modes button[aria-pressed="true"]{border-color:var(--accent);background:var(--surface-2)}
svg{display:block}
#ov{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;z-index:10}
#ovbox{background:var(--surface);color:var(--text);padding:14px;border-radius:8px;min-width:280px;border:1px solid var(--border)}
#ovbox input{width:100%;padding:6px;margin:8px 0;background:var(--surface);color:var(--text);border:1px solid var(--border-strong);border-radius:6px}
#ovbox .r{display:flex;gap:8px;justify-content:flex-end}
.conn{display:flex;align-items:center;gap:6px;margin:4px 0}
.conn .peer{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stride-overlay{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:18px}
.stride-dialog{box-sizing:border-box;width:min(1120px,100%);max-height:94vh;overflow:auto;background:var(--surface);color:var(--text);padding:16px;border:1px solid var(--border);border-radius:10px}
.stride-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.stride-dialog h2{font-size:17px;margin:0}
.stride-dialog>header button{flex:0 0 auto}
.stride-dialog .stride-pair{margin:14px 0;padding:10px;border:1px solid var(--border);border-radius:8px}
.stride-dialog .stride-pair h3{font-size:13px;margin:4px 0 8px}
.stride-dialog .stride-labels{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.stride-dialog .stride-labels label{display:flex;flex-direction:column;gap:4px}
.stride-dialog table{width:100%;border-collapse:collapse;font-size:12px}
.stride-dialog th,.stride-dialog td{padding:4px;border-top:1px solid var(--border);vertical-align:top}
.stride-dialog thead th{text-align:center;border-bottom:1px solid var(--border)}
.stride-dialog tbody th{text-align:left;white-space:nowrap}
.stride-dialog textarea{box-sizing:border-box;width:100%;min-height:54px;resize:vertical;font:12px system-ui}
.stride-dialog [data-stride-heading]{border-left:2px solid var(--border)}
.stride-dialog .stride-empty{margin:18px 0}
</style></head><body>
<div id="bar">
  <span class="brand"><img class="logo" src="${logoUri}" alt=""><b>EmbedRisk</b></span>
  <span id="crumb">root</span>
  <button data-act="up" title="parent layer (Backspace)">&#9650; up</button>
  <button data-act="down" title="into component (Enter)">&#9660; in</button>
  <select id="sel" title="Select a node or trust boundary to edit"><option value="">Select&hellip;</option></select>
  <span style="width:8px"></span>
  <button data-act="add" data-type="external-entity" title="x">+ External</button>
  <button data-act="add" data-type="process" title="p">+ Process</button>
  <button data-act="add" data-type="multiprocess" title="m">+ Multiproc</button>
  <button data-act="add" data-type="store" title="s">+ Store</button>
  <button data-act="add" data-type="trust-boundary" title="b">+ Boundary</button>
  <button id="cbtn" data-act="connect" title="t">Connect</button>
  <button data-act="del" title="d / Del">Delete</button>
  <span style="width:8px"></span>
  <button id="undo" data-act="undo" title="Undo (Ctrl+Z)" disabled>&#8630; Undo</button>
  <button id="redo" data-act="redo" title="Redo (Ctrl+Shift+Z)" disabled>&#8631; Redo</button>
  <span id="status"></span>
  <span id="hint">&larr;&rarr; select &middot; Enter in &middot; Backspace up &middot; t connect</span>
</div>
<div id="body">
  <div id="wrap"><svg id="cv" xmlns="http://www.w3.org/2000/svg"></svg></div>
  <aside id="insp"></aside>
</div>
<div id="ov"><div id="ovbox"><div id="ovlabel"></div><input id="ovinput"><div class="r"><button class="btn" id="ovcancel">Cancel</button><button class="btn primary" id="ovok">OK</button></div></div></div>
<script nonce="${nonce}" src="${modelUri}"></script>
<script nonce="${nonce}" src="${riskUri}"></script>
<script nonce="${nonce}" src="${visibilityUri}"></script>
<script nonce="${nonce}" src="${strideUri}"></script>
<script nonce="${nonce}">
const M=DfdModel, R=window.RiskModel, V=window.LayerVisibilityModel, S=window.StrideModel, vs=acquireVsCodeApi();
const TYPES=['external-entity','process','multiprocess','store','trust-boundary'];
let dfd={nodes:[],flows:[]}, system={}, components=[], interfaces=[], trustBoundaryIds=[], riskData={}, threats=[], cms=[], riskScheme=null, acceptableRisk, matrixMode='residual', stack=[], focus=null, connect=false, connectFrom=null, strideOverlay=null;
let drag=null, chipDrag=null, portDrag=null, dragMoved=false, dragging=false;
let renderedNodePositions=new Map();
const $=id=>document.getElementById(id);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function cur(){return stack.length?stack[stack.length-1]:null;}
function sibs(){return M.siblings(dfd,cur());}
function node(id){return dfd.nodes.find(x=>x.id===id);}
function label(id){var n=node(id);return n?n.label:id;}
function endpointLabel(id){var n=node(id);if(n)return n.label;var itf=(interfaces||[]).find(function(x){return x.id===id;});return itf?(itf.tag||itf.name):id;}
function ensureFocus(){var s=sibs();var n=focus?node(focus):null;var pv=n?(n.parent==null?null:n.parent):undefined;
  if(focus&&focus.indexOf('flow:')===0&&dfd.flows.some(function(f){return f.id===focus.slice(5);}))return;
  if(focus&&focus.indexOf('iface:')===0&&(interfaces||[]).some(function(itf){return itf.id===focus.slice(6)&&!itf.hidden;}))return;
  if(focus&&focus.indexOf('port:')===0)return;
  if(!n||pv!==cur())focus=s.length?s[0].id:null;}

/* ---- undo / redo: webview-local snapshots of dfd.json, mirroring the tra-webapp history ---- */
let undoStack=[], redoStack=[], baseState=null, histKey='', histTime=0;
function snap(){return JSON.stringify(dfd);}
function updUndo(){var u=$('undo'),r=$('redo');if(u)u.disabled=!undoStack.length;if(r)r.disabled=!redoStack.length;}
function commit(key){
  var now=Date.now();
  var coalesce=undoStack.length&&key&&key===histKey&&(now-histTime<800);
  if(baseState!=null&&!coalesce){undoStack.push(baseState);if(undoStack.length>120)undoStack.shift();redoStack=[];}
  histKey=key||('u'+now);histTime=now;baseState=snap();updUndo();
  vs.postMessage({type:'save',dfd:JSON.stringify(dfd,null,2)});
}
function persist(key){commit(key||'');}
function restore(json){try{dfd=JSON.parse(json);}catch(_){return false;}if(!dfd.nodes)dfd.nodes=[];if(!dfd.flows)dfd.flows=[];return true;}
function undo(){if(!undoStack.length)return;redoStack.push(snap());var p=undoStack.pop();if(!restore(p))return;baseState=p;histKey='';focus=null;updUndo();vs.postMessage({type:'save',dfd:JSON.stringify(dfd,null,2)});draw();}
function redo(){if(!redoStack.length)return;undoStack.push(snap());var n=redoStack.pop();if(!restore(n))return;baseState=n;histKey='';focus=null;updUndo();vs.postMessage({type:'save',dfd:JSON.stringify(dfd,null,2)});draw();}

function worstRiskForNode(nodeId){
  var BAND_ORDER={'#2e7d32':1,'#f9a825':2,'#ef6c00':3,'#c62828':4};
  var n=node(nodeId); if(!n)return null;
  var directColor=(n.componentRef&&riskData[n.componentRef])?riskData[n.componentRef]:null;
  var worstScore=directColor?(BAND_ORDER[directColor]||0):0;
  var worstColor=directColor;
  dfd.nodes.filter(function(c){return c.parent===nodeId;}).forEach(function(c){
    var childColor=worstRiskForNode(c.id);
    if(childColor&&(BAND_ORDER[childColor]||0)>worstScore){worstScore=BAND_ORDER[childColor]||0;worstColor=childColor;}
  });
  return worstColor;
}
function drawCanvas(){
  // Build risk color map using subtree propagation so root-level nodes inherit sub-component risk
  var nodeRisk={};
  var visibleRealNodes=M.viewNodes(dfd,cur()).filter(function(n){return n.type!=='trust-boundary';});
  visibleRealNodes.forEach(function(n){var c=worstRiskForNode(n.id);if(c)nodeRisk[n.id]=c;});
  var compById=new Map((components||[]).map(function(c){return [c.id,c];}));
  var visibleRealNodeIds=new Set(visibleRealNodes.map(function(n){return n.id;}));
  var visibleIfaceIds=V.deriveVisibleInterfaceIds({
    currentParent:cur(),nodes:dfd.nodes,compById:compById,interfaces:interfaces,flows:dfd.flows,visibleRealNodes:visibleRealNodes
  });
  var visibleFlows=dfd.flows.filter(function(flow){return V.flowBelongsToLayerContext({
    flow:flow,currentParent:cur(),visibleRealNodeIds:visibleRealNodeIds,visibleIfaceIds:visibleIfaceIds,
    nodes:dfd.nodes,compById:compById,interfaces:interfaces
  });});
  // Layout/render a copy: DfdModel.layout assigns default coordinates to nodes without positions.
  var renderDfd={...dfd,nodes:dfd.nodes.map(function(n){return {...n};}),flows:visibleFlows};
  var positionedNodes=M.layout(renderDfd,cur()).filter(function(n){return n.type!=='trust-boundary';});
  var inner=M.render(renderDfd,cur(),focus,nodeRisk);
  var positionedById=new Map(positionedNodes.map(function(n){return [n.id,n];}));
  renderedNodePositions=positionedById;
  var ifacePositions=new Map();
  // Render only interfaces selected by the shared layer-visibility model.
  var ifaceChips='';
  (interfaces||[]).forEach(function(itf){
    if(!visibleIfaceIds.has(itf.id)||!itf.component)return;
    var targetId=V.resolveTargetNodeId(itf.component,visibleRealNodes,compById);
    var nb=positionedById.get(targetId);
    if(!nb)return;
    var posKey=(cur()||'root')+':'+itf.id;
    var cp=(dfd.ifacePos||{})[posKey];
    var cx=cp?cp.x:((nb.x||0)+4), cy=cp?cp.y:((nb.y||0)-50);
    ifacePositions.set(itf.id,{x:cx,y:cy});
    var lbl=esc((itf.tag||itf.name).slice(0,13));
    var tx=(nb.x||0)+65, ty=(nb.y||0)+28; // midpoint of target node
    var isFocus=focus==='iface:'+itf.id;
    ifaceChips+='<g class="ifacechip" data-iface="'+esc(itf.id)+'" style="cursor:pointer">'+
      '<line x1="'+(cx+40)+'" y1="'+(cy+14)+'" x2="'+tx+'" y2="'+ty+'" stroke="#777" stroke-dasharray="4 3" stroke-width="1.2"/>'+
      '<rect x="'+cx+'" y="'+cy+'" width="80" height="28" rx="6" fill="var(--surface)" stroke="'+(isFocus?'#1565c0':'#5c8df6')+'" stroke-width="'+(isFocus?2:1.2)+'"/>'+
      '<text x="'+(cx+40)+'" y="'+(cy+17)+'" text-anchor="middle" font-size="10" fill="#5c8df6">'+lbl+'</text>'+
    '</g>';
  });
  var contextPortIds=new Set(),portPositions=new Map(),portInfo=new Map();
  if(cur()){
    var currentNode=node(cur());
    var currentParent=currentNode&&currentNode.parent!=null?currentNode.parent:null;
    var externalSiblings=new Set(dfd.nodes.filter(function(n){return (n.parent==null?null:n.parent)===currentParent&&n.id!==cur()&&n.type!=='trust-boundary';}).map(function(n){return n.id;}));
    var interfaceIds=new Set((interfaces||[]).map(function(itf){return itf.id;}));
    var parentInterfaceIds=new Set((interfaces||[]).filter(function(itf){return currentNode&&itf.component===currentNode.componentRef;}).map(function(itf){return itf.id;}));
    var directVisible=function(id){return visibleRealNodeIds.has(id)||visibleIfaceIds.has(id);};
    var addPort=function(id,dir,flowLabel){
      if(directVisible(id))return;
      var info=portInfo.get(id)||{in:false,out:false,labels:[]};
      info[dir]=true;if(flowLabel)info.labels.push(flowLabel);portInfo.set(id,info);
    };
    visibleFlows.forEach(function(flow){
      var fromDirect=directVisible(flow.from),toDirect=directVisible(flow.to);
      var hiddenEndpoint=fromDirect?flow.to:flow.from;
      if(fromDirect!==toDirect&&(externalSiblings.has(hiddenEndpoint)||interfaceIds.has(hiddenEndpoint)))addPort(hiddenEndpoint,fromDirect?'out':'in',flow.label);
      var other=flow.from===cur()?flow.to:flow.to===cur()?flow.from:null;
      if(other&&(externalSiblings.has(other)||interfaceIds.has(other)))addPort(other,flow.from===cur()?'out':'in',flow.label);
      if(parentInterfaceIds.has(flow.from)||parentInterfaceIds.has(flow.to)){
        var parentIface=parentInterfaceIds.has(flow.from)?flow.from:flow.to;
        addPort(parentIface,parentIface===flow.from?'out':'in',flow.label);
      }
      if(visibleRealNodeIds.has(flow.from)&&(externalSiblings.has(flow.to)||interfaceIds.has(flow.to)))addPort(flow.to,'out',flow.label);
      if(visibleRealNodeIds.has(flow.to)&&(externalSiblings.has(flow.from)||interfaceIds.has(flow.from)))addPort(flow.from,'in',flow.label);
    });
    var minY=positionedNodes.reduce(function(y,n){return Math.min(y,typeof n.y==='number'?n.y:70);},70);
    Array.from(portInfo.entries()).forEach(function(entry,i){
      var id=entry[0],info=entry[1],key=(cur()||'root')+':'+id,placed=(dfd.portPos||{})[key];
      var px=placed?placed.x:40+i*164,py=placed?placed.y:Math.max(10,minY-68);
      contextPortIds.add(id);portPositions.set(id,{x:px,y:py});var endpointNode=node(id),endpointIface=(interfaces||[]).find(function(itf){return itf.id===id;});
      var name=endpointIface?(endpointIface.tag||endpointIface.name):(endpointNode?endpointNode.label:id);
      var direction=info.in&&info.out?'⇄':info.out?'→':'←';
      portInfo.set(id,{in:info.in,out:info.out,labels:info.labels,name:name,direction:direction,x:px,y:py});
    });
  }
  var ifaceFlows='';
  visibleFlows.forEach(function(flow){
    var fromIface=visibleIfaceIds.has(flow.from)||contextPortIds.has(flow.from),toIface=visibleIfaceIds.has(flow.to)||contextPortIds.has(flow.to);
    if(!fromIface&&!toIface)return;
    var endpointPoint=function(id){
      var chip=ifacePositions.get(id);if(chip)return{x:chip.x+40,y:chip.y+14};
      var port=portPositions.get(id);if(port)return{x:port.x+75,y:port.y+21};
      var endpoint=positionedById.get(id);return endpoint?{x:(endpoint.x||0)+65,y:(endpoint.y||0)+28}:null;
    };
    var start=endpointPoint(flow.from),end=endpointPoint(flow.to);if(!start||!end)return;
    var x1=start.x,y1=start.y,x2=end.x,y2=end.y;
    var lx=(x1+x2)/2, ly=(y1+y2)/2-5;
    ifaceFlows+='<path data-flow="'+esc(flow.id)+'" d="M '+x1+' '+y1+' L '+x2+' '+y2+'" stroke="#666" stroke-width="1.5" fill="none" marker-end="url(#arrow)" style="cursor:pointer"/>'+
      (flow.label?'<text x="'+lx+'" y="'+ly+'" text-anchor="middle" font-size="10" fill="#555">'+esc(flow.label)+'</text>':'');
  });
  var portChips='';
  portInfo.forEach(function(info,id){
    var lbl=esc((info.name||id).slice(0,18)),detail=esc(info.direction+(info.labels.length?': '+Array.from(new Set(info.labels)).join(', '):''));
    var selected=focus==='port:'+id;
    portChips+='<g class="contextport" data-port="'+esc(id)+'" style="cursor:pointer">'+
      '<rect x="'+info.x+'" y="'+info.y+'" width="150" height="42" rx="6" fill="var(--surface)" stroke="'+(selected?'#1565c0':'#777')+'" stroke-width="'+(selected?2:1.2)+'"/>'+
      '<text x="'+(info.x+75)+'" y="'+(info.y+17)+'" text-anchor="middle" font-size="10" fill="currentColor">'+lbl+'</text>'+
      '<text x="'+(info.x+75)+'" y="'+(info.y+32)+'" text-anchor="middle" font-size="9" fill="#777">'+detail+'</text></g>';
  });
  var maxX=600,maxY=400;
  var ns=positionedNodes;
  ns.forEach(function(n){if(typeof n.x==='number')maxX=Math.max(maxX,n.x+220);if(typeof n.y==='number')maxY=Math.max(maxY,n.y+180);});
  ifacePositions.forEach(function(p){maxX=Math.max(maxX,p.x+100);maxY=Math.max(maxY,p.y+48);});
  portPositions.forEach(function(p){maxX=Math.max(maxX,p.x+170);maxY=Math.max(maxY,p.y+60);});
  var cv=$('cv');cv.setAttribute('width',maxX);cv.setAttribute('height',maxY);
  cv.innerHTML="<defs><marker id='arrow' markerWidth='9' markerHeight='9' refX='8' refY='3' orient='auto'><path d='M0,0L8,3L0,6' fill='#888'/></marker></defs>"+inner+ifaceFlows+ifaceChips+portChips;
  $('crumb').textContent=['root'].concat(stack.map(label)).join(' / ');
  $('cbtn').className=connect?'on':'';
  $('status').textContent=connect?(connectFrom?('Connect: click the target for '+endpointLabel(connectFrom)):'Connect: click the source node, interface, or context port'):'';
}
function chip(text,on,attrs,title){return '<span class="chip'+(on?' on':'')+'" role="button" tabindex="0" '+attrs+(title?' title="'+esc(title)+'"':'')+'>'+esc(text)+'</span>';}
function navigateThreat(id){vs.postMessage({type:'navigateThreat',threatId:id});}
function matrixThreatChooser(ids,opener){
  if(ids.length===1){navigateThreat(ids[0]);return;}
  if(ids.length<2)return;
  var overlay=document.createElement('div');overlay.className='matrix-threat-overlay';
  var dialog=document.createElement('div');dialog.className='matrix-threat-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','matrix-threat-title');
  var title=document.createElement('h2');title.id='matrix-threat-title';title.textContent='Threats at selected risk';
  var close=document.createElement('button');close.type='button';close.className='btn sm';close.setAttribute('aria-label','Close threat chooser');close.textContent='Close';
  var head=document.createElement('div');head.className='matrix-threat-head';head.appendChild(title);head.appendChild(close);dialog.appendChild(head);
  var finish=function(){overlay.remove();if(opener&&opener.focus)opener.focus();};
  close.addEventListener('click',finish);
  overlay.addEventListener('click',function(e){if(e.target===overlay)finish();});
  ids.forEach(function(id){
    var threat=threats.find(function(t){return t.id===id;});if(!threat)return;
    var button=document.createElement('button');button.type='button';button.className='matrix-threat-choice';
    button.textContent=String(id)+' — '+String(threat.title||'Untitled threat');
    button.addEventListener('click',function(){finish();navigateThreat(id);});
    dialog.appendChild(button);
  });
  overlay.appendChild(dialog);document.body.appendChild(overlay);close.focus();
}
function activateMatrixCell(cell){
  if(!cell||!cell.dataset.matrixThreats)return;
  var ids;try{ids=JSON.parse(cell.dataset.matrixThreats);}catch(_){return;}
  if(Array.isArray(ids))matrixThreatChooser(ids,cell);
}
function renderRiskMatrix(componentRef){
  if(!R||!R.matrix)return '<div class="risk-matrix">Risk matrix not available.</div>';
  var ids=null, rolledUp=false, scopedThreats=threats||[];
  if(componentRef){
    ids=new Set([componentRef]);
    var pending=[componentRef];
    while(pending.length){
      var parent=pending.pop();
      components.forEach(function(c){if(c.parent===parent&&!ids.has(c.id)){ids.add(c.id);pending.push(c.id);}});
    }
    rolledUp=ids.size>1;
    scopedThreats=scopedThreats.filter(function(t){return (t.components||[]).some(function(id){return ids.has(id);});});
  }
  var m=R.matrix(scopedThreats,cms,riskScheme,acceptableRisk,matrixMode);
  var html='<section class="risk-matrix" id="dfd-risk-matrix" aria-label="DFD risk matrix">'+
    '<h3>Risk matrix</h3><div class="matrix-modes" role="group" aria-label="Risk matrix mode">'+
    ['initial','residual'].map(function(mode){return '<button type="button" data-matrix-mode="'+mode+'" aria-pressed="'+(matrixMode===mode)+'">'+(mode==='initial'?'Initial':'Residual')+'</button>';}).join('')+
    '</div><table aria-label="'+matrixMode+' risk"><tbody>';
  m.cells.forEach(function(c){
    if(c.likelihood===1)html+='<tr><th scope="row">'+c.impact+'</th>';
    html+='<td data-l="'+c.likelihood+'" data-i="'+c.impact+'" '+(c.ids.length?'role="button" tabindex="0" data-matrix-threats="'+esc(JSON.stringify(c.ids))+'" aria-label="'+esc('Likelihood '+c.likelihood+' by impact '+c.impact+', '+c.band.name+', '+c.ids.length+' threat(s): '+c.ids.join(', ')+'. Activate to open.')+'" ':'')+'class="'+(c.ids.length?'hit ':'')+(c.boundaryTop?'boundary-top ':'')+(c.boundaryRight?'boundary-right':'')+'" title="'+esc('L'+c.likelihood+' × I'+c.impact+' = '+c.score+' ('+c.band.name+')'+(c.ids.length?' — '+c.ids.join(', '):''))+'">'+
      '<span class="matrix-colour" style="background-color:'+esc(c.band.color)+'"></span><span>'+c.score+'</span><small class="bandmark" aria-hidden="true">'+esc(c.band.name[0])+'</small><b class="n">'+(c.ids.length||'')+'</b></td>';
    if(c.likelihood===5)html+='</tr>';
  });
  html+='</tbody><tfoot><tr><td></td>'+[1,2,3,4,5].map(function(l){return '<th scope="col">'+l+'</th>';}).join('')+'</tr></tfoot></table>'+
    '<div class="hint">Likelihood → · Impact ↑ · '+matrixMode+' risk · '+(componentRef?'selected component'+(rolledUp?' + descendants':''):'all project')+'</div><div class="matrix-legend">'+
    m.bands.map(function(b){return '<span><i style="background-color:'+esc(b.color)+'"></i> '+esc(b.name)+'</span>';}).join('')+
    '<span><i class="threshold-key"></i> acceptable risk: '+esc(m.threshold)+'</span></div></section>';
  return html;
}
function renderInspector(){
  var selectedFlow=focus&&focus.indexOf('flow:')===0?dfd.flows.find(function(f){return f.id===focus.slice(5);}):null;
  if(selectedFlow){
    $('insp').innerHTML='<h3>Selected data flow</h3>'+
      '<div class="field"><label>From</label><div style="padding:4px 0">'+esc(endpointLabel(selectedFlow.from))+'</div></div>'+
      '<div class="field"><label>To</label><div style="padding:4px 0">'+esc(endpointLabel(selectedFlow.to))+'</div></div>'+
      '<div class="field"><label>Label</label><input class="inp" id="ins-flow-label" value="'+esc(selectedFlow.label||'')+'"></div>'+
      '<button class="btn sm danger" id="ins-delete-flow" data-delflow="'+esc(selectedFlow.id)+'">Delete flow</button>'+
      renderRiskMatrix(null);
    return;
  }
  var n=focus?node(focus):null;
  if(!n){
    // Check if an interface chip is focused
    var ifaceId=focus&&focus.startsWith('iface:')?focus.slice(6):null;
    var selIface=ifaceId?(interfaces||[]).find(function(f){return f.id===ifaceId&&!f.hidden;}):null;
    if(selIface){
      var ifaceFlows=dfd.flows.filter(function(f){return f.from===ifaceId||f.to===ifaceId;});
      $('insp').innerHTML='<h3>Interface chip</h3>'+
        '<div class="field"><label>Name</label><div style="padding:4px 0">'+esc(selIface.name)+'</div></div>'+
        (selIface.tag?'<div class="field"><label>Tag</label><div style="padding:4px 0">'+esc(selIface.tag)+'</div></div>':'')+
        '<div class="field"><label>Component</label><div style="padding:4px 0">'+esc((components.find(function(c){return c.id===selIface.component;})||{}).name||selIface.component||'—')+'</div></div>'+
        '<div class="field"><label>Category</label><div style="padding:4px 0">'+esc(selIface.category||'—')+'</div></div>'+
        '<div class="field"><label>Exposure</label><div style="padding:4px 0">'+esc(selIface.exposure||'—')+'</div></div>'+
        (selIface.protocol?'<div class="field"><label>Protocol</label><div style="padding:4px 0">'+esc(selIface.protocol)+'</div></div>':'')+
        (ifaceFlows.length?'<h3 style="margin-top:12px">Data flow</h3>'+ifaceFlows.map(function(f){return '<button class="btn sm" style="margin:2px" data-flow-select="'+esc(f.id)+'">'+esc(endpointLabel(f.from))+' → '+esc(endpointLabel(f.to))+'</button>';}).join(''):'')+
        '<p class="hint" style="margin-top:8px">Interface chips are defined in step 03 (System &amp; Assets) and automatically appear here when their component is on this layer.</p>'+
        renderRiskMatrix(null);
      return;
    }
    var portId=focus&&focus.indexOf('port:')===0?focus.slice(5):null;
    if(portId){
      var endpointFlows=dfd.flows.filter(function(f){return f.from===portId||f.to===portId;});
      $('insp').innerHTML='<h3>Context port</h3><div class="field"><label>Endpoint</label><div style="padding:4px 0">'+esc(endpointLabel(portId))+'</div></div>'+
        (endpointFlows.length?'<h3 style="margin-top:12px">Data flow</h3>'+endpointFlows.map(function(f){return '<button class="btn sm" style="margin:2px" data-flow-select="'+esc(f.id)+'">'+esc(endpointLabel(f.from))+' → '+esc(endpointLabel(f.to))+'</button>';}).join(''):'')+
        renderRiskMatrix(null);return;
    }
    $('insp').innerHTML='<h3>Inspector</h3><p class="hint">Select a node (click it, or use the arrow keys). Click a boundary label to edit its members.</p>'+renderRiskMatrix(null);return;
  }
  var isTb=n.type==='trust-boundary';
  var html='<h3>Selected '+(isTb?'trust boundary':'node')+'</h3>';
  html+='<div class="field"><label>Label</label><input class="inp" id="ins-label" value="'+esc(n.label)+'"></div>';
  html+='<div class="field"><label>Type</label><select class="inp" id="ins-type">'+TYPES.map(function(t){return '<option'+(n.type===t?' selected':'')+'>'+t+'</option>';}).join('')+'</select></div>';
  if(isTb){
    var opts=sibs();
    html+='<div class="field"><label>Members (a boundary must contain at least one node)</label><div class="chips">'+
      (opts.length?opts.map(function(s){return chip(s.label,(n.members||[]).indexOf(s.id)>=0,'data-mem="'+esc(s.id)+'"');}).join(''):'<span class="hint">No nodes on this layer yet.</span>')+'</div></div>';
    html+='<div class="field"><button type="button" class="btn sm" data-open-stride>Analyze STRIDE per boundary</button></div>';
  } else {
    html+='<div class="field"><label>Linked component</label><select class="inp" id="ins-comp"><option value="">&mdash; none &mdash;</option>'+
      components.map(function(c){return '<option value="'+esc(c.id)+'"'+(n.componentRef===c.id?' selected':'')+'>'+esc(c.name)+' ('+esc(c.id)+')</option>';}).join('')+'</select></div>';
    var linkedIfaces=(interfaces||[]).filter(function(itf){return itf.component&&itf.component===n.componentRef;});
    if(linkedIfaces.length){
      html+='<div class="field"><label>Interfaces (from system context)</label>'+
        '<div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">'+
        linkedIfaces.map(function(itf){
          return '<div style="padding:3px 8px;background:var(--surface-2);border-radius:6px;border:1px solid #5c8df644;font-size:11px"><b>'+
            esc(itf.tag||itf.name)+'</b>'+(itf.exposure?' · '+esc(itf.exposure):'')+(itf.protocol?' · '+esc(itf.protocol):'')+
          '</div>';
        }).join('')+'</div></div>';
    }
    var conns=dfd.flows.filter(function(f){return f.from===n.id||f.to===n.id;});
    html+='<h3 style="margin-top:12px">Data flow</h3>';
    html+=conns.length?conns.map(function(f){var out=f.from===n.id;var other=out?f.to:f.from;
      return '<div class="conn"><span>'+(out?'&rarr;':'&larr;')+'</span><span class="peer" title="'+esc(label(other))+'">'+esc(label(other))+'</span>'+
        '<input class="inp" style="width:88px" placeholder="label" data-flow="'+esc(f.id)+'" value="'+esc(f.label||'')+'"><button class="btn sm danger" data-delflow="'+esc(f.id)+'">&#10005;</button></div>';
    }).join(''):'<p class="hint">No data flow yet.</p>';
    var others=sibs().filter(function(s){return s.id!==n.id;});
    html+='<div class="conn" style="margin-top:8px"><select class="inp" id="ins-dir" style="width:72px"><option value="out">&rarr; to</option><option value="in">&larr; from</option></select>'+
      '<select class="inp" id="ins-target" style="flex:1"><option value="">Node&hellip;</option>'+others.map(function(s){return '<option value="'+esc(s.id)+'">'+esc(s.label)+'</option>';}).join('')+'</select>'+
      '<button class="btn sm" id="ins-addflow">+ Add</button></div>';
  }
  $('insp').innerHTML=html+renderRiskMatrix(!isTb?n.componentRef:null);
}
function renderSel(){
  var sel=$('sel');if(!sel)return;
  var vn=M.viewNodes(dfd,cur());
  sel.innerHTML='<option value="">Select&hellip;</option>'+vn.map(function(n){
    var tag=n.type==='trust-boundary'?' (boundary)':'';
    return '<option value="'+esc(n.id)+'"'+(n.id===focus?' selected':'')+'>'+esc(n.label)+tag+'</option>';
  }).join('');
  sel.value=focus||'';
}
function draw(){ensureFocus();drawCanvas();renderInspector();renderSel();}

function selectNode(id){
  var n=node(id);if(!n)return;
  selectEndpoint(id);
}
function selectEndpoint(id){
  if(connect){
    var endpointNode=node(id);if(endpointNode&&endpointNode.type==='trust-boundary')return;
    if(!connectFrom){connectFrom=id;}
    else{if(connectFrom!==id){M.addFlow(dfd,connectFrom,id);persist();}connectFrom=null;connect=false;}
    focus=(interfaces||[]).some(function(itf){return itf.id===id;})?'iface:'+id:(node(id)&&(node(id).parent==null?null:node(id).parent)===cur()?id:'port:'+id);draw();return;
  }
  focus=(interfaces||[]).some(function(itf){return itf.id===id;})?'iface:'+id:(node(id)&&(node(id).parent==null?null:node(id).parent)===cur()?id:'port:'+id);draw();
}
function step(dir){var s=sibs();if(!s.length)return;var i=s.findIndex(function(n){return n.id===focus;});i=(i+dir+s.length)%s.length;focus=s[i].id;draw();}
function up(){if(stack.length){stack.pop();focus=null;draw();}}
function down(){
  var n=focus?node(focus):null;if(!n||n.type==='trust-boundary')return;
  var kids=M.children(dfd,focus);
  if(!kids.length){
    confirmBox("'"+label(focus)+"' has no sub-components. Create a child layer?",function(ok){
      if(!ok)return;var child=M.addNode(dfd,focus,'process','Sub-component');stack.push(focus);focus=child.id;persist();draw();
    });return;
  }
  stack.push(focus);focus=null;draw();
}
function add(type){
  var n=M.addNode(dfd,cur(),type,'New '+type.replace('-',' '),trustBoundaryIds);
  if(type==='trust-boundary'){n.members=[];delete n.x;delete n.y;}
  focus=n.id;persist('add');draw();
  promptBox('Name for new '+type,n.label,function(v){if(v!=null&&v!==''){n.label=v;persist('add');draw();}});
}
function del(){if(!focus)return;var id=focus;confirmBox("Delete '"+label(id)+"'"+(M.children(dfd,id).length?" and its sub-components":"")+"?",function(ok){if(!ok)return;M.deleteNode(dfd,id);focus=null;persist();draw();});}
function toggleConnect(){connect=!connect;connectFrom=null;draw();}

function closeStrideEditor(){
  if(strideOverlay){strideOverlay.remove();strideOverlay=null;}
}
function openStrideEditor(tbId){
  closeStrideEditor();
  var tb=(system.trustBoundaries||[]).find(function(b){return b.id===tbId;});
  var tbNode=(dfd.nodes||[]).find(function(n){return n.id===tbId&&n.type==='trust-boundary';});
  var name=(tb&&tb.name)||(tbNode&&tbNode.label)||tbId;
  var pairs=S.boundaryPairs(system,dfd,tbId);
  var overlay=document.createElement('div');
  overlay.className='stride-overlay';
  overlay.innerHTML='<section class="stride-dialog" role="dialog" aria-modal="true" aria-label="STRIDE analysis per trust boundary">'+
    '<header><h2>STRIDE analysis · <span class="mono">'+esc(tbId)+'</span> '+esc(name)+'</h2><button type="button" class="btn sm" data-stride-close aria-label="Close">✕ Close</button></header>'+
    '<p class="hint">One table per communicating pair. Analyses are <b>shared across all boundaries</b> — edits appear in every boundary crossed by the same flow.</p>'+
    (pairs.length?pairs.map(function(pair){
      var analysis=(system.strideAnalyses||{})[pair.key]||{};
      function sideLabel(side){
        var ep=side==='inside'?pair.inside:pair.outside;
        var saved=analysis.endpoints&&analysis.endpoints[ep.id]&&analysis.endpoints[ep.id].label;
        return saved==null?ep.label:saved;
      }
      var sides=['inside','outside'];
      var fields=['strengths','weaknesses'];
      var head='<div class="stride-pair" data-pair-key="'+esc(pair.key)+'">'+
        '<h3><span data-pair-inside>'+esc(pair.inside.label)+'</span> <span class="muted">⇄</span> <span data-pair-outside>'+esc(pair.outside.label)+'</span></h3>'+
        '<div class="stride-labels">'+sides.map(function(side){
          var ep=side==='inside'?pair.inside:pair.outside;
          return '<label>Side '+(side==='inside'?'A':'B')+' — '+esc(ep.label)+(side==='inside'?' (inside this boundary)':' (across this boundary)')+
            '<input class="inp" data-stride-label="'+esc(ep.id)+'" aria-label="'+esc(side+' endpoint label')+'" value="'+esc(sideLabel(side))+'"></label>';
        }).join('')+'</div><table><thead><tr><th rowspan="2">STRIDE</th>'+
          '<th colspan="2" data-stride-heading="'+esc(pair.inside.id)+'">'+esc(sideLabel('inside'))+'</th>'+
          '<th colspan="2" data-stride-heading="'+esc(pair.outside.id)+'">'+esc(sideLabel('outside'))+'</th></tr>'+
          '<tr><th>Strengths</th><th>Weaknesses</th><th>Strengths</th><th>Weaknesses</th></tr></thead><tbody>';
      var rows=S.STRIDE_KEYS.map(function(key){
        var cells='<tr><th><span class="mono">'+key+'</span> · '+esc(S.STRIDE_LABEL[key])+'</th>';
        sides.forEach(function(side){
          var ep=side==='inside'?pair.inside:pair.outside;
          fields.forEach(function(field){
            var items=analysis.endpoints&&analysis.endpoints[ep.id]&&analysis.endpoints[ep.id].cells&&analysis.endpoints[ep.id].cells[key]&&analysis.endpoints[ep.id].cells[key][field]||[];
            cells+='<td><textarea class="inp" data-stride-cell="'+esc(ep.id)+'" data-stride-key="'+key+'" data-stride-field="'+field+'" aria-label="'+esc(side+' '+S.STRIDE_LABEL[key]+' '+field)+'" placeholder="one per line">'+esc(items.join('\\n'))+'</textarea></td>';
          });
        });
        return cells+'</tr>';
      }).join('');
      return head+rows+'</tbody></table></div>';
    }).join(''):'<p class="hint stride-empty">No data flows cross this boundary yet. Add flows in the DFD that cross <span class="mono">'+esc(tbId)+'</span> to analyse each communicating pair.</p>')+
    '</section>';
  document.body.appendChild(overlay);
  strideOverlay=overlay;
  overlay.addEventListener('click',function(e){
    if(e.target===overlay||e.target.closest('[data-stride-close]'))closeStrideEditor();
  });
  overlay.addEventListener('input',function(e){
    var t=e.target, pairEl=t.closest('[data-pair-key]');
    if(!pairEl)return;
    var key=pairEl.dataset.pairKey, endpointId=t.dataset.strideLabel||t.dataset.strideCell;
    if(!endpointId)return;
    var analyses=system.strideAnalyses||(system.strideAnalyses={});
    var analysis=analyses[key]||(analyses[key]={});
    var endpoints=analysis.endpoints||(analysis.endpoints={});
    var endpoint=endpoints[endpointId]||(endpoints[endpointId]={});
    if(t.dataset.strideLabel!==undefined){
      var labelText=t.value.trim();
      if(labelText)endpoint.label=labelText;else delete endpoint.label;
      var headings=Array.from(pairEl.querySelectorAll('[data-stride-heading]'));
      var insideId=pairEl.querySelector('[data-stride-heading]').dataset.strideHeading;
      var matchingHeading=headings.find(function(header){return header.dataset.strideHeading===endpointId;});
      var pair=pairs.find(function(p){return p.key===key;});
      if(matchingHeading)matchingHeading.textContent=labelText||(endpointId===insideId?pair.inside.label:pair.outside.label);
      var display=labelText||(endpointId===insideId?pair.inside.label:pair.outside.label);
      var head=pairEl.querySelector(endpointId===insideId?'[data-pair-inside]':'[data-pair-outside]');
      if(head)head.textContent=display;
      vs.postMessage({type:'strideEdit',pairKey:key,endpointId:endpointId,kind:'label',value:t.value});
    }else{
      var cells=endpoint.cells||(endpoint.cells={}), cell=cells[t.dataset.strideKey]||(cells[t.dataset.strideKey]={});
      var lines=t.value.split('\\n');cell[t.dataset.strideField]=lines.length===1&&lines[0]===''?[]:lines;
      vs.postMessage({type:'strideEdit',pairKey:key,endpointId:endpointId,kind:'cell',strideKey:t.dataset.strideKey,field:t.dataset.strideField,value:t.value});
    }
  });
  overlay.querySelector('button').focus();
}

let ovCb=null,ovMode=null;
function promptBox(lbl,val,cb){ovMode='prompt';ovCb=cb;$('ovlabel').textContent=lbl;$('ovinput').style.display='';$('ovinput').value=val||'';$('ov').style.display='flex';$('ovinput').focus();}
function confirmBox(lbl,cb){ovMode='confirm';ovCb=cb;$('ovlabel').textContent=lbl;$('ovinput').style.display='none';$('ov').style.display='flex';}
function ovOk(){var cb=ovCb,mode=ovMode,v=$('ovinput').value;$('ov').style.display='none';ovCb=null;if(cb){mode==='confirm'?cb(true):cb(v);}}
function ovCancel(){var cb=ovCb,mode=ovMode;$('ov').style.display='none';ovCb=null;if(cb&&mode==='confirm')cb(false);}

/* canvas mouse: click selects, drag moves (small threshold so a click is never treated as a drag) */
const cv=$('cv');
cv.addEventListener('mousedown',function(e){
  var pc=e.target.closest&&e.target.closest('[data-port]');
  if(pc){
    var portId=pc.getAttribute('data-port');
    if(connect){selectEndpoint(portId);return;}
    focus='port:'+portId;var portKey=(cur()||'root')+':'+portId;
    var rect=pc.querySelector('rect');portDrag={id:portId,key:portKey,sx:e.clientX,sy:e.clientY,ox:rect?Number(rect.getAttribute('x')):0,oy:rect?Number(rect.getAttribute('y')):0};
    dragMoved=false;dragging=true;draw();return;
  }
  // Interface chip: Connect mode uses its model ID; otherwise preserve the existing drag behavior.
  var ic=e.target.closest&&e.target.closest('[data-iface]');
  if(ic){
    var ifaceId=ic.getAttribute('data-iface');
    if(connect){selectEndpoint(ifaceId);return;}
    focus='iface:'+ifaceId;
    var posKey=(cur()||'root')+':'+ifaceId;
    var cp=(dfd.ifacePos||{})[posKey]||{};
    chipDrag={id:ifaceId,key:posKey,sx:e.clientX,sy:e.clientY,ox:cp.x||0,oy:cp.y||0};
    dragMoved=false;dragging=true;
    draw();
    return;
  }
  var g=e.target.closest&&e.target.closest('[data-id]');if(!g)return;var id=g.getAttribute('data-id');var n=node(id);if(!n)return;var rendered=renderedNodePositions.get(id)||{};dragMoved=false;dragging=true;drag={id:id,sx:e.clientX,sy:e.clientY,ox:typeof n.x==='number'?n.x:(typeof rendered.x==='number'?rendered.x:0),oy:typeof n.y==='number'?n.y:(typeof rendered.y==='number'?rendered.y:0)};});
cv.addEventListener('click',function(e){
  var flowPath=e.target.closest&&e.target.closest('[data-flow]');
  if(flowPath){focus='flow:'+flowPath.getAttribute('data-flow');connect=false;connectFrom=null;draw();}
});
window.addEventListener('mousemove',function(e){
  if(!dragging)return;
  if(portDrag){
    if(!dragMoved&&Math.abs(e.clientX-portDrag.sx)<4&&Math.abs(e.clientY-portDrag.sy)<4)return;
    dfd.portPos=dfd.portPos||{};
    dfd.portPos[portDrag.key]={x:Math.round(portDrag.ox+(e.clientX-portDrag.sx)),y:Math.round(portDrag.oy+(e.clientY-portDrag.sy))};
    dragMoved=true;drawCanvas();return;
  }
  if(chipDrag){
    if(!dragMoved&&Math.abs(e.clientX-chipDrag.sx)<4&&Math.abs(e.clientY-chipDrag.sy)<4)return;
    dfd.ifacePos=dfd.ifacePos||{};
    dfd.ifacePos[chipDrag.key]={x:Math.round(chipDrag.ox+(e.clientX-chipDrag.sx)),y:Math.round(chipDrag.oy+(e.clientY-chipDrag.sy))};
    dragMoved=true;drawCanvas();return;
  }
  if(!drag)return;if(!dragMoved&&Math.abs(e.clientX-drag.sx)<4&&Math.abs(e.clientY-drag.sy)<4)return;var n=node(drag.id);if(!n||n.type==='trust-boundary')return;n.x=Math.max(0,drag.ox+(e.clientX-drag.sx));n.y=Math.max(0,drag.oy+(e.clientY-drag.sy));dragMoved=true;drawCanvas();});
window.addEventListener('mouseup',function(){
  if(dragging&&portDrag){if(dragMoved)persist('port:'+portDrag.id);portDrag=null;dragging=false;dragMoved=false;drag=null;return;}
  if(dragging&&chipDrag){if(dragMoved)persist('iface:'+chipDrag.id);chipDrag=null;dragging=false;dragMoved=false;drag=null;return;}
  if(dragging&&drag){if(dragMoved)persist('move:'+drag.id);else selectNode(drag.id);}
  dragging=false;drag=null;
});

/* toolbar */
$('bar').addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-act]');if(!b)return;var a=b.dataset.act;
  if(a==='up')up();else if(a==='down')down();else if(a==='add')add(b.dataset.type);else if(a==='connect')toggleConnect();else if(a==='del')del();else if(a==='undo')undo();else if(a==='redo')redo();});
$('sel').addEventListener('change',function(e){var id=e.target.value;if(id){connect=false;connectFrom=null;focus=id;draw();}});

/* inspector */
$('insp').addEventListener('input',function(e){var t=e.target,n=focus?node(focus):null;
  if(t.id==='ins-flow-label'){var selected=dfd.flows.find(function(f){return focus==='flow:'+f.id;});if(selected){selected.label=t.value;drawCanvas();}return;}
  if(!n)return;
  if(t.id==='ins-label'){n.label=t.value;drawCanvas();}
  else if(t.dataset.flow){var f=dfd.flows.find(function(x){return x.id===t.dataset.flow;});if(f){f.label=t.value;drawCanvas();}}
});
$('insp').addEventListener('change',function(e){var t=e.target,n=focus?node(focus):null;
  if(t.id==='ins-flow-label'){persist();return;}
  if(!n)return;
  if(t.id==='ins-label'){persist('label:'+n.id);}
  else if(t.id==='ins-type'){n.type=t.value;if(n.type==='trust-boundary'){if(!n.members)n.members=[];}else{delete n.members;}persist();draw();}
  else if(t.id==='ins-comp'){if(t.value)n.componentRef=t.value;else delete n.componentRef;persist();}
  else if(t.dataset.flow){persist();}
});
$('insp').addEventListener('click',function(e){
  var strideButton=e.target.closest&&e.target.closest('[data-open-stride]');
  if(strideButton&&focus){openStrideEditor(focus);return;}
  var flowChoice=e.target.closest&&e.target.closest('[data-flow-select]');
  if(flowChoice){focus='flow:'+flowChoice.dataset.flowSelect;draw();return;}
  var matrixCell=e.target.closest&&e.target.closest('[data-matrix-threats]');
  if(matrixCell){activateMatrixCell(matrixCell);return;}
  var modeButton=e.target.closest('[data-matrix-mode]');
  if(modeButton){matrixMode=modeButton.dataset.matrixMode;renderInspector();return;}
  var b=e.target.closest('[data-mem],[data-delflow],#ins-addflow');if(!b)return;
  if(b.dataset.delflow){dfd.flows=dfd.flows.filter(function(f){return f.id!==b.dataset.delflow;});persist();draw();return;}
  var n=focus?node(focus):null;if(!n)return;
  if(b.dataset.mem){var arr=n.members||(n.members=[]);var k=arr.indexOf(b.dataset.mem);if(k>=0)arr.splice(k,1);else arr.push(b.dataset.mem);persist();draw();}
  else if(b.id==='ins-addflow'){var dir=$('ins-dir').value,tgt=$('ins-target').value;if(!tgt)return;var from=dir==='out'?n.id:tgt,to=dir==='out'?tgt:n.id;M.addFlow(dfd,from,to);persist();draw();}
});

$('ovok').addEventListener('click',ovOk);$('ovcancel').addEventListener('click',ovCancel);
window.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    if(strideOverlay){closeStrideEditor();e.preventDefault();return;}
    var dialog=document.querySelector('.matrix-threat-overlay');if(dialog){var close=dialog.querySelector('[aria-label="Close threat chooser"]');if(close)close.click();e.preventDefault();return;}
  }
  if(e.key==='Enter'||e.key===' '){
    var cell=e.target.closest&&e.target.closest('#dfd-risk-matrix td[data-l]');
    if(cell){e.preventDefault();e.stopPropagation();if(cell.hasAttribute('data-matrix-threats'))activateMatrixCell(cell);return;}
  }
  if($('ov').style.display==='flex'){if(e.key==='Enter'){ovOk();e.preventDefault();}if(e.key==='Escape'){ovCancel();e.preventDefault();}return;}
  var tag=(e.target&&e.target.tagName)||'';if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA')return;
  if((e.ctrlKey||e.metaKey)&&!e.altKey){var k=e.key.toLowerCase();if(k==='z'&&!e.shiftKey){undo();e.preventDefault();return;}if(k==='y'||(k==='z'&&e.shiftKey)){redo();e.preventDefault();return;}}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='ArrowLeft'){step(-1);e.preventDefault();}
  else if(e.key==='ArrowRight'){step(1);e.preventDefault();}
  else if(e.key==='ArrowDown'||e.key==='Enter'){down();e.preventDefault();}
  else if(e.key==='ArrowUp'||e.key==='Backspace'){up();e.preventDefault();}
  else if(e.key==='d'||e.key==='Delete'){del();e.preventDefault();}
  else if(e.key==='t'){toggleConnect();e.preventDefault();}
  else if(e.key==='x'){add('external-entity');e.preventDefault();}
  else if(e.key==='p'){add('process');e.preventDefault();}
  else if(e.key==='m'){add('multiprocess');e.preventDefault();}
  else if(e.key==='s'){add('store');e.preventDefault();}
  else if(e.key==='b'){add('trust-boundary');e.preventDefault();}
});

window.addEventListener('message',function(ev){var m=ev.data;
  if(m.type==='load'){try{dfd=JSON.parse(m.dfd);}catch(_){dfd={nodes:[],flows:[]};}if(!dfd.nodes)dfd.nodes=[];if(!dfd.flows)dfd.flows=[];if(m.system)system=m.system;if(m.components)components=m.components;if(m.interfaces)interfaces=m.interfaces;if(m.trustBoundaryIds)trustBoundaryIds=m.trustBoundaryIds;if(m.riskData)riskData=m.riskData;threats=m.threats||[];cms=m.cms||[];riskScheme=m.scheme||null;acceptableRisk=m.acceptableRisk;baseState=snap();updUndo();if(dragging)return;draw();}
});
vs.postMessage({type:'ready'});
</script></body></html>`;
  }
}
