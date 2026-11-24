// Bug Bar reference table: dimensions × levels with concrete scenarios so any user can
// rate impact objectively. Data comes from the shared knowledge base (.assets/knowledge-base/bug-bar.json).
import { useStore } from '../state/store';

export default function BugBarTable() {
    const bugBar = useStore((s) => s.bugBar);
    const dims = bugBar?.dimensions || [];
    if (!dims.length) return <p className="hint">Bug bar reference not available.</p>;
    const labelFor = (score: number) => dims[0].levels.find((l: any) => l.score === score)?.label || '';
    return (
        <div>
            {bugBar.rule && <p className="hint" style={{ marginTop: 0 }}>{bugBar.rule}</p>}
            <table className="tbl bugbar">
                <thead>
                    <tr>
                        <th style={{ width: 110 }}>Level</th>
                        {dims.map((d: any) => (
                            <th key={d.key}>{d.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {[5, 4, 3, 2, 1].map((score) => (
                        <tr key={score}>
                            <td>
                                <b>{score}</b> · {labelFor(score)}
                            </td>
                            {dims.map((d: any) => (
                                <td key={d.key} style={{ fontSize: '0.75rem' }}>
                                    {d.levels.find((l: any) => l.score === score)?.scenario || ''}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
