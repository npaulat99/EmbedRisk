import type { ViewKey } from '../types';

export type RouteView = ViewKey | 'dashboard' | 'kb';
export type RouteHistoryMode = 'push' | 'replace' | 'none';
export type HashRoute = { view: RouteView; id?: string };

const ROUTES = new Set<RouteView>([
    'project',
    'assumptions',
    'system',
    'dfd',
    'useCases',
    'threats',
    'requirements',
    'countermeasures',
    'attackTrees',
    'review',
    'versions',
    'defects',
    'dashboard',
    'kb',
]);

export function parseHashRoute(hash: string): HashRoute | null {
    if (!hash.startsWith('#/')) return null;
    try {
        const [rawView, rawId] = hash.slice(2).split('/');
        const view = decodeURIComponent(rawView) as RouteView;
        if (!ROUTES.has(view)) return null;
        const id = rawId ? decodeURIComponent(rawId) : undefined;
        return { view, ...(id ? { id } : {}) };
    } catch {
        return null;
    }
}

export function serializeHashRoute(route: HashRoute): string {
    const view = encodeURIComponent(route.view);
    const id = route.id ? `/${encodeURIComponent(route.id)}` : '';
    return `#/${view}${id}`;
}

export function writeHashRoute(route: HashRoute, mode: RouteHistoryMode = 'push') {
    if (mode === 'none' || typeof window === 'undefined') return;
    const hash = serializeHashRoute(route);
    if (window.location.hash === hash) return;
    if (mode === 'push') {
        window.location.hash = hash;
    } else {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
}
