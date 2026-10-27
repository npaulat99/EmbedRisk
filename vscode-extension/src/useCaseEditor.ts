import * as vscode from "vscode";

// Use-case diagram editor. The persisted document is 04b-use-cases/use-cases.json and can hold
// multiple diagrams. Draw.io is reused as a rendering canvas (embedded iframe), while this editor
// owns the structured model for actors/actions/connections/groups and writes JSON directly.
export class UseCaseEditor implements vscode.CustomTextEditorProvider {
    constructor(private extUri: vscode.Uri) { }

    async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel) {
        const media = vscode.Uri.joinPath(this.extUri, "media", "drawio");
        const q = "?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&autosave=1";
        let frameSrc = "https://embed.diagrams.net/" + q;
        let local = "";
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(media, "index.html"));
            frameSrc = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "index.html")).toString() + q;
            local = media.toString();
        } catch {
            // Hosted draw.io fallback.
        }

        panel.webview.options = { enableScripts: true, localResourceRoots: local ? [media] : [] };
        const csp = `default-src 'none'; img-src ${panel.webview.cspSource} https: data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource} 'unsafe-inline'; frame-src ${panel.webview.cspSource} https://embed.diagrams.net;`;
        panel.webview.html = this.html(frameSrc, csp);

        let lastText = "";
        const saveDoc = async (text: string) => {
            lastText = text;
            const ed = new vscode.WorkspaceEdit();
            ed.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
            await vscode.workspace.applyEdit(ed);
            await doc.save();
        };

        const projRoot = vscode.Uri.joinPath(doc.uri, "..", "..");
        const readJson = async (rel: string): Promise<any> => {
            try { return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projRoot, rel))).toString()); } catch { return {}; }
        };
        // Read-only Step 03/04 data for linking independent DFD nodes to system components.
        const post = async () => {
            const sys = await readJson("03-system-assets/system.json");
            const dfd = await readJson("04-dfd/dfd.json");
            const components = (Array.isArray(sys.components) ? sys.components : []).map((c: any) => ({ id: c.id, name: c.name, kind: c.kind }));
            const byId = new Map(components.map((c: any) => [c.id, c]));
            const nodes: any[] = Array.isArray(dfd.nodes) ? dfd.nodes : [];
            const available = nodes
                .filter((n) => n && n.type !== "trust-boundary" && n.componentRef)
                .filter((n, i, all) => all.findIndex((o) => o.componentRef === n.componentRef) === i)
                .map((n) => ({ nodeId: n.id, label: n.label, type: n.type, componentRef: n.componentRef, name: (byId.get(n.componentRef) as any)?.name }));
            return panel.webview.postMessage({ type: "load", doc: doc.getText() || '{"diagrams":[]}', components, availableComponents: available });
        };
        const sub = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() === doc.uri.toString() && e.document.getText() !== lastText) post();
        });
        panel.onDidDispose(() => sub.dispose());

        panel.webview.onDidReceiveMessage(async (m) => {
            if (m?.type === "ready") await post();
            else if (m?.type === "save") await saveDoc(m.doc);
            else if (m?.type === "exit") {
                await vscode.commands.executeCommand("embedrisk.wizard");
                panel.dispose();
            }
        });
    }

    private html(frameSrc: string, csp: string): string {
        return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html,body{height:100%;margin:0;font:13px system-ui}
body{display:flex;flex-direction:column;background:#0f1115;color:#e8eaee}
#bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1a1f27;border-bottom:1px solid #2a3240;flex:0 0 auto}
#bar button,#bar select,#bar input{font:12px system-ui;padding:5px 8px;border:1px solid #374357;border-radius:7px;background:#11161d;color:#e8eaee}
#bar button{cursor:pointer}
#bar button.primary{background:#0f9d8f;border-color:#0f9d8f;color:#001315}
#bar .grow{flex:1}
#body{flex:1 1 auto;display:grid;grid-template-columns:390px 1fr;min-height:0}
#left{border-right:1px solid #2a3240;overflow:auto;padding:10px;background:#141920}
#right{min-height:0;position:relative}
#f{position:absolute;inset:0;border:0;width:100%;height:100%}
.field{margin:6px 0}
.field label{display:block;font-size:11px;color:#9fb0c8;margin-bottom:2px}
.row{display:flex;gap:6px;align-items:center}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.item{border:1px solid #2f3948;border-radius:8px;padding:8px;margin:7px 0;background:#0f141c}
.item h4{margin:0 0 6px;font-size:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{border:1px solid #3a475b;border-radius:999px;padding:3px 8px;font-size:11px;cursor:pointer}
.chip.on{background:#0f9d8f;color:#001315;border-color:#0f9d8f}
.muted{color:#8ea0ba}
.dn rect{fill:#18202b;stroke:#8ea0ba;stroke-width:1.5}.dn line{stroke:#8ea0ba;stroke-width:1.5}.dn.sel rect{stroke:#0f9d8f;stroke-width:3}.dn text{fill:#e8eaee;font:12px system-ui;pointer-events:none}.df line{stroke:#8ea0ba;stroke-width:1.5}
</style></head><body>
<div id="bar">
	<b>Use-case diagrams</b>
	<select id="diagSel" class="grow"></select>
	<button id="addDiag">+ Diagram</button>
	<button id="delDiag">Delete</button>
	<button id="exitBtn" class="primary">Exit</button>
</div>
<div id="body">
	<aside id="left">
		<div id="dfdEditor" style="display:none">
			<div class="field"><label>Diagram name</label><input id="dfdName"></div>
			<p class="muted">Independent from Step 04. Flows are preserved; flow editing is not available yet.</p>
			<div id="dfdInspector"></div>
		</div>
		<div id="diagramEditor">
		<div class="field"><label>Diagram name</label><input id="diagName"></div>
		<div class="field"><label>Quick add entities</label>
			<div class="chips">
				<span class="chip" data-add-kind="actor">+ Actor</span>
				<span class="chip" data-add-kind="misuse-actor">+ Misuse actor</span>
				<span class="chip" data-add-kind="action">+ Action</span>
				<span class="chip" data-add-kind="misuse-action">+ Misuse action</span>
			</div>
		</div>
		<h3>Entities</h3>
		<div id="entities"></div>
		<h3>Connections</h3>
		<button id="addConn">+ Connection</button>
		<div id="conns"></div>
		<h3>Grouping boxes</h3>
		<button id="addGroup">+ Group</button>
		<div id="groups"></div>
		</div>
	</aside>
	<main id="right"><iframe id="f" src="${frameSrc}"></iframe>
		<div id="dfdPane" style="display:none;position:absolute;inset:0;overflow:auto;flex-direction:column">
			<div id="dfdBar" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;background:#1a1f27">
				<select id="dfdComp"></select>
				<button data-dfd-add="process">+ Process</button><button data-dfd-add="multiprocess">+ Multi-process</button><button data-dfd-add="store">+ Store</button><button data-dfd-add="external-entity">+ External entity</button>
				<button id="dfdLayout">Auto layout</button><button id="dfdDelete" disabled>Delete selected</button>
			</div>
			<svg id="dfdSvg" width="760" height="460" style="background:#0f1115"></svg>
		</div></main>
</div>

<script>
(function(){
const vs=acquireVsCodeApi();
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=(p,arr)=>{const used=new Set();(arr||[]).forEach(x=>{const id=x&&x.id;if(typeof id!=='string'||id.indexOf(p)!==0)return;const rest=id.slice(p.length);if(/^[0-9]+$/.test(rest))used.add(Number(rest));});let n=1;while(used.has(n))n++;return p+n;};
const ENTITY_PREFIX={actor:'A','misuse-actor':'MA',action:'U','misuse-action':'MU'};

let doc={diagrams:[]};
let components=[],available=[];
let selNode=null,drag=null;
const NODE_TYPES=['process','multiprocess','store','external-entity'];
const NODE_DIMS={process:{w:150,h:90},multiprocess:{w:150,h:90},store:{w:160,h:72},'external-entity':{w:160,h:72}};
const TYPE_LABEL={process:'Process',multiprocess:'Multi-process',store:'Store','external-entity':'External entity'};
const isDfd=(d)=>!!d&&d.kind==='independent-dfd';
function compById(id){return components.find((c)=>c.id===id);}
function typeForComp(c,fb){if(c&&(c.kind==='store'||c.kind==='external-entity'||c.kind==='multiprocess'))return c.kind;return fb==='trust-boundary'||!fb?'process':fb;}
function displayType(n){const t=typeForComp(n.componentRef?compById(n.componentRef):undefined,n.type);return NODE_DIMS[t]?t:'process';}
function dfdOf(d){const raw=d&&d.dfd;return raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw,nodes:Array.isArray(raw.nodes)?raw.nodes:[],flows:Array.isArray(raw.flows)?raw.flows:[]}:{nodes:[],flows:[]};}
function ensureDfd(d){if(!d.dfd||typeof d.dfd!=='object'||Array.isArray(d.dfd))d.dfd={};if(!Array.isArray(d.dfd.nodes))d.dfd.nodes=[];if(!Array.isArray(d.dfd.flows))d.dfd.flows=[];return d.dfd;}
function slot(i,o){return {x:o+(i%4)*210,y:o+Math.floor(i/4)*150};}
function nodePosition(n,i){const fallback=slot(i,40);return {x:Number.isFinite(n.x)?n.x:fallback.x,y:Number.isFinite(n.y)?n.y:fallback.y};}
function addDfdNode(d,type,label,componentRef){
	const g=ensureDfd(d);const p=slot(g.nodes.length,40);
	const n={id:uid('SCN-DFD',g.nodes),label,type,layer:1,x:p.x,y:p.y};
	if(componentRef)n.componentRef=componentRef;
	g.nodes.push(n);selNode=n.id;save();
}
function dfdNode(d){return d&&dfdOf(d).nodes.find((n)=>n.id===selNode);}
function renderDfd(d){
	const g=dfdOf(d);
	if(selNode&&!g.nodes.some((n)=>n.id===selNode))selNode=null;
	$('dfdName').value=d.name||'';
	$('dfdComp').innerHTML='<option value="">Add a Step 04 component...</option>'+available.map((a,i)=>'<option value="'+i+'">'+esc(a.name||a.label)+' ('+TYPE_LABEL[typeForComp(compById(a.componentRef),a.type)]+')</option>').join('');
	$('dfdLayout').disabled=!g.nodes.length;
	$('dfdDelete').disabled=!selNode;
	const pos=(n)=>drag&&drag.id===n.id?drag:nodePosition(n,nodes.indexOf(n));
	const nodes=g.nodes.filter((n)=>n.type!=='trust-boundary');
	const byId=new Map(g.nodes.map((n)=>[n.id,n]));
	const ctr=(n)=>{const p=pos(n),s=NODE_DIMS[displayType(n)];return {x:(p.x||0)+s.w/2,y:(p.y||0)+s.h/2};};
	let w=760,h=460;
	nodes.forEach((n)=>{const p=pos(n),s=NODE_DIMS[displayType(n)];w=Math.max(w,(p.x||0)+s.w+60);h=Math.max(h,(p.y||0)+s.h+60);});
	const flows=g.flows.map((f)=>{const a=byId.get(f.from),b=byId.get(f.to);if(!a||!b)return '';const A=ctr(a),B=ctr(b);return '<g class="df" data-flow="'+esc(f.id)+'"><line x1="'+A.x+'" y1="'+A.y+'" x2="'+B.x+'" y2="'+B.y+'"/></g>';}).join('');
	const shapes=nodes.map((n)=>{const t=displayType(n),s=NODE_DIMS[t],p=pos(n);
		const body=t==='store'?'<line x1="0" y1="10" x2="'+s.w+'" y2="10"/><line x1="0" y1="'+(s.h-10)+'" x2="'+s.w+'" y2="'+(s.h-10)+'"/>':'<rect width="'+s.w+'" height="'+s.h+'" rx="'+(t==='process'||t==='multiprocess'?45:3)+'"/>';
		return '<g class="dn '+t+(selNode===n.id?' sel':'')+'" data-node="'+esc(n.id)+'" transform="translate('+(p.x||0)+','+(p.y||0)+')">'+body+'<text x="'+s.w/2+'" y="'+(s.h/2+4)+'" text-anchor="middle">'+esc(n.label||n.id)+'</text></g>';}).join('');
	const svg=$('dfdSvg');svg.setAttribute('width',w);svg.setAttribute('height',h);svg.innerHTML=flows+shapes;
	const n=dfdNode(d);
	$('dfdInspector').innerHTML=n?'<div class="item"><h4>'+esc(n.id)+'</h4><div class="field"><label>Node label</label><input data-dn="label" value="'+esc(n.label||'')+'"></div>'+
		'<div class="field"><label>DFD shape</label><select data-dn="type">'+NODE_TYPES.map((t)=>'<option value="'+t+'"'+(displayType(n)===t?' selected':'')+'>'+TYPE_LABEL[t]+'</option>').join('')+'</select></div>'+
		'<div class="field"><label>System component</label><select data-dn="componentRef"><option value="">Independent node</option>'+(n.componentRef&&!available.some((a)=>a.componentRef===n.componentRef)?'<option value="'+esc(n.componentRef)+'" selected>'+esc(n.componentRef)+'</option>':'')+available.map((a)=>'<option value="'+esc(a.componentRef)+'"'+(n.componentRef===a.componentRef?' selected':'')+'>'+esc(a.name||a.label)+'</option>').join('')+'</select></div></div>':'<p class="muted">Select a node to edit it.</p>';
}
let di=0;

function cur(){return doc.diagrams[di]||null;}
function ensure(){if(!Array.isArray(doc.diagrams))doc.diagrams=[];if(di<0)di=0;if(di>=doc.diagrams.length)di=Math.max(0,doc.diagrams.length-1);} 
function sortForGroupBounds(d){
	const byId=new Map((d.entities||[]).map((e,i)=>[e.id,{x:Number.isFinite(e.x)?e.x:80+(i%4)*220,y:Number.isFinite(e.y)?e.y:90+Math.floor(i/4)*170,w:(e.kind==='actor'||e.kind==='misuse-actor')?80:180,h:(e.kind==='actor'||e.kind==='misuse-actor')?120:70}]));
	return byId;
}

function toMxXml(d){
	const entities=d.entities||[];
	const conns=d.connections||[];
	const groups=d.groups||[];
	const byId=sortForGroupBounds(d);
	let cells=[];
	cells.push('<mxCell id="0"/>');
	cells.push('<mxCell id="1" parent="0"/>');
	let next=2;
	const idMap=new Map();

	for(const g of groups){
		const members=(g.members||[]).map((id)=>byId.get(id)).filter(Boolean);
		let x=40,y=40,w=260,h=160;
		if(members.length){
			x=Math.min(...members.map(m=>m.x))-26;
			y=Math.min(...members.map(m=>m.y))-42;
			w=Math.max(...members.map(m=>m.x+m.w))-x+26;
			h=Math.max(...members.map(m=>m.y+m.h))-y+18;
		}
		const gid='g'+next++;
		cells.push('<mxCell id="'+gid+'" value="'+esc(g.name||g.id)+'" style="rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#4d5a6d;align=left;verticalAlign=top;spacing=6;" vertex="1" parent="1"><mxGeometry x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" as="geometry"/></mxCell>');
	}

	entities.forEach((e,i)=>{
		const b=byId.get(e.id);
		const mx='v'+next++;
		idMap.set(e.id,mx);
		const actor=e.kind==='actor'||e.kind==='misuse-actor';
		const misuse=e.kind==='misuse-actor'||e.kind==='misuse-action';
		const style=actor
			? 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;whiteSpace=wrap;'+(misuse?'fillColor=#111111;strokeColor=#111111;fontColor=#ffffff;':'')
			: 'ellipse;whiteSpace=wrap;html=1;align=center;verticalAlign=middle;'+(misuse?'fillColor=#111111;strokeColor=#111111;fontColor=#ffffff;':'');
		cells.push('<mxCell id="'+mx+'" value="'+esc(e.name||e.id)+'" style="'+style+'" vertex="1" parent="1"><mxGeometry x="'+b.x+'" y="'+b.y+'" width="'+b.w+'" height="'+b.h+'" as="geometry"/></mxCell>');
	});

	conns.forEach((c)=>{
		const s=idMap.get(c.from),t=idMap.get(c.to);if(!s||!t)return;
		const ar=c.arrow||'none';
		const dashed=c.dashed?'1':'0';
		const st='edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;dashed='+dashed+';endArrow='+(ar==='forward'||ar==='both'?'classic':'none')+';startArrow='+(ar==='backward'||ar==='both'?'classic':'none')+';';
		const eid='e'+next++;
		cells.push('<mxCell id="'+eid+'" value="'+esc(c.label||'')+'" style="'+st+'" edge="1" parent="1" source="'+s+'" target="'+t+'"><mxGeometry relative="1" as="geometry"/></mxCell>');
	});

	return '<mxfile host="app.diagrams.net" modified="'+new Date().toISOString()+'" agent="EmbedRisk" version="24.7.17"><diagram name="'+esc(d.name||d.id)+'"><mxGraphModel dx="1480" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1000" math="0" shadow="0"><root>'+cells.join('')+'</root></mxGraphModel></diagram></mxfile>';
}

function sendDrawio(xml){
	const f=$('f');
	if(f&&f.contentWindow)f.contentWindow.postMessage(JSON.stringify({action:'load',xml}),'*');
}

const EMPTY_XML='<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
function diagramXml(d){return d&&d.kind!=='independent-dfd'?(d.drawioXml||toMxXml(d)):EMPTY_XML;}

function save(){
	const d=cur();
	vs.postMessage({type:'save',doc:JSON.stringify(doc,null,2)});
	if(d&&!isDfd(d)){d.drawioXml=toMxXml(d);sendDrawio(d.drawioXml);}
	render();
}

function addDiagram(){
	const id=uid('UC',doc.diagrams);
	doc.diagrams.push({id,name:'New use case '+id,entities:[],connections:[],groups:[],drawioXml:''});
	di=doc.diagrams.length-1;
	save();
}

function render(){
	ensure();
	const d=cur();
	const readOnly=isDfd(d);
	const sel=$('diagSel');
	sel.innerHTML=doc.diagrams.map((x,i)=>'<option value="'+i+'"'+(i===di?' selected':'')+'>'+esc(x.name||x.id)+'</option>').join('')||'<option>(no diagrams)</option>';
	$('diagramEditor').style.display=readOnly||!d?'none':'';
	$('dfdEditor').style.display=readOnly?'block':'none';
	$('dfdPane').style.display=readOnly?'flex':'none';
	$('f').style.visibility=readOnly?'hidden':'';
	$('diagName').value=d?d.name||'':'';
	if(!d){$('entities').innerHTML='<p class="muted">Add a diagram to start.</p>';$('conns').innerHTML='';$('groups').innerHTML='';sendDrawio(EMPTY_XML);return;}
	if(readOnly){sendDrawio(EMPTY_XML);renderDfd(d);return;}

	$('entities').innerHTML=(d.entities||[]).map((e,i)=>{
		return '<div class="item"><div class="row"><h4>'+esc(e.id)+'</h4><button data-del-entity="'+i+'">Delete</button></div>'+
			'<div class="grid"><div class="field"><label>Name</label><input data-entity="'+i+'" data-k="name" value="'+esc(e.name||'')+'"></div>'+
			'<div class="field"><label>Kind</label><select data-entity="'+i+'" data-k="kind">'+['actor','misuse-actor','action','misuse-action'].map((k)=>'<option'+(e.kind===k?' selected':'')+'>'+k+'</option>').join('')+'</select></div></div>'+
			'<div class="grid"><div class="field"><label>X</label><input type="number" data-entity="'+i+'" data-k="x" value="'+(Number.isFinite(e.x)?e.x:'')+'"></div>'+
			'<div class="field"><label>Y</label><input type="number" data-entity="'+i+'" data-k="y" value="'+(Number.isFinite(e.y)?e.y:'')+'"></div></div></div>';
	}).join('')||'<p class="muted">No entities yet.</p>';

	$('conns').innerHTML=(d.connections||[]).map((c,i)=>{
		return '<div class="item"><div class="row"><h4>'+esc(c.id)+'</h4><button data-del-conn="'+i+'">Delete</button></div>'+
			'<div class="grid3"><div class="field"><label>From</label><select data-conn="'+i+'" data-k="from"><option value="">—</option>'+(d.entities||[]).map((e)=>'<option value="'+esc(e.id)+'"'+(c.from===e.id?' selected':'')+'>'+esc(e.name||e.id)+'</option>').join('')+'</select></div>'+
			'<div class="field"><label>To</label><select data-conn="'+i+'" data-k="to"><option value="">—</option>'+(d.entities||[]).map((e)=>'<option value="'+esc(e.id)+'"'+(c.to===e.id?' selected':'')+'>'+esc(e.name||e.id)+'</option>').join('')+'</select></div>'+
			'<div class="field"><label>Arrow</label><select data-conn="'+i+'" data-k="arrow">'+['none','forward','backward','both'].map((a)=>'<option'+((c.arrow||'none')===a?' selected':'')+'>'+a+'</option>').join('')+'</select></div></div>'+
			'<div class="grid"><div class="field"><label>Label</label><input data-conn="'+i+'" data-k="label" value="'+esc(c.label||'')+'"></div>'+
			'<div class="field"><label>Dashed</label><input type="checkbox" data-conn="'+i+'" data-k="dashed" '+(c.dashed?'checked':'')+'></div></div></div>';
	}).join('')||'<p class="muted">No connections yet.</p>';

	$('groups').innerHTML=(d.groups||[]).map((g,i)=>{
		const chips=(d.entities||[]).map((e)=>{
			const on=(g.members||[]).indexOf(e.id)>=0;
			return '<span class="chip'+(on?' on':'')+'" data-group-member="'+i+'" data-val="'+esc(e.id)+'">'+esc(e.name||e.id)+'</span>';
		}).join('')||'<span class="muted">No entities available.</span>';
		return '<div class="item"><div class="row"><h4>'+esc(g.id)+'</h4><button data-del-group="'+i+'">Delete</button></div>'+
			'<div class="field"><label>Name</label><input data-group="'+i+'" data-k="name" value="'+esc(g.name||'')+'"></div>'+
			'<div class="field"><label>Contained entities</label><div class="chips">'+chips+'</div></div></div>';
	}).join('')||'<p class="muted">No grouping boxes yet.</p>';

	sendDrawio(d.drawioXml||toMxXml(d));
}

document.addEventListener('click',(e)=>{
	const t=e.target;
	const d=cur();
	if(t.id==='addDiag'){addDiagram();return;}
	if(t.id==='exitBtn'){vs.postMessage({type:'exit'});return;}
	if(isDfd(d)){
		const add=t.getAttribute&&t.getAttribute('data-dfd-add');
		if(t.id==='delDiag'){doc.diagrams.splice(di,1);selNode=null;ensure();save();return;}
		if(add&&NODE_DIMS[add]){addDfdNode(d,add,TYPE_LABEL[add]);return;}
		if(t.id==='dfdLayout'){ensureDfd(d).nodes.forEach((n,i)=>{const p=slot(i,48);n.x=p.x;n.y=p.y;});save();return;}
		if(t.id==='dfdDelete'&&selNode){const g=ensureDfd(d),id=selNode;g.nodes=g.nodes.filter((n)=>n.id!==id);g.flows=g.flows.filter((f)=>f.from!==id&&f.to!==id);selNode=null;save();return;}
		return;
	}
	if(t.id==='delDiag'){if(!d)return;doc.diagrams.splice(di,1);ensure();save();return;}
	if(t.id==='addConn'&&d){d.connections=d.connections||[];d.connections.push({id:uid('CN',d.connections),from:'',to:'',arrow:'none',label:'',dashed:false});save();return;}
	if(t.id==='addGroup'&&d){d.groups=d.groups||[];d.groups.push({id:uid('G',d.groups),name:'Group',members:[]});save();return;}

	const addKind=t.getAttribute&&t.getAttribute('data-add-kind');
	if(addKind&&d){d.entities=d.entities||[];d.entities.push({id:uid(ENTITY_PREFIX[addKind],d.entities),kind:addKind,name:addKind.replace('-',' '),x:80+(d.entities.length%4)*220,y:90+Math.floor(d.entities.length/4)*170});save();return;}

	if(t.hasAttribute&&t.hasAttribute('data-del-entity')&&d){const removed=d.entities.splice(+t.getAttribute('data-del-entity'),1)[0];const gone=removed&&removed.id;d.connections=(d.connections||[]).filter((c)=>c.from!==gone&&c.to!==gone);(d.groups||[]).forEach((g)=>{g.members=(g.members||[]).filter((m)=>m!==gone);});save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-del-conn')&&d){d.connections.splice(+t.getAttribute('data-del-conn'),1);save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-del-group')&&d){d.groups.splice(+t.getAttribute('data-del-group'),1);save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-group-member')&&d){
		const gi=+t.getAttribute('data-group-member');const v=t.getAttribute('data-val');
		const g=d.groups[gi];g.members=g.members||[];const idx=g.members.indexOf(v);if(idx>=0)g.members.splice(idx,1);else g.members.push(v);save();return;
	}
});

document.addEventListener('input',(e)=>{
	const t=e.target; const d=cur(); if(!d)return;
	if(isDfd(d)){
		if(t.id==='dfdName'){d.name=t.value;save();}
		return;
	}
	if(t.id==='diagName'){d.name=t.value;save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-entity')){const i=+t.getAttribute('data-entity');const k=t.getAttribute('data-k');if(k==='x'||k==='y')d.entities[i][k]=t.value===''?undefined:Number(t.value);else d.entities[i][k]=t.value;save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-conn')){const i=+t.getAttribute('data-conn');const k=t.getAttribute('data-k');d.connections[i][k]=k==='dashed'?!!t.checked:t.value;save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-group')){const i=+t.getAttribute('data-group');const k=t.getAttribute('data-k');d.groups[i][k]=t.value;save();return;}
});

$('diagSel').addEventListener('change',(e)=>{di=+e.target.value;selNode=null;ensure();render();});
$('dfdComp').addEventListener('change',(e)=>{
	const a=available[+e.target.value],d=cur();e.target.value='';
	if(!a||!isDfd(d))return;
	const c=compById(a.componentRef);
	addDfdNode(d,typeForComp(c,a.type),(c&&c.name)||a.label,a.componentRef);
});
document.addEventListener('change',(e)=>{
	const t=e.target,d=cur();
	if(!isDfd(d)||!t.getAttribute||!t.hasAttribute('data-dn'))return;
	const n=dfdNode(d);if(!n)return;
	const k=t.getAttribute('data-dn');
	if(k==='label')n.label=t.value;
	else if(k==='type')n.type=t.value;
	else if(k==='componentRef'){if(t.value){n.componentRef=t.value;n.type=typeForComp(compById(t.value),n.type);}else delete n.componentRef;}
	save();
});
const svgEl=$('dfdSvg');
svgEl.addEventListener('mousedown',(e)=>{
	const d=cur();if(!isDfd(d))return;
	const g=e.target.closest&&e.target.closest('[data-node]');
	if(!g){selNode=null;renderDfd(d);return;}
	const nodes=dfdOf(d).nodes,n=nodes.find((x)=>x.id===g.getAttribute('data-node'));if(!n)return;
	e.preventDefault();
	const r=svgEl.getBoundingClientRect();
	selNode=n.id;
	const p=nodePosition(n,nodes.indexOf(n));
	drag={id:n.id,x:p.x,y:p.y,ox:e.clientX-r.left-p.x,oy:e.clientY-r.top-p.y,moved:false};
	renderDfd(d);
});
svgEl.addEventListener('mousemove',(e)=>{
	if(!drag)return;
	const r=svgEl.getBoundingClientRect();
	drag.x=Math.max(0,Math.round(e.clientX-r.left-drag.ox));drag.y=Math.max(0,Math.round(e.clientY-r.top-drag.oy));drag.moved=true;
	renderDfd(cur());
});
function endDrag(){
	if(!drag)return;
	const dr=drag;drag=null;const d=cur();
	if(dr.moved&&isDfd(d)){const n=ensureDfd(d).nodes.find((x)=>x.id===dr.id);if(n){n.x=dr.x;n.y=dr.y;save();return;}}
	if(isDfd(d))renderDfd(d);
}
svgEl.addEventListener('mouseup',endDrag);
svgEl.addEventListener('mouseleave',endDrag);

window.addEventListener('message',(ev)=>{
	let m=ev.data;
	if(typeof m==='string'){
		try{m=JSON.parse(m);}catch{m={};}
	}
	if(m.event==='init'){
		sendDrawio(diagramXml(cur()));
		return;
	}
	if(m.type==='load'){
		components=Array.isArray(m.components)?m.components:[];available=Array.isArray(m.availableComponents)?m.availableComponents:[];
		try{doc=JSON.parse(m.doc||'{"diagrams":[]}');}catch{doc={diagrams:[]};}
		ensure();
		render();
	}
});

vs.postMessage({type:'ready'});
})();
</script></body></html>`;
    }
}
