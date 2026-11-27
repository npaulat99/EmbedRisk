// Consolidated IEC 62443-4-1 / CRA overview: assets, interfaces, third-party software,
// threats and countermeasure status with the traceability links required for an audit.
import type React from 'react';
import { useStore } from '../../state/store';
import { createRiskEngine, riskOf } from '../../lib/risk';
import { Jump, HelpButton, RiskPill, sortStride, TableRegion } from '../common';

function Stat({ label, value, warn, href, onClick }: { label: string; value: number | string; warn?: boolean; href?: string; onClick?: () => void }) {
    const content = <><span className={'statval' + (warn ? ' warn' : '')}>{value}</span><span className="statlabel">{label}</span></>;
    return href
        ? <a className="stat clickable" href={href} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onClick?.();
        }}>{content}</a>
        : <div className="stat">{content}</div>;
}

export default function DashboardPanel() {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const riskEngine = scheme ? createRiskEngine(scheme) : null;
    const setView = useStore((s) => s.setView);
    const sys = data.system;
    const project = data.project;
    const threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];
    const implementedCms = cms.filter((c) => c.selected !== false);
    const components = sys.components || [];
    const interfaces = sys.interfaces || [];
    const assets = sys.assets || [];
    const thirdParty = components.filter((c) => c.provenance && !/^own\b/i.test(c.provenance));
    const ticketsOf = (c: any) => (c.ticketUrls?.length ? c.ticketUrls : c.ticketUrl ? [c.ticketUrl] : []);
    const missingTicket = implementedCms.filter((c) => (c.status === 'implemented' || c.status === 'verified') && !ticketsOf(c).length);
    const openThreats = threats.filter((t) => t.status === 'open');
    const reqs = data.requirements?.requirements || [];
    const defects = data.defects?.defects || [];
    const openDefects = defects.filter((d) => d.status !== 'fixed' && d.status !== 'wont-fix');
    const highNoReq = threats.filter((t) => riskEngine && riskEngine.inRange('likelihood', t.likelihood) && riskEngine.inRange('impact', t.impact)
        && riskEngine.isHighOrAbove(riskEngine.classify(t.likelihood, t.impact)) && t.status !== 'accepted' && t.status !== 'avoided'
        && !reqs.some((r) => (r.derivedFromThreat || []).includes(t.id)));
    const protocolLimitations = threats.filter((t) => t.classification === 'protocol-limitation').length;
    const deploymentRisks = threats.filter((t) => t.classification === 'deployment-risk').length;
    const sharedResponsibility = threats.filter((t) => t.classification === 'shared-responsibility').length;
    const threatById = new Map(threats.map((t) => [t.id, t]));
    const cmById = new Map(cms.map((c) => [c.id, c]));

    return (
        <div className="panel">
            {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning} Ratings are shown as stored axes without scheme classification.</div>}
            <div className="panelhead">
                <h1>Compliance dashboard</h1>
                <HelpButton title="IEC 62443-4-1 / CRA overview">
                    <ul>
                        <li>One traceable view of assets, interfaces, third-party software, threats, and controls.</li>
                        <li><b>Implemented / verified</b> countermeasures should include a ticket link.</li>
                        <li>Click any ID to jump to its full record.</li>
                    </ul>
                </HelpButton>
            </div>
            <p className="lead">
                {project.device?.name || 'Device'} · SL-C {project.slTarget || '—'} · {project.scope?.mode || 'graybox'} · status {project.status || 'draft'}
            </p>

            <div className="dashgrid">
                <Stat label="Components" value={components.length} href="#/system" onClick={() => setView('system')} />
                <Stat label="3rd-party SW/HW" value={thirdParty.length} href="#/system" onClick={() => setView('system')} />
                <Stat label="Interfaces" value={interfaces.length} href="#/system" onClick={() => setView('system')} />
                <Stat label="Assets" value={assets.length} href="#/system" onClick={() => setView('system')} />
                <Stat label="Threats" value={threats.length} href="#/threats" onClick={() => setView('threats')} />
                <Stat label="Open threats" value={openThreats.length} warn={openThreats.length > 0} href="#/threats" onClick={() => setView('threats')} />
                <Stat label="Protocol limits" value={protocolLimitations} href="#/threats" onClick={() => setView('threats')} />
                <Stat label="Deployment risks" value={deploymentRisks} href="#/threats" onClick={() => setView('threats')} />
                <Stat label="Shared controls" value={sharedResponsibility} href="#/threats" onClick={() => setView('threats')} />
                <Stat label="Requirements" value={reqs.length} href="#/requirements" onClick={() => setView('requirements')} />
                <Stat label="High threats w/o req." value={highNoReq.length} warn={highNoReq.length > 0} href="#/threats" onClick={() => setView('threats')} />
                <Stat label="Countermeasures" value={implementedCms.length} href="#/countermeasures" onClick={() => setView('countermeasures')} />
                <Stat label="Missing ticket links" value={missingTicket.length} warn={missingTicket.length > 0} href="#/countermeasures" onClick={() => setView('countermeasures')} />
                <Stat label="Open defects" value={openDefects.length} warn={openDefects.length > 0} href="#/defects" onClick={() => setView('defects')} />
            </div>

            <div className="card">
                <h3>Components &amp; third-party software</h3>
                <TableRegion label="Components and third-party software">
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th scope="col">ID</th>
                                <th scope="col">Name</th>
                                <th scope="col">Kind</th>
                                <th scope="col">Version</th>
                                <th scope="col">Supplier</th>
                                <th scope="col">Provenance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {components.map((c) => (
                                <tr key={c.id}>
                                    <th scope="row" className="mono">{c.id}</th>
                                    <td>{c.name}</td>
                                    <td>{c.kind}</td>
                                    <td>{c.version || '—'}</td>
                                    <td>{c.supplier || '—'}</td>
                                    <td>{c.provenance && !/^own/i.test(c.provenance) ? <span className="tag" style={{ color: 'var(--warn)' }}>{c.provenance}</span> : c.provenance || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </TableRegion>
            </div>

            <div className="card">
                <h3>Interfaces</h3>
                <TableRegion label="Interfaces">
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th scope="col">ID</th>
                                <th scope="col">Name</th>
                                <th scope="col">Category</th>
                                <th scope="col">Exposure</th>
                                <th scope="col">Protocol</th>
                            </tr>
                        </thead>
                        <tbody>
                            {interfaces.map((c) => (
                                <tr key={c.id}>
                                    <th scope="row" className="mono">{c.id}</th>
                                    <td>{c.name}</td>
                                    <td>{c.category || '—'}</td>
                                    <td>{c.exposure}</td>
                                    <td>{c.protocol || '—'}</td>
                                </tr>
                            ))}
                            {!interfaces.length && (
                                <tr>
                                    <td colSpan={5} className="hint">No interfaces yet.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </TableRegion>
            </div>

            <div className="card">
                <h3>Assets</h3>
                <TableRegion label="Assets">
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th scope="col">ID</th>
                                <th scope="col">Name</th>
                                <th scope="col">Stored in</th>
                                <th scope="col">C/I/A/S</th>
                            </tr>
                        </thead>
                        <tbody>
                            {assets.map((a) => (
                                <tr key={a.id}>
                                    <th scope="row" className="mono">
                                        <Jump view="system" id={a.id} title={`${a.id} · ${a.name}`} />
                                    </th>
                                    <td>{a.name}</td>
                                    <td>{a.storage || '—'}</td>
                                    <td className="mono">
                                        {a.objectives?.confidentiality ?? 0}/{a.objectives?.integrity ?? 0}/{a.objectives?.availability ?? 0}/{a.objectives?.safety ?? 0}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </TableRegion>
            </div>

            <div className="card">
                <h3>Threats</h3>
                <TableRegion label="Threats">
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th scope="col">ID</th>
                                <th scope="col">Threat</th>
                                <th scope="col">STRIDE</th>
                                <th scope="col">Initial</th>
                                <th scope="col">Residual</th>
                                <th scope="col">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {threats.map((t) => {
                                const r = riskOf(t, cms, scheme);
                                return (
                                    <tr key={t.id}>
                                        <th scope="row" className="mono">
                                            <Jump view="threats" id={t.id} title={`${t.id} · ${t.title}`} />
                                        </th>
                                        <td>{t.title}</td>
                                        <td className="mono">{sortStride(t.stride).join('')}</td>
                                        <td>
                                            {schemeWarning
                                                ? `L${t.likelihood ?? '—'} / I${t.impact ?? '—'}`
                                                : <RiskPill score={r.initial} band={r.initialBand} />}
                                        </td>
                                        <td>
                                            {schemeWarning ? `L${r.residualLikelihood ?? '—'} / I${r.residualImpact ?? '—'}` : <RiskPill score={r.residual} band={r.residualBand} />}
                                        </td>
                                        <td style={{ textTransform: 'capitalize' }}>{t.status}</td>
                                    </tr>
                                );
                            })}
                            {!threats.length && (
                                <tr>
                                    <td colSpan={6} className="hint">No threats yet.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </TableRegion>
            </div>

            <div className="card">
                <h3>Countermeasures &amp; implementation evidence</h3>
                <TableRegion label="Countermeasures and implementation evidence">
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th scope="col">ID</th>
                                <th scope="col">Countermeasure</th>
                                <th scope="col">Addresses</th>
                                <th scope="col">Status</th>
                                <th scope="col">Ticket</th>
                                <th scope="col">Verification</th>
                            </tr>
                        </thead>
                        <tbody>
                            {implementedCms.map((c) => {
                                const tickets = ticketsOf(c);
                                const needsTicket = (c.status === 'implemented' || c.status === 'verified') && !tickets.length;
                                return (
                                    <tr key={c.id} style={needsTicket ? { background: 'rgba(239,108,0,0.08)' } : undefined}>
                                        <th scope="row" className="mono">
                                            <Jump view="countermeasures" id={c.id} title={`${c.id} · ${c.title}`} />
                                        </th>
                                        <td>{c.title}</td>
                                        <td className="mono">
                                            {(c.addresses || []).map((a) => (
                                                <Jump key={a.threat} view="threats" id={a.threat} title={threatById.get(a.threat) ? `${a.threat} · ${threatById.get(a.threat)!.title}` : undefined} />
                                            ))}
                                        </td>
                                        <td style={{ textTransform: 'capitalize' }}>{c.status}</td>
                                        <td>
                                            {tickets.length ? (
                                                tickets.map((ticket: string, idx: number) => (
                                                    <a key={ticket + idx} className="linkbtn" href={ticket} target="_blank" rel="noreferrer" style={{ marginRight: 6 }}>
                                                        ticket {idx + 1} ↗
                                                    </a>
                                                ))
                                            ) : needsTicket ? (
                                                <span style={{ color: 'var(--warn)' }}>required</span>
                                            ) : (
                                                '—'
                                            )}
                                        </td>
                                        <td>
                                            {c.verificationUrl ? (
                                                <a className="linkbtn" href={c.verificationUrl} target="_blank" rel="noreferrer">
                                                    evidence ↗
                                                </a>
                                            ) : (
                                                '—'
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {!implementedCms.length && (
                                <tr>
                                    <td colSpan={6} className="hint">No countermeasures yet.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </TableRegion>
            </div>

            <div className="card">
                <h3>Security requirements (threat &rarr; requirement &rarr; control)</h3>
                <TableRegion label="Security requirements traceability">
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th scope="col">ID</th>
                                <th scope="col">Requirement</th>
                                <th scope="col">Standard / SL·FR</th>
                                <th scope="col">From threats</th>
                                <th scope="col">Satisfied by</th>
                            </tr>
                        </thead>
                        <tbody>
                            {reqs.map((r) => (
                                <tr key={r.id}>
                                    <th scope="row" className="mono">{r.id}</th>
                                    <td>{r.text}</td>
                                    <td>
                                        {r.standardRef || '—'}
                                        {r.slFr ? ` · ${r.slFr}` : ''}
                                    </td>
                                    <td className="mono">
                                        {(r.derivedFromThreat || []).map((th) => (
                                            <Jump key={th} view="threats" id={th} title={threatById.get(th) ? `${th} · ${threatById.get(th)!.title}` : undefined} />
                                        ))}
                                    </td>
                                    <td className="mono">
                                        {(r.satisfiedByCM || []).map((cm) => (
                                            <Jump key={cm} view="countermeasures" id={cm} title={cmById.get(cm) ? `${cm} · ${cmById.get(cm)!.title}` : undefined} />
                                        ))}
                                    </td>
                                </tr>
                            ))}
                            {!reqs.length && (
                                <tr>
                                    <td colSpan={5} className="hint">No requirements yet.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </TableRegion>
            </div>
        </div>
    );
}
