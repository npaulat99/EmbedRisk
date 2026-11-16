// Threat-actor scale 1-4 (EN IEC 62443-4-1:2018/prAA:2026 draft). Keep in sync with vscode-extension/media/attacker-scale.js.
export const ACTOR_LEVELS = [
    { level: 1, title: 'Casual or coincidental violation', description: 'Casual or coincidental violation', resources: 'No intentional attack resources', motivation: 'None (casual or coincidental)' },
    { level: 2, title: 'Intentional violation using simple means', description: 'Intentional violation using simple means with low resources, generic skills and low motivation', resources: 'Simple means, low resources, generic skills', motivation: 'Low' },
    { level: 3, title: 'Intentional violation using sophisticated means, moderate resources', description: 'Intentional violation using sophisticated means with moderate resources, ACS specific skills and moderate motivation', resources: 'Sophisticated means, moderate resources, ACS specific skills', motivation: 'Moderate' },
    { level: 4, title: 'Intentional violation using sophisticated means, extended resources', description: 'Intentional violation using sophisticated means with extended resources, ACS specific skills and high motivation', resources: 'Sophisticated means, extended resources, ACS specific skills', motivation: 'High' },
];

export const MAX_ACTOR_LEVEL = 4;

// A persisted legacy 5 is read as 4.
export function normalizeActorLevel(value) {
    return typeof value === 'number' && value >= 1 ? Math.min(MAX_ACTOR_LEVEL, value) : value;
}

export function actorLevelLabel(value) {
    const level = normalizeActorLevel(Math.round(value));
    return ACTOR_LEVELS.some((entry) => entry.level === level) ? `Threat actor ${level}` : '–';
}

export function actorLevelOption(value) {
    const entry = ACTOR_LEVELS.find((item) => item.level === normalizeActorLevel(Math.round(value)));
    return entry ? `${entry.level} · ${entry.description}` : '–';
}

export function managedSlcAttacker(level) {
    const entry = ACTOR_LEVELS.find((item) => item.level === level);
    if (!entry) return undefined;
    return { id: `ATK-SLC-${level}`, name: `Threat Actor ${level}: ${entry.title}`, capability: level, motivation: entry.motivation, resources: entry.resources, text: entry.description };
}
