import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import type { StepKey } from '../../types';
import { Field, HelpButton, confirmDelete } from '../common';
import { attackerForSlc, slcLevel, syncThreatFeasibility } from '../../lib/slc';
import { useDialogs } from '../../lib/useDialogs';

type GitWorkspace = {
    repoUrl: string;
    workBranch: string;
    baseBranch: string;
    subdir?: string;
    localPath: string;
};

type GitWorkspaceStatus = {
    configured?: boolean;
    ready?: boolean;
    branch?: string | null;
    expectedBranch?: string | null;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
    remoteExists?: boolean;
    onProtectedBranch?: boolean;
    reason?: string;
};

const COMMIT_STEP_KEYS: StepKey[] = ['project', 'assumptions', 'system', 'dfd', 'requirements', 'threats', 'attackTrees', 'countermeasures', 'defects'];

function parseDevOpsBranchUrl(raw: string): { repoUrl: string; workBranch?: string } | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        const repoMatch = url.pathname.match(/(.*?\/_git\/[^/?#]+)/);
        const repoUrl = repoMatch ? `${url.origin}${repoMatch[1]}` : value.split('?')[0];
        const version = url.searchParams.get('version') || '';
        const workBranch = version.startsWith('GB') ? decodeURIComponent(version.slice(2)) : '';
        return { repoUrl, workBranch: workBranch || undefined };
    } catch {
        return null;
    }
}

const DEPTH_HELP: Record<string, string> = {
    blackbox:
        'Model only external interfaces.',
    graybox:
        'Add the security-relevant internals.',
    whitebox:
        'Model the full internals, including firmware and debug access.',
};
const RISK_CRITERIA_INPUTS = [
    ['regulation', 'Regulation'],
    ['contracts', 'Contracts'],
    ['riskNature', 'Nature of risk'],
    ['users', 'Users'],
    ['productType', 'Product type'],
    ['stateOfTheArt', 'State of the art'],
] as const;
const MAX_PRODUCT_CONTEXT_ITEMS = 50;

/** Add/remove list of short free-text items shown as removable chips (type + Enter to add). */
function ScopeList({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
    const [draft, setDraft] = useState('');
    const add = () => {
        const v = draft.trim();
        setDraft('');
        if (v && !items.includes(v)) onChange([...items, v]);
    };
    return (
        <div>
            <div className="chips" style={{ minHeight: 26 }}>
                {items.length ? (
                    items.map((it, i) => (
                        <span className="chip on" key={i}>
                            {it}
                            <button className="chipx" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                                ✕
                            </button>
                        </span>
                    ))
                ) : (
                    <span className="hint">Nothing yet.</span>
                )}
            </div>
            <div className="inline" style={{ marginTop: 6 }}>
                <input
                    className="inp grow"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                            e.preventDefault();
                            add();
                        }
                    }}
                    placeholder={placeholder}
                />
                <button className="btn sm" disabled={!draft.trim()} onClick={add}>
                    + Add
                </button>
            </div>
        </div>
    );
}

export default function ProjectPanel() {
    const dialogs = useDialogs();
    const data = useStore((s) => s.data)!;
    const save = useStore((s) => s.save);
    const setView = useStore((s) => s.setView);
    const activeId = useStore((s) => s.activeId);
    const p = data.project;
    const slcAttacker = attackerForSlc(p.slTarget);
    const set = (patch: any) => save('project', { ...p, ...patch });
    const setDevice = (patch: any) => set({ device: { ...(p.device || {}), ...patch } });
    const setScope = (patch: any) => set({ scope: { ...(p.scope || {}), ...patch } });
    const setRepo = (patch: any) => set({ repo: { ...(p.repo || {}), ...patch } });
    const setSbom = (patch: any) => set({ sbom: { ...(p.sbom || {}), ...patch } });
    const setProductContext = (patch: any) => set({ productContext: { ...(p.productContext || {}), ...patch } });
    const setRiskCriteria = (patch: any) => set({ riskCriteria: { ...(p.riskCriteria || {}), ...patch } });
    const setRiskCriteriaInput = (key: string, value: string) => setRiskCriteria({ inputs: { ...(p.riskCriteria?.inputs || {}), [key]: value || undefined } });
    const productFunctions = p.productContext?.functions || [];
    const productEvidence = p.productContext?.evidence || [];
    const vulnerableGroups = p.productContext?.users?.vulnerableGroups || [];
    const setSlc = (level: number) => {
        const attacker = attackerForSlc(`SL-C ${level}`)!;
        save('project', { ...p, slTarget: `SL-C ${level}` });
        save('assumptions', { ...data.assumptions, attacker: [attacker] });
        save('threats', {
            threats: data.threats.threats.map((threat) =>
                syncThreatFeasibility({ ...threat, attackerRef: attacker.id }, attacker.capability),
            ),
        });
    };
    const ucDiagrams = data.useCases?.diagrams || [];
    const acceptedNotices = p.acceptedNotices || [];
    const includeUseCases = !!p.reportOptions?.includeUseCases;
    const ucNoticePending = ucDiagrams.length > 0 && !includeUseCases && !acceptedNotices.includes('usecases-excluded');
    const setIncludeUseCases = (v: boolean) =>
        set({
            reportOptions: { ...(p.reportOptions || {}), includeUseCases: v },
            acceptedNotices: v ? acceptedNotices.filter((k) => k !== 'usecases-excluded') : acceptedNotices,
        });
    const ackUseCaseNotice = () => set({ acceptedNotices: [...new Set([...acceptedNotices, 'usecases-excluded'])] });
    const [git, setGit] = useState('');
    const [gitWorkspace, setGitWorkspace] = useState<GitWorkspace | null>(null);
    const [gitStatus, setGitStatus] = useState<GitWorkspaceStatus | null>(null);
    const [repoUrl, setRepoUrl] = useState('');
    const [workBranch, setWorkBranch] = useState('');
    const [baseBranch, setBaseBranch] = useState('main');
    const [subdir, setSubdir] = useState('');
    const parsedProjectBranchUrl = parseDevOpsBranchUrl(p.repo?.projectBranchUrl || '');
    const effectiveRepoUrl = repoUrl || parsedProjectBranchUrl?.repoUrl || '';
    const effectiveWorkBranch = workBranch || parsedProjectBranchUrl?.workBranch || '';

    useEffect(() => {
        const parsed = parseDevOpsBranchUrl(p.repo?.projectBranchUrl || '');
        if (!parsed) return;
        if (parsed.repoUrl) setRepoUrl(parsed.repoUrl);
        if (parsed.workBranch) setWorkBranch(parsed.workBranch);
    }, [p.repo?.projectBranchUrl]);

    useEffect(() => {
        if (!activeId) return;
        let cancelled = false;
        fetch(`/api/projects/${activeId}/git/workspace`)
            .then((x) => x.json())
            .then((r) => {
                if (cancelled) return;
                if (r.workspace) {
                    setGitWorkspace(r.workspace);
                    setRepoUrl(r.workspace.repoUrl || '');
                    setWorkBranch(r.workspace.workBranch || '');
                    setBaseBranch(r.workspace.baseBranch || 'main');
                    setSubdir(r.workspace.subdir || '');
                } else {
                    const seed = String(p.title || activeId || 'tra-project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                    const parsed = parseDevOpsBranchUrl(p.repo?.projectBranchUrl || '');
                    setWorkBranch(parsed?.workBranch || `tra/${seed || 'project'}`);
                    setRepoUrl(parsed?.repoUrl || String(p.repo?.projectBranchUrl || '').trim());
                    setSubdir('');
                }
                setGitStatus(r.status || null);
            })
            .catch(() => {
                if (!cancelled) {
                    setGitWorkspace(null);
                    setGitStatus(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [activeId]);

    const flushProjectData = async () => {
        if (!activeId || !data) return false;
        setGit('Saving project data…');
        for (const step of COMMIT_STEP_KEYS) {
            const r = await fetch(`/api/projects/${activeId}/${step}`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify((data as any)[step]),
            }).catch(() => null);
            if (!r?.ok) {
                setGit(`Save failed before commit (${step}).`);
                return false;
            }
        }
        return true;
    };

    const ensureWorkspace = async () => {
        if (!activeId) return false;
        if (!effectiveRepoUrl || !effectiveWorkBranch || !baseBranch) {
            setGit('Add a DevOps branch link first.');
            return false;
        }
        setGit('Preparing git workspace…');
        const parsed = parseDevOpsBranchUrl(p.repo?.projectBranchUrl || '');
        const r = await fetch(`/api/projects/${activeId}/git/workspace`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectBranchUrl: p.repo?.projectBranchUrl || '', repoUrl: effectiveRepoUrl || parsed?.repoUrl || '', workBranch: effectiveWorkBranch || parsed?.workBranch || '', baseBranch, subdir }),
        })
            .then((x) => x.json())
            .catch(() => ({ ok: false, stderr: 'request failed' }));
        if (!r.ok) {
            setGit(`Setup failed: ${r.stderr || 'error'}`);
            return false;
        }
        setGitWorkspace(r.workspace || null);
        setGitStatus(r.status || null);
        return true;
    };

    const commit = async () => {
        if (!activeId) return;
        if (!(await flushProjectData())) return;
        if (!(await ensureWorkspace())) return;
        const msg = await dialogs.prompt({
            title: 'Commit project changes',
            label: 'Commit message',
            defaultValue: `TRA ${p.title || ''}`.trim(),
            validate: (value) => value ? null : 'Enter a commit message.',
        });
        if (msg === null) return;
        setGit('Committing project…');
        const r = await fetch(`/api/projects/${activeId}/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: msg, push: false }) })
            .then((x) => x.json())
            .catch(() => ({ ok: false, stderr: 'request failed' }));
        setGit(r.ok ? (r.committed ? `Local commit on ${r.branch}.` : r.note || 'Nothing to commit.') : `Commit failed: ${r.stderr || 'error'}`);
    };

    const commitAndPush = async () => {
        if (!activeId) return;
        if (!(await flushProjectData())) return;
        if (!(await ensureWorkspace())) return;
        const msg = await dialogs.prompt({
            title: 'Commit and push project changes',
            label: 'Commit message',
            defaultValue: `TRA ${p.title || ''}`.trim(),
            validate: (value) => value ? null : 'Enter a commit message.',
        });
        if (msg === null) return;
        setGit('Committing and pushing…');
        const r = await fetch(`/api/projects/${activeId}/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: msg, push: true }) })
            .then((x) => x.json())
            .catch(() => ({ ok: false, stderr: 'request failed' }));
        if (!r.ok) {
            setGit(`Commit/push failed: ${r.stderr || 'error'}`);
            return;
        }
        if (!r.pushOk) {
            setGit(`Push failed: ${r.stderr || r.pushOutput || 'error'}`);
            return;
        }
        const sha = r.remoteAfter || r.localSha || '';
        setGit(`${r.committed ? 'Pushed' : 'Already up to date'} ${sha ? sha.slice(0, 12) : ''} to ${r.branch}.`);
    };

    const prepareWorkspace = async () => {
        if (!activeId) return;
        if (await ensureWorkspace()) setGit(`Ready: ${effectiveWorkBranch}.`);
    };

    const refreshWorkspace = async () => {
        if (!activeId) return;
        const r = await fetch(`/api/projects/${activeId}/git/workspace`)
            .then((x) => x.json())
            .catch(() => ({ ok: false }));
        setGitWorkspace(r.workspace || null);
        setGitStatus(r.status || null);
    };

    const verifyDevOpsAccess = async () => {
        if (!activeId) return;
        setGit('Checking DevOps git access…');
        const r = await fetch(`/api/projects/${activeId}/git/workspace/verify`, { method: 'POST' })
            .then((x) => x.json())
            .catch(() => ({ ok: false, stderr: 'request failed' }));
        if (!r.ok) {
            setGit(`DevOps access check failed: ${r.stderr || 'error'}`);
            return;
        }
        setGit(`DevOps access OK: ${r.branch}.`);
    };

    return (
        <div className="panel">
            <div className="panelhead">
                <h1>Project</h1>
                <HelpButton title="Project &amp; scope (tips)">
                    <ul>
                        <li>State the <b>boundary in one sentence</b>. Everything outside it is an external entity.</li>
                        <li>Pick the <b>smallest modelling depth</b> that still answers the assessment question.</li>
                        <li><b>Group assets</b> sensibly (one “measurement integrity” asset, not one per value) and reuse template TRAs for similar devices.</li>
                        <li>CRA requires the <b>intended purpose</b> and the <b>reasonably foreseeable use</b> to be documented — fill them in below.</li>
                    </ul>
                </HelpButton>
            </div>
            <p className="lead">
                Define the device boundary and modeling depth.
            </p>

            <div className="card">
                <h3>Device under assessment</h3>
                <Field label="Project title">
                    <input value={p.title || ''} onChange={(e) => set({ title: e.target.value })} placeholder="TRA: …" />
                </Field>
                <div className="row">
                    <Field label="Device name">
                        <input value={p.device?.name || ''} onChange={(e) => setDevice({ name: e.target.value })} placeholder="RadarLevel RL-100" />
                    </Field>
                    <Field label="Device type">
                        <input value={p.device?.type || ''} onChange={(e) => setDevice({ type: e.target.value })} placeholder="radar level sensor" />
                    </Field>
                    <Field label="Version under assessment" hint="Hardware and firmware revision.">
                        <input value={p.device?.version || ''} onChange={(e) => setDevice({ version: e.target.value })} placeholder="FW 2.4 / HW B" />
                    </Field>
                </div>
            </div>

            <div className="card">
                <h3>Scope &amp; modelling depth</h3>
                <div className="row">
                    <Field
                        label="Modelling depth"
                    >
                        <select value={p.scope?.mode || 'graybox'} onChange={(e) => setScope({ mode: e.target.value })}>
                            <option value="blackbox">Black-box — external interfaces only</option>
                            <option value="graybox">Gray-box — key internal components</option>
                            <option value="whitebox">White-box — full internals</option>
                        </select>
                    </Field>
                    <Field label="Target Security Level" hint="Selects the managed threat-actor profile used for feasibility.">
                        <select value={slcLevel(p.slTarget) || ''} onChange={(e) => e.target.value && setSlc(Number(e.target.value))}>
                            <option value="">Select SL-C level</option>
                            {[1, 2, 3, 4].map((level) => <option key={level} value={level}>SL-C {level}</option>)}
                        </select>
                        {slcAttacker && (
                            <div className="card" style={{ marginTop: 8 }}>
                                <b>{slcAttacker.name}</b>
                                <p style={{ margin: '4px 0' }}>{slcAttacker.text}</p>
                                <p className="hint" style={{ margin: 0 }}>Capability {slcAttacker.capability} · Resources: {slcAttacker.resources} · Motivation: {slcAttacker.motivation}</p>
                            </div>
                        )}
                    </Field>
                    <Field label="Status">
                        <select value={p.status || 'draft'} onChange={(e) => set({ status: e.target.value })}>
                            {['draft', 'in-progress', 'review', 'released'].map((o) => (
                                <option key={o}>{o}</option>
                            ))}
                        </select>
                    </Field>
                </div>
                <p className="depthnote">{DEPTH_HELP[p.scope?.mode || 'graybox']}</p>
                <p className="hint" style={{ margin: '2px 0 8px' }}>
                    Rigorous mode and the residual-risk threshold are in <b>⚙ Settings</b>.
                </p>
                <Field
                    label="System boundary"
                    hint="One sentence: what is included, and where does it end?"
                >
                    <textarea
                        value={p.scope?.boundary || ''}
                        onChange={(e) => setScope({ boundary: e.target.value })}
                        placeholder="The sensor enclosure and all its interfaces; the plant DCS and engineering laptop are external entities."
                    />
                </Field>
                <div className="grid2">
                    <Field label="In scope" hint="Type an item and press Enter.">
                        <ScopeList items={p.scope?.inScope || []} onChange={(v) => setScope({ inScope: v })} placeholder="e.g. sensor firmware" />
                    </Field>
                    <Field label="Out of scope" hint="Type an item and press Enter.">
                        <ScopeList items={p.scope?.outOfScope || []} onChange={(v) => setScope({ outOfScope: v })} placeholder="e.g. plant DCS" />
                    </Field>
                </div>
            </div>

            <div className="card">
                <h3>Scenarios & diagrams</h3>
                <p className="hint" style={{ marginTop: 0 }}>
                    Model use cases, misuse cases and scenario-specific data flows in a dedicated editor.
                </p>
                <button className="btn sm" onClick={() => setView('useCases')}>
                    Open scenario editor
                </button>
                <Field label="Report inclusion" style={{ marginTop: 10 }} hint="Off by default — scenario diagrams are supporting material, not part of the TRA chain.">
                    <label className="check">
                        <input type="checkbox" checked={includeUseCases} onChange={(e) => setIncludeUseCases(e.target.checked)} /> Include scenario diagrams in report
                    </label>
                </Field>
                {ucNoticePending && (
                    <div className="notice-box" style={{ marginTop: 8 }}>
                        <b>Notice:</b> {ucDiagrams.length} scenario diagram{ucDiagrams.length === 1 ? '' : 's'} exist but {ucDiagrams.length === 1 ? 'is' : 'are'} excluded from the report.
                        <div style={{ marginTop: 6 }}>
                            <button className="btn sm" onClick={ackUseCaseNotice}>
                                Acknowledge intentional exclusion
                            </button>
                        </div>
                    </div>
                )}
                <div style={{ marginTop: 10 }}>
                    <label>Use-case diagrams</label>
                    {ucDiagrams.length ? (
                        <ul className="hint" style={{ margin: '4px 0 0 18px' }}>
                            {ucDiagrams.map((d) => (
                                <li key={d.id}>{d.name || d.id}</li>
                            ))}
                        </ul>
                    ) : (
                        <p className="hint">No use-case diagrams yet.</p>
                    )}
                </div>
            </div>

            <div className="card">
                <h3>Software Bill of Materials (SBOM)</h3>
                <p className="hint" style={{ marginTop: 0 }}>
                    In-tool SBOMs use component metadata from the System step.
                </p>
                <div className="row">
                    <Field label="SBOM source">
                        <select value={p.sbom?.mode || 'in-tool'} onChange={(e) => setSbom({ mode: e.target.value })}>
                            <option value="in-tool">Generate in-tool from component metadata</option>
                            <option value="external">External — link to an existing SBOM</option>
                        </select>
                    </Field>
                    {(p.sbom?.mode || 'in-tool') === 'in-tool' ? (
                        <Field label="Format">
                            <select value={p.sbom?.format || 'cyclonedx'} onChange={(e) => setSbom({ format: e.target.value })}>
                                <option value="cyclonedx">CycloneDX (JSON)</option>
                                <option value="spdx">SPDX 2.3 (JSON)</option>
                            </select>
                        </Field>
                    ) : (
                        <Field label="External SBOM URL" hint="Used instead of an in-tool SBOM.">
                            <input value={p.sbom?.url || ''} onChange={(e) => setSbom({ url: e.target.value })} placeholder="https://…/device-sbom.cdx.json" />
                        </Field>
                    )}
                </div>
            </div>

            <div className="card">
                <h3>Intended purpose &amp; reasonably foreseeable use <span className="hint">(CRA)</span></h3>
                <Field label="Intended purpose" hint="The manufacturer's intended purpose and operating conditions of the product.">
                    <textarea
                        value={p.intendedUse || ''}
                        onChange={(e) => set({ intendedUse: e.target.value })}
                        placeholder="Continuous, non-contact level measurement of liquids in fixed process tanks; may drive an overfill-protection function."
                    />
                </Field>
                <div className="field">
                    <label>
                        Reasonably foreseeable use <span className="hint">one scenario per box</span>
                    </label>
                    <div className="list">
                        {(p.foreseeableUse || []).map((m, i) => (
                            <div className="inline" key={i} style={{ gap: 6, alignItems: 'flex-start' }}>
                                <textarea
                                    className="inp grow"
                                    value={m}
                                    onChange={(e) => {
                                        const next = [...(p.foreseeableUse || [])];
                                        next[i] = e.target.value;
                                        set({ foreseeableUse: next });
                                    }}
                                    placeholder="e.g. Bluetooth commissioning left enabled with the default passcode in production"
                                />
                                <button
                                    className="btn sm danger"
                                    title="Remove scenario"
                                    aria-label="Remove use scenario"
                                    onClick={async () => { if (await confirmDelete('this use scenario')) set({ foreseeableUse: (p.foreseeableUse || []).filter((_, j) => j !== i) }); }}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                        {!(p.foreseeableUse || []).length && <p className="hint">No scenarios yet.</p>}
                    </div>
                    <button className="btn sm" style={{ marginTop: 6 }} onClick={() => set({ foreseeableUse: [...(p.foreseeableUse || []), ''] })}>
                        + Add scenario
                    </button>
                </div>
            </div>

            <div className="card">
                <h3>Product context</h3>
                {productFunctions.map((item, index) => (
                    <fieldset className="product-context-item" key={`function-${index}`}>
                        <legend>Function {index + 1}</legend>
                        <Field label="Name">
                            <input maxLength={200} value={item.name || ''} onChange={(e) => setProductContext({ functions: productFunctions.map((current, i) => i === index ? { ...current, name: e.target.value } : current) })} />
                        </Field>
                        <Field label="Description">
                            <textarea rows={2} maxLength={2000} value={item.description || ''} onChange={(e) => setProductContext({ functions: productFunctions.map((current, i) => i === index ? { ...current, description: e.target.value || undefined } : current) })} />
                        </Field>
                        <button type="button" className="btn sm danger" aria-label={`Remove product function ${index + 1}`} onClick={() => setProductContext({ functions: productFunctions.filter((_, i) => i !== index) })}>
                            Remove function
                        </button>
                    </fieldset>
                ))}
                <button type="button" className="btn sm" disabled={productFunctions.length >= MAX_PRODUCT_CONTEXT_ITEMS} aria-label={`Add product function ${productFunctions.length + 1}`} onClick={() => setProductContext({ functions: [...productFunctions, { name: '' }] })}>
                    Add function
                </button>

                <Field label="Users">
                    <textarea rows={3} maxLength={2000} value={p.productContext?.users?.description || ''} onChange={(e) => setProductContext({ users: { ...(p.productContext?.users || {}), description: e.target.value || undefined } })} />
                </Field>
                <Field label="Vulnerable groups">
                    <div className="product-context-list">
                        {vulnerableGroups.map((group, index) => (
                            <div className="inline" key={`group-${index}`}>
                                <input className="inp grow" maxLength={200} aria-label={`Vulnerable group ${index + 1}`} value={group} onChange={(e) => setProductContext({ users: { ...(p.productContext?.users || {}), vulnerableGroups: vulnerableGroups.map((current, i) => i === index ? e.target.value : current) } })} />
                                <button type="button" className="btn sm danger" aria-label={`Remove vulnerable group ${index + 1}`} onClick={() => setProductContext({ users: { ...(p.productContext?.users || {}), vulnerableGroups: vulnerableGroups.filter((_, i) => i !== index) } })}>
                                    Remove
                                </button>
                            </div>
                        ))}
                    </div>
                    <button type="button" className="btn sm" style={{ marginTop: 6 }} disabled={vulnerableGroups.length >= MAX_PRODUCT_CONTEXT_ITEMS} aria-label={`Add vulnerable group ${vulnerableGroups.length + 1}`} onClick={() => setProductContext({ users: { ...(p.productContext?.users || {}), vulnerableGroups: [...vulnerableGroups, ''] } })}>
                        Add vulnerable group
                    </button>
                </Field>

                {productEvidence.map((item, index) => (
                    <fieldset className="product-context-item" key={`evidence-${index}`}>
                        <legend>Evidence {index + 1}</legend>
                        <div className="grid2">
                            <Field label="Title">
                                <input maxLength={200} value={item.title || ''} onChange={(e) => setProductContext({ evidence: productEvidence.map((current, i) => i === index ? { ...current, title: e.target.value } : current) })} />
                            </Field>
                            <Field label="Reference" hint="HTTP(S) URL or project-relative path.">
                                <input maxLength={2000} value={item.ref || ''} onChange={(e) => setProductContext({ evidence: productEvidence.map((current, i) => i === index ? { ...current, ref: e.target.value } : current) })} />
                            </Field>
                        </div>
                        <Field label="Clause">
                            <input maxLength={200} value={item.clause || ''} onChange={(e) => setProductContext({ evidence: productEvidence.map((current, i) => i === index ? { ...current, clause: e.target.value || undefined } : current) })} />
                        </Field>
                        <button type="button" className="btn sm danger" aria-label={`Remove evidence ${index + 1}`} onClick={() => setProductContext({ evidence: productEvidence.filter((_, i) => i !== index) })}>
                            Remove evidence
                        </button>
                    </fieldset>
                ))}
                <button type="button" className="btn sm" style={{ marginTop: 8 }} disabled={productEvidence.length >= MAX_PRODUCT_CONTEXT_ITEMS} aria-label={`Add evidence ${productEvidence.length + 1}`} onClick={() => setProductContext({ evidence: [...productEvidence, { title: '', ref: '' }] })}>
                    Add evidence
                </button>
            </div>

            <div className="card">
                <h3>Project repository</h3>
                <Field label="DevOps branch / PR link">
                    <input value={p.repo?.projectBranchUrl || ''} onChange={(e) => setRepo({ projectBranchUrl: e.target.value })} placeholder="https://devops.vega.com/tfs/VEGA/Entwicklung/_git/EmbedRisk-TestProject?path=%2F&version=GBdocs%2Ftest-infrastructure&_a=contents" />
                </Field>
                <div className="inline">
                    <button className="btn sm" onClick={commit} disabled={!activeId || !effectiveRepoUrl || !effectiveWorkBranch}>
                        Commit locally
                    </button>
                    <button className="btn sm primary" onClick={commitAndPush} disabled={!activeId || !effectiveRepoUrl || !effectiveWorkBranch}>
                        Commit + push
                    </button>
                </div>
                <div className="inline" style={{ marginTop: 2 }}>
                    {effectiveWorkBranch && <span className="hint">Branch: <code>{effectiveWorkBranch}</code></span>}
                    {gitStatus?.remoteExists !== undefined && <span className="hint">Remote: {gitStatus.remoteExists ? 'ready' : 'new branch'}</span>}
                </div>
                <details style={{ marginTop: 10 }}>
                    <summary className="hint" style={{ cursor: 'pointer' }}>Advanced git settings</summary>
                    <div className="row">
                        <Field label="Repository URL">
                            <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://git.invalid/_git/project" />
                        </Field>
                        <Field label="Work branch">
                            <input value={workBranch} onChange={(e) => setWorkBranch(e.target.value)} placeholder="docs/test-infrastructure" />
                        </Field>
                    </div>
                    <div className="row">
                        <Field label="Base branch">
                            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
                        </Field>
                        <Field label="Repo subdirectory">
                            <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="security/tra/my-device" />
                        </Field>
                    </div>
                    <div className="inline">
                        <button className="btn sm" onClick={verifyDevOpsAccess} disabled={!gitStatus?.configured}>
                            Verify access
                        </button>
                        <button className="btn sm" onClick={prepareWorkspace} disabled={!activeId || !effectiveRepoUrl || !effectiveWorkBranch || !baseBranch}>Prepare</button>
                        <button className="btn sm" onClick={refreshWorkspace} disabled={!activeId}>Refresh</button>
                    </div>
                    {gitWorkspace && (
                        <p className="hint"><code>{gitWorkspace.localPath}</code></p>
                    )}
                    {gitStatus && (
                        <p className="hint">
                            {gitStatus.configured ? (gitStatus.ready ? 'Ready' : gitStatus.reason || 'Not ready') : 'Not configured'}
                            {gitStatus.branch ? ` | current: ${gitStatus.branch}` : ''}
                            {typeof gitStatus.ahead === 'number' && typeof gitStatus.behind === 'number' ? ` | ahead/behind: ${gitStatus.ahead}/${gitStatus.behind}` : ''}
                            {gitStatus.onProtectedBranch ? ' | protected branch' : ''}
                        </p>
                    )}
                </details>
                {git && <p className="hint" style={{ marginTop: 4 }}>{git}</p>}
            </div>

        </div>
    );
}
