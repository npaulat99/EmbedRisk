// Client-side mirror of the deterministic risk engine so risk badges update instantly
// as the user edits, without a server round-trip. Bands fall back to the canonical
// scheme until the live scheme is fetched.
import type { Component, Countermeasure, Objectives, RiskBand, RiskScheme, RiskSchemeV2, Threat } from '../types';
import '@shared/riskEngine.js';

type RiskEngine = {
    scheme: any;
    likelihoodLevels(): { value: number; code: string; label: string }[];
    impactLevels(): { value: number; code: string; label: string }[];
    bands(): RiskBand[];
    band(score: number): RiskBand;
    classify(likelihood: number, impact: number): { id: string; label: string; rank: number; color: string };
    isHighOrAbove(level: string | number | { rank: number }): boolean;
    inRange(axis: 'likelihood' | 'impact', value: number): boolean;
    residual(threat: Threat, cms: Countermeasure[]): [number, number];
    riskOf(threat: Threat, cms: Countermeasure[]): { initial: number; residual: number; residualLikelihood: number; residualImpact: number };
    deriveImpact(threat: { impact?: number; impactCriteria?: Record<string, number | null>; impactDimensions?: Objectives }): number | null;
    deriveLikelihood(threat: { likelihood?: number; likelihoodCriteria?: Record<string, number | null>; likelihoodFactors?: { exposure?: number; exploitability?: number } }): number | null;
};

const engineCache = new WeakMap<object, RiskEngine>();
function engineOf(scheme: RiskScheme | null): RiskEngine {
    const api = (globalThis as any).RiskEngine;
    if (!api) throw new Error('Risk engine script was not loaded.');
    const key = scheme && typeof scheme === 'object' ? scheme as object : null;
    if (key && engineCache.has(key)) return engineCache.get(key)!;
    const engine = api.createRiskEngine(scheme || {});
    if (key) engineCache.set(key, engine);
    return engine;
}

export function createRiskEngine(scheme: RiskScheme | null): RiskEngine {
    return engineOf(scheme);
}

export function legacyRiskSchemeRegistry(legacyScheme: RiskScheme): {
    schemes: RiskSchemeV2[];
    fingerprints: Record<string, string>;
    errors: { file: string; message: string }[];
} {
    const api = (globalThis as any).RiskEngine;
    const engines = (['cost-based', 'exposure-exploitability-impact'] as const).map((riskScoringMethod) =>
        api.createRiskEngine(legacyScheme, { riskScoringMethod }));
    return {
        schemes: engines.map((engine) => engine.scheme as RiskSchemeV2),
        fingerprints: Object.fromEntries(engines.map((engine) => [engine.scheme.id, engine.fingerprint])),
        errors: [],
    };
}

export function schemeForProject(project: { riskSchemeId?: string; riskScoringMethod?: string; riskSchemeFingerprint?: string }, schemes: RiskSchemeV2[], fingerprints: Record<string, string>) {
    const id = project.riskSchemeId || (project.riskScoringMethod === 'exposure-exploitability-impact' ? 'builtin:5x5-exposure' : 'builtin:5x5-cost');
    const scheme = schemes.find((item) => item.id === id);
    if (!scheme) return { scheme: null, schemeWarning: `Risk scheme '${id}' is unavailable. Risk ratings are read-only.` };
    if (project.riskSchemeFingerprint && project.riskSchemeFingerprint !== fingerprints[id])
        return { scheme: null, schemeWarning: `Risk scheme '${id}' has changed since this project was assessed. Risk ratings are read-only.` };
    return { scheme, schemeWarning: null };
}

export function bandForRisk(likelihood: number, impact: number, scheme: RiskScheme | null): RiskBand {
    const engine = engineOf(scheme);
    return riskBand(engine, likelihood, impact, likelihood * impact);
}

function riskBand(engine: RiskEngine, likelihood: number, impact: number, score: number): RiskBand {
    if (score <= 0) return NONE_BAND;
    if (engine.scheme.classification.kind === 'product-bands') return engine.band(score);
    const level = engine.classify(likelihood, impact);
    return level.id === 'none'
        ? NONE_BAND
        : { name: level.label, min: level.rank, max: level.rank, color: level.color, lookup: true };
}

/**
 * A component and all of its descendants (transitive children via `parent`). Selecting a
 * parent component in the DFD therefore rolls up the risk of every sub-component it contains
 * (e.g. the RL-100 Sensor aggregates the MCU, BT stack, HART modem and config store).
 */
export function descendantComponentIds(components: Component[], rootId: string): Set<string> {
    const childrenByParent = new Map<string | null, string[]>();
    for (const c of components) {
        const p = c.parent ?? null;
        (childrenByParent.get(p) || childrenByParent.set(p, []).get(p)!).push(c.id);
    }
    const ids = new Set<string>([rootId]);
    const stack = [rootId];
    while (stack.length) {
        const cur = stack.pop()!;
        for (const child of childrenByParent.get(cur) || []) {
            if (!ids.has(child)) {
                ids.add(child);
                stack.push(child);
            }
        }
    }
    return ids;
}

export const DEFAULT_BANDS: RiskBand[] = [
    { name: 'Low', min: 1, max: 5, color: '#2e7d32' },
    { name: 'Medium', min: 6, max: 11, color: '#f9a825' },
    { name: 'High', min: 12, max: 19, color: '#ef6c00' },
    { name: 'Critical', min: 20, max: 25, color: '#c62828' },
];

/** A zero likelihood or impact means the threat is not possible — risk 0, its own band. */
export const NONE_BAND: RiskBand = { name: 'None', min: 0, max: 0, color: '#6b7280' };

export function bandsOf(scheme: RiskScheme | null): RiskBand[] {
    return engineOf(scheme).bands();
}

export function band(score: number, scheme: RiskScheme | null): RiskBand {
    return engineOf(scheme).band(score);
}

/** Residual [likelihood, impact] for a threat across all selected countermeasure links. */
export function residual(threat: Threat, cms: Countermeasure[]): [number, number] {
    return engineOf(null).residual(threat, cms);
}

export interface ThreatRisk {
    initial: number;
    initialBand: RiskBand;
    residual: number;
    residualBand: RiskBand;
    residualLikelihood: number;
    residualImpact: number;
}

export function riskOf(threat: Threat, cms: Countermeasure[], scheme: RiskScheme | null): ThreatRisk {
    const engine = engineOf(scheme);
    const risk = engine.riskOf(threat, cms);
    const initialBand = riskBand(engine, threat.likelihood, threat.impact, risk.initial);
    const residualBand = riskBand(engine, risk.residualLikelihood, risk.residualImpact, risk.residual);
    // Lookup schemes have no product score; the level rank is the priority used for sorting.
    return {
        ...risk,
        initial: initialBand.lookup ? initialBand.min : risk.initial,
        residual: residualBand.lookup ? residualBand.min : risk.residual,
        initialBand,
        residualBand,
    };
}

/** Bug Bar: impact is the worst plausible dimension (max of C/I/A/Safety). */
export function deriveImpact(d?: Objectives): number | null {
    return engineOf(null).deriveImpact({ impactDimensions: d });
}

/**
 * Likelihood as a decomposition of the (too coarse) single likelihood into **Exposure ×
 * Exploitability**, keeping the familiar 5×5 matrix (likelihood is remapped to 1-5, then
 * Risk = Likelihood × Impact). Both factors are 1-5 with higher = more likely; they are combined
 * with a **geometric mean** (√(exposure·exploitability)) and mapped onto the 1-5 likelihood axis.
 * The geometric mean keeps the diagonal linear (3×3 → 3, 5×5 → 5) and spreads the levels, unlike
 * dividing the raw product by 5 which is bottom-heavy (12/25 cells collapse to 1). The likelihood
 * stays objectively decomposable (better inter-rater reliability). Control maturity is deliberately
 * excluded here — controls act on the *residual*, not the inherent likelihood (avoids double-counting).
 */
export function deriveLikelihood(f?: { exposure?: number; exploitability?: number }): number | null {
    return engineOf(null).deriveLikelihood({ likelihoodFactors: f });
}

/**
 * Attack-surface exposure (1-5, higher = more reachable) implied by an interface's exposure class.
 * Aligned with the RiskCalculator's Exposure scale: 1 Physical · 2 Local · 3 Adjacent/fieldbus ·
 * 4 Remote (authenticated) · 5 Remote (unauthenticated). An interface flagged only "remote" maps
 * to 4 (authenticated); raise it to 5 manually if it is reachable unauthenticated.
 */
export function exposureFromInterface(exposure?: string): number | undefined {
    switch (exposure) {
        case 'remote':
            return 4;
        case 'adjacent':
            return 3;
        case 'local':
            return 2;
        case 'physical':
            return 1;
        default:
            return undefined;
    }
}
