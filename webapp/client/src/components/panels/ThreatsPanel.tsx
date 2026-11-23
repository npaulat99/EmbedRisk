import { useEffect, useId, useState } from 'react';
import { useStore, uid } from '../../state/store';
import { Field, Chips, TagSelect, cx, STRIDE, sortStride, RiskPill, useFocus, useEditMode, EditBackBar, ScaleSelect, Jump, HelpButton, confirmDelete, IdInput } from '../common';
import { createRiskEngine, riskOf } from '../../lib/risk';
import { adId } from '../../lib/attackTree';
import { actorLevelLabel, normalizeActorLevel } from '@shared/attackerScale.js';
import RiskCalculator from './RiskCalculator';
import ThreatCmImportExport from '../ThreatCmImportExport';
import type { Threat } from '../../types';

export default function ThreatsPanel() {
    const data = useStore((s) => s.data)!;
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const engine = createRiskEngine(scheme);
    const likelihoodScale = engine.likelihoodLevels().map((level) => [level.value, `${level.code} · ${level.label}`] as [number, string]);
    const impactScale = engine.impactLevels().map((level) => [level.value, `${level.code} · ${level.label}`] as [number, string]);
    const kb = useStore((s) => s.kb);
    const save = useStore((s) => s.save);
    const setView = useStore((s) => s.setView);
    const [sortBy, setSortBy] = useState<'id' | 'name' | 'initial' | 'residual'>('id');
    const [kbFilter, setKbFilter] = useState('');
    const [recordFilter, setRecordFilter] = useState('');
    const kbSearchId = useId();
    const recordSearchId = useId();

    const threats = data.threats.threats || [];
    const knowledgeThreats = kb?.threats || [];
    const filteredKnowledgeThreats = knowledgeThreats.filter((item: any) => `${item.key} ${item.title} ${(item.stride || []).join(' ')}`.toLowerCase().includes(kbFilter.trim().toLowerCase()));
    const filteredThreats = threats.filter((threat) => `${threat.id} ${threat.title} ${threat.classification || ''} ${(threat.stride || []).join(' ')}`.toLowerCase().includes(recordFilter.trim().toLowerCase()));
    const cms = data.countermeasures.countermeasures || [];
    const focusId = useFocus('threats');
    const { editingId, setEditingId } = useEditMode(focusId);
    const [editTab, setEditTab] = useState<'classification' | 'details' | 'risk'>('classification');
    useEffect(() => setEditTab('classification'), [editingId]);
    const cmsFor = (tid: string) => cms.filter((c) => (c.addresses || []).some((a) => a.threat === tid));
    const requirements = data.requirements?.requirements || [];
    const requirementOpts = requirements.map((r) => ({ value: r.id, label: r.id, title: r.text }));
    const compOpts = (data.system.components || []).map((c) => ({ value: c.id, label: `${c.name}` }));
    const assetOpts = (data.system.assets || []).map((a) => ({ value: a.id, label: a.name }));
    const attacker = data.assumptions.attacker?.[0];
    const assumptionRows = [
        ...(data.assumptions.device || []).map((x) => ({ id: x.id, text: x.text || '', source: 'Device' })),
        ...(data.assumptions.system || []).map((x) => ({ id: x.id, text: x.text || '', source: 'System' })),
        ...(data.assumptions.environment || []).map((x) => ({ id: x.id, text: x.text || '', source: 'Environment' })),
        ...(data.assumptions.operational || []).map((x) => ({ id: x.id, text: x.text || '', source: 'Operational' })),
        ...(attacker ? [{ id: attacker.id, text: attacker.text || attacker.name || '', source: 'Attacker' }] : []),
    ];
    const assumptionOpts = assumptionRows.map((x) => ({ value: x.id, label: `${x.id} · ${x.source}`, title: x.text || undefined }));

    const trees = data.attackTrees?.trees || [];
    const treeThreatRefs = (tree: any) => [...new Set([...(tree.threatRefs || []), ...(tree.threatRef ? [tree.threatRef] : [])])];
    const treeFor = (tid: string) => trees.find((x) => treeThreatRefs(x).includes(tid));
    const makeTree = (t: Threat) => {
        if (!treeFor(t.id)) {
            const root = { id: adId(), kind: 'goal' as const, label: t.title, gate: 'OR' as const, children: [] };
            save('attackTrees', { trees: [...trees, { id: uid('AT', trees.map((x) => x.id)), title: t.title, threatRef: t.id, threatRefs: [t.id], root }] });
        }
        setView('attackTrees');
    };

    const setThreats = (list: Threat[]) => save('threats', { threats: list });
    const setThreatRequirements = (threatId: string, requirementIds: string[]) => {
        const selected = new Set(requirementIds);
        save('requirements', {
            requirements: requirements.map((requirement) => {
                const links = new Set(requirement.derivedFromThreat || []);
                if (selected.has(requirement.id)) links.add(threatId);
                else links.delete(threatId);
                return { ...requirement, derivedFromThreat: [...links] };
            }),
        });
    };
    const add = () => {
        const id = uid('T', threats.map((t) => t.id));
        setThreats([...threats, { id, title: 'New threat', stride: ['T'], components: [], likelihood: 3, impact: 3, status: 'open' }]);
        setEditingId(id);
    };
    const importKb = (key: string) => {
        const k = (kb?.threats || []).find((x: any) => x.key === key);
        if (!k) return;
        const id = uid('T', threats.map((t) => t.id));
        setThreats([
            ...threats,
            {
                id,
                title: k.title,
                stride: sortStride(k.stride || ['T']),
                components: [],
                likelihood: 3,
                impact: k.typicalImpact || 3,
                status: 'open',
                description: `Imported from knowledge base (${k.key}). Assign affected components.`,
            },
        ]);
        setEditingId(id);
    };
    const editing = threats.find((t) => t.id === editingId) || null;

    const renderEditor = (t: Threat) => {
        const upd = (patch: any) => setThreats(threats.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
        const orphan = !(t.components || []).length;
        const ifaceOpts = (data.system.interfaces || []).map((itf) => ({ value: itf.id, label: `${itf.name}${itf.protocol ? ` (${itf.protocol})` : ''}` }));
        const linkedRequirementIds = requirements.filter((r) => (r.derivedFromThreat || []).includes(t.id)).map((r) => r.id);
        const interfaceRefs = t.interfaceRefs?.length ? t.interfaceRefs : t.interfaceRef && t.interfaceRef !== 'custom' ? [t.interfaceRef] : [];
        const setInterfaces = (next: string[]) => upd({ interfaceRefs: next, interfaceRef: next[0] || undefined });
        const splitByInterface = () => {
            if (interfaceRefs.length < 2 || t.interfaceLabel) return;
            const suffix = new Map((data.system.interfaces || []).map((itf) => [itf.id, itf.name]));
            const usedIds = [...threats.filter((x) => x.id !== t.id).map((x) => x.id)];
            const clones = interfaceRefs.map((ifaceId) => {
                const nextId = uid('T', usedIds);
                usedIds.push(nextId);
                return {
                    ...t,
                    id: nextId,
                    title: `${t.title} - ${suffix.get(ifaceId) || ifaceId}`,
                    interfaceRef: ifaceId,
                    interfaceRefs: [ifaceId],
                };
            });
            setThreats([...threats.filter((x) => x.id !== t.id), ...clones]);
            setEditingId(clones[0]?.id || null);
        };
        return (
            <div id={`f-threats-${t.id}`} className="itemcard" key={t.id} style={orphan ? { borderColor: '#f0c9a8' } : undefined}>
                <div className="head">
                    <IdInput id={t.id} onRename={setEditingId} />
                    <input className="inp grow" value={t.title} onChange={(e) => upd({ title: e.target.value })} />
                    <button className="btn sm danger" aria-label={`Delete threat ${t.id}`} onClick={async () => { if (await confirmDelete(`threat ${t.id}`)) { setThreats(threats.filter((x) => x.id !== t.id)); setEditingId(null); } }}>
                        ✕
                    </button>
                </div>

                <div className="grid2">
                    <Field label="STRIDE">
                        <Chips options={STRIDE.map((s) => ({ value: s.k, label: `${s.k} · ${s.label}` }))} value={t.stride || []} onChange={(v) => upd({ stride: sortStride(v) })} />
                    </Field>
                    <div className="grid3">
                        <Field label="Likelihood">
                            {schemeWarning ? <span className="hint">Stored: {t.likelihood ?? '—'}</span> : ['criteria-max', 'geometric-mean'].includes(engine.scheme.likelihood.derivation.kind)
                                ? <span className="hint">{engine.scheme.likelihood.levels.find((level: any) => level.value === t.likelihood)?.label || 'Not rated'} · rated in Risk assessment</span>
                                : <ScaleSelect value={t.likelihood} onChange={(n) => upd({ likelihood: n })} levels={likelihoodScale} />}
                            {engine.scheme.likelihood.derivation.kind === 'cost-based' && typeof t.costLikelihoodProposal === 'number' && t.likelihood !== t.costLikelihoodProposal && (
                                <p className="hint warnmark" style={{ margin: '5px 0 0' }}>Manual value differs from calculated proposal L{t.costLikelihoodProposal}. Review and accept this override in Review &amp; report if intentional.</p>
                            )}
                        </Field>
                        <Field label="Impact">
                            {schemeWarning ? <span className="hint">Stored: {t.impact ?? '—'}</span> : engine.scheme.impact.derivation.kind === 'criteria-max'
                                ? <span className="hint">{engine.scheme.impact.levels.find((level: any) => level.value === t.impact)?.label || 'Not rated'} · rated in Risk assessment</span>
                                : <ScaleSelect value={t.impact} onChange={(n) => upd({ impact: n })} levels={impactScale} />}
                        </Field>
                        <Field label="Status">
                            <select value={t.status || 'open'} onChange={(e) => upd({ status: e.target.value })}>
                                {['open', 'mitigated', 'accepted', 'transferred', 'unfeasible'].map((o) => (
                                    <option key={o} disabled={o === 'unfeasible'}>{o}</option>
                                ))}
                            </select>
                        </Field>
                    </div>
                </div>

                <Field label="Affected components" hint={orphan ? 'A threat must affect at least one component.' : undefined}>
                    <TagSelect options={compOpts} value={t.components || []} onChange={(v) => upd({ components: v })} empty="Define components in step 03 first." />
                </Field>
                <div className="subtabs">
                    <div className="tabs sub">
                        <button type="button" className={cx('tab', editTab === 'classification' && 'active')} onClick={() => setEditTab('classification')}>
                            Classification
                        </button>
                        <button type="button" className={cx('tab', editTab === 'details' && 'active')} onClick={() => setEditTab('details')}>
                            Assets &amp; interfaces
                        </button>
                        <button type="button" className={cx('tab', editTab === 'risk' && 'active')} onClick={() => setEditTab('risk')}>
                            Risk rating
                        </button>
                    </div>
                    {editTab === 'classification' && (
                        <div className="calc">
                            <div className="grid2">
                                <Field label="Classification">
                                    <select value={t.classification || ''} onChange={(e) => upd({ classification: e.target.value || undefined })}>
                                        <option value="">— none —</option>
                                        <option value="product-vulnerability">product-vulnerability</option>
                                        <option value="protocol-limitation">protocol-limitation</option>
                                        <option value="deployment-risk">deployment-risk</option>
                                        <option value="shared-responsibility">shared-responsibility</option>
                                    </select>
                                </Field>
                                <Field label="Responsibility">
                                    <select value={t.responsibility || ''} onChange={(e) => upd({ responsibility: e.target.value || undefined })}>
                                        <option value="">— none —</option>
                                        <option value="manufacturer">manufacturer</option>
                                        <option value="integrator-operator">integrator-operator</option>
                                        <option value="shared">shared</option>
                                    </select>
                                </Field>
                            </div>
                            <Field label="Classification rationale">
                                <textarea value={t.classificationRationale || ''} onChange={(e) => upd({ classificationRationale: e.target.value || undefined })} />
                            </Field>
                            {(t.classification === 'protocol-limitation' || t.classification === 'deployment-risk' || t.classification === 'shared-responsibility') && (
                                <Field
                                    label="Deployment constraints"
                                    hint="Compensating controls required outside this component (segmentation, physical protection, gateway architecture, monitoring) for the residual risk to be acceptable in an actual deployment."
                                >
                                    <textarea value={t.deploymentConstraints || ''} onChange={(e) => upd({ deploymentConstraints: e.target.value || undefined })} />
                                </Field>
                            )}
                        </div>
                    )}
                    {editTab === 'details' && (
                        <div className="calc">
                            <div className="grid2">
                                <Field label="Affected assets">
                                    <TagSelect options={assetOpts} value={t.assets || []} onChange={(v) => upd({ assets: v })} empty="No assets yet." />
                                </Field>
                                <Field label="Affected interfaces / vectors" hint="Split by interface if the risk differs.">
                                    <TagSelect options={ifaceOpts} value={interfaceRefs} onChange={setInterfaces} empty="No interfaces defined in step 03 yet." />
                                    <input
                                        className="inp"
                                        style={{ marginTop: 6 }}
                                        placeholder="Optional custom vector, e.g. over USB service port"
                                        value={t.interfaceLabel || ''}
                                        onChange={(e) => upd({ interfaceLabel: e.target.value || undefined })}
                                    />
                                    {interfaceRefs.length > 1 && !t.interfaceLabel && (
                                        <button type="button" className="btn sm" style={{ marginTop: 6 }} onClick={splitByInterface}>
                                            Split into one threat per interface
                                        </button>
                                    )}
                                </Field>
                            </div>
                            <div className="grid2">
                                <Field label="Likelihood rationale">
                                    <textarea value={t.likelihoodRationale || ''} onChange={(e) => upd({ likelihoodRationale: e.target.value })} />
                                </Field>
                                <Field label="Impact rationale">
                                    <textarea value={t.impactRationale || ''} onChange={(e) => upd({ impactRationale: e.target.value })} />
                                </Field>
                            </div>
                            <Field label="Supporting assumptions" hint="Assumptions that justify feasibility or the chosen risk rating.">
                                <TagSelect options={assumptionOpts} value={t.assumptionRefs || []} onChange={(v) => upd({ assumptionRefs: v })} empty="No assumptions defined in step 02 yet." />
                            </Field>
                        </div>
                    )}
                    {editTab === 'risk' && <RiskCalculator t={t} upd={upd} />}
                </div>
                <Field
                    label={t.status === 'transferred' ? 'Risk transfer requirements' : 'Linked requirements / rationale'}
                    hint="Link requirements that mitigate this threat or justify why its residual risk is accepted or transferred."
                >
                    <TagSelect options={requirementOpts} value={linkedRequirementIds} onChange={(v) => setThreatRequirements(t.id, v)} empty="Define requirements in step 05 first." />
                </Field>
                {t.status === 'accepted' && (
                    <div className="grid3" style={{ marginTop: 8 }}>
                        <Field label="Accepted by" hint="Residual-risk sign-off owner.">
                            <input value={t.acceptedBy || ''} onChange={(e) => upd({ acceptedBy: e.target.value })} placeholder="name / role" />
                        </Field>
                        <Field label="Acceptance rationale" hint="Why the residual risk is acceptable.">
                            <input value={t.acceptanceRationale || ''} onChange={(e) => upd({ acceptanceRationale: e.target.value })} placeholder="e.g. compensating controls in the plant" />
                        </Field>
                        <Field label="Next review date" hint="Next reassessment date.">
                            <input type="date" value={t.reviewDate || ''} onChange={(e) => upd({ reviewDate: e.target.value })} />
                        </Field>
                    </div>
                )}
                <div className="inline" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
                    <button className="btn sm" onClick={() => makeTree(t)}>
                        {treeFor(t.id) ? 'Open attack tree →' : '+ Attack tree for this threat'}
                    </button>
                    <span className="hint" style={{ marginLeft: 8 }}>Mitigated by:</span>
                    {cmsFor(t.id).length ? (
                        cmsFor(t.id).map((c) => <Jump key={c.id} view="countermeasures" id={c.id} label={`${c.id} · ${c.title}`.slice(0, 26)} title={`${c.id} · ${c.title}`} />)
                    ) : (
                        <span className="hint">none</span>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Threats &amp; risk</h1>
                <HelpButton title="Threat identification (tips)">
                    <ul>
                        <li>Walk each <b>interface and trust-boundary crossing</b> with STRIDE; flows that cross a boundary are the hot-spots.</li>
                        <li>Keep it proportionate: around <b>~5 substantive threats per interface</b> is usually enough.</li>
                        <li>Prefer the <b>knowledge base</b> for common OT threats; write attack trees only for the few complex multi-step paths.</li>
                        <li>Attach every threat to at least one component, set the <b>primary interface</b>, and ground likelihood in an attacker profile.</li>
                    </ul>
                </HelpButton>
            </div>
            {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning} Risk fields are read-only; stored L/I values are shown without classification.</div>}
            <p className="lead">
                Enumerate STRIDE threats and link each one to the affected components and assets.
            </p>
            <div className="assessment-basis" role="note">
                <span className="assessment-basis-label">Attacker Profile</span>
                {attacker ? (
                    <span>{attacker.name} <span className="muted">· capability {normalizeActorLevel(attacker.capability)} ({actorLevelLabel(attacker.capability)})</span></span>
                ) : (
                    <span className="warnmark">Select a target SL-C level in Project settings to establish the assessment attacker.</span>
                )}
            </div>

            {editing ? (
                <>
                    <EditBackBar label={`Editing ${editing.id}`} onBack={() => setEditingId(null)} />
                    {renderEditor(editing)}
                </>
            ) : (
                <>
                    <div className="toolbar">
                        <button className="btn primary sm" onClick={add}>
                            + Threat
                        </button>
                        {knowledgeThreats.length ? (
                            <div className="kb-threat-picker">
                                <search className="threat-search">
                                    <label htmlFor={kbSearchId}>Search knowledge base</label>
                                    <input id={kbSearchId} className="inp" type="search" value={kbFilter} onChange={(event) => setKbFilter(event.target.value)} />
                                </search>
                                <select
                                    className="inp"
                                    aria-label="Add filtered knowledge-base threat"
                                    value=""
                                    onChange={(e) => {
                                        if (e.target.value) importKb(e.target.value);
                                        e.target.value = '';
                                    }}
                                >
                                    <option value="">+ Add from knowledge base…</option>
                                    {filteredKnowledgeThreats.map((item: any) => <option key={item.key} value={item.key}>{item.title}</option>)}
                                </select>
                                {kbFilter && (
                                    <span className="tag active-filter">
                                        Knowledge base: {kbFilter}
                                        <button className="filter-clear" type="button" aria-label="Clear knowledge-base search" onClick={() => setKbFilter('')}>Clear</button>
                                    </span>
                                )}
                                {kbFilter && !filteredKnowledgeThreats.length && <span className="hint">No knowledge-base threats match this search.</span>}
                            </div>
                        ) : null}
                        <ThreatCmImportExport />
                        <label className="inline" style={{ gap: 6 }}>
                            <span className="hint">Sort by</span>
                            <select className="inp sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                                <option value="id">ID</option>
                                <option value="name">Name</option>
                                <option value="initial">Original risk</option>
                                <option value="residual">Residual risk</option>
                            </select>
                        </label>
                    </div>

                    <search className="threat-search threat-record-search">
                        <label htmlFor={recordSearchId}>Search threats</label>
                        <input id={recordSearchId} className="inp" type="search" value={recordFilter} onChange={(event) => setRecordFilter(event.target.value)} />
                        {recordFilter && (
                            <span className="tag active-filter">
                                Threats: {recordFilter}
                                <button className="filter-clear" type="button" aria-label="Clear threat search" onClick={() => setRecordFilter('')}>Clear</button>
                            </span>
                        )}
                    </search>

                    <div className="list">
                        {[...filteredThreats].sort((a, b) => {
                            if (sortBy === 'id') return a.id.localeCompare(b.id, undefined, { numeric: true });
                            if (sortBy === 'name') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
                            const aRisk = riskOf(a, cms, scheme);
                            const bRisk = riskOf(b, cms, scheme);
                            return sortBy === 'initial' ? bRisk.initial - aRisk.initial : bRisk.residual - aRisk.residual;
                        }).map((t) => {
                            const r = riskOf(t, cms, scheme);
                            const orphan = !(t.components || []).length;
                            return (
                                <div id={`f-threats-${t.id}`} className={'itemcard collapsed' + (focusId === t.id ? ' focused' : '')} key={t.id} style={orphan ? { borderColor: '#f0c9a8' } : undefined}>
                                    <div className="head">
                                        <span className="summary-id">{t.id}</span>
                                        <span className="summary-title" title={t.title}>{t.title}</span>
                                        <RiskPill score={r.initial} band={r.initialBand} title="Initial risk" />
                                        <span className="muted">→</span>
                                        <RiskPill score={r.residual} band={r.residualBand} title="Residual risk" />
                                        <span className="tag">{t.status || 'open'}</span>
                                        <button className="btn sm" onClick={() => setEditingId(t.id)}>
                                            Edit
                                        </button>
                                        <button className="btn sm danger" aria-label={`Delete threat ${t.id}`} onClick={async () => { if (await confirmDelete(`threat ${t.id}`)) setThreats(threats.filter((x) => x.id !== t.id)); }}>
                                            ✕
                                        </button>
                                    </div>
                                    <div className="summary-links">
                                        {(t.stride || []).length ? <span className="tag stride">{sortStride(t.stride).join(' ')}</span> : null}
                                        {t.classification ? <span className="tag">Class: {t.classification}</span> : null}
                                        {t.responsibility ? <span className="tag">Resp: {t.responsibility}</span> : null}
                                        {(t.assumptionRefs || []).length ? <span className="tag">Assumptions: {t.assumptionRefs.join(', ')}</span> : null}
                                        <span className="lbl">Mitigated by:</span>
                                        {cmsFor(t.id).length ? cmsFor(t.id).map((c) => <Jump key={c.id} view="countermeasures" id={c.id} title={`${c.id} · ${c.title}`} />) : <span className="hint">none</span>}
                                        {(t.assets || []).length ? (
                                            <>
                                                <span className="lbl">Assets:</span>
                                                {(t.assets || []).map((aid) => (
                                                    <Jump key={aid} view="system" id={aid} title={assetOpts.find((a) => a.value === aid) ? `${aid} · ${assetOpts.find((a) => a.value === aid)!.label}` : undefined} />
                                                ))}
                                            </>
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                        {!threats.length ? <p className="hint">No threats yet.</p> : !filteredThreats.length ? <p className="hint">No threats match this search.</p> : null}
                    </div>
                </>
            )}
        </div>
    );
}
