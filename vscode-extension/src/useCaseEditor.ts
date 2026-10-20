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

        const post = async () => panel.webview.postMessage({ type: "load", doc: doc.getText() || '{"diagrams":[]}' });
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
	</aside>
	<main id="right"><iframe id="f" src="${frameSrc}"></iframe></main>
</div>

<script>
(function(){
const vs=acquireVsCodeApi();
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=(p,arr)=>{const used=new Set();(arr||[]).forEach(x=>{const id=x&&x.id;if(typeof id!=='string'||id.indexOf(p)!==0)return;const rest=id.slice(p.length);if(/^[0-9]+$/.test(rest))used.add(Number(rest));});let n=1;while(used.has(n))n++;return p+n;};
const ENTITY_PREFIX={actor:'A','misuse-actor':'MA',action:'U','misuse-action':'MU'};

let doc={diagrams:[]};
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

function save(){
	vs.postMessage({type:'save',doc:JSON.stringify(doc,null,2)});
	const d=cur();
	if(d){d.drawioXml=toMxXml(d);sendDrawio(d.drawioXml);}
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
	const sel=$('diagSel');
	sel.innerHTML=doc.diagrams.map((x,i)=>'<option value="'+i+'"'+(i===di?' selected':'')+'>'+esc(x.name||x.id)+'</option>').join('')||'<option>(no diagrams)</option>';
	$('diagName').value=d?d.name||'':'';
	if(!d){$('entities').innerHTML='<p class="muted">Add a diagram to start.</p>';$('conns').innerHTML='';$('groups').innerHTML='';sendDrawio('<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');return;}

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
	if(t.id==='delDiag'){if(!d)return;doc.diagrams.splice(di,1);ensure();save();return;}
	if(t.id==='exitBtn'){vs.postMessage({type:'exit'});return;}
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
	if(t.id==='diagName'){d.name=t.value;save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-entity')){const i=+t.getAttribute('data-entity');const k=t.getAttribute('data-k');if(k==='x'||k==='y')d.entities[i][k]=t.value===''?undefined:Number(t.value);else d.entities[i][k]=t.value;save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-conn')){const i=+t.getAttribute('data-conn');const k=t.getAttribute('data-k');d.connections[i][k]=k==='dashed'?!!t.checked:t.value;save();return;}
	if(t.hasAttribute&&t.hasAttribute('data-group')){const i=+t.getAttribute('data-group');const k=t.getAttribute('data-k');d.groups[i][k]=t.value;save();return;}
});

$('diagSel').addEventListener('change',(e)=>{di=+e.target.value;ensure();render();});

window.addEventListener('message',(ev)=>{
	let m=ev.data;
	if(typeof m==='string'){
		try{m=JSON.parse(m);}catch{m={};}
	}
	if(m.event==='init'){
		const d=cur();
		sendDrawio(d?(d.drawioXml||toMxXml(d)):'<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');
		return;
	}
	if(m.type==='load'){
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

