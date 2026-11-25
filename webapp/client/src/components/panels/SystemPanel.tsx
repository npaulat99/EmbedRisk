import { useState } from 'react';
import { useStore, uid } from '../../state/store';
import { Field, TagSelect, ComboInput, useFocus, useEditMode, EditBackBar, ScaleSelect, OBJECTIVE_LEVELS, SelectedChips, Jump, HelpButton, confirmDelete, IdInput } from '../common';
import type { Asset, Component, Interface, TrustBoundary } from '../../types';

const KIND_OPTS = ['device', 'hardware', 'software', 'interface', 'external-entity', 'store'].map((v) => ({ value: v }));
const PROVENANCE_OPTS = [
    { value: 'own', label: 'own development' },
    { value: 'third-party (OSS)', label: 'open-source dependency' },
    { value: 'third-party (commercial)', label: 'commercial / licensed' },
    { value: 'subcontracted', label: 'developed by a subcontractor' },
];
const CATEGORY_OPTS = [
    { value: 'network', label: 'network / fieldbus' },
    { value: 'external', label: 'external / debug' },
    { value: 'user', label: 'user / local HMI' },
];
const ASSET_TYPE_OPTS = [
    { value: 'function', label: 'function - control logic, service, operation' },
    { value: 'data', label: 'data - measurements, recipes, logs, set-points' },
    { value: 'credential', label: 'credential - password, token, key material' },
    { value: 'firmware', label: 'firmware - executable image or boot content' },
    { value: 'config', label: 'config - parameters, calibration, provisioning' },
    { value: 'physical-process', label: 'physical-process - plant state or safety effect' },
].map((v) => ({ value: v.value, label: v.label }));

type Tab = 'components' | 'interfaces' | 'boundaries' | 'assets';

export default function SystemPanel() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const openStrideBoundary = useStore((s) => s.openStrideBoundary);
    const sys = data.system;
    const set = (patch: any) => save('system', { ...sys, ...patch });
    const compOpts = (sys.components || []).map((c) => ({ value: c.id, label: `${c.name} (${c.id})` }));
    const focusId = useFocus('system');
    const { editingId, setEditingId } = useEditMode(focusId);
    const allThreats = data.threats.threats || [];
    const threatsForAsset = (aid: string) => allThreats.filter((t) => (t.assets || []).includes(aid));
    const [tab, setTab] = useState<Tab>('components');
    // Switching tabs returns to the collapsed list; a traceability jump to an asset opens it.
    const switchTab = (t: Tab) => {
        setEditingId(null);
        setTab(t);
    };

    const layerForParent = (parentId?: string | null) => {
        if (!parentId) return 1;
        const parent = (sys.components || []).find((c) => c.id === parentId);
        return (parent?.layer || 0) + 1;
    };

    const addComp = () =>
        set({
            components: [
                ...sys.components,
                {
                    id: uid('C-', sys.components.map((c) => c.id)),
                    name: 'New component',
                    kind: 'software',
                    parent: sys.components[0]?.id || null,
                    layer: layerForParent(sys.components[0]?.id || null),
                },
            ],
        });
    const addIface = () =>
        set({ interfaces: [...(sys.interfaces || []), { id: uid('I-', (sys.interfaces || []).map((c) => c.id)), name: 'New interface', exposure: 'local' }] });
    const addTb = () => {
        const id = uid('TB-', (sys.trustBoundaries || []).map((c) => c.id));
        set({ trustBoundaries: [...(sys.trustBoundaries || []), { id, name: 'New boundary', members: [] }] });
        setEditingId(id);
    };
    const addAsset = () => {
        const id = uid('AST-', (sys.assets || []).map((c) => c.id));
        set({
            assets: [
                ...(sys.assets || []),
                { id, name: 'New asset', type: 'function', components: [], objectives: { confidentiality: 1, integrity: 3, availability: 3, safety: 1 } },
            ],
        });
        setEditingId(id);
    };
    const editingTb = (sys.trustBoundaries || []).find((b) => b.id === editingId) || null;
    const editingAsset = (sys.assets || []).find((a) => a.id === editingId) || null;
    const isDeviceHousing = (tb: TrustBoundary) => tb.id === 'TB-1';

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>System definition &amp; assets</h1>
                <HelpButton title="System &amp; assets (tips)">
                    <ul>
                        <li>Mark third-party components (OSS / commercial) with <b>provenance</b> — they drive SBOM and supply-chain scope.</li>
                        <li><b>Group assets</b> at the right level: model one "measurement integrity" asset, not one per signal.</li>
                        <li>Categorise interfaces (network / external / user) and record where each asset is <b>stored</b> (internal/external flash, secure element…) — storage location changes the attacker's required access.</li>
                        <li>Rate each asset's protection goals: C / I / A / Safety (0–5). Safety stays in the model when the asset or function can affect a hazardous plant state; otherwise it can stay low or zero.</li>
                    </ul>
                </HelpButton>
            </div>
            <p className="lead">
                Define components, interfaces, trust boundaries, and protected assets.
            </p>

            <div className="tabs">
                {(
                    [
                        { k: 'components', label: 'Components', n: (sys.components || []).length },
                        { k: 'interfaces', label: 'Interfaces', n: (sys.interfaces || []).length },
                        { k: 'boundaries', label: 'Trust boundaries', n: (sys.trustBoundaries || []).length },
                        { k: 'assets', label: 'Assets', n: (sys.assets || []).length },
                    ] as { k: Tab; label: string; n: number }[]
                ).map((t) => (
                    <button key={t.k} className={'tab' + (tab === t.k ? ' active' : '')} onClick={() => switchTab(t.k)}>
                        {t.label} <span className="badge">{t.n}</span>
                    </button>
                ))}
            </div>

            {/* Components */}
            {tab === 'components' && (
                <div className="card">
                    <div className="toolbar">
                        <h3 style={{ margin: 0 }}>Components</h3>
                        <div className="right">
                            <button className="btn sm" onClick={addComp}>
                                + Component
                            </button>
                        </div>
                    </div>
                    <div className="list">
                        {(sys.components || []).map((c: Component, i) => {
                            const upd = (patch: any) => set({ components: sys.components.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                            return (
                                <div className="itemcard" key={i}>
                                    <div className="head">
                                        <IdInput id={c.id} />
                                        <input className="inp grow" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                                        <button className="btn sm danger" aria-label={`Delete component ${c.id}`} onClick={async () => { if (await confirmDelete(`component ${c.id}`)) set({ components: sys.components.filter((_, j) => j !== i) }); }}>
                                            ✕
                                        </button>
                                    </div>
                                    <div className="grid4">
                                        <Field label="Kind">
                                            <ComboInput value={c.kind} onChange={(v) => upd({ kind: v })} options={KIND_OPTS} placeholder="software…" />
                                        </Field>
                                        <Field label="Provenance">
                                            <ComboInput value={c.provenance} onChange={(v) => upd({ provenance: v || undefined })} options={PROVENANCE_OPTS} placeholder="own / third-party…" />
                                        </Field>
                                        <Field label="Parent">
                                            <select value={c.parent || ''} onChange={(e) => upd({ parent: e.target.value || null, layer: layerForParent(e.target.value || null) })}>
                                                <option value="">— none —</option>
                                                {sys.components.filter((x) => x.id !== c.id).map((x) => (
                                                    <option key={x.id} value={x.id}>
                                                        {x.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </Field>
                                        <Field label="Layer">
                                            <input value={String(c.layer || layerForParent(c.parent))} readOnly disabled />
                                        </Field>
                                        <Field label="Trust zone">
                                            <input value={c.trustZone || ''} onChange={(e) => upd({ trustZone: e.target.value })} />
                                        </Field>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Interfaces */}
            {tab === 'interfaces' && (
                <div className="card">
                    <div className="toolbar">
                        <h3 style={{ margin: 0 }}>Interfaces</h3>
                        <div className="right">
                            <button className="btn sm" onClick={addIface}>
                                + Interface
                            </button>
                        </div>
                    </div>
                    <div className="list">
                        {(sys.interfaces || []).map((c: Interface, i) => {
                            const upd = (patch: any) => set({ interfaces: sys.interfaces.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                            return (
                                <div className="itemcard" key={i}>
                                    <div className="head">
                                        <IdInput id={c.id} />
                                        <input className="inp grow" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                                        <button className="btn sm danger" aria-label={`Delete interface ${c.id}`} onClick={async () => { if (await confirmDelete(`interface ${c.id}`)) set({ interfaces: sys.interfaces.filter((_, j) => j !== i) }); }}>
                                            ✕
                                        </button>
                                    </div>
                                    <div className="grid4">
                                        <Field label="Category">
                                            <ComboInput value={c.category} onChange={(v) => upd({ category: v || undefined })} options={CATEGORY_OPTS} placeholder="network…" />
                                        </Field>
                                        <Field label="Chip tag" hint="Short label displayed on the DFD node.">
                                            <input value={c.tag || ''} onChange={(e) => upd({ tag: e.target.value })} placeholder="BLE, HMI, JTAG…" />
                                        </Field>
                                        <Field label="On component">
                                            <select value={c.component || ''} onChange={(e) => upd({ component: e.target.value })}>
                                                <option value="">— none —</option>
                                                {compOpts.map((o) => (
                                                    <option key={o.value} value={o.value}>
                                                        {o.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </Field>
                                        <Field label="Exposure">
                                            <select value={c.exposure} onChange={(e) => upd({ exposure: e.target.value })}>
                                                {['physical', 'local', 'adjacent', 'remote'].map((o) => (
                                                    <option key={o}>{o}</option>
                                                ))}
                                            </select>
                                        </Field>
                                        <Field label="Protocol">
                                            <input value={c.protocol || ''} onChange={(e) => upd({ protocol: e.target.value })} />
                                        </Field>
                                        {c.hidden && (
                                            <Field label="DFD visibility" hint="This control only appears after the interface has been hidden in step 04.">
                                                <label className="check">
                                                    <input type="checkbox" checked={!!c.hidden} onChange={(e) => upd({ hidden: e.target.checked })} /> hide this interface
                                                </label>
                                                <p className="hint" style={{ marginTop: 8 }}>
                                                    Untick to unhide this interface in the DFD view.
                                                </p>
                                            </Field>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Trust boundaries */}
            {tab === 'boundaries' && (
                <div className="card">
                    {editingTb ? (
                        (() => {
                            const c = editingTb;
                            const upd = (patch: any) => set({ trustBoundaries: sys.trustBoundaries.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) });
                            return (
                                <>
                                    <EditBackBar label={`Editing ${c.id}`} onBack={() => setEditingId(null)} />
                                    <div className="itemcard">
                                        <div className="head">
                                            <IdInput id={c.id} onRename={setEditingId} />
                                            <input className="inp grow" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                                            {isDeviceHousing(c) ? (
                                                <span className="hint" style={{ marginLeft: 8 }}>
                                                    Mandatory device housing
                                                </span>
                                            ) : (
                                                <button className="btn sm danger" aria-label={`Delete trust boundary ${c.id}`} onClick={async () => { if (await confirmDelete(`trust boundary ${c.id}`)) { set({ trustBoundaries: sys.trustBoundaries.filter((x) => x.id !== c.id) }); setEditingId(null); } }}>
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                        <Field label="Members">
                                            <TagSelect options={compOpts} value={c.members || []} onChange={(v) => upd({ members: v })} />
                                        </Field>
                                        <button className="btn sm" onClick={() => openStrideBoundary(c.id)}>
                                            STRIDE strengths / weaknesses
                                        </button>
                                    </div>
                                </>
                            );
                        })()
                    ) : (
                        <>
                            <div className="toolbar">
                                <h3 style={{ margin: 0 }}>Trust boundaries</h3>
                                <div className="right">
                                    <button className="btn sm" onClick={addTb}>
                                        + Boundary
                                    </button>
                                </div>
                            </div>
                            <div className="list">
                                {(sys.trustBoundaries || []).map((c: TrustBoundary) => (
                                    <div className="itemcard collapsed" key={c.id}>
                                        <div className="head">
                                            <span className="summary-id">{c.id}</span>
                                            <span className="summary-title" title={c.name}>{c.name}</span>
                                            <button className="btn sm" onClick={() => openStrideBoundary(c.id)} title="Edit the STRIDE strengths/weaknesses analysis for this boundary">
                                                STRIDE
                                            </button>
                                            <button className="btn sm" onClick={() => setEditingId(c.id)}>
                                                Edit
                                            </button>
                                            {isDeviceHousing(c) ? (
                                                <span className="hint" style={{ marginLeft: 8 }}>
                                                    Mandatory device housing
                                                </span>
                                            ) : (
                                                <button className="btn sm danger" aria-label={`Delete trust boundary ${c.id}`} onClick={async () => { if (await confirmDelete(`trust boundary ${c.id}`)) set({ trustBoundaries: sys.trustBoundaries.filter((x) => x.id !== c.id) }); }}>
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                        <div className="summary-links">
                                            <span className="lbl">Members:</span>
                                            <SelectedChips options={compOpts} value={c.members} empty="none" />
                                        </div>
                                    </div>
                                ))}
                                {!(sys.trustBoundaries || []).length && <p className="hint">No trust boundaries yet.</p>}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Assets */}
            {tab === 'assets' && (
                <div className="card">
                    <datalist id="storages">
                        {['internal flash', 'external flash', 'secure element', 'TPM', 'RAM', 'ROM / OTP', 'EEPROM', 'SD card', 'cloud / backend'].map((o) => (
                            <option key={o} value={o} />
                        ))}
                    </datalist>
                    {editingAsset ? (
                        (() => {
                            const c = editingAsset;
                            const upd = (patch: any) => set({ assets: sys.assets.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) });
                            const obj = (k: string, v: number) => upd({ objectives: { ...c.objectives, [k]: v } });
                            return (
                                <>
                                    <EditBackBar label={`Editing ${c.id}`} onBack={() => setEditingId(null)} />
                                    <div id={`f-system-${c.id}`} className="itemcard">
                                        <div className="head">
                                            <IdInput id={c.id} onRename={setEditingId} />
                                            <input className="inp grow" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                                            <ComboInput value={c.type || 'function'} onChange={(v) => upd({ type: v })} options={ASSET_TYPE_OPTS} width={150} />
                                            <button className="btn sm danger" aria-label={`Delete asset ${c.id}`} onClick={async () => { if (await confirmDelete(`asset ${c.id}`)) { set({ assets: sys.assets.filter((x) => x.id !== c.id) }); setEditingId(null); } }}>
                                                ✕
                                            </button>
                                        </div>
                                        <div className="grid4">
                                            {(['confidentiality', 'integrity', 'availability', 'safety'] as const).map((k) => (
                                                <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
                                                    <ScaleSelect value={(c.objectives as any)?.[k] ?? 0} onChange={(n) => obj(k, n)} levels={OBJECTIVE_LEVELS} />
                                                </Field>
                                            ))}
                                        </div>
                                        <p className="hint" style={{ marginTop: 8 }}>
                                            Defines asset protection priorities. Safety is prioritized for assets that directly impact plant stability.
                                        </p>
                                        <div className="grid2">
                                            <Field label="Asset type" hint="Pick the closest business or technical class.">
                                                <ComboInput value={c.type || 'function'} onChange={(v) => upd({ type: v })} options={ASSET_TYPE_OPTS} placeholder="function, data, credential…" />
                                            </Field>
                                        </div>
                                        <div className="grid2">
                                            <Field label="Stored in" hint="Physical storage location.">
                                                <input list="storages" value={c.storage || ''} onChange={(e) => upd({ storage: e.target.value })} placeholder="internal flash, secure element…" />
                                            </Field>
                                            <Field label="Held by components">
                                                <TagSelect options={compOpts} value={c.components || []} onChange={(v) => upd({ components: v })} />
                                            </Field>
                                        </div>
                                        <Field label="No-threat rationale" hint="Explain why no threat applies to this asset. Maximum 2000 characters.">
                                            <textarea rows={2} maxLength={2000} value={c.noThreatRationale || ''} onChange={(e) => upd({ noThreatRationale: e.target.value })} />
                                        </Field>
                                        {threatsForAsset(c.id).length > 0 && (
                                            <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
                                                <span className="hint">Threats:</span>
                                                {threatsForAsset(c.id).map((t) => (
                                                    <Jump key={t.id} view="threats" id={t.id} title={`${t.id} · ${t.title}`} />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </>
                            );
                        })()
                    ) : (
                        <>
                            <div className="toolbar">
                                <h3 style={{ margin: 0 }}>Assets &amp; protection goals</h3>
                                <div className="right">
                                    <button className="btn sm" onClick={addAsset}>
                                        + Asset
                                    </button>
                                </div>
                            </div>
                            <div className="list">
                                {(sys.assets || []).map((c: Asset) => {
                                    const o = c.objectives || {};
                                    return (
                                        <div id={`f-system-${c.id}`} className={'itemcard collapsed' + (focusId === c.id ? ' focused' : '')} key={c.id}>
                                            <div className="head">
                                                <span className="summary-id">{c.id}</span>
                                                <span className="summary-title" title={c.name}>{c.name}</span>
                                                <span className="tag">{c.type || 'function'}</span>
                                                <span className="tag" title="Confidentiality / Integrity / Availability / Safety">
                                                    C{o.confidentiality ?? 0}/I{o.integrity ?? 0}/A{o.availability ?? 0}/S{o.safety ?? 0}
                                                </span>
                                                <button className="btn sm" onClick={() => setEditingId(c.id)}>
                                                    Edit
                                                </button>
                                                <button className="btn sm danger" aria-label={`Delete asset ${c.id}`} onClick={async () => { if (await confirmDelete(`asset ${c.id}`)) set({ assets: sys.assets.filter((x) => x.id !== c.id) }); }}>
                                                    ✕
                                                </button>
                                            </div>
                                            <div className="summary-links">
                                                <span className="lbl">Held by:</span>
                                                <SelectedChips options={compOpts} value={c.components} empty="none" />
                                                {threatsForAsset(c.id).length ? (
                                                    <>
                                                        <span className="lbl">Threats:</span>
                                                        {threatsForAsset(c.id).map((t) => (
                                                            <Jump key={t.id} view="threats" id={t.id} title={`${t.id} · ${t.title}`} />
                                                        ))}
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>
                                    );
                                })}
                                {!(sys.assets || []).length && <p className="hint">No assets yet.</p>}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
