// Custom React Flow node renderers using DeMarco notation:
//   process / multiprocess -> circle (double ring for multiprocess)
//   external-entity        -> solid rectangle
//   store                  -> open rectangle (top & bottom rule only)
//   trust-boundary         -> dashed container drawn behind the other nodes
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../state/store';
import { cx } from '../common';

// Every node exposes eight connector positions — the four sides (t/r/b/l) plus the four corners
// (tl/tr/br/bl), each with BOTH a target and a source handle (ids `t-<pos>` / `s-<pos>`). Handles
// are placed exactly on the VISIBLE outline: box edges/corners for rectangles, and the 45° arc
// points for the oval (multi-)process shapes. Inlined per node so React Flow measures their bounds.
const RECT_PTS: Record<string, [number, number]> = {
    t: [50, 0],
    r: [100, 50],
    b: [50, 100],
    l: [0, 50],
    tl: [0, 0],
    tr: [100, 0],
    br: [100, 100],
    bl: [0, 100],
};
// 45° points of an ellipse inscribed in the box: 50 ± 50·cos45 = 14.64 / 85.36.
const OVAL_PTS: Record<string, [number, number]> = {
    ...RECT_PTS,
    tl: [14.6, 14.6],
    tr: [85.4, 14.6],
    br: [85.4, 85.4],
    bl: [14.6, 85.4],
};
const SIDE_POS: Record<string, Position> = {
    t: Position.Top,
    tl: Position.Top,
    tr: Position.Top,
    b: Position.Bottom,
    bl: Position.Bottom,
    br: Position.Bottom,
    l: Position.Left,
    r: Position.Right,
};

function NodeHandles({ shape = 'rect' }: { shape?: 'rect' | 'ellipse' }) {
    const pts = shape === 'ellipse' ? OVAL_PTS : RECT_PTS;
    return (
        <>
            {Object.entries(pts).flatMap(([k, [x, y]]) => {
                const style = { left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' } as const;
                return [
                    <Handle key={`t-${k}`} id={`t-${k}`} type="target" position={SIDE_POS[k]} style={style} />,
                    <Handle key={`s-${k}`} id={`s-${k}`} type="source" position={SIDE_POS[k]} style={style} />,
                ];
            })}
        </>
    );
}

export function DfdNodeView({ id, data, selected }: any) {
    const selectNode = useStore((s) => s.selectNode);
    const drillInto = useStore((s) => s.drillInto);
    const shape = data.dtype === 'process' || data.dtype === 'multiprocess' ? 'ellipse' : 'rect';
    return (
        <div
            className={cx('node', data.dtype, selected && 'sel')}
            aria-label={`${data.dtype === 'external-entity' ? 'External entity' : data.dtype === 'multiprocess' ? 'Multi-process' : data.dtype === 'store' ? 'Data store' : 'Process'} ${id}: ${data.label}`}
            onClick={(e) => {
                e.stopPropagation();
                selectNode(id);
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                drillInto(id);
            }}
        >
            <NodeHandles shape={shape} />
            <div className="lbl">{data.label}</div>
            {!data.connMode && data.sub ? <div className="sub">{data.sub}</div> : null}
            {!data.connMode && data.risk ? (
                <span className="riskdot" style={{ background: data.risk.color }} title={data.risk.title}>
                    {data.risk.count}
                </span>
            ) : null}
            {!data.connMode && data.hasChildren ? <span className="layerdot" title="This component is modelled in a lower layer">↳</span> : null}
        </div>
    );
}

export function BoundaryNodeView({ id, data, selected }: any) {
    const selectNode = useStore((s) => s.selectNode);
    return (
        <div
            className={cx('boundary', selected && 'sel', data.warn && 'warn')}
            style={{ width: '100%', height: '100%' }}
            aria-label={`Trust boundary ${id}: ${data.label}`}
            onClick={(e) => {
                e.stopPropagation();
                selectNode(id);
            }}
        >
            <span className="blabel">{data.label}</span>
        </div>
    );
}

// Ancestor trust boundary drawn as a faint context frame when you have zoomed into a layer.
export function ContextNodeView({ id, data }: any) {
    return (
        <div className="contextframe" style={{ width: '100%', height: '100%' }} aria-label={`Ancestor trust boundary ${id.replace(/^ctx:/, '')}: ${data.label}`}>
            <span className="ctxlabel">{data.label}</span>
        </div>
    );
}

// External interface (HART / Bluetooth / JTAG …) shown pinned on every layer of the device.
export function InterfaceNodeView({ id, data, selected }: any) {
    const selectNode = useStore((s) => s.selectNode);
    return (
        <div
            className={cx('ifacechip', selected && 'sel')}
            aria-label={`Interface ${id.replace(/^iface:/, '')}: ${data.label}`}
            title={data.title}
            style={data.rotation ? { transform: `rotate(${data.rotation}deg)` } : undefined}
            onClick={(e) => {
                e.stopPropagation();
                selectNode(id);
            }}
        >
            <NodeHandles />
            <span className="ifaceproto">{data.tag || data.protocol || 'interface'}</span>
            <span className="ifacename">{data.label}</span>
            {data.exposure ? <span className={'ifaceexp exp-' + data.exposure}>{data.exposure}</span> : null}
        </div>
    );
}

// Ingress / egress port: the modelled component's touch-point to a sibling component or interface
// on the layer above, shown so the user can wire internal nodes to it without modelling the sibling.
export function PortNodeView({ id, data, selected }: any) {
    const selectNode = useStore((s) => s.selectNode);
    return (
        <div
            className={cx('portchip', selected && 'sel')}
            aria-label={`${data.dir === 'in' ? 'Ingress' : 'Egress'} port ${id}: ${data.name}`}
            title={data.title}
            onClick={(e) => {
                e.stopPropagation();
                selectNode(id);
            }}
        >
            <NodeHandles />
            <span className="portdir">{data.dir}</span>
            <span className="portbody">
                <span className="portname">{data.name}</span>
                {data.detail ? <span className="portdetail">{data.detail}</span> : null}
            </span>
        </div>
    );
}

export const nodeTypes = {
    dfd: DfdNodeView,
    boundary: BoundaryNodeView,
    context: ContextNodeView,
    iface: InterfaceNodeView,
    port: PortNodeView,
};
