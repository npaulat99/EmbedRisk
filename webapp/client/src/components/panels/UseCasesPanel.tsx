// (Mis-)use case diagram editor (step 04b, optional). Native SVG canvas — the webapp client has no
// draw.io dependency (that only lives in vscode-extension/media/drawio), so entities/connections/
// groups are modelled and rendered directly, mirroring the free-form layout of the isomorphic
// UseCaseDiagram model in ../../types. Selection lives in the store (mirroring selectedNodeId /
// selectedEdgeId for the DFD) so the right-hand Inspector edits the selected item's properties,
// matching step 04's canvas + sidebar feel.
import { useEffect, useRef, useState } from 'react';
import { useStore, uid } from '../../state/store';
import { confirmDelete, cx } from '../common';
import type { UseCaseConnection, UseCaseDiagram, UseCaseEntity, UseCaseEntityKind } from '../../types';
import IndependentDfdEditor from './IndependentDfdEditor';

const ENTITY_LABEL: Record<UseCaseEntityKind, string> = {
    actor: 'Actor',
    'misuse-actor': 'Misuse actor',
    action: 'Action',
    'misuse-action': 'Misuse action',
};
const ENTITY_PREFIX: Record<UseCaseEntityKind, string> = { actor: 'A', 'misuse-actor': 'MA', action: 'U', 'misuse-action': 'MU' };
const KIND_DIMS: Record<UseCaseEntityKind, { w: number; h: number }> = {
    actor: { w: 74, h: 96 },
    'misuse-actor': { w: 74, h: 96 },
    action: { w: 156, h: 70 },
    'misuse-action': { w: 156, h: 70 },
};
const isActorKind = (k: UseCaseEntityKind) => k === 'actor' || k === 'misuse-actor';
const isMisuseKind = (k: UseCaseEntityKind) => k === 'misuse-actor' || k === 'misuse-action';
const center = (e: UseCaseEntity) => {
    const { w, h } = KIND_DIMS[e.kind];
    return { x: (e.x || 0) + w / 2, y: (e.y || 0) + h / 2 };
};

function connectionPoint(from: UseCaseEntity, to: UseCaseEntity, override?: { x: number; y: number }) {
    const fromPos = override || center(from);
    const toPos = center(to);
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    if (isActorKind(from.kind)) {
        return { x: fromPos.x + ux * 46, y: fromPos.y + uy * 46 };
    }

    const { w, h } = KIND_DIMS[from.kind];
    const rx = w / 2 - 4;
    const ry = h / 2 - 4;
    const scale = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry));
    return { x: fromPos.x + ux * scale, y: fromPos.y + uy * scale };
}

function EntityShape({
    ent,
    selected,
    dimmed,
    onMouseDown,
    onClick,
}: {
    ent: UseCaseEntity;
    selected: boolean;
    dimmed: boolean;
    onMouseDown: (e: React.MouseEvent) => void;
    onClick: () => void;
}) {
    const { w, h } = KIND_DIMS[ent.kind];
    const misuse = isMisuseKind(ent.kind);
    return (
        <g
            className={cx('uc-entity', misuse && 'misuse', selected && 'sel', dimmed && 'dim')}
            transform={`translate(${ent.x || 0},${ent.y || 0})`}
            onMouseDown={onMouseDown}
            onClick={onClick}
        >
            <title>{ent.name || ENTITY_LABEL[ent.kind]}</title>
            {isActorKind(ent.kind) ? (
                <>
                    <circle className="uc-shape" cx={w / 2} cy={16} r={10} />
                    <line className="uc-shape" x1={w / 2} y1={26} x2={w / 2} y2={52} />
                    <line className="uc-shape" x1={w / 2 - 16} y1={34} x2={w / 2 + 16} y2={34} />
                    <line className="uc-shape" x1={w / 2} y1={52} x2={w / 2 - 14} y2={76} />
                    <line className="uc-shape" x1={w / 2} y1={52} x2={w / 2 + 14} y2={76} />
                </>
            ) : (
                <ellipse className="uc-shape" cx={w / 2} cy={h / 2} rx={w / 2 - 4} ry={h / 2 - 4} />
            )}
            <text className="uc-label" x={w / 2} y={isActorKind(ent.kind) ? h - 4 : h / 2 + 4} textAnchor="middle">
                {(ent.name || '(unnamed)').slice(0, 22)}
            </text>
        </g>
    );
}

export default function UseCasesPanel() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const setView = useStore((s) => s.setView);
    const activeId = useStore((s) => s.activeId);
    const ucDiagramId = useStore((s) => s.ucDiagramId);
    const setUcDiagram = useStore((s) => s.setUcDiagram);
    const ucSelection = useStore((s) => s.ucSelection);
    const selectUcItem = useStore((s) => s.selectUcItem);
    const doc = data.useCases || { diagrams: [] };
    const diagrams = doc.diagrams || [];
    const [linking, setLinking] = useState(false);
    const [connectFrom, setConnectFrom] = useState<string | null>(null);
    const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const dragOffset = useRef({ x: 0, y: 0 });
    const svgRef = useRef<SVGSVGElement>(null);
    const hadDiagramsRef = useRef(diagrams.length > 0);

    const scrollEditorToTop = () => {
        const main = panelRef.current?.closest('.main');
        if (main instanceof HTMLElement) main.scrollTo({ top: 0 });
    };

    // Reset local UI state when switching TRA projects (selection itself is reset by the store).
    useEffect(() => {
        setLinking(false);
        setConnectFrom(null);
    }, [activeId]);

    useEffect(() => {
        if (!diagrams.length) {
            if (ucDiagramId !== null) setUcDiagram(null);
            return;
        }
        if (!ucDiagramId || !diagrams.some((d) => d.id === ucDiagramId)) {
            setUcDiagram(diagrams[0].id);
        }
    }, [diagrams, ucDiagramId, setUcDiagram]);

    useEffect(() => {
        if (!hadDiagramsRef.current && diagrams.length > 0) {
            requestAnimationFrame(scrollEditorToTop);
        }
        hadDiagramsRef.current = diagrams.length > 0;
    }, [diagrams.length]);

    const activeDiagram = diagrams.find((d) => d.id === ucDiagramId) || diagrams[0] || null;

    useEffect(() => {
        if (!activeDiagram) {
            if (ucSelection) selectUcItem(null);
            return;
        }
        if (!ucSelection) return;
        const exists =
            (ucSelection.type === 'entity' && activeDiagram.entities.some((e) => e.id === ucSelection.id)) ||
            (ucSelection.type === 'connection' && activeDiagram.connections.some((c) => c.id === ucSelection.id)) ||
            (ucSelection.type === 'group' && activeDiagram.groups.some((g) => g.id === ucSelection.id));
        if (!exists) selectUcItem(null);
    }, [activeDiagram, ucSelection, selectUcItem]);

    const setDiagrams = (next: UseCaseDiagram[]) => save('useCases', { diagrams: next });
    const updateDiagram = (id: string, patch: Partial<UseCaseDiagram>) => setDiagrams(diagrams.map((d) => (d.id === id ? { ...d, ...patch } : d)));

    const addDiagram = (kind: 'use-case' | 'independent-dfd' = 'use-case') => {
        const id = uid('UC', diagrams.map((d) => d.id));
        const next: UseCaseDiagram = {
            id,
            name: kind === 'independent-dfd' ? `Data flow ${diagrams.length + 1}` : `Use cases ${diagrams.length + 1}`,
            kind,
            entities: [],
            connections: [],
            groups: [],
            ...(kind === 'independent-dfd' ? { dfd: { nodes: [], flows: [] } } : {}),
        };
        setDiagrams([...diagrams, next]);
        setUcDiagram(id);
    };
    const deleteDiagram = async (id: string) => {
        if (!(await confirmDelete(`use-case diagram ${id}`))) return;
        const next = diagrams.filter((d) => d.id !== id);
        setDiagrams(next);
        setUcDiagram(next[0]?.id || null);
    };

    // Declared before the early return below so the hook order stays stable when the first diagram appears.
    useEffect(() => {
        if (!drag || !activeDiagram) return;
        const diagramId = activeDiagram.id;
        const diagramEntities = activeDiagram.entities || [];
        const onMove = (e: MouseEvent) => {
            const rect = svgRef.current!.getBoundingClientRect();
            const x = Math.max(0, Math.round(e.clientX - rect.left - dragOffset.current.x));
            const y = Math.max(0, Math.round(e.clientY - rect.top - dragOffset.current.y));
            setDrag((d) => (d ? { ...d, x, y } : d));
        };
        const onUp = () =>
            setDrag((d) => {
                if (!d) return null;
                updateDiagram(diagramId, { entities: diagramEntities.map((ent) => (ent.id === d.id ? { ...ent, x: d.x, y: d.y } : ent)) });
                return null;
            });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drag?.id]);

    if (!activeDiagram) {
        return (
            <div className="panel" ref={panelRef}>
                <div className="panelhead">
                    <h1>Scenarios & diagrams</h1>
                </div>
                <p className="lead">Model actors, actions and misuse-case variants for the device. Optional and excluded from the report by default.</p>
                <div className="inline">
                    <button className="btn primary" onClick={() => addDiagram('use-case')}>
                        + New use case
                    </button>
                    <button className="btn" onClick={() => addDiagram('independent-dfd')}>
                        + New DFD
                    </button>
                    <button className="btn sm" onClick={() => setView('project')}>
                        ← Exit to project
                    </button>
                </div>
            </div>
        );
    }

    const entities = activeDiagram.entities || [];
    const connections = activeDiagram.connections || [];
    const groups = activeDiagram.groups || [];
    const entityById = new Map(entities.map((e) => [e.id, e]));

    const setEntities = (next: UseCaseEntity[]) => updateDiagram(activeDiagram.id, { entities: next });
    const setConnections = (next: UseCaseConnection[]) => updateDiagram(activeDiagram.id, { connections: next });

    const addEntity = (kind: UseCaseEntityKind) => {
        const id = uid(ENTITY_PREFIX[kind], entities.map((e) => e.id));
        const idx = entities.length;
        setEntities([...entities, { id, kind, name: ENTITY_LABEL[kind], x: 40 + (idx % 5) * 170, y: 40 + Math.floor(idx / 5) * 130 }]);
        selectUcItem({ type: 'entity', id });
    };
    const updateEntity = (id: string, patch: Partial<UseCaseEntity>) => setEntities(entities.map((e) => (e.id === id ? { ...e, ...patch } : e)));

    const addGroup = () => {
        const id = uid('G', groups.map((g) => g.id));
        const idx = groups.length;
        updateDiagram(activeDiagram.id, {
            groups: [
                ...groups,
                {
                    id,
                    name: `Group ${groups.length + 1}`,
                    members: [],
                    x: 36 + (idx % 3) * 240,
                    y: 32 + Math.floor(idx / 3) * 170,
                    w: 220,
                    h: 128,
                },
            ],
        });
        selectUcItem({ type: 'group', id });
    };

    const onEntityClick = (id: string) => {
        if (linking) {
            if (!connectFrom) {
                setConnectFrom(id);
            } else if (connectFrom !== id) {
                const cid = uid('CN', connections.map((c) => c.id));
                setConnections([...connections, { id: cid, from: connectFrom, to: id, arrow: 'forward' }]);
                setConnectFrom(null);
                selectUcItem({ type: 'connection', id: cid });
            }
            return;
        }
        selectUcItem({ type: 'entity', id });
    };

    const onEntityMouseDown = (e: React.MouseEvent, ent: UseCaseEntity) => {
        if (linking) {
            onEntityClick(ent.id);
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        selectUcItem({ type: 'entity', id: ent.id });
        const rect = svgRef.current!.getBoundingClientRect();
        dragOffset.current = { x: e.clientX - rect.left - (ent.x || 0), y: e.clientY - rect.top - (ent.y || 0) };
        setDrag({ id: ent.id, x: ent.x || 0, y: ent.y || 0 });
    };

    const posOf = (ent: UseCaseEntity) => (drag && drag.id === ent.id ? { x: drag.x, y: drag.y } : { x: ent.x || 0, y: ent.y || 0 });

    // Canvas + group bounding boxes are derived from live (dragged) entity positions.
    const bbox = (ent: UseCaseEntity) => {
        const { x, y } = posOf(ent);
        const { w, h } = KIND_DIMS[ent.kind];
        return { x1: x, y1: y, x2: x + w, y2: y + h };
    };
    const canvasW = Math.max(760, ...entities.map((e) => bbox(e).x2 + 60), 60);
    const canvasH = Math.max(460, ...entities.map((e) => bbox(e).y2 + 60), 60);

    const groupRects = groups.map((g) => {
        const members = (g.members || []).map((id) => entityById.get(id)).filter((e): e is UseCaseEntity => !!e);
        if (!members.length) {
            return {
                group: g,
                empty: true as const,
                x: g.x ?? 36,
                y: g.y ?? 32,
                w: g.w ?? 220,
                h: g.h ?? 128,
            };
        }
        const boxes = members.map(bbox);
        const pad = 22;
        return {
            group: g,
            empty: false as const,
            x: Math.min(...boxes.map((b) => b.x1)) - pad,
            y: Math.min(...boxes.map((b) => b.y1)) - pad - 18,
            w: Math.max(...boxes.map((b) => b.x2)) - Math.min(...boxes.map((b) => b.x1)) + pad * 2,
            h: Math.max(...boxes.map((b) => b.y2)) - Math.min(...boxes.map((b) => b.y1)) + pad * 2 + 18,
        };
    });

    if (activeDiagram.kind === 'independent-dfd') {
        return (
            <div className="panel" ref={panelRef}>
                <div className="panelhead">
                    <h1>Scenarios & diagrams</h1>
                    <div className="right palette">
                        <button className="btn sm" onClick={() => addDiagram('use-case')}>+ Use case</button>
                        <button className="btn sm" onClick={() => addDiagram('independent-dfd')}>+ DFD</button>
                        <button className="btn sm danger" onClick={() => deleteDiagram(activeDiagram.id)}>Delete</button>
                        <button className="btn sm" onClick={() => setView('project')}>← Exit</button>
                    </div>
                </div>
                <p className="lead">Model a data flow for this scenario without changing the system DFD in Step 04.</p>
                <div className="dfd-bar">
                    <div className="crumbs">
                        <select className="inp" value={activeDiagram.id} onChange={(e) => setUcDiagram(e.target.value)}>
                            {diagrams.map((diagram) => <option key={diagram.id} value={diagram.id}>{diagram.name || diagram.id}</option>)}
                        </select>
                        <input className="inp" style={{ marginLeft: 8, width: 200 }} value={activeDiagram.name || ''} onChange={(e) => updateDiagram(activeDiagram.id, { name: e.target.value })} />
                    </div>
                </div>
                <IndependentDfdEditor diagram={activeDiagram} updateDiagram={(patch) => updateDiagram(activeDiagram.id, patch)} />
            </div>
        );
    }

    return (
        <div className="panel" ref={panelRef}>
            <div className="panelhead">
                <h1>Scenarios & diagrams</h1>
                <div className="right palette">
                    <button className="btn sm" onClick={() => addDiagram('use-case')} title="New use-case diagram">+ Use case</button>
                    <button className="btn sm" onClick={() => addDiagram('independent-dfd')} title="New independent data-flow diagram">+ DFD</button>
                    <button className="btn sm danger" onClick={() => deleteDiagram(activeDiagram.id)} title="Delete this diagram">Delete</button>
                    <button className="btn sm" onClick={() => setView('project')}>← Exit</button>
                </div>
            </div>
            <p className="lead">Optional supporting diagrams — use cases, misuse cases and scenario-specific data flows. Excluded from the report by default (toggle in step 01).</p>

            <div className="dfd-bar">
                <div className="crumbs">
                    <select className="inp" value={activeDiagram.id} onChange={(e) => setUcDiagram(e.target.value)}>
                        {diagrams.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.name || d.id}
                            </option>
                        ))}
                    </select>
                    <input
                        className="inp"
                        style={{ marginLeft: 8, width: 200 }}
                        value={activeDiagram.name || ''}
                        onChange={(e) => updateDiagram(activeDiagram.id, { name: e.target.value })}
                    />
                </div>
                <div className="dfd-nav">
                    <select
                        className="inp navsel"
                        value={ucSelection ? `${ucSelection.type}:${ucSelection.id}` : ''}
                        title="Select an item to inspect"
                        onChange={(e) => {
                            const value = e.target.value;
                            if (!value) {
                                selectUcItem(null);
                                return;
                            }
                            const [type, id] = value.split(':', 2) as ['entity' | 'group', string];
                            selectUcItem({ type, id });
                        }}
                    >
                        <option value="">Select item…</option>
                        {entities.map((e) => (
                            <option key={e.id} value={`entity:${e.id}`}>
                                Entity: {e.name || e.id}
                            </option>
                        ))}
                        {groups.map((g) => (
                            <option key={g.id} value={`group:${g.id}`}>
                                Group: {g.name || g.id}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="right palette">
                    <button className="btn sm" onClick={() => addEntity('actor')} title="Add actor">
                        + Actor
                    </button>
                    <button className="btn sm" onClick={() => addEntity('misuse-actor')} title="Add misuse actor">
                        + Misuse actor
                    </button>
                    <button className="btn sm" onClick={() => addEntity('action')} title="Add action">
                        + Action
                    </button>
                    <button className="btn sm" onClick={() => addEntity('misuse-action')} title="Add misuse action">
                        + Misuse action
                    </button>
                    <button className="btn sm" onClick={addGroup} title="Add a grouping box">
                        + Group
                    </button>
                    <button
                        className={cx('btn sm', linking && 'primary')}
                        onClick={() => {
                            setLinking((v) => !v);
                            setConnectFrom(null);
                        }}
                        title="Connections mode: click a source entity, then a target entity, to link them"
                    >
                        {linking ? '✓ Connections' : '🔗 Connections'}
                    </button>
                </div>
            </div>

            <div className={cx('uc-canvas', linking && 'connmode')}>
                <svg ref={svgRef} width={canvasW} height={canvasH} onMouseDown={() => selectUcItem(null)}>
                    <defs>
                        <marker id="uc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                            <path className="uc-arrow-head" d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
                        </marker>
                    </defs>

                    {groupRects.map((r) =>
                        <g
                            key={r.group.id}
                            className={cx('uc-group', ucSelection?.type === 'group' && ucSelection.id === r.group.id && 'sel', r.empty && 'empty')}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => selectUcItem({ type: 'group', id: r.group.id })}
                        >
                            <rect className="uc-group-rect" x={r.x} y={r.y} width={r.w} height={r.h} rx={8} />
                            <text className="uc-group-label" x={r.x + 10} y={r.y + 16}>
                                {r.group.name}
                            </text>
                            {r.empty && (
                                <text className="uc-group-empty" x={r.x + r.w / 2} y={r.y + r.h / 2} textAnchor="middle">
                                    Empty group
                                </text>
                            )}
                        </g>,
                    )}

                    {connections.map((c) => {
                        const from = entityById.get(c.from);
                        const to = entityById.get(c.to);
                        if (!from || !to) return null;
                        const fromPos = { ...center(from), ...(drag && drag.id === from.id ? { x: drag.x + KIND_DIMS[from.kind].w / 2, y: drag.y + KIND_DIMS[from.kind].h / 2 } : {}) };
                        const toPos = { ...center(to), ...(drag && drag.id === to.id ? { x: drag.x + KIND_DIMS[to.kind].w / 2, y: drag.y + KIND_DIMS[to.kind].h / 2 } : {}) };
                        const start = connectionPoint(from, to, drag && drag.id === from.id ? fromPos : undefined);
                        const end = connectionPoint(to, from, drag && drag.id === to.id ? toPos : undefined);
                        const arrow = c.arrow || 'none';
                        const selected = ucSelection?.type === 'connection' && ucSelection.id === c.id;
                        return (
                            <g key={c.id} className={cx('uc-conn-group', selected && 'sel')} onMouseDown={(e) => e.stopPropagation()} onClick={() => selectUcItem({ type: 'connection', id: c.id })}>
                                <line className="uc-conn-hit" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
                                <line
                                    className="uc-conn"
                                    x1={start.x}
                                    y1={start.y}
                                    x2={end.x}
                                    y2={end.y}
                                    strokeDasharray={c.dashed ? '6 4' : undefined}
                                    markerEnd={arrow === 'forward' || arrow === 'both' ? 'url(#uc-arrow)' : undefined}
                                    markerStart={arrow === 'backward' || arrow === 'both' ? 'url(#uc-arrow)' : undefined}
                                />
                                {c.label && (
                                    <text className="uc-conn-label" x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 6} textAnchor="middle">
                                        {c.label}
                                    </text>
                                )}
                            </g>
                        );
                    })}

                    {entities.map((ent) => (
                        <EntityShape
                            key={ent.id}
                            ent={{ ...ent, ...posOf(ent) }}
                            selected={(ucSelection?.type === 'entity' && ucSelection.id === ent.id) || connectFrom === ent.id}
                            dimmed={linking && !!connectFrom && connectFrom !== ent.id}
                            onMouseDown={(e) => onEntityMouseDown(e, ent)}
                            onClick={() => onEntityClick(ent.id)}
                        />
                    ))}
                </svg>
            </div>
            <p className="hint">Drag entities to reposition. Click an entity, connection or grouping box to edit it on the right. Use “Connections” mode, then click a source and a target, to link entities.</p>
        </div>
    );
}

