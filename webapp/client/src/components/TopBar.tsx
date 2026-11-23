import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useDialogs } from '../lib/useDialogs';
import { announce } from './LiveStatus';

type SaveStatus = 'unsaved' | 'saving' | 'saved' | 'offline' | 'live';

export default function TopBar() {
    const projects = useStore((s) => s.projects);
    const activeId = useStore((s) => s.activeId);
    const connected = useStore((s) => s.connected);
    const saveState = useStore((s) => s.saveState);
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
    const saveStatus: SaveStatus = !connected || saveState === 'offline'
        ? 'offline'
        : saveState === 'saving'
            ? 'saving'
            : saveState === 'saved'
                ? 'saved'
                : 'live';

    useEffect(() => {
        const previous = previousSaveStatus.current;
        previousSaveStatus.current = saveStatus;
        if (previous === null) return;
        const message = previous === 'offline' && saveStatus !== 'offline'
            ? 'Live'
            : saveStatus === 'offline' && previous !== 'offline'
                ? 'Offline, changes kept locally'
                : saveStatus === 'saved' && (previous === 'saving' || previous === 'unsaved')
                    ? 'Saved'
                    : null;
        if (!message) return;
        const timer = setTimeout(() => announce(message), 800);
        return () => clearTimeout(timer);
    }, [saveStatus]);

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
        const name = await dialogs.prompt({
            title: 'New project',
            label: 'Device / project name',
            defaultValue: 'New device',
            validate: (value) => value ? null : 'Enter a project name.',
        });
        if (name) await newProject(name);
    };

    const statusLabel = saveStatus === 'offline'
        ? 'Offline, changes kept locally'
        : saveStatus === 'saved'
            ? 'Saved'
            : saveStatus === 'saving'
                ? 'Unsaved changes'
                : 'Live';

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
                + New
            </button>
            {status && <span className="tag statuspill">{status}</span>}

            <div className="spacer" />

            <div className="topbar-actions">
                <span className="undogroup">
                    <button className="btn sm iconbtn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!undoDepth} onClick={undo}>↶</button>
                    <button className="btn sm iconbtn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!redoDepth} onClick={redo}>↷</button>
                </span>
                <button className="btn sm" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                    {theme === 'dark' ? '☀ Light' : '☾ Dark'}
                </button>
                <button className="btn sm iconbtn" title="Project settings" aria-label="Project settings" onClick={() => setSettings(true)}>⚙</button>
                <div className="helpmenu" ref={helpRef}>
                    <button
                        className="btn sm iconbtn"
                        title="Help"
                        aria-label="Help"
                        aria-haspopup="menu"
                        aria-expanded={helpOpen}
                        onClick={() => setHelpOpen((v) => !v)}
                    >
                        <span aria-hidden="true">?</span>
                    </button>
                    {helpOpen && (
                        <div className="helpmenu-pop" role="menu">
                            <button className="helpmenu-item" role="menuitem" onClick={() => { setHelpOpen(false); openTutorial(); }}>▶ Start tutorial</button>
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
                <button className="btn sm" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button>
                <button className="btn sm" type="button" onClick={() => setSettings(true)}>Project settings</button>
                <button className="btn sm" type="button" onClick={openTutorial}>Start tutorial</button>
                <button className="btn sm" type="button" onClick={openTutorialPrompt}>Tutorial overview</button>
                <button className="btn sm" type="button" onClick={() => setView('review')}>Generate report</button>
            </div>
            <span className="conn" title={connected ? 'Live sync connected' : 'Reconnecting…'}>
                <span className={'dot ' + (connected ? 'on' : 'off')} />
                {statusLabel}
            </span>
        </header>
    );
}
