// Deterministic risk engine: Risk = Likelihood x Impact (5x5), banded, with residual
// risk derived from the minimum residual L/I across all countermeasure links for a threat.
import { promises as fs } from 'node:fs';
import { riskSchemePath } from './paths.js';
import '../../shared/riskEngine.js';

let scheme = null;
const engineCache = new WeakMap();
function engineOf(value) {
    const key = value && typeof value === 'object' ? value : null;
    if (key && engineCache.has(key)) return engineCache.get(key);
    const engine = globalThis.RiskEngine.createRiskEngine(value || {});
    if (key) engineCache.set(key, engine);
    return engine;
}

export async function loadScheme() {
    if (!scheme) scheme = JSON.parse(await fs.readFile(riskSchemePath, 'utf8'));
    return scheme;
}

export function band(s, r) {
    return engineOf(s).band(r);
}

/** Residual [likelihood, impact] for a threat given all selected countermeasures. */
export function residual(threat, cms) {
    return engineOf(null).residual(threat, cms);
}

export function computeRisk(s, threats, cms) {
    const engine = engineOf(s);
    return threats.map((t) => {
        const risk = engine.riskOf(t, cms);
        const riskBand = (likelihood, impact, score) => {
            if (score <= 0) return { name: 'None', min: 0, max: 0, color: '#6b7280' };
            if (engine.scheme.classification.kind === 'product-bands') return engine.band(score);
            const level = engine.classify(likelihood, impact);
            return { name: level.label, min: level.rank, max: level.rank, color: level.color };
        };
        return {
            id: t.id,
            likelihood: t.likelihood,
            impact: t.impact,
            ...risk,
            initialBand: riskBand(t.likelihood, t.impact, risk.initial),
            residualBand: riskBand(risk.residualLikelihood, risk.residualImpact, risk.residual),
        };
    });
}
