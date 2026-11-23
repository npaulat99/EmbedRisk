import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import { validate, openIssues, isAccepted } from '../../lib/validate';
import { issueTarget } from '../../lib/ids';
import { riskOf } from '../../lib/risk';
import { RiskPill, sortStride, TableRegion } from '../common';
import AppDialog from '../AppDialog';

export default function ReviewPanel() {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const report = useStore((s) => s.report);
    const save = useStore((s) => s.save);
    const activeId = useStore((s) => s.activeId);
    const goto = useStore((s) => s.goto);
    const allIssues = validate(data, scheme, schemeWarning);
    const accepted = data.project?.acceptedNotices || [];
    const open = openIssues(allIssues, accepted);
    const acceptedList = allIssues.filter((i) => isAccepted(i, accepted));
    const acceptNotice = (key: string) => save('project', { ...data.project, acceptedNotices: [...new Set([...accepted, key])] });
    const reopenNotice = (key: string) => save('project', { ...data.project, acceptedNotices: accepted.filter((k) => k !== key) });
    const includeStride = !!data.project?.reportOptions?.includeStrideBoundaryAnalysis;
    const setIncludeStride = (v: boolean) => save('project', { ...data.project, reportOptions: { ...(data.project?.reportOptions || {}), includeStrideBoundaryAnalysis: v } });
    const hasStrideAnalysis = Object.keys(data.system?.strideAnalyses || {}).length > 0;
    const sbomMode = data.project?.sbom?.mode || 'in-tool';
    const sbomFormat = data.project?.sbom?.format || 'cyclonedx';
    const sbomUrl = data.project?.sbom?.url;
    const threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];
    const protocolLimitations = threats.filter((t) => t.classification === 'protocol-limitation').length;
    const deploymentRisks = threats.filter((t) => t.classification === 'deployment-risk').length;
    const sharedResponsibility = threats.filter((t) => t.classification === 'shared-responsibility').length;
    const [html, setHtml] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!html) return;
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHtml(null);
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [html]);

    const onReport = async () => {
        setBusy(true);
        const res = await report();
        setBusy(false);
        if (res?.html) setHtml(res.html);
    };
    const download = () => {
        if (!html) return;
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${activeId || 'tra'}-report.html`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="panel">
            <h1>Review &amp; report</h1>
            <p className="lead">
                Resolve open issues, then generate the report.
            </p>

            <div className="toolbar">
                <button className="btn primary" onClick={onReport} disabled={busy}>
                    {busy ? 'Generating…' : 'Generate report'}
                </button>
                {activeId && (
                    <span className="right">
                        <a className="btn sm" href={`/api/projects/${activeId}/export/traceability.csv`} target="_blank" rel="noreferrer">
                            ↓ Traceability CSV
                        </a>
                        <a className="btn sm" href={`/api/projects/${activeId}/export/traceability.json`} target="_blank" rel="noreferrer">
                            ↓ Traceability JSON
                        </a>
                        {sbomMode === 'external' ? (
                            sbomUrl ? (
                                <a className="btn sm" href={sbomUrl} target="_blank" rel="noreferrer">
                                    ↗ SBOM (external)
                                </a>
                            ) : null
                        ) : sbomFormat === 'spdx' ? (
                            <a className="btn sm" href={`/api/projects/${activeId}/export/sbom.spdx.json`} target="_blank" rel="noreferrer">
                                ↓ SBOM (SPDX)
                            </a>
                        ) : (
                            <a className="btn sm" href={`/api/projects/${activeId}/export/sbom.cdx.json`} target="_blank" rel="noreferrer">
                                ↓ SBOM (CycloneDX)
                            </a>
                        )}
                    </span>
                )}
                <span className={'tag ' + (open.length ? 'warnmark' : '')}>{open.length ? `${open.length} open issue(s)` : 'No issues'}</span>
            </div>

            <div className="card" style={{ paddingTop: 12, paddingBottom: 12 }}>
                <label className="inline" style={{ gap: 8, alignItems: 'flex-start', margin: 0 }}>
                    <input type="checkbox" checked={includeStride} onChange={(e) => setIncludeStride(e.target.checked)} style={{ marginTop: 3 }} />
                    <span className="hint">
                        <b>Include STRIDE-per-trust-boundary analysis</b> in the report.
                        {!hasStrideAnalysis && ' No boundary analyses added yet.'}
                    </span>
                </label>
            </div>

            <AppDialog open={!!html} onClose={() => setHtml(null)} title="Report preview" size="xl" dismissOnBackdrop>
                {html && (
                    <>
                        <div className="inline" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
                            <button className="btn sm" onClick={download}>↓ Download HTML</button>
                        </div>
                        <iframe title="TRA report" srcDoc={html} style={{ width: '100%', height: '70vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
                    </>
                )}
            </AppDialog>

            {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning} Risk fields are shown as stored axes without classification.</div>}
            <div className="card">
                <h3>Plausibility check</h3>
                <ul className="issues">
                    {open.length === 0 ? (
                        <li className="ok">✓ No open issues.</li>
                    ) : (
                        open.map((it, i) => {
                            const tgt = issueTarget(data, it.message);
                            const icon = it.severity === 'error' ? '⛔' : it.severity === 'notice' ? 'ℹ' : '⚠';
                            return (
                                <li key={i} className={it.severity}>
                                    <span aria-hidden>{icon}</span>{' '}
                                    {tgt ? (
                                        <button className="issuelink" title={`Jump to ${tgt.id || tgt.view} to fix this`} onClick={() => goto(tgt.view, tgt.id)}>
                                            {it.message}
                                        </button>
                                    ) : (
                                        <span className="grow">{it.message}</span>
                                    )}
                                    {it.severity === 'notice' && (
                                        <button className="btn sm right" title="Accept this notice — it will no longer be an open point" onClick={() => acceptNotice(it.key)}>
                                            Accept
                                        </button>
                                    )}
                                </li>
                            );
                        })
                    )}
                </ul>
                {acceptedList.length > 0 && (
                    <>
                        <h4 style={{ margin: '14px 0 6px' }}>Accepted notices</h4>
                        <ul className="issues">
                            {acceptedList.map((it, i) => (
                                <li key={i} className="ok">
                                    <span aria-hidden>✓</span> <span className="grow">{it.message}</span>
                                    <button className="btn sm right" title="Reopen this notice" onClick={() => reopenNotice(it.key)}>
                                        Reopen
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>

            <div className="card">
                <h3>Threats &amp; risk</h3>
                <p className="hint" style={{ marginTop: 0 }}>
                    Classification summary: {protocolLimitations} protocol-limitation, {deploymentRisks} deployment-risk, {sharedResponsibility} shared-responsibility.
                </p>
                <TableRegion label="Threats and risk">
                    <table className="tbl">
                        <thead>
                            <tr style={{ textAlign: 'left', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                                <th scope="col" style={{ padding: 6 }}>ID</th>
                                <th scope="col" style={{ padding: 6 }}>Threat</th>
                                <th scope="col" style={{ padding: 6 }}>STRIDE</th>
                                <th scope="col" style={{ padding: 6 }}>Initial</th>
                                <th scope="col" style={{ padding: 6 }}>Residual</th>
                                <th scope="col" style={{ padding: 6 }}>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {threats.map((t) => {
                                const r = riskOf(t, cms, scheme);
                                return (
                                    <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                                        <th scope="row" style={{ padding: 6, fontFamily: 'ui-monospace, monospace' }}>{t.id}</th>
                                        <td style={{ padding: 6 }}>{t.title}</td>
                                        <td style={{ padding: 6 }} className="stride">
                                            {sortStride(t.stride).join('')}
                                        </td>
                                        <td style={{ padding: 6 }}>
                                            {schemeWarning ? `L${t.likelihood ?? '—'} / I${t.impact ?? '—'}` : <RiskPill score={r.initial} band={r.initialBand} />}
                                        </td>
                                        <td style={{ padding: 6 }}>
                                            {schemeWarning ? `L${r.residualLikelihood ?? '—'} / I${r.residualImpact ?? '—'}` : <RiskPill score={r.residual} band={r.residualBand} />}
                                        </td>
                                        <td style={{ padding: 6, textTransform: 'capitalize' }}>{t.status}</td>
                                    </tr>
                                );
                            })}
                            {!threats.length && (
                                <tr>
                                    <td colSpan={6} className="hint" style={{ padding: 10 }}>
                                        No threats defined yet.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </TableRegion>
            </div>
        </div>
    );
}
