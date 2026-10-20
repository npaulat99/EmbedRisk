import * as vscode from "vscode";

// Native attack-defense tree editor (optional artifact). Edits 07-attack-trees/attack-trees.json,
// a single document holding many trees (schema-identical to the tra-webapp). Each tree decomposes a
// threat into attacker steps combined by AND/OR/SAND gates, with per-step access/skill/cost and
// defence/vulnerability nodes. Deterministic metrics are derived bottom-up. Two-way file sync.
export class AttackTreeEditor implements vscode.CustomTextEditorProvider {
  public pendingTreeId: string | undefined;
  constructor(private extUri: vscode.Uri) { }

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const media = vscode.Uri.joinPath(this.extUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const modelUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "attacktree-model.js"));
    const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "tra-ui.css"));
    const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "embedrisk-logo.svg"));
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource};`;

    const projRoot = vscode.Uri.joinPath(doc.uri, "..", "..");
    const readRefs = async () => {
      const rd = async (rel: string, def: any) => { try { return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, rel))).toString()); } catch { return def; } };
      const cms = ((await rd("08-countermeasures/countermeasures.json", { countermeasures: [] })).countermeasures || []).map((c: any) => ({ id: c.id, title: c.title, status: c.status }));
      const threats = ((await rd("06-threats/threats.json", { threats: [] })).threats || []).map((t: any) => ({ id: t.id, title: t.title }));
      return { cms, threats };
    };

    let lastText = "";
    const post = async () => { const r = await readRefs(); const selectId = this.pendingTreeId; this.pendingTreeId = undefined; panel.webview.postMessage({ type: "load", doc: doc.getText() || '{"trees":[]}', cms: r.cms, threats: r.threats, selectId }); };
    const save = async (text: string) => {
      lastText = text;
      const ed = new vscode.WorkspaceEdit();
      ed.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
      await vscode.workspace.applyEdit(ed);
      await doc.save(); // persist immediately so a new / edited tree is never lost when the editor closes
    };

    panel.webview.html = this.html(modelUri, cssUri, logoUri, csp, nonce);
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === doc.uri.toString() && e.document.getText() !== lastText) post();
    });
    panel.onDidDispose(() => sub.dispose());
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "ready") await post();
      else if (m.type === "save") await save(m.doc);
    });
  }

  private html(modelUri: vscode.Uri, cssUri: vscode.Uri, logoUri: vscode.Uri, csp: string, nonce: string): string {
    return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
<style>
html,body{height:100%;margin:0;font:13px system-ui;color:var(--text);background:var(--bg)}
body{display:flex;flex-direction:column}
#bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:var(--surface);color:var(--text);border-bottom:1px solid var(--border);flex:0 0 auto;z-index:2}
#bar b{margin-right:6px}
#bar select,#bar input{padding:4px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text)}
#bar button{font:12px system-ui;padding:4px 9px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:7px;cursor:pointer}
#bar button:disabled{opacity:.4;cursor:default}
#bar button.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--border-strong))}
#bar .brand{display:flex;align-items:center;gap:6px;margin-right:2px}
#bar .brand .logo{width:18px;height:18px;display:block}
#metrics{color:var(--accent-2);font-size:12px}
#threatlinks{display:inline-flex;flex-wrap:wrap;gap:4px}
#threatlinks .chip{display:inline-flex;align-items:center;gap:4px;cursor:default}
#bar #threatlinks .chip button{padding:0 4px;border:0;background:none;line-height:1}
#hint{margin-left:auto;color:var(--text-faint);font-size:11px}
#body{flex:1 1 auto;display:flex;min-height:0}
#wrap{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;position:relative;color:var(--text)}
#insp{flex:0 0 300px;border-left:1px solid var(--border);background:var(--surface);overflow:auto;padding:12px}
#insp h3{font-size:13px;margin:0 0 8px}
.costgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
#ov{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;z-index:10}
#ovbox{background:var(--surface);color:var(--text);padding:14px;border-radius:8px;min-width:300px;border:1px solid var(--border)}
#ovbox input{width:100%;padding:6px;margin:8px 0;background:var(--surface);color:var(--text);border:1px solid var(--border-strong);border-radius:6px}
#ovbox .r{display:flex;gap:8px;justify-content:flex-end}
</style></head><body>
<div id="bar">
  <span class="brand"><img class="logo" src="${logoUri}" alt=""><b>EmbedRisk</b></span>
  <span class="hint">tree</span>
  <select id="treesel" title="Select tree"></select>
  <button data-act="addtree">+ Tree</button>
  <button data-act="deltree" class="danger" title="Delete the current attack tree (its goal and all nodes)">Delete tree</button>
  <span class="hint">threats</span><span id="threatlinks"></span><select id="threatsel" title="Link another threat this tree decomposes"></select>
  <span style="width:8px"></span>
  <button id="undo" data-act="undo" title="Undo (Ctrl+Z)" disabled>&#8630; Undo</button>
  <button id="redo" data-act="redo" title="Redo (Ctrl+Shift+Z)" disabled>&#8631; Redo</button>
  <span id="metrics"></span>
  <span id="hint">&larr;&rarr; siblings &middot; &uarr;&darr; parent/child &middot; Enter child &middot; e edit &middot; d delete</span>
</div>
<div id="body">
  <div id="wrap"><svg id="cv" xmlns="http://www.w3.org/2000/svg"></svg></div>
  <aside id="insp"></aside>
</div>
<div id="ov"><div id="ovbox"><div id="ovlabel"></div><input id="ovinput"><div class="r"><button class="btn" id="ovcancel">Cancel</button><button class="btn primary" id="ovok">OK</button></div></div></div>
<script nonce="${nonce}" src="${modelUri}"></script>
<script nonce="${nonce}">
const M=AtModel, vs=acquireVsCodeApi();
const KINDS=['goal','step','substep','category','countermeasure','vulnerability'];
const ADD_KINDS=['step','substep','category','countermeasure','vulnerability'];
const ACCESS=[[1,'Remote (unauth.)'],[2,'Remote (auth.)'],[3,'Adjacent / fieldbus'],[4,'Local (on site)'],[5,'Physical (enclosure)']];
const SKILL=[[1,'Script kiddie'],[2,'Experienced hacker'],[3,'Security engineer'],[4,'Expert team'],[5,'Nation-state']];
const COST_LEVELS={
  time:[[1,'Minutes'],[2,'Hours'],[3,'Days'],[4,'Weeks'],[5,'Months+']],
  notoriety:[[1,'Public'],[2,'Known'],[3,'Limited'],[4,'Internal'],[5,'Unknown']],
  exploitability:[[1,'Trivial'],[2,'Easy'],[3,'Moderate'],[4,'Difficult'],[5,'Very Difficult']],
  window:[[1,'Permanent'],[2,'Regular'],[3,'Occasional'],[4,'Brief'],[5,'One-Time']],
  detection:[[1,'None'],[2,'Low'],[3,'Moderate'],[4,'High'],[5,'Very High']],
  prep:[[1,'None'],[2,'Software setup'],[3,'Test environment'],[4,'Procure'],[5,'Infrastructure']],
  abort:[[1,'Robust'],[2,'Rare'],[3,'Moderate'],[4,'Frequent'],[5,'Very Likely']]
};
let doc={trees:[]}, ti=0, focus=null, cms=[], threats=[];
const $=id=>document.getElementById(id);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function tree(){return doc.trees[ti];}
function root(){var t=tree();return t?t.root:null;}
function cmMap(){var m={};cms.forEach(function(c){m[c.id]={status:c.status};});return m;}

/* ---- undo / redo: webview-local snapshots of the attack-tree document, mirroring tra-webapp ---- */
let undoStack=[], redoStack=[], baseState=null, histKey='', histTime=0;
function snap(){return JSON.stringify(doc);}
function updUndo(){var u=$('undo'),r=$('redo');if(u)u.disabled=!undoStack.length;if(r)r.disabled=!redoStack.length;}
function commit(key){
  var now=Date.now();
  var coalesce=undoStack.length&&key&&key===histKey&&(now-histTime<800);
  if(baseState!=null&&!coalesce){undoStack.push(baseState);if(undoStack.length>120)undoStack.shift();redoStack=[];}
  histKey=key||('u'+now);histTime=now;baseState=snap();updUndo();
  vs.postMessage({type:'save',doc:JSON.stringify(doc,null,2)});
}
function persist(key){commit(key||'');}
function restore(json){try{doc=JSON.parse(json);}catch(_){return false;}if(!doc.trees)doc.trees=[];if(ti>=doc.trees.length)ti=0;return true;}
function undo(){if(!undoStack.length)return;redoStack.push(snap());var p=undoStack.pop();if(!restore(p))return;baseState=p;histKey='';var r=root();focus=r?r.id:null;updUndo();vs.postMessage({type:'save',doc:JSON.stringify(doc,null,2)});draw();}
function redo(){if(!redoStack.length)return;undoStack.push(snap());var n=redoStack.pop();if(!restore(n))return;baseState=n;histKey='';var r=root();focus=r?r.id:null;updUndo();vs.postMessage({type:'save',doc:JSON.stringify(doc,null,2)});draw();}

function drawCanvas(){
  var t=tree(),cv=$('cv');
  if(!t){cv.innerHTML='';cv.setAttribute('width',400);cv.setAttribute('height',120);$('metrics').textContent='';return;}
  if(!M.find(t.root,focus))focus=t.root.id;
  var r=M.render(t,focus);
  cv.setAttribute('width',Math.max(r.width,400));cv.setAttribute('height',Math.max(r.height,180));cv.innerHTML=r.svg;
  var m=M.evaluate(t.root,cmMap());
  $('metrics').textContent='success ≈ '+Math.round(m.prob*100)+'% · suggests likelihood '+M.likelihoodFromProb(m.prob)+' · access '+m.accessReq+' · skill '+m.skillReq+' · '+m.defenses+' defence(s)';
}
function renderTreeSel(){
  $('treesel').innerHTML=doc.trees.map(function(t,i){var refs=M.threatRefsOf(t);var pfx=refs.length?(refs.join(', ')+' \u00b7 '):'';return '<option value="'+i+'"'+(i===ti?' selected':'')+'>'+esc(pfx+(t.title||t.id))+'</option>';}).join('')||'<option>(no trees)</option>';
  var t=tree();
  var linked=t?M.threatRefsOf(t):[];
  $('threatlinks').innerHTML=linked.map(function(id){var th=threats.find(function(x){return x.id===id;});return '<span class="chip static" title="'+esc(th?th.title:'Unknown threat')+'">'+esc(id)+'<button data-unlink="'+esc(id)+'" title="Unlink threat '+esc(id)+'" aria-label="Unlink threat '+esc(id)+'">\u00d7</button></span>';}).join('')||'<span class="hint">none</span>';
  $('threatsel').disabled=!t;
  $('threatsel').innerHTML='<option value="">+ link threat…</option>'+threats.filter(function(x){return linked.indexOf(x.id)<0;}).map(function(x){return '<option value="'+esc(x.id)+'">'+esc(x.id)+' · '+esc(x.title)+'</option>';}).join('');
}
function setThreatLinks(next){var t=tree();if(!t)return;M.setThreatRefs(t,next);persist();renderTreeSel();}
function opt(list,val){return list.map(function(o){return '<option value="'+o[0]+'"'+(+val===o[0]?' selected':'')+'>'+o[0]+' · '+esc(o[1])+'</option>';}).join('');}
function renderInspector(){
  var t=tree();if(!t){$('insp').innerHTML='<p class="hint">Add a tree to begin.</p>';return;}
  var n=M.find(t.root,focus);if(!n){$('insp').innerHTML='';return;}
  var structural=M.isStructural(n),isStep=(n.kind==='step'||n.kind==='substep');
  var html='<h3>Selected node</h3>';
  html+='<div class="field"><label>Kind</label><select class="inp" id="in-kind">'+KINDS.map(function(k){return '<option'+(n.kind===k?' selected':'')+'>'+k+'</option>';}).join('')+'</select></div>';
  html+='<div class="field"><label>Label</label><input class="inp" id="in-label" value="'+esc(n.label)+'"></div>';
  if(structural)html+='<div class="field"><label>Gate (children combine)</label><select class="inp" id="in-gate">'+M.GATES.map(function(gt){return '<option'+((n.gate||'AND')===gt?' selected':'')+'>'+gt+'</option>';}).join('')+'</select></div>';
  if(isStep){
    html+='<div class="field"><label>Required access</label><select class="inp" id="in-access">'+opt(ACCESS,n.access||3)+'</select></div>';
    html+='<div class="field"><label>Required skill</label><select class="inp" id="in-skill">'+opt(SKILL,n.skill||2)+'</select></div>';
    html+='<div class="field"><label>Cost factors</label><div class="costgrid">'+M.COST_FACTORS.map(function(f){var v=(n.cost||{})[f.k];return '<label class="hint">'+esc(f.label)+'<select class="inp" data-cost="'+f.k+'"><option value="">–</option>'+(COST_LEVELS[f.k]||[]).map(function(o){return '<option value="'+o[0]+'"'+(+v===o[0]?' selected':'')+'>'+o[0]+' · '+esc(o[1])+'</option>';}).join('')+'</select></label>';}).join('')+'</div></div>';
  }
  if(n.kind==='countermeasure')html+='<div class="field"><label>Linked countermeasure</label><select class="inp" id="in-cmref"><option value="">(link CM…)</option>'+cms.map(function(c){return '<option value="'+esc(c.id)+'"'+(n.countermeasureRef===c.id?' selected':'')+'>'+esc(c.id)+' · '+esc(c.title)+'</option>';}).join('')+'</select></div>';
  html+='<div class="field"><label>Add child</label><div class="chips">'+ADD_KINDS.map(function(k){return '<span class="chip" role="button" tabindex="0" data-addkind="'+k+'">+ '+esc(M.KIND_LABEL[k])+'</span>';}).join('')+'</div></div>';
  if(M.parentOf(t.root,n.id))html+='<button class="btn sm danger" id="in-del">Delete node</button>';
  $('insp').innerHTML=html;
}
function draw(){renderTreeSel();drawCanvas();renderInspector();}

function move(dir){var t=tree();if(!t)return;var r=t.root;
  if(dir==='up'){var p=M.parentOf(r,focus);if(p)focus=p.id;}
  else if(dir==='down'){var n=M.find(r,focus);if(n&&n.children&&n.children.length)focus=n.children[0].id;}
  else{var p2=M.parentOf(r,focus);if(!p2)return;var i=p2.children.findIndex(function(c){return c.id===focus;});var j=(i+(dir==='right'?1:-1)+p2.children.length)%p2.children.length;focus=p2.children[j].id;}
  draw();
}
function addChild(kind){var t=tree();if(!t)return;var n=M.addChild(t.root,focus,kind||'step');if(n){focus=n.id;persist();draw();promptBox('Label',n.label,function(v){if(v){n.label=v;persist();draw();}});}}
function addSib(){var t=tree();if(!t)return;var n=M.addSibling(t.root,focus,'step');if(n){focus=n.id;persist();draw();promptBox('Label',n.label,function(v){if(v){n.label=v;persist();draw();}});}}
function gate(){var t=tree();if(!t)return;if(M.cycleGate(t.root,focus)!==null){persist();draw();}}
function rename(){var t=tree();if(!t)return;var n=M.find(t.root,focus);if(!n)return;promptBox('Rename',n.label,function(v){if(v){n.label=v;persist();draw();}});}
function del(){var t=tree();if(!t)return;if(M.remove(t.root,focus)){focus=t.root.id;persist();draw();}}
function addTree(){var used={};doc.trees.forEach(function(t){used[t.id]=1;});var n=1,id;do{id='AT'+(n++);}while(used[id]);var firstThreat=threats[0]&&threats[0].id;var nt={id:id,title:'New attack goal',threatRefs:firstThreat?[firstThreat]:[],root:{id:'n1',kind:'goal',label:'Attack goal',gate:'OR',children:[]}};if(firstThreat)nt.threatRef=firstThreat;doc.trees.push(nt);ti=doc.trees.length-1;focus='n1';persist('addtree');draw();}
function delTree(){var t=tree();if(!t)return;confirmBox('Delete this attack tree and all of its nodes?',function(ok){if(!ok)return;doc.trees.splice(ti,1);if(ti>=doc.trees.length)ti=Math.max(0,doc.trees.length-1);var r=root();focus=r?r.id:null;persist('deltree');draw();});}

let ovCb=null, ovMode='prompt';
function promptBox(lbl,val,cb){ovMode='prompt';ovCb=cb;$('ovlabel').textContent=lbl;$('ovinput').style.display='';$('ovinput').value=val||'';$('ov').style.display='flex';$('ovinput').focus();}
function confirmBox(lbl,cb){ovMode='confirm';ovCb=cb;$('ovlabel').textContent=lbl;$('ovinput').style.display='none';$('ov').style.display='flex';}
function ovOk(){var cb=ovCb,mode=ovMode,v=$('ovinput').value;$('ov').style.display='none';$('ovinput').style.display='';ovCb=null;if(cb){mode==='confirm'?cb(true):cb(v);}}
function ovCancel(){var cb=ovCb,mode=ovMode;$('ov').style.display='none';$('ovinput').style.display='';ovCb=null;if(cb&&mode==='confirm')cb(false);}

$('cv').addEventListener('click',function(e){
  var gg=e.target.closest&&e.target.closest('[data-gate]');
  if(gg){var t=tree();if(t){var id=gg.getAttribute('data-gate');focus=id;if(M.cycleGate(t.root,id)!==null)persist('gate:'+id);draw();}return;}
  var g=e.target.closest&&e.target.closest('[data-id]');if(g){focus=g.getAttribute('data-id');draw();}});
$('bar').addEventListener('click',function(e){var u=e.target.closest&&e.target.closest('[data-unlink]');if(u){var t=tree();if(t){var id=u.getAttribute('data-unlink');setThreatLinks(M.threatRefsOf(t).filter(function(r){return r!==id;}));}return;}var b=e.target.closest&&e.target.closest('[data-act]');if(!b)return;var a=b.dataset.act;if(a==='addtree')addTree();else if(a==='deltree')delTree();else if(a==='undo')undo();else if(a==='redo')redo();});
$('treesel').addEventListener('change',function(e){ti=+e.target.value;var r=root();focus=r?r.id:null;draw();});
$('threatsel').addEventListener('change',function(e){var t=tree(),v=e.target.value;if(t&&v)setThreatLinks(M.threatRefsOf(t).concat([v]));});
$('insp').addEventListener('input',function(e){var t=tree();if(!t)return;var n=M.find(t.root,focus);if(!n)return;if(e.target.id==='in-label'){n.label=e.target.value;drawCanvas();}});
$('insp').addEventListener('change',function(e){var t=tree();if(!t)return;var n=M.find(t.root,focus);if(!n)return;var el=e.target;
  if(el.id==='in-label'){persist();}
  else if(el.id==='in-kind'){M.setKind(t.root,n.id,el.value);persist();draw();}
  else if(el.id==='in-gate'){n.gate=el.value;persist();drawCanvas();}
  else if(el.id==='in-access'){n.access=+el.value;persist();drawCanvas();}
  else if(el.id==='in-skill'){n.skill=+el.value;persist();drawCanvas();}
  else if(el.id==='in-cmref'){if(el.value)n.countermeasureRef=el.value;else delete n.countermeasureRef;persist();drawCanvas();}
  else if(el.dataset.cost){n.cost=n.cost||{};if(el.value==='')delete n.cost[el.dataset.cost];else n.cost[el.dataset.cost]=+el.value;persist();drawCanvas();}
});
$('insp').addEventListener('click',function(e){var b=e.target.closest('[data-addkind],#in-del');if(!b)return;if(b.id==='in-del')del();else addChild(b.dataset.addkind);});
$('ovok').addEventListener('click',ovOk);$('ovcancel').addEventListener('click',ovCancel);
window.addEventListener('keydown',function(e){
  if($('ov').style.display==='flex'){if(e.key==='Enter'){ovOk();e.preventDefault();}if(e.key==='Escape'){ovCancel();e.preventDefault();}return;}
  var tag=(e.target&&e.target.tagName)||'';if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA')return;
  if((e.ctrlKey||e.metaKey)&&!e.altKey){var k=e.key.toLowerCase();if(k==='z'&&!e.shiftKey){undo();e.preventDefault();return;}if(k==='y'||(k==='z'&&e.shiftKey)){redo();e.preventDefault();return;}}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='ArrowLeft'){move('left');e.preventDefault();}
  else if(e.key==='ArrowRight'){move('right');e.preventDefault();}
  else if(e.key==='ArrowUp'){move('up');e.preventDefault();}
  else if(e.key==='ArrowDown'){move('down');e.preventDefault();}
  else if(e.key==='Enter'){addChild('step');e.preventDefault();}
  else if(e.key==='Insert'){addSib();e.preventDefault();}
  else if(e.key==='t'||e.key==='g'){gate();e.preventDefault();}
  else if(e.key==='e'||e.key==='F2'){rename();e.preventDefault();}
  else if(e.key==='d'||e.key==='Delete'){del();e.preventDefault();}
});
window.addEventListener('message',function(ev){var m=ev.data;if(m.type==='load'){try{doc=JSON.parse(m.doc);}catch(_){doc={trees:[]};}if(!doc.trees)doc.trees=[];if(m.cms)cms=m.cms;if(m.threats)threats=m.threats;if(m.selectId){var si=doc.trees.findIndex(function(t){return t.id===m.selectId;});if(si>=0){ti=si;focus=null;}}if(ti>=doc.trees.length)ti=0;var r=root();if(r&&!M.find(r,focus))focus=r.id;baseState=snap();updUndo();draw();}});
vs.postMessage({type:'ready'});
</script></body></html>`;
  }
}
