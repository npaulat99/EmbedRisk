// Guided, deterministic risk rating: Bug Bar impact (max of C/I/A/Safety) and a likelihood
// decomposed into Exposure × Exploitability, with CVSS as an optional exploitability hint and
// one-click seeding from the linked attacker profile / interface. Risk then reads
// Exposure × Exploitability × Impact, kept on the familiar 5×5 matrix.
import { useStore } from '../../state/store';
import { createRiskEngine, exposureFromInterface } from '../../lib/risk';
import { cvssBaseScore } from '../../lib/cvss';
import { accessProbability, ACCESS_OPTS, COST_FACTOR_LEVELS, COST_FACTORS, likelihoodFromProb, stepProb } from '../../lib/attackTree';
import { ACTOR_LEVELS, actorLevelLabel, actorLevelOption, normalizeActorLevel } from '@shared/attackerScale.js';
import CriteriaRater from '../CriteriaRater';
import type { Threat } from '../../types';

type GuidedRiskModel = Pick<Threat, 'attackerRef' | 'interfaceRef' | 'interfaceRefs' | 'impactDimensions' | 'likelihoodFactors' | 'likelihoodCriteria' | 'impactCriteria' | 'cvss' | 'ratedBy' | 'ratedAt' | 'requiredSkill' | 'requiredAccess' | 'costFactors' | 'costRationales' | 'costLikelihood' | 'costLikelihoodProposal' | 'status'> & {
    likelihood?: number;
    impact?: number;
    residualLikelihood?: number;
    residualImpact?: number;
};

function CostRiskCalculator({ t, upd, schemeThresholds }: { t: GuidedRiskModel; upd: (patch: any) => void; schemeThresholds?: Record<string, number> }) {
    const attacker = useStore((s) => s.data?.assumptions.attacker?.[0]);
    const weights = useStore((s) => s.data?.project.costFactorWeights);
    const accessProbabilities = useStore((s) => s.data?.project.accessProbabilities);
    const projectThresholds = useStore((s) => s.data?.project.likelihoodProbabilityThresholds);
    const likelihoodThresholds = { ...(schemeThresholds || {}), ...(projectThresholds || {}) };
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
    return (
        <div className="calc">
            <div className="calchead">Cost-based likelihood <span className="muted">weighted attack difficulty and required access</span></div>
            <div className="grid4">
                <label className="minifield"><span>Required capability (threat actor)</span><select className="inp" style={{ width: '100%', maxWidth: '100%', textOverflow: 'ellipsis' }} value={skill} onChange={(e) => update({ requiredSkill: Number(e.target.value) })}>{ACTOR_LEVELS.map(({ level }) => <option key={level} value={level}>{actorLevelOption(level)}</option>)}</select><span className="hint">{ACTOR_LEVELS.find((l) => l.level === skill)?.description}</span></label>
                <label className="minifield"><span>Required access</span><select className="inp" value={access} onChange={(e) => update({ requiredAccess: Number(e.target.value) })}>{ACCESS_OPTS.map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}</select></label>
                <div className="minifield"><span>Calculated vector probability</span><b>{(probability * 100).toFixed(1)}%</b></div>
                <div className="minifield"><span>Proposed matrix likelihood</span><b>L{proposal} · {proposal === 1 ? 'Very low' : proposal === 2 ? 'Low' : proposal === 3 ? 'Moderate' : proposal === 4 ? 'High' : proposal === 5 ? 'Very high' : 'None'}</b>
                    {t.likelihood !== proposal && <button className="btn sm" type="button" style={{ marginTop: 4 }} onClick={() => update({})}>Apply likelihood</button>}
                </div>
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
    const scheme = useStore((s) => s.scheme);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const engine = createRiskEngine(scheme);
    const likelihoodAxis = engine.scheme.likelihood;
    const impactAxis = engine.scheme.impact;
    const dims = t.impactDimensions || {};
    const fac = t.likelihoodFactors || {};
    const likelihoodCriteria = t.likelihoodCriteria || {};
    const impactCriteria = t.impactCriteria || {};
    const cvss = t.cvss || {};
    const attackers = useStore((s) => s.data?.assumptions.attacker || []);
    const interfaces = useStore((s) => s.data?.system.interfaces || []);
    const attacker = attackers.find((a) => a.id === t.attackerRef);
    const scoringMethod = likelihoodAxis.derivation.kind;
    const primaryInterface = t.interfaceRefs?.[0] || t.interfaceRef;
    const iface = interfaces.find((i) => i.id === primaryInterface);
    const today = new Date().toISOString().slice(0, 10);

    const setCriterion = (axis: 'likelihood' | 'impact', id: string, value: number | null) => {
        const isLikelihood = axis === 'likelihood';
        const current = isLikelihood ? (Object.keys(likelihoodCriteria).length ? likelihoodCriteria : fac) : (Object.keys(impactCriteria).length ? impactCriteria : dims);
        const next = { ...current, [id]: value };
        const candidate = isLikelihood
            ? { ...t, likelihoodCriteria: next }
            : { ...t, impactCriteria: next };
        const derived = isLikelihood ? engine.deriveLikelihood(candidate) : engine.deriveImpact(candidate);
        const patch: any = {
            [isLikelihood ? 'likelihoodCriteria' : 'impactCriteria']: next,
            [isLikelihood ? likelihoodField : impactField]: derived ?? undefined,
            ratedAt: today,
        };
        if (isLikelihood && (id === 'exposure' || id === 'exploitability')) patch.likelihoodFactors = next;
        if (!isLikelihood && ['confidentiality', 'integrity', 'availability', 'safety'].includes(id)) patch.impactDimensions = next;
        upd(patch);
    };
    const setFac = (k: string, v: number) => {
        const f = { ...fac, [k]: v };
        const criteria = { ...likelihoodCriteria, [k]: v };
        const derived = engine.deriveLikelihood({ ...t, likelihoodFactors: f, likelihoodCriteria: criteria });
        upd({ likelihoodFactors: f, likelihoodCriteria: criteria, [likelihoodField]: derived ?? undefined, ratedAt: today });
    };
    const seed = () => {
        const exp = exposureFromInterface(iface?.exposure);
        if (typeof exp !== 'number') return;
        setFac('exposure', exp);
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
    const derivedL = engine.deriveLikelihood(t);
    const derivedI = engine.deriveImpact(t);
    const storedLikelihood = (t as any)[likelihoodField];
    const storedImpact = (t as any)[impactField];
    const invalidLikelihood = typeof storedLikelihood === 'number' && storedLikelihood !== 0 && !engine.inRange('likelihood', storedLikelihood);
    const invalidImpact = typeof storedImpact === 'number' && storedImpact !== 0 && !engine.inRange('impact', storedImpact);
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

    if (schemeWarning) {
        return <div className="settings-error-banner" role="alert">{schemeWarning} Risk fields are read-only. Stored values: L {t[likelihoodField] ?? '—'} / I {t[impactField] ?? '—'}.</div>;
    }

    return (
        <>
            <div className="calc">
                <div className="calchead">
                    Impact <span className="muted">— {impactAxis.derivation.kind === 'criteria-max' ? 'highest assessed criterion determines the level' : 'set the impact level'}</span>
                </div>
                {impactAxis.criteria.length ? (
                    <CriteriaRater
                        criteria={impactAxis.criteria}
                        levels={impactAxis.levels}
                        values={(Object.keys(impactCriteria).length ? impactCriteria : dims) as Record<string, number | null | undefined>}
                        onChange={(id, value) => setCriterion('impact', id, value)}
                    />
                ) : (
                    <label className="minifield"><span>Impact level</span><select className="inp" value={impact || ''} onChange={(e) => upd({ [impactField]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                        <option value="">Not rated</option>
                        {impactAxis.levels.map((level: any) => <option key={level.value} value={level.value}>{level.code} · {level.label}</option>)}
                    </select></label>
                )}
            </div>

            {scoringMethod === 'cost-based' ? (
                <>
                    <CostRiskCalculator t={t} upd={upd} schemeThresholds={likelihoodAxis.derivation.probabilityThresholds} />
                    <div className="calc">{ratedByRow}</div>
                </>
            ) : (
                <div className="calc">
                    <div className="calcgrid2">
                        <div>
                            <div className="calchead">
                                Likelihood <span className="muted">— {likelihoodAxis.derivation.kind === 'geometric-mean' ? 'geometric mean of criteria' : likelihoodAxis.derivation.kind === 'criteria-max' ? 'highest assessed criterion' : 'set the likelihood level'}</span>
                                {iface && likelihoodAxis.criteria.some((criterion: any) => criterion.id === 'exposure') && (
                                    <button type="button" className="btn sm ghost" style={{ marginLeft: 6 }} onClick={seed} title="Seed exposure from the linked interface's exposure class">
                                        seed exposure from interface
                                    </button>
                                )}
                            </div>
                            {likelihoodAxis.criteria.length ? (
                                <CriteriaRater
                                    criteria={likelihoodAxis.criteria}
                                    levels={likelihoodAxis.levels}
                                    values={(Object.keys(likelihoodCriteria).length ? likelihoodCriteria : fac) as Record<string, number | null | undefined>}
                                    onChange={(id, value) => setCriterion('likelihood', id, value)}
                                />
                            ) : (
                                <label className="minifield"><span>Likelihood level</span><select className="inp" value={likelihood || ''} onChange={(e) => upd({ [likelihoodField]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                                    <option value="">Not rated</option>
                                    {likelihoodAxis.levels.map((level: any) => <option key={level.value} value={level.value}>{level.code} · {level.label}</option>)}
                                </select></label>
                            )}
                        </div>

                        {likelihoodAxis.criteria.some((criterion: any) => criterion.id === 'exploitability') && <div>
                            <div className="calchead">CVSS <span className="muted">— optional, informs exploitability (v3.1 &amp; v4.0)</span></div>
                            <div className="grid3">
                                <label className="minifield">
                                    <span>Version</span>
                                    <select className="inp" value={cvssVer} onChange={(e) => {
                                        const version = e.target.value;
                                        const baseScore = cvss.vector ? cvssBaseScore(cvss.vector, version) : cvss.baseScore;
                                        upd({ cvss: { ...cvss, version, baseScore: baseScore ?? undefined } });
                                    }}>
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
                                    <input className={'inp' + (vecBad ? ' invalid' : '')} value={cvss.vector || ''} placeholder={cvssVer === '4.0' ? 'CVSS:4.0/AV:N/AC:L/AT:N/…' : 'CVSS:3.1/AV:N/AC:L/…'} onChange={(e) => {
                                        const vector = e.target.value;
                                        const baseScore = vector ? cvssBaseScore(vector, cvssVer) : cvss.baseScore;
                                        upd({ cvss: { ...cvss, vector, baseScore: baseScore ?? undefined } });
                                    }} />
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
                        </div>}
                    </div>
                    <p className="hint">
                        Derived → likelihood <b>{derivedL ?? likelihood}</b>, impact <b>{derivedI ?? impact}</b>.{' '}
                        {overridden ? (
                            <span className="warnmark">stored axis ratings differ from the criteria-derived values.</span>
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
                    {(invalidLikelihood || invalidImpact) && <p className="hint warnmark" role="alert">Stored {invalidLikelihood ? `likelihood ${storedLikelihood}` : ''}{invalidLikelihood && invalidImpact ? ' and ' : ''}{invalidImpact ? `impact ${storedImpact}` : ''} is outside the active scheme's range.</p>}
                    {ratedByRow}
                </div>
            )}
        </>
    );
}
