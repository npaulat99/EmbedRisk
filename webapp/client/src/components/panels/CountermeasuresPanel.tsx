import { useState } from 'react';
import { useStore, uid } from '../../state/store';
import { Field, TagSelect, useFocus, useEditMode, EditBackBar, ScaleSelect, RiskPill, Jump, HelpButton, confirmDelete, IdInput } from '../common';
import { bandForRisk, createRiskEngine } from '../../lib/risk';
import { actorLevelLabel } from '@shared/attackerScale.js';
import RiskCalculator from './RiskCalculator';
import ThreatCmImportExport from '../ThreatCmImportExport';
import type { Countermeasure, Requirement } from '../../types';

export default function CountermeasuresPanel() {
    const data = useStore((s) => s.data)!;
    const kb = useStore((s) => s.kb);
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const engine = createRiskEngine(scheme);
    const likelihoodScale: [number, string][] = [[0, 'None — not possible'], ...engine.likelihoodLevels().map((level) => [level.value, `${level.code} · ${level.label}`] as [number, string])];
    const impactScale: [number, string][] = [[0, 'None — no impact'], ...engine.impactLevels().map((level) => [level.value, `${level.code} · ${level.label}`] as [number, string])];
    const save = useStore((s) => s.save);

    const cms = data.countermeasures.countermeasures || [];
    const threats = data.threats.threats || [];
    const reqs = data.requirements?.requirements || [];
    const attackers = data.assumptions.attacker || [];
    const ifaceOpts = (data.system.interfaces || []).map((itf) => ({ value: itf.id, label: `${itf.name}${itf.protocol ? ` (${itf.protocol})` : ''}` }));
    const attackerOpts = attackers.map((a) => ({ value: a.id, label: `${a.name} (${actorLevelLabel(a.capability)}, ${a.access})` }));
    const focusId = useFocus('countermeasures');
    const { editingId, setEditingId } = useEditMode(focusId);
    const threatOpts = threats.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }));
    const compOpts = (data.system.components || []).map((c) => ({ value: c.id, label: c.name }));
    const threatById = new Map(threats.map((t) => [t.id, t]));

    // A countermeasure is "selected" (chosen to be implemented) unless explicitly unchecked. Older
    // projects without the flag are treated as selected, so nothing disappears from the overview.
    const isSelected = (c: Countermeasure) => c.selected !== false;
    const byId = (a: Countermeasure, b: Countermeasure) => a.id.localeCompare(b.id, undefined, { numeric: true });
    const selectedCms = cms.filter(isSelected).sort(byId);
    const candidateCms = cms.filter((c) => !isSelected(c)).sort(byId);

    // "Compare & choose" (brainstorming) mode: pick a threat, see every candidate control side by side.
    const [mode, setMode] = useState<'selected' | 'compare'>('selected');
    const [compareThreatId, setCompareThreatId] = useState<string>('');
    const openCompare = () => {
        if (!compareThreatId && threats.length) setCompareThreatId(threats[0].id);
        setMode('compare');
    };

    const setCms = (list: Countermeasure[]) => save('countermeasures', { countermeasures: list });
    const updCm = (cmId: string, patch: Partial<Countermeasure>) => setCms(cms.map((x) => (x.id === cmId ? { ...x, ...patch } : x)));
    const updCmAddr = (cmId: string, tid: string, patch: any) => {
        const c = cms.find((x) => x.id === cmId);
        if (!c) return;
        updCm(cmId, { addresses: (c.addresses || []).map((a) => (a.threat === tid ? { ...a, ...patch } : a)) });
    };

    // Every countermeasure must be backed by a security requirement (the "is CM" requirement). Create
    // one automatically when a control is chosen for implementation, if it does not already have one.
    const writeReqs = (list: Requirement[]) => save('requirements', { requirements: list });
    const reqForCm = (cmId: string) => reqs.find((r) => (r.satisfiedByCM || []).includes(cmId));
    const ensureReqForCm = (c: Countermeasure) => {
        if (reqForCm(c.id)) return;
        const id = uid('R', reqs.map((r) => r.id));
        writeReqs([...reqs, { id, text: `The system shall implement: ${c.title}`, fromCountermeasure: true, derivedFromThreat: (c.addresses || []).map((a) => a.threat), satisfiedByCM: [c.id] }]);
    };
    const toggleSelected = (c: Countermeasure, on: boolean) => {
        updCm(c.id, { selected: on });
        if (on) ensureReqForCm({ ...c, selected: on });
    };

    const add = () => {
        const id = uid('CM', cms.map((c) => c.id));
        const cm: Countermeasure = { id, title: 'New countermeasure', type: 'preventive', addresses: [], components: [], status: 'proposed', selected: true };
        setCms([...cms, cm]);
        ensureReqForCm(cm);
        setEditingId(id);
    };
    const addCandidateForThreat = (tid: string) => {
        const id = uid('CM', cms.map((c) => c.id));
        const cm: Countermeasure = { id, title: 'New candidate control', type: 'preventive', addresses: [{ threat: tid, ...seedResidualFromThreat(threatById.get(tid)) }], components: [], status: 'proposed', selected: false };
        setCms([...cms, cm]);
    };
    const importKb = (key: string) => {
        const k = (kb?.countermeasures || []).find((x: any) => x.key === key);
        if (!k) return;
        const id = uid('CM', cms.map((c) => c.id));
        const cm: Countermeasure = { id, title: k.title, type: 'preventive', addresses: [], components: [], status: 'proposed', selected: true };
        setCms([...cms, cm]);
        ensureReqForCm(cm);
        setEditingId(id);
    };
    const removeCm = (id: string) => {
        setCms(cms.filter((x) => x.id !== id));
        // Keep the requirement chain consistent: drop the deleted control from any requirement it satisfied.
        if (reqs.some((r) => (r.satisfiedByCM || []).includes(id)))
            writeReqs(reqs.map((r) => ((r.satisfiedByCM || []).includes(id) ? { ...r, satisfiedByCM: (r.satisfiedByCM || []).filter((c) => c !== id) } : r)));
    };
    const editing = cms.find((c) => c.id === editingId) || null;
    const ticketList = (c: Countermeasure) => (c.ticketUrls?.length ? c.ticketUrls : c.ticketUrl ? [c.ticketUrl] : ['']);
    const seedResidualFromThreat = (t: any) => ({
        residualLikelihood: t?.likelihood ?? 2,
        residualImpact: t?.impact ?? 2,
        attackerRef: t?.attackerRef,
        interfaceRef: t?.interfaceRef,
        interfaceRefs: t?.interfaceRefs?.length ? [...t.interfaceRefs] : t?.interfaceRef ? [t.interfaceRef] : [],
        interfaceLabel: t?.interfaceLabel,
        likelihoodFactors: t?.likelihoodFactors ? { ...t.likelihoodFactors } : undefined,
        impactDimensions: t?.impactDimensions ? { ...t.impactDimensions } : undefined,
        cvss: t?.cvss ? { ...t.cvss } : undefined,
        ratedBy: t?.ratedBy,
        ratedAt: t?.ratedAt,
    });

    const renderEditor = (c: Countermeasure) => {
        const upd = (patch: any) => setCms(cms.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
        const setTickets = (tickets: string[]) => {
            const cleaned = tickets.map((t) => t.trim()).filter(Boolean);
            upd({ ticketUrl: cleaned[0] || '', ticketUrls: cleaned });
        };
        const addrThreatIds = (c.addresses || []).map((a) => a.threat);
        const toggleThreat = (next: string[]) => {
            const existing = new Map((c.addresses || []).map((a) => [a.threat, a]));
            const addresses = next.map((tid) => existing.get(tid) || { threat: tid, ...seedResidualFromThreat(threats.find((x) => x.id === tid)) });
            upd({ addresses });
        };
        const updAddr = (tid: string, patch: any) => upd({ addresses: (c.addresses || []).map((a) => (a.threat === tid ? { ...a, ...patch } : a)) });
        return (
            <div id={`f-countermeasures-${c.id}`} className="itemcard" key={c.id} style={!addrThreatIds.length ? { borderColor: '#f0c9a8' } : undefined}>
                <div className="head">
                    <IdInput id={c.id} onRename={setEditingId} />
                    <input className="inp grow" value={c.title} onChange={(e) => upd({ title: e.target.value })} />
                    <select className="inp" style={{ width: 140 }} value={c.type || 'preventive'} onChange={(e) => upd({ type: e.target.value })}>
                        {['preventive', 'detective', 'corrective', 'organizational'].map((o) => (
                            <option key={o}>{o}</option>
                        ))}
                    </select>
                    <select className="inp" style={{ width: 130 }} value={c.status || 'proposed'} onChange={(e) => upd({ status: e.target.value })}>
                        {['proposed', 'planned', 'implemented', 'verified'].map((o) => (
                            <option key={o}>{o}</option>
                        ))}
                    </select>
                    <label className="inline" style={{ gap: 5, whiteSpace: 'nowrap' }} title="Chosen to be implemented — only selected controls appear in the main overview">
                        <input type="checkbox" checked={isSelected(c)} onChange={(e) => toggleSelected(c, e.target.checked)} />
                        <span className="hint">Implement</span>
                    </label>
                    <button className="btn sm danger" aria-label={`Delete countermeasure ${c.id}`} onClick={() => confirmDelete(`countermeasure ${c.id}`) && (removeCm(c.id), setEditingId(null))}>
                        ✕
                    </button>
                </div>

                <Field label="Addresses threats" hint={!addrThreatIds.length ? 'A countermeasure must address at least one threat.' : undefined}>
                    <TagSelect options={threatOpts} value={addrThreatIds} onChange={toggleThreat} empty="Define threats in step 05 first." />
                </Field>

                {(c.addresses || []).length > 0 && (
                    <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)', marginBottom: 10 }}>
                        {(c.addresses || []).map((a) => {
                            const t = threats.find((x) => x.id === a.threat);
                            const residualIfaces = a.interfaceRefs?.length ? a.interfaceRefs : t?.interfaceRefs?.length ? t.interfaceRefs : t?.interfaceRef ? [t.interfaceRef] : [];
                            const residualModel = {
                                likelihood: t?.likelihood ?? 2,
                                impact: t?.impact ?? 2,
                                residualLikelihood: a.residualLikelihood ?? t?.likelihood ?? 2,
                                residualImpact: a.residualImpact ?? t?.impact ?? 2,
                                attackerRef: a.attackerRef ?? t?.attackerRef,
                                interfaceRef: a.interfaceRef ?? residualIfaces[0],
                                interfaceRefs: residualIfaces,
                                interfaceLabel: a.interfaceLabel ?? t?.interfaceLabel,
                                likelihoodFactors: a.likelihoodFactors ?? t?.likelihoodFactors,
                                impactDimensions: a.impactDimensions ?? t?.impactDimensions,
                                cvss: a.cvss ?? t?.cvss,
                                ratedBy: a.ratedBy ?? '',
                                ratedAt: a.ratedAt,
                            };
                            return (
                                <div key={a.threat} className="itemcard residual-card" style={{ marginBottom: 8 }}>
                                    <div className="inline" style={{ marginBottom: 8, alignItems: 'center' }}>
                                        <Jump view="threats" id={a.threat} title={t ? `${t.id} · ${t.title}` : undefined} />
                                        <span className="grow muted" style={{ flex: 1, minWidth: 180 }}>
                                            {t?.title || 'unknown threat'}
                                        </span>
                                        <span className="hint">Initial {t?.likelihood ?? '—'} × {t?.impact ?? '—'}</span>
                                        <button className="btn sm" type="button" onClick={() => updAddr(a.threat, seedResidualFromThreat(t))}>
                                            Reset from threat
                                        </button>
                                    </div>
                                    <div className="grid2">
                                        <Field label="Residual attacker profile">
                                            <select className="inp" value={residualModel.attackerRef || ''} onChange={(e) => updAddr(a.threat, { attackerRef: e.target.value || undefined })}>
                                                <option value="">— none —</option>
                                                {attackerOpts.map((opt) => (
                                                    <option key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </Field>
                                        <Field label="Residual interfaces / vectors">
                                            <TagSelect options={ifaceOpts} value={residualIfaces} onChange={(v) => updAddr(a.threat, { interfaceRefs: v, interfaceRef: v[0] || undefined })} empty="No interfaces defined in step 03 yet." />
                                            <input className="inp" style={{ marginTop: 6 }} value={a.interfaceLabel ?? t?.interfaceLabel ?? ''} placeholder="Optional custom vector" onChange={(e) => updAddr(a.threat, { interfaceLabel: e.target.value || undefined })} />
                                        </Field>
                                    </div>
                                    <div className="grid2">
                                        <Field label="Residual likelihood">
                                            <ScaleSelect value={a.residualLikelihood ?? t?.likelihood ?? 2} onChange={(n) => updAddr(a.threat, { residualLikelihood: Math.min(n, t?.likelihood ?? n) })} levels={likelihoodScale} disabled={!!schemeWarning} style={{ width: '100%' }} />
                                        </Field>
                                        <Field label="Residual impact">
                                            <ScaleSelect value={a.residualImpact ?? t?.impact ?? 2} onChange={(n) => updAddr(a.threat, { residualImpact: Math.min(n, t?.impact ?? n) })} levels={impactScale} disabled={!!schemeWarning} style={{ width: '100%' }} />
                                        </Field>
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                        <h4 style={{ margin: '0 0 8px 0' }}>Guided residual assessment</h4>
                                        <RiskCalculator
                                            t={residualModel as any}
                                            upd={(patch) => updAddr(a.threat, patch)}
                                            likelihoodField="residualLikelihood"
                                            impactField="residualImpact"
                                        />
                                    </div>
                                    {(t?.likelihoodRationale || t?.impactRationale || t?.interfaceLabel || t?.interfaceRefs?.length || t?.interfaceRef) && (
                                        <div className="hint" style={{ marginTop: 6 }}>
                                            {(t.interfaceRefs?.length || t.interfaceRef) ? `Interfaces: ${[...(t.interfaceRefs?.length ? t.interfaceRefs : t.interfaceRef ? [t.interfaceRef] : [])].join(', ')}. ` : ''}
                                            {t.interfaceLabel ? `Vector: ${t.interfaceLabel}. ` : ''}
                                            {t.likelihoodRationale ? `Likelihood rationale: ${t.likelihoodRationale}. ` : ''}
                                            {t.impactRationale ? `Impact rationale: ${t.impactRationale}.` : ''}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="grid3">
                    <Field label="Affected components">
                        <TagSelect options={compOpts} value={c.components || []} onChange={(v) => upd({ components: v })} empty="Define components in step 03 first." />
                    </Field>
                    <Field label="IEC 62443 reference (optional)">
                        <input value={c.iec62443Ref || ''} onChange={(e) => upd({ iec62443Ref: e.target.value })} placeholder="CR 1.2 / FR1" />
                    </Field>
                    <Field label="Responsibility">
                        <select value={c.responsibility || ''} onChange={(e) => upd({ responsibility: e.target.value || undefined })}>
                            <option value="">— none —</option>
                            <option value="product">product</option>
                            <option value="deployment">deployment</option>
                            <option value="shared">shared</option>
                        </select>
                    </Field>
                </div>
                <Field label="Description">
                    <textarea value={c.description || ''} onChange={(e) => upd({ description: e.target.value })} />
                </Field>
                <Field label="Negative effects / trade-offs" hint="One per line.">
                    <textarea
                        value={(c.negativeEffects || []).join('\n')}
                        placeholder={'e.g. additional implementation effort\nhigher computation time'}
                        onChange={(e) => {
                            const lines = e.target.value.split('\n');
                            upd({ negativeEffects: lines.length === 1 && lines[0] === '' ? [] : lines });
                        }}
                    />
                </Field>
                <Field label="Associated security requirement" hint="Required for traceability.">
                    {(() => {
                        const linkedReqs = reqs.filter((r) => (r.satisfiedByCM || []).includes(c.id));
                        return linkedReqs.length ? (
                            <div className="summary-links">
                                {linkedReqs.map((r) => (
                                    <Jump key={r.id} view="requirements" id={r.id} label={`${r.id} · ${r.text}`} />
                                ))}
                            </div>
                        ) : (
                            <div className="inline">
                                <span className="hint">No linked requirement.</span>
                                <button className="btn sm" type="button" onClick={() => ensureReqForCm(c)}>
                                    + Create linked requirement
                                </button>
                            </div>
                        );
                    })()}
                </Field>
                {(c.status === 'implemented' || c.status === 'verified') && (
                    <div className="grid2">
                        <Field
                            label="Implementation tickets (at least one required)"
                            hint={!ticketList(c).some((t) => t.trim()) ? 'Add at least one ticket link.' : undefined}
                        >
                            <div className="list" style={{ gap: 6 }}>
                                {ticketList(c).map((ticket, idx) => (
                                    <div className="inline" key={idx} style={{ gap: 6 }}>
                                        <input
                                            className="inp grow"
                                            value={ticket}
                                            onChange={(e) => {
                                                const next = [...ticketList(c)];
                                                next[idx] = e.target.value;
                                                setTickets(next);
                                            }}
                                            placeholder="https://dev.azure.com/org/proj/_workitems/edit/123"
                                            style={!ticket.trim() && !ticketList(c).some((t) => t.trim()) ? { borderColor: 'var(--warn)' } : undefined}
                                        />
                                        {ticketList(c).length > 1 && (
                                            <button className="btn sm danger" type="button" onClick={() => setTickets(ticketList(c).filter((_, i) => i !== idx))}>
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                ))}
                                <button className="btn sm" type="button" onClick={() => setTickets([...ticketList(c), ''])}>
                                    + Another ticket
                                </button>
                            </div>
                        </Field>
                        <Field label="Verification evidence link">
                            <input
                                value={c.verificationUrl || ''}
                                onChange={(e) => upd({ verificationUrl: e.target.value })}
                                placeholder="link to test report / verification record"
                            />
                        </Field>
                    </div>
                )}
            </div>
        );
    };

    // Brainstorming comparison: for one threat, list every candidate control side by side with its
    // residual risk, negative effects and an "implement" checkbox, so alternatives can be weighed.
    const renderCompare = () => {
        const t = threatById.get(compareThreatId);
        const forThreat = t ? cms.filter((c) => (c.addresses || []).some((a) => a.threat === t.id)).sort(byId) : [];
        const initial = t ? (t.likelihood || 0) * (t.impact || 0) : 0;
        const negOf = (c: Countermeasure) => (c.negativeEffects || []).join('\n');
        const setNeg = (cmId: string, text: string) => {
            const lines = text.split('\n');
            updCm(cmId, { negativeEffects: lines.length === 1 && lines[0] === '' ? [] : lines });
        };
        return (
            <>
                <EditBackBar label="Compare &amp; choose countermeasures" onBack={() => setMode('selected')} />
                <div className="card">
                    <div className="toolbar" style={{ alignItems: 'flex-end' }}>
                        <Field label="Threat to compare">
                            <select className="inp" style={{ minWidth: 260 }} value={compareThreatId} onChange={(e) => setCompareThreatId(e.target.value)}>
                                <option value="">Select a threat…</option>
                                {threats.map((x) => (
                                    <option key={x.id} value={x.id}>
                                        {x.id} · {x.title}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        {t && (
                            <span className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                Initial risk {schemeWarning ? `L ${t.likelihood ?? '—'} / I ${t.impact ?? '—'}` : <RiskPill score={initial} band={bandForRisk(t.likelihood, t.impact, scheme)} />}
                            </span>
                        )}
                    </div>
                    {t ? (
                        <>
                            <table className="cmp-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ textAlign: 'left', color: 'var(--text-dim)', fontSize: 12 }}>
                                        <th style={{ padding: 6 }}>Countermeasure</th>
                                        <th style={{ padding: 6, width: 260 }}>Residual (L × I)</th>
                                        <th style={{ padding: 6 }}>Negative effects</th>
                                        <th style={{ padding: 6, width: 70 }} />
                                        <th style={{ padding: 6, width: 90, textAlign: 'center' }}>Implement</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {forThreat.map((c) => {
                                        const a = (c.addresses || []).find((x) => x.threat === t.id);
                                        const rl = a?.residualLikelihood ?? t.likelihood;
                                        const ri = a?.residualImpact ?? t.impact;
                                        const risk = (rl || 0) * (ri || 0);
                                        return (
                                            <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                                                <td style={{ padding: 6 }}>
                                                    <input className="inp" value={c.title} onChange={(e) => updCm(c.id, { title: e.target.value })} />
                                                    <span className="hint mono">{c.id} · {c.type || 'preventive'}</span>
                                                </td>
                                                <td style={{ padding: 6 }}>
                                                    <div className="inline" style={{ gap: 4, alignItems: 'center' }}>
                                                        <ScaleSelect value={rl} levels={likelihoodScale} disabled={!!schemeWarning} onChange={(n) => updCmAddr(c.id, t.id, { residualLikelihood: Math.min(n, t.likelihood) })} style={{ width: 96 }} />
                                                        <span>×</span>
                                                        <ScaleSelect value={ri} levels={impactScale} disabled={!!schemeWarning} onChange={(n) => updCmAddr(c.id, t.id, { residualImpact: Math.min(n, t.impact) })} style={{ width: 96 }} />
                                                        {schemeWarning ? <span className="hint">L {rl ?? '—'} / I {ri ?? '—'}</span> : <RiskPill score={risk} band={bandForRisk(rl, ri, scheme)} />}
                                                    </div>
                                                </td>
                                                <td style={{ padding: 6 }}>
                                                    <textarea className="inp" style={{ minHeight: 48, fontSize: 12 }} value={negOf(c)} placeholder="one per line" onChange={(e) => setNeg(c.id, e.target.value)} />
                                                </td>
                                                <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                                                    <button className="btn sm" onClick={() => setEditingId(c.id)}>Edit</button>
                                                    <button className="btn sm danger" aria-label={`Delete countermeasure ${c.id}`} onClick={() => confirmDelete(`countermeasure ${c.id}`) && removeCm(c.id)}>✕</button>
                                                </td>
                                                <td style={{ padding: 6, textAlign: 'center' }}>
                                                    <input type="checkbox" checked={isSelected(c)} onChange={(e) => toggleSelected(c, e.target.checked)} aria-label={`Implement ${c.id}`} />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    {!forThreat.length && (
                                        <tr>
                                            <td colSpan={5} className="hint" style={{ padding: 10 }}>
                                                No countermeasures address this threat yet.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                            <button className="btn sm primary" style={{ marginTop: 8 }} onClick={() => addCandidateForThreat(t.id)}>
                                + Add candidate for this threat
                            </button>
                        </>
                    ) : (
                        <p className="hint">Pick a threat above to compare candidate controls side by side.</p>
                    )}
                </div>

                {candidateCms.length > 0 && (
                    <div className="card">
                        <h3>Not-yet-implemented candidates</h3>
                        <p className="hint" style={{ marginTop: 0 }}>Controls modelled but not selected for implementation — still fully editable here.</p>
                        <div className="list">
                            {candidateCms.map((c) => (
                                <div className="itemcard collapsed" key={c.id}>
                                    <div className="head">
                                        <span className="summary-id">{c.id}</span>
                                        <span className="summary-title" title={c.title}>{c.title}</span>
                                        <span className="tag">{c.type || 'preventive'}</span>
                                        <label className="inline" style={{ gap: 5 }} title="Choose to implement">
                                            <input type="checkbox" checked={isSelected(c)} onChange={(e) => toggleSelected(c, e.target.checked)} />
                                            <span className="hint">Implement</span>
                                        </label>
                                        <button className="btn sm" onClick={() => setEditingId(c.id)}>Edit</button>
                                        <button className="btn sm danger" aria-label={`Delete countermeasure ${c.id}`} onClick={() => confirmDelete(`countermeasure ${c.id}`) && removeCm(c.id)}>✕</button>
                                    </div>
                                    <div className="summary-links">
                                        <span className="lbl">Addresses:</span>
                                        {(c.addresses || []).length ? (c.addresses || []).map((a) => <Jump key={a.threat} view="threats" id={a.threat} title={threatById.get(a.threat) ? `${a.threat} · ${threatById.get(a.threat)!.title}` : undefined} />) : <span className="hint">none</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </>
        );
    };

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Countermeasures &amp; residual risk</h1>
                <HelpButton title="Countermeasures (tips)">
                    <ul>
                        <li>Use <b>object references, not copies</b> — link one countermeasure to many threats rather than duplicating text.</li>
                        <li>Record the residual L/I each control achieves; the residual risk uses the <b>lowest</b> result across applied controls.</li>
                        <li>Implemented or verified controls should include ticket and verification links.</li>
                    </ul>
                </HelpButton>
            </div>
            {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning} Residual ratings are read-only and shown as stored axes.</div>}
            <p className="lead">
                Link each countermeasure to the threats it reduces and record the residual L/I per threat.
            </p>

            {editing ? (
                <>
                    <EditBackBar label={`Editing ${editing.id}`} onBack={() => setEditingId(null)} />
                    {renderEditor(editing)}
                </>
            ) : mode === 'compare' ? (
                renderCompare()
            ) : (
                <>
                    <div className="toolbar">
                        <button className="btn primary sm" onClick={add}>
                            + Countermeasure
                        </button>
                        {kb?.countermeasures?.length ? (
                            <select
                                className="inp"
                                style={{ width: 280 }}
                                value=""
                                onChange={(e) => {
                                    if (e.target.value) importKb(e.target.value);
                                    e.target.value = '';
                                }}
                            >
                                <option value="">+ Add from knowledge base…</option>
                                {kb.countermeasures.map((k: any) => (
                                    <option key={k.key} value={k.key}>
                                        {k.title}
                                    </option>
                                ))}
                            </select>
                        ) : null}
                        <button className="btn sm" onClick={openCompare} title="Compare candidate controls for a threat">
                            ⚖ Compare &amp; choose
                        </button>
                        {candidateCms.length > 0 && (
                            <button className="btn sm right" onClick={openCompare} title="Candidate controls not selected for implementation">
                                {candidateCms.length} candidate{candidateCms.length > 1 ? 's' : ''} not implemented
                            </button>
                        )}
                        <ThreatCmImportExport />
                    </div>

                    <div className="list">
                        {selectedCms.map((c) => {
                            const addr = c.addresses || [];
                            return (
                                <div id={`f-countermeasures-${c.id}`} className={'itemcard collapsed' + (focusId === c.id ? ' focused' : '')} key={c.id} style={!addr.length ? { borderColor: '#f0c9a8' } : undefined}>
                                    <div className="head">
                                        <span className="summary-id">{c.id}</span>
                                        <span className="summary-title" title={c.title}>{c.title}</span>
                                        <span className="tag">{c.type || 'preventive'}</span>
                                        <span className="tag statuspill">{c.status || 'proposed'}</span>
                                        <button className="btn sm" onClick={() => setEditingId(c.id)}>
                                            Edit
                                        </button>
                                        <button className="btn sm danger" aria-label={`Delete countermeasure ${c.id}`} onClick={() => confirmDelete(`countermeasure ${c.id}`) && removeCm(c.id)}>
                                            ✕
                                        </button>
                                    </div>
                                    <div className="summary-links">
                                        <span className="lbl">Addresses:</span>
                                        {addr.length ? addr.map((a) => <Jump key={a.threat} view="threats" id={a.threat} title={threatById.get(a.threat) ? `${a.threat} · ${threatById.get(a.threat)!.title}` : undefined} />) : <span className="hint">none</span>}
                                    </div>
                                    {(c.negativeEffects || []).filter(Boolean).length > 0 && (
                                        <div className="summary-links">
                                            <span className="lbl">Trade-offs:</span>
                                            <span className="hint">{(c.negativeEffects || []).filter(Boolean).join('; ')}</span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {!selectedCms.length && (
                            <p className="hint">
                                No implemented countermeasures yet. Use <b>⚖ Compare &amp; choose</b> to review candidates.
                            </p>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
