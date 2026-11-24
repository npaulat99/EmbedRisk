// Visual Attack-Defense Tree: a graphical, editable rendering of the same AdNode tree the list
// view edits. Notation (Kordy et al. + Jhawar et al. SAND): root on top, children branch downward;
// a gate is drawn below a parent that has more than one child — OR = plain fan-out, AND = fan-out
// with a connecting arc, SAND = AND arc carrying a left→right arrow (child order = execution order).
// Attack, defence and vulnerability nodes are drawn the same way and may alternate recursively.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import {
    evaluate,
    COST_FACTOR_LEVELS,
    COST_FACTORS,
    KIND_LABEL,
    GATES,
    ADD_KINDS,
    ACCESS_OPTS,
    accessLabel,
    skillLabel,
} from '../../lib/attackTree';
import { ACTOR_LEVELS, actorLevelOption, normalizeActorLevel } from '@shared/attackerScale.js';
import BugBarImpactSelector from '../BugBarImpactSelector';
import AppDialog from '../AppDialog';
import type { AdGate, AdKind, AdNode, AttackTree } from '../../types';

const NW = 182; // node width
const NH = 58; // node height
const HGAP = 30; // gap between sibling subtrees
const VGAP = 98; // vertical gap between a node's top and its children's top is NH + VGAP
const PAD = 28; // canvas padding
const GATE_DY = 30; // gate distance below the parent's bottom edge

interface Ops {
    upd: (id: string, patch: Partial<AdNode>) => void;
    add: (parentId: string, kind: AdKind) => void;
    del: (id: string) => void;
    move: (id: string, dir: -1 | 1) => void;
}

type Placed = { node: AdNode; x: number; y: number };

/** Width (px) needed by a node's whole subtree. */
function measure(node: AdNode): number {
    const kids = node.children || [];
    if (!kids.length) return NW;
    const w = kids.map(measure).reduce((a, b) => a + b, 0) + HGAP * (kids.length - 1);
    return Math.max(NW, w);
}

/** Assign an (x = centre, y = top) to every node, laying children out horizontally under the parent. */
function place(node: AdNode, cx: number, top: number, out: Placed[]) {
    out.push({ node, x: cx, y: top });
    const kids = node.children || [];
    if (!kids.length) return;
    const widths = kids.map(measure);
    const total = widths.reduce((a, b) => a + b, 0) + HGAP * (kids.length - 1);
    let x = cx - total / 2;
    const childTop = top + NH + VGAP;
    for (let i = 0; i < kids.length; i++) {
        place(kids[i], x + widths[i] / 2, childTop, out);
        x += widths[i] + HGAP;
    }
}

const nextGate = (g?: AdGate): AdGate => GATES[(GATES.indexOf(g || 'AND') + 1) % GATES.length];

export default function AttackTreeDiagram({ tree, ops }: { tree: AttackTree; ops: Ops }) {
    const cms = useStore((s) => s.data!.countermeasures.countermeasures || []);
    const weights = useStore((s) => s.data!.project.costFactorWeights);
    const cmById = useMemo(() => new Map(cms.map((c) => [c.id, c])), [cms]);
    const [selId, setSelId] = useState<string | null>(tree.root.id);
    const [editingId, setEditingId] = useState<string | null>(null);

    const placed = useMemo(() => {
        const out: Placed[] = [];
        place(tree.root, PAD + measure(tree.root) / 2, PAD, out);
        return out;
    }, [tree.root]);
    const posById = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);

    const W = Math.max(...placed.map((p) => p.x + NW / 2)) + PAD;
    const H = Math.max(...placed.map((p) => p.y + NH)) + PAD;

    const selected = selId ? posById.get(selId)?.node || null : null;

    // ---- edges + gates -----------------------------------------------------
    const edges: JSX.Element[] = [];
    const gates: JSX.Element[] = [];
    for (const { node, x: px, y: py } of placed) {
        const kids = node.children || [];
        if (!kids.length) continue;
        const parentBottom = py + NH;
        const kidPos = kids.map((k) => posById.get(k.id)!).filter(Boolean);
        const childTop = kidPos[0].y;
        if (kids.length === 1) {
            const k = kidPos[0];
            edges.push(<path key={'e' + node.id} className="adt-edge" d={`M ${px},${parentBottom} L ${k.x},${childTop}`} />);
            continue;
        }
        const gateY = parentBottom + GATE_DY;
        edges.push(<path key={'stem' + node.id} className="adt-edge" d={`M ${px},${parentBottom} L ${px},${gateY}`} />);
        for (const k of kidPos) edges.push(<path key={'e' + node.id + k.node.id} className="adt-edge" d={`M ${px},${gateY} L ${k.x},${childTop}`} />);

        const gate = node.kind === 'category' ? 'OR' : node.gate || 'AND';
        if (gate !== 'OR') {
            const arcY = gateY + 22;
            const t = (arcY - gateY) / (childTop - gateY);
            const lx = px + (kidPos[0].x - px) * t;
            const rx = px + (kidPos[kidPos.length - 1].x - px) * t;
            gates.push(<path key={'arc' + node.id} className="adt-arc" d={`M ${lx},${arcY} Q ${px},${arcY + 15} ${rx},${arcY}`} />);
            if (gate === 'SAND') gates.push(<path key={'arr' + node.id} className="adt-arrow" d={`M ${rx - 2},${arcY - 4.5} L ${rx + 6},${arcY} L ${rx - 2},${arcY + 4.5} Z`} />);
        }
        gates.push(
            <g key={'g' + node.id} className="adt-gate" transform={`translate(${px},${gateY})`} onClick={() => node.kind !== 'category' && ops.upd(node.id, { gate: nextGate(node.gate) })}>
                <rect x={-22} y={-11} width={44} height={22} rx={11} />
                <text x={0} y={4} textAnchor="middle">{gate}</text>
            </g>,
        );
    }

    return (
        <div className="adt-diagram">
            <div className="adt-legend">
                <span className="adt-lg k-step">Attack</span>
                <span className="adt-lg k-countermeasure">Defence</span>
                <span className="adt-lg k-vulnerability">Vulnerability</span>
                <span className="muted">· double-click a node label to assess it · click a gate to change AND / OR / SAND · SAND arrow = sequence</span>
            </div>
            <div className="adt-canvas">
                <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
                    {edges}
                    {gates}
                    {placed.map(({ node, x, y }) => {
                        const cm = node.countermeasureRef ? cmById.get(node.countermeasureRef) : undefined;
                        const metrics = evaluate(node, cmById, weights);
                        const showMetrics = node.kind === 'goal' || node.kind === 'step' || node.kind === 'substep' || node.kind === 'vulnerability' || node.kind === 'countermeasure';
                        return (
                            <foreignObject key={node.id} x={x - NW / 2} y={y} width={NW} height={NH}>
                                <div
                                    className={'adt-node k-' + node.kind + (selId === node.id ? ' sel' : '')}
                                    onClick={() => setSelId(node.id)}
                                    title={node.label}
                                >
                                    <div className="adt-node-kind">{KIND_LABEL[node.kind]}</div>
                                    <div className="adt-node-label" onDoubleClick={() => setEditingId(node.id)}>{node.label}</div>
                                    {showMetrics && <div className="adt-node-sub">{node.kind === 'countermeasure' && cm ? `${cm.id} · ` : ''}acc {metrics.accessReq || '–'} · {skillLabel(metrics.skillReq)} · {Math.round(metrics.prob * 100)}%</div>}
                                </div>
                            </foreignObject>
                        );
                    })}
                </svg>
            </div>

            {createPortal(
                <AppDialog
                    open={!!editingId && !!posById.get(editingId)?.node}
                    onClose={() => setEditingId(null)}
                    title={`Assess ${posById.get(editingId || '')?.node?.label || 'attack tree node'}`}
                    size="xl"
                    className="adt-page-modal"
                    dismissOnBackdrop
                >
                    {editingId && posById.get(editingId)?.node && (
                        <NodeAssessmentOverlay node={posById.get(editingId)!.node} ops={ops} isRoot={editingId === tree.root.id} cms={cms} onClose={() => setEditingId(null)} />
                    )}
                </AppDialog>,
                document.body,
            )}
        </div>
    );
}

function CostAssessment({
    title,
    cost,
    rationales,
    onChange,
}: {
    title: string;
    cost?: AdNode['cost'];
    rationales?: AdNode['costRationales'];
    onChange: (cost: NonNullable<AdNode['cost']>, rationales: NonNullable<AdNode['costRationales']>) => void;
}) {
    return (
        <section className="adt-assessment-section">
            <h4>{title}</h4>
            <div className="costgrid">
                {COST_FACTORS.map((factor) => (
                    <label key={factor.k} className="minifield">
                        <span>{factor.label} ({factor.weight})</span>
                        <select className="inp" value={cost?.[factor.k] ?? 3} onChange={(e) => onChange({ ...(cost || {}), [factor.k]: Number(e.target.value) }, { ...(rationales || {}) })}>
                            {COST_FACTOR_LEVELS[factor.k].map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}
                        </select>
                        <textarea className="inp" rows={2} value={rationales?.[factor.k] || ''} placeholder="Assessment reason" onChange={(e) => onChange({ ...(cost || {}) }, { ...(rationales || {}), [factor.k]: e.target.value })} />
                    </label>
                ))}
            </div>
        </section>
    );
}

function NodeAssessmentOverlay({
    node,
    ops,
    isRoot,
    cms,
    onClose,
}: {
    node: AdNode;
    ops: Ops;
    isRoot: boolean;
    cms: { id: string; title: string; status?: string }[];
    onClose: () => void;
}) {
    const isStep = node.kind === 'step' || node.kind === 'substep';
    const isGoal = node.kind === 'goal';
    const isVulnerability = node.kind === 'vulnerability';
    const isCountermeasure = node.kind === 'countermeasure';
    const isStructural = !['countermeasure', 'vulnerability'].includes(node.kind);
    const hasAttackChildren = (node.children || []).some((child) => child.kind === 'step' || child.kind === 'substep');
    const weights = useStore((s) => s.data!.project.costFactorWeights);
    const metrics = evaluate(node, new Map(cms.map((countermeasure) => [countermeasure.id, countermeasure])), weights);
    const addKinds = node.kind === 'substep' ? ADD_KINDS.filter((kind) => !['step', 'substep', 'category'].includes(kind)) : ADD_KINDS;
    const directAssessment = (isStep && !hasAttackChildren) || isVulnerability || isCountermeasure;
    const metricsLabel = isGoal || (isStep && hasAttackChildren) ? 'calculated' : 'assessed';
    const setImpact = (key: 'confidentiality' | 'integrity' | 'availability' | 'safety', value: number | undefined) => {
        const d: any = { ...(node.impactDimensions || {}) };
        if (value == null) delete d[key];
        else d[key] = value;
        ops.upd(node.id, { impactDimensions: d });
    };
    return (
        <div className="adt-node-modal-body">
            <div className="adt-editrow">
                <span className={'adkind k-' + node.kind}>{KIND_LABEL[node.kind]}</span>
                <input className="inp grow" aria-label="Node label" value={node.label} onChange={(e) => ops.upd(node.id, { label: e.target.value })} />
            </div>
            <div className="adt-editrow">
                {isStructural && node.kind !== 'category' && (
                    <label className="minifield" style={{ width: 120 }}><span>Gate</span><select className="inp" value={node.gate || 'AND'} onChange={(e) => ops.upd(node.id, { gate: e.target.value as AdGate })}>{GATES.map((gate) => <option key={gate}>{gate}</option>)}</select></label>
                )}
                {node.kind === 'category' && <span className="hint">Categories always aggregate alternatives with OR.</span>}
                {isCountermeasure && (
                    <label className="minifield" style={{ width: 260 }}><span>Linked countermeasure</span><select className="inp" value={node.countermeasureRef || ''} onChange={(e) => ops.upd(node.id, { countermeasureRef: e.target.value || undefined })}>
                        <option value="">(link CM…)</option>
                        {cms.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.id} · {c.title}
                            </option>
                        ))}
                    </select></label>
                )}
                {!isRoot && <button className="btn sm danger" type="button" onClick={() => { ops.del(node.id); onClose(); }}>Delete node</button>}
            </div>
            <div className="adderived">
                <span className="dtag">{metricsLabel} probability <b>{Math.round(metrics.prob * 100)}%</b></span>
                <span className="dtag">{metricsLabel} access <b>{metrics.accessReq || '–'} · {accessLabel(metrics.accessReq)}</b></span>
                <span className="dtag">{metricsLabel} capability <b>{skillLabel(metrics.skillReq)}</b></span>
            </div>

            {directAssessment && (
                <div className="adattrs">
                    <label className="minifield" style={{ width: 220 }}><span>Required access</span><select className="inp" value={node.access ?? 3} onChange={(e) => ops.upd(node.id, { access: Number(e.target.value) })}>
                        {ACCESS_OPTS.map(([v, l]) => (
                            <option key={v} value={v}>{v} · {l}</option>
                        ))}
                    </select></label>
                    <label className="minifield" style={{ width: 220 }}><span>Required capability (threat actor)</span><select className="inp" style={{ width: '100%', maxWidth: '100%', textOverflow: 'ellipsis' }} value={normalizeActorLevel(node.skill ?? 2)} onChange={(e) => ops.upd(node.id, { skill: Number(e.target.value) })}>
                        {ACTOR_LEVELS.map(({ level }) => (
                            <option key={level} value={level}>{actorLevelOption(level)}</option>
                        ))}
                    </select><span className="hint">{ACTOR_LEVELS.find((l) => l.level === normalizeActorLevel(node.skill ?? 2))?.description}</span></label>
                </div>
            )}
            {isStep && !hasAttackChildren && <CostAssessment title="Step difficulty assessment" cost={node.cost} rationales={node.costRationales} onChange={(cost, costRationales) => ops.upd(node.id, { cost, costRationales })} />}
            {isCountermeasure && <CostAssessment title="Residual difficulty after this defence" cost={node.residualCost} rationales={node.residualCostRationales} onChange={(residualCost, residualCostRationales) => ops.upd(node.id, { residualCost, residualCostRationales })} />}
            {isVulnerability && <CostAssessment title="Residual difficulty after exploiting this vulnerability" cost={node.residualCost} rationales={node.residualCostRationales} onChange={(residualCost, residualCostRationales) => ops.upd(node.id, { residualCost, residualCostRationales })} />}
            {isGoal && (
                <section className="adt-assessment-section">
                    <h4>Bug Bar impact</h4>
                    <BugBarImpactSelector dims={node.impactDimensions} onSelect={(key, value) => setImpact(key as any, value)} />
                </section>
            )}
            <div className="adadd">
                <span className="hint" style={{ marginRight: 4 }}>Add child:</span>
                {addKinds.map((kind) => <button key={kind} className="btn sm ghost" type="button" onClick={() => ops.add(node.id, kind)}>+ {KIND_LABEL[kind]}</button>)}
            </div>
        </div>
    );
}
