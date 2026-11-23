// Defect / vulnerability register (lifecycle DM/SUM). Tracks known weaknesses and CVEs on
// components across the product lifecycle so residual risk can be re-assessed per release.
import { useStore, uid } from '../../state/store';
import { Field, ComboInput, HelpButton, confirmDelete, IdInput, Jump, useFocus } from '../common';
import type { Defect } from '../../types';

const SEVERITY = ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v }));
const STATUS = ['open', 'triaged', 'fixed', 'wont-fix'].map((v) => ({ value: v }));
const SEV_COLOR: Record<string, string> = { critical: 'var(--danger)', high: 'var(--warn)', medium: '#c9a227', low: 'var(--text-faint)' };
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const isOpen = (d: Defect) => d.status !== 'fixed' && d.status !== 'wont-fix';

export default function DefectsPanel() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const defects = data.defects?.defects || [];
    const focusId = useFocus('defects');
    const comps = (data.system.components || []).map((c) => ({ value: c.id, label: `${c.name} (${c.id})` }));
    const threatOpts = (data.threats.threats || []).map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }));
    const write = (list: Defect[]) => save('defects', { defects: list });
    const upd = (id: string, patch: Partial<Defect>) => write(defects.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const del = (id: string) => write(defects.filter((x) => x.id !== id));
    const add = () =>
        write([
            ...defects,
            { id: uid('D', defects.map((d) => d.id)), title: 'New defect', severity: 'medium', status: 'open', discovered: new Date().toISOString().slice(0, 10) },
        ]);
    // Show the most urgent first: open before resolved, then by severity.
    const ordered = [...defects].sort((a, b) => {
        const ao = isOpen(a) ? 0 : 1;
        const bo = isOpen(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    });
    const openCount = defects.filter(isOpen).length;

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Defect &amp; vulnerability register</h1>
                <HelpButton title="Defect register (tips)">
                    <ul>
                        <li>Track known weaknesses through the product lifecycle.</li>
                        <li>Record third-party CVEs against the affected SBOM component and re-assess linked threats after the fix.</li>
                    </ul>
                </HelpButton>
            </div>
            <p className="lead">
                Track known defects and CVEs per component.
            </p>
            <div className="toolbar">
                <button className="btn primary sm" onClick={add}>
                    + Defect
                </button>
                <span className="tag">{defects.length} total</span>
                <span className={'tag' + (openCount ? ' warnmark' : '')}>{openCount} open</span>
            </div>
            {ordered.length ? (
                ordered.map((d) => {
                    return (
                        <div
                            id={`f-defects-${d.id}`}
                            className={'card' + (focusId === d.id ? ' focused' : '')}
                            key={d.id}
                            style={{ borderLeft: `4px solid ${SEV_COLOR[d.severity] || 'var(--border)'}`, opacity: isOpen(d) ? 1 : 0.72 }}
                        >
                            <div className="head">
                                <span className="sevdot" title={d.severity} style={{ background: SEV_COLOR[d.severity] || 'var(--border)' }} />
                                <IdInput id={d.id} />
                                <input className="inp grow" value={d.title} onChange={(e) => upd(d.id, { title: e.target.value })} />
                                <button className="btn sm danger" aria-label={`Delete defect ${d.id}`} onClick={async () => { if (await confirmDelete(`defect ${d.id}`)) del(d.id); }}>
                                    ✕
                                </button>
                            </div>
                            <div className="grid4">
                                <Field label="CVE / advisory">
                                    <input value={d.cve || ''} onChange={(e) => upd(d.id, { cve: e.target.value })} placeholder="CVE-2024-…" />
                                </Field>
                                <Field label="Affected component">
                                    <ComboInput value={d.component} onChange={(v) => upd(d.id, { component: v || undefined })} options={comps} placeholder="component…" />
                                    {d.component && (
                                        <div style={{ marginTop: 4 }}>
                                            <Jump view="system" id={d.component} title={comps.find((c) => c.value === d.component)?.label} />
                                        </div>
                                    )}
                                </Field>
                                <Field label="Severity">
                                    <ComboInput value={d.severity} onChange={(v) => upd(d.id, { severity: v as any })} options={SEVERITY} />
                                </Field>
                                <Field label="Status">
                                    <ComboInput value={d.status} onChange={(v) => upd(d.id, { status: v as any })} options={STATUS} />
                                </Field>
                            </div>
                            <div className="grid3">
                                <Field label="Discovered">
                                    <input type="date" value={d.discovered || ''} onChange={(e) => upd(d.id, { discovered: e.target.value })} />
                                </Field>
                                <Field label="Fixed in (version)">
                                    <input value={d.fixedIn || ''} onChange={(e) => upd(d.id, { fixedIn: e.target.value })} placeholder="FW 2.5" />
                                </Field>
                                <Field label="Re-assess threat" hint="Open high/critical defects flag this threat for reassessment.">
                                    <ComboInput value={d.threatRef} onChange={(v) => upd(d.id, { threatRef: v || undefined })} options={threatOpts} placeholder="threat…" />
                                    {d.threatRef && (
                                        <div style={{ marginTop: 4 }}>
                                            <Jump view="threats" id={d.threatRef} title={threatOpts.find((t) => t.value === d.threatRef)?.label} />
                                        </div>
                                    )}
                                </Field>
                            </div>
                            <Field label="Note">
                                <textarea className="inp grow" value={d.note || ''} onChange={(e) => upd(d.id, { note: e.target.value })} />
                            </Field>
                        </div>
                    );
                })
            ) : (
                <p className="hint">No defects yet.</p>
            )}
        </div>
    );
}
