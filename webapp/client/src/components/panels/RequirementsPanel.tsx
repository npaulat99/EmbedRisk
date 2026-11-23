// Security requirements (methodology step 05) — the traceable bridge threat -> risk ->
// requirement -> control that IEC 62443-4-1 (SR) and the CRA expect.
import { useStore, uid } from '../../state/store';
import { Field, TagSelect, useFocus, useEditMode, EditBackBar, Jump, HelpButton, confirmDelete, IdInput } from '../common';
import type { Requirement } from '../../types';

export default function RequirementsPanel() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const reqs = data.requirements?.requirements || [];
    const threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];
    const focusId = useFocus('requirements');
    const { editingId, setEditingId } = useEditMode(focusId);
    const write = (list: Requirement[]) => save('requirements', { requirements: list });
    const add = () => {
        const id = uid('R', reqs.map((r) => r.id));
        write([...reqs, { id, text: 'New security requirement', derivedFromThreat: [], satisfiedByCM: [] }]);
        setEditingId(id);
    };
    const threatOpts = threats.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }));
    const cmOpts = cms.map((c) => ({ value: c.id, label: `${c.id} · ${c.title}` }));
    const threatById = new Map(threats.map((t) => [t.id, t]));
    const cmById = new Map(cms.map((c) => [c.id, c]));
    const editing = reqs.find((r) => r.id === editingId) || null;

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Security requirements</h1>
                <HelpButton title="Security requirements (tips)">
                    <ul>
                        <li>Requirements complete the audit chain <b>threat → risk → requirement → control</b>.</li>
                        <li>Cite the standard clause (e.g. IEC 62443-4-2 CR 1.2) and the SL / Foundational Requirement it satisfies.</li>
                        <li>Every high/critical threat should derive at least one requirement; every requirement should be satisfied by a countermeasure.</li>
                    </ul>
                </HelpButton>
            </div>
            <p className="lead">
                Derive testable requirements from threats and link them to the controls that satisfy them.
            </p>

            {editing ? (
                <>
                    <EditBackBar label={`Editing ${editing.id}`} onBack={() => setEditingId(null)} />
                    {(() => {
                        const r = editing;
                        const upd = (patch: Partial<Requirement>) => write(reqs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
                        return (
                            <div id={`f-requirements-${r.id}`} className="card">
                                <div className="head">
                                    <IdInput id={r.id} onRename={setEditingId} />
                                    <input className="inp grow" value={r.text} onChange={(e) => upd({ text: e.target.value })} />
                                    <button className="btn sm danger" aria-label={`Delete requirement ${r.id}`} onClick={async () => { if (await confirmDelete(`requirement ${r.id}`)) { write(reqs.filter((x) => x.id !== r.id)); setEditingId(null); } }}>
                                        ✕
                                    </button>
                                </div>
                                <div className="grid2">
                                    <Field label="Standard reference">
                                        <input value={r.standardRef || ''} onChange={(e) => upd({ standardRef: e.target.value })} placeholder="IEC 62443-4-2 CR 1.2" />
                                    </Field>
                                    <Field label="SL / Foundational Requirement">
                                        <input value={r.slFr || ''} onChange={(e) => upd({ slFr: e.target.value })} placeholder="FR1 SL2" />
                                    </Field>
                                </div>
                                <Field label="Derived from threats">
                                    <TagSelect options={threatOpts} value={r.derivedFromThreat || []} onChange={(v) => upd({ derivedFromThreat: v })} empty="No threats yet." />
                                </Field>
                                <Field label="Satisfied by countermeasures">
                                    <TagSelect options={cmOpts} value={r.satisfiedByCM || []} onChange={(v) => upd({ satisfiedByCM: v, fromCountermeasure: v.length ? true : r.fromCountermeasure })} empty="No countermeasures yet." />
                                </Field>
                                <label className="inline" style={{ gap: 7, alignItems: 'flex-start', marginTop: 4 }}>
                                    <input type="checkbox" checked={!!r.fromCountermeasure || (r.satisfiedByCM || []).length > 0} disabled={(r.satisfiedByCM || []).length > 0} onChange={(e) => upd({ fromCountermeasure: e.target.checked })} style={{ marginTop: 3 }} />
                                    <span className="hint">
                                        <b>Is CM</b> means this requirement is realized by a countermeasure.
                                    </span>
                                </label>
                            </div>
                        );
                    })()}
                </>
            ) : (
                <>
                    <div className="toolbar">
                        <button className="btn primary sm" onClick={add}>
                            + Requirement
                        </button>
                    </div>
                    {reqs.length ? (
                        <div className="list">
                            {[...reqs].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((r) => (
                                <div id={`f-requirements-${r.id}`} className={'itemcard collapsed' + (focusId === r.id ? ' focused' : '')} key={r.id}>
                                    <div className="head">
                                        <span className="summary-id">{r.id}</span>
                                        <span className="summary-title" title={r.text || undefined}>{r.text || '(untitled requirement)'}</span>
                                        {r.fromCountermeasure || (r.satisfiedByCM || []).length ? (
                                            <span className="tag" title="Realises a countermeasure that reduces a threat's risk">is CM</span>
                                        ) : !(r.derivedFromThreat || []).length ? (
                                            <span className="tag" title="Not derived from a threat or countermeasure">standalone</span>
                                        ) : null}
                                        <button className="btn sm" onClick={() => setEditingId(r.id)}>
                                            Edit
                                        </button>
                                        <button className="btn sm danger" aria-label={`Delete requirement ${r.id}`} onClick={async () => { if (await confirmDelete(`requirement ${r.id}`)) write(reqs.filter((x) => x.id !== r.id)); }}>
                                            ✕
                                        </button>
                                    </div>
                                    <div className="summary-links">
                                        <span className="lbl">From threats:</span>
                                        {(r.derivedFromThreat || []).length ? r.derivedFromThreat!.map((tid) => <Jump key={tid} view="threats" id={tid} title={threatById.get(tid) ? `${tid} · ${threatById.get(tid)!.title}` : undefined} />) : <span className="hint">none</span>}
                                        <span className="lbl">Satisfied by:</span>
                                        {(r.satisfiedByCM || []).length ? r.satisfiedByCM!.map((cid) => <Jump key={cid} view="countermeasures" id={cid} title={cmById.get(cid) ? `${cid} · ${cmById.get(cid)!.title}` : undefined} />) : <span className="hint">none</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="hint">No requirements yet.</p>
                    )}
                </>
            )}
        </div>
    );
}
