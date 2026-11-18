// Full-model overview for the DFD: a single collapsible tree of every layer and entity.
// It is purely a navigation / "big picture" aid — it is never the default view and is not part
// of the generated report. Clicking a node opens it in the standard layered diagram.
import { useStore } from '../../state/store';
import { riskOf } from '../../lib/risk';
import type { DfdNode, DfdNodeType } from '../../types';

const TYPE_LABEL: Record<DfdNodeType, string> = {
    'external-entity': 'External entity',
    process: 'Process',
    multiprocess: 'Multi-process',
    store: 'Data store',
    'trust-boundary': 'Trust boundary',
};
const TYPE_ICON: Record<DfdNodeType, string> = {
    'external-entity': '▭',
    process: '○',
    multiprocess: '◎',
    store: '▤',
    'trust-boundary': '⬚',
};

export default function DfdOverview({ onOpen }: { onOpen: (nodeId: string, path: string[]) => void }) {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const dfd = data.dfd;
    const threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];
    const compById = new Map((data.system.components || []).map((c) => [c.id, c]));
    const interfaces = (data.system.interfaces || []).filter((it) => !it.hidden);
    const deviceName = data.project.device?.name || data.project.title || 'Device';

    const childrenOf = (pid: string | null) => dfd.nodes.filter((n) => (n.parent ?? null) === pid);

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
        return { count: rel.length, color: worst.color, score: worst.score };
    };

    const renderNode = (n: DfdNode, path: string[], layer: number) => {
        const kids = childrenOf(n.id);
        const comp = n.componentRef ? compById.get(n.componentRef) : undefined;
        const ifaces = comp ? interfaces.filter((it) => it.component === comp.id) : [];
        const risk = riskFor(n);
        return (
            <li key={n.id}>
                <div
                    className="ov-node"
                    role="button"
                    tabIndex={0}
                    title={`Open ${n.label} in the diagram`}
                    onClick={() => onOpen(n.id, path)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpen(n.id, path);
                        }
                    }}
                >
                    <span className="ov-ico">{TYPE_ICON[n.type]}</span>
                    <span>{n.label}</span>
                    <span className="ov-type">{TYPE_LABEL[n.type]}</span>
                    {comp && <span className="ov-comp">{comp.name}</span>}
                    {n.type === 'trust-boundary' && n.members?.length ? <span className="ov-badge">{n.members.length} members</span> : null}
                    {ifaces.map((it) => (
                        <span key={it.id} className="ov-badge">
                            {it.name}
                        </span>
                    ))}
                    {risk && <span className="ov-riskdot" style={{ background: risk.color }} title={`${risk.count} threat(s) · worst residual ${risk.score}`} />}
                    {kids.length > 0 && <span className="ov-layer">L{layer + 1} ▾</span>}
                </div>
                {kids.length > 0 && <ul>{kids.map((k) => renderNode(k, [...path, n.id], layer + 1))}</ul>}
            </li>
        );
    };

    const roots = childrenOf(null);
    return (
        <div className="dfd-overview">
            {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning} DFD risk indicators are hidden until the scheme is available.</div>}
            <div className="ov-head">Full-model overview — every layer and entity at a glance. Click a node to open it in the diagram.</div>
            <ul className="ov-tree">
                <li>
                    <div className="ov-root">
                        <span className="ov-ico">▣</span> {deviceName} <span className="ov-layer">Layer 1</span>
                    </div>
                    {roots.length ? (
                        <ul>{roots.map((n) => renderNode(n, [], 1))}</ul>
                    ) : (
                        <ul>
                            <li>
                                <span className="hint">No nodes yet.</span>
                            </li>
                        </ul>
                    )}
                </li>
            </ul>
        </div>
    );
}
