// Export/import full (concrete) threats and countermeasures — every schema field, ratings and all —
// as a portable JSON file. Distinct from the abstract knowledge-base catalogue import (KbPanel):
// this round-trips actual project data, e.g. to share an assessed threat set between projects.
import { useRef, useState } from 'react';
import { useStore } from '../state/store';
import { allIds } from '../lib/ids';
import type { Threat, Countermeasure } from '../types';
import AppDialog from './AppDialog';

function download(filename: string, data: unknown) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** Next free id for `prefix`, considering both the project's existing ids and ids already claimed in this batch. */
function nextId(prefix: string, claimed: Set<string>): string {
    let n = 1;
    while (claimed.has(`${prefix}${n}`)) n++;
    const id = `${prefix}${n}`;
    claimed.add(id);
    return id;
}

/** The id's leading, non-numeric prefix (e.g. "T-12" -> "T-"), falling back to `fallback`. */
function guessPrefix(id: unknown, fallback: string): string {
    const m = typeof id === 'string' ? id.match(/^(.*?)\d+$/) : null;
    return m?.[1] || fallback;
}

function ExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const data = useStore((s) => s.data)!;
    const threats = data.threats.threats || [];
    const cms = data.countermeasures.countermeasures || [];
    const [selT, setSelT] = useState<Set<string>>(new Set(threats.map((t) => t.id)));
    const [selC, setSelC] = useState<Set<string>>(new Set(cms.map((c) => c.id)));
    const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
        const next = new Set(set);
        next.has(id) ? next.delete(id) : next.add(id);
        setSet(next);
    };
    const toggleAll = (all: { id: string }[], set: Set<string>, setSet: (s: Set<string>) => void) =>
        setSet(set.size === all.length ? new Set() : new Set(all.map((x) => x.id)));

    const doExport = () => {
        const out: { threats?: Threat[]; countermeasures?: Countermeasure[] } = {};
        if (selT.size) out.threats = threats.filter((t) => selT.has(t.id));
        if (selC.size) out.countermeasures = cms.filter((c) => selC.has(c.id));
        const stamp = new Date().toISOString().slice(0, 10);
        download(`${data.project.projectId || data.project.title || 'tra'}-threats-countermeasures-${stamp}.json`, out);
        onClose();
    };

    return (
        <AppDialog open={open} onClose={onClose} title="Export threats and countermeasures" size="lg" dismissOnBackdrop>
            <p className="hint">Select which items to include. Every field (ratings, rationale, status, etc.) is exported as-is.</p>
            <div className="grid2">
                <div className="card">
                    <div className="inline" style={{ justifyContent: 'space-between' }}>
                        <h3 style={{ margin: 0 }}>Threats</h3>
                        <button className="btn sm" onClick={() => toggleAll(threats, selT, setSelT)}>
                            {selT.size === threats.length ? 'None' : 'All'}
                        </button>
                    </div>
                    <div className="checklist">
                        {threats.map((t) => (
                            <label key={t.id} className="checkrow">
                                <input type="checkbox" checked={selT.has(t.id)} onChange={() => toggle(selT, setSelT, t.id)} />
                                <span className="mono">{t.id}</span> {t.title}
                            </label>
                        ))}
                        {!threats.length && <p className="hint">No threats yet.</p>}
                    </div>
                </div>
                <div className="card">
                    <div className="inline" style={{ justifyContent: 'space-between' }}>
                        <h3 style={{ margin: 0 }}>Countermeasures</h3>
                        <button className="btn sm" onClick={() => toggleAll(cms, selC, setSelC)}>
                            {selC.size === cms.length ? 'None' : 'All'}
                        </button>
                    </div>
                    <div className="checklist">
                        {cms.map((c) => (
                            <label key={c.id} className="checkrow">
                                <input type="checkbox" checked={selC.has(c.id)} onChange={() => toggle(selC, setSelC, c.id)} />
                                <span className="mono">{c.id}</span> {c.title}
                            </label>
                        ))}
                        {!cms.length && <p className="hint">No countermeasures yet.</p>}
                    </div>
                </div>
            </div>
            <div className="inline" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn primary sm" onClick={doExport} disabled={!selT.size && !selC.size}>
                    Export {selT.size + selC.size} item{selT.size + selC.size === 1 ? '' : 's'}
                </button>
            </div>
        </AppDialog>
    );
}

export default function ThreatCmImportExport() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const [exportOpen, setExportOpen] = useState(false);
    const [msg, setMsg] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    const doImport = async (file: File) => {
        let parsed: any;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            setMsg('Import failed: not valid JSON.');
            return;
        }
        // Accept our own export shape, a bare array, or a raw threats.json/countermeasures.json step file.
        const rawThreats: any[] = Array.isArray(parsed) ? (parsed[0]?.addresses ? [] : parsed) : parsed.threats || [];
        const rawCms: any[] = Array.isArray(parsed) ? (parsed[0]?.addresses ? parsed : []) : parsed.countermeasures || [];
        if (!rawThreats.length && !rawCms.length) {
            setMsg('Import failed: no threats or countermeasures found in the file.');
            return;
        }

        const claimed = new Set(allIds(data).map((x) => x.id));
        const threatIdMap = new Map<string, string>();
        const cmIdMap = new Map<string, string>();

        const newThreats: Threat[] = rawThreats.map((t) => {
            const finalId = t?.id && !claimed.has(t.id) ? (claimed.add(t.id), t.id) : nextId(guessPrefix(t?.id, 'T'), claimed);
            if (t?.id) threatIdMap.set(t.id, finalId);
            return { ...t, id: finalId };
        });
        const newCms: Countermeasure[] = rawCms.map((c) => {
            const finalId = c?.id && !claimed.has(c.id) ? (claimed.add(c.id), c.id) : nextId(guessPrefix(c?.id, 'CM'), claimed);
            if (c?.id) cmIdMap.set(c.id, finalId);
            return { ...c, id: finalId };
        });
        // Remap cross-references between threats and countermeasures imported in the same batch;
        // references to ids outside the batch (e.g. an existing project threat) are left untouched.
        for (const c of newCms) c.addresses = (c.addresses || []).map((a: any) => ({ ...a, threat: threatIdMap.get(a.threat) || a.threat }));
        for (const t of newThreats) if (t.countermeasures) t.countermeasures = t.countermeasures.map((id) => cmIdMap.get(id) || id);

        if (newThreats.length) save('threats', { threats: [...(data.threats.threats || []), ...newThreats] });
        if (newCms.length) save('countermeasures', { countermeasures: [...(data.countermeasures.countermeasures || []), ...newCms] });

        const remapped = [...threatIdMap.entries(), ...cmIdMap.entries()].filter(([o, n]) => o !== n).length;
        setMsg(`Imported ${newThreats.length} threat(s) and ${newCms.length} countermeasure(s).${remapped ? ` ${remapped} id(s) renamed to avoid collisions.` : ''}`);
    };

    return (
        <>
            <button className="btn sm" onClick={() => setExportOpen(true)}>
                ⇓ Export…
            </button>
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
                ⇑ Import…
            </button>
            <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) doImport(file);
                }}
            />
            {msg && <span className="hint">{msg}</span>}
            <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
        </>
    );
}
