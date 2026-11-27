export function resolveTargetNodeId(componentId, visibleRealNodes, compById) {
    let current = componentId;
    const seen = new Set();
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = visibleRealNodes.find((candidate) => candidate.componentRef === current);
        if (node) return node.id;
        current = compById.get(current)?.parent ?? null;
    }
    return null;
}

function isDescendantOrSelf(componentId, ancestorId, compById) {
    let current = componentId;
    const seen = new Set();
    while (current && !seen.has(current)) {
        if (current === ancestorId) return true;
        seen.add(current);
        current = compById.get(current)?.parent ?? null;
    }
    return false;
}

function isNodeAncestor(ancestorId, nodeId, nodes) {
    const byId = new Map((nodes || []).map((node) => [node.id, node]));
    let current = byId.get(nodeId)?.parent ?? null;
    const seen = new Set();
    while (current != null && !seen.has(current)) {
        if (current === ancestorId) return true;
        seen.add(current);
        current = byId.get(current)?.parent ?? null;
    }
    return false;
}

// A flow whose two endpoints are DFD nodes in a parent/child relationship (e.g. a container and its
// own nested sub-component) can never belong to a single layer view — the two ends are never visible
// as peers at the same time. Left unguarded, such a flow leaks into the parent's layer (because the
// container endpoint is trivially visible there) and produces a nonsensical self-port when viewed
// inside the child layer itself.
export function isParentChildNodeFlow(flow, nodes) {
    return isNodeAncestor(flow.from, flow.to, nodes) || isNodeAncestor(flow.to, flow.from, nodes);
}

export function isDeviceBoundaryInterfaceFlow({ currentParent, nodes, compById, interfaces, interfaceId, otherEndpointId }) {
    const parentNode = (nodes || []).find((node) => node.id === currentParent);
    const parentComponent = parentNode?.componentRef ? compById.get(parentNode.componentRef) : null;
    if (!parentComponent || parentComponent.kind !== 'device' || parentComponent.parent != null) return false;

    const itf = (interfaces || []).find((candidate) => candidate.id === interfaceId);
    if (!itf?.component) return false;
    if (!isDescendantOrSelf(itf.component, parentComponent.id, compById)) return false;

    const otherNode = (nodes || []).find((node) => node.id === otherEndpointId);
    if (!otherNode) return false;
    return (otherNode.parent ?? null) !== currentParent;
}

export function deriveVisibleInterfaceIds({ currentParent, interfaces, flows, nodes, visibleRealNodes, compById }) {
    const ids = new Set();
    const visibleRealNodeIds = new Set(visibleRealNodes.map((node) => node.id));
    const shownInterfaces = (interfaces || []).filter((itf) => !itf.hidden);
    if (currentParent == null) {
        for (const itf of shownInterfaces) ids.add(itf.id);
        return ids;
    }
    for (const itf of shownInterfaces) {
        if (!resolveTargetNodeId(itf.component, visibleRealNodes, compById)) continue;
        const connectedToContext = (flows || []).some((flow) => {
            if (flow.from !== itf.id && flow.to !== itf.id) return false;
            const other = flow.from === itf.id ? flow.to : flow.from;
            return other === currentParent || visibleRealNodeIds.has(other) || isDeviceBoundaryInterfaceFlow({ currentParent, nodes, compById, interfaces, interfaceId: itf.id, otherEndpointId: other });
        });
        if (connectedToContext) ids.add(itf.id);
    }
    return ids;
}

// A node nested inside a node that is visible on this layer is part of that node's inner layer.
// Flows touching it are drawn when drilling in, not as extra port chips on the outer layer.
function isNestedInVisibleNode(nodeId, visibleRealNodeIds, nodes) {
    const byId = new Map((nodes || []).map((node) => [node.id, node]));
    let current = byId.get(nodeId)?.parent ?? null;
    const seen = new Set();
    while (current != null && !seen.has(current)) {
        if (visibleRealNodeIds.has(current)) return true;
        seen.add(current);
        current = byId.get(current)?.parent ?? null;
    }
    return false;
}

export function flowBelongsToLayerContext({ flow, currentParent, visibleRealNodeIds, visibleIfaceIds, nodes, compById, interfaces }) {
    if (isParentChildNodeFlow(flow, nodes)) return false;
    if (isNestedInVisibleNode(flow.from, visibleRealNodeIds, nodes) || isNestedInVisibleNode(flow.to, visibleRealNodeIds, nodes)) return false;
    const flowFromDeviceBoundary = isDeviceBoundaryInterfaceFlow({
        currentParent,
        nodes,
        compById,
        interfaces,
        interfaceId: flow.from,
        otherEndpointId: flow.to,
    });
    const flowToDeviceBoundary = isDeviceBoundaryInterfaceFlow({
        currentParent,
        nodes,
        compById,
        interfaces,
        interfaceId: flow.to,
        otherEndpointId: flow.from,
    });
    return (
        flow.from === currentParent ||
        flow.to === currentParent ||
        visibleRealNodeIds.has(flow.from) ||
        visibleRealNodeIds.has(flow.to) ||
        visibleIfaceIds.has(flow.from) ||
        visibleIfaceIds.has(flow.to) ||
        flowFromDeviceBoundary ||
        flowToDeviceBoundary
    );
}