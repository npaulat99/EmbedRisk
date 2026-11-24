import assert from 'node:assert/strict';
import { createSaveQueue } from '../client/src/state/saveQueue.js';

function createFakeTimers() {
    let nextId = 0;
    let time = 0;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, at: time + delay });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        advance(ms) {
            const end = time + ms;
            while (true) {
                const next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
                if (!next || next[1].at > end) break;
                time = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
            }
            time = end;
        },
    };
}

function testQueuedGroupsCoalesceAndKeepTheirProjectSnapshot() {
    const timers = createFakeTimers();
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry), now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    queue.disconnect();
    const first = { project: { title: 'A' }, system: { name: 'A' }, dfd: { nodes: [] } };
    queue.enqueue({ projectId: 'PROJECT-A', groupId: 'project', snapshots: first, baseRevisions: { project: 'p0', system: 's0', dfd: 'd0' } });
    first.project.title = 'mutated after enqueue';
    const second = { system: { name: 'B' }, dfd: { nodes: [{ id: 'N-1' }] } };
    queue.enqueue({ projectId: 'PROJECT-A', groupId: 'system', snapshots: second, baseRevisions: { system: 's0', dfd: 'd0' } });
    queue.enqueue({ projectId: 'PROJECT-B', groupId: 'system', snapshots: { system: { name: 'other project' } }, baseRevisions: { system: 'other-s0' } });

    const [merged] = queue.getEntries('PROJECT-A');
    assert.deepEqual(merged.steps, ['project', 'system', 'dfd']);
    assert.equal(merged.snapshots.project.title, 'A');
    assert.deepEqual(merged.snapshots.dfd.nodes, [{ id: 'N-1' }]);
    assert.equal(queue.getEntries('PROJECT-B')[0].snapshots.system.name, 'other project');
    assert.equal(sent.length, 0, 'Disconnected entries must remain held without sending.');
}

function testDebounceCoalescesCapturedProjectSnapshots() {
    const timers = createFakeTimers();
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry), now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, debounceMs: 160 });
    const first = { project: { title: 'first' } };
    queue.enqueue({ projectId: 'P1', groupId: 'project', snapshots: first, baseRevisions: { project: 'p0' } });
    first.project.title = 'mutated after enqueue';
    queue.enqueue({ projectId: 'P1', groupId: 'project', snapshots: { project: { title: 'latest' } }, baseRevisions: { project: 'p0' } });
    queue.enqueue({ projectId: 'P2', groupId: 'project', snapshots: { project: { title: 'separate project' } }, baseRevisions: { project: 'other-p0' } });
    assert.equal(queue.getEntries('P1').length, 1);
    assert.equal(queue.getEntries('P1')[0].state, 'debouncing');
    timers.advance(159);
    assert.equal(sent.length, 0);
    timers.advance(1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].projectId, 'P1');
    assert.equal(sent[0].snapshots.project.title, 'latest');
    queue.ackStep({ requestId: sent[0].requestId, step: 'project', revision: 'p1' });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].projectId, 'P2');
    assert.equal(sent[1].snapshots.project.title, 'separate project');
    queue.ackStep({ requestId: sent[1].requestId, step: 'project', revision: 'other-p1' });
}

function testSingleInflightAndCreationOrder() {
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry) });
    const first = queue.enqueue({ projectId: 'P', groupId: 'project', snapshots: { project: { title: 'one' } }, baseRevisions: { project: 'p0' } });
    queue.enqueue({ projectId: 'P', groupId: 'threats', snapshots: { threats: { threats: [] } }, baseRevisions: { threats: 't0' } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sequence, first);
    assert.equal(sent[0].state, 'in-flight');
    queue.ackStep({ requestId: sent[0].requestId, step: 'project', revision: 'p1' });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].groupId, 'threats');
    queue.ackStep({ requestId: sent[1].requestId, step: 'threats', revision: 't1' });
}

function testInFlightGroupCannotBeDiscarded() {
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry) });
    queue.enqueue({ projectId: 'P', groupId: 'project', snapshots: { project: { title: 'possible server commit' } }, baseRevisions: { project: 'p0' } });
    assert.equal(queue.discard('P'), false);
    assert.equal(queue.getSummary('P').inFlight, true);
    queue.ackStep({ requestId: sent[0].requestId, step: 'project', revision: 'p1' });
    assert.equal(queue.getSummary('P').pendingCount, 0);
}

function testStaleAndDuplicateAcknowledgementsAreIgnored() {
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry) });
    queue.enqueue({ projectId: 'P', groupId: 'system-dfd', snapshots: { system: {}, dfd: {} }, baseRevisions: { system: 's0', dfd: 'd0' } });
    const requestId = sent[0].requestId;
    assert.equal(queue.ackStep({ requestId: 'old-request', step: 'system', revision: 's1' }), false);
    assert.equal(queue.ackStep({ requestId, step: 'system', revision: 's1' }), true);
    assert.equal(queue.getSummary('P').pendingCount, 1, 'A partial group ack must not clear the group.');
    assert.equal(queue.ackStep({ requestId, step: 'system', revision: 's1-late' }), true);
    assert.equal(queue.ackStep({ requestId, step: 'dfd', revision: 'd1' }), true);
    assert.equal(queue.getSummary('P').pendingCount, 0);
    assert.equal(queue.ackStep({ requestId, step: 'dfd', revision: 'd1' }), false, 'A duplicate ack after completion must be ignored.');
}

function testTimeoutBackoffAndManualRetry() {
    const timers = createFakeTimers();
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry), now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, ackTimeoutMs: 100 });
    queue.enqueue({ projectId: 'P', groupId: 'project', snapshots: { project: {} }, baseRevisions: { project: 'p0' } });
    timers.advance(100);
    assert.equal(queue.getEntries('P')[0].state, 'retry-wait');
    assert.equal(queue.getSummary('P').nextRetryAt, 1100);
    timers.advance(1000);
    assert.equal(sent.length, 2);
    assert.equal(queue.getEntries('P')[0].state, 'in-flight');
    queue.disconnect();
    assert.equal(queue.getEntries('P')[0].state, 'retry-wait');
    assert.equal(queue.retry('P'), false, 'Retry stays held until the connection returns and revisions reconcile.');
}

async function testLateTransportResponseCannotAckNewAttempt() {
    const timers = createFakeTimers();
    const requests = [];
    const queue = createSaveQueue({
        send: (entry) => new Promise((resolve) => requests.push({ entry, resolve })),
        now: timers.now,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        ackTimeoutMs: 100,
    });
    queue.enqueue({ projectId: 'P', groupId: 'project', snapshots: { project: { title: 'latest' } }, baseRevisions: { project: 'p0' } });
    const firstRequestId = requests[0].entry.requestId;
    timers.advance(100);
    timers.advance(1000);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[1].entry.requestId, firstRequestId);
    requests[0].resolve({ ok: true, revisions: { project: 'p1-stale' } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(queue.getEntries('P')[0].requestId, requests[1].entry.requestId);
    assert.equal(queue.getEntries('P')[0].state, 'in-flight');
    requests[1].resolve({ ok: true, revisions: { project: 'p1-current' } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(queue.getSummary('P').pendingCount, 0);
}

function testReconnectReconcilesAndDetectsConflicts() {
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry) });
    const sequence = queue.enqueue({ projectId: 'P', groupId: 'threats', snapshots: { threats: { threats: [{ id: 'T-1' }] } }, baseRevisions: { threats: 't0' } });
    queue.disconnect();
    queue.reconcile('P', { data: { threats: { threats: [{ id: 'T-1' }] } }, revisions: { threats: 't1' } });
    assert.equal(queue.getSummary('P').pendingCount, 0, 'A lost ack is reconciled when the remote snapshot already matches.');

    queue.disconnect();
    const conflictSequence = queue.enqueue({ projectId: 'P', groupId: 'threats', snapshots: { threats: { threats: [{ id: 'T-2' }] } }, baseRevisions: { threats: 't1' } });
    queue.disconnect();
    queue.reconcile('P', { data: { threats: { threats: [{ id: 'T-remote' }] } }, revisions: { threats: 't2' } });
    assert.equal(queue.getSummary('P').hasConflict, true);
    assert.equal(sent.length, 1, 'A conflict is never retried automatically.');
    assert.equal(queue.resolveConflict('P', conflictSequence, 'keep-local', { revisions: { threats: 't2' } }), true);
    assert.equal(sent.length, 2, 'Keeping local rebases and sends the group.');
    assert.equal(sent[1].baseRevisions.threats, 't2');
    queue.ackStep({ requestId: sent[1].requestId, step: 'threats', revision: 't3' });
    assert.ok(sequence < conflictSequence);
}

function testAcceptRemoteAndDiscardAreProjectScoped() {
    const sent = [];
    const queue = createSaveQueue({ send: (entry) => sent.push(entry) });
    queue.disconnect();
    const sequence = queue.enqueue({ projectId: 'P1', groupId: 'dfd', snapshots: { dfd: { nodes: [] } }, baseRevisions: { dfd: 'd0' } });
    queue.enqueue({ projectId: 'P2', groupId: 'dfd', snapshots: { dfd: { nodes: [{ id: 'other' }] } }, baseRevisions: { dfd: 'other-d0' } });
    queue.reconcile('P1', { data: { dfd: { nodes: [{ id: 'remote' }] } }, revisions: { dfd: 'd1' } });
    queue.disconnect();
    const accepted = queue.resolveConflict('P1', sequence, 'accept-remote');
    assert.deepEqual(accepted.steps, ['dfd']);
    assert.deepEqual(accepted.remoteData.dfd.nodes, [{ id: 'remote' }]);
    assert.equal(queue.discard('P2'), true);
    assert.equal(queue.getSummary('P1').pendingCount, 0);
    assert.equal(queue.getSummary('P2').pendingCount, 0);
}

testQueuedGroupsCoalesceAndKeepTheirProjectSnapshot();
testDebounceCoalescesCapturedProjectSnapshots();
testSingleInflightAndCreationOrder();
testInFlightGroupCannotBeDiscarded();
testStaleAndDuplicateAcknowledgementsAreIgnored();
testTimeoutBackoffAndManualRetry();
await testLateTransportResponseCannotAckNewAttempt();
testReconnectReconcilesAndDetectsConflicts();
testAcceptRemoteAndDiscardAreProjectScoped();
console.log('save queue tests passed');