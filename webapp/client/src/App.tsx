import { useEffect, useRef, useState } from 'react';
import { useStore } from './state/store';
import { parseHashRoute } from './lib/route';
import type { ProjectData } from './types';
import TopBar from './components/TopBar';
import StepNav, { StepPicker } from './components/StepNav';
import Inspector from './components/Inspector';
import WizardBar from './components/WizardBar';
import DfdView from './components/dfd/DfdView';
import ProjectPanel from './components/panels/ProjectPanel';
import UseCasesPanel from './components/panels/UseCasesPanel';
import AssumptionsPanel from './components/panels/AssumptionsPanel';
import SystemPanel from './components/panels/SystemPanel';
import ThreatsPanel from './components/panels/ThreatsPanel';
import RequirementsPanel from './components/panels/RequirementsPanel';
import CountermeasuresPanel from './components/panels/CountermeasuresPanel';
import AttackTreesPanel from './components/panels/AttackTreesPanel';
import ReviewPanel from './components/panels/ReviewPanel';
import VersionsPanel from './components/panels/VersionsPanel';
import DashboardPanel from './components/panels/DashboardPanel';
import DefectsPanel from './components/panels/DefectsPanel';
import KbPanel from './components/panels/KbPanel';
import SettingsModal from './components/SettingsModal';
import StrideBoundaryEditor from './components/StrideBoundaryEditor';
import TutorialOnboarding from './components/TutorialOnboarding';
import DialogProvider from './components/DialogProvider';
import AppDialog from './components/AppDialog';
import LiveStatus from './components/LiveStatus';
import SaveSyncDialogs from './components/SaveSyncDialogs';
import { useDialogs } from './lib/useDialogs';

function routeTargetExists(data: ProjectData, view: string, id: string | undefined) {
    if (!id) return true;
    const has = (items: { id: string }[] | undefined) => !!items?.some((item) => item.id === id);
    switch (view) {
        case 'project': return data.project.projectId === id;
        case 'assumptions': return has(data.assumptions.attacker) || has(data.assumptions.device) || has(data.assumptions.system) || has(data.assumptions.environment) || has(data.assumptions.operational);
        case 'system': return has(data.system.components) || has(data.system.interfaces) || has(data.system.trustBoundaries) || has(data.system.assets);
        case 'dfd': return has(data.dfd.nodes) || has(data.dfd.flows) || has(data.system.interfaces);
        case 'useCases': return (data.useCases?.diagrams || []).some((diagram) => diagram.id === id || diagram.entities?.some((entity) => entity.id === id) || diagram.connections?.some((connection) => connection.id === id) || diagram.groups?.some((group) => group.id === id));
        case 'threats': return has(data.threats.threats);
        case 'requirements': return has(data.requirements.requirements);
        case 'countermeasures': return has(data.countermeasures.countermeasures);
        case 'attackTrees': {
            const contains = (node: any): boolean => node?.id === id || (node?.children || []).some(contains);
            return (data.attackTrees?.trees || []).some((tree) => tree.id === id || contains(tree.root));
        }
        case 'defects': return has(data.defects?.defects);
        case 'versions': return data.changeTracker.entries.some((entry) => entry.version === id);
        default: return false;
    }
}

function AppContent() {
    const data = useStore((s) => s.data);
    const view = useStore((s) => s.activeView);
    const activeId = useStore((s) => s.activeId);
    const newProject = useStore((s) => s.newProject);
    const dialogs = useDialogs();
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const hasInspector = view !== 'dashboard' && view !== 'kb' && view !== 'defects' && view !== 'versions';
    const routeContext = useRef({ data, activeId });
    routeContext.current = { data, activeId };
    const applyHashRoute = useRef<() => void>(() => { });
    applyHashRoute.current = () => {
        const project = routeContext.current.data;
        if (!project || window.location.hash === '#main-content') return;
        const route = parseHashRoute(window.location.hash);
        if (!route) {
            useStore.getState().setView('project', 'replace');
            return;
        }
        if (!routeTargetExists(project, route.view, route.id)) {
            useStore.getState().setView(route.view, 'replace');
            return;
        }
        if (route.id) useStore.getState().goto(route.view, route.id, 'none');
        else useStore.getState().setView(route.view, 'none');
    };

    useEffect(() => {
        const syncRoute = () => applyHashRoute.current();
        window.addEventListener('hashchange', syncRoute);
        window.addEventListener('popstate', syncRoute);
        syncRoute();
        return () => {
            window.removeEventListener('hashchange', syncRoute);
            window.removeEventListener('popstate', syncRoute);
        };
    }, []);

    useEffect(() => {
        if (data) applyHashRoute.current();
    }, [activeId, !!data]);

    useEffect(() => {
        const openInspector = () => setInspectorOpen(true);
        window.addEventListener('embedrisk:open-inspector', openInspector);
        return () => window.removeEventListener('embedrisk:open-inspector', openInspector);
    }, []);

    useEffect(() => setInspectorOpen(false), [view]);

    const main = () => {
        switch (view) {
            case 'dfd':
                return <DfdView />;
            case 'project':
                return <ProjectPanel />;
            case 'assumptions':
                return <AssumptionsPanel />;
            case 'system':
                return <SystemPanel />;
            case 'useCases':
                return <UseCasesPanel />;
            case 'threats':
                return <ThreatsPanel />;
            case 'requirements':
                return <RequirementsPanel />;
            case 'countermeasures':
                return <CountermeasuresPanel />;
            case 'attackTrees':
                return <AttackTreesPanel />;
            case 'review':
                return <ReviewPanel />;
            case 'versions':
                return <VersionsPanel />;
            case 'dashboard':
                return <DashboardPanel />;
            case 'defects':
                return <DefectsPanel />;
            case 'kb':
                return <KbPanel />;
            default:
                return <DfdView />;
        }
    };

    return (
        <div className="app">
            <a
                className="skip-link"
                href="#main-content"
                onClick={(event) => {
                    event.preventDefault();
                    document.getElementById('main-content')?.focus();
                }}
            >
                Skip to main content
            </a>
            <TopBar />
            <SaveSyncDialogs />
            {data ? (
                <>
                    <div className="shell-compact-tools">
                        <StepPicker />
                        {hasInspector && (
                            <button
                                className="btn sm inspector-toggle"
                                type="button"
                                aria-expanded={inspectorOpen}
                                aria-controls="inspector-drawer"
                                onClick={() => setInspectorOpen(true)}
                            >
                                Inspector
                            </button>
                        )}
                    </div>
                    <div className={'layout' + (!hasInspector ? ' wide' : '')}>
                        <StepNav />
                        <main id="main-content" tabIndex={-1} className={'main' + (view === 'dfd' ? ' is-dfd' : '')}>
                            {main()}
                            {view !== 'dfd' && <WizardBar />}
                        </main>
                        {hasInspector && <Inspector />}
                    </div>
                    {hasInspector && (
                        <AppDialog id="inspector-drawer" open={inspectorOpen} onClose={() => setInspectorOpen(false)} title="Inspector" size="md" dismissOnBackdrop className="inspector-drawer">
                            <Inspector />
                        </AppDialog>
                    )}
                </>
            ) : (
                <div className="empty">
                    <div className="box">
                        <h2>No project open</h2>
                        <p className="muted">
                            Create a project to begin, or copy a folder into <code>tra-webapp/projects/</code>. Each step is a JSON
                            file you can edit here or directly on disk — changes sync live.
                        </p>
                        <button
                            className="btn primary"
                            onClick={async () => {
                                const name = await dialogs.prompt({
                                    title: 'New project',
                                    label: 'Device / project name',
                                    defaultValue: 'New device',
                                    validate: (value) => value ? null : 'Enter a project name.',
                                });
                                if (name) await newProject(name);
                            }}
                        >
                            + New project
                        </button>
                    </div>
                </div>
            )}
            <SettingsModal />
            <StrideBoundaryEditor />
            <TutorialOnboarding />
        </div>
    );
}

export default function App() {
    return (
        <DialogProvider>
            <AppContent />
            <LiveStatus />
        </DialogProvider>
    );
}
