import { useStore } from '../state/store';
import AppDialog from './AppDialog';

const STEP_LABELS: Record<string, string> = {
    project: 'Project',
    assumptions: 'Assumptions',
    system: 'System & Assets',
    dfd: 'Data Flow Diagram',
    useCases: 'Scenarios & diagrams',
    threats: 'Threats',
    requirements: 'Requirements',
    countermeasures: 'Countermeasures',
    attackTrees: 'Attack trees',
    defects: 'Defects',
};

export default function SaveSyncDialogs() {
    const activeId = useStore((state) => state.activeId);
    const projects = useStore((state) => state.projects);
    const entries = useStore((state) => state.syncQueueEntries);
    const pendingSwitchId = useStore((state) => state.pendingProjectSwitchId);
    const conflictVisible = useStore((state) => state.syncConflictVisible);
    const resolveConflict = useStore((state) => state.resolveSaveConflict);
    const setConflictVisible = useStore((state) => state.setSyncConflictVisible);
    const cancelProjectSwitch = useStore((state) => state.cancelProjectSwitch);
    const waitAndSwitch = useStore((state) => state.waitAndSwitchProject);
    const discardAndSwitch = useStore((state) => state.discardAndSwitchProject);
    const conflict = entries.find((entry) => entry.state === 'conflict') || null;
    const showConflict = !!conflict && conflictVisible;
    const conflictStep = conflict?.conflict?.step || conflict?.steps?.[0] || 'project';
    const conflictSteps = conflict?.steps || [conflictStep];
    const switchTarget = projects.find((project) => project.id === pendingSwitchId);
    const unsyncedGroups = useStore((state) => state.syncSummary.pendingCount);
    const saveInFlight = useStore((state) => state.syncSummary.inFlight);

    return (
        <>
            <AppDialog
                open={showConflict}
                onClose={() => setConflictVisible(false)}
                title={`Sync conflict: ${STEP_LABELS[conflictStep] || conflictStep}`}
                size="md"
                dismissOnBackdrop={false}
            >
                <p>The server version changed while this tab had a grouped save pending. This group includes:</p>
                <ul className="sync-conflict-steps">
                    {conflictSteps.map((step: string) => <li key={step}>{STEP_LABELS[step] || step}</li>)}
                </ul>
                <p>Keep my version overwrites the server artifacts for every listed step. Use the other version replaces all listed local steps with the current server versions. Your changes remain untouched until you choose.</p>
                <div className="app-dialog-actions">
                    <button className="btn" type="button" onClick={() => setConflictVisible(false)}>Decide later</button>
                    <button className="btn danger" type="button" onClick={() => void resolveConflict(conflict!.sequence, 'accept-remote')}>Use other version</button>
                    <button className="btn primary" type="button" onClick={() => void resolveConflict(conflict!.sequence, 'keep-local')}>Keep my version</button>
                </div>
            </AppDialog>
            <AppDialog
                open={!!pendingSwitchId && !showConflict}
                onClose={cancelProjectSwitch}
                title="Unsynced changes"
                size="md"
                dismissOnBackdrop={false}
            >
                <p>{unsyncedGroups} save group{unsyncedGroups === 1 ? '' : 's'} for {activeId} have not been acknowledged. Switching to {switchTarget?.title || pendingSwitchId} will wait for these edits, or discard them only if you choose to do so.</p>
                {conflict && (
                    <p className="warnmark">A sync conflict must be resolved before waiting can complete.</p>
                )}
                {saveInFlight && <p>A save group is currently being committed. Wait for its acknowledgement before discarding pending changes.</p>}
                <div className="app-dialog-actions">
                    <button className="btn" type="button" onClick={cancelProjectSwitch}>Stay here</button>
                    {conflict && <button className="btn" type="button" onClick={() => setConflictVisible(true)}>Review conflict</button>}
                    <button className="btn danger" type="button" disabled={saveInFlight} onClick={() => void discardAndSwitch()}>Discard unsynced changes and switch</button>
                    <button className="btn primary" type="button" onClick={() => void waitAndSwitch()}>Wait for sync</button>
                </div>
            </AppDialog>
        </>
    );
}