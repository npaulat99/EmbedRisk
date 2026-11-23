// Global application state (zustand) plus the live-sync transport.
//
// Sync model:
//   - Every edit calls `save(step, value)`. The store updates local state optimistically
//     and (debounced) pushes the new artifact over the WebSocket. The backend writes the
//     JSON file and relays the change to *other* connected clients.
//   - When a JSON file is edited externally, the backend pushes an {type:'artifact'}
//     message which `applyArtifact` merges back into state — so the UI tracks the files live.
import { create } from 'zustand';
import type { LaunchConfig, ProjectData, ProjectSummary, RiskScheme, RiskSchemeV2, StepKey, ViewKey } from '../types';
import { tutorialStorageKey } from '../tutorial/tutorialData';
import { alignedManagedAttacker } from '../lib/slc';
import { legacyRiskSchemeRegistry, schemeForProject } from '../lib/risk';
import { writeHashRoute } from '../lib/route';
import type { RouteHistoryMode, RouteView } from '../lib/route';

export type AppTheme = 'system' | 'light' | 'dark';

const norm = (v: string | null | undefined) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const isPlaceholderComponentName = (label: string | undefined) => {
    const l = norm(label);
    return l === 'newcomponent' || l === 'newprocess' || l === 'newmultiprocess' || l === 'newstore' || l === 'newexternalentity' || l === 'newdevice';
};
const isPlaceholderDfdLabel = (label: string | undefined) => {
    const l = norm(label);
    return l === 'newcomponent' || l === 'newexternalentity' || l === 'newtrustboundary' || l === 'newboundary' || l === 'newprocess' || l === 'newmultiprocess' || l === 'newstore';
};
const DEVICE_HOUSING_ID = 'TB-1';
const DEVICE_HOUSING_NAME = 'Device housing';
const suffixNum = (id?: string | null) => {
    const m = String(id || '').match(/(\d+)$/);
    return m ? Number(m[1]) : null;
};
const defaultNodeType = (kind?: string) => {
    if (kind === 'store') return 'store';
    if (kind === 'external-entity') return 'external-entity';
    if (kind === 'multiprocess') return 'multiprocess';
    return 'process';
};

function inferFlowBoundaryId(system: any, dfd: any, flow: any) {
    const compById = new Map((system.components || []).map((c: any) => [c.id, c]));
    const nodeById = new Map((dfd.nodes || []).map((n: any) => [n.id, n]));
    const nodesByComponent = new Map<string, any[]>();
    for (const node of dfd.nodes || []) {
        if (!node.componentRef) continue;
        const list = nodesByComponent.get(node.componentRef) || [];
        list.push(node);
        nodesByComponent.set(node.componentRef, list);
    }
    const tbNodes = (dfd.nodes || []).filter((n: any) => n.type === 'trust-boundary');
    const interfaceById = new Map((system.interfaces || []).map((itf: any) => [itf.id, itf]));

    const boundaryDepthsForNode = (nodeId: string) => {
        const depths = new Map<string, number>();
        let current: any = nodeById.get(nodeId);
        let depth = 0;
        const seen = new Set<string>();
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            for (const tb of tbNodes) {
                if ((tb.parent ?? null) === (current.parent ?? null) && (tb.members || []).includes(current.id)) {
                    depths.set(tb.id, Math.max(depths.get(tb.id) || 0, depth + 1));
                }
            }
            current = current.parent ? nodeById.get(current.parent) : null;
            depth++;
        }
        return depths;
    };

    const boundaryDepthsForEndpoint = (endpointId: string) => {
        const direct: any = nodeById.get(endpointId);
        if (direct) return boundaryDepthsForNode(endpointId);
        const itf: any = interfaceById.get(endpointId);
        if (!itf?.component) return new Map<string, number>();
        const depths = new Map<string, number>();
        let compId: string | null | undefined = itf.component;
        let depth = 0;
        const seen = new Set<string>();
        while (compId && !seen.has(compId)) {
            seen.add(compId);
            for (const node of nodesByComponent.get(compId) || []) {
                for (const [tbId, tbDepth] of boundaryDepthsForNode(node.id)) depths.set(tbId, Math.max(depths.get(tbId) || 0, tbDepth + depth));
            }
            compId = (compById.get(compId) as any)?.parent ?? null;
            depth++;
        }
        return depths;
    };

    const a = boundaryDepthsForEndpoint(flow.from);
    const b = boundaryDepthsForEndpoint(flow.to);
    let best: { id: string; depth: number } | null = null;
    const ids = new Set([...a.keys(), ...b.keys()]);
    for (const id of ids) {
        const inA = a.has(id);
        const inB = b.has(id);
        if (inA === inB) continue;
        const depth = Math.max(a.get(id) || 0, b.get(id) || 0);
        if (!best || depth > best.depth) best = { id, depth };
    }
    return best?.id || null;
}

function reconcileSystemDfd(system: any, dfd: any, authoritative: 'system' | 'dfd' = 'system') {
    const compIds = new Set((system?.components || []).map((c: any) => c.id));
    const sysTbIds = new Set((system?.trustBoundaries || []).map((b: any) => b.id));
    const nodes = [...(dfd?.nodes || [])].filter((n: any) => {
        if (authoritative !== 'system') return true;
        if (n.type === 'trust-boundary') return sysTbIds.has(n.id);
        if (n.componentRef) return compIds.has(n.componentRef);
        return true;
    });
    const flows = [...(dfd?.flows || [])];
    const existingIds = new Set(nodes.map((n: any) => n.id));
    const nodeById = new Map(nodes.map((n: any) => [n.id, n]));
    const makeNodeId = (compId: string) => {
        const num = suffixNum(compId);
        const preferred = num ? `N-${num}` : null;
        if (preferred && !existingIds.has(preferred)) {
            existingIds.add(preferred);
            return preferred;
        }
        let n = existingIds.size + 1;
        let id = `N-${n}`;
        while (existingIds.has(id)) id = `N-${++n}`;
        existingIds.add(id);
        return id;
    };
    const nodeId = () => {
        let n = existingIds.size + 1;
        let id = `N-${n}`;
        while (existingIds.has(id)) id = `N-${++n}`;
        existingIds.add(id);
        return id;
    };
    const components = [...(system?.components || [])].sort((a: any, b: any) => (a.layer || 0) - (b.layer || 0) || a.name.localeCompare(b.name));
    const nodesByComponent = new Map<string, any>();
    const compById = new Map(components.map((c: any) => [c.id, c]));
    const unlinked = nodes.filter((n: any) => n.type !== 'trust-boundary' && !n.componentRef);

    for (const node of nodes) if (node.componentRef && compById.has(node.componentRef) && !nodesByComponent.has(node.componentRef)) nodesByComponent.set(node.componentRef, node);

    for (const comp of components) {
        if (nodesByComponent.has(comp.id)) continue;
        const parentNode = comp.parent ? nodesByComponent.get(comp.parent) : null;
        const candidate = unlinked.find(
            (node: any) =>
                !node.componentRef &&
                node.type !== 'trust-boundary' &&
                (node.parent ?? null) === (parentNode?.id ?? null) &&
                norm(node.label) === norm(comp.name),
        );
        if (candidate) {
            candidate.componentRef = comp.id;
            candidate.layer = comp.layer;
            candidate.parent = parentNode?.id ?? null;
            nodesByComponent.set(comp.id, candidate);
            continue;
        }
        const created = {
            id: comp.parent ? makeNodeId(comp.id) : 'N-DEV',
            label: comp.name,
            type: defaultNodeType(comp.kind),
            layer: comp.layer,
            parent: parentNode?.id ?? null,
            componentRef: comp.id,
        };
        if (created.id === 'N-DEV' && existingIds.has(created.id)) created.id = nodeId();
        else existingIds.add(created.id);
        nodes.push(created);
        nodesByComponent.set(comp.id, created);
    }

    for (const node of nodes) {
        if (!node.componentRef) continue;
        const comp = compById.get(node.componentRef);
        if (!comp) {
            delete node.componentRef;
            continue;
        }
        const parentNode = comp.parent ? nodesByComponent.get(comp.parent) : null;
        node.layer = comp.layer;
        node.parent = parentNode?.id ?? null;
        if (!node.label || norm(node.label) === norm(comp.id) || isPlaceholderDfdLabel(node.label)) node.label = comp.name;
    }

    const tbNodes = nodes.filter((n: any) => n.type === 'trust-boundary');
    const tbById = new Map(tbNodes.map((n: any) => [n.id, n]));
    for (const tb of system?.trustBoundaries || []) {
        const memberNodeIds = (tb.members || []).map((cid: string) => nodesByComponent.get(cid)?.id).filter(Boolean);
        const memberParent = memberNodeIds.length ? nodes.find((n: any) => n.id === memberNodeIds[0])?.parent ?? null : null;
        const memberLayer = memberNodeIds.length ? nodes.find((n: any) => n.id === memberNodeIds[0])?.layer ?? 1 : 1;
        const existing = tbById.get(tb.id) || tbNodes.find((n: any) => norm(n.label) === norm(tb.name));
        if (existing) {
            const unlinkedMembers = (existing.members || []).filter((nodeId: string) => !(nodeById.get(nodeId) as any)?.componentRef);
            existing.id = tb.id;
            existing.label = tb.name;
            existing.members = [...new Set([...memberNodeIds, ...unlinkedMembers])];
            existing.parent = memberParent;
            existing.layer = memberLayer;
            tbById.set(tb.id, existing);
        } else {
            const created = { id: tb.id, label: tb.name, type: 'trust-boundary', members: memberNodeIds, parent: memberParent, layer: memberLayer };
            nodes.push(created);
            tbById.set(tb.id, created);
        }
    }

    const validNodeIds = new Set(nodes.map((n: any) => n.id));
    const validBoundaryIds = new Set(nodes.filter((n: any) => n.type === 'trust-boundary').map((n: any) => n.id));
    const nextFlows = flows.filter((flow: any) => {
        const fromNode = validNodeIds.has(flow.from) || (system.interfaces || []).some((itf: any) => itf.id === flow.from);
        const toNode = validNodeIds.has(flow.to) || (system.interfaces || []).some((itf: any) => itf.id === flow.to);
        return fromNode && toNode;
    }).map((flow: any) => {
        if (flow.crossesBoundary && validBoundaryIds.has(flow.crossesBoundary)) return flow;
        return { ...flow, crossesBoundary: inferFlowBoundaryId(system, { ...dfd, nodes }, flow) };
    });

    return { ...(dfd || {}), nodes, flows: nextFlows };
}

function reconcileDfdSystem(system: any, dfd: any) {
    const nodeById = new Map((dfd?.nodes || []).map((n: any) => [n.id, n]));
    const componentNodes = (dfd?.nodes || []).filter((n: any) => n.type !== 'trust-boundary' && n.componentRef);
    const existingComponents = new Map((system?.components || []).map((c: any) => [c.id, c]));

    const nextComponents = componentNodes.map((node: any) => {
        const existing: any = existingComponents.get(node.componentRef) || {};
        const preserveExistingName = !!existing.name && isPlaceholderComponentName(node.label) && norm(existing.name) !== norm(node.label);
        return {
            ...existing,
            id: node.componentRef,
            name: preserveExistingName ? existing.name : node.label || existing.name || node.componentRef,
            kind: existing.kind || (node.type === 'store' ? 'store' : node.type === 'external-entity' ? 'external-entity' : node.type === 'multiprocess' ? 'multiprocess' : 'software'),
            layer: Number(node.layer) || 1,
            parent: node.parent ? ((nodeById.get(node.parent) as any)?.componentRef ?? null) : null,
        };
    });

    const keptComponentIds = new Set(nextComponents.map((c: any) => c.id));
    const preservedSystemOnly = (system?.components || []).filter((c: any) => c.kind === 'device' && !keptComponentIds.has(c.id));

    const componentIdSet = new Set([...keptComponentIds, ...preservedSystemOnly.map((c: any) => c.id)]);

    // Keep interfaces/assets bound to existing components only, and keep threat-boundary references valid.
    const nextInterfaces = (system?.interfaces || []).map((itf: any) => {
        if (!itf.component || componentIdSet.has(itf.component)) return itf;
        return { ...itf, component: null };
    });

    const nextAssets = (system?.assets || []).map((asset: any) => ({
        ...asset,
        components: (asset.components || []).filter((cid: string) => componentIdSet.has(cid)),
    }));

    const nextTrustBoundaries = (dfd?.nodes || [])
        .filter((n: any) => n.type === 'trust-boundary')
        .map((tb: any) => ({
            id: tb.id,
            name: tb.label || tb.id,
            members: (tb.members || [])
                .map((nodeId: string) => (nodeById.get(nodeId) as any)?.componentRef)
                .filter(Boolean),
        }));

    const deviceComponent = (nextComponents as any[]).find((c) => c.kind === 'device') || (system?.components || []).find((c: any) => c.kind === 'device');
    if (deviceComponent && !nextTrustBoundaries.some((tb) => tb.id === DEVICE_HOUSING_ID)) {
        nextTrustBoundaries.unshift({ id: DEVICE_HOUSING_ID, name: DEVICE_HOUSING_NAME, members: [deviceComponent.id] });
    }

    return {
        ...(system || {}),
        components: [...preservedSystemOnly, ...nextComponents],
        interfaces: nextInterfaces,
        assets: nextAssets,
        trustBoundaries: nextTrustBoundaries,
    };
}

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

async function getJSON<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
}
async function postJSON<T>(url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return r.json();
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

// ---- Undo / redo history --------------------------------------------------
// A stack of whole-project snapshots. Every edit (save / renameId) records the pre-edit state;
// rapid edits to the same step within a short window coalesce into one undo step so typing or
// dragging does not produce dozens of tiny steps. undo()/redo() restore a snapshot and push the
// changed artifacts to the backend.
const STEP_KEYS: StepKey[] = ['project', 'assumptions', 'system', 'dfd', 'useCases', 'threats', 'requirements', 'countermeasures', 'attackTrees', 'defects'];
let undoStack: ProjectData[] = [];
let redoStack: ProjectData[] = [];
let histStep = '';
let histTime = 0;
let histSuppress = false;
const cloneData = (d: ProjectData): ProjectData => JSON.parse(JSON.stringify(d));

function pushHistory(prev: ProjectData, step: string) {
    const now = Date.now();
    if (undoStack.length && step === histStep && now - histTime < 700) {
        histTime = now;
        return;
    }
    undoStack.push(cloneData(prev));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    histStep = step;
    histTime = now;
    useStore.setState({ undoDepth: undoStack.length, redoDepth: 0 });
}

function ensureDeviceHousing(system: any, dfd: any) {
    const deviceComponent = (system?.components || []).find((c: any) => c.kind === 'device');
    if (!deviceComponent) return { system, dfd };
    const systemBoundaries = [...(system?.trustBoundaries || [])];
    if (!systemBoundaries.some((tb: any) => tb.id === DEVICE_HOUSING_ID)) {
        systemBoundaries.unshift({ id: DEVICE_HOUSING_ID, name: DEVICE_HOUSING_NAME, members: [deviceComponent.id] });
    }
    const dfdNodes = [...(dfd?.nodes || [])];
    const hasNode = dfdNodes.some((n: any) => n.type === 'trust-boundary' && n.id === DEVICE_HOUSING_ID);
    if (!hasNode) {
        const deviceNode = dfdNodes.find((n: any) => n.componentRef === deviceComponent.id);
        if (deviceNode) {
            dfdNodes.unshift({
                id: DEVICE_HOUSING_ID,
                label: DEVICE_HOUSING_NAME,
                type: 'trust-boundary',
                layer: 1,
                parent: null,
                x: deviceNode.x ?? 200,
                y: (deviceNode.y ?? 200) - 80,
                members: [deviceNode.id],
            });
        }
    }
    return { system: { ...(system || {}), trustBoundaries: systemBoundaries }, dfd: { ...(dfd || {}), nodes: dfdNodes } };
}

function restoreSnapshot(target: ProjectData, current: ProjectData) {
    useStore.setState({ data: target, selectedNodeId: null, selectedEdgeId: null, ucSelection: null });
    const id = useStore.getState().activeId;
    if (!id) return;
    useStore.setState({ saveState: 'saving' });
    for (const step of STEP_KEYS) {
        if (JSON.stringify((target as any)[step]) !== JSON.stringify((current as any)[step])) sendSave(id, step, (target as any)[step]);
    }
}

function clearHistory() {
    undoStack = [];
    redoStack = [];
    histStep = '';
    histTime = 0;
    useStore.setState({ undoDepth: 0, redoDepth: 0 });
}

const applyTheme = (theme: AppTheme) => {
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (theme === 'system') {
        delete root.dataset.theme;
        root.style.removeProperty('color-scheme');
        if (meta) meta.content = 'light dark';
        return;
    }
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (meta) meta.content = theme;
};

function riskValuesChanged(step: StepKey, before: any, after: any): boolean {
    const threatFields = ['likelihood', 'impact', 'likelihoodCriteria', 'impactCriteria', 'likelihoodFactors', 'impactDimensions', 'costFactors', 'costLikelihood', 'costLikelihoodProposal'];
    if (step === 'threats') {
        const values = (doc: any) => (doc?.threats || []).map((threat: any) => [threat.id, ...threatFields.map((field) => threat[field])]);
        return JSON.stringify(values(before)) !== JSON.stringify(values(after));
    }
    if (step === 'countermeasures') {
        const values = (doc: any) => (doc?.countermeasures || []).map((cm: any) => [cm.id, ...(cm.addresses || []).map((address: any) => [address.threat, address.residualLikelihood, address.residualImpact, address.residualLikelihoodCriteria, address.residualImpactCriteria])]);
        return JSON.stringify(values(before)) !== JSON.stringify(values(after));
    }
    return false;
}

interface Store {
    connected: boolean;
    projects: ProjectSummary[];
    activeId: string | null;
    data: ProjectData | null;
    scheme: RiskScheme | null;
    riskSchemes: RiskSchemeV2[];
    riskSchemeFingerprints: Record<string, string>;
    riskSchemeErrors: { file: string; message: string }[];
    schemeWarning: string | null;
    kb: any | null;
    bugBar: any | null;
    theme: AppTheme;
    activeView: ViewKey | 'dashboard' | 'kb';
    dfdPath: string[];
    selectedNodeId: string | null;
    selectedEdgeId: string | null;
    ucDiagramId: string | null;
    ucSelection: { type: 'entity' | 'connection' | 'group'; id: string } | null;
    strideBoundaryId: string | null;
    settingsOpen: boolean;
    focus: { view: string; id: string } | null;
    lastSavedAt: number;
    saveState: 'idle' | 'saving' | 'saved' | 'offline';
    tutorialPromptOpen: boolean;
    tutorialWalkthroughOpen: boolean;

    init(): Promise<void>;
    refreshProjects(): Promise<void>;
    refreshKb(): Promise<void>;
    selectProject(id: string): Promise<void>;
    newProject(name: string): Promise<string>;
    startTutorial(): void;
    skipTutorial(): void;
    closeTutorial(): void;
    openTutorial(): void;
    openTutorialPrompt(): void;
    setView(v: RouteView, historyMode?: RouteHistoryMode): void;
    goto(view: string, id?: string, historyMode?: RouteHistoryMode): void;
    setTheme(t: AppTheme): void;
    setDfdPath(path: string[]): void;
    selectNode(id: string | null): void;
    selectEdge(id: string | null): void;
    setUcDiagram(id: string | null): void;
    selectUcItem(sel: { type: 'entity' | 'connection' | 'group'; id: string } | null): void;
    openStrideBoundary(id: string | null): void;
    openSettings(v: boolean): void;
    drillInto(id: string): void;
    save(step: StepKey, value: any): void;
    renameId(oldId: string, newId: string): void;
    applyArtifact(step: StepKey, value: any): void;
    undo(): void;
    redo(): void;
    undoDepth: number;
    redoDepth: number;
    report(): Promise<{ html: string; issues: { key: string; message: string; severity: string }[] } | null>;
}

export const useStore = create<Store>((set, get) => ({
    connected: false,
    projects: [],
    activeId: null,
    data: null,
    scheme: null,
    riskSchemes: [],
    riskSchemeFingerprints: {},
    riskSchemeErrors: [],
    schemeWarning: null,
    kb: null,
    bugBar: null,
    theme: 'system',
    activeView: 'dfd',
    dfdPath: [],
    selectedNodeId: null,
    selectedEdgeId: null,
    ucDiagramId: null,
    ucSelection: null,
    strideBoundaryId: null,
    settingsOpen: false,
    focus: null,
    lastSavedAt: 0,
    saveState: 'idle',
    tutorialPromptOpen: false,
    tutorialWalkthroughOpen: false,
    undoDepth: 0,
    redoDepth: 0,

    async init() {
        const storedTheme = localStorage.getItem('tra-theme');
        const saved: AppTheme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
        applyTheme(saved);
        window.addEventListener('storage', (event) => {
            if (event.key !== 'tra-theme') return;
            const next: AppTheme = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'system';
            applyTheme(next);
            useStore.setState({ theme: next });
        });
        window.addEventListener('beforeunload', (e) => {
            const s = useStore.getState().saveState;
            if (s === 'saving' || s === 'offline') {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        const [registry, kb, bugBar, projects, config] = await Promise.all([
            getJSON<{ schemes: RiskSchemeV2[]; fingerprints: Record<string, string>; errors: { file: string; message: string }[] }>('/api/risk-schemes').catch(async () => {
                const legacyScheme = await getJSON<RiskScheme>('/api/risk-scheme').catch(() => null);
                return legacyScheme ? legacyRiskSchemeRegistry(legacyScheme) : null;
            }),
            getJSON<any>('/api/kb').catch(() => null),
            getJSON<any>('/api/bug-bar').catch(() => null),
            getJSON<ProjectSummary[]>('/api/projects').catch(() => []),
            getJSON<LaunchConfig>('/api/config').catch(() => ({ preselectProjectId: null })),
        ]);
        set({ riskSchemes: registry?.schemes || [], riskSchemeFingerprints: registry?.fingerprints || {}, riskSchemeErrors: registry?.errors || [], scheme: null, schemeWarning: null, kb, bugBar, theme: saved, projects });
        connect();
        if (projects.length) {
            const preferred = config?.preselectProjectId;
            const selected = preferred && projects.some((p) => p.id === preferred) ? preferred : projects[0].id;
            await get().selectProject(selected);
        }
    },

    async refreshProjects() {
        const projects = await getJSON<ProjectSummary[]>('/api/projects').catch(() => []);
        set({ projects });
    },

    async refreshKb() {
        const kb = await getJSON<any>('/api/kb').catch(() => null);
        if (kb) set({ kb });
    },

    async selectProject(id) {
        const data = await getJSON<ProjectData>(`/api/projects/${id}`);
        const selection = schemeForProject(data.project || {}, get().riskSchemes, get().riskSchemeFingerprints);
        set({ activeId: id, data, ...selection, dfdPath: [], selectedNodeId: null, selectedEdgeId: null, ucDiagramId: null, ucSelection: null });
        const aligned = alignedManagedAttacker(data.project?.slTarget, data.assumptions?.attacker);
        if (aligned) get().save('assumptions', { ...data.assumptions, attacker: [aligned] });
        clearHistory();
        subscribe(id);
    },

    async newProject(name) {
        const { id } = await postJSON<{ id: string }>('/api/projects', { name });
        await get().refreshProjects();
        await get().selectProject(id);
        get().setView('project');
        try {
            if (!localStorage.getItem(tutorialStorageKey)) {
                set({ tutorialPromptOpen: true, tutorialWalkthroughOpen: false });
            }
        } catch {
            /* ignore localStorage access errors */
        }
        return id;
    },

    startTutorial() {
        try {
            localStorage.setItem(tutorialStorageKey, 'started');
        } catch {
            /* ignore localStorage access errors */
        }
        set({ tutorialPromptOpen: false, tutorialWalkthroughOpen: true });
    },

    skipTutorial() {
        try {
            localStorage.setItem(tutorialStorageKey, 'skipped');
        } catch {
            /* ignore localStorage access errors */
        }
        set({ tutorialPromptOpen: false, tutorialWalkthroughOpen: false });
    },

    closeTutorial() {
        set({ tutorialPromptOpen: false, tutorialWalkthroughOpen: false });
    },

    openTutorial() {
        set({ tutorialPromptOpen: false, tutorialWalkthroughOpen: true });
    },

    openTutorialPrompt() {
        set({ tutorialPromptOpen: true, tutorialWalkthroughOpen: false });
    },

    setView(v, historyMode = 'push') {
        writeHashRoute({ view: v }, historyMode);
        set({ activeView: v, focus: null });
    },
    goto(view, id, historyMode = 'push') {
        writeHashRoute({ view: view as RouteView, ...(id ? { id } : {}) }, historyMode);
        set({ activeView: view as any, focus: id ? { view, id } : null, selectedNodeId: null, selectedEdgeId: null });
    },
    setTheme(t) {
        applyTheme(t);
        try {
            if (t === 'system') localStorage.removeItem('tra-theme');
            else localStorage.setItem('tra-theme', t);
        } catch {
            /* ignore */
        }
        set({ theme: t });
    },
    setDfdPath(path) {
        set({ dfdPath: path, selectedNodeId: null, selectedEdgeId: null });
    },
    selectNode(id) {
        set({ selectedNodeId: id, selectedEdgeId: null });
    },
    selectEdge(id) {
        set({ selectedEdgeId: id, selectedNodeId: null });
    },
    setUcDiagram(id) {
        set({ ucDiagramId: id, ucSelection: null });
    },
    selectUcItem(sel) {
        set({ ucSelection: sel });
    },
    openStrideBoundary(id) {
        set({ strideBoundaryId: id });
    },
    openSettings(v) {
        set({ settingsOpen: v });
    },
    drillInto(id) {
        const { data, dfdPath } = get();
        if (!data) return;
        const node = (data.dfd.nodes || []).find((n: any) => n.id === id);
        if (!node || node.type === 'trust-boundary') return;
        // Enter the component's internal layer. If it has no children yet the layer is simply
        // empty, ready for the user to model the internals — we never inject a placeholder.
        set({ dfdPath: [...dfdPath, id], selectedNodeId: null, selectedEdgeId: null });
    },

    save(step, value) {
        const data = get().data;
        if (!data) return;
        if (get().schemeWarning && riskValuesChanged(step, (data as any)[step], value)) return;
        if (!histSuppress) pushHistory(data, step);
        const nextData = { ...data, [step]: value } as ProjectData;
        if (step === 'project') {
            const deviceName = String(nextData.project?.device?.name || '').trim();
            if (deviceName) {
                const components = nextData.system?.components || [];
                const rootDevice = components.find((component: any) => component.kind === 'device' && component.parent == null) || components.find((component: any) => component.kind === 'device');
                if (rootDevice && rootDevice.name !== deviceName) {
                    nextData.system = {
                        ...nextData.system,
                        components: components.map((component: any) => (component.id === rootDevice.id ? { ...component, name: deviceName } : component)),
                    };
                    nextData.dfd = reconcileSystemDfd(nextData.system, nextData.dfd, 'system');
                }
            }
        }
        if (step === 'system') nextData.dfd = reconcileSystemDfd(nextData.system, nextData.dfd, 'system');
        if (step === 'dfd') {
            nextData.system = reconcileDfdSystem(nextData.system, nextData.dfd);
            nextData.dfd = reconcileSystemDfd(nextData.system, nextData.dfd, 'dfd');
        }
        const enforced = ensureDeviceHousing(nextData.system, nextData.dfd);
        nextData.system = enforced.system;
        nextData.dfd = enforced.dfd;
        const schemeSelection = step === 'project'
            ? schemeForProject(nextData.project, get().riskSchemes, get().riskSchemeFingerprints)
            : {};
        set({ data: nextData, ...schemeSelection });
        const id = get().activeId;
        if (!id) return;
        clearTimeout(saveTimers[step]);
        clearTimeout(saveTimers.dfd);
        clearTimeout(saveTimers.system);
        set({ saveState: 'saving' });
        saveTimers[step] = setTimeout(() => {
            const latest = get().data;
            if (latest) sendSave(id, step, (latest as any)[step]);
        }, 160);
        if (step === 'system') {
            saveTimers.dfd = setTimeout(() => {
                const latest = get().data;
                if (latest) sendSave(id, 'dfd', latest.dfd);
            }, 160);
        }
        if (step === 'project') {
            saveTimers.system = setTimeout(() => {
                const latest = get().data;
                if (latest) sendSave(id, 'system', latest.system);
            }, 160);
            saveTimers.dfd = setTimeout(() => {
                const latest = get().data;
                if (latest) sendSave(id, 'dfd', latest.dfd);
            }, 160);
        }
        if (step === 'dfd') {
            saveTimers.system = setTimeout(() => {
                const latest = get().data;
                if (latest) sendSave(id, 'system', latest.system);
            }, 160);
        }
    },

    renameId(oldId, newId) {
        const data = get().data;
        if (!data || !oldId || !newId || oldId === newId) return;
        pushHistory(data, 'rename');
        histSuppress = true;
        const m = (id: any) => (id === oldId ? newId : id);
        const arr = (a?: any[]) => (Array.isArray(a) ? a.map(m) : a);
        const remapStride = (obj?: Record<string, any>) => {
            if (!obj) return obj;
            const out: Record<string, any> = {};
            for (const [pk, v] of Object.entries(obj)) {
                // Remap any occurrence of oldId in the pair key (which is two endpoint IDs sorted and joined).
                const newPk = pk.split('~').map((p: string) => (p === oldId ? newId : p)).sort().join('~');
                const endpoints: Record<string, any> = {};
                for (const [eid, e] of Object.entries((v as any)?.endpoints || {}))
                    endpoints[eid === oldId ? newId : eid] = e;
                out[newPk] = { ...(v as any), endpoints };
            }
            return out;
        };
        const mapNode = (n: any): any => ({ ...n, countermeasureRef: n.countermeasureRef === oldId ? newId : n.countermeasureRef, children: (n.children || []).map(mapNode) });
        const next: Record<string, any> = {
            system: {
                ...data.system,
                components: (data.system.components || []).map((c) => ({ ...c, id: m(c.id), parent: c.parent === oldId ? newId : c.parent })),
                interfaces: (data.system.interfaces || []).map((i) => ({ ...i, id: m(i.id), component: i.component === oldId ? newId : i.component })),
                trustBoundaries: (data.system.trustBoundaries || []).map((b) => ({ ...b, id: m(b.id), members: arr(b.members) })),
                assets: (data.system.assets || []).map((a) => ({ ...a, id: m(a.id), components: arr(a.components) })),
                strideAnalyses: remapStride(data.system.strideAnalyses),
            },
            threats: {
                threats: (data.threats.threats || []).map((t) => ({ ...t, id: m(t.id), components: arr(t.components), assets: arr(t.assets), attackerRef: t.attackerRef === oldId ? newId : t.attackerRef, interfaceRef: t.interfaceRef === oldId ? newId : t.interfaceRef, interfaceRefs: arr(t.interfaceRefs), countermeasures: arr(t.countermeasures) })),
            },
            requirements: {
                requirements: (data.requirements?.requirements || []).map((r) => ({ ...r, id: m(r.id), derivedFromThreat: arr(r.derivedFromThreat), satisfiedByCM: arr(r.satisfiedByCM) })),
            },
            countermeasures: {
                countermeasures: (data.countermeasures.countermeasures || []).map((c) => ({ ...c, id: m(c.id), components: arr(c.components), addresses: (c.addresses || []).map((a) => ({ ...a, threat: a.threat === oldId ? newId : a.threat })) })),
            },
            attackTrees: {
                trees: (data.attackTrees?.trees || []).map((t) => ({
                    ...t,
                    id: m(t.id),
                    threatRef: t.threatRef === oldId ? newId : t.threatRef,
                    threatRefs: (t.threatRefs || []).map((r: string) => (r === oldId ? newId : r)),
                    root: mapNode(t.root),
                })),
            },
            defects: { defects: (data.defects?.defects || []).map((d) => ({ ...d, id: m(d.id), component: d.component === oldId ? newId : d.component })) },
            assumptions: { ...data.assumptions, attacker: (data.assumptions.attacker || []).map((a) => ({ ...a, id: m(a.id) })) },
            dfd: {
                nodes: (data.dfd.nodes || []).map((n) => ({ ...n, id: m(n.id), parent: n.parent === oldId ? newId : n.parent, componentRef: n.componentRef === oldId ? newId : n.componentRef, members: arr(n.members) })),
                flows: (data.dfd.flows || []).map((f) => ({ ...f, from: m(f.from), to: m(f.to) })),
            },
        };
        for (const step of ['system', 'threats', 'requirements', 'countermeasures', 'attackTrees', 'defects', 'assumptions', 'dfd'] as StepKey[]) {
            if (JSON.stringify((data as any)[step]) !== JSON.stringify(next[step])) get().save(step, next[step]);
        }
        histSuppress = false;
        set({ dfdPath: get().dfdPath.map(m), selectedNodeId: get().selectedNodeId === oldId ? newId : get().selectedNodeId === `iface:${oldId}` ? `iface:${newId}` : get().selectedNodeId });
    },

    undo() {
        if (!undoStack.length) return;
        const cur = get().data;
        if (!cur) return;
        const prev = undoStack.pop()!;
        redoStack.push(cloneData(cur));
        histStep = '';
        histTime = 0;
        restoreSnapshot(prev, cur);
        set({ undoDepth: undoStack.length, redoDepth: redoStack.length });
    },
    redo() {
        if (!redoStack.length) return;
        const cur = get().data;
        if (!cur) return;
        const nextSnap = redoStack.pop()!;
        undoStack.push(cloneData(cur));
        histStep = '';
        histTime = 0;
        restoreSnapshot(nextSnap, cur);
        set({ undoDepth: undoStack.length, redoDepth: redoStack.length });
    },

    applyArtifact(step, value) {
        const data = get().data;
        if (!data) return;
        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
        if (JSON.stringify((data as any)[step]) === JSON.stringify(value)) return;
        const nextData = { ...data, [step]: value };
        const schemeSelection = step === 'project'
            ? schemeForProject(nextData.project, get().riskSchemes, get().riskSchemeFingerprints)
            : {};
        set({ data: nextData, ...schemeSelection });
    },

    async report() {
        const id = get().activeId;
        if (!id) return null;
        return postJSON<{ html: string; issues: { key: string; message: string; severity: string }[] }>(`/api/projects/${id}/report`, {});
    },
}));

function connect() {
    socket = new WebSocket(wsUrl());
    socket.onopen = () => {
        useStore.setState({ connected: true });
        const id = useStore.getState().activeId;
        if (id) subscribe(id);
    };
    socket.onclose = () => {
        const s = useStore.getState();
        useStore.setState({ connected: false, saveState: s.saveState === 'saving' ? 'offline' : s.saveState });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1500);
    };
    socket.onerror = () => socket?.close();
    socket.onmessage = (ev) => {
        let msg: any;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        const st = useStore.getState();
        if (msg.type === 'artifact' && msg.id === st.activeId) st.applyArtifact(msg.step, msg.data);
        else if (msg.type === 'saved' && msg.id === st.activeId) useStore.setState({ saveState: 'saved', lastSavedAt: Date.now() });
        else if (msg.type === 'projects-changed') st.refreshProjects();
    };
}

function subscribe(id: string) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribe', id }));
}

function sendSave(id: string, step: string, data: unknown) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'save', id, step, data }));
        // The server replies with a 'saved' ack, which flips saveState to 'saved'.
    } else {
        // Fallback to REST if the socket is momentarily down.
        fetch(`/api/projects/${id}/${step}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
        })
            .then((r) => useStore.setState(r.ok ? { saveState: 'saved', lastSavedAt: Date.now() } : { saveState: 'offline' }))
            .catch(() => useStore.setState({ saveState: 'offline' }));
    }
}

// Small id helper used across panels.
export const uid = (prefix: string, existing: string[]) => {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const used = new Set<number>();
    const rx = new RegExp(`^${esc}(\\d+)$`);
    for (const id of existing) {
        const m = rx.exec(id);
        if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return `${prefix}${n}`;
};
