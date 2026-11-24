const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const backoff = [1000, 2000, 5000, 10000];

/**
 * @param {{
 *   send: (entry: any, signal: AbortSignal) => unknown,
 *   onChange?: (state: { connected: boolean, entries: any[] }) => void,
 *   now?: () => number,
 *   setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>,
 *   clearTimer?: (timer: ReturnType<typeof setTimeout>) => void,
 *   ackTimeoutMs?: number,
 *   debounceMs?: number,
 * }} options
 */
export function createSaveQueue({
    send,
    onChange = () => { },
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    ackTimeoutMs = 10000,
    debounceMs = 0,
} = {}) {
    if (typeof send !== 'function') throw new TypeError('Save queue requires a send function.');

    const entries = [];
    const waiters = [];
    const debounceTimers = new Map();
    let connected = true;
    let inFlight = null;
    let sequence = 0;
    let ackTimer = null;
    let retryTimer = null;
    let inFlightController = null;

    const ordered = () => entries.sort((left, right) => left.orderSequence - right.orderSequence);
    const matching = (projectId) => entries.filter((entry) => entry.projectId === projectId);
    const makeRequestId = (entry) => `${entry.projectId}:${entry.sequence}:${now()}`;

    function getSummary(projectId) {
        const pending = matching(projectId);
        const retryTimes = pending.map((entry) => entry.state === 'retry-wait' ? entry.nextRetryAt : null).filter(Number.isFinite);
        return {
            connected,
            pendingCount: pending.length,
            inFlight: pending.some((entry) => entry.state === 'in-flight'),
            debouncing: pending.some((entry) => entry.state === 'debouncing'),
            hasConflict: pending.some((entry) => entry.state === 'conflict'),
            oldestUnsavedAt: pending.length ? Math.min(...pending.map((entry) => entry.createdAt)) : null,
            nextRetryAt: retryTimes.length ? Math.min(...retryTimes) : null,
        };
    }

    function notify() {
        const snapshot = entries.map((entry) => copy(entry));
        onChange({ connected, entries: snapshot });
        for (let index = waiters.length - 1; index >= 0; index--) {
            const waiter = waiters[index];
            const pending = matching(waiter.projectId);
            if (!pending.length || pending.some((entry) => entry.state === 'conflict')) {
                waiters.splice(index, 1);
                waiter.resolve(!pending.length);
            }
        }
    }

    function clearAckTimer() {
        if (ackTimer !== null) clearTimer(ackTimer);
        ackTimer = null;
    }

    function clearRetryTimer() {
        if (retryTimer !== null) clearTimer(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry(entry) {
        clearRetryTimer();
        if (!connected || entry.state !== 'retry-wait' || !Number.isFinite(entry.nextRetryAt)) return;
        retryTimer = setTimer(() => {
            retryTimer = null;
            if (entry.state !== 'retry-wait') return;
            entry.state = 'queued';
            entry.nextRetryAt = null;
            notify();
            pump();
        }, Math.max(0, entry.nextRetryAt - now()));
    }

    function retryAfterFailure(entry, message) {
        if (inFlight !== entry) return;
        clearAckTimer();
        inFlightController?.abort();
        inFlightController = null;
        inFlight = null;
        entry.state = 'retry-wait';
        entry.error = message || 'The save request failed.';
        const delay = backoff[Math.min(entry.attempts, backoff.length - 1)];
        entry.attempts++;
        entry.nextRetryAt = now() + delay;
        notify();
        scheduleRetry(entry);
        pump();
    }

    function markConflict(entry, conflict) {
        if (inFlight === entry) {
            clearAckTimer();
            inFlightController?.abort();
            inFlightController = null;
            inFlight = null;
        }
        entry.state = 'conflict';
        entry.nextRetryAt = null;
        entry.conflict = copy(conflict || {});
        entry.requestId = null;
        notify();
        pump();
    }

    function completeIfAcknowledged(entry) {
        if (!entry.steps.every((step) => Object.hasOwn(entry.acknowledgedRevisions, step))) return false;
        clearAckTimer();
        if (inFlight === entry) inFlight = null;
        entries.splice(entries.indexOf(entry), 1);
        notify();
        pump();
        return true;
    }

    function handleTransportResult(entry, result) {
        if (inFlight !== entry) return;
        if (result?.conflict) {
            markConflict(entry, result);
            return;
        }
        if (result?.ok && result.revisions) {
            for (const step of entry.steps) ackStep({ requestId: entry.requestId, step, revision: result.revisions[step] });
        }
    }

    function pump() {
        if (!connected || inFlight) return;
        const entry = ordered()[0];
        if (!entry || entry.state === 'conflict') return;
        if (entry.state === 'retry-wait') {
            scheduleRetry(entry);
            return;
        }
        if (entry.state !== 'queued') return;

        entry.state = 'in-flight';
        entry.requestId = makeRequestId(entry);
        entry.acknowledgedRevisions = {};
        inFlight = entry;
        inFlightController = new AbortController();
        const signal = inFlightController.signal;
        ackTimer = setTimer(() => retryAfterFailure(entry, 'Save acknowledgement timed out.'), ackTimeoutMs);
        notify();

        try {
            const attemptRequestId = entry.requestId;
            const result = send(copy(entry), signal);
            if (result && typeof result.then === 'function') {
                result.then((value) => {
                    if (entry.requestId === attemptRequestId) handleTransportResult(entry, value);
                }).catch((error) => {
                    if (entry.requestId === attemptRequestId) retryAfterFailure(entry, error?.message);
                });
            } else if (result?.conflict || result?.ok) {
                handleTransportResult(entry, result);
            }
        } catch (error) {
            retryAfterFailure(entry, error?.message);
        }
    }

    function enqueue({ projectId, groupId, snapshots, baseRevisions }) {
        if (!projectId || !groupId || !snapshots || !Object.keys(snapshots).length) throw new TypeError('A save group needs a project, group id, and snapshots.');
        const nextSequence = ++sequence;
        const nextSnapshots = copy(snapshots);
        const nextSteps = Object.keys(nextSnapshots);
        const overlaps = entries.filter((entry) => entry.projectId === projectId
            && ['debouncing', 'queued', 'retry-wait'].includes(entry.state)
            && entry.steps.some((step) => nextSteps.includes(step)));
        const earliest = overlaps.length ? Math.min(...overlaps.map((entry) => entry.orderSequence)) : nextSequence;
        const mergedSnapshots = {};
        const mergedRevisions = {};
        const groupIds = new Set([groupId]);
        for (const entry of overlaps) {
            Object.assign(mergedSnapshots, entry.snapshots);
            Object.assign(mergedRevisions, entry.baseRevisions);
            for (const id of entry.groupIds) groupIds.add(id);
        }
        Object.assign(mergedSnapshots, nextSnapshots);
        for (const step of nextSteps) {
            if (!Object.hasOwn(mergedRevisions, step)) mergedRevisions[step] = baseRevisions?.[step];
        }
        for (const entry of overlaps) {
            const timer = debounceTimers.get(entry.sequence);
            if (timer !== undefined) clearTimer(timer);
            debounceTimers.delete(entry.sequence);
            entries.splice(entries.indexOf(entry), 1);
        }
        const steps = Object.keys(mergedSnapshots);
        const entry = {
            projectId,
            groupId: [...groupIds].join('+'),
            groupIds: [...groupIds],
            orderSequence: earliest,
            sequence: nextSequence,
            steps,
            snapshots: mergedSnapshots,
            baseRevisions: mergedRevisions,
            state: debounceMs > 0 ? 'debouncing' : 'queued',
            requestId: null,
            createdAt: overlaps.length ? Math.min(...overlaps.map((item) => item.createdAt), now()) : now(),
            attempts: 0,
            nextRetryAt: null,
            debounceAt: debounceMs > 0 ? now() + debounceMs : null,
            acknowledgedRevisions: {},
            conflict: null,
            error: null,
        };
        entries.push(entry);
        ordered();
        notify();
        if (debounceMs > 0) {
            const timer = setTimer(() => {
                debounceTimers.delete(entry.sequence);
                if (entry.state !== 'debouncing') return;
                entry.state = 'queued';
                entry.debounceAt = null;
                notify();
                pump();
            }, debounceMs);
            debounceTimers.set(entry.sequence, timer);
        } else {
            pump();
        }
        return entry.sequence;
    }

    function ackStep({ requestId, step, revision }) {
        const entry = inFlight;
        if (!entry || entry.requestId !== requestId || !entry.steps.includes(step) || typeof revision !== 'string') return false;
        const previousRevision = entry.baseRevisions[step];
        entry.acknowledgedRevisions[step] = revision;
        entry.baseRevisions[step] = revision;
        for (const pending of entries) {
            if (pending.projectId !== entry.projectId || pending.sequence <= entry.sequence || pending.state === 'conflict') continue;
            if (pending.steps.includes(step) && pending.baseRevisions[step] === previousRevision) pending.baseRevisions[step] = revision;
        }
        return completeIfAcknowledged(entry) || (notify(), true);
    }

    function ackGroup({ requestId, revisions }) {
        const entry = inFlight;
        if (!entry || entry.requestId !== requestId || !entry.steps.every((step) => typeof revisions?.[step] === 'string')) return false;
        for (const step of entry.steps) {
            const previousRevision = entry.baseRevisions[step];
            const revision = revisions[step];
            entry.acknowledgedRevisions[step] = revision;
            entry.baseRevisions[step] = revision;
            for (const pending of entries) {
                if (pending.projectId !== entry.projectId || pending.sequence <= entry.sequence || pending.state === 'conflict') continue;
                if (pending.steps.includes(step) && pending.baseRevisions[step] === previousRevision) pending.baseRevisions[step] = revision;
            }
        }
        return completeIfAcknowledged(entry) || (notify(), true);
    }

    function fail({ requestId, message }) {
        if (!inFlight || inFlight.requestId !== requestId) return false;
        retryAfterFailure(inFlight, message);
        return true;
    }

    function conflict({ requestId, step, revision, remoteData, remoteRevisions }) {
        if (!inFlight || inFlight.requestId !== requestId) return false;
        markConflict(inFlight, { step, revision, remoteData, remoteRevisions });
        return true;
    }

    function disconnect() {
        connected = false;
        clearAckTimer();
        clearRetryTimer();
        for (const entry of entries) {
            const timer = debounceTimers.get(entry.sequence);
            if (timer !== undefined) clearTimer(timer);
            debounceTimers.delete(entry.sequence);
            if (entry.state === 'debouncing') {
                entry.state = 'queued';
                entry.debounceAt = null;
            }
        }
        if (inFlight) {
            inFlightController?.abort();
            inFlightController = null;
            inFlight.state = 'retry-wait';
            inFlight.requestId = null;
            inFlight.nextRetryAt = null;
            inFlight = null;
        }
        notify();
    }

    function reconcile(projectId, remote) {
        connected = true;
        for (const entry of matching(projectId)) {
            const alreadySaved = entry.steps.every((step) => equal(remote.data?.[step], entry.snapshots[step]));
            if (alreadySaved) {
                entries.splice(entries.indexOf(entry), 1);
                continue;
            }
            const unchanged = entry.steps.every((step) => remote.revisions?.[step] === entry.baseRevisions[step]);
            if (unchanged) {
                entry.state = 'queued';
                entry.requestId = null;
                entry.nextRetryAt = null;
                entry.error = null;
            } else {
                entry.state = 'conflict';
                entry.requestId = null;
                entry.nextRetryAt = null;
                entry.conflict = { remoteData: copy(remote.data), remoteRevisions: copy(remote.revisions) };
            }
        }
        notify();
        pump();
    }

    function remoteChange(projectId, step, remote) {
        const entry = matching(projectId).find((item) => item.steps.includes(step) && item.state !== 'conflict');
        if (!entry) return false;
        if (inFlight === entry) {
            clearAckTimer();
            inFlightController?.abort();
            inFlightController = null;
            inFlight = null;
        }
        entry.state = 'conflict';
        entry.requestId = null;
        entry.nextRetryAt = null;
        entry.conflict = {
            ...copy(remote),
            step,
            remoteRevisions: { ...entry.baseRevisions, ...(remote?.remoteRevisions || {}) },
        };
        notify();
        pump();
        return true;
    }

    function retry(projectId) {
        if (!connected) return false;
        let changed = false;
        for (const entry of matching(projectId)) {
            if (entry.state !== 'retry-wait') continue;
            entry.state = 'queued';
            entry.attempts = 0;
            entry.nextRetryAt = null;
            entry.error = null;
            changed = true;
        }
        if (changed) {
            clearRetryTimer();
            notify();
            pump();
        }
        return changed;
    }

    function resolveConflict(projectId, sequenceId, choice, remote) {
        const entry = matching(projectId).find((item) => item.sequence === sequenceId && item.state === 'conflict');
        if (!entry || !['keep-local', 'accept-remote'].includes(choice)) return false;
        if (choice === 'accept-remote') {
            entries.splice(entries.indexOf(entry), 1);
            notify();
            pump();
            return { accepted: true, remoteData: copy(remote?.data || entry.conflict?.remoteData), steps: [...entry.steps] };
        }
        entry.baseRevisions = copy(remote?.revisions || entry.conflict?.remoteRevisions || {});
        entry.state = 'queued';
        entry.conflict = null;
        entry.requestId = null;
        entry.attempts = 0;
        entry.nextRetryAt = null;
        entry.error = null;
        notify();
        pump();
        return true;
    }

    function flushOrHold(projectId) {
        for (const entry of matching(projectId)) {
            if (entry.state !== 'debouncing') continue;
            const timer = debounceTimers.get(entry.sequence);
            if (timer !== undefined) clearTimer(timer);
            debounceTimers.delete(entry.sequence);
            entry.state = 'queued';
            entry.debounceAt = null;
        }
        notify();
        pump();
        const pending = matching(projectId);
        if (!pending.length) return Promise.resolve(true);
        if (pending.some((entry) => entry.state === 'conflict')) return Promise.resolve(false);
        return new Promise((resolve) => waiters.push({ projectId, resolve }));
    }

    function discard(projectId) {
        if (inFlight?.projectId === projectId) return false;
        for (let index = entries.length - 1; index >= 0; index--) {
            if (entries[index].projectId === projectId) {
                const timer = debounceTimers.get(entries[index].sequence);
                if (timer !== undefined) clearTimer(timer);
                debounceTimers.delete(entries[index].sequence);
                entries.splice(index, 1);
            }
        }
        clearRetryTimer();
        notify();
        pump();
        return true;
    }

    return {
        enqueue,
        ackStep,
        ackGroup,
        fail,
        conflict,
        disconnect,
        reconcile,
        remoteChange,
        retry,
        resolveConflict,
        flushOrHold,
        discard,
        getSummary,
        getEntries: (projectId) => matching(projectId).map((entry) => copy(entry)),
        getAllEntries: () => entries.map((entry) => copy(entry)),
    };
}