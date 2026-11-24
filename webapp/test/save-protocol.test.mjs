import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createUxHarness } from './lib/ux-harness.mjs';

const projectId = 'RL-100';
const harness = await createUxHarness();
const sockets = [];

function parseRevisions(response) {
    const header = response.headers.get('x-artifact-revisions');
    assert.ok(header, 'Project response should include X-Artifact-Revisions.');
    return JSON.parse(header);
}

async function getProject() {
    const response = await fetch(`${harness.baseUrl}/api/projects/${projectId}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    return { data, revisions: parseRevisions(response) };
}

async function openSocket(clientId) {
    const url = `${harness.baseUrl.replace(/^http/, 'ws')}/ws`;
    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', id: projectId, clientId }));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    return socket;
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('message', onMessage);
            reject(new Error('Timed out waiting for a WebSocket protocol message.'));
        }, timeoutMs);
        const onMessage = (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (!predicate(message)) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message);
        };
        socket.on('message', onMessage);
    });
}

function expectNoMessage(socket, predicate, timeoutMs = 200) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off('message', onMessage);
            resolve();
        }, timeoutMs);
        const onMessage = (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (!predicate(message)) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            reject(new Error(`Unexpected WebSocket message: ${JSON.stringify(message)}`));
        };
        socket.on('message', onMessage);
    });
}

async function putStep(step, data, headers = {}) {
    return fetch(`${harness.baseUrl}/api/projects/${projectId}/${step}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(data),
    });
}

try {
    const client = await openSocket('protocol-client');
    const peer = await openSocket('protocol-peer');

    const initial = await getProject();
    assert.match(initial.revisions.threats, /^[a-f0-9]{40}$/);

    const firstData = { threats: [{ id: 'T-PROTOCOL-1', title: 'Matching revision save' }] };
    const peerFirst = waitForMessage(peer, (message) => message.type === 'artifact' && message.data?.threats?.[0]?.id === 'T-PROTOCOL-1');
    const noRestEcho = expectNoMessage(client, (message) => message.type === 'artifact' && message.data?.threats?.[0]?.id === 'T-PROTOCOL-1');
    const matching = await putStep('threats', firstData, {
        'if-match': `"${initial.revisions.threats}"`,
        'x-client-id': 'protocol-client',
    });
    assert.equal(matching.status, 200);
    const matchingBody = await matching.json();
    assert.equal(matchingBody.revision, matching.headers.get('etag')?.replaceAll('"', ''));
    assert.equal((await peerFirst).revision, matchingBody.revision);
    await noRestEcho;

    const stale = await putStep('threats', { threats: [{ id: 'T-STALE', title: 'Must not overwrite' }] }, {
        'if-match': initial.revisions.threats,
    });
    assert.equal(stale.status, 412);
    assert.equal((await stale.json()).error, 'conflict');
    assert.equal((await getProject()).data.threats.threats[0].id, 'T-PROTOCOL-1');

    const beforeGroup = await getProject();
    const groupSnapshots = {
        system: { ...beforeGroup.data.system, testGroupMarker: true },
        dfd: beforeGroup.data.dfd,
    };
    const groupConflict = await fetch(`${harness.baseUrl}/api/projects/${projectId}/save-group`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            snapshots: groupSnapshots,
            baseRevisions: { system: beforeGroup.revisions.system, dfd: 'stale-revision' },
        }),
    });
    assert.equal(groupConflict.status, 412, 'A stale member must reject the entire group.');
    assert.equal((await groupConflict.json()).step, 'dfd');
    const afterGroupConflict = await getProject();
    assert.deepEqual(afterGroupConflict.revisions, beforeGroup.revisions, 'No group member may be written when any base revision is stale.');
    assert.equal(afterGroupConflict.data.system.testGroupMarker, undefined);

    const matchingGroup = await fetch(`${harness.baseUrl}/api/projects/${projectId}/save-group`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshots: { system: beforeGroup.data.system, dfd: beforeGroup.data.dfd }, baseRevisions: beforeGroup.revisions }),
    });
    assert.equal(matchingGroup.status, 200);
    assert.ok((await matchingGroup.json()).revisions.dfd);

    const sharedRevision = (await getProject()).revisions.threats;
    const concurrent = await Promise.all([
        putStep('threats', { threats: [{ id: 'T-RACE-A', title: 'Concurrent A' }] }, { 'if-match': sharedRevision }),
        putStep('threats', { threats: [{ id: 'T-RACE-B', title: 'Concurrent B' }] }, { 'if-match': sharedRevision }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 412]);

    const externalPath = join(harness.projectsDir, projectId, '06-threats', 'threats.json');
    const watcherUpdate = { threats: [{ id: 'T-EXTERNAL', title: 'External edit' }] };
    const externalBroadcast = waitForMessage(peer, (message) => message.type === 'artifact' && message.data?.threats?.[0]?.id === 'T-EXTERNAL');
    await writeFile(externalPath, `${JSON.stringify(watcherUpdate, null, 2)}\n`);
    const externalMessage = await externalBroadcast;
    assert.match(externalMessage.revision, /^[a-f0-9]{40}$/);
    assert.equal((await getProject()).revisions.threats, externalMessage.revision);

    const beforeWebSocketSave = await getProject();
    const requirementsData = { requirements: [{ id: 'REQ-PROTOCOL', text: 'WebSocket revision ack' }] };
    const peerWebSocketUpdate = waitForMessage(peer, (message) => message.type === 'artifact' && message.data?.requirements?.[0]?.id === 'REQ-PROTOCOL');
    const wsAck = waitForMessage(client, (message) => message.type === 'saved' && message.requestId === 'request-success');
    client.send(JSON.stringify({
        type: 'save',
        id: projectId,
        step: 'requirements',
        requestId: 'request-success',
        baseRevision: beforeWebSocketSave.revisions.requirements,
        data: requirementsData,
    }));
    const savedMessage = await wsAck;
    assert.equal(savedMessage.step, 'requirements');
    assert.match(savedMessage.revision, /^[a-f0-9]{40}$/);
    assert.equal((await peerWebSocketUpdate).revision, savedMessage.revision);

    const groupedSnapshot = await getProject();
    const groupRequestId = 'request-group-order';
    const groupAck = waitForMessage(client, (message) => message.type === 'saved-group' && message.requestId === groupRequestId);
    client.send(JSON.stringify({
        type: 'save-group',
        id: projectId,
        requestId: groupRequestId,
        baseRevisions: { system: groupedSnapshot.revisions.system, dfd: groupedSnapshot.revisions.dfd },
        snapshots: { system: groupedSnapshot.data.system, dfd: groupedSnapshot.data.dfd },
    }));
    assert.deepEqual(Object.keys((await groupAck).revisions).sort(), ['dfd', 'system']);

    const groupConflictAck = waitForMessage(client, (message) => message.type === 'save-group-conflict' && message.requestId === 'request-group-conflict');
    client.send(JSON.stringify({
        type: 'save-group',
        id: projectId,
        requestId: 'request-group-conflict',
        baseRevisions: { system: groupedSnapshot.revisions.system, dfd: 'old-dfd-revision' },
        snapshots: { system: { ...groupedSnapshot.data.system, mustNotWrite: true }, dfd: groupedSnapshot.data.dfd },
    }));
    assert.equal((await groupConflictAck).step, 'dfd');
    assert.equal((await getProject()).data.system.mustNotWrite, undefined, 'A conflict in one group member must not write other members.');

    const staleWsConflict = waitForMessage(client, (message) => message.type === 'save-conflict' && message.requestId === 'request-conflict');
    client.send(JSON.stringify({
        type: 'save',
        id: projectId,
        step: 'requirements',
        requestId: 'request-conflict',
        baseRevision: beforeWebSocketSave.revisions.requirements,
        data: { requirements: [{ id: 'REQ-STALE', text: 'Must not overwrite' }] },
    }));
    assert.equal((await staleWsConflict).revision, savedMessage.revision);

    const absentPath = join(harness.projectsDir, projectId, '09-defects', 'defects.json');
    await rm(absentPath, { force: true });
    assert.equal((await getProject()).revisions.defects, 'absent');
    const legacyWrite = await putStep('defects', { defects: [] });
    assert.equal(legacyWrite.status, 200, 'A PUT without If-Match must remain unconditional.');
    assert.match((await legacyWrite.json()).revision, /^[a-f0-9]{40}$/);

    await rm(absentPath, { force: true });
    await mkdir(absentPath);
    const writeError = waitForMessage(client, (message) => message.type === 'save-error' && message.requestId === 'request-error');
    client.send(JSON.stringify({
        type: 'save',
        id: projectId,
        step: 'defects',
        requestId: 'request-error',
        baseRevision: 'absent',
        data: { defects: [] },
    }));
    assert.equal((await writeError).message, 'The artifact could not be saved.');

    console.log('save protocol tests passed');
} finally {
    for (const socket of sockets) socket.close();
    await harness.cleanup();
}