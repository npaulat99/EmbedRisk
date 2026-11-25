// Project settings dialog (opened from the gear button). Groups project-level configuration that
// is not TRA content: the acceptable residual-risk threshold (used by the plausibility checker),
// the rigorous-assessment mode, and report-content toggles.
import { useStore } from '../state/store';
import { DEFAULT_ACCEPTABLE_RISK } from '../types';
import { Field } from './common';
import { accessProbability, costWeightTotal, COST_FACTORS, DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS, likelihoodFromProb, stepProb } from '../lib/attackTree';
import { createRiskEngine, deriveImpact } from '../lib/risk';
import { normalizeActorLevel } from '@shared/attackerScale.js';
import AppDialog from './AppDialog';
import { useDialogs } from '../lib/useDialogs';

const RISK_CRITERIA_INPUTS = [
    ['regulation', 'Regulation'],
    ['contracts', 'Contracts'],
    ['riskNature', 'Nature of risk'],
    ['users', 'Users'],
    ['productType', 'Product type'],
    ['stateOfTheArt', 'State of the art'],
] as const;

export default function SettingsModal() {
    const data = useStore((s) => s.data);
    const save = useStore((s) => s.save);
    const scheme = useStore((s) => s.scheme);
    const schemes = useStore((s) => s.riskSchemes);
    const fingerprints = useStore((s) => s.riskSchemeFingerprints);
    const schemeWarning = useStore((s) => s.schemeWarning);
    const open = useStore((s) => s.settingsOpen);
    const setOpen = useStore((s) => s.openSettings);
    const theme = useStore((s) => s.theme);
    const setTheme = useStore((s) => s.setTheme);
    const dialogs = useDialogs();

    if (!data) return null;
    const p = data.project;
    const set = (patch: any) => save('project', { ...p, ...patch });
    const setReport = (patch: any) => set({ reportOptions: { ...(p.reportOptions || {}), ...patch } });
    const setRiskCriteria = (patch: any) => set({ riskCriteria: { ...(p.riskCriteria || {}), ...patch } });
    const setRiskCriteriaInput = (key: string, value: string) => setRiskCriteria({ inputs: { ...(p.riskCriteria?.inputs || {}), [key]: value || undefined } });
    const acceptable = typeof p.acceptableRisk === 'number' ? p.acceptableRisk : DEFAULT_ACCEPTABLE_RISK;
    const activeScheme = scheme && 'schemaVersion' in scheme ? scheme : null;
    const activeSchemeId = p.riskSchemeId || (p.riskScoringMethod === 'exposure-exploitability-impact' ? 'builtin:5x5-exposure' : 'builtin:5x5-cost');
    const maxRisk = activeScheme ? activeScheme.likelihood.levels.length * activeScheme.impact.levels.length : 25;
    const rankLevels = activeScheme?.classification.levels || [];
    const schemeThresholds = activeScheme?.likelihood.derivation.kind === 'cost-based' ? activeScheme.likelihood.derivation.probabilityThresholds : undefined;
    const effectiveThresholds = { ...(schemeThresholds || {}), ...(p.likelihoodProbabilityThresholds || {}) };
    const costBasedScheme = activeScheme?.likelihood.derivation.kind === 'cost-based' || (!activeScheme && p.riskScoringMethod === 'cost-based');
    const weightTotal = costWeightTotal(p.costFactorWeights);
    const weightsInvalid = Math.abs(weightTotal - 1) > 0.000001;
    const syncCostLikelihoods = (nextWeights = p.costFactorWeights, nextAccessProbabilities = p.accessProbabilities, nextThresholds = effectiveThresholds) => {
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
    const setRiskScheme = async (id: string) => {
        const nextScheme = schemes.find((item) => item.id === id);
        if (!nextScheme) return;
        const currentId = p.riskSchemeId || (p.riskScoringMethod === 'exposure-exploitability-impact' ? 'builtin:5x5-exposure' : 'builtin:5x5-cost');
        if (id === currentId && !schemeWarning) return;
        const ratedThreats = data.threats.threats.filter((threat) => typeof threat.likelihood === 'number' || typeof threat.impact === 'number'
            || Object.values(threat.likelihoodCriteria || {}).some((value) => typeof value === 'number')
            || Object.values(threat.impactCriteria || {}).some((value) => typeof value === 'number'));
        if (ratedThreats.length && !(await dialogs.confirm({
            title: 'Switch risk scheme?',
            message: `Switch risk scheme to "${nextScheme.title}"? Invalid ratings will be cleared. Affected threats:\n\n${ratedThreats.map((threat) => `${threat.id} · ${threat.title}`).join('\n')}`,
            confirmLabel: 'Switch scheme',
            danger: true,
        }))) return;

        const engine = createRiskEngine(nextScheme);
        let threatsChanged = false;
        const nextThreats = data.threats.threats.map((threat) => {
            const next: any = { ...threat };
            if (typeof threat.likelihood === 'number' && !(threat.status === 'unfeasible' && threat.likelihood === 0) && !engine.inRange('likelihood', threat.likelihood)) {
                next.likelihood = undefined;
                next.likelihoodCriteria = undefined;
                threatsChanged = true;
            } else if (threat.likelihoodCriteria) {
                const validIds = new Set(nextScheme.likelihood.criteria.map((criterion) => criterion.id));
                const criteria = Object.fromEntries(Object.entries(threat.likelihoodCriteria).map(([key, value]) => [key,
                    validIds.has(key) && (value == null || engine.inRange('likelihood', value)) ? value : null]));
                if (JSON.stringify(criteria) !== JSON.stringify(threat.likelihoodCriteria)) {
                    next.likelihoodCriteria = criteria;
                    threatsChanged = true;
                }
            }
            if (typeof threat.impact === 'number' && !engine.inRange('impact', threat.impact)) {
                next.impact = undefined;
                next.impactCriteria = undefined;
                threatsChanged = true;
            } else if (threat.impactCriteria) {
                const validIds = new Set(nextScheme.impact.criteria.map((criterion) => criterion.id));
                const criteria = Object.fromEntries(Object.entries(threat.impactCriteria).map(([key, value]) => [key,
                    validIds.has(key) && (value == null || engine.inRange('impact', value)) ? value : null]));
                if (JSON.stringify(criteria) !== JSON.stringify(threat.impactCriteria)) {
                    next.impactCriteria = criteria;
                    threatsChanged = true;
                }
            }
            return next;
        });
        let countermeasuresChanged = false;
        const nextCountermeasures = data.countermeasures.countermeasures.map((cm) => ({
            ...cm,
            addresses: (cm.addresses || []).map((address) => {
                const next: any = { ...address };
                if (typeof address.residualLikelihood === 'number' && address.residualLikelihood !== 0 && !engine.inRange('likelihood', address.residualLikelihood)) {
                    next.residualLikelihood = undefined;
                    countermeasuresChanged = true;
                }
                if (typeof address.residualImpact === 'number' && address.residualImpact !== 0 && !engine.inRange('impact', address.residualImpact)) {
                    next.residualImpact = undefined;
                    countermeasuresChanged = true;
                }
                return next;
            }),
        }));
        const compatibilityMethod = id === 'builtin:5x5-cost' ? 'cost-based' : id === 'builtin:5x5-exposure' ? 'exposure-exploitability-impact' : p.riskScoringMethod;
        set({ riskSchemeId: id, riskSchemeFingerprint: fingerprints[id], ...(compatibilityMethod ? { riskScoringMethod: compatibilityMethod } : {}) });
        if (threatsChanged) save('threats', { threats: nextThreats });
        if (countermeasuresChanged) save('countermeasures', { countermeasures: nextCountermeasures });
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
        const nextThresholds = { ...effectiveThresholds, [level]: Math.max(0.01, Math.min(1, value || 0.01)) };
        set({ likelihoodProbabilityThresholds: nextThresholds });
        syncCostLikelihoods(p.costFactorWeights, p.accessProbabilities, nextThresholds);
    };
    const restoreDefaultLikelihoodThresholds = () => {
        const defaults = schemeThresholds || DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS;
        set({ likelihoodProbabilityThresholds: defaults });
        syncCostLikelihoods(p.costFactorWeights, p.accessProbabilities, defaults);
    };

    return (
        <AppDialog open={open} onClose={() => setOpen(false)} title="Project settings" dismissOnBackdrop={false}>
            <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Appearance</h3>
                <Field label="Color scheme">
                    <select value={theme} onChange={(event) => setTheme(event.target.value as 'system' | 'light' | 'dark')}>
                        <option value="system">Use system setting</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                    </select>
                </Field>
            </div>
            <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Risk scoring</h3>
                {schemeWarning && <div className="settings-error-banner" role="alert">{schemeWarning}</div>}
                <Field label="Risk scheme">
                    <select value={activeSchemeId} onChange={(e) => setRiskScheme(e.target.value)}>
                        {!schemes.some((item) => item.id === activeSchemeId) && <option value={activeSchemeId}>Unavailable scheme · {activeSchemeId}</option>}
                        {schemes.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>)}
                    </select>
                </Field>
                {activeScheme?.description && <p className="hint">{activeScheme.description}</p>}
                {costBasedScheme && (
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
                                    <input className="inp" type="number" min={0.01} max={1} step={0.05} value={effectiveThresholds[level] ?? DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS[level]} onChange={(e) => setLikelihoodThreshold(level, Number(e.target.value))} />
                                </Field>
                            ))}
                            <div className="settings-weight-restore"><button className="btn sm" type="button" onClick={restoreDefaultLikelihoodThresholds}>Restore defaults</button></div>
                        </div>
                    </>
                )}
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Risk acceptance</h3>
                <Field label="Acceptable risk level">
                    <select className="inp" value={p.acceptableLevel || activeScheme?.acceptance?.defaultLevel || ''} onChange={(e) => set({ acceptableLevel: e.target.value || undefined })}>
                        <option value="">Use scheme default</option>
                        {rankLevels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
                    </select>
                </Field>
                {activeScheme?.classification.kind === 'product-bands' && <Field
                    label="Acceptable risk score"
                    hint="Numeric threshold retained for product-band schemes."
                >
                    <input
                        className="inp"
                        type="number"
                        min={0}
                        max={maxRisk}
                        style={{ width: 100 }}
                        value={acceptable}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            set({ acceptableRisk: Number.isFinite(v) ? Math.max(0, Math.min(maxRisk, v)) : DEFAULT_ACCEPTABLE_RISK });
                        }}
                    />
                </Field>}
                <fieldset className="risk-criteria-group">
                    <legend>Risk scheme justification</legend>
                    <Field label="Why this scheme and acceptance criteria?">
                        <textarea rows={3} maxLength={2000} value={p.riskCriteria?.schemeJustification || ''} onChange={(e) => setRiskCriteria({ schemeJustification: e.target.value || undefined })} />
                    </Field>
                    <Field label="Source or reference">
                        <input maxLength={200} value={p.riskCriteria?.schemeSource || ''} onChange={(e) => setRiskCriteria({ schemeSource: e.target.value || undefined })} />
                    </Field>
                    <div className="grid2">
                        {RISK_CRITERIA_INPUTS.map(([key, label]) => (
                            <Field key={key} label={label}>
                                <input maxLength={200} value={p.riskCriteria?.inputs?.[key] || ''} onChange={(e) => setRiskCriteriaInput(key, e.target.value)} />
                            </Field>
                        ))}
                    </div>
                </fieldset>
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
        </AppDialog>
    );
}
