import { useState } from 'react';
import { useStore, uid } from '../state/store';
import { validate, openIssues } from '../lib/validate';
import { riskOf, descendantComponentIds } from '../lib/risk';
import RiskMatrix from './RiskMatrix';
import { RiskPill, TagSelect, IdInput } from './common';
import type { DfdNodeType, UseCaseArrow, UseCaseEntityKind } from '../types';

const HANDLE_OPTS = [
    ['t', 'top'],
    ['tr', 'top-right'],
    ['r', 'right'],
    ['br', 'bottom-right'],
    ['b', 'bottom'],
    ['bl', 'bottom-left'],
    ['l', 'left'],
    ['tl', 'top-left'],
] as const;

const HELP: Record<string, string> = {
    project: 'Keep the boundary to one sentence. Choose the smallest modelling depth (blackbox → graybox → whitebox) that still answers your question.',
    assumptions: 'Attacker profiles are mandatory: capability (threat actor 1–4) and access (remote→physical) feed the likelihood rubric directly.',
    system: 'Rate each asset’s C/I/A/Safety (0–5). Impact later defaults to the worst plausible asset (max of C/I/A/Safety).',
    dfd: 'Flows that cross a trust boundary are the threat hot-spots. Drill into a process to model its internals on a deeper layer.',
    useCases: 'Optional: model actors and actions, plus misuse-case variants for abuse scenarios. Group related entities with a named grouping box. Report inclusion defaults to off.',
    threats: 'One STRIDE threat can touch many components. Likelihood × Impact = initial risk, banded Low/Medium/High/Critical.',
    countermeasures: 'A countermeasure can address several threats; record the residual L/I per link. Residual risk = the lowest residual achieved.',
    attackTrees: 'Optional: decompose an important threat into attacker steps (AND/OR/SAND) and attach defences. Each step carries access, skill and cost factors.',
    review: 'Resolve plausibility issues (orphans, unknown references, missing attacker) before releasing the report.',
};

function NodeInspector() {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const save = useStore((s) => s.save);
    const setView = useStore((s) => s.setView);
    const openStrideBoundary = useStore((s) => s.openStrideBoundary);
    const selectedNodeId = useStore((s) => s.selectedNodeId);
    const dfdPath = useStore((s) => s.dfdPath);
    const [target, setTarget] = useState('');
    const [dir, setDir] = useState<'out' | 'in'>('out');
    const [connLabel, setConnLabel] = useState('');
    const node = data.dfd.nodes.find((n) => n.id === selectedNodeId);
    if (!node) return null;

    const dfd = data.dfd;
    const currentParent = dfdPath.length ? dfdPath[dfdPath.length - 1] : null;
    const siblings = dfd.nodes.filter((n) => (n.parent ?? null) === currentParent && n.id !== node.id && n.type !== 'trust-boundary');
    const connIfaces = (data.system.interfaces || []).filter((itf) => !itf.hidden);
    const nodeLabel = (id: string) => dfd.nodes.find((n) => n.id === id)?.label || connIfaces.find((i) => i.id === id)?.name || id;
    const updNode = (patch: any) => save('dfd', { ...dfd, nodes: dfd.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) });
    const setFlows = (flows: any[]) => save('dfd', { ...dfd, flows });
    const deleteNode = () => {
        save('dfd', { ...dfd, nodes: dfd.nodes.filter((n) => n.id !== node.id), flows: dfd.flows.filter((f) => f.from !== node.id && f.to !== node.id) });
        useStore.getState().selectNode(null);
    };
    const cms = data.countermeasures.countermeasures || [];
    const compIds = node.componentRef ? descendantComponentIds(data.system.components || [], node.componentRef) : null;
    const rolledUp = !!compIds && compIds.size > 1;
    const rel = (data.threats.threats || []).filter((t) => compIds && (t.components || []).some((c) => compIds.has(c)));
    const conns = dfd.flows.filter((f) => f.from === node.id || f.to === node.id);
    const isTb = node.type === 'trust-boundary';
    const isDeviceHousing = node.id === 'TB-1';

    const addConn = () => {
        if (!target || !connLabel.trim()) return;
        const id = uid('F', dfd.flows.map((f) => f.id));
        const flow = dir === 'out' ? { id, from: node.id, to: target, label: connLabel.trim() } : { id, from: target, to: node.id, label: connLabel.trim() };
        setFlows([...dfd.flows, flow]);
        setTarget('');
        setConnLabel('');
    };
    const updConn = (id: string, patch: any) => setFlows(dfd.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    const delConn = (id: string) => setFlows(dfd.flows.filter((f) => f.id !== id));

    const addThreatForComponent = () => {
        if (!node.componentRef) return;
        const threats = data.threats.threats || [];
        const t = { id: uid('T', threats.map((x) => x.id)), title: `Threat on ${node.label}`, stride: ['T'], components: [node.componentRef], likelihood: 3, impact: 3, status: 'open' };
        save('threats', { threats: [...threats, t] });
        setView('threats');
    };

    return (
        <div className="block">
            <h2>Selected {isTb ? 'trust boundary' : 'node'}</h2>
            <div className="field">
                <label>Label</label>
                <input className="inp" value={node.label} onChange={(e) => updNode({ label: e.target.value })} />
            </div>
            <div className="field">
                <label>Type</label>
                <select className="inp" value={node.type} onChange={(e) => updNode({ type: e.target.value as DfdNodeType })}>
                    {['external-entity', 'process', 'multiprocess', 'store', 'trust-boundary'].map((o) => (
                        <option key={o}>{o}</option>
                    ))}
                </select>
            </div>

            {isTb ? (
                <div className="field">
                    <label>Members (a trust boundary must contain at least one)</label>
                    <TagSelect
                        options={siblings.map((s) => ({ value: s.id, label: s.label }))}
                        value={node.members || []}
                        onChange={(v) => updNode({ members: v })}
                        empty="No nodes on this layer yet."
                    />
                    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => openStrideBoundary(node.id)}>
                        STRIDE strengths / weaknesses
                    </button>
                    {isDeviceHousing ? (
                        <span className="hint" style={{ display: 'inline-block', marginTop: 8, marginLeft: 8 }}>
                            Device housing is mandatory and cannot be deleted.
                        </span>
                    ) : (
                        <button className="btn sm danger" style={{ marginTop: 8, marginLeft: 8 }} onClick={deleteNode}>
                            Delete trust boundary
                        </button>
                    )}
                </div>
            ) : (
                <>
                    <div className="field">
                        <label>Linked component</label>
                        <select className="inp" value={node.componentRef || ''} onChange={(e) => updNode({ componentRef: e.target.value || undefined })}>
                            <option value="">— none —</option>
                            {(data.system.components || []).map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.name} ({c.id})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="sep-h" />
                    <h2>Connections</h2>
                    {conns.length ? (
                        <div className="list">
                            {conns.map((f) => {
                                const outgoing = f.from === node.id;
                                const other = outgoing ? f.to : f.from;
                                return (
                                    <div className="conn" key={f.id}>
                                        <span className="connarrow">{outgoing ? '→' : '←'}</span>
                                        <span className="connpeer" title={nodeLabel(other)}>
                                            {nodeLabel(other)}
                                        </span>
                                        <input className="inp" placeholder="data / label" value={f.label || ''} onChange={(e) => updConn(f.id, { label: e.target.value })} />
                                        <button className="btn sm danger" onClick={() => delConn(f.id)}>
                                            ✕
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="hint">No connections yet.</p>
                    )}
                    <div className="conn" style={{ marginTop: 8 }}>
                        <select className="inp" style={{ width: 78 }} value={dir} onChange={(e) => setDir(e.target.value as any)}>
                            <option value="out">→ to</option>
                            <option value="in">← from</option>
                        </select>
                        <select className="inp grow" value={target} onChange={(e) => setTarget(e.target.value)}>
                            <option value="">Node / interface…</option>
                            {siblings.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.label}
                                </option>
                            ))}
                            {connIfaces.length > 0 && (
                                <optgroup label="Interfaces">
                                    {connIfaces.map((itf) => (
                                        <option key={itf.id} value={itf.id}>
                                            {itf.name}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                    </div>
                    <div className="conn">
                        <input className="inp grow" placeholder="Label (what data / command) — required" value={connLabel} onChange={(e) => setConnLabel(e.target.value)} />
                        <button className="btn sm" disabled={!target || !connLabel.trim()} onClick={addConn}>
                            + Add
                        </button>
                    </div>

                    {node.componentRef && (
                        <>
                            <div className="sep-h" />
                            <h2>Threats on this component{rolledUp ? ' (incl. sub-components)' : ''}</h2>
                            {rel.length ? (
                                <div className="list">
                                    {rel.map((t) => {
                                        const r = riskOf(t, cms, scheme);
                                        return (
                                            <div className="inline" key={t.id} style={{ justifyContent: 'space-between' }}>
                                                <span className="muted" style={{ flex: 1 }}>
                                                    {t.id} · {t.title}
                                                </span>
                                                <RiskPill score={r.residual} band={r.residualBand} />
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="hint">No threats reference this component yet.</p>
                            )}
                            <button className="btn sm" style={{ marginTop: 8 }} onClick={addThreatForComponent}>
                                + Threat for this component
                            </button>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

function EdgeInspector() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const selectedEdgeId = useStore((s) => s.selectedEdgeId);
    const selectEdge = useStore((s) => s.selectEdge);
    const dfd = data.dfd;
    const flow = dfd.flows.find((f) => f.id === selectedEdgeId);
    if (!flow) return null;
    const nodeLabel = (id: string) => dfd.nodes.find((n) => n.id === id)?.label || id;
    const upd = (patch: any) => save('dfd', { ...dfd, flows: dfd.flows.map((f) => (f.id === flow.id ? { ...f, ...patch } : f)) });
    const boundaries = Array.from(
        new Set([
            ...(data.system.trustBoundaries || []).map((b) => b.id),
            ...dfd.nodes.filter((n) => n.type === 'trust-boundary').map((n) => n.id),
        ]),
    );
    return (
        <div className="block">
            <h2>Selected data flow</h2>
            <p className="hint">
                {nodeLabel(flow.from)} → {nodeLabel(flow.to)}
            </p>
            <div className="field">
                <label>Label / data carried</label>
                <input className="inp" value={flow.label || ''} onChange={(e) => upd({ label: e.target.value })} placeholder="e.g. level value, config" />
            </div>
            <div className="field">
                <label>Crosses trust boundary</label>
                <select className="inp" value={flow.crossesBoundary || ''} onChange={(e) => upd({ crossesBoundary: e.target.value || null })}>
                    <option value="">— no —</option>
                    {boundaries.map((b) => (
                        <option key={b} value={b}>
                            {b}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label>Junction point on source object</label>
                <select className="inp" value={flow.sourceHandle || ''} onChange={(e) => upd({ sourceHandle: e.target.value || null })}>
                    <option value="">Auto (closest)</option>
                    {HANDLE_OPTS.map(([handle, label]) => (
                        <option key={handle} value={`s-${handle}`}>
                            {label}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label>Junction point on target object</label>
                <select className="inp" value={flow.targetHandle || ''} onChange={(e) => upd({ targetHandle: e.target.value || null })}>
                    <option value="">Auto (closest)</option>
                    {HANDLE_OPTS.map(([handle, label]) => (
                        <option key={handle} value={`t-${handle}`}>
                            {label}
                        </option>
                    ))}
                </select>
            </div>
            <button
                className="btn sm danger"
                onClick={() => {
                    save('dfd', { ...dfd, flows: dfd.flows.filter((f) => f.id !== flow.id) });
                    selectEdge(null);
                }}
            >
                Delete flow
            </button>
        </div>
    );
}

function InterfaceInspector() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const selectedNodeId = useStore((s) => s.selectedNodeId)!;
    const ifaceId = selectedNodeId.slice(6);
    const sys = data.system;
    const dfd = data.dfd;
    const dfdPath = useStore((s) => s.dfdPath);
    const currentParent = dfdPath.length ? dfdPath[dfdPath.length - 1] : null;
    const rotKey = `${currentParent ?? 'root'}:${ifaceId}`;
    const rotation = dfd.ifaceRot?.[rotKey] || 0;
    const itf = (sys.interfaces || []).find((i) => i.id === ifaceId);
    if (!itf) return null;
    const upd = (patch: any) => save('system', { ...sys, interfaces: (sys.interfaces || []).map((i) => (i.id === itf.id ? { ...i, ...patch } : i)) });
    const setRotation = (deg: number) =>
        save('dfd', {
            ...dfd,
            ifaceRot: {
                ...(dfd.ifaceRot || {}),
                [rotKey]: deg,
            },
        });
    return (
        <div className="block">
            <h2>Selected interface</h2>
            <div className="field">
                <label>ID</label>
                <IdInput id={itf.id} />
            </div>
            <div className="field">
                <label>Name</label>
                <input className="inp" value={itf.name} onChange={(e) => upd({ name: e.target.value })} />
            </div>
            <div className="field">
                <label>Chip tag (shown on the chip)</label>
                <input className="inp" value={itf.tag || ''} onChange={(e) => upd({ tag: e.target.value })} placeholder="e.g. BLE, HMI, JTAG" />
            </div>
            <div className="field">
                <label>Protocol / transport</label>
                <input className="inp" value={itf.protocol || ''} onChange={(e) => upd({ protocol: e.target.value })} placeholder="e.g. Bluetooth LE, RS-485, UART" />
            </div>
            <div className="field">
                <label>Linked component</label>
                <select className="inp" value={itf.component || ''} onChange={(e) => upd({ component: e.target.value || undefined })}>
                    <option value="">— none —</option>
                    {(sys.components || []).map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name} ({c.id})
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label>Exposure</label>
                <select className="inp" value={itf.exposure} onChange={(e) => upd({ exposure: e.target.value })}>
                    {['physical', 'local', 'adjacent', 'remote'].map((v) => (
                        <option key={v} value={v}>
                            {v}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label>Category</label>
                <input className="inp" value={itf.category || ''} onChange={(e) => upd({ category: e.target.value })} placeholder="e.g. network, debug, physical" />
            </div>
            <div className="field">
                <label>Visibility in DFD view</label>
                <label className="check">
                    <input type="checkbox" checked={!!itf.hidden} onChange={(e) => upd({ hidden: e.target.checked })} /> hide this interface
                </label>
                <p className="hint" style={{ marginTop: 8 }}>
                    Hidden interfaces are not shown in step 04, but remain in data and can be unhidden in step 03.
                </p>
            </div>
            <div className="field">
                <label>Rotation (current layer)</label>
                <input
                    className="inp"
                    type="range"
                    min={0}
                    max={330}
                    step={30}
                    value={rotation}
                    onChange={(e) => setRotation(Number(e.target.value) || 0)}
                />
                <div className="inline" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <span className="hint">{rotation}°</span>
                    <button className="btn sm" onClick={() => setRotation(0)}>
                        Reset
                    </button>
                </div>
            </div>
            <p className="hint">External entities outside the boundary connect down into this chip. Add or remove interfaces on the System page.</p>
        </div>
    );
}

const UC_ENTITY_KINDS: UseCaseEntityKind[] = ['actor', 'misuse-actor', 'action', 'misuse-action'];
const UC_ENTITY_LABEL: Record<UseCaseEntityKind, string> = { actor: 'Actor', 'misuse-actor': 'Misuse actor', action: 'Action', 'misuse-action': 'Misuse action' };
const UC_ARROW_OPTS: { value: UseCaseArrow; label: string }[] = [
    { value: 'none', label: 'No arrow' },
    { value: 'forward', label: '→ forward' },
    { value: 'backward', label: '← backward' },
    { value: 'both', label: '↔ both' },
];

/** The use-case diagram currently shown in the main panel (falls back to the first diagram). */
function useActiveUcDiagram() {
    const data = useStore((s) => s.data)!;
    const ucDiagramId = useStore((s) => s.ucDiagramId);
    const diagrams = data.useCases?.diagrams || [];
    const diagram = diagrams.find((d) => d.id === ucDiagramId) || diagrams[0] || null;
    const save = useStore((s) => s.save);
    const setDiagram = (patch: any) => {
        if (!diagram) return;
        save('useCases', { diagrams: diagrams.map((d) => (d.id === diagram.id ? { ...d, ...patch } : d)) });
    };
    return { diagram, diagrams, setDiagram };
}

function UcEntityInspector() {
    const ucSelection = useStore((s) => s.ucSelection);
    const selectUcItem = useStore((s) => s.selectUcItem);
    const { diagram, setDiagram } = useActiveUcDiagram();
    const entity = diagram?.entities.find((e) => e.id === ucSelection?.id);
    if (!diagram || !entity) return null;

    const upd = (patch: any) => setDiagram({ entities: diagram.entities.map((e) => (e.id === entity.id ? { ...e, ...patch } : e)) });
    const del = () => {
        setDiagram({
            entities: diagram.entities.filter((e) => e.id !== entity.id),
            connections: diagram.connections.filter((c) => c.from !== entity.id && c.to !== entity.id),
            groups: diagram.groups.map((g) => ({ ...g, members: (g.members || []).filter((m) => m !== entity.id) })),
        });
        selectUcItem(null);
    };

    return (
        <div className="block">
            <h2>Selected entity</h2>
            <div className="field">
                <label>Kind</label>
                <select className="inp" value={entity.kind} onChange={(e) => upd({ kind: e.target.value as UseCaseEntityKind })}>
                    {UC_ENTITY_KINDS.map((k) => (
                        <option key={k} value={k}>
                            {UC_ENTITY_LABEL[k]}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label>Name</label>
                <input className="inp" value={entity.name} onChange={(e) => upd({ name: e.target.value })} />
            </div>
            <button className="btn sm danger" onClick={del}>
                Delete entity
            </button>
        </div>
    );
}

function UcConnectionInspector() {
    const ucSelection = useStore((s) => s.ucSelection);
    const selectUcItem = useStore((s) => s.selectUcItem);
    const { diagram, setDiagram } = useActiveUcDiagram();
    const conn = diagram?.connections.find((c) => c.id === ucSelection?.id);
    if (!diagram || !conn) return null;
    const entityLabel = (id: string) => diagram.entities.find((e) => e.id === id)?.name || id;

    const upd = (patch: any) => setDiagram({ connections: diagram.connections.map((c) => (c.id === conn.id ? { ...c, ...patch } : c)) });
    const del = () => {
        setDiagram({ connections: diagram.connections.filter((c) => c.id !== conn.id) });
        selectUcItem(null);
    };

    return (
        <div className="block">
            <h2>Selected connection</h2>
            <p className="hint">
                {entityLabel(conn.from)} → {entityLabel(conn.to)}
            </p>
            <div className="field">
                <label>Arrow</label>
                <select className="inp" value={conn.arrow || 'none'} onChange={(e) => upd({ arrow: e.target.value as UseCaseArrow })}>
                    {UC_ARROW_OPTS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label className="check">
                    <input type="checkbox" checked={!!conn.dashed} onChange={(e) => upd({ dashed: e.target.checked })} /> Dashed line
                </label>
            </div>
            <div className="field">
                <label>Label</label>
                <input className="inp" value={conn.label || ''} onChange={(e) => upd({ label: e.target.value })} placeholder="e.g. includes, extends" />
            </div>
            <button className="btn sm danger" onClick={del}>
                Delete connection
            </button>
        </div>
    );
}

function UcGroupInspector() {
    const ucSelection = useStore((s) => s.ucSelection);
    const selectUcItem = useStore((s) => s.selectUcItem);
    const { diagram, setDiagram } = useActiveUcDiagram();
    const group = diagram?.groups.find((g) => g.id === ucSelection?.id);
    if (!diagram || !group) return null;

    const upd = (patch: any) => setDiagram({ groups: diagram.groups.map((g) => (g.id === group.id ? { ...g, ...patch } : g)) });
    const del = () => {
        setDiagram({ groups: diagram.groups.filter((g) => g.id !== group.id) });
        selectUcItem(null);
    };

    return (
        <div className="block">
            <h2>Selected grouping box</h2>
            <div className="field">
                <label>Name</label>
                <input className="inp" value={group.name} onChange={(e) => upd({ name: e.target.value })} />
            </div>
            <div className="field">
                <label>Members</label>
                <TagSelect
                    options={diagram.entities.map((e) => ({ value: e.id, label: e.name || e.id }))}
                    value={group.members || []}
                    onChange={(v) => upd({ members: v })}
                    empty="No entities on this diagram yet."
                />
            </div>
            <button className="btn sm danger" onClick={del}>
                Delete grouping box
            </button>
        </div>
    );
}

export default function Inspector() {
    const data = useStore((s) => s.data);
    const view = useStore((s) => s.activeView);
    const selectedNodeId = useStore((s) => s.selectedNodeId);
    const selectedEdgeId = useStore((s) => s.selectedEdgeId);
    const ucSelection = useStore((s) => s.ucSelection);
    if (!data) return <aside className="inspector" />;
    const issues = openIssues(validate(data), data.project?.acceptedNotices);
    const isIface = !!selectedNodeId?.startsWith('iface:');
    const selNode = view === 'dfd' && selectedNodeId && !isIface ? data.dfd.nodes.find((n) => n.id === selectedNodeId) : null;
    const matrixRef = selNode?.componentRef;

    return (
        <aside className="inspector">
            {view === 'dfd' && selectedEdgeId && <EdgeInspector />}
            {view === 'dfd' && !selectedEdgeId && isIface && <InterfaceInspector />}
            {view === 'dfd' && !selectedEdgeId && selectedNodeId && !isIface && <NodeInspector />}
            {view === 'useCases' && ucSelection?.type === 'entity' && <UcEntityInspector />}
            {view === 'useCases' && ucSelection?.type === 'connection' && <UcConnectionInspector />}
            {view === 'useCases' && ucSelection?.type === 'group' && <UcGroupInspector />}


            <div className="block">
                <h2>{matrixRef ? 'Risk on this component' : 'Residual risk matrix'}</h2>
                <RiskMatrix componentRef={matrixRef} />
            </div>

            <div className="block">
                <h2>Plausibility</h2>
                {issues.length === 0 ? (
                    <p className="hint" style={{ color: 'var(--ok)' }}>✓ No issues.</p>
                ) : (
                    <ul className="issues">
                        {issues.slice(0, 6).map((it, i) => (
                            <li key={i} className={it.severity}>
                                {it.severity === 'error' ? '⛔' : it.severity === 'notice' ? 'ℹ' : '⚠'} {it.message}
                            </li>
                        ))}
                        {issues.length > 6 && <li className="ok">+{issues.length - 6} more — see Review.</li>}
                    </ul>
                )}
            </div>

            <div className="block">
                <h2>Guidance</h2>
                <p className="hint">{HELP[view] || HELP.dfd}</p>
            </div>
        </aside>
    );
}
