// Renders a git-pulled catalogue file (see webapp/.assets/knowledge-base/imported/<name>/*.json)
// as browsable threat/countermeasure tables instead of a raw JSON dump.
import React, { useState } from 'react';
import { sortStride, TableRegion } from './common';

type CatalogueDoc = {
    name?: string;
    version?: string;
    maintainer?: string;
    description?: string;
    notice?: string;
    sources?: string[];
    threats?: any[];
    countermeasures?: any[];
};

function ExpandButton({ open, onClick }: { open: boolean; onClick: () => void }) {
    return (
        <button type="button" className="linkbtn" onClick={onClick} aria-expanded={open}>
            {open ? 'Hide' : 'Details'}
        </button>
    );
}

function ThreatsTable({ threats, docKey }: { threats: any[]; docKey: string }) {
    const [open, setOpen] = useState<Set<string>>(new Set());
    const toggle = (key: string) =>
        setOpen((s) => {
            const next = new Set(s);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    return (
        <TableRegion label={`Threat catalogue ${docKey}`}>
            <table className="tbl">
                <thead>
                    <tr>
                        <th scope="col">Key</th>
                        <th scope="col">Title</th>
                        <th scope="col">STRIDE</th>
                        <th scope="col">Applies to</th>
                        <th scope="col">Typ. impact</th>
                        <th scope="col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {threats.map((t) => {
                        const rowKey = `${docKey}:${t.key}`;
                        const isOpen = open.has(rowKey);
                        return (
                            <React.Fragment key={rowKey}>
                                <tr>
                                    <th scope="row" className="mono">{t.key}</th>
                                    <td>{t.title}</td>
                                    <td className="mono stride">{sortStride(t.stride || []).join('')}</td>
                                    <td className="mono">{(t.appliesTo || []).join(', ')}</td>
                                    <td>{t.typicalImpact ?? '—'}</td>
                                    <td>
                                        <ExpandButton open={isOpen} onClick={() => toggle(rowKey)} />
                                    </td>
                                </tr>
                                {isOpen && (
                                    <tr className="rowdetail">
                                        <td colSpan={6}>
                                            {t.description && <p>{t.description}</p>}
                                            <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
                                                {t.emb3dId && <span className="tag">EMB3D {t.emb3dId}</span>}
                                                {t.category && <span className="tag">{t.category}</span>}
                                                {t.tier && <span className="tag">{t.tier}</span>}
                                                {(t.cwe || []).map((c: string) => (
                                                    <span className="tag" key={c}>
                                                        {c}
                                                    </span>
                                                ))}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        );
                    })}
                </tbody>
            </table>
        </TableRegion>
    );
}

function CountermeasuresTable({ countermeasures, docKey }: { countermeasures: any[]; docKey: string }) {
    const [open, setOpen] = useState<Set<string>>(new Set());
    const toggle = (key: string) =>
        setOpen((s) => {
            const next = new Set(s);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    return (
        <TableRegion label={`Countermeasure catalogue ${docKey}`}>
            <table className="tbl">
                <thead>
                    <tr>
                        <th scope="col">Key</th>
                        <th scope="col">Title</th>
                        <th scope="col">For</th>
                        <th scope="col">Maturity</th>
                        <th scope="col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {countermeasures.map((c) => {
                        const rowKey = `${docKey}:${c.key}`;
                        const isOpen = open.has(rowKey);
                        return (
                            <React.Fragment key={rowKey}>
                                <tr>
                                    <th scope="row" className="mono">{c.key}</th>
                                    <td>{c.title}</td>
                                    <td className="mono">{(c.for || []).join(', ')}</td>
                                    <td>{c.maturity ?? '—'}</td>
                                    <td>
                                        <ExpandButton open={isOpen} onClick={() => toggle(rowKey)} />
                                    </td>
                                </tr>
                                {isOpen && (
                                    <tr className="rowdetail">
                                        <td colSpan={5}>
                                            <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
                                                {c.emb3dId && <span className="tag">EMB3D {c.emb3dId}</span>}
                                                {c.iec62443 && <span className="tag">{c.iec62443}</span>}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        );
                    })}
                </tbody>
            </table>
        </TableRegion>
    );
}

export default function ImportedCatalogue({
    name,
    files,
    onDelete,
    busy,
}: {
    name: string;
    files: Record<string, CatalogueDoc>;
    onDelete?: (name: string) => void;
    busy?: boolean;
}) {
    return (
        <>
            <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '10px 0 -4px' }}>
                <h3 className="mono" style={{ margin: 0 }}>
                    {name}
                </h3>
                {onDelete && (
                    <button type="button" className="btn sm danger" onClick={() => onDelete(name)} disabled={busy}>
                        ✕ De-import
                    </button>
                )}
            </div>
            {Object.entries(files).map(([fileName, doc]) => {
                const docKey = `${name}/${fileName}`;
                const threats = doc?.threats || [];
                const countermeasures = doc?.countermeasures || [];
                return (
                    <div className="card" key={docKey}>
                        <h3>{doc?.name || fileName}</h3>
                        <p className="hint">
                            {doc?.version && <span className="tag">v{doc.version}</span>} {doc?.maintainer}
                        </p>
                        {doc?.description && <p>{doc.description}</p>}

                        {threats.length > 0 && (
                            <>
                                <h4>
                                    Threats <span className="badge">{threats.length}</span>
                                </h4>
                                <ThreatsTable threats={threats} docKey={docKey} />
                            </>
                        )}

                        {countermeasures.length > 0 && (
                            <>
                                <h4>
                                    Countermeasures <span className="badge">{countermeasures.length}</span>
                                </h4>
                                <CountermeasuresTable countermeasures={countermeasures} docKey={docKey} />
                            </>
                        )}

                        {!threats.length && !countermeasures.length && <p className="hint">No threats or countermeasures in this file.</p>}

                        {doc?.notice && (
                            <details>
                                <summary>License / attribution notice</summary>
                                <p className="hint">{doc.notice}</p>
                                {(doc.sources || []).length > 0 && (
                                    <ul className="hint">
                                        {doc.sources!.map((s) => (
                                            <li key={s}>{s}</li>
                                        ))}
                                    </ul>
                                )}
                            </details>
                        )}
                    </div>
                );
            })}
        </>
    );
}
