// Deterministic risk engine: Risk = Likelihood x Impact (5x5), banded, with residual
// risk derived from the minimum residual L/I across all countermeasure links for a threat.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { builtinRiskSchemePaths, localRiskSchemesDir } from './paths.js';
import { fingerprint, normalizeScheme } from '../../shared/riskScheme.js';
import '../../shared/riskEngine.js';

const engineCache = new WeakMap();
const LEGACY_SCHEME_IDS = {
    'exposure-exploitability-impact': 'builtin:5x5-exposure',
    'cost-based': 'builtin:5x5-cost',
};

function engineOf(value) {
    const key = value && typeof value === 'object' ? value : null;
    if (key && engineCache.has(key)) return engineCache.get(key);
    const engine = globalThis.RiskEngine.createRiskEngine(value || {});
    if (key) engineCache.set(key, engine);
    return engine;
}

export async function loadRiskSchemes({ localDirectory = localRiskSchemesDir } = {}) {
    const schemes = new Map();
    const errors = [];
    for (const [id, filePath] of Object.entries(builtinRiskSchemePaths)) {
        const normalized = normalizeScheme(await fs.readFile(filePath, 'utf8'));
        if (normalized.id !== id) throw new Error(`Built-in risk scheme ID mismatch in ${filePath}`);
        schemes.set(id, normalized);
    }

    let entries = [];
    try {
        entries = await fs.readdir(localDirectory, { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') errors.push({ file: localDirectory, message: error.message });
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        try {
            const filePath = join(localDirectory, entry.name);
            const normalized = normalizeScheme(await fs.readFile(filePath, 'utf8'), { local: true });
            if (schemes.has(normalized.id)) throw new Error(`duplicate risk scheme ID '${normalized.id}'`);
            schemes.set(normalized.id, normalized);
        } catch (error) {
            errors.push({ file: entry.name, message: error.message });
        }
    }
    return { schemes: [...schemes.values()], errors };
}

function requestedSchemeId(project = {}) {
    return project.riskSchemeId || LEGACY_SCHEME_IDS[project.riskScoringMethod] || LEGACY_SCHEME_IDS['cost-based'];
}

export async function resolveProjectScheme(project = {}, options) {
    const id = requestedSchemeId(project);
    const registry = await loadRiskSchemes(options);
    const selected = registry.schemes.find((item) => item.id === id);
    if (!selected) {
        const rejected = registry.errors.find((item) => item.file === `${id}.json` || item.message.includes(`'${id}'`));
        return { id, scheme: null, fingerprint: null, warning: `Risk scheme '${id}' is unavailable.${rejected ? ` ${rejected.message}` : ''}` };
    }
    const schemeFingerprint = fingerprint(selected);
    if (project.riskSchemeFingerprint && project.riskSchemeFingerprint !== schemeFingerprint) {
        return { id, scheme: null, fingerprint: schemeFingerprint, warning: `Risk scheme '${id}' has changed since this project was assessed; risk classifications are unavailable until the scheme is reviewed.` };
    }
    return { id, scheme: selected, fingerprint: schemeFingerprint, warning: null };
}

export async function loadScheme(id, project = {}) {
    const selectedProject = typeof id === 'string'
        ? { ...project, riskSchemeId: id }
        : (id && typeof id === 'object' ? id : project);
    const resolved = await resolveProjectScheme(selectedProject);
    if (!resolved.scheme) throw new Error(resolved.warning);
    return resolved.scheme;
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
