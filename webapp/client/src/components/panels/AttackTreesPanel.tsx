// Attack-Defense Tree editor (optional artifact). An outline of attacker steps combined by
// AND / OR / SAND gates, with per-step access, skill and cost factors, plus defence
// (countermeasure) and vulnerability nodes. Deterministic metrics are derived bottom-up.
// Two interchangeable views: an indented list and a graphical (node-and-gate) diagram.
import { useState } from 'react';
import { useStore, uid } from '../../state/store';
import { TagSelect, Field, HelpButton, confirmDelete, IdInput } from '../common';
import { evaluate, COST_FACTOR_LEVELS, COST_FACTORS, updateNode, addChild, removeNode, moveChild, adId, KIND_LABEL, likelihoodFromProb, newNode, GATES, ADD_KINDS, ACCESS_OPTS, accessLabel, skillLabel, accessProbability } from '../../lib/attackTree';
import { ACTOR_LEVELS, actorLevelOption, normalizeActorLevel } from '@shared/attackerScale.js';
import { deriveImpact } from '../../lib/risk';
import AttackTreeDiagram from './AttackTreeDiagram';
import type { AdGate, AdKind, AdNode, AttackTree } from '../../types';

interface Ops {
    upd: (id: string, patch: Partial<AdNode>) => void;
    add: (parentId: string, kind: AdKind) => void;
    del: (id: string) => void;
    move: (id: string, dir: -1 | 1) => void;
}

function treeThreatRefs(tree: AttackTree) {
    const merged = [...(tree.threatRefs || []), ...(tree.threatRef ? [tree.threatRef] : [])].filter(Boolean) as string[];
    return [...new Set(merged)];
}

function NodeRow({ node, depth, ops }: { node: AdNode; depth: number; ops: Ops }) {
    const cms = useStore((s) => s.data!.countermeasures.countermeasures || []);
    const weights = useStore((s) => s.data!.project.costFactorWeights);
    const cmById = new Map(cms.map((c) => [c.id, c]));
    const isStep = node.kind === 'step' || node.kind === 'substep';
    const isStructural = !['countermeasure', 'vulnerability'].includes(node.kind);
    const hasStructuralKids = (node.children || []).some((c) => c.kind !== 'countermeasure' && c.kind !== 'vulnerability');
    const m = evaluate(node, cmById, weights);
    return (
        <div className={'adnode kind-' + node.kind} style={{ marginLeft: depth * 18 }}>
            <div className="adrow">
                <span className={'adkind k-' + node.kind}>{KIND_LABEL[node.kind]}</span>
                <input className="inp grow" value={node.label} onChange={(e) => ops.upd(node.id, { label: e.target.value })} />
                {isStructural && (
                    <select className="inp" style={{ width: 86 }} value={node.kind === 'category' ? 'OR' : node.gate || 'AND'} disabled={node.kind === 'category'} onChange={(e) => ops.upd(node.id, { gate: e.target.value as AdGate })} title={node.kind === 'category' ? 'Categories always combine alternatives with OR.' : 'How the children combine'}>
                        {GATES.map((g) => (
                            <option key={g}>{g}</option>
                        ))}
                    </select>
                )}
                {node.kind === 'countermeasure' && (
                    <select className="inp" style={{ width: 150 }} value={node.countermeasureRef || ''} onChange={(e) => ops.upd(node.id, { countermeasureRef: e.target.value || undefined })} title="Link an existing countermeasure">
                        <option value="">(link CM…)</option>
                        {cms.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.id} · {c.title}
                            </option>
                        ))}
                    </select>
                )}
                {depth > 0 && (
                    <>
                        <button className="btn sm" onClick={() => ops.move(node.id, -1)} title="Move earlier in the sequence (SAND order)">
                            ↑
                        </button>
                        <button className="btn sm" onClick={() => ops.move(node.id, 1)} title="Move later in the sequence (SAND order)">
                            ↓
                        </button>
                    </>
                )}
                <button className="btn sm danger" onClick={() => ops.del(node.id)} title="Delete node">
                    ✕
                </button>
            </div>

            {isStep && !hasStructuralKids && (
                <div className="adattrs">
                    <label className="minifield" style={{ width: 172 }}>
                        <span>Required access</span>
                        <select className="inp" value={node.access ?? 3} onChange={(e) => ops.upd(node.id, { access: Number(e.target.value) })}>
                            {ACCESS_OPTS.map(([v, l]) => (
                                <option key={v} value={v}>
                                    {v} · {l}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="minifield" style={{ width: 172 }}>
                        <span>Required capability (threat actor)</span>
                        <select className="inp" style={{ width: '100%', maxWidth: '100%', textOverflow: 'ellipsis' }} value={normalizeActorLevel(node.skill ?? 2)} onChange={(e) => ops.upd(node.id, { skill: Number(e.target.value) })}>
                            {ACTOR_LEVELS.map(({ level }) => (
                                <option key={level} value={level}>
                                    {actorLevelOption(level)}
                                </option>
                            ))}
                        </select>
                        <span className="hint">{ACTOR_LEVELS.find((l) => l.level === normalizeActorLevel(node.skill ?? 2))?.description}</span>
                    </label>
                    <details className="costf">
                        <summary>cost factors</summary>
                        <div className="costgrid">
                            {COST_FACTORS.map((f) => (
                                <label key={f.k} className="minifield">
                                    <span title={`weight ${f.weight}`}>{f.label}</span>
                                    <select className="inp" value={(node.cost as any)?.[f.k] ?? ''} onChange={(e) => ops.upd(node.id, { cost: { ...(node.cost || {}), [f.k]: e.target.value === '' ? undefined : Number(e.target.value) } })}>
                                        <option value="">–</option>
                                        {COST_FACTOR_LEVELS[f.k].map(([value, label]) => (
                                            <option key={value} value={value}>{value} · {label}</option>
                                        ))}
                                    </select>
                                </label>
                            ))}
                        </div>
                    </details>
                </div>
            )}

            {hasStructuralKids && (
                <div className="adderived" title="Derived bottom-up from the sub-steps via the gate logic (AND/SAND = hardest sub-step, OR = easiest).">
                    <span className="dtag">required access <b>{Math.round(m.accessReq) || '–'} · {accessLabel(m.accessReq)}</b></span>
                    <span className="dtag">required capability <b>{skillLabel(m.skillReq)}</b></span>
                    <span className="dtag">success ≈ {Math.round(m.prob * 100)}%</span>
                    <span className="muted">derived from {node.gate} of sub-steps</span>
                </div>
            )}

            <div className="adadd">
                {(node.kind === 'substep' ? ADD_KINDS.filter((kind) => !['step', 'substep', 'category'].includes(kind)) : ADD_KINDS).map((k) => (
                    <button key={k} className="btn sm ghost" onClick={() => ops.add(node.id, k)}>
                        + {KIND_LABEL[k]}
                    </button>
                ))}
            </div>

            {(node.children || []).map((c) => (
                <NodeRow key={c.id} node={c} depth={depth + 1} ops={ops} />
            ))}
        </div>
    );
}

function TreeCard({ tree, view }: { tree: AttackTree; view: 'list' | 'diagram' }) {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const trees = data.attackTrees?.trees || [];
    const threats = data.threats.threats || [];
    const attackers = data.assumptions.attacker || [];
    const linkedThreatIds = treeThreatRefs(tree);
    const linkedThreatLabel = linkedThreatIds.join(', ');

    const writeTrees = (list: AttackTree[]) => save('attackTrees', { trees: list });
    const updTree = (patch: Partial<AttackTree>) => writeTrees(trees.map((t) => (t.id === tree.id ? { ...t, ...patch } : t)));
    const setRoot = (root: AdNode) => updTree({ root });
    const ops: Ops = {
        upd: (id, patch) => setRoot(updateNode(tree.root, id, patch)),
        add: (parentId, kind) => setRoot(addChild(tree.root, parentId, newNode(kind))),
        del: (id) => {
            if (id === tree.root.id) return; // never delete the goal root
            setRoot(removeNode(tree.root, id));
        },
        move: (id, dir) => setRoot(moveChild(tree.root, id, dir)),
    };

    const m = evaluate(tree.root, new Map((data.countermeasures.countermeasures || []).map((c) => [c.id, c])), data.project.costFactorWeights);
    const vectorProbability = m.prob * accessProbability(m.accessReq, data.project.accessProbabilities);
    const treeUnfeasible = !!attackers[0] && m.skillReq > (normalizeActorLevel(attackers[0].capability) as number);
    const hasSteps = (tree.root.children || []).some((c) => c.kind !== 'countermeasure' && c.kind !== 'vulnerability');
    const setThreatLinks = (next: string[]) => updTree({ threatRefs: next, threatRef: next[0] || undefined });

    const applyToThreat = () => {
        if (!linkedThreatIds.length) return;
        const L = likelihoodFromProb(treeUnfeasible ? 0 : vectorProbability, data.project.likelihoodProbabilityThresholds);
        const goalImpact = deriveImpact(tree.root.impactDimensions);
        save('threats', {
            threats: threats.map((t) => linkedThreatIds.includes(t.id)
                ? { ...t, requiredSkill: m.skillReq, requiredAccess: m.accessReq, costLikelihood: treeUnfeasible ? 0 : vectorProbability, costLikelihoodProposal: L, likelihood: L, ...(tree.root.impactDimensions ? { impactDimensions: tree.root.impactDimensions, impact: goalImpact ?? t.impact } : {}), status: treeUnfeasible ? 'unfeasible' : t.status === 'unfeasible' ? 'open' : t.status }
                : t),
        });
    };
    return (
        <div className="card">
            <div className="head">
                <IdInput id={tree.id} />
                <input className="inp grow" value={tree.title} onChange={(e) => updTree({ title: e.target.value })} />
                <button className="btn sm danger" aria-label={`Delete attack tree ${tree.id}`} onClick={() => confirmDelete(`attack tree ${tree.id}`) && writeTrees(trees.filter((t) => t.id !== tree.id))}>
                    ✕
                </button>
            </div>

            <Field label="Linked threats">
                <TagSelect
                    options={threats.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))}
                    value={linkedThreatIds}
                    onChange={setThreatLinks}
                    empty="No threats available yet."
                    label="linked threats"
                />
            </Field>

            <div className="admetrics">
                {hasSteps ? (
                    <>
                        <span className="tag">required capability {skillLabel(m.skillReq)}</span>
                        <span className="tag">required access {m.accessReq || '–'}</span>
                        <span className="tag">goal cost likelihood ≈ {Math.round(m.prob * 100)}%</span>
                        <span className="tag">attack-vector likelihood ≈ {Math.round(vectorProbability * 100)}%</span>
                        <span className="tag">defences {m.defenses}</span>
                        {m.vulns ? <span className="tag">vulnerabilities {m.vulns}</span> : null}
                        {linkedThreatIds.length > 0 && (
                            <button className="btn sm" onClick={applyToThreat} title={`Set linked threat likelihoods (${linkedThreatLabel}) from this tree's cheapest path`}>
                                → set linked threat likelihood{linkedThreatIds.length > 1 ? 's' : ''} = {likelihoodFromProb(treeUnfeasible ? 0 : vectorProbability, data.project.likelihoodProbabilityThresholds)}
                            </button>
                        )}
                        <span className="muted" style={{ marginLeft: 8 }}>
                            feasible for:{' '}
                            {attackers
                                .filter((a) => m.skillReq <= ((normalizeActorLevel(a.capability) as number) || 0))
                                .map((a) => a.name)
                                .join(', ') || 'none of the defined attackers'}
                        </span>
                    </>
                ) : (
                    <span className="muted">Add attacker steps below to compute required access/skill, success probability and feasibility.</span>
                )}
            </div>

            <div className="adtree">
                {view === 'diagram' ? <AttackTreeDiagram tree={tree} ops={ops} /> : <NodeRow node={tree.root} depth={0} ops={ops} />}
            </div>
        </div>
    );
}

export default function AttackTreesPanel() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const trees = data.attackTrees?.trees || [];
    const threats = data.threats.threats || [];
    const [view, setView] = useState<'list' | 'diagram'>('diagram');

    const add = () => {
        const root: AdNode = { id: adId(), kind: 'goal', label: 'Attacker goal', gate: 'OR', children: [] };
        const firstThreat = threats[0]?.id;
        save('attackTrees', {
            trees: [
                ...trees,
                {
                    id: uid('AT', trees.map((t) => t.id)),
                    title: 'New attack tree',
                    threatRef: firstThreat,
                    threatRefs: firstThreat ? [firstThreat] : [],
                    root,
                },
            ],
        });
    };

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Attack trees</h1>
                <HelpButton title="Attack-defence trees (thesis tip)">
                    <p>
                        Decompose a high-risk threat into attacker steps joined by gates. <b>AND</b>/<b>SAND</b> require every child; <b>OR</b> takes the easiest path; <b>SAND</b> also fixes the order.
                    </p>
                    <p className="muted">Use trees for the highest-risk threats only.</p>
                </HelpButton>
            </div>
            <p className="lead">
                Optional analysis for high-risk threats.
            </p>

            <div className="toolbar">
                <button className="btn primary sm" onClick={add}>
                    + Attack tree
                </button>
                <span className="seg" role="group" aria-label="Attack tree view">
                    <button className={'btn sm' + (view === 'diagram' ? ' primary' : '')} onClick={() => setView('diagram')} title="Graphical attack-defence tree">
                        ◇ Diagram
                    </button>
                    <button className={'btn sm' + (view === 'list' ? ' primary' : '')} onClick={() => setView('list')} title="Indented outline">
                        ≣ List
                    </button>
                </span>
                <span className="hint">AND = all needed · OR = any path · SAND = ordered sequence.</span>
            </div>

            {trees.length ? (
                trees.map((t) => <TreeCard key={t.id} tree={t} view={view} />)
            ) : (
                <p className="hint">No attack trees yet.</p>
            )}
        </div>
    );
}
