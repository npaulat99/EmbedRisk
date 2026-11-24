import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useDialogs } from '../lib/useDialogs';
import { announce } from './LiveStatus';
import Icon from './Icon';
import type { AppTheme } from '../state/store';

type SaveStatus = 'saving' | 'saved' | 'retrying' | 'offline-pending' | 'offline-empty' | 'conflict';

export default function TopBar() {
    const projects = useStore((s) => s.projects);
    const activeId = useStore((s) => s.activeId);
    const connected = useStore((s) => s.connected);
    const syncSummary = useStore((s) => s.syncSummary);
    const syncQueueEntries = useStore((s) => s.syncQueueEntries);
    const retrySync = useStore((s) => s.retrySync);
    const showSyncConflict = useStore((s) => s.setSyncConflictVisible);
    const select = useStore((s) => s.selectProject);
    const newProject = useStore((s) => s.newProject);
    const setView = useStore((s) => s.setView);
    const status = useStore((s) => s.data?.project?.status);
    const theme = useStore((s) => s.theme);
    const setTheme = useStore((s) => s.setTheme);
    const undo = useStore((s) => s.undo);
    const redo = useStore((s) => s.redo);
    const undoDepth = useStore((s) => s.undoDepth);
    const redoDepth = useStore((s) => s.redoDepth);
    const setSettings = useStore((s) => s.openSettings);
    const openTutorial = useStore((s) => s.openTutorial);
    const openTutorialPrompt = useStore((s) => s.openTutorialPrompt);
    const dialogs = useDialogs();

    const [helpOpen, setHelpOpen] = useState(false);
    const helpRef = useRef<HTMLDivElement>(null);
    const overflowId = useId();
    const previousSaveStatus = useRef<SaveStatus | null>(null);
    const conflictStep = syncQueueEntries.find((entry) => entry.state === 'conflict')?.conflict?.step || null;
    const hasPending = syncSummary.pendingCount > 0;
    const saveStatus: SaveStatus = syncSummary.hasConflict
        ? 'conflict'
        : syncSummary.inFlight || syncSummary.debouncing
            ? 'saving'
            : !connected && hasPending
                ? 'offline-pending'
                : !connected
                    ? 'offline-empty'
                    : hasPending
                        ? 'retrying'
                        : 'saved';

    useEffect(() => {
        const previous = previousSaveStatus.current;
        previousSaveStatus.current = saveStatus;
        if (previous === null) return;
        const message = saveStatus === 'offline-pending' && previous !== 'offline-pending'
            ? 'Offline. Unsaved changes are held in this tab only.'
            : saveStatus === 'offline-empty' && previous !== 'offline-empty'
                ? 'Offline. Nothing is unsaved.'
                : saveStatus === 'conflict' && previous !== 'conflict'
                    ? `Sync conflict${conflictStep ? ` on ${conflictStep}` : ''}. Review before continuing.`
                    : saveStatus === 'saved' && previous !== 'saved' && previous !== 'offline-empty'
                        ? 'Saved to disk.'
                        : previous?.startsWith('offline') && !saveStatus.startsWith('offline')
                            ? 'Live sync reconnected.'
                            : null;
        if (!message) return;
        const timer = setTimeout(() => announce(message), 800);
        return () => clearTimeout(timer);
    }, [conflictStep, saveStatus]);

    // Close the Help menu when clicking elsewhere.
    useEffect(() => {
        if (!helpOpen) return;
        const onDown = (e: MouseEvent) => {
            if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [helpOpen]);

    // Global Ctrl/Cmd+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo). We defer to the browser's native
    // undo while a text field is focused so typing corrections still work as expected.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            const k = e.key.toLowerCase();
            if (k === 'z' && !e.shiftKey) {
                e.preventDefault();
                useStore.getState().undo();
            } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
                e.preventDefault();
                useStore.getState().redo();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const onNew = async () => {
        if (syncSummary.pendingCount > 0) {
            await dialogs.alert({
                title: 'Unsynced changes',
                message: 'Save or resolve the current project changes before creating a new project. Unsynced edits are held only in this tab.',
            });
            return;
        }
        const name = await dialogs.prompt({
            title: 'New project',
            label: 'Device / project name',
            defaultValue: 'New device',
            validate: (value) => value ? null : 'Enter a project name.',
        });
        if (name) await newProject(name);
    };

    const changeTheme = (value: string) => setTheme(value as AppTheme);

    const statusLabel = saveStatus === 'conflict'
        ? `Sync conflict${conflictStep ? ` on ${conflictStep}` : ''}`
        : saveStatus === 'offline-pending'
            ? `Offline, ${syncSummary.pendingCount} change${syncSummary.pendingCount === 1 ? '' : 's'} held in this tab only`
            : saveStatus === 'offline-empty'
                ? 'Offline, nothing unsaved'
                : saveStatus === 'retrying'
                    ? 'Unsaved changes held in this tab (retrying)'
                    : saveStatus === 'saving'
                        ? 'Saving'
                        : 'Saved';
    const unsavedDetail = 'Unsaved changes are only in this tab’s memory. They can be lost if you close or reload this tab.';

    return (
        <header className="topbar">
            <div className="brand">
                <img className="logo" src="/favicon.svg" alt="" width={26} height={26} />
                <span>
                    EmbedRisk <small>· Threat &amp; Risk Assessment</small>
                </span>
            </div>

            <select className="inp project-select" value={activeId || ''} onChange={(e) => select(e.target.value)}>
                {projects.length === 0 && <option value="">No projects</option>}
                {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.title} ({p.id})
                    </option>
                ))}
            </select>
            <button className="btn sm" onClick={onNew}>
                <Icon name="add" width={16} height={16} /> New
            </button>
            {status && <span className="tag statuspill">{status}</span>}

            <div className="spacer" />

            <div className="topbar-actions">
                <span className="undogroup">
                    <button className="btn sm iconbtn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!undoDepth} onClick={undo}><Icon name="undo" width={16} height={16} /></button>
                    <button className="btn sm iconbtn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!redoDepth} onClick={redo}><Icon name="redo" width={16} height={16} /></button>
                </span>
                <select className="inp theme-select" aria-label="Color scheme" value={theme} onChange={(event) => changeTheme(event.target.value)}>
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                </select>
                <button className="btn sm iconbtn" title="Project settings" aria-label="Project settings" onClick={() => setSettings(true)}><Icon name="settings" width={16} height={16} /></button>
                <div className="helpmenu" ref={helpRef}>
                    <button
                        className="btn sm iconbtn"
                        title="Help"
                        aria-label="Help"
                        aria-haspopup="menu"
                        aria-expanded={helpOpen}
                        onClick={() => setHelpOpen((v) => !v)}
                    >
                        <Icon name="help" width={16} height={16} />
                    </button>
                    {helpOpen && (
                        <div className="helpmenu-pop" role="menu">
                            <button className="helpmenu-item" role="menuitem" onClick={() => { setHelpOpen(false); openTutorial(); }}><Icon name="play" width={16} height={16} /> Start tutorial</button>
                            <button className="helpmenu-item" role="menuitem" onClick={() => { setHelpOpen(false); openTutorialPrompt(); }}>Tutorial overview</button>
                        </div>
                    )}
                </div>
                <button className="btn" onClick={() => setView('review')}>Generate report</button>
            </div>
            <button
                className="btn sm topbar-overflow-toggle"
                type="button"
                aria-controls={overflowId}
                {...({ popovertarget: overflowId } as any)}
            >
                More actions
            </button>
            <div id={overflowId} className="topbar-overflow" {...({ popover: 'auto' } as any)}>
                <button className="btn sm" type="button" disabled={!undoDepth} onClick={undo}>Undo</button>
                <button className="btn sm" type="button" disabled={!redoDepth} onClick={redo}>Redo</button>
                <label className="theme-select-label">
                    <span>Color scheme</span>
                    <select className="inp theme-select" aria-label="Color scheme" value={theme} onChange={(event) => changeTheme(event.target.value)}>
                        <option value="system">System</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                    </select>
                </label>
                <button className="btn sm" type="button" onClick={() => setSettings(true)}>Project settings</button>
                <button className="btn sm" type="button" onClick={openTutorial}>Start tutorial</button>
                <button className="btn sm" type="button" onClick={openTutorialPrompt}>Tutorial overview</button>
                <button className="btn sm" type="button" onClick={() => setView('review')}>Generate report</button>
            </div>
            <span
                className="conn"
                title={hasPending ? `${unsavedDetail} ${syncSummary.nextRetryAt ? 'A retry is scheduled.' : ''}` : connected ? 'All current changes are saved to disk.' : 'Offline. Nothing is unsaved.'}
                aria-label={`${statusLabel}${hasPending ? `. ${unsavedDetail}` : ''}`}
            >
                <span className={'dot ' + (connected ? 'on' : 'off')} />
                {statusLabel}
            </span>
            {syncSummary.hasConflict && <button className="btn sm" type="button" onClick={() => showSyncConflict(true)}>Review conflict</button>}
            {hasPending && !syncSummary.hasConflict && syncSummary.nextRetryAt !== null && (
                <button className="btn sm" type="button" onClick={retrySync}>Retry sync</button>
            )}
        </header>
    );
}
