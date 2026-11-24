// TRA web application backend.
//
// Responsibilities:
//   1. Serve the built React client and a small REST API.
//   2. Provide a WebSocket channel for live, bidirectional synchronisation:
//        - UI edits arrive as {type:'save'} -> written to disk -> broadcast to *other*
//          subscribed clients (so multiple tabs stay in sync without echoing to the sender).
//        - External edits to the JSON files (detected by chokidar) -> broadcast to *all*
//          subscribed clients, so editing a file by hand updates the UI live.
//   3. Generate the HTML report on demand.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { PORT, projectsDir, clientDist, fieldLibraryPath, bugBarPath, riskSchemePath, knowledgeBaseDir } from './paths.js';
import {
    STEP_KEYS,
    listProjects,
    readProject,
    readProjectWithRevisions,
    readArtifactRevision,
    readChangeTracker,
    writeArtifactWithRevision,
    writeArtifactIfRevision,
    writeArtifactsIfRevisions,
    scaffoldProject,
    pathToStep,
    isExternalChange,
    recordHash,
    recordAssessmentVersion,
    diffProjectVersions,
} from './artifacts.js';
import { loadRiskSchemes, loadScheme, resolveProjectScheme } from './risk.js';
import { validate } from './validate.js';
import { generateReport, buildReport } from './report.js';
import { pullKnowledgeBase, commitProject, gitStatus, getProjectWorkspace, prepareProjectWorkspace, verifyProjectWorkspace, removeImportedCatalogue } from './git.js';
import { fingerprint } from '../../shared/riskScheme.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

/**
 * The importable threat/countermeasure library: the shared field-device library plus the threats
 * and countermeasures contributed by any git-pulled catalogue under knowledge-base/imported/*.
 * This is what makes a pulled knowledge-base repo actually usable (importable), not just browsable.
 * Entries need a unique `key` and a `title`; duplicate keys (base wins) are skipped.
 */
async function loadImportableLibrary() {
    const readJson = async (p) => {
        try {
            return JSON.parse(await fs.readFile(p, 'utf8'));
        } catch {
            return null;
        }
    };
    const base = (await readJson(fieldLibraryPath)) || {};
    const threats = [...(base.threats || [])];
    const countermeasures = [...(base.countermeasures || [])];
    const seenT = new Set(threats.map((t) => t.key));
    const seenC = new Set(countermeasures.map((c) => c.key));
    try {
        const importedDir = join(knowledgeBaseDir, 'imported');
        for (const e of await fs.readdir(importedDir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const dir = join(importedDir, e.name);
            for (const f of await fs.readdir(dir).catch(() => [])) {
                if (!f.endsWith('.json')) continue;
                const doc = await readJson(join(dir, f));
                if (!doc) continue;
                for (const t of doc.threats || []) if (t && t.key && t.title && !seenT.has(t.key)) (seenT.add(t.key), threats.push(t));
                for (const c of doc.countermeasures || []) if (c && c.key && c.title && !seenC.has(c.key)) (seenC.add(c.key), countermeasures.push(c));
            }
        }
    } catch {
        /* no imported catalogues */
    }
    return { ...base, threats, countermeasures };
}

// ---- REST API -------------------------------------------------------------
app.get('/api/risk-schemes', async (_req, res) => {
    const registry = await loadRiskSchemes();
    res.json({
        ...registry,
        fingerprints: Object.fromEntries(registry.schemes.map((scheme) => [scheme.id, fingerprint(scheme)])),
    });
});

app.get('/api/risk-scheme', async (req, res) => {
    try {
        const id = typeof req.query.id === 'string' ? req.query.id : undefined;
        res.json(await loadScheme(id));
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

app.get('/api/kb', async (_req, res) => {
    try {
        res.json(await loadImportableLibrary());
    } catch {
        res.json({ threats: [], countermeasures: [] });
    }
});

app.get('/api/bug-bar', async (_req, res) => {
    try {
        res.json(JSON.parse(await fs.readFile(bugBarPath, 'utf8')));
    } catch {
        res.json({ dimensions: [] });
    }
});

// Full knowledge base for the browse page: library + bug bar + risk scheme + imported catalogues.
app.get('/api/kb/full', async (_req, res) => {
    const readJson = async (p) => {
        try {
            return JSON.parse(await fs.readFile(p, 'utf8'));
        } catch {
            return null;
        }
    };
    const riskSchemes = await loadRiskSchemes();
    const out = {
        library: await readJson(fieldLibraryPath),
        bugBar: await readJson(bugBarPath),
        riskScheme: await readJson(riskSchemePath),
        riskSchemes: riskSchemes.schemes,
        riskSchemeErrors: riskSchemes.errors,
        imported: [],
    };
    try {
        const importedDir = join(knowledgeBaseDir, 'imported');
        for (const e of await fs.readdir(importedDir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const dir = join(importedDir, e.name);
            const files = {};
            for (const f of await fs.readdir(dir).catch(() => [])) if (f.endsWith('.json')) files[f] = await readJson(join(dir, f));
            out.imported.push({ name: e.name, files });
        }
    } catch {
        /* no imported catalogues */
    }
    res.json(out);
});

app.post('/api/kb/git/pull', async (req, res) => res.json(await pullKnowledgeBase(req.body?.url)));
app.delete('/api/kb/imported/:name', async (req, res) => res.json(await removeImportedCatalogue(req.params.name)));
app.get('/api/projects/:id/git/workspace', async (req, res) => res.json(await getProjectWorkspace(req.params.id)));
app.post('/api/projects/:id/git/workspace', async (req, res) => res.json(await prepareProjectWorkspace(req.params.id, req.body || {})));
app.post('/api/projects/:id/git/workspace/verify', async (req, res) => res.json(await verifyProjectWorkspace(req.params.id)));
app.post('/api/projects/:id/git/commit', async (req, res) => res.json(await commitProject(req.params.id, req.body || {})));
app.get('/api/projects/:id/git/status', async (req, res) => res.json(await gitStatus(req.params.id)));

app.get('/api/projects', async (_req, res) => res.json(await listProjects()));

app.get('/api/config', async (_req, res) => {
    const requested = process.env.TRA_PRESELECT_PROJECT || null;
    if (!requested) return res.json({ preselectProjectId: null });
    const projects = await listProjects();
    const isValid = projects.some((p) => p.id === requested);
    res.json({ preselectProjectId: isValid ? requested : null });
});

app.post('/api/projects', async (req, res) => {
    const id = await scaffoldProject(req.body?.name || 'New device');
    broadcastProjects();
    res.json({ id });
});

app.get('/api/projects/:id', async (req, res) => {
    const snapshot = await readProjectWithRevisions(req.params.id);
    res.set('X-Artifact-Revisions', JSON.stringify(snapshot.revisions));
    res.set('Cache-Control', 'no-store');
    res.json(snapshot.data);
});

app.get('/api/projects/:id/change-tracker', async (req, res) => {
    const tracker = await readChangeTracker(req.params.id);
    res.json(tracker);
});

app.post('/api/projects/:id/change-tracker/versions', async (req, res) => {
    try {
        const result = await recordAssessmentVersion(req.params.id, req.body || {});
        if (result.ok && result.project) {
            const revision = await readArtifactRevision(req.params.id, 'project');
            broadcastArtifact(req.params.id, 'project', result.project, revision);
        }
        res.json(result);
    } catch (error) {
        res.status(400).json({ ok: false, error: error?.message || 'Could not record the TRA version.' });
    }
});

app.get('/api/projects/:id/change-tracker/diff', async (req, res) => {
    try {
        const diff = await diffProjectVersions(req.params.id, req.query.from, req.query.to);
        res.json(diff);
    } catch (error) {
        res.status(400).json({ ok: false, error: error?.message || 'Could not compare the requested TRA versions.' });
    }
});

app.put('/api/projects/:id/:step', async (req, res) => {
    const { id, step } = req.params;
    if (!STEP_KEYS.includes(step)) return res.status(400).json({ error: 'unknown step' });
    const ifMatch = req.get('If-Match');
    const baseRevision = ifMatch?.replace(/^W\//, '').replace(/^"|"$/g, '');
    try {
        const result = baseRevision === undefined
            ? await writeArtifactWithRevision(id, step, req.body)
            : await writeArtifactIfRevision(id, step, req.body, baseRevision);
        if (result.ok === false) return res.status(412).json({ error: 'conflict', step, revision: result.revision });
        broadcastArtifact(id, step, req.body, result.revision, null, req.get('X-Client-Id'));
        return res.set('ETag', `"${result.revision}"`).json({ ok: true, revision: result.revision });
    } catch {
        return res.status(500).json({ error: 'save-failed', step });
    }
});

app.post('/api/projects/:id/save-group', async (req, res) => {
    const { id } = req.params;
    const { snapshots, baseRevisions } = req.body || {};
    try {
        const result = await writeArtifactsIfRevisions(id, snapshots, baseRevisions);
        if (result.ok === false) return res.status(412).json({ error: 'conflict', step: result.step, revision: result.revision });
        for (const [step, revision] of Object.entries(result.revisions)) broadcastArtifact(id, step, snapshots[step], revision, null, req.get('X-Client-Id'));
        return res.json({ ok: true, revisions: result.revisions });
    } catch (error) {
        return res.status(400).json({ error: 'save-group-failed', message: error?.message || 'The save group could not be written.' });
    }
});

app.post('/api/projects/:id/validate', async (req, res) => {
    const data = await readProject(req.params.id);
    const resolved = await resolveProjectScheme(data.project);
    res.json({ issues: validate({ ...data, riskScheme: resolved.scheme, riskSchemeWarning: resolved.warning }) });
});

app.post('/api/projects/:id/report', async (req, res) => {
    const { html, issues } = await generateReport(req.params.id);
    res.json({ ok: true, path: `projects/${req.params.id}/report/index.html`, html, issues });
});

// Machine-readable exports for auditors / downstream tooling.
app.get('/api/projects/:id/export/traceability.csv', async (req, res) => {
    const { files } = await buildReport(req.params.id);
    res.type('text/csv').set('Content-Disposition', `attachment; filename="${req.params.id}-traceability.csv"`).send(files['traceability.csv']);
});
app.get('/api/projects/:id/export/traceability.json', async (req, res) => {
    const { files } = await buildReport(req.params.id);
    res.type('application/json').send(files['traceability.json']);
});
app.get('/api/projects/:id/export/sbom.cdx.json', async (req, res) => {
    const { files } = await buildReport(req.params.id);
    if (!files['sbom.cdx.json']) return res.status(404).json({ error: 'CycloneDX SBOM not generated for this project (check the SBOM settings on the Project page).' });
    res.type('application/json').set('Content-Disposition', `attachment; filename="${req.params.id}-sbom.cdx.json"`).send(files['sbom.cdx.json']);
});
app.get('/api/projects/:id/export/sbom.spdx.json', async (req, res) => {
    const { files } = await buildReport(req.params.id);
    if (!files['sbom.spdx.json']) return res.status(404).json({ error: 'SPDX SBOM not generated for this project (check the SBOM settings on the Project page).' });
    res.type('application/json').set('Content-Disposition', `attachment; filename="${req.params.id}-sbom.spdx.json"`).send(files['sbom.spdx.json']);
});

// ---- Static client (production build) -------------------------------------
app.use(express.static(clientDist));
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
    res.sendFile(join(clientDist, 'index.html'), (err) => {
        if (err) res.status(404).send('Client not built yet. Run "npm run build" in tra-webapp.');
    });
});

// ---- HTTP + WebSocket server ----------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
    ws.subscribedId = null;
    ws.clientId = null;
    ws.saveChain = Promise.resolve();
    clients.add(ws);
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (msg.type === 'subscribe') {
            ws.subscribedId = msg.id;
            ws.clientId = typeof msg.clientId === 'string' ? msg.clientId : null;
        } else if (msg.type === 'save-group' && msg.id && msg.snapshots && typeof msg.snapshots === 'object') {
            ws.saveChain = ws.saveChain.then(() => handleSocketSaveGroup(ws, msg)).catch(() => { });
        } else if (msg.type === 'save' && msg.id && STEP_KEYS.includes(msg.step)) {
            ws.saveChain = ws.saveChain.then(() => handleSocketSave(ws, msg)).catch(() => { });
        }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
});

async function handleSocketSave(ws, msg) {
    try {
        const result = typeof msg.baseRevision === 'string'
            ? await writeArtifactIfRevision(msg.id, msg.step, msg.data, msg.baseRevision)
            : await writeArtifactWithRevision(msg.id, msg.step, msg.data);
        if (result.ok === false) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-conflict', id: msg.id, step: msg.step, requestId: msg.requestId ?? null, revision: result.revision }));
            return;
        }
        broadcastArtifact(msg.id, msg.step, msg.data, result.revision, ws);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'saved', id: msg.id, step: msg.step, requestId: msg.requestId ?? null, revision: result.revision }));
    } catch {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-error', id: msg.id, step: msg.step, requestId: msg.requestId ?? null, message: 'The artifact could not be saved.' }));
    }
}

async function handleSocketSaveGroup(ws, msg) {
    try {
        const result = await writeArtifactsIfRevisions(msg.id, msg.snapshots, msg.baseRevisions);
        if (result.ok === false) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-group-conflict', id: msg.id, requestId: msg.requestId ?? null, step: result.step, revision: result.revision }));
            return;
        }
        for (const [step, revision] of Object.entries(result.revisions)) broadcastArtifact(msg.id, step, msg.snapshots[step], revision, ws);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'saved-group', id: msg.id, requestId: msg.requestId ?? null, revisions: result.revisions }));
    } catch {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'save-group-error', id: msg.id, requestId: msg.requestId ?? null, message: 'The save group could not be saved.' }));
    }
}

function broadcastArtifact(id, step, data, revision, except = null, exceptClientId = null) {
    const payload = JSON.stringify({ type: 'artifact', id, step, data, revision });
    for (const ws of clients) {
        if (ws !== except && (!exceptClientId || ws.clientId !== exceptClientId) && ws.readyState === 1 && ws.subscribedId === id) ws.send(payload);
    }
}
function broadcastProjects() {
    const payload = JSON.stringify({ type: 'projects-changed' });
    for (const ws of clients) if (ws.readyState === 1) ws.send(payload);
}

// ---- File watcher: external edits -> live UI update -----------------------
const watcher = chokidar.watch(projectsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
});
watcher.on('all', async (event, path) => {
    if (!path.endsWith('.json')) return;
    if (event !== 'add' && event !== 'change') return;
    const loc = pathToStep(path);
    if (!loc) return;
    let txt;
    try {
        txt = await fs.readFile(path, 'utf8');
    } catch {
        return;
    }
    if (!isExternalChange(path, txt)) return; // our own write — ignore the echo
    const revision = recordHash(path, txt);
    let data;
    try {
        data = JSON.parse(txt);
    } catch {
        return; // half-written / invalid JSON during manual editing — skip until valid
    }
    broadcastArtifact(loc.id, loc.step, data, revision);
    if (loc.step === 'project') broadcastProjects();
});

// Bind to 0.0.0.0 so the app is reachable from outside the VM (e.g. the Windows host),
// not only from localhost inside the VM. Override the interface with HOST if needed.
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    const lan = Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address);
    console.log(`TRA web app listening on http://${HOST}:${PORT}`);
    console.log(`  local:   http://localhost:${PORT}`);
    for (const ip of lan) console.log(`  network: http://${ip}:${PORT}  (reachable from the host)`);
    console.log(`Projects directory: ${projectsDir}`);
});
