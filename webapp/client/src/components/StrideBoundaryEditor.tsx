// Modal editor for the per-trust-boundary STRIDE strengths/weaknesses analysis.
// One table per communicating pair. Analysis data is stored globally by pair key (not per
// boundary), so the same channel's properties appear consistently in every boundary that the
// flow crosses — editing here updates all views simultaneously.
import { useStore } from '../state/store';
import AppDialog from './AppDialog';
import { boundaryPairs, STRIDE_KEYS, STRIDE_LABEL } from '../lib/stride';
import type { StridePair } from '../lib/stride';
import type { StridePairAnalysis, StrideSideAnalysis, Stride } from '../types';

export default function StrideBoundaryEditor() {
    const data = useStore((s) => s.data);
    const tbId = useStore((s) => s.strideBoundaryId);
    const close = useStore((s) => s.openStrideBoundary);
    const title = tbId ? `STRIDE analysis per trust boundary · ${tbId}` : 'STRIDE analysis per trust boundary';
    return (
        <AppDialog open={!!data && !!tbId} onClose={() => close(null)} title={title} size="xl" dismissOnBackdrop={false}>
            {data && tbId && <StrideBoundaryContent data={data} tbId={tbId} />}
        </AppDialog>
    );
}

function StrideBoundaryContent({ data, tbId }: { data: NonNullable<ReturnType<typeof useStore.getState>['data']>; tbId: string }) {
    const save = useStore((s) => s.save);
    const system = data.system;
    const pairs = boundaryPairs(system, data.dfd, tbId);

    // Analysis is stored flat by pair key (not nested per boundary) so every boundary that
    // a flow crosses shares the same entry — the channel's security properties don't change.
    const writeAnalysis = (pairKey: string, next: StridePairAnalysis) =>
        save('system', { ...system, strideAnalyses: { ...(system.strideAnalyses || {}), [pairKey]: next } });

    const renderPairTable = (pair: StridePair) => {
        const analysis: StridePairAnalysis = system.strideAnalyses?.[pair.key] || {};
        const epId = (side: 'inside' | 'outside') => side === 'inside' ? pair.inside.id : pair.outside.id;

        const setLabel = (side: 'inside' | 'outside', v: string) => {
            const id = epId(side);
            const endpoints = { ...(analysis.endpoints || {}) };
            endpoints[id] = { ...(endpoints[id] || {}), label: v.trim() || undefined };
            writeAnalysis(pair.key, { ...analysis, endpoints });
        };
        const setCell = (side: 'inside' | 'outside', k: Stride, field: 'strengths' | 'weaknesses', text: string) => {
            const id = epId(side);
            const endpoints = { ...(analysis.endpoints || {}) };
            const ep: StrideSideAnalysis = { ...(endpoints[id] || {}) };
            const cells = { ...(ep.cells || {}) };
            const cell = { ...(cells[k] || {}) };
            const lines = text.split('\n');
            cell[field] = lines.length === 1 && lines[0] === '' ? [] : lines;
            cells[k] = cell;
            endpoints[id] = { ...ep, cells };
            writeAnalysis(pair.key, { ...analysis, endpoints });
        };
        const cellText = (side: 'inside' | 'outside', k: Stride, field: 'strengths' | 'weaknesses') =>
            (analysis.endpoints?.[epId(side)]?.cells?.[k]?.[field] || []).join('\n');
        const getLabel = (side: 'inside' | 'outside') => {
            const ep = side === 'inside' ? pair.inside : pair.outside;
            return analysis.endpoints?.[ep.id]?.label ?? ep.label;
        };
        const cell = (side: 'inside' | 'outside', k: Stride, field: 'strengths' | 'weaknesses') => (
            <td style={{ verticalAlign: 'top', padding: 4 }}>
                <textarea
                    className="inp"
                    style={{ width: '100%', minHeight: 54, resize: 'vertical', fontSize: 12 }}
                    value={cellText(side, k, field)}
                    placeholder="one per line"
                    aria-label={`${side} ${STRIDE_LABEL[k]} ${field}`}
                    onChange={(e) => setCell(side, k, field, e.target.value)}
                />
            </td>
        );
        const aLabel = getLabel('inside');
        const bLabel = getLabel('outside');
        return (
            <div className="card" key={pair.key} style={{ marginBottom: 14 }}>
                <div className="grid2" style={{ marginBottom: 8 }}>
                    <div className="field">
                        <label>Side A — {pair.inside.label} (inside this boundary)</label>
                        <input className="inp" value={aLabel} onChange={(e) => setLabel('inside', e.target.value)} />
                    </div>
                    <div className="field">
                        <label>Side B — {pair.outside.label} (across this boundary)</label>
                        <input className="inp" value={bLabel} onChange={(e) => setLabel('outside', e.target.value)} />
                    </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                        <tr>
                            <th rowSpan={2} style={{ padding: 6, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                                STRIDE
                            </th>
                            <th colSpan={2} style={{ padding: 6, borderBottom: '1px solid var(--border)', borderLeft: '2px solid var(--border)' }}>
                                {aLabel}
                            </th>
                            <th colSpan={2} style={{ padding: 6, borderBottom: '1px solid var(--border)', borderLeft: '2px solid var(--border)' }}>
                                {bLabel}
                            </th>
                        </tr>
                        <tr style={{ color: 'var(--text-dim)' }}>
                            <th style={{ padding: 4, borderLeft: '2px solid var(--border)' }}>Strengths</th>
                            <th style={{ padding: 4 }}>Weaknesses</th>
                            <th style={{ padding: 4, borderLeft: '2px solid var(--border)' }}>Strengths</th>
                            <th style={{ padding: 4 }}>Weaknesses</th>
                        </tr>
                    </thead>
                    <tbody>
                        {STRIDE_KEYS.map((k) => (
                            <tr key={k} style={{ borderTop: '1px solid var(--border)' }}>
                                <th style={{ padding: 6, textAlign: 'left', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                                    <span className="mono">{k}</span> · {STRIDE_LABEL[k]}
                                </th>
                                {cell('inside', k, 'strengths')}
                                {cell('inside', k, 'weaknesses')}
                                {cell('outside', k, 'strengths')}
                                {cell('outside', k, 'weaknesses')}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    return (
        <>
            <p className="hint" style={{ marginTop: 0 }}>
                One table per communicating pair. Analyses are <b>shared across all boundaries</b> — a communication channel's
                security properties are the same regardless of which boundary you view it from, so edits here also appear
                in any other boundary that this pair's flow crosses.
            </p>
            {pairs.length ? (
                pairs.map((pair) => (
                    <div key={pair.key}>
                        <h4 style={{ margin: '4px 0 6px' }}>
                            {pair.inside.label} <span className="muted">⇄</span> {pair.outside.label}
                        </h4>
                        {renderPairTable(pair)}
                    </div>
                ))
            ) : (
                <p className="hint">
                    No data flows cross this boundary yet. Add flows in the DFD that cross <span className="mono">{tbId}</span> to
                    analyse each communicating pair (e.g. HART ⇄ Plant DCS, Bluetooth ⇄ maintenance app).
                </p>
            )}
        </>
    );
}
