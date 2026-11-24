// Artifact (per-step JSON file) access layer.
//
// Every TRA project is a folder under `projectsDir` containing one sub-folder per
// methodology step. This module is the single place that maps the logical step keys
// used by the UI/API to the canonical file paths on disk, reads and writes them, and
// tracks a content hash per file so the file-system watcher can distinguish a change
// that *we* just wrote (echo) from a change made externally (e.g. the user editing the
// JSON in an editor). Only external changes are pushed back to the browser.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { projectsDir } from './paths.js';

/** Logical step key -> canonical relative file path inside a project folder. */
export const STEP_FILES = {
    project: '01-project-description/project.json',
    assumptions: '02-assumptions/assumptions.json',
    system: '03-system-assets/system.json',
    dfd: '04-dfd/dfd.json',
    useCases: '04b-use-cases/use-cases.json',
    threats: '06-threats/threats.json',
    requirements: '05-requirements/requirements.json',
    countermeasures: '08-countermeasures/countermeasures.json',
    attackTrees: '07-attack-trees/attack-trees.json',
    defects: '09-defects/defects.json',
};
export const STEP_KEYS = Object.keys(STEP_FILES);
export const CHANGE_REASONS = ['initial', 'functional changes', 'new vulnerabilities', 'regular reassessment'];
export const CHANGE_TRACKER_FILE = '01-project-description/change-tracker.json';
export const SNAPSHOTS_DIR = '10-tra-versions';

/** Empty-but-valid skeletons used when a step file does not exist yet. */
export const DEFAULTS = {
    project: () => ({ device: {}, scope: {}, steps: {} }),
    assumptions: () => ({ device: [], system: [], environment: [], operational: [], attacker: [] }),
    system: () => ({ components: [], interfaces: [], trustBoundaries: [], assets: [] }),
    dfd: () => ({ nodes: [], flows: [] }),
    useCases: () => ({ diagrams: [] }),
    threats: () => ({ threats: [] }),
    requirements: () => ({ requirements: [] }),
    countermeasures: () => ({ countermeasures: [] }),
    attackTrees: () => ({ trees: [] }),
    defects: () => ({ defects: [] }),
};

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const hashes = new Map(); // absolute path -> last known content hash
const artifactLocks = new Map(); // absolute path -> queued writes/reads
const fileOf = (id, step) => join(projectsDir, id, STEP_FILES[step]);
const changeTrackerPath = (id) => join(projectsDir, id, CHANGE_TRACKER_FILE);
const snapshotDirOf = (id, version) => join(projectsDir, id, SNAPSHOTS_DIR, version);
const snapshotFileOf = (id, version, step) => join(snapshotDirOf(id, version), STEP_FILES[step]);
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const today = () => new Date().toISOString().slice(0, 10);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function normalizeTraVersion(value) {
    const match = /^v?(\d+)\.(\d+)$/i.exec(String(value || '').trim());
    if (!match) return 'v1.0';
    return `v${Number(match[1])}.${Number(match[2])}`;
}

function parseTraVersion(value) {
    const match = /^v?(\d+)\.(\d+)$/i.exec(String(value || '').trim());
    if (!match) return { major: 1, minor: 0 };
    return { major: Number(match[1]), minor: Number(match[2]) };
}

export function nextTraVersion(currentVersion, reason) {
    const { major, minor } = parseTraVersion(currentVersion);
    if (reason === 'functional changes') return `v${major + 1}.0`;
    if (reason === 'initial') return 'v1.0';
    return `v${major}.${minor + 1}`;
}

function normalizeProjectForDiff(project) {
    if (!isObject(project)) return project;
    const { traVersion, ...rest } = project;
    return rest;
}

function normalizeStepForDiff(step, value) {
    return step === 'project' ? normalizeProjectForDiff(value) : value;
}

function makeInitialEntry(version, summary = 'Initial TRA baseline.') {
    return {
        version,
        reason: 'initial',
        assessedAt: today(),
        assessors: [],
        summary,
        changedSteps: [...STEP_KEYS],
        changedFiles: STEP_KEYS.map((step) => STEP_FILES[step]),
        hasChanges: true,
        snapshotPath: `${SNAPSHOTS_DIR}/${version}`,
    };
}

function normalizeChangeTracker(raw, fallbackVersion) {
    const entries = Array.isArray(raw?.entries)
        ? raw.entries.map((entry, index) => {
            const version = normalizeTraVersion(entry?.version || fallbackVersion || `v1.${index}`);
            const changedSteps = Array.isArray(entry?.changedSteps)
                ? entry.changedSteps.filter((step) => STEP_KEYS.includes(step))
                : [];
            const changedFiles = Array.isArray(entry?.changedFiles)
                ? entry.changedFiles.filter((path) => typeof path === 'string')
                : changedSteps.map((step) => STEP_FILES[step]);
            return {
                version,
                reason: CHANGE_REASONS.includes(entry?.reason) ? entry.reason : index === 0 ? 'initial' : 'regular reassessment',
                assessedAt: String(entry?.assessedAt || today()),
                assessors: Array.isArray(entry?.assessors) ? entry.assessors.map((name) => String(name).trim()).filter(Boolean) : [],
                summary: String(entry?.summary || ''),
                changedSteps,
                changedFiles,
                hasChanges: entry?.hasChanges !== false,
                snapshotPath: String(entry?.snapshotPath || `${SNAPSHOTS_DIR}/${version}`),
            };
        })
        : [];
    const trailingVersion = entries.length ? entries[entries.length - 1].version : null;
    const currentVersion = raw?.currentVersion ? normalizeTraVersion(raw.currentVersion) : trailingVersion || (fallbackVersion && entries.length ? normalizeTraVersion(fallbackVersion) : null);
    return { currentVersion, entries };
}

async function readJsonOrNull(path) {
    try {
        return JSON.parse(await fs.readFile(path, 'utf8'));
    } catch {
        return null;
    }
}

async function writeJson(path, data) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function snapshotExists(id, version) {
    try {
        await fs.access(snapshotFileOf(id, version, 'project'));
        return true;
    } catch {
        return false;
    }
}

async function readProjectArtifacts(id) {
    const entries = await Promise.all(STEP_KEYS.map(async (step) => [step, await readArtifact(id, step)]));
    return Object.fromEntries(entries);
}

async function writeChangeTracker(id, tracker) {
    await writeJson(changeTrackerPath(id), tracker);
    return tracker;
}

async function readSnapshot(id, version) {
    const entries = await Promise.all(
        STEP_KEYS.map(async (step) => {
            const filePath = snapshotFileOf(id, version, step);
            const data = (await readJsonOrNull(filePath)) ?? DEFAULTS[step]();
            return [step, data];
        }),
    );
    return Object.fromEntries(entries);
}

async function writeSnapshot(id, version, projectData) {
    await Promise.all(
        STEP_KEYS.map(async (step) => {
            await writeJson(snapshotFileOf(id, version, step), projectData[step] ?? DEFAULTS[step]());
        }),
    );
}

function computeJsonDiff(before, after, path = '$', bucket = { added: [], removed: [], changed: [] }) {
    if (JSON.stringify(before) === JSON.stringify(after)) return bucket;
    if (Array.isArray(before) && Array.isArray(after)) {
        const count = Math.max(before.length, after.length);
        for (let index = 0; index < count; index++) {
            const childPath = `${path}[${index}]`;
            if (index >= before.length) bucket.added.push({ path: childPath, value: after[index] });
            else if (index >= after.length) bucket.removed.push({ path: childPath, value: before[index] });
            else computeJsonDiff(before[index], after[index], childPath, bucket);
        }
        return bucket;
    }
    if (isObject(before) && isObject(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) {
            const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
            if (!(key in before)) bucket.added.push({ path: childPath, value: after[key] });
            else if (!(key in after)) bucket.removed.push({ path: childPath, value: before[key] });
            else computeJsonDiff(before[key], after[key], childPath, bucket);
        }
        return bucket;
    }
    bucket.changed.push({ path, before, after });
    return bucket;
}

export function diffProjectData(beforeProject, afterProject) {
    const files = [];
    for (const step of STEP_KEYS) {
        const before = normalizeStepForDiff(step, beforeProject?.[step] ?? DEFAULTS[step]());
        const after = normalizeStepForDiff(step, afterProject?.[step] ?? DEFAULTS[step]());
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        files.push({
            step,
            path: STEP_FILES[step],
            diff: computeJsonDiff(before, after),
        });
    }
    return {
        changedFiles: files.map((file) => ({ step: file.step, path: file.path })),
        files,
    };
}

export async function readArtifact(id, step) {
    const p = fileOf(id, step);
    return withArtifactLock(p, async () => {
        const snapshot = await readArtifactSnapshotUnlocked(id, step);
        return snapshot.data;
    });
}

async function readArtifactSnapshotUnlocked(id, step) {
    const p = fileOf(id, step);
    try {
        const txt = await fs.readFile(p, 'utf8');
        const revision = sha1(txt);
        hashes.set(p, revision);
        let data;
        try {
            data = JSON.parse(txt);
        } catch {
            data = DEFAULTS[step] ? DEFAULTS[step]() : null;
        }
        return { data, revision, raw: txt };
    } catch (error) {
        if (error?.code === 'ENOENT') return { data: DEFAULTS[step] ? DEFAULTS[step]() : null, revision: 'absent', raw: null };
        throw error;
    }
}

async function writeArtifactUnlocked(id, step, data) {
    const p = fileOf(id, step);
    const txt = JSON.stringify(data, null, 2) + '\n';
    const revision = sha1(txt);
    // Record the expected hash *before* writing so the watcher recognises the echo.
    hashes.set(p, revision);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, txt, 'utf8');
    return { data, revision };
}

async function withArtifactLock(path, operation) {
    const previous = artifactLocks.get(path) || Promise.resolve();
    let release;
    const current = new Promise((resolveLock) => { release = resolveLock; });
    const queued = previous.then(() => current);
    artifactLocks.set(path, queued);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (artifactLocks.get(path) === queued) artifactLocks.delete(path);
    }
}

async function withArtifactLocks(paths, operation) {
    const orderedPaths = [...new Set(paths)].sort();
    const acquire = (index) => index >= orderedPaths.length
        ? operation()
        : withArtifactLock(orderedPaths[index], () => acquire(index + 1));
    return acquire(0);
}

export async function readArtifactRevision(id, step) {
    if (!STEP_FILES[step]) throw new Error(`Unknown artifact step: ${step}`);
    const p = fileOf(id, step);
    return withArtifactLock(p, async () => (await readArtifactSnapshotUnlocked(id, step)).revision);
}

export async function writeArtifactWithRevision(id, step, data) {
    if (!STEP_FILES[step]) throw new Error(`Unknown artifact step: ${step}`);
    const p = fileOf(id, step);
    return withArtifactLock(p, () => writeArtifactUnlocked(id, step, data));
}

export async function writeArtifactIfRevision(id, step, data, baseRevision) {
    if (!STEP_FILES[step]) throw new Error(`Unknown artifact step: ${step}`);
    const p = fileOf(id, step);
    return withArtifactLock(p, async () => {
        const current = await readArtifactSnapshotUnlocked(id, step);
        if (current.revision !== baseRevision) return { ok: false, revision: current.revision };
        const written = await writeArtifactUnlocked(id, step, data);
        return { ok: true, data: written.data, revision: written.revision };
    });
}

export async function writeArtifactsIfRevisions(id, snapshots, baseRevisions) {
    const steps = Object.keys(snapshots || {}).sort((left, right) => STEP_KEYS.indexOf(left) - STEP_KEYS.indexOf(right));
    if (!steps.length || steps.some((step) => !STEP_FILES[step])) throw new Error('A save group must contain known artifact steps.');
    const paths = steps.map((step) => fileOf(id, step));
    return withArtifactLocks(paths, async () => {
        const revisions = {};
        const previous = {};
        for (const step of steps) {
            const current = await readArtifactSnapshotUnlocked(id, step);
            if (baseRevisions?.[step] !== undefined && current.revision !== baseRevisions[step]) return { ok: false, step, revision: current.revision };
            revisions[step] = current.revision;
            previous[step] = current;
        }
        const committed = {};
        const written = [];
        try {
            for (const step of steps) {
                const result = await writeArtifactUnlocked(id, step, snapshots[step]);
                committed[step] = result.revision;
                written.push(step);
            }
        } catch (error) {
            for (const step of written.reverse()) {
                const path = fileOf(id, step);
                const original = previous[step];
                if (original.raw === null) {
                    await fs.rm(path, { force: true }).catch(() => { });
                    hashes.delete(path);
                } else {
                    await fs.writeFile(path, original.raw, 'utf8').catch(() => { });
                    hashes.set(path, original.revision);
                }
            }
            throw error;
        }
        return { ok: true, revisions: committed };
    });
}

export async function writeArtifact(id, step, data) {
    const written = await writeArtifactWithRevision(id, step, data);
    return written.data;
}

export async function ensureProjectVersioning(id) {
    const projectData = await readProjectArtifacts(id);
    const normalizedVersion = projectData.project?.traVersion ? normalizeTraVersion(projectData.project.traVersion) : null;
    const rawTracker = await readJsonOrNull(changeTrackerPath(id));
    const normalizedTracker = normalizeChangeTracker(rawTracker, normalizedVersion);
    let tracker = normalizedTracker;
    let trackerChanged = false;

    if (tracker.entries.length && tracker.currentVersion !== tracker.entries[tracker.entries.length - 1]?.version) {
        tracker = { ...tracker, currentVersion: tracker.entries[tracker.entries.length - 1]?.version || normalizedVersion };
        trackerChanged = true;
    }

    if (tracker.currentVersion && projectData.project?.traVersion !== tracker.currentVersion) {
        projectData.project = { ...(projectData.project || {}), traVersion: tracker.currentVersion };
        await writeArtifact(id, 'project', projectData.project);
    }

    if (rawTracker && (JSON.stringify(normalizedTracker) !== JSON.stringify(tracker) || trackerChanged)) {
        await writeChangeTracker(id, tracker);
    }

    if (tracker.currentVersion && !(await snapshotExists(id, tracker.currentVersion))) {
        const snapshotProject = { ...projectData, project: { ...(projectData.project || {}), traVersion: tracker.currentVersion } };
        await writeSnapshot(id, tracker.currentVersion, snapshotProject);
    }

    return tracker;
}

export async function readProject(id) {
    const snapshot = await readProjectWithRevisions(id);
    return snapshot.data;
}

export async function readProjectWithRevisions(id) {
    const changeTracker = await ensureProjectVersioning(id);
    const paths = STEP_KEYS.map((step) => fileOf(id, step));
    return withArtifactLocks(paths, async () => {
        const entries = await Promise.all(STEP_KEYS.map(async (step) => [step, await readArtifactSnapshotUnlocked(id, step)]));
        const artifacts = Object.fromEntries(entries.map(([step, snapshot]) => [step, snapshot.data]));
        const revisions = Object.fromEntries(entries.map(([step, snapshot]) => [step, snapshot.revision]));
        return { data: { ...artifacts, changeTracker }, revisions };
    });
}

export async function listProjects() {
    let dirs = [];
    try {
        dirs = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const proj = await readArtifact(d.name, 'project');
        out.push({
            id: d.name,
            title: proj?.title || d.name,
            device: proj?.device || null,
            status: proj?.status || 'draft',
            slTarget: proj?.slTarget || '',
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Map an absolute changed-file path back to {id, step}, or null if it is not a step file. */
export function pathToStep(absPath) {
    const rel = relative(projectsDir, absPath);
    if (!rel || rel.startsWith('..')) return null;
    const parts = rel.split(sep);
    if (parts.length < 2) return null;
    const id = parts[0];
    const stepRel = parts.slice(1).join('/');
    const step = STEP_KEYS.find((k) => STEP_FILES[k] === stepRel);
    return step ? { id, step } : null;
}

/** True when the on-disk text differs from what we last wrote (i.e. an external edit). */
export function isExternalChange(absPath, txt) {
    return hashes.get(absPath) !== sha1(txt);
}
export function recordHash(absPath, txt) {
    const revision = sha1(txt);
    hashes.set(absPath, revision);
    return revision;
}

export async function readChangeTracker(id) {
    return ensureProjectVersioning(id);
}

export async function recordAssessmentVersion(id, payload = {}) {
    const tracker = await ensureProjectVersioning(id);
    const projectData = await readProjectArtifacts(id);
    const previousVersion = tracker.currentVersion;
    const reason = CHANGE_REASONS.includes(payload.reason) ? payload.reason : null;
    if (!reason) return { ok: false, error: 'Select an assessment reason.' };
    const isInitial = tracker.entries.length === 0;
    if (isInitial && reason !== 'initial') return { ok: false, error: 'The first tagged TRA version must be the initial assessment.' };
    if (!isInitial && reason === 'initial') return { ok: false, error: 'The initial TRA version has already been recorded.' };

    const assessors = Array.isArray(payload.assessors)
        ? payload.assessors.map((name) => String(name).trim()).filter(Boolean)
        : [];
    if (!assessors.length) return { ok: false, error: 'At least one assessor is required.' };

    const assessedAt = String(payload.assessedAt || today()).trim();
    const nextVersion = isInitial ? 'v1.0' : nextTraVersion(previousVersion, reason);
    const previousSnapshot = previousVersion ? await readSnapshot(id, previousVersion) : null;
    const diff = previousSnapshot
        ? diffProjectData(previousSnapshot, projectData)
        : {
            changedFiles: STEP_KEYS.map((step) => ({ step, path: STEP_FILES[step] })),
            files: STEP_KEYS.map((step) => ({
                step,
                path: STEP_FILES[step],
                diff: computeJsonDiff(undefined, normalizeStepForDiff(step, projectData?.[step] ?? DEFAULTS[step]())),
            })),
        };
    const hasChanges = isInitial ? true : diff.changedFiles.length > 0;

    if (!hasChanges && reason === 'regular reassessment' && !payload.allowEmpty) {
        return { ok: false, requiresEmptyConfirmation: true, nextVersion, previousVersion };
    }
    if (!hasChanges && reason !== 'regular reassessment') {
        return { ok: false, error: 'No file changes were detected since the previous TRA version.' };
    }

    const nextProject = { ...(projectData.project || {}), traVersion: nextVersion };
    await writeArtifact(id, 'project', nextProject);
    const nextSnapshot = { ...cloneJson(projectData), project: nextProject };
    await writeSnapshot(id, nextVersion, nextSnapshot);

    const entry = {
        version: nextVersion,
        reason,
        assessedAt,
        assessors,
        summary: String(payload.summary || '').trim(),
        changedSteps: diff.changedFiles.map((file) => file.step),
        changedFiles: diff.changedFiles.map((file) => file.path),
        hasChanges,
        snapshotPath: `${SNAPSHOTS_DIR}/${nextVersion}`,
    };
    const nextTracker = {
        currentVersion: nextVersion,
        entries: [...tracker.entries, entry],
    };
    await writeChangeTracker(id, nextTracker);

    return {
        ok: true,
        previousVersion,
        nextVersion,
        project: nextProject,
        changeTracker: nextTracker,
        changedFiles: diff.changedFiles,
    };
}

export async function diffProjectVersions(id, fromVersion, toVersion) {
    const tracker = await ensureProjectVersioning(id);
    const knownVersions = new Set(tracker.entries.map((entry) => entry.version));
    const from = normalizeTraVersion(fromVersion);
    const to = normalizeTraVersion(toVersion);
    if (!knownVersions.has(from) || !knownVersions.has(to)) throw new Error('Unknown TRA version requested.');
    const [beforeProject, afterProject] = await Promise.all([readSnapshot(id, from), readSnapshot(id, to)]);
    return { fromVersion: from, toVersion: to, ...diffProjectData(beforeProject, afterProject) };
}

const slugify = (name) =>
    String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `project-${Date.now()}`;

/** Create a new project skeleton mirroring the example layout. Returns the project id (slug). */
export async function scaffoldProject(name) {
    let slug = slugify(name);
    let n = 1;
    // Ensure a unique folder name.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            await fs.access(join(projectsDir, slug));
            slug = `${slugify(name)}-${++n}`;
        } catch {
            break;
        }
    }
    await writeArtifact(slug, 'project', {
        projectId: slug,
        title: `TRA: ${name}`,
        device: { name, type: 'field device' },
        scope: { mode: 'graybox', boundary: '', inScope: [], outOfScope: [] },
        slTarget: 'SL2',
        steps: Object.fromEntries(STEP_KEYS.map((k) => [STEP_FILES[k].split('/')[0], STEP_FILES[k]])),
        status: 'draft',
    });
    await writeArtifact(slug, 'assumptions', {
        device: [],
        system: [],
        environment: [],
        operational: [],
        attacker: [
            { id: 'ATK-1', name: 'Opportunistic attacker', capability: 2, access: 'local', motivation: 'disruption', text: '' },
        ],
    });
    await writeArtifact(slug, 'system', {
        components: [{ id: 'C-DEV', name, kind: 'device', layer: 1, parent: null, trustZone: 'device' }],
        interfaces: [],
        trustBoundaries: [{ id: 'TB-1', name: 'Device housing', members: ['C-DEV'] }],
        assets: [
            {
                id: 'AS-1',
                name: 'Primary function',
                type: 'function',
                components: ['C-DEV'],
                objectives: { confidentiality: 1, integrity: 3, availability: 3, safety: 1 },
            },
        ],
    });
    await writeArtifact(slug, 'dfd', {
        nodes: [
            { id: 'N-DEV', label: name, type: 'process', layer: 1, parent: null, componentRef: 'C-DEV', x: 320, y: 200 },
            { id: 'TB-1', label: 'Device housing', type: 'trust-boundary', layer: 1, parent: null, x: 210, y: 120, members: ['N-DEV'] },
        ],
        flows: [],
    });
    await writeArtifact(slug, 'useCases', { diagrams: [] });
    await writeArtifact(slug, 'threats', { threats: [] });
    await writeArtifact(slug, 'countermeasures', { countermeasures: [] });
    await writeArtifact(slug, 'attackTrees', { trees: [] });
    await writeArtifact(slug, 'requirements', { requirements: [] });
    await writeArtifact(slug, 'defects', { defects: [] });
    return slug;
}
