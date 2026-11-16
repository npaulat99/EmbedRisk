// Guided, deterministic risk rating: Bug Bar impact (max of C/I/A/Safety) and a likelihood
// decomposed into Exposure × Exploitability, with CVSS as an optional exploitability hint and
// one-click seeding from the linked attacker profile / interface. Risk then reads
// Exposure × Exploitability × Impact, kept on the familiar 5×5 matrix.
import { useEffect } from 'react';
import { useStore } from '../../state/store';
import { deriveImpact, deriveLikelihood, exposureFromInterface } from '../../lib/risk';
import { cvssBaseScore } from '../../lib/cvss';
import { accessProbability, ACCESS_OPTS, COST_FACTOR_LEVELS, COST_FACTORS, likelihoodFromProb, stepProb } from '../../lib/attackTree';
import { ACTOR_LEVELS, actorLevelLabel, actorLevelOption, normalizeActorLevel } from '@shared/attackerScale.js';
import BugBarImpactSelector from '../BugBarImpactSelector';
import type { Threat } from '../../types';

type GuidedRiskModel = Pick<Threat, 'attackerRef' | 'interfaceRef' | 'interfaceRefs' | 'impactDimensions' | 'likelihoodFactors' | 'cvss' | 'ratedBy' | 'ratedAt' | 'requiredSkill' | 'requiredAccess' | 'costFactors' | 'costRationales' | 'costLikelihood' | 'costLikelihoodProposal' | 'status'> & {
    likelihood?: number;
    impact?: number;
    residualLikelihood?: number;
    residualImpact?: number;
};

function CostRiskCalculator({ t, upd }: { t: GuidedRiskModel; upd: (patch: any) => void }) {
    const attacker = useStore((s) => s.data?.assumptions.attacker?.[0]);
    const weights = useStore((s) => s.data?.project.costFactorWeights);
    const accessProbabilities = useStore((s) => s.data?.project.accessProbabilities);
    const likelihoodThresholds = useStore((s) => s.data?.project.likelihoodProbabilityThresholds);
    const factors = t.costFactors || {};
    const rationales = t.costRationales || {};
    const access = t.requiredAccess || 3;
    const skill = normalizeActorLevel(t.requiredSkill || 1) as number;
    const feasible = !attacker || skill <= (normalizeActorLevel(attacker.capability) as number);
    const costProbability = stepProb(factors, weights);
    const probability = feasible ? accessProbability(access, accessProbabilities) * costProbability : 0;
    const proposal = likelihoodFromProb(probability, likelihoodThresholds);
    const update = (patch: Partial<Threat>) => {
        const nextFactors = patch.costFactors ?? factors;
        const nextSkill = patch.requiredSkill ?? skill;
        const nextAccess = patch.requiredAccess ?? access;
        const status = attacker && (normalizeActorLevel(nextSkill) as number) > (normalizeActorLevel(attacker.capability) as number) ? 'unfeasible' : t.status === 'unfeasible' ? 'open' : t.status;
        const nextCostProbability = stepProb(nextFactors, weights);
        const nextProbability = status === 'unfeasible' ? 0 : accessProbability(nextAccess, accessProbabilities) * nextCostProbability;
        const nextProposal = likelihoodFromProb(nextProbability, likelihoodThresholds);
        upd({ ...patch, status, costLikelihood: nextProbability, costLikelihoodProposal: nextProposal, likelihood: nextProposal });
    };
    useEffect(() => {
        const proposal = likelihoodFromProb(probability, likelihoodThresholds);
        if (t.likelihood === proposal && Math.abs((t.costLikelihood ?? -1) - probability) < 0.000001 && t.costLikelihoodProposal === proposal) return;
        upd({ costLikelihood: probability, costLikelihoodProposal: proposal, likelihood: proposal });
    }, [probability, likelihoodThresholds, t.likelihood, t.costLikelihood, t.costLikelihoodProposal, upd]);
    return (
        <div className="calc">
            <div className="calchead">Cost-based likelihood <span className="muted">weighted attack difficulty and required access</span></div>
            <div className="grid4">
                <label className="minifield"><span>Required capability (threat actor)</span><select className="inp" style={{ width: '100%', maxWidth: '100%', textOverflow: 'ellipsis' }} value={skill} onChange={(e) => update({ requiredSkill: Number(e.target.value) })}>{ACTOR_LEVELS.map(({ level }) => <option key={level} value={level}>{actorLevelOption(level)}</option>)}</select><span className="hint">{ACTOR_LEVELS.find((l) => l.level === skill)?.description}</span></label>
                <label className="minifield"><span>Required access</span><select className="inp" value={access} onChange={(e) => update({ requiredAccess: Number(e.target.value) })}>{ACCESS_OPTS.map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}</select></label>
                <div className="minifield"><span>Calculated vector probability</span><b>{(probability * 100).toFixed(1)}%</b></div>
                <div className="minifield"><span>Proposed matrix likelihood</span><b>L{proposal} · {proposal === 1 ? 'Very low' : proposal === 2 ? 'Low' : proposal === 3 ? 'Moderate' : proposal === 4 ? 'High' : proposal === 5 ? 'Very high' : 'None'}</b></div>
            </div>
            <div className="costgrid" style={{ marginTop: 10 }}>
                {COST_FACTORS.map((factor) => (
                    <div key={factor.k} className="minifield">
                        <label><span>{factor.label}</span><select className="inp" value={(factors as any)[factor.k] ?? 3} onChange={(e) => update({ costFactors: { ...factors, [factor.k]: Number(e.target.value) } })}>{COST_FACTOR_LEVELS[factor.k].map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}</select></label>
                        <textarea className="inp" rows={2} style={{ marginTop: 4 }} value={(rationales as any)[factor.k] || ''} placeholder="Assessment reason" onChange={(e) => update({ costRationales: { ...rationales, [factor.k]: e.target.value } })} />
                    </div>
                ))}
            </div>
            {!feasible && <p className="hint warnmark">Required capability exceeds the selected SL-C attacker ({attacker?.name}, {actorLevelLabel(attacker?.capability ?? 0)}); this threat is marked unfeasible.</p>}
        </div>
    );
}

const LFACTORS: { k: 'exposure' | 'exploitability'; label: string; hint: string; opts: [number, string][] }[] = [
    { k: 'exposure', label: 'Exposure', hint: 'how reachable the attack surface is', opts: [[1, 'Physical (open enclosure)'], [2, 'Local (on site)'], [3, 'Adjacent / fieldbus'], [4, 'Remote (authenticated)'], [5, 'Remote (unauthenticated)']] },
    { k: 'exploitability', label: 'Exploitability', hint: 'how easy to exploit once reached', opts: [[1, 'Very hard (nation-state)'], [2, 'Hard (specialist)'], [3, 'Moderate'], [4, 'Easy'], [5, 'Trivial / automated']] },
];

/** Detect the CVSS version from a vector's prefix (e.g. "CVSS:4.0/…"), else the stored version. */
function detectCvssVersion(vector?: string, fallback?: string): string | undefined {
    const m = vector ? /^CVSS:(\d+\.\d+)\//.exec(vector.trim()) : null;
    return m ? m[1] : fallback;
}

/** Rough 1-5 exploitability from the CVSS vector's exploitability-side metrics (AC/AT/PR/UI) — NOT
 * the base score, which double-counts the impact sub-score. Supports CVSS v3.0/3.1 (AC/PR/UI) and
 * v4.0 (adds Attack Requirements AT and re-defines UI as N/P/A). Falls back to a coarse base proxy. */
function cvssExploitability(vector?: string, base?: number, version?: string): number | null {
    const ver = detectCvssVersion(vector, version);
    if (vector) {
        const m = (k: string) => new RegExp(`/${k}:([A-Z])`).exec(vector)?.[1];
        const ac = m('AC');
        const pr = m('PR');
        const ui = m('UI');
        const at = m('AT'); // v4.0 Attack Requirements
        if (ac || pr || ui || at) {
            let s = 3;
            if (ac === 'L') s += 1;
            else if (ac === 'H') s -= 1;
            if (pr === 'N') s += 1;
            else if (pr === 'H') s -= 1;
            if (ver === '4.0') {
                if (ui === 'N') s += 0.5; // None easiest; Passive/Active harder
                else if (ui === 'A') s -= 0.5;
                if (at === 'P') s -= 0.5; // Attack Requirements present -> harder
            } else {
                if (ui === 'N') s += 0.5;
                else if (ui === 'R') s -= 0.5;
            }
            return Math.max(1, Math.min(5, Math.round(s)));
        }
    }
    if (typeof base === 'number') return Math.max(1, Math.min(5, Math.round(base / 2)));
    return null;
}

export default function RiskCalculator({
    t,
    upd,
    likelihoodField = 'likelihood',
    impactField = 'impact',
}: {
    t: GuidedRiskModel;
    upd: (patch: any) => void;
    likelihoodField?: 'likelihood' | 'residualLikelihood';
    impactField?: 'impact' | 'residualImpact';
}) {
    const likelihood = Number((t as any)[likelihoodField] ?? 0);
    const impact = Number((t as any)[impactField] ?? 0);
    const dims = t.impactDimensions || {};
    const fac = t.likelihoodFactors || {};
    const cvss = t.cvss || {};
    const attackers = useStore((s) => s.data?.assumptions.attacker || []);
    const interfaces = useStore((s) => s.data?.system.interfaces || []);
    const attacker = attackers.find((a) => a.id === t.attackerRef);
    const scoringMethod = useStore((s) => s.data?.project.riskScoringMethod || 'cost-based');
    const primaryInterface = t.interfaceRefs?.[0] || t.interfaceRef;
    const iface = interfaces.find((i) => i.id === primaryInterface);
    const today = new Date().toISOString().slice(0, 10);

    const setDim = (k: string, v: number | undefined) => {
        const d: any = { ...dims };
        if (v == null) delete d[k];
        else d[k] = v;
        upd({ impactDimensions: d, [impactField]: deriveImpact(d) ?? 0, ratedAt: today });
    };
    const setFac = (k: string, v: number) => {
        const f = { ...fac, [k]: v };
        upd({ likelihoodFactors: f, [likelihoodField]: deriveLikelihood(f) ?? likelihood, ratedAt: today });
    };
    const seed = () => {
        const exp = exposureFromInterface(iface?.exposure);
        if (typeof exp !== 'number') return;
        const f = { ...fac, exposure: exp }; // exposure = attack-surface reachability of the entry interface
        upd({ likelihoodFactors: f, [likelihoodField]: deriveLikelihood(f) ?? likelihood, ratedAt: today });
    };
    // Prefer CVSS exploitability metrics over the base score (which double-counts impact).
    const suggestExp = cvssExploitability(cvss.vector, cvss.baseScore, cvss.version);
    const cvssVer = cvss.version || detectCvssVersion(cvss.vector) || '3.1';
    const vecVer = detectCvssVersion(cvss.vector);
    const vecBad = !!cvss.vector && !/^CVSS:(3\.[01]|4\.0)\//.test(cvss.vector.trim());
    const vecMismatch = !!cvss.vector && !!vecVer && !vecBad && cvssVer !== vecVer;
    const hasVector = !!cvss.vector && cvss.vector.trim().length > 0;
    // With a vector present, the Base Score is CALCULATED from it (read-only) so the two can never
    // disagree; the field is only editable when there is no vector.
    const computedBase = hasVector && !vecBad ? cvssBaseScore(cvss.vector, cvssVer) : null;
    useEffect(() => {
        if (hasVector && computedBase != null && cvss.baseScore !== computedBase) {
            upd({ cvss: { ...cvss, baseScore: computedBase } });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasVector, computedBase]);
    const derivedL = deriveLikelihood(fac);
    const derivedI = deriveImpact(dims);
    const overridden = (derivedL != null && derivedL !== likelihood) || (derivedI != null && derivedI !== impact);
    const capGate = attacker && typeof attacker.capability === 'number' && typeof fac.exploitability === 'number' && (normalizeActorLevel(attacker.capability) as number) + fac.exploitability < 6;

    const ratedByRow = (
        <div className="inline" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <label className="minifield" style={{ width: 160 }}>
                <span>Rated by</span>
                <input className="inp" value={t.ratedBy || ''} placeholder="name / initials" onChange={(e) => upd({ ratedBy: e.target.value, ratedAt: today })} />
            </label>
            {t.ratedAt && <span className="hint">last rated {t.ratedAt}</span>}
        </div>
    );

    return (
        <>
            <div className="calc">
                <div className="calchead">
                    Bug Bar impact <span className="muted">— impact = worst dimension; click the scenario that applies in each column</span>
                </div>
                <BugBarImpactSelector dims={dims} onSelect={setDim} />
            </div>

            {scoringMethod === 'cost-based' ? (
                <>
                    <CostRiskCalculator t={t} upd={upd} />
                    <div className="calc">{ratedByRow}</div>
                </>
            ) : (
                <div className="calc">
                    <div className="calcgrid2">
                        <div>
                            <div className="calchead">
                                Likelihood <span className="muted">— Exposure × Exploitability</span>
                                {iface && (
                                    <button type="button" className="btn sm ghost" style={{ marginLeft: 6 }} onClick={seed} title="Seed exposure from the linked interface's exposure class">
                                        seed exposure from interface
                                    </button>
                                )}
                            </div>
                            <div className="grid2">
                                {LFACTORS.map((f) => (
                                    <label key={f.k} className="minifield">
                                        <span title={f.hint}>{f.label}</span>
                                        <select className="inp" value={(fac as any)[f.k] ?? ''} onChange={(e) => setFac(f.k, Number(e.target.value))}>
                                            <option value="">–</option>
                                            {f.opts.map(([v, lab]) => (
                                                <option key={v} value={v}>{v} · {lab}</option>
                                            ))}
                                        </select>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div>
                            <div className="calchead">CVSS <span className="muted">— optional, informs exploitability (v3.1 &amp; v4.0)</span></div>
                            <div className="grid3">
                                <label className="minifield">
                                    <span>Version</span>
                                    <select className="inp" value={cvssVer} onChange={(e) => upd({ cvss: { ...cvss, version: e.target.value } })}>
                                        <option value="3.1">3.1</option>
                                        <option value="4.0">4.0</option>
                                    </select>
                                </label>
                                <label className="minifield">
                                    <span>Base score (0–10){hasVector ? ' — calculated' : ''}</span>
                                    <input
                                        className="inp"
                                        type="number"
                                        min={0}
                                        max={10}
                                        step={0.1}
                                        value={hasVector ? (computedBase ?? '') : (cvss.baseScore ?? '')}
                                        readOnly={hasVector}
                                        title={hasVector ? 'Calculated from the vector — clear the vector box to enter a score manually.' : 'Enter a base score, or paste a vector to calculate it automatically.'}
                                        style={hasVector ? { background: 'var(--surface-2)', cursor: 'not-allowed' } : undefined}
                                        onChange={(e) => {
                                            if (hasVector) return;
                                            upd({ cvss: { ...cvss, baseScore: e.target.value === '' ? undefined : Number(e.target.value) } });
                                        }}
                                    />
                                </label>
                                <label className="minifield">
                                    <span>Vector</span>
                                    <input className={'inp' + (vecBad ? ' invalid' : '')} value={cvss.vector || ''} placeholder={cvssVer === '4.0' ? 'CVSS:4.0/AV:N/AC:L/AT:N/…' : 'CVSS:3.1/AV:N/AC:L/…'} onChange={(e) => upd({ cvss: { ...cvss, vector: e.target.value } })} />
                                </label>
                            </div>
                            {vecBad && <p className="hint warnmark">Unrecognised vector — expected a CVSS:3.1 or CVSS:4.0 prefix.</p>}
                            {vecMismatch && <p className="hint warnmark">Vector is {vecVer} but version is set to {cvssVer}.</p>}
                            {hasVector && !vecBad && computedBase == null && <p className="hint warnmark">Vector is incomplete — add the base metrics to calculate the score.</p>}
                            {suggestExp && (
                                <p className="hint">
                                    Suggested exploitability ≈ <b>{suggestExp}</b>{' '}
                                    <button className="btn sm" style={{ padding: '0 7px' }} onClick={() => setFac('exploitability', suggestExp)}>
                                        apply
                                    </button>
                                </p>
                            )}
                        </div>
                    </div>
                    <p className="hint">
                        Derived → likelihood <b>{derivedL ?? likelihood}</b>, impact <b>{derivedI ?? impact}</b>.{' '}
                        {overridden ? (
                            <span className="warnmark">stored risk uses likelihood {likelihood} × impact {impact}.</span>
                        ) : (
                            'These drive the risk above; you can still override the numbers directly.'
                        )}
                        {capGate && (
                            <>
                                {' '}
                                <span className="warnmark">likelihood may be over-stated based on the linked attacker's capability.</span>
                            </>
                        )}
                    </p>
                    {ratedByRow}
                </div>
            )}
        </>
    );
}
