import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import type { ChangeReason, StepKey, VersionDiff } from '../../types';
import { Field } from '../common';
import AppDialog from '../AppDialog';

const COMMIT_STEP_KEYS: StepKey[] = ['project', 'assumptions', 'system', 'dfd', 'requirements', 'threats', 'attackTrees', 'countermeasures', 'defects'];
const FOLLOW_UP_REASONS: ChangeReason[] = ['functional changes', 'new vulnerabilities', 'regular reassessment'];

function nextVersionTag(currentVersion: string | null | undefined, reason: ChangeReason) {
    if (reason === 'initial' || !currentVersion) return 'v1.0';
    const match = /^v?(\d+)\.(\d+)$/i.exec(String(currentVersion));
    const major = match ? Number(match[1]) : 1;
    const minor = match ? Number(match[2]) : 0;
    if (reason === 'functional changes') return `v${major + 1}.0`;
    return `v${major}.${minor + 1}`;
}

function parseAssessors(value: string) {
    return value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function toggleVersionSelection(selected: string[], version: string) {
    if (selected.includes(version)) return selected.filter((item) => item !== version);
    if (selected.length < 2) return [...selected, version];
    return [selected[1], version];
}

export default function VersionsPanel() {
    const activeId = useStore((s) => s.activeId);
    const data = useStore((s) => s.data)!;
    const selectProject = useStore((s) => s.selectProject);
    const tracker = data.changeTracker;
    const [status, setStatus] = useState('');
    const [recording, setRecording] = useState(false);
    const [reason, setReason] = useState<ChangeReason>(tracker.entries.length ? 'functional changes' : 'initial');
    const [assessedAt, setAssessedAt] = useState(() => new Date().toISOString().slice(0, 10));
    const [assessors, setAssessors] = useState('');
    const [summary, setSummary] = useState('');
    const [emptyConfirm, setEmptyConfirm] = useState<null | { nextVersion: string; payload: { reason: ChangeReason; assessedAt: string; assessors: string[]; summary: string }; typed: string }>(null);
    const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
    const [diffBusy, setDiffBusy] = useState(false);
    const [diffError, setDiffError] = useState('');
    const [diff, setDiff] = useState<VersionDiff | null>(null);

    useEffect(() => {
        setReason(tracker.entries.length ? 'functional changes' : 'initial');
    }, [tracker.entries.length]);

    useEffect(() => {
        setSelectedVersions((current) => current.filter((version) => tracker.entries.some((entry) => entry.version === version)).slice(-2));
    }, [tracker.entries]);

    useEffect(() => {
        if (!activeId || selectedVersions.length !== 2) {
            setDiff(null);
            setDiffError('');
            return;
        }
        const order = new Map(tracker.entries.map((entry, index) => [entry.version, index]));
        const [fromVersion, toVersion] = [...selectedVersions].sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0));
        let cancelled = false;
        setDiffBusy(true);
        setDiffError('');
        fetch(`/api/projects/${activeId}/change-tracker/diff?from=${encodeURIComponent(fromVersion)}&to=${encodeURIComponent(toVersion)}`)
            .then(async (response) => {
                const result = await response.json();
                if (cancelled) return;
                if (!response.ok || result.ok === false) {
                    setDiff(null);
                    setDiffError(result.error || 'Could not load the selected version diff.');
                    return;
                }
                setDiff(result);
            })
            .catch(() => {
                if (!cancelled) {
                    setDiff(null);
                    setDiffError('Could not load the selected version diff.');
                }
            })
            .finally(() => {
                if (!cancelled) setDiffBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [activeId, selectedVersions, tracker.entries]);

    const availableReasons = useMemo<ChangeReason[]>(() => (tracker.entries.length ? FOLLOW_UP_REASONS : ['initial']), [tracker.entries.length]);
    const currentVersion = tracker.currentVersion;
    const upcomingVersion = nextVersionTag(currentVersion, reason);

    const flushProjectData = async () => {
        if (!activeId || !data) return false;
        for (const step of COMMIT_STEP_KEYS) {
            const response = await fetch(`/api/projects/${activeId}/${step}`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify((data as any)[step]),
            }).catch(() => null);
            if (!response?.ok) {
                setStatus(`Save failed before versioning (${step}).`);
                return false;
            }
        }
        return true;
    };

    const submitVersion = async (payload: { reason: ChangeReason; assessedAt: string; assessors: string[]; summary: string; allowEmpty?: boolean }) => {
        if (!activeId) return;
        setRecording(true);
        try {
            if (!(await flushProjectData())) return;
            const response = await fetch(`/api/projects/${activeId}/change-tracker/versions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await response.json();
            if (result.requiresEmptyConfirmation && result.nextVersion) {
                setEmptyConfirm({ nextVersion: result.nextVersion, payload: { reason: payload.reason, assessedAt: payload.assessedAt, assessors: payload.assessors, summary: payload.summary }, typed: '' });
                setStatus('');
                return;
            }
            if (!response.ok || !result.ok) {
                setStatus(result.error || 'Could not record the TRA version.');
                return;
            }
            await selectProject(activeId);
            setSummary('');
            setAssessors('');
            setEmptyConfirm(null);
            setStatus(`Recorded ${result.nextVersion}.`);
        } finally {
            setRecording(false);
        }
    };

    const recordVersion = async () => {
        const parsedAssessors = parseAssessors(assessors);
        if (!assessedAt.trim()) {
            setStatus('Assessment date is required.');
            return;
        }
        if (!parsedAssessors.length) {
            setStatus('At least one assessor is required.');
            return;
        }
        await submitVersion({ reason, assessedAt, assessors: parsedAssessors, summary: summary.trim() });
    };

    const confirmEmptyReassessment = async () => {
        if (!emptyConfirm) return;
        await submitVersion({ ...emptyConfirm.payload, allowEmpty: true });
    };

    return (
        <div className="panel">
            <h1>TRA versions</h1>
            <p className="lead">
                Record assessment baselines explicitly. The first manual tag is the initial <code>v1.0</code>; later tags track functional changes, new vulnerabilities, and regular reassessments.
            </p>

            <div className="card">
                <h3>Current status</h3>
                <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className="tag">{currentVersion ? `Current TRA version ${currentVersion}` : 'No TRA version tagged yet'}</span>
                    <span className="hint">Stored in <code>01-project-description/change-tracker.json</code></span>
                </div>
                <p className="hint" style={{ margin: 0 }}>
                    {tracker.entries.length
                        ? `${tracker.entries.length} recorded version(s). Select two below for a quick diff.`
                        : 'Finish the first TRA, then record the initial baseline manually as v1.0.'}
                </p>
            </div>

            <div className="card">
                <h3>{tracker.entries.length ? 'Record a new version' : 'Record the initial version'}</h3>
                <div className="row">
                    <Field label="Reason">
                        <select value={reason} onChange={(e) => setReason(e.target.value as ChangeReason)}>
                            {availableReasons.map((item) => (
                                <option key={item} value={item}>
                                    {item}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Assessment date">
                        <input type="date" value={assessedAt} onChange={(e) => setAssessedAt(e.target.value)} />
                    </Field>
                </div>
                <Field label="Assessors" hint="Comma-separated or one name per line.">
                    <textarea value={assessors} onChange={(e) => setAssessors(e.target.value)} placeholder="Jane Doe, John Smith" />
                </Field>
                <Field label="Assessment note" hint="Optional context for this recorded TRA baseline.">
                    <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Initial completed TRA for the concept phase." />
                </Field>
                <div className="inline" style={{ justifyContent: 'space-between', marginTop: 14, flexWrap: 'wrap' }}>
                    <span className="tag">Next version {upcomingVersion}</span>
                    <button className="btn primary" onClick={recordVersion} disabled={recording}>
                        {recording ? 'Recording…' : `Record ${upcomingVersion}`}
                    </button>
                </div>
                {status ? <p className="hint" style={{ marginTop: 10 }}>{status}</p> : null}
            </div>

            <div className="card">
                <h3>Version history</h3>
                {tracker.entries.length ? (
                    <>
                        <p className="hint" style={{ marginTop: 0 }}>
                            Click two version tags to compare the recorded baselines. The diff ignores the version label itself, so a regular reassessment can intentionally produce no file changes.
                        </p>
                        <div className="chips" role="group" aria-label="TRA versions">
                            {tracker.entries.map((entry) => {
                                const selected = selectedVersions.includes(entry.version);
                                return (
                                    <button
                                        key={entry.version}
                                        className={`chip ${selected ? 'on' : ''}`}
                                        type="button"
                                        aria-pressed={selected}
                                        title={`${entry.reason} · ${entry.assessedAt}`}
                                        onClick={() => setSelectedVersions((current) => toggleVersionSelection(current, entry.version))}
                                    >
                                        {entry.version}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="version-history-list">
                            {tracker.entries.map((entry) => (
                                <div className="version-history-item" key={`${entry.version}-${entry.assessedAt}`}>
                                    <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                                        <strong>{entry.version}</strong>
                                        <span className="tag">{entry.reason}</span>
                                    </div>
                                    <p className="hint" style={{ margin: '4px 0 0' }}>
                                        {entry.assessedAt} · {entry.assessors.join(', ') || 'no assessors recorded'}
                                    </p>
                                    {entry.summary ? <p style={{ margin: '6px 0 0' }}>{entry.summary}</p> : null}
                                    <p className="hint" style={{ margin: '6px 0 0' }}>
                                        {entry.hasChanges === false ? 'No file changes recorded.' : `${entry.changedFiles?.length || 0} changed file(s) recorded.`}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <p className="hint" style={{ marginTop: 0 }}>No TRA versions have been tagged yet.</p>
                )}
            </div>

            <div className="card">
                <h3>Version diff</h3>
                {selectedVersions.length !== 2 ? (
                    <p className="hint" style={{ marginTop: 0 }}>Select exactly two recorded versions above to compare them.</p>
                ) : diffBusy ? (
                    <p className="hint" style={{ marginTop: 0 }}>Loading diff…</p>
                ) : diffError ? (
                    <p className="hint" style={{ marginTop: 0 }}>{diffError}</p>
                ) : diff ? (
                    <>
                        <div className="inline" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                            <span className="tag">{diff.fromVersion}</span>
                            <span className="hint">→</span>
                            <span className="tag">{diff.toVersion}</span>
                            <span className="hint">{diff.changedFiles.length} changed file(s)</span>
                        </div>
                        {diff.changedFiles.length ? (
                            <>
                                <div className="chips readonly" style={{ marginBottom: 10 }}>
                                    {diff.changedFiles.map((file) => (
                                        <span className="chip on static" key={`${file.step}:${file.path}`}>
                                            {file.path}
                                        </span>
                                    ))}
                                </div>
                                {diff.files.map((file) => (
                                    <details key={file.path} className="version-diff-file" open>
                                        <summary>
                                            <strong>{file.path}</strong>
                                            <span className="hint" style={{ marginLeft: 8 }}>
                                                +{file.diff.added.length} / -{file.diff.removed.length} / Δ{file.diff.changed.length}
                                            </span>
                                        </summary>
                                        <pre className="jsondiff">{JSON.stringify(file.diff, null, 2)}</pre>
                                    </details>
                                ))}
                            </>
                        ) : (
                            <p className="hint" style={{ marginTop: 0 }}>No methodology files changed between these two versions.</p>
                        )}
                    </>
                ) : (
                    <p className="hint" style={{ marginTop: 0 }}>No diff loaded.</p>
                )}
            </div>

            <AppDialog open={!!emptyConfirm} onClose={() => !recording && setEmptyConfirm(null)} title="Confirm reassessment without changes" dismissOnBackdrop={!recording} onCancel={recording ? () => { } : undefined}>
                {emptyConfirm && (
                    <>
                        <p className="hint" style={{ marginTop: 0 }}>
                            No methodology files changed since {tracker.currentVersion}. To conclude this regular reassessment anyway, type <b>{emptyConfirm.nextVersion}</b> exactly.
                        </p>
                        <Field label={`Type ${emptyConfirm.nextVersion} to confirm`}>
                            <input value={emptyConfirm.typed} onChange={(e) => setEmptyConfirm({ ...emptyConfirm, typed: e.target.value })} placeholder={emptyConfirm.nextVersion} />
                        </Field>
                        <div className="inline" style={{ justifyContent: 'space-between', marginTop: 14, flexWrap: 'wrap' }}>
                            <span className="tag">Pending version {emptyConfirm.nextVersion}</span>
                            <button className="btn primary" onClick={confirmEmptyReassessment} disabled={recording || emptyConfirm.typed.trim() !== emptyConfirm.nextVersion}>
                                {recording ? 'Recording…' : `Confirm ${emptyConfirm.nextVersion}`}
                            </button>
                        </div>
                    </>
                )}
            </AppDialog>
        </div>
    );
}
