import type { AttackerProfile, Threat } from '../types';
import { ACTOR_LEVELS, managedSlcAttacker, normalizeActorLevel } from '@shared/attackerScale.js';

export const SLC_ATTACKERS: Record<number, AttackerProfile> = Object.fromEntries(
    ACTOR_LEVELS.map(({ level }) => [level, managedSlcAttacker(level) as AttackerProfile]),
);

export function slcLevel(value?: string): number | null {
    const match = /(?:SL(?:-C)?\s*)?([1-4])/i.exec(value || '');
    return match ? Number(match[1]) : null;
}

export function attackerForSlc(value?: string): AttackerProfile | null {
    const level = slcLevel(value);
    return level ? SLC_ATTACKERS[level] : null;
}

// The stored managed profile realigned to the canonical content, or null when no rewrite is needed.
export function alignedManagedAttacker(slTarget: string | undefined, attackers: AttackerProfile[] | undefined): AttackerProfile | null {
    const canonical = attackerForSlc(slTarget);
    const stored = attackers?.length === 1 ? attackers[0] : undefined;
    if (!canonical || !stored || stored.id !== canonical.id) return null;
    const differs = (['name', 'capability', 'motivation', 'resources', 'text'] as const).some((key) => stored[key] !== canonical[key]);
    return differs ? { ...stored, ...canonical } : null;
}

export function syncThreatFeasibility(threat: Threat, capability: number): Threat {
    if (typeof threat.requiredSkill !== 'number') return threat;
    if (normalizeActorLevel(threat.requiredSkill)! > normalizeActorLevel(capability)!) return { ...threat, status: 'unfeasible' };
    return threat.status === 'unfeasible' ? { ...threat, status: 'open' } : threat;
}