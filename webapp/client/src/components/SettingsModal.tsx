// Project settings dialog (opened from the gear button). Groups project-level configuration that
// is not TRA content: the acceptable residual-risk threshold (used by the plausibility checker),
// the rigorous-assessment mode, and report-content toggles.
import { useEffect } from 'react';
import { useStore } from '../state/store';
import { DEFAULT_ACCEPTABLE_RISK } from '../types';
import { Field } from './common';
import { accessProbability, costWeightTotal, COST_FACTORS, DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS, likelihoodFromProb, stepProb } from '../lib/attackTree';
import { deriveImpact } from '../lib/risk';
import { normalizeActorLevel } from '@shared/attackerScale.js';

export default function SettingsModal() {
    const data = useStore((s) => s.data);
    const save = useStore((s) => s.save);
    const open = useStore((s) => s.settingsOpen);
    const setOpen = useStore((s) => s.openSettings);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, setOpen]);

    if (!open || !data) return null;
    const p = data.project;
    const set = (patch: any) => save('project', { ...p, ...patch });
    const setReport = (patch: any) => set({ reportOptions: { ...(p.reportOptions || {}), ...patch } });
    const acceptable = typeof p.acceptableRisk === 'number' ? p.acceptableRisk : DEFAULT_ACCEPTABLE_RISK;
    const weightTotal = costWeightTotal(p.costFactorWeights);
    const weightsInvalid = Math.abs(weightTotal - 1) > 0.000001;
    const syncCostLikelihoods = (nextWeights = p.costFactorWeights, nextAccessProbabilities = p.accessProbabilities, nextThresholds = p.likelihoodProbabilityThresholds) => {
        const attacker = data.assumptions.attacker?.[0];
        save('threats', {
            threats: data.threats.threats.map((threat) => {
                const unfeasible = !!attacker && typeof threat.requiredSkill === 'number' && (normalizeActorLevel(threat.requiredSkill) as number) > (normalizeActorLevel(attacker.capability) as number);
                const probability = unfeasible ? 0 : accessProbability(threat.requiredAccess ?? 3, nextAccessProbabilities) * stepProb(threat.costFactors, nextWeights);
                const impact = deriveImpact(threat.impactDimensions) ?? threat.impact ?? 0;
                const proposal = likelihoodFromProb(probability, nextThresholds);
                return {
                    ...threat,
                    status: unfeasible ? 'unfeasible' : threat.status === 'unfeasible' ? 'open' : threat.status,
                    likelihood: proposal,
                    impact,
                    costLikelihood: probability,
                    costLikelihoodProposal: proposal,
                };
            }),
        });
    };
    const setScoringMethod = (method: string) => {
        set({ riskScoringMethod: method });
        if (method === 'cost-based') syncCostLikelihoods();
    };
    const setWeight = (key: string, value: number) => {
        const otherWeights = { ...(p.costFactorWeights || {}), [key]: 0 };
        const maxForWeight = Math.max(0, 1 - costWeightTotal(otherWeights));
        const nextWeights = { ...(p.costFactorWeights || {}), [key]: Math.min(Math.max(0, value || 0), maxForWeight) };
        set({ costFactorWeights: nextWeights });
        syncCostLikelihoods(nextWeights);
    };
    const restoreDefaultWeights = () => {
        const defaultWeights = Object.fromEntries(COST_FACTORS.map((factor) => [factor.k, factor.weight]));
        set({ costFactorWeights: defaultWeights });
        syncCostLikelihoods(defaultWeights);
    };
    const setAccessProbability = (level: 1 | 2 | 3 | 4 | 5, value: number) => {
        const nextAccessProbabilities = { ...(p.accessProbabilities || {}), [level]: Math.max(0.05, Math.min(1, value || 0.05)) };
        set({ accessProbabilities: nextAccessProbabilities });
        syncCostLikelihoods(p.costFactorWeights, nextAccessProbabilities);
    };
    const setLikelihoodThreshold = (level: 2 | 3 | 4 | 5, value: number) => {
        const nextThresholds = { ...(p.likelihoodProbabilityThresholds || {}), [level]: Math.max(0.01, Math.min(1, value || 0.01)) };
        set({ likelihoodProbabilityThresholds: nextThresholds });
        syncCostLikelihoods(p.costFactorWeights, p.accessProbabilities, nextThresholds);
    };
    const restoreDefaultLikelihoodThresholds = () => {
        set({ likelihoodProbabilityThresholds: DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS });
        syncCostLikelihoods(p.costFactorWeights, p.accessProbabilities, DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS);
    };

    return (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Project settings" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
                <div className="modalhead">
                    <h3 style={{ margin: 0 }}>⚙ Project settings</h3>
                    <button className="btn sm" aria-label="Close" onClick={() => setOpen(false)}>
                        ✕ Close
                    </button>
                </div>

                <div className="card" style={{ marginBottom: 12 }}>
                    <h3 style={{ marginTop: 0 }}>Risk scoring</h3>
                    <Field label="Scoring method">
                        <select value={p.riskScoringMethod || 'cost-based'} onChange={(e) => setScoringMethod(e.target.value)}>
                            <option value="exposure-exploitability-impact">Exposure x Exploitability x Impact</option>
                            <option value="cost-based">Cost-based</option>
                        </select>
                    </Field>
                    {p.riskScoringMethod === 'cost-based' && (
                        <>
                            <p className="hint">Configured weight total: {weightTotal.toFixed(2)}. Weights must combine to 1.00.</p>
                            {weightsInvalid && <div className="settings-error-banner" role="alert">Cost-factor weights currently total {weightTotal.toFixed(2)}. Set the combined weight to exactly 1.00 before assessing threats.</div>}
                            <div className="settings-weight-grid">
                                {COST_FACTORS.map((factor) => (
                                    <Field key={factor.k} label={factor.label}>
                                        <input
                                            className="inp"
                                            type="number"
                                            min={0}
                                            max={Math.max(0, 1 - costWeightTotal({ ...(p.costFactorWeights || {}), [factor.k]: 0 })).toFixed(2)}
                                            step={0.05}
                                            value={p.costFactorWeights?.[factor.k] ?? factor.weight}
                                            onChange={(e) => setWeight(factor.k, Math.max(0, Number(e.target.value) || 0))}
                                        />
                                    </Field>
                                ))}
                                <div className="settings-weight-restore">
                                    <button className="btn sm" type="button" onClick={restoreDefaultWeights}>
                                        Restore defaults
                                    </button>
                                </div>
                            </div>
                            <h4 style={{ margin: '14px 0 6px' }}>Access probabilities</h4>
                            <p className="hint">Probability of obtaining each required access level. Values must be from 0.05 to 1.00.</p>
                            <div className="settings-weight-grid">
                                {[
                                    [1, 'Remote unauthenticated', 0.9],
                                    [2, 'Remote authenticated', 0.7],
                                    [3, 'Adjacent / fieldbus', 0.5],
                                    [4, 'Local on site', 0.3],
                                    [5, 'Physical / enclosure', 0.1],
                                ].map(([level, label, fallback]) => (
                                    <Field key={level} label={`${level} · ${label}`}>
                                        <input className="inp" type="number" min={0.05} max={1} step={0.05} value={p.accessProbabilities?.[level as 1 | 2 | 3 | 4 | 5] ?? fallback} onChange={(e) => setAccessProbability(level as 1 | 2 | 3 | 4 | 5, Number(e.target.value))} />
                                    </Field>
                                ))}
                            </div>
                            <h4 style={{ margin: '14px 0 6px' }}>Likelihood probability thresholds</h4>
                            <p className="hint">Lower probability bound for each matrix likelihood. L1 covers positive probabilities below L2; 0% is L0.</p>
                            <div className="settings-weight-grid">
                                {([2, 3, 4, 5] as const).map((level) => (
                                    <Field key={level} label={`L${level} or higher`}>
                                        <input className="inp" type="number" min={0.01} max={1} step={0.05} value={p.likelihoodProbabilityThresholds?.[level] ?? DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS[level]} onChange={(e) => setLikelihoodThreshold(level, Number(e.target.value))} />
                                    </Field>
                                ))}
                                <div className="settings-weight-restore"><button className="btn sm" type="button" onClick={restoreDefaultLikelihoodThresholds}>Restore defaults</button></div>
                            </div>
                        </>
                    )}
                </div>

                <div className="card" style={{ marginBottom: 12 }}>
                    <h3 style={{ marginTop: 0 }}>Risk acceptance</h3>
                    <Field
                        label="Acceptable residual risk"
                        hint="Warnings appear above this residual-risk threshold. Default: 12."
                    >
                        <input
                            className="inp"
                            type="number"
                            min={0}
                            max={25}
                            style={{ width: 100 }}
                            value={acceptable}
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                set({ acceptableRisk: Number.isFinite(v) ? Math.max(0, Math.min(25, v)) : DEFAULT_ACCEPTABLE_RISK });
                            }}
                        />
                    </Field>
                </div>

                <div className="card" style={{ marginBottom: 12 }}>
                    <h3 style={{ marginTop: 0 }}>Assessment rigor</h3>
                    <label className="inline" style={{ gap: 7, margin: 0, alignItems: 'flex-start' }}>
                        <input type="checkbox" checked={!!p.rigorousMode} onChange={(e) => set({ rigorousMode: e.target.checked })} style={{ marginTop: 3 }} />
                        <span className="hint">
                            <b>Rigorous mode</b> requires Bug Bar dimensions, exposure/exploitability, and a named rater on every threat.
                        </span>
                    </label>
                </div>

                <div className="card">
                    <h3 style={{ marginTop: 0 }}>Report content</h3>
                    <label className="inline" style={{ gap: 7, margin: 0, alignItems: 'flex-start' }}>
                        <input
                            type="checkbox"
                            checked={!!p.reportOptions?.includeStrideBoundaryAnalysis}
                            onChange={(e) => setReport({ includeStrideBoundaryAnalysis: e.target.checked })}
                            style={{ marginTop: 3 }}
                        />
                        <span className="hint">
                            Include <b>STRIDE-per-trust-boundary</b> tables.
                        </span>
                    </label>
                </div>
            </div>
        </div>
    );
}
