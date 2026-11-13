// Attack-Defense Tree helpers: deterministic bottom-up evaluation and immutable tree edits.
// Grounded in notes/topics/attack-trees.typ and bewertung.typ (cost factor weights,
// access/skill aggregation) and Kordy et al. (AND/OR) + Jhawar et al. (SAND).
import type { AdCost, AdGate, AdKind, AdNode } from '../types';
import { ACTOR_LEVELS, actorLevelLabel, normalizeActorLevel } from '@shared/attackerScale.js';

export const COST_FACTORS: { k: keyof AdCost; label: string; weight: number }[] = [
    { k: 'time', label: 'Time effort', weight: 0.25 },
    { k: 'exploitability', label: 'Exploitability', weight: 0.2 },
    { k: 'window', label: 'Window of opportunity', weight: 0.15 },
    { k: 'detection', label: 'Detection probability', weight: 0.15 },
    { k: 'notoriety', label: 'Prior knowledge', weight: 0.1 },
    { k: 'prep', label: 'Preparation effort', weight: 0.1 },
    { k: 'abort', label: 'Abort risk', weight: 0.05 },
];

export const COST_FACTOR_LEVELS: Record<keyof AdCost, [number, string][]> = {
    time: [[1, 'Minutes'], [2, 'Hours'], [3, 'Days'], [4, 'Weeks'], [5, 'Months+']],
    notoriety: [[1, 'Public'], [2, 'Known'], [3, 'Limited'], [4, 'Internal'], [5, 'Unknown']],
    exploitability: [[1, 'Trivial'], [2, 'Easy'], [3, 'Moderate'], [4, 'Difficult'], [5, 'Very Difficult']],
    window: [[1, 'Permanent'], [2, 'Regular'], [3, 'Occasional'], [4, 'Brief'], [5, 'One-Time']],
    detection: [[1, 'None'], [2, 'Low'], [3, 'Moderate'], [4, 'High'], [5, 'Very High']],
    prep: [[1, 'None'], [2, 'Software setup'], [3, 'Test environment'], [4, 'Procure'], [5, 'Infrastructure']],
    abort: [[1, 'Robust'], [2, 'Rare'], [3, 'Moderate'], [4, 'Frequent'], [5, 'Very Likely']],
};

export type CostWeights = Partial<Record<keyof AdCost, number>>;

export function costWeightTotal(weights?: CostWeights): number {
    return COST_FACTORS.reduce((sum, factor) => sum + Math.max(0, Number(weights?.[factor.k] ?? factor.weight) || 0), 0);
}

export function normalizedCostWeights(weights?: CostWeights): Record<keyof AdCost, number> {
    const total = costWeightTotal(weights);
    return Object.fromEntries(COST_FACTORS.map((factor) => [factor.k, Math.max(0, Number(weights?.[factor.k] ?? factor.weight) || 0) / (total || 1)])) as Record<keyof AdCost, number>;
}

export function weightedCost(cost?: AdCost, weights?: CostWeights): number {
    const normalized = normalizedCostWeights(weights);
    return COST_FACTORS.reduce((sum, factor) => sum + normalized[factor.k] * Math.max(1, Math.min(5, cost?.[factor.k] ?? 3)), 0);
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Per-step attacker success probability (0..1) from the cost factors. Each factor c (1-5, higher =
 * harder) contributes to the weighted arithmetic cost C = sum(weight * factor). The cost is then
 * converted to success probability as (6 - C) / 5.
 */
export function stepProb(cost?: AdCost, weights?: CostWeights): number {
    return clamp01((6 - weightedCost(cost, weights)) / 5);
}

export interface AdMetrics {
    skillReq: number;
    accessReq: number;
    prob: number; // 0..1 attacker success probability of the cheapest feasible path
    defenses: number;
    vulns: number;
}

const hasCostAssessment = (cost?: AdCost) => COST_FACTORS.some((factor) => typeof cost?.[factor.k] === 'number');
const assessedStepProb = (cost: AdCost | undefined, weights?: CostWeights) => hasCostAssessment(cost) ? stepProb(cost, weights) : 1;
const accessLevel = (value: unknown) => typeof value === 'number' && value >= 1 && value <= 5 ? value : 0;
const skillLevel = (value: unknown) => typeof value === 'number' && value >= 1 && value <= 5 ? normalizeActorLevel(value) as number : 0;

/**
 * Bottom-up evaluation returning the attacker's success probability of the *cheapest* path
 * (Kordy et al. attack–defense trees; Jhawar et al. SAND). Semantics:
 *   OR  — the attacker takes the single easiest child: probability = MAX child, and required
 *         access/skill are reported from *that* child (never a mix of independently-minimised axes).
 *   AND — every sub-step is required: probability = PRODUCT of children (multiplicative, so longer
 *         chains are correctly less likely); required access/skill = MAX.
 *   SAND— quantitatively identical to AND (all steps required); the fixed order is descriptive
 *         (it constrains sequencing, not the success probability of the conjunction).
 * Each defence child lowers the local success probability by a factor that depends on the linked
 * countermeasure's *status* (a verified control reduces more than a merely proposed one); each
 * vulnerability child raises it.
 */
const DEF_FACTOR: Record<string, number> = { proposed: 0.85, planned: 0.7, implemented: 0.5, verified: 0.35 };

export function evaluate(node: AdNode, cmById?: Map<string, { status?: string }>, weights?: CostWeights): AdMetrics {
    const kids = (node.children || []).filter((c) => c.kind !== 'countermeasure' && c.kind !== 'vulnerability');
    const defChildren = (node.children || []).filter((c) => c.kind === 'countermeasure');
    const vulnChildren = (node.children || []).filter((c) => c.kind === 'vulnerability');
    const ownDef = defChildren.length;
    const ownVuln = vulnChildren.length;
    // A non-leaf attack step is structural: its cost, required skill, and required access are
    // derived from the attack-step descendants rather than assessed independently.
    const leafAttackStep = (node.kind === 'step' || node.kind === 'substep') && !kids.length;
    const residualEntity = node.kind === 'countermeasure' || node.kind === 'vulnerability';
    const assessedNode = leafAttackStep || residualEntity;
    const assessmentCost = residualEntity ? node.residualCost : node.cost;
    let selfProb = assessedNode ? assessedStepProb(assessmentCost, weights) : 1;
    let selfSkill = assessedNode ? skillLevel(node.skill) : 0;
    let selfAccess = assessedNode ? accessLevel(node.access) : 0;

    // Residual assessments modify only a leaf attack step. Structural AND/OR/SAND nodes aggregate
    // their child paths first; applying a low-probability vulnerability to an OR container would
    // incorrectly suppress a more likely sibling path.
    const defenceResiduals = leafAttackStep ? defChildren.filter((child) => hasCostAssessment(child.residualCost)) : [];
    if (defenceResiduals.length) selfProb = Math.min(...defenceResiduals.map((child) => assessedStepProb(child.residualCost, weights)));
    const vulnerabilityResiduals = leafAttackStep ? vulnChildren.filter((child) => hasCostAssessment(child.residualCost)) : [];
    if (vulnerabilityResiduals.length) {
        const selected = vulnerabilityResiduals.reduce((best, child) => assessedStepProb(child.residualCost, weights) > assessedStepProb(best.residualCost, weights) ? child : best);
        selfProb = assessedStepProb(selected.residualCost, weights);
        selfSkill = skillLevel(selected.skill);
        selfAccess = accessLevel(selected.access);
    }

    let skillReq: number;
    let accessReq: number;
    let prob: number;
    let defenses = ownDef;
    let vulns = ownVuln;

    if (!kids.length) {
        skillReq = selfSkill;
        accessReq = selfAccess;
        prob = selfProb;
    } else {
        const childM = kids.map((k) => evaluate(k, cmById, weights));
        defenses += childM.reduce((s, c) => s + c.defenses, 0);
        vulns += childM.reduce((s, c) => s + c.vulns, 0);
        if (node.kind === 'category' || node.gate === 'OR') {
            // A vulnerability attached to an OR container is an alternative attack vector. It must
            // compete with the other paths rather than act as a modifier on the whole container.
            const alternatives = [...childM, ...vulnChildren.map((child) => evaluate(child, cmById, weights))];
            const best = alternatives.reduce((a, b) => (b.prob > a.prob ? b : a));
            skillReq = Math.max(best.skillReq, selfSkill);
            accessReq = Math.max(best.accessReq, selfAccess);
            prob = best.prob * selfProb;
        } else {
            skillReq = Math.max(selfSkill, ...childM.map((c) => c.skillReq));
            accessReq = Math.max(selfAccess, ...childM.map((c) => c.accessReq));
            prob = childM.reduce((p, c) => p * c.prob, 1) * selfProb;
        }
    }
    const legacyDefChildren = leafAttackStep ? defChildren.filter((child) => !hasCostAssessment(child.residualCost)) : [];
    const legacyVulns = leafAttackStep ? vulnChildren.filter((child) => !hasCostAssessment(child.residualCost)).length : 0;
    const defMult = legacyDefChildren.reduce((m, c) => m * (DEF_FACTOR[(c.countermeasureRef ? cmById?.get(c.countermeasureRef)?.status : '') ?? ''] ?? 0.6), 1);
    prob = clamp01(prob * defMult * Math.pow(1.6, legacyVulns));
    return { skillReq, accessReq, prob, defenses, vulns };
}

/** Suggested threat likelihood (1-5) from a tree's root success probability. */
export const DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS: Record<2 | 3 | 4 | 5, number> = { 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };

/** Maps a success probability to the project's L1-L5 matrix scale. L1 covers every positive
 * probability below the L2 threshold; L0 is reserved for an impossible/unfeasible path. */
export function likelihoodFromProb(prob: number, thresholds?: Partial<Record<2 | 3 | 4 | 5, number>>): number {
    if (prob <= 0) return 0;
    for (const level of [5, 4, 3, 2] as const)
        if (prob >= (thresholds?.[level] ?? DEFAULT_LIKELIHOOD_PROBABILITY_THRESHOLDS[level])) return level;
    return 1;
}

// ---- immutable tree editing -------------------------------------------------
let counter = 0;
export const adId = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

export function updateNode(root: AdNode, id: string, patch: Partial<AdNode>): AdNode {
    const rec = (n: AdNode): AdNode => ({
        ...(n.id === id ? { ...n, ...patch } : n),
        children: (n.children || []).map(rec),
    });
    return rec(root);
}

export function addChild(root: AdNode, parentId: string, child: AdNode): AdNode {
    const rec = (n: AdNode): AdNode =>
        n.id === parentId && !(n.kind === 'substep' && ['step', 'substep', 'category'].includes(child.kind))
            ? { ...n, children: [...(n.children || []), child] }
            : { ...n, children: (n.children || []).map(rec) };
    return rec(root);
}

export function removeNode(root: AdNode, id: string): AdNode {
    const rec = (n: AdNode): AdNode => ({ ...n, children: (n.children || []).filter((c) => c.id !== id).map(rec) });
    return rec(root);
}

export const KIND_LABEL: Record<string, string> = {
    goal: 'Goal',
    step: 'Step',
    substep: 'Sub-step',
    category: 'Category',
    countermeasure: 'Defence',
    vulnerability: 'Vulnerability',
};

// ---- Shared presentational option maps (used by both the list and the diagram editors) -------
export const GATES: AdGate[] = ['AND', 'OR', 'SAND'];
export const ADD_KINDS: AdKind[] = ['step', 'substep', 'category', 'countermeasure', 'vulnerability'];
export const ACCESS_OPTS: [number, string][] = [
    [1, 'Remote (unauth.)'],
    [2, 'Remote (auth.)'],
    [3, 'Adjacent / fieldbus'],
    [4, 'Local (on site)'],
    [5, 'Physical (open enclosure)'],
];
const DEFAULT_ACCESS_PROBABILITIES: Record<number, number> = { 1: 0.9, 2: 0.7, 3: 0.5, 4: 0.3, 5: 0.1 };
export const accessProbability = (access: number, probabilities?: Partial<Record<1 | 2 | 3 | 4 | 5, number>>) => {
    const value = probabilities?.[Math.round(access) as 1 | 2 | 3 | 4 | 5] ?? DEFAULT_ACCESS_PROBABILITIES[Math.round(access)] ?? 0.05;
    return Math.max(0.05, Math.min(1, value));
};
export const SKILL_OPTS: [number, string][] = ACTOR_LEVELS.map((entry) => [entry.level, entry.description]);
export const accessLabel = (n: number) => ACCESS_OPTS.find(([v]) => v === Math.round(n))?.[1] || '–';
export const skillLabel = (n: number) => actorLevelLabel(n);

/** A fresh node of the given kind, with sensible defaults (steps get access/skill/cost; structural
 *  nodes get a default gate). Attack and defence nodes are created the same way. */
export function newNode(kind: AdKind): AdNode {
    return {
        id: adId(),
        kind,
        label: KIND_LABEL[kind],
        ...(kind === 'step' || kind === 'substep' ? { access: 3, skill: 2, cost: {} } : {}),
        ...(kind === 'countermeasure' || kind === 'vulnerability' ? { access: 3, skill: 2, residualCost: {} } : {}),
        ...(['goal', 'path', 'step', 'substep', 'category'].includes(kind) ? { gate: kind === 'category' ? 'OR' as AdGate : 'AND' as AdGate } : {}),
        children: [],
    };
}

/** Move a node one position left (-1) or right (+1) among its siblings — preserving SAND order
 *  semantics (left-to-right = execution sequence). No-op at the ends. Immutable. */
export function moveChild(root: AdNode, id: string, dir: -1 | 1): AdNode {
    const rec = (n: AdNode): AdNode => {
        const children = n.children || [];
        const idx = children.findIndex((c) => c.id === id);
        if (idx !== -1) {
            const j = idx + dir;
            if (j < 0 || j >= children.length) return n;
            const next = [...children];
            [next[idx], next[j]] = [next[j], next[idx]];
            return { ...n, children: next };
        }
        return { ...n, children: children.map(rec) };
    };
    return rec(root);
}
