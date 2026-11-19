import { Fragment, useState } from 'react';
import { useStore } from '../state/store';
import { riskOf, bandForRisk, bandsOf, createRiskEngine, descendantComponentIds } from '../lib/risk';
import { DEFAULT_ACCEPTABLE_RISK } from '../types';

/**
 * 5×5 residual-risk heat map. Optionally filtered to a single component (when a DFD node
 * is selected) — including all of that component's sub-components, so a parent node rolls
 * up the risk of everything it contains. Clicking a cell that holds threats jumps to the
 * matching threat directly, or opens a chooser when several threats share the cell.
 */
export default function RiskMatrix({ componentRef }: { componentRef?: string }) {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const goto = useStore((s) => s.goto);
    const [previewIds, setPreviewIds] = useState<string[]>([]);
    if (!scheme || schemeWarning) {
        return <div className="settings-error-banner" role="alert">{schemeWarning || 'Risk scheme is not available; matrix classification is disabled.'}</div>;
    }
    const engine = createRiskEngine(scheme);
    let threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];
    let rolledUp = false;
    if (componentRef) {
        const ids = descendantComponentIds(data.system.components || [], componentRef);
        rolledUp = ids.size > 1;
        threats = threats.filter((t) => (t.components || []).some((c) => ids.has(c)));
    }
    threats = threats.filter((threat) => threat.status !== 'unfeasible');

    const cellThreats: Record<string, string[]> = {};
    for (const t of threats) {
        const r = riskOf(t, cms, scheme);
        const k = `${r.residualLikelihood}-${r.residualImpact}`;
        (cellThreats[k] = cellThreats[k] || []).push(t.id);
    }

    const impacts = engine.impactLevels().slice().reverse();
    const likes = engine.likelihoodLevels();
    const acceptableRisk = typeof data.project.acceptableRisk === 'number' ? data.project.acceptableRisk : DEFAULT_ACCEPTABLE_RISK;
    const acceptableLevel = data.project.acceptableLevel || (engine.scheme.classification.kind === 'lookup' ? engine.scheme.acceptance?.defaultLevel : undefined);
    const acceptableRank = acceptableLevel ? engine.scheme.classification.levels.find((level: any) => level.id === acceptableLevel)?.rank : undefined;
    const isAcceptable = (likelihood: number, impact: number) => {
        const level = engine.classify(likelihood, impact);
        if (level.treatment === 'auto-accept') return true;
        if (Number.isInteger(acceptableRank)) return level.rank <= acceptableRank;
        return likelihood * impact <= acceptableRisk;
    };
    const boundaryClass = (likelihood: number, impact: number) => {
        const acceptable = isAcceptable(likelihood, impact);
        const classes: string[] = [];
        if (impact < impacts.length && acceptable !== isAcceptable(likelihood, impact + 1)) classes.push('boundary-top');
        if (likelihood < likes.length && acceptable !== isAcceptable(likelihood + 1, impact)) classes.push('boundary-right');
        return classes.join(' ');
    };
    const openCell = (ids: string[]) => {
        if (ids.length === 1) goto('threats', ids[0]);
        else if (ids.length > 1) setPreviewIds(ids);
    };

    return (
        <div>
            <div className="matrix" style={{ gridTemplateColumns: `22px repeat(${likes.length}, minmax(0, 1fr))` }}>
                {impacts.map((I) => (
                    <Fragment key={`r-${I}`}>
                        <div className="cell axis" style={{ writingMode: 'vertical-rl' as any }}>
                            {I.code}
                        </div>
                        {likes.map((L) => {
                            const score = L.value * I.value;
                            const level = engine.classify(L.value, I.value);
                            const b = bandForRisk(L.value, I.value, scheme);
                            const ids = cellThreats[`${L.value}-${I.value}`] || [];
                            const n = ids.length;
                            const cellLabel = engine.scheme.classification.kind === 'product-bands' ? String(score) : level.label;
                            return (
                                <div
                                    className={'cell ' + boundaryClass(L.value, I.value) + (n ? ' hit' : '')}
                                    key={`${L.value}-${I.value}`}
                                    role={n ? 'button' : undefined}
                                    tabIndex={n ? 0 : undefined}
                                    aria-label={n ? `${L.label} by ${I.label}, ${level.label}, ${n} threat(s): ${ids.join(', ')}. Activate to open.` : `${L.label} by ${I.label}, ${level.label}`}
                                    style={{ background: b.color, opacity: n ? 1 : 0.42, cursor: n ? 'pointer' : 'default' }}
                                    title={n ? `${L.code} × ${I.code}: ${level.label} — ${ids.join(', ')} · click to open` : `${L.code} × ${I.code}: ${level.label}`}
                                    onClick={() => openCell(ids)}
                                    onKeyDown={(e) => {
                                        if (n && (e.key === 'Enter' || e.key === ' ')) {
                                            e.preventDefault();
                                            openCell(ids);
                                        }
                                    }}
                                >
                                    {cellLabel}
                                    <span className="bandmark" aria-hidden="true">{level.label[0]}</span>
                                    {n > 0 && <span className="n">{n}</span>}
                                </div>
                            );
                        })}
                    </Fragment>
                ))}
                <div className="matrix-boundaries" aria-hidden="true" style={{ gridTemplateColumns: `22px repeat(${likes.length}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${impacts.length + 1}, 30px)` }}>
                    {impacts.map((I, rowIndex) =>
                        likes.map((L) => {
                            const boundary = boundaryClass(L.value, I.value);
                            if (!boundary) return null;
                            return (
                                <span
                                    key={`${L.value}-${I.value}`}
                                    className={boundary}
                                    style={{ gridColumn: L.value + 1, gridRow: rowIndex + 1 }}
                                />
                            );
                        }),
                    )}
                </div>
                <div className="cell axis" />
                {likes.map((L) => (
                    <div className="cell axis" key={`l-${L.value}`}>
                        {L.code}
                    </div>
                ))}
            </div>
            <div className="axislabel">
                Likelihood → · Impact ↑ ·{' '}
                {componentRef
                    ? `${threats.length} threat(s) on this component${rolledUp ? ' + sub-components' : ''}`
                    : `residual risk of ${threats.length} threat(s)`}
            </div>
            <div className="inline" style={{ marginTop: 6 }}>
                {bandsOf(scheme).map((b) => (
                    <span key={b.name} className="inline" style={{ gap: 4 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: b.color, display: 'inline-block' }} />
                        <span className="hint">{b.name}</span>
                    </span>
                ))}
                <span className="inline" style={{ gap: 4 }}>
                    <span className="matrix-threshold-key" aria-hidden="true" />
                    <span className="hint">acceptable risk: {acceptableRisk}</span>
                </span>
            </div>
            {previewIds.length > 1 ? (
                <div className="modal-overlay" onClick={() => setPreviewIds([])}>
                    <div className="modal matrix-preview" role="dialog" aria-modal="true" aria-label="Threats at selected residual risk" onClick={(event) => event.stopPropagation()}>
                        <div className="modalhead">
                            <strong>Threats at this residual risk</strong>
                            <button className="btn sm" type="button" aria-label="Close threat preview" onClick={() => setPreviewIds([])}>✕</button>
                        </div>
                        {previewIds.map((id) => {
                            const threat = threats.find((item) => item.id === id);
                            return (
                                <button key={id} className="matrix-preview-item" type="button" onClick={() => goto('threats', id)}>
                                    <span className="summary-id">{id}</span>
                                    <span>{threat?.title || 'Unknown threat'}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
