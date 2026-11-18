// The layered Data Flow Diagram — the centrepiece of the application.
//
// A "layer" is the set of nodes that share the same parent. Double-clicking (or pressing
// ArrowDown on) a process drills into its child layer; ArrowUp / the breadcrumb returns to
// the parent. Left/Right cycle the sibling selection. Every structural change (move, add,
// connect, delete) is written straight back to 04-dfd/dfd.json via the live-sync store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ReactFlow,
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    MarkerType,
    BaseEdge,
    EdgeLabelRenderer,
    useNodesState,
    useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore, uid } from '../../state/store';
import { nodeTypes } from './nodes';
import DfdOverview from './DfdOverview';
import { riskOf } from '../../lib/risk';
import { deriveVisibleInterfaceIds, flowBelongsToLayerContext, isParentChildNodeFlow, resolveTargetNodeId } from './layerVisibility.js';
import { cx, confirmDelete } from '../common';
import type { Dfd, DfdNode, DfdNodeType } from '../../types';
import { routeAround, roundedPath } from '@shared/dfdEngine.js';

function pointOnPolyline(points: number[][], fraction: number) {
    const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
    let remaining = lengths.reduce((sum, length) => sum + length, 0) * fraction;
    for (let index = 0; index < lengths.length; index++) {
        if (remaining <= lengths[index]) {
            const ratio = lengths[index] ? remaining / lengths[index] : 0;
            const from = points[index];
            const to = points[index + 1];
            const dx = to[0] - from[0];
            const dy = to[1] - from[1];
            const length = lengths[index] || 1;
            return { x: from[0] + dx * ratio, y: from[1] + dy * ratio, nx: -dy / length, ny: dx / length };
        }
        remaining -= lengths[index];
    }
    const from = points[points.length - 2];
    const to = points[points.length - 1];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    return { x: to[0], y: to[1], nx: -(to[1] - from[1]) / length, ny: (to[0] - from[0]) / length };
}

function edgeGeometry(sourceX: number, sourceY: number, targetX: number, targetY: number, obstacles: any[], offset: number) {
    const route = routeAround(sourceX, sourceY, targetX, targetY, obstacles, 16);
    const directDist = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
    let polyLen = 0;
    for (let index = 1; index < route.length; index++) polyLen += Math.hypot(route[index][0] - route[index - 1][0], route[index][1] - route[index - 1][1]);
    if (route.length > 2 && polyLen <= 2.4 * directDist) {
        return { path: roundedPath(route, 14), pointAt: (fraction: number) => pointOnPolyline(route, fraction) };
    }
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const length = Math.hypot(dx, dy) || 1;
    const controlX = (sourceX + targetX) / 2 + (-dy / length) * offset;
    const controlY = (sourceY + targetY) / 2 + (dx / length) * offset;
    return {
        path: `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`,
        pointAt: (fraction: number) => {
            const inverse = 1 - fraction;
            const x = inverse * inverse * sourceX + 2 * inverse * fraction * controlX + fraction * fraction * targetX;
            const y = inverse * inverse * sourceY + 2 * inverse * fraction * controlY + fraction * fraction * targetY;
            const tangentX = 2 * inverse * (controlX - sourceX) + 2 * fraction * (targetX - controlX);
            const tangentY = 2 * inverse * (controlY - sourceY) + 2 * fraction * (targetY - controlY);
            const tangentLength = Math.hypot(tangentX, tangentY) || 1;
            return { x, y, nx: -tangentY / tangentLength, ny: tangentX / tangentLength };
        },
    };
}

// Data-flow edge. It routes around foreground entities so it never hides behind them; when the
// straight line is already clear it keeps a gentle curve (offset) so bidirectional pairs separate.
function OffsetEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: any) {
    const obstacles = data?.obstacles || [];
    const geometry = edgeGeometry(sourceX, sourceY, targetX, targetY, obstacles, data?.offset || 0);
    const labelPosition = data?.labelPosition || geometry.pointAt(0.55);
    const labelAnchor = data?.labelAnchor || labelPosition;
    return (
        <>
            <BaseEdge id={id} path={geometry.path} markerEnd={markerEnd} interactionWidth={28} />
            {data?.label ? (
                <EdgeLabelRenderer>
                    {Math.hypot(labelPosition.x - labelAnchor.x, labelPosition.y - labelAnchor.y) > 4 ? (
                        <svg
                            className="edgelabel-leader"
                            style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
                            aria-hidden="true"
                        >
                            <line x1={labelAnchor.x} y1={labelAnchor.y} x2={labelPosition.x} y2={labelPosition.y} />
                        </svg>
                    ) : null}
                    <div
                        className="edgelabel"
                        style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`, pointerEvents: 'all' }}
                        onClick={(e) => {
                            e.stopPropagation();
                            data.onSelect?.();
                        }}
                    >
                        {data.label}
                    </div>
                </EdgeLabelRenderer>
            ) : null}
        </>
    );
}
const edgeTypes = { offset: OffsetEdge };

const TYPE_LABEL: Record<DfdNodeType, string> = {
    'external-entity': 'External entity',
    process: 'Process',
    multiprocess: 'Multi-process',
    store: 'Data store',
    'trust-boundary': 'Trust boundary',
};
const PALETTE: DfdNodeType[] = ['process', 'store', 'external-entity', 'multiprocess', 'trust-boundary'];
const COMPONENT_KIND: Record<Exclude<DfdNodeType, 'trust-boundary'>, string> = {
    process: 'software',
    multiprocess: 'multiprocess',
    store: 'store',
    'external-entity': 'external-entity',
};

const ROW: Record<string, number> = { 'external-entity': 0, process: 1, multiprocess: 1, store: 2, 'trust-boundary': 3 };
function autoLayout(nodes: DfdNode[]): Record<string, { x: number; y: number }> {
    const col: Record<number, number> = {};
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
        const r = ROW[n.type] ?? 1;
        col[r] = col[r] || 0;
        pos[n.id] = { x: 90 + col[r] * 240, y: 70 + r * 160 };
        col[r]++;
    }
    return pos;
}

const NODE_SIZE: Record<string, { w: number; h: number }> = {
    'external-entity': { w: 150, h: 60 },
    process: { w: 124, h: 84 },
    multiprocess: { w: 124, h: 84 },
    store: { w: 140, h: 60 },
};
const sizeOf = (t: string) => NODE_SIZE[t] || { w: 150, h: 90 };
function bboxOf(items: { x: number; y: number; w: number; h: number }[]) {
    const minX = Math.min(...items.map((i) => i.x));
    const minY = Math.min(...items.map((i) => i.y));
    const maxX = Math.max(...items.map((i) => i.x + i.w));
    const maxY = Math.max(...items.map((i) => i.y + i.h));
    return { minX, minY, maxX, maxY };
}

type Box = { x: number; y: number; w: number; h: number };
const HANDLE_RING = ['t', 'tr', 'r', 'br', 'b', 'bl', 'l', 'tl'] as const;
function handlePoint(box: Box, handle: string, ellipse = false) {
    const key = handle.replace(/^[st]-/, '');
    const corner = ellipse ? 0.146 : 0;
    const positions: Record<string, [number, number]> = {
        t: [0.5, 0], tr: [1 - corner, corner], r: [1, 0.5], br: [1 - corner, 1 - corner],
        b: [0.5, 1], bl: [corner, 1 - corner], l: [0, 0.5], tl: [corner, corner],
    };
    const [x, y] = positions[key] || positions.r;
    return { x: box.x + box.w * x, y: box.y + box.h * y };
}
/** Which side (t/r/b/l) of `from` faces `to` — used to auto-route a flow to the nearest handles. */
function sideToward(from: Box, to: Box): 'l' | 'r' | 't' | 'b' {
    const dx = to.x + to.w / 2 - (from.x + from.w / 2);
    const dy = to.y + to.h / 2 - (from.y + from.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l';
    return dy >= 0 ? 'b' : 't';
}

/** Push overlapping boxes apart (axis-aligned separation) so nodes never sit on top of each
 * other. Returns new positions; iterative and gentle so the overall arrangement is preserved. */
function separateOverlaps(items: { id: string; x: number; y: number; w: number; h: number }[], margin = 26, iterations = 80) {
    const pos = items.map((i) => ({ ...i }));
    for (let it = 0; it < iterations; it++) {
        let moved = false;
        for (let a = 0; a < pos.length; a++) {
            for (let b = a + 1; b < pos.length; b++) {
                const A = pos[a];
                const B = pos[b];
                const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + margin;
                const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) + margin;
                if (ox > 0 && oy > 0) {
                    moved = true;
                    if (ox < oy) {
                        const s = ox / 2;
                        if (A.x <= B.x) {
                            A.x -= s;
                            B.x += s;
                        } else {
                            A.x += s;
                            B.x -= s;
                        }
                    } else {
                        const s = oy / 2;
                        if (A.y <= B.y) {
                            A.y -= s;
                            B.y += s;
                        } else {
                            A.y += s;
                            B.y -= s;
                        }
                    }
                }
            }
        }
        if (!moved) break;
    }
    return pos.map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) }));
}

function Canvas({ connMode, setConnMode, overview, setOverview }: { connMode: boolean; setConnMode: (v: boolean) => void; overview: boolean; setOverview: (v: boolean) => void }) {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const dfdPath = useStore((s) => s.dfdPath);
    const setDfdPath = useStore((s) => s.setDfdPath);
    const selectedNodeId = useStore((s) => s.selectedNodeId);
    const selectNode = useStore((s) => s.selectNode);
    const selectedEdgeId = useStore((s) => s.selectedEdgeId);
    const selectEdge = useStore((s) => s.selectEdge);
    const save = useStore((s) => s.save);

    const dfd = data.dfd;
    const currentParent = dfdPath.length ? dfdPath[dfdPath.length - 1] : null;
    const layer = dfdPath.length + 1;
    const threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];

    const visible = useMemo(() => dfd.nodes.filter((n) => (n.parent ?? null) === currentParent), [dfd.nodes, currentParent]);
    const realNodes = useMemo(() => visible.filter((n) => n.type !== 'trust-boundary'), [visible]);
    const tbNodes = useMemo(() => visible.filter((n) => n.type === 'trust-boundary'), [visible]);
    const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);

    const [rfNodes, setRfNodes, onNodesChange] = useNodesState<any>([]);
    const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<any>([]);
    const dragging = useRef(false);
    const canvasRef = useRef<HTMLDivElement>(null);
    const didAutoTidy = useRef(false);
    const layoutRef = useRef<{ boxes: Record<string, Box>; portEndpointIds: Set<string>; ifacePortIds: Set<string> }>({ boxes: {}, portEndpointIds: new Set(), ifacePortIds: new Set() });

    const compById = useMemo(() => new Map((data.system.components || []).map((c) => [c.id, c])), [data.system.components]);
    const compName = (ref?: string) => (ref ? compById.get(ref)?.name || '' : '');
    const targetForComponent = (compId?: string) => resolveTargetNodeId(compId, realNodes, compById);
    const visibleIfaceIds = useMemo(() => {
        return deriveVisibleInterfaceIds({
            currentParent,
            interfaces: data.system.interfaces || [],
            flows: dfd.flows || [],
            nodes: dfd.nodes || [],
            visibleRealNodes: realNodes,
            compById,
        });
    }, [currentParent, dfd.flows, dfd.nodes, data.system.interfaces, realNodes, compById]);
    const riskFor = (node: DfdNode) => {
        if (schemeWarning) return null;
        if (!node.componentRef) return null;
        const rel = threats.filter((t) => (t.components || []).includes(node.componentRef!));
        if (!rel.length) return null;
        let worst = { score: 0, color: '#888' };
        for (const t of rel) {
            const r = riskOf(t, cms, scheme);
            if (r.residual >= worst.score) worst = { score: r.residual, color: r.residualBand.color };
        }
        return { count: rel.length, color: worst.color, title: `${rel.length} threat(s) · worst residual ${worst.score}` };
    };

    const targetOf = useMemo(() => (data.system.interfaces || []).map((itf) => targetForComponent(itf.component)), [data.system.interfaces, realNodes, compById]);

    const placedReal = () => realNodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0, ...sizeOf(n.type) }));

    const buildNodes = () => {
        const out: any[] = [];
        const real = placedReal();
        const contentBox = real.length ? bboxOf(real) : { minX: 0, minY: 0, maxX: 320, maxY: 200 };
        const ifaces = data.system.interfaces || [];
        const boxes: Record<string, Box> = {};
        real.forEach((p) => (boxes[p.id] = { x: p.x, y: p.y, w: p.w, h: p.h }));
        const portChips: { rfid: string; name: string; dir: string; detail: string; box: Box }[] = [];
        const portEndpointIds = new Set<string>();
        const ifacePortIds = new Set<string>();

        // Interfaces only appear on a layer if their (nearest ancestor) component resolves to a
        // node on THIS layer — this is what makes them refine as you drill in and stops orphan
        // chips floating over deeper layers.
        const CHIP_W = 176;
        const CHIP_H = 44;
        const GAP = 26;
        const CHIP_MEMBER_GAP = 74; // vertical breathing room between the chip row and the members
        const TB_PAD = 34; // side / bottom padding around members
        const TB_LABEL_H = 24; // reserved header strip for the boundary name
        const TB_GAP = 10; // gaps between label / chips / members
        const ifaceVisible = ifaces.map((itf) => visibleIfaceIds.has(itf.id));

        // Group the visible interfaces by the trust boundary that contains their target (or by the
        // bare target node when it is not inside a boundary on this layer).
        const memberTb = (tid: string | null) => (tid ? tbNodes.find((tb) => (tb.members || []).includes(tid) && real.some((p) => (tb.members || []).includes(p.id))) : undefined);
        const groupKey = (i: number) => {
            const tb = memberTb(targetOf[i]);
            return tb ? `tb:${tb.id}` : targetOf[i] ? `node:${targetOf[i]}` : 'none';
        };
        const groups: Record<string, number[]> = {};
        ifaces.forEach((_, i) => {
            if (!ifaceVisible[i]) return;
            (groups[groupKey(i)] = groups[groupKey(i)] || []).push(i);
        });

        // Size each trust-boundary box to enclose its members AND host a header (name) plus a row
        // of interface chips at the top, so nothing overlaps and the boundary name stays readable.
        let tbBoxes: Record<string, Box> = {};
        tbNodes.forEach((tb) => {
            const members = real.filter((p) => (tb.members || []).includes(p.id));
            if (!members.length) return;
            const b = bboxOf(members);
            const chips = groups[`tb:${tb.id}`] || [];
            const chipRowW = chips.length ? chips.length * CHIP_W + (chips.length - 1) * GAP : 0;
            const innerW = Math.max(b.maxX - b.minX, chipRowW);
            const w = innerW + TB_PAD * 2;
            const topOffset = TB_LABEL_H + TB_GAP + (chips.length ? CHIP_H + CHIP_MEMBER_GAP : 0);
            const cx = (b.minX + b.maxX) / 2;
            tbBoxes[tb.id] = { x: Math.round(cx - w / 2), y: Math.round(b.minY - topOffset), w: Math.round(w), h: Math.round(b.maxY - b.minY + topOffset + TB_PAD) };
        });

        // Place the interface chips: a centred row inside the boundary's header area, or (for a
        // target not in a boundary) just above the target node.
        const chipPos: { x: number; y: number }[] = [];
        ifaces.forEach((_itf, i) => {
            if (!ifaceVisible[i]) {
                chipPos[i] = { x: 0, y: 0 };
                return;
            }
            const members = groups[groupKey(i)];
            const idx = members.indexOf(i);
            const n = members.length;
            const tb = memberTb(targetOf[i]);
            const rowW = n * CHIP_W + (n - 1) * GAP;
            let startX: number;
            let chipY: number;
            if (tb && tbBoxes[tb.id]) {
                const box = tbBoxes[tb.id];
                startX = box.x + box.w / 2 - rowW / 2;
                chipY = box.y + TB_LABEL_H + TB_GAP;
            } else {
                const nb = real.find((p) => p.id === targetOf[i]);
                const cx = nb ? nb.x + nb.w / 2 : contentBox.minX + 120;
                startX = cx - rowW / 2;
                chipY = (nb ? nb.y : contentBox.minY) - CHIP_H - CHIP_MEMBER_GAP;
            }
            const rawPos = { x: Math.round(startX + idx * (CHIP_W + GAP)), y: Math.round(chipY) };
            const posKey = `${currentParent ?? 'root'}:${ifaces[i].id}`;
            chipPos[i] = dfd.ifacePos?.[posKey] ?? rawPos;
            boxes[`iface:${ifaces[i].id}`] = { x: chipPos[i].x, y: chipPos[i].y, w: CHIP_W, h: CHIP_H };
        });

        const fittedTbBoxes: Record<string, Box> = {};
        tbNodes.forEach((tb) => {
            const members = real.filter((p) => (tb.members || []).includes(p.id));
            if (!members.length) return;
            const chips = (groups[`tb:${tb.id}`] || []).map((i) => ({ x: chipPos[i].x, y: chipPos[i].y, w: CHIP_W, h: CHIP_H }));
            const memberBox = bboxOf(members);
            const minX = Math.min(memberBox.minX, ...(chips.length ? chips.map((c) => c.x) : [memberBox.minX]));
            const maxX = Math.max(memberBox.maxX, ...(chips.length ? chips.map((c) => c.x + c.w) : [memberBox.maxX]));
            const topContentY = chips.length ? Math.min(...chips.map((c) => c.y)) : memberBox.minY;
            const bottomContentY = Math.max(memberBox.maxY, ...(chips.length ? chips.map((c) => c.y + c.h) : [memberBox.maxY]));
            const y = Math.round(Math.min(memberBox.minY - TB_LABEL_H, topContentY - (TB_LABEL_H + TB_GAP)));
            fittedTbBoxes[tb.id] = {
                x: Math.round(minX - TB_PAD),
                y,
                w: Math.round(maxX - minX + TB_PAD * 2),
                h: Math.round(bottomContentY - y + TB_PAD),
            };
        });
        tbBoxes = fittedTbBoxes;

        // Ports: on a non-root layer, show the modelled component's external touch-points — its own
        // interfaces plus the endpoints it exchanges data with on its PARENT layer — as connectable
        // chips, WITHOUT modelling those sibling components here. This keeps the external interfaces
        // visible in every layer and gives the modelled component ingress/egress points.
        if (currentParent) {
            const P = dfd.nodes.find((n) => n.id === currentParent);
            const Pcomp = P?.componentRef;
            const parentOfP = P?.parent ?? null;
            const sibIds = new Set(dfd.nodes.filter((n) => (n.parent ?? null) === parentOfP && n.id !== currentParent && n.type !== 'trust-boundary').map((n) => n.id));
            const ifaceIdSet = new Set(ifaces.map((it) => it.id));
            const parentIfaceIds = new Set(ifaces.filter((it) => it.component === Pcomp).map((it) => it.id));
            const visibleIfaceHere = visibleIfaceIds;
            const nodeById = new Map(dfd.nodes.map((n) => [n.id, n]));
            const visibleRealNodeIds = new Set(real.map((node) => node.id));
            const internalHas = (id: string) => visibleRealNodeIds.has(id);
            const interfaceChipVisible = (id: string) => visibleIfaceHere.has(id) && !!targetForComponent(ifaces.find((itf) => itf.id === id)?.component);
            const directVisible = (id: string) => internalHas(id) || interfaceChipVisible(id);
            const portMap = new Map<string, { in: boolean; out: boolean; labels: string[] }>();
            const addPort = (ep: string, dir: 'in' | 'out', label?: string) => {
                if (directVisible(ep)) return;
                const e = portMap.get(ep) || { in: false, out: false, labels: [] };
                e[dir] = true;
                if (label) e.labels.push(label);
                portMap.set(ep, e);
            };
            for (const f of dfd.flows) {
                const inLayerContext = flowBelongsToLayerContext({
                    flow: f,
                    currentParent,
                    visibleRealNodeIds,
                    visibleIfaceIds: visibleIfaceHere,
                    nodes: dfd.nodes || [],
                    compById,
                    interfaces: ifaces,
                });
                if (!inLayerContext) continue;
                const fromDirect = directVisible(f.from);
                const toDirect = directVisible(f.to);
                if (fromDirect !== toDirect) {
                    addPort(fromDirect ? f.to : f.from, fromDirect ? 'out' : 'in', f.label);
                }
                const other = f.from === currentParent ? f.to : f.to === currentParent ? f.from : null;
                if (other && (sibIds.has(other) || ifaceIdSet.has(other))) addPort(other, f.from === currentParent ? 'out' : 'in', f.label);
                const fromParentIface = parentIfaceIds.has(f.from);
                const toParentIface = parentIfaceIds.has(f.to);
                if (fromParentIface || toParentIface) {
                    const ifaceId = fromParentIface ? f.from : f.to;
                    addPort(ifaceId, fromParentIface ? 'out' : 'in', f.label);
                }
                // Flows the user has already drawn from an internal node to an external endpoint.
                if (internalHas(f.from) && (sibIds.has(f.to) || ifaceIdSet.has(f.to))) addPort(f.to, 'out', f.label);
                if (internalHas(f.to) && (sibIds.has(f.from) || ifaceIdSet.has(f.from))) addPort(f.from, 'in', f.label);
            }

            const portList = [...portMap.entries()];
            const PW = 150;
            const PH = 42;
            const PGAP = 14;
            const rowW = portList.length * PW + (portList.length - 1) * PGAP;
            const cx0 = (contentBox.minX + contentBox.maxX) / 2;
            const startX = cx0 - rowW / 2;
            const portY = contentBox.minY - PH - 64;
            portList.forEach(([ep, info], i) => {
                const isIface = ifaceIdSet.has(ep);
                const rfid = isIface ? `iface:${ep}` : ep;
                const name = isIface ? ifaces.find((x) => x.id === ep)?.name || ep : nodeById.get(ep)?.label || ep;
                const dir = info.in && info.out ? '⇄' : info.out ? '→' : '←';
                const box = { x: Math.round(startX + i * (PW + PGAP)), y: Math.round(portY), w: PW, h: PH };
                const posKey = `${currentParent ?? 'root'}:${ep}`;
                const placed = dfd.portPos?.[posKey];
                if (placed) {
                    box.x = placed.x;
                    box.y = placed.y;
                }
                boxes[rfid] = box;
                portEndpointIds.add(ep);
                if (isIface) ifacePortIds.add(ep);
                portChips.push({ rfid, name, dir, detail: [...new Set(info.labels)].join(', '), box });
            });
        }
        layoutRef.current = { boxes, portEndpointIds, ifacePortIds };

        const chipBoxes: Box[] = [];
        ifaces.forEach((_itf, i) => {
            if (ifaceVisible[i]) chipBoxes.push({ x: chipPos[i].x, y: chipPos[i].y, w: CHIP_W, h: CHIP_H });
        });
        const tbBoxList = Object.values(tbBoxes);
        const portBoxes = portChips.map((p) => p.box);
        const allForBounds = [...real, ...chipBoxes, ...tbBoxList, ...portBoxes];
        const overall = bboxOf(allForBounds.length ? allForBounds : [{ x: contentBox.minX, y: contentBox.minY, w: 320, h: 200 }]);

        // In connections mode we hide the decorative boundaries / context frames so only the
        // entities and their connections remain — making the edges far easier to grab and edit.
        if (!connMode) {
            // Ancestor trust boundaries you have zoomed inside -> faint nested context frames.
            // Order them by depth (how early their member appears on the drill path) so the
            // OUTERMOST boundary gets the LARGEST frame and inner ones nest inside it correctly.
            const ancestors = dfd.nodes
                .filter((n) => n.type === 'trust-boundary' && (n.members || []).some((m) => dfdPath.includes(m)))
                .map((tb) => ({
                    tb,
                    depth: Math.min(...(tb.members || []).filter((m) => dfdPath.includes(m)).map((m) => dfdPath.indexOf(m))),
                }))
                .sort((a, b) => a.depth - b.depth);
            const nAnc = ancestors.length;
            ancestors.forEach(({ tb }, i) => {
                const pad = 46 + (nAnc - 1 - i) * 30; // outermost (i=0) -> largest pad
                out.push({
                    id: `ctx:${tb.id}`,
                    type: 'context',
                    position: { x: overall.minX - pad, y: overall.minY - pad - 26 },
                    data: { label: tb.label },
                    draggable: false,
                    selectable: false,
                    connectable: false,
                    deletable: false,
                    width: overall.maxX - overall.minX + pad * 2,
                    height: overall.maxY - overall.minY + pad * 2 + 26,
                });
            });

            // Current-layer trust boundaries, sized to enclose their members + header + chips.
            tbNodes.forEach((tb) => {
                if (tbBoxes[tb.id]) {
                    const box = tbBoxes[tb.id];
                    out.push({
                        id: tb.id,
                        type: 'boundary',
                        position: { x: box.x, y: box.y },
                        selected: tb.id === selectedNodeId,
                        data: { label: tb.label, warn: false },
                        draggable: false,
                        selectable: true,
                        connectable: false,
                        width: box.w,
                        height: box.h,
                    });
                } else {
                    out.push({
                        id: tb.id,
                        type: 'boundary',
                        position: { x: contentBox.minX, y: contentBox.maxY + 48 },
                        selected: tb.id === selectedNodeId,
                        data: { label: `${tb.label} — no members on this layer`, warn: true },
                        draggable: false,
                        selectable: true,
                        connectable: false,
                        width: 260,
                        height: 80,
                    });
                }
            });
        }

        // External interface chips: selectable + connectable so external entities can wire into
        // them and they can be edited from the inspector. Only rendered when visible on this layer.
        ifaces.forEach((itf, i) => {
            if (!ifaceVisible[i]) return;
            out.push({
                id: `iface:${itf.id}`,
                type: 'iface',
                position: chipPos[i],
                width: CHIP_W,
                height: CHIP_H,
                selected: selectedNodeId === `iface:${itf.id}`,
                data: {
                    label: itf.name,
                    protocol: itf.protocol,
                    tag: itf.tag,
                    exposure: itf.exposure,
                    category: itf.category,
                    connMode,
                    rotation: dfd.ifaceRot?.[`${currentParent ?? 'root'}:${itf.id}`] || 0,
                    title: `${itf.name} · ${itf.protocol || ''} · ${itf.exposure}`,
                },
                draggable: !connMode,
                selectable: true,
                connectable: true,
                deletable: false,
            });
        });

        // Ingress / egress port chips (the modelled component's external touch-points).
        portChips.forEach((p) => {
            out.push({
                id: p.rfid,
                type: 'port',
                position: { x: p.box.x, y: p.box.y },
                width: p.box.w,
                height: p.box.h,
                selected: selectedNodeId === p.rfid,
                data: { name: p.name, dir: p.dir, detail: p.detail, connMode, title: `${p.name}${p.detail ? ' · ' + p.detail : ''}` },
                draggable: !connMode,
                selectable: true,
                connectable: true,
                deletable: false,
            });
        });

        // Real DeMarco nodes.
        real.forEach((p) => {
            const n = realNodes.find((x) => x.id === p.id)!;
            const sz = sizeOf(n.type);
            const hasChildren = dfd.nodes.some((x) => (x.parent ?? null) === n.id);
            out.push({
                id: n.id,
                type: 'dfd',
                position: { x: n.x ?? 0, y: n.y ?? 0 },
                width: sz.w,
                height: sz.h,
                selected: n.id === selectedNodeId,
                draggable: !connMode,
                connectable: true,
                data: { label: n.componentRef ? compName(n.componentRef) || n.label : n.label, dtype: n.type, sub: compName(n.componentRef), risk: riskFor(n), hasChildren, connMode },
            });
        });
        return out;
    };

    const buildEdges = () => {
        const out: any[] = [];
        const { boxes, portEndpointIds, ifacePortIds } = layoutRef.current;
        const ifaces = data.system.interfaces || [];
        const visIface = visibleIfaceIds;
        const endpointVisible = (ep: string) => visibleIds.has(ep) || visIface.has(ep) || portEndpointIds.has(ep);
        const rfId = (ep: string) => (visIface.has(ep) || ifacePortIds.has(ep) ? `iface:${ep}` : ep);
        // Obstacle boxes for edge routing = every entity box on this layer (nodes, interface chips,
        // ports) — NOT trust boundaries. Each edge routes around all of them except its own ends.
        const boxList = Object.entries(boxes).map(([bid, b]) => ({ id: bid, x: b.x, y: b.y, w: b.w, h: b.h }));
        const obstaclesFor = (aId: string, bId: string) => boxList.filter((o) => o.id !== aId && o.id !== bId).map(({ x, y, w, h }) => ({ x, y, w, h }));
        const flows = dfd.flows.filter((f) => endpointVisible(f.from) && endpointVisible(f.to));
        // All flows curve to the right of their direction (positive offset = right-of-direction
        // normal). Bidirectional pairs each receive the same positive offset value; the reversed
        // direction vector on the return flow causes it to bow the other way, creating an eye shape.
        // Same-direction multiple flows spread outward around the base curve.
        const CURVE = 28; // wider, but still eye-shaped, bidirectional pairs
        const LANE_STEP = 32; // extra step per same-direction flow within a pair
        const offsetOf = (f: (typeof flows)[number]) => {
            const sameDir = flows.filter((x) => x.from === f.from && x.to === f.to);
            sameDir.sort((a, b) => (a.id < b.id ? -1 : 1));
            const i = sameDir.findIndex((x) => x.id === f.id);
            const n = sameDir.length;
            return CURVE + (i - (n - 1) / 2) * LANE_STEP;
        };
        const handleUse = new Map<string, number>();
        const shapeById = new Map(realNodes.map((node) => [node.id, node.type === 'process' || node.type === 'multiprocess']));
        const reserveHandle = (nodeId: string, role: 's' | 't', handle: string) => {
            const key = handle.replace(/^[st]-/, '');
            const usageKey = `${nodeId}:${role}:${key}`;
            handleUse.set(usageKey, (handleUse.get(usageKey) || 0) + 1);
            return `${role}-${key}`;
        };
        const allocateHandle = (nodeId: string, role: 's' | 't', from: Box, toward: Box) => {
            const closest = sideToward(from, toward);
            const closestIndex = HANDLE_RING.indexOf(closest);
            const allowed = [closest, HANDLE_RING[(closestIndex + 7) % 8], HANDLE_RING[(closestIndex + 1) % 8]];
            const candidates = [...allowed];
            candidates.sort((a, b) => {
                const useDiff = (handleUse.get(`${nodeId}:${role}:${a}`) || 0) - (handleUse.get(`${nodeId}:${role}:${b}`) || 0);
                if (useDiff) return useDiff;
                const targetX = toward.x + toward.w / 2;
                const targetY = toward.y + toward.h / 2;
                const pointA = handlePoint(from, a, shapeById.get(nodeId));
                const pointB = handlePoint(from, b, shapeById.get(nodeId));
                const cardinalTolerance = (key: string) => key.length === 1 ? 18 : 0;
                return Math.hypot(pointA.x - targetX, pointA.y - targetY) - cardinalTolerance(a) - (Math.hypot(pointB.x - targetX, pointB.y - targetY) - cardinalTolerance(b));
            });
            const selected = candidates.find((key) => (handleUse.get(`${nodeId}:${role}:${key}`) || 0) === 0) || candidates[0];
            const usageKey = `${nodeId}:${role}:${selected}`;
            handleUse.set(usageKey, (handleUse.get(usageKey) || 0) + 1);
            return `${role}-${selected}`;
        };
        const pairKey = (from: string, to: string) => from < to ? `${from}\u0001${to}` : `${to}\u0001${from}`;
        const pairHandles = new Map<string, { from: string; to: string; sourceKey: string; targetKey: string }>();
        const assigned = [...flows].sort((a, b) => pairKey(a.from, a.to).localeCompare(pairKey(b.from, b.to)) || a.id.localeCompare(b.id)).map((flow) => {
            const sourceId = rfId(flow.from);
            const targetId = rfId(flow.to);
            const sourceBox = boxes[sourceId];
            const targetBox = boxes[targetId];
            const key = pairKey(sourceId, targetId);
            const paired = pairHandles.get(key);
            let sourceHandle: string;
            let targetHandle: string;
            let bidirectional = false;
            const reversePaired = paired && paired.from === targetId && paired.to === sourceId;
            if (flow.sourceHandle) sourceHandle = reserveHandle(sourceId, 's', flow.sourceHandle);
            else if (reversePaired) sourceHandle = reserveHandle(sourceId, 's', paired.targetKey);
            else sourceHandle = sourceBox && targetBox ? allocateHandle(sourceId, 's', sourceBox, targetBox) : 's-r';
            if (flow.targetHandle) targetHandle = reserveHandle(targetId, 't', flow.targetHandle);
            else if (reversePaired) targetHandle = reserveHandle(targetId, 't', paired.sourceKey);
            else targetHandle = sourceBox && targetBox ? allocateHandle(targetId, 't', targetBox, sourceBox) : 't-l';
            if (reversePaired) {
                bidirectional = true;
            }
            if (!paired) pairHandles.set(key, { from: sourceId, to: targetId, sourceKey: sourceHandle.slice(2), targetKey: targetHandle.slice(2) });
            if (!bidirectional) bidirectional = flows.some((candidate) => candidate.from === flow.to && candidate.to === flow.from);
            return { flow, sourceId, targetId, sourceBox, targetBox, sourceHandle, targetHandle, bidirectional };
        });
        const placedLabels: Box[] = [];
        const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const labelSize = (text: string) => {
            const lines = [''];
            for (const word of text.trim().split(/\s+/).filter(Boolean)) {
                const current = lines[lines.length - 1];
                if (current && `${current} ${word}`.length <= 34) lines[lines.length - 1] = `${current} ${word}`;
                else if (word.length <= 34) lines.push(word);
                else {
                    for (let index = 0; index < word.length; index += 34) lines.push(word.slice(index, index + 34));
                }
            }
            const contentLines = lines.filter(Boolean);
            const maxLength = Math.max(1, ...contentLines.map((line) => line.length));
            return { w: Math.min(220, Math.max(54, maxLength * 6.1 + 16)), h: Math.max(1, contentLines.length) * 14 + 4 };
        };
        const labelPositionFor = (entry: (typeof assigned)[number], offset: number, obstacles: any[]) => {
            if (!entry.sourceBox || !entry.targetBox) return undefined;
            const source = handlePoint(entry.sourceBox, entry.sourceHandle, shapeById.get(entry.sourceId));
            const target = handlePoint(entry.targetBox, entry.targetHandle, shapeById.get(entry.targetId));
            const geometry = edgeGeometry(source.x, source.y, target.x, target.y, obstacles, offset);
            const size = labelSize(entry.flow.label || '');
            const preferredFraction = entry.bidirectional ? 0.36 : 0.5;
            let best: { x: number; y: number; score: number; box: Box; anchor: { x: number; y: number } } | undefined;
            for (const fraction of entry.bidirectional ? [0.36, 0.28, 0.44, 0.55, 0.2] : [0.5, 0.35, 0.65, 0.2, 0.8]) {
                const point = geometry.pointAt(fraction);
                for (const normalOffset of [0, 16, -16, 32, -32, 48, -48]) {
                    const x = point.x + point.nx * normalOffset;
                    const y = point.y + point.ny * normalOffset;
                    const box = { x: x - size.w / 2, y: y - size.h / 2, ...size };
                    const overlap = [...boxList, ...placedLabels].reduce((sum, obstacle) => sum + overlapArea(box, obstacle), 0);
                    const score = overlap * 1000 + Math.abs(fraction - preferredFraction) * 140 + Math.abs(normalOffset);
                    if (!best || score < best.score) best = { x, y, score, box, anchor: { x: point.x, y: point.y } };
                }
            }
            if (best) placedLabels.push(best.box);
            return best ? { position: { x: best.x, y: best.y }, anchor: best.anchor } : undefined;
        };
        assigned.forEach((entry) => {
            const { flow: f, sourceId: sId, targetId: tId, sourceHandle: sh, targetHandle: th } = entry;
            const obstacles = obstaclesFor(sId, tId);
            const offset = offsetOf(f);
            const labelPlacement = labelPositionFor(entry, offset, obstacles);
            out.push({
                id: f.id,
                source: sId,
                target: tId,
                sourceHandle: sh,
                targetHandle: th,
                type: 'offset',
                reconnectable: true,
                data: {
                    offset,
                    label: f.label,
                    labelPosition: labelPlacement?.position,
                    labelAnchor: labelPlacement?.anchor,
                    obstacles,
                    onSelect: () => selectEdge(f.id),
                },
                markerEnd: { type: MarkerType.ArrowClosed },
                className: cx(isEdgeSelected(f.id) && 'edge-sel'),
            });
        });

        return out;
    };

    // Re-derive the canvas from the store whenever the persisted model changes
    // (own saves, external file edits, selection) — but never mid-drag.
    const signature = JSON.stringify({
        v: realNodes.map((n) => [n.id, n.type, n.label, n.x, n.y, n.componentRef]),
        tb: tbNodes.map((n) => [n.id, n.label, n.members]),
        f: dfd.flows.map((f) => [f.id, f.from, f.to, f.label, f.crossesBoundary, f.sourceHandle, f.targetHandle]),
        itf: (data.system.interfaces || []).map((i) => [i.id, i.name, i.component, i.protocol, i.exposure]),
        cp: (data.system.components || []).map((c) => [c.id, c.parent]),
        anc: dfdPath,
        th: threats.map((t) => [t.id, t.components, t.likelihood, t.impact]),
        cm: cms.map((c) => [c.id, (c.addresses || []).map((a) => [a.threat, a.residualLikelihood, a.residualImpact])]),
        selN: selectedNodeId,
        selE: selectedEdgeId,
        conn: connMode,
        sc: !!scheme,
        ip: dfd.ifacePos || null,
        pp: dfd.portPos || null,
        ir: dfd.ifaceRot || null,
        il: dfd.ifaceLink || null,
    });
    useEffect(() => {
        if (dragging.current) return;
        const missing = realNodes.filter((n) => n.x == null || n.y == null);
        if (missing.length) {
            const pos = autoLayout(realNodes);
            const nodes2 = dfd.nodes.map((n) => (missing.find((m) => m.id === n.id) ? { ...n, x: pos[n.id].x, y: pos[n.id].y } : n));
            save('dfd', { ...dfd, nodes: nodes2 });
            return;
        }
        // Once per layer, nudge any overlapping nodes apart so the diagram is readable.
        if (!didAutoTidy.current) {
            didAutoTidy.current = true;
            const placed = placedReal();
            if (placed.length > 1) {
                const sep = separateOverlaps(placed);
                if (sep.some((s, i) => s.x !== placed[i].x || s.y !== placed[i].y)) {
                    const byId = new Map(sep.map((s) => [s.id, s]));
                    save('dfd', { ...dfd, nodes: dfd.nodes.map((n) => (byId.has(n.id) ? { ...n, x: byId.get(n.id)!.x, y: byId.get(n.id)!.y } : n)) });
                    return;
                }
            }
        }
        setRfNodes(buildNodes());
        setRfEdges(buildEdges());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);

    const persist = (next: Partial<Dfd>) => save('dfd', { ...dfd, ...next });

    const onNodeDragStart = useCallback(() => {
        dragging.current = true;
    }, []);
    const onNodeDragStop = useCallback(
        (_e: any, node: any) => {
            dragging.current = false;
            if (node.id.startsWith('iface:')) {
                // Persist the interface chip's new position keyed by layer so each layer remembers
                // independently where the user placed it.
                const ifaceId = node.id.slice(6);
                const posKey = `${currentParent ?? 'root'}:${ifaceId}`;
                persist({ ifacePos: { ...(dfd.ifacePos || {}), [posKey]: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } });
            } else if (layoutRef.current.portEndpointIds.has(node.id)) {
                const posKey = `${currentParent ?? 'root'}:${node.id}`;
                persist({ portPos: { ...(dfd.portPos || {}), [posKey]: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } });
            } else {
                persist({ nodes: dfd.nodes.map((n) => (n.id === node.id ? { ...n, x: Math.round(node.position.x), y: Math.round(node.position.y) } : n)) });
            }
        },
        [dfd, currentParent],
    );
    const onConnect = useCallback(
        (c: any) => {
            if (!c.source || !c.target) return;
            const strip = (x: string) => (x.startsWith('iface:') ? x.slice(6) : x);
            const from = strip(c.source);
            const to = strip(c.target);
            if (from === to) return;
            if (isParentChildNodeFlow({ from, to }, dfd.nodes)) {
                window.alert('A container and its own nested component can never be connected directly — model the connection between siblings inside the child layer instead.');
                return;
            }
            const label = window.prompt('Label this data flow — what data or command does it carry? (required)', '');
            if (!label || !label.trim()) return;
            const id = uid('F', dfd.flows.map((f) => f.id));
            persist({ flows: [...dfd.flows, { id, from, to, label: label.trim(), sourceHandle: c.sourceHandle || undefined, targetHandle: c.targetHandle || undefined }] });
        },
        [dfd],
    );
    const onReconnect = useCallback(
        (oldEdge: any, conn: any) => {
            if (!conn.source || !conn.target) return;
            const strip = (x: string) => (x.startsWith('iface:') ? x.slice(6) : x);
            const from = strip(conn.source);
            const to = strip(conn.target);
            if (isParentChildNodeFlow({ from, to }, dfd.nodes)) {
                window.alert('A container and its own nested component can never be connected directly — model the connection between siblings inside the child layer instead.');
                return;
            }
            persist({
                flows: dfd.flows.map((f) => (f.id === oldEdge.id ? { ...f, from, to, sourceHandle: conn.sourceHandle || undefined, targetHandle: conn.targetHandle || undefined } : f)),
            });
        },
        [dfd],
    );
    const onNodesDelete = useCallback(
        (deleted: any[]) => {
            const ids = new Set(deleted.map((d) => d.id));
            if (!confirmDelete(deleted.length > 1 ? `${deleted.length} nodes and their flows` : `node ${deleted[0]?.id}`)) {
                setRfNodes(buildNodes());
                setRfEdges(buildEdges());
                return;
            }
            persist({ nodes: dfd.nodes.filter((n) => !ids.has(n.id)), flows: dfd.flows.filter((f) => !ids.has(f.from) && !ids.has(f.to)) });
            if (selectedNodeId && ids.has(selectedNodeId)) selectNode(null);
        },
        [dfd, selectedNodeId],
    );
    const onEdgesDelete = useCallback(
        (deleted: any[]) => {
            const ids = new Set(deleted.map((d) => d.id));
            persist({ flows: dfd.flows.filter((f) => !ids.has(f.id)) });
        },
        [dfd],
    );

    const drillInto = (id: string) => {
        const node = dfd.nodes.find((n) => n.id === id);
        if (!node || node.type === 'trust-boundary') return;
        // Enter the component's internal layer; if empty, the user models the internals there.
        setDfdPath([...dfdPath, id]);
    };

    const addNode = (type: DfdNodeType) => {
        if (type === 'trust-boundary') {
            const id = uid('TB-', [...(data.system.trustBoundaries || []).map((b) => b.id), ...dfd.nodes.filter((n) => n.type === 'trust-boundary').map((n) => n.id)]);
            const x = 120 + (visible.length % 4) * 230;
            const y = 110 + Math.floor(visible.length / 4) * 170;
            const node: DfdNode = {
                id,
                label: 'New trust boundary',
                type,
                layer,
                parent: currentParent,
                x,
                y,
                members: [],
            };
            save('dfd', { ...dfd, nodes: [...dfd.nodes, node] });
            selectNode(id);
            return;
        }
        if (type === 'external-entity') {
            const id = uid('N-', dfd.nodes.map((n) => n.id));
            const node: DfdNode = {
                id,
                label: 'New external entity',
                type,
                layer,
                parent: currentParent,
                x: 120 + (visible.length % 4) * 230,
                y: 110 + Math.floor(visible.length / 4) * 170,
            };
            save('dfd', { ...dfd, nodes: [...dfd.nodes, node] });
            selectNode(id);
            return;
        }
        const compId = uid('C-', data.system.components.map((c) => c.id));
        const parentComp = currentParent ? dfd.nodes.find((n) => n.id === currentParent)?.componentRef : null;
        const comp = {
            id: compId,
            name: `New ${TYPE_LABEL[type].toLowerCase()}`,
            kind: COMPONENT_KIND[type],
            parent: parentComp,
            layer,
        };
        save('system', { ...data.system, components: [...data.system.components, comp] });
        const nodeNum = compId.match(/(\d+)$/)?.[1];
        selectNode(nodeNum ? `N-${nodeNum}` : null);
    };

    const tidy = () => {
        const placed = placedReal();
        if (placed.length < 2) return;
        const sep = separateOverlaps(placed);
        const byId = new Map(sep.map((s) => [s.id, s]));
        save('dfd', { ...dfd, nodes: dfd.nodes.map((n) => (byId.has(n.id) ? { ...n, x: byId.get(n.id)!.x, y: byId.get(n.id)!.y } : n)) });
    };

    // Keyboard navigation via a document-level listener, so it works even on an empty layer where
    // the canvas has nothing to focus — Up always jumps to the parent layer.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const sibs = visible.filter((n) => n.type !== 'trust-boundary');
            if (e.key === 'ArrowUp') {
                if (dfdPath.length) {
                    setDfdPath(dfdPath.slice(0, -1));
                    e.preventDefault();
                }
            } else if (e.key === 'ArrowDown') {
                const t = selectedNodeId || sibs[0]?.id;
                if (t) {
                    drillInto(t);
                    e.preventDefault();
                }
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                if (!sibs.length) return;
                const idx = sibs.findIndex((n) => n.id === selectedNodeId);
                const nx = e.key === 'ArrowRight' ? (idx + 1) % sibs.length : (idx - 1 + sibs.length) % sibs.length;
                selectNode(sibs[nx < 0 ? 0 : nx].id);
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, dfdPath, selectedNodeId]);

    const nodeName = (id: string | null) => (id ? dfd.nodes.find((n) => n.id === id)?.label || id : '');

    const selectedIfaceIds = new Set(
        (data.system.interfaces || [])
            .filter((itf) => !itf.hidden)
            .filter((itf) => selectedNodeId && !selectedNodeId.startsWith('iface:') && targetForComponent(itf.component) === selectedNodeId)
            .map((itf) => itf.id),
    );
    const isEdgeSelected = (edgeId: string) => {
        if (selectedEdgeId === edgeId) return true;
        if (!selectedNodeId) return false;
        const f = dfd.flows.find((x) => x.id === edgeId);
        if (f) return f.from === selectedNodeId || f.to === selectedNodeId;
        if (edgeId.startsWith('if:')) {
            const ifaceId = edgeId.slice(3);
            return selectedNodeId === `iface:${ifaceId}` || selectedIfaceIds.has(ifaceId);
        }
        return false;
    };

    // Open a node picked in the overview: leave overview mode, drill to its layer and select it.
    const openFromOverview = (nodeId: string, path: string[]) => {
        setOverview(false);
        setDfdPath(path);
        selectNode(nodeId);
    };

    return (
        <div className="dfd-wrap">
            {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning} DFD risk indicators are hidden until the scheme is available.</div>}
            <div className="dfd-bar">
                <div className="crumbs">
                    <button onClick={() => setDfdPath([])} className={dfdPath.length ? '' : 'here'}>
                        {data.project.device?.name || 'Device'} <span className="muted">L1</span>
                    </button>
                    {dfdPath.map((id, i) => (
                        <span key={id} style={{ display: 'inline-flex', alignItems: 'center' }}>
                            <span className="sep">/</span>
                            <button onClick={() => setDfdPath(dfdPath.slice(0, i + 1))} className={i === dfdPath.length - 1 ? 'here' : ''}>
                                {nodeName(id)} <span className="muted">L{i + 2}</span>
                            </button>
                        </span>
                    ))}
                </div>
                {!overview && (
                    <div className="dfd-nav">
                        {dfdPath.length > 0 && (
                            <button className="btn sm" onClick={() => setDfdPath(dfdPath.slice(0, -1))} title="Go to the parent layer">
                                ▲ Up
                            </button>
                        )}
                        <select
                            className="inp navsel"
                            value={selectedNodeId || ''}
                            title="Select a node to inspect"
                            onChange={(e) => selectNode(e.target.value || null)}
                        >
                            <option value="">Select node…</option>
                            {visible.map((n) => (
                                <option key={n.id} value={n.id}>
                                    {n.label}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <div className="right palette">
                    <button
                        className={cx('btn sm', overview && 'primary')}
                        onClick={() => setOverview(!overview)}
                        title="Overview: show every layer and entity as a single tree (a navigation aid; not used in the report)"
                    >
                        {overview ? '✓ Overview' : '☰ Overview'}
                    </button>
                    {!overview && (
                        <>
                            <button
                                className={cx('btn sm', connMode && 'primary')}
                                onClick={() => setConnMode(!connMode)}
                                title="Connections mode: locks the nodes and shows only entities + connections, so links are easy to grab, move and reconnect"
                            >
                                {connMode ? '✓ Connections' : '🔗 Connections'}
                            </button>
                            {!connMode && (
                                <button className="btn sm" onClick={tidy} title="Space overlapping nodes apart for readability">
                                    ⤢ Tidy
                                </button>
                            )}
                            {!connMode &&
                                PALETTE.map((t) => (
                                    <button key={t} className="btn sm" onClick={() => addNode(t)} title={`Add ${TYPE_LABEL[t]}`}>
                                        + {TYPE_LABEL[t]}
                                    </button>
                                ))}
                        </>
                    )}
                </div>
            </div>

            {overview ? (
                <DfdOverview onOpen={openFromOverview} />
            ) : (
                <div className={cx('dfd-canvas', connMode && 'connmode')} tabIndex={0} ref={canvasRef}>
                    <ReactFlow
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        nodes={rfNodes}
                        edges={rfEdges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onNodeDragStart={onNodeDragStart}
                        onNodeDragStop={onNodeDragStop}
                        onConnect={onConnect}
                        onReconnect={onReconnect}
                        onNodesDelete={onNodesDelete}
                        onEdgesDelete={onEdgesDelete}
                        onNodeClick={(_e, n) => {
                            if (n.type === 'dfd' || n.type === 'boundary' || n.type === 'iface' || n.type === 'port') selectNode(n.id);
                        }}
                        onNodeDoubleClick={(_e, n) => {
                            if (n.type === 'dfd') drillInto(n.id);
                        }}
                        onEdgeClick={(_e, ed) => {
                            selectEdge(ed.id);
                        }}
                        onPaneClick={() => {
                            selectNode(null);
                            selectEdge(null);
                        }}
                        reconnectRadius={26}
                        nodesDraggable={!connMode}
                        elevateEdgesOnSelect
                        deleteKeyCode={['Delete']}
                        disableKeyboardA11y
                        zoomOnDoubleClick={false}
                        fitView
                        fitViewOptions={{ padding: 0.25 }}
                        proOptions={{ hideAttribution: true }}
                    >
                        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#dfe3ea" />
                        <MiniMap
                            pannable
                            zoomable
                            nodeColor={(n) =>
                                n.type === 'boundary' ? '#0f9d8f55' : n.type === 'context' ? '#0f9d8f22' : n.type === 'iface' ? '#8a93a2' : '#c7ccff'
                            }
                        />
                        <Controls showInteractive={false} />
                    </ReactFlow>
                </div>
            )}

            <div className="dfd-bar" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
                <span className="keyhint">
                    {overview ? (
                        <>
                            <b>Overview</b> — every layer and entity in one tree. Click any node to open it in the diagram. This is a
                            navigation aid only and is not included in the report.
                        </>
                    ) : connMode ? (
                        <>
                            <b>Connections mode</b> — nodes are locked; drag between any handle to connect, and drag an edge end
                            onto another handle to move it. Toggle off to move nodes again.
                        </>
                    ) : (
                        <>
                            Click a node to inspect it; <b>double-click</b> to open its (internal) sub-diagram. Drag from any
                            connector to link nodes (either side works); drag an edge end onto another connector to move it.
                            Use <b>Connections</b> mode for easy link editing and <b>Tidy</b> to space nodes out. <kbd>←</kbd>{' '}
                            <kbd>→</kbd> siblings, <kbd>↑</kbd> parent layer, <kbd>↓</kbd> drill in.
                        </>
                    )}
                </span>
            </div>
        </div>
    );
}

export default function DfdView() {
    const dfdPath = useStore((s) => s.dfdPath);
    const currentParent = dfdPath.length ? dfdPath[dfdPath.length - 1] : 'root';
    const [connMode, setConnMode] = useState(false);
    const [overview, setOverview] = useState(false);
    // Re-mount per layer so the view auto-fits and resets cleanly.
    return <Canvas key={`layer-${currentParent}`} connMode={connMode} setConnMode={setConnMode} overview={overview} setOverview={setOverview} />;
}
