import { useState } from 'react';
import { useStore, uid } from '../../state/store';
import { Field, HelpButton, confirmDelete, IdInput } from '../common';
import type { Assumption } from '../../types';

const CATS: { key: 'device' | 'system' | 'environment' | 'operational'; label: string; help: string }[] = [
    { key: 'device', label: 'Device', help: 'Secure boot, debug ports, hardware roots of trust…' },
    { key: 'system', label: 'System', help: 'How the device sits in the wider system / safety chain.' },
    { key: 'environment', label: 'Environment', help: 'Physical access, wireless range, network exposure.' },
    { key: 'operational', label: 'Operational', help: 'Default passwords, update cadence, lifetime.' },
];

const ASSUMPTION_PREFIX: Record<typeof CATS[number]['key'], string> = {
    device: 'AD-',
    system: 'SYSA-',
    environment: 'AE-',
    operational: 'AO-',
};

type TabKey = 'overview' | 'device' | 'system' | 'environment' | 'operational';

export default function AssumptionsPanel() {
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const a = data.assumptions;
    const [tab, setTab] = useState<TabKey>('overview');
    const set = (patch: any) => save('assumptions', { ...a, ...patch });

    const setList = (key: typeof CATS[number]['key'], list: Assumption[]) => set({ [key]: list });
    const addAssumption = (key: typeof CATS[number]['key']) => {
        const list = a[key] || [];
        setList(key, [...list, { id: uid(ASSUMPTION_PREFIX[key], list.map((x) => x.id)), text: '' }]);
    };
    const catCard = (cat: typeof CATS[number]) => (
        <div className="card" key={cat.key}>
            <div className="toolbar">
                <h3 style={{ margin: 0 }}>{cat.label} assumptions</h3>
                <div className="right">
                    <button className="btn sm" onClick={() => addAssumption(cat.key)}>
                        + Add
                    </button>
                </div>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
                {cat.help}
            </p>
            <div className="list">
                {(a[cat.key] || []).map((item, i) => ({ item, i })).sort((a, b) => a.item.id.localeCompare(b.item.id, undefined, { numeric: true })).map(({ item, i }) => {
                    const list = a[cat.key];
                    const upd = (patch: any) => setList(cat.key, list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                        <div className="itemcard" key={i}>
                            <div className="head" style={{ alignItems: 'flex-start' }}>
                                <IdInput id={item.id} />
                                <textarea className="inp grow" rows={2} value={item.text} onChange={(e) => upd({ text: e.target.value })} placeholder="Assumption text (wraps to fit)" />
                                <button className="btn sm danger" aria-label="Delete assumption" onClick={async () => { if (await confirmDelete('this assumption')) setList(cat.key, list.filter((_, j) => j !== i)); }}>
                                    ✕
                                </button>
                            </div>
                        </div>
                    );
                })}
                {!(a[cat.key] || []).length && <p className="hint">No assumptions yet.</p>}
            </div>
        </div>
    );

    const total = CATS.reduce((s, c) => s + (a[c.key]?.length || 0), 0);
    const tabs: { key: TabKey; label: string; count: number }[] = [
        { key: 'overview', label: 'Overview', count: total },
        ...CATS.map((c) => ({ key: c.key as TabKey, label: c.label, count: a[c.key]?.length || 0 })),
    ];

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Assumptions</h1>
                <HelpButton title="Assumptions (tips)">
                    <ul>
                        <li>The attacker profile is selected from the project SL-C level; access is rated on each threat or attack path.</li>
                        <li>Be explicit about the awkward truths: default passwords left in place, 15–20 year lifetime, rare firmware updates.</li>
                        <li>Separate <b>device</b> (what the product guarantees), <b>system</b> (its role in the plant/safety chain), <b>environment</b> (physical/network exposure) and <b>operational</b> (how it is run).</li>
                    </ul>
                </HelpButton>
            </div>
            <p className="lead">
                Record the assumptions behind the assessment.
            </p>

            <div className="tabs">
                {tabs.map((t) => (
                    <button key={t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
                        {t.label}
                        <span className="badge">{t.count}</span>
                    </button>
                ))}
            </div>

            {CATS.filter((c) => tab === 'overview' || tab === c.key).map(catCard)}
        </div>
    );
}
