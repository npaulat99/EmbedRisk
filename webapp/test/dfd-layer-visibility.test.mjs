import assert from 'node:assert/strict';
import * as webappLayerVisibility from '../client/src/components/dfd/layerVisibility.js';
let { deriveVisibleInterfaceIds, flowBelongsToLayerContext, isDeviceBoundaryInterfaceFlow, isParentChildNodeFlow } = webappLayerVisibility;

export function runLayerVisibilityTests(api = webappLayerVisibility) {
    ({ deriveVisibleInterfaceIds, flowBelongsToLayerContext, isDeviceBoundaryInterfaceFlow, isParentChildNodeFlow } = api);

function baseFixture() {
    const components = [
        { id: 'DEV', name: 'Device', kind: 'device', layer: 1, parent: null },
        { id: 'C-MCU', name: 'MCU', kind: 'hardware', layer: 2, parent: 'DEV' },
        { id: 'C-FW', name: 'Firmware', kind: 'software', layer: 3, parent: 'C-MCU' },
    ];
    const compById = new Map(components.map((component) => [component.id, component]));
    const interfaces = [{ id: 'IF-X', name: 'External link', component: 'C-FW', exposure: 'adjacent' }];
    const nodes = [
        { id: 'N-DEV', componentRef: 'DEV', parent: null, type: 'process' },
        { id: 'N-MCU', componentRef: 'C-MCU', parent: 'N-DEV', type: 'process' },
        { id: 'N-FW', componentRef: 'C-FW', parent: 'N-MCU', type: 'process' },
        { id: 'N-EXT', parent: null, type: 'external-entity' },
    ];
    return {
        nodes,
        compById,
        interfaces,
        visibleRealNodes: [nodes[2]],
        currentParent: 'N-MCU',
        externalFlow: { id: 'F-EXT', from: 'IF-X', to: 'N-EXT' },
        handoffFlow: { id: 'F-HANDOFF', from: 'N-MCU', to: 'IF-X' },
    };
}

function testDeviceBoundaryExceptionAppliesOnlyToRootDeviceLayer() {
    const fixture = baseFixture();
    assert.equal(
        isDeviceBoundaryInterfaceFlow({
            currentParent: 'N-DEV',
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
            interfaceId: 'IF-X',
            otherEndpointId: 'N-EXT',
        }),
        true,
    );
    assert.equal(
        isDeviceBoundaryInterfaceFlow({
            currentParent: fixture.currentParent,
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
            interfaceId: 'IF-X',
            otherEndpointId: 'N-EXT',
        }),
        false,
    );
}

function testL2DeviceBoundaryShowsExternalInterfaceFlow() {
    const fixture = baseFixture();
    const visibleIfaceIds = deriveVisibleInterfaceIds({
        currentParent: 'N-DEV',
        interfaces: fixture.interfaces,
        flows: [fixture.externalFlow],
        nodes: fixture.nodes,
        visibleRealNodes: [fixture.nodes[1]],
        compById: fixture.compById,
    });
    assert.equal(visibleIfaceIds.has('IF-X'), true);

    const visibleRealNodeIds = new Set(['N-MCU']);
    assert.equal(
        flowBelongsToLayerContext({
            flow: fixture.externalFlow,
            currentParent: 'N-DEV',
            visibleRealNodeIds,
            visibleIfaceIds,
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
        }),
        true,
    );
}

function testL3DoesNotShowDescendantInterfaceWithoutContextFlow() {
    const fixture = baseFixture();
    const visibleIfaceIds = deriveVisibleInterfaceIds({
        currentParent: fixture.currentParent,
        interfaces: fixture.interfaces,
        flows: [fixture.externalFlow],
        nodes: fixture.nodes,
        visibleRealNodes: fixture.visibleRealNodes,
        compById: fixture.compById,
    });
    assert.equal(visibleIfaceIds.has('IF-X'), false);

    const visibleRealNodeIds = new Set(fixture.visibleRealNodes.map((node) => node.id));
    assert.equal(
        flowBelongsToLayerContext({
            flow: fixture.externalFlow,
            currentParent: fixture.currentParent,
            visibleRealNodeIds,
            visibleIfaceIds,
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
        }),
        false,
    );
}

function testExplicitHandoffMakesInterfaceVisible() {
    const fixture = baseFixture();
    const visibleIfaceIds = deriveVisibleInterfaceIds({
        currentParent: fixture.currentParent,
        interfaces: fixture.interfaces,
        flows: [fixture.externalFlow, fixture.handoffFlow],
        nodes: fixture.nodes,
        visibleRealNodes: fixture.visibleRealNodes,
        compById: fixture.compById,
    });
    assert.equal(visibleIfaceIds.has('IF-X'), true);

    const visibleRealNodeIds = new Set(fixture.visibleRealNodes.map((node) => node.id));
    assert.equal(
        flowBelongsToLayerContext({
            flow: fixture.externalFlow,
            currentParent: fixture.currentParent,
            visibleRealNodeIds,
            visibleIfaceIds,
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
        }),
        true,
    );
}

function testParentChildNodeFlowNeverBelongsToAnyLayer() {
    const fixture = baseFixture();
    // A flow directly between a container node and its own nested child (e.g. MCU -> Firmware)
    // must never be treated as belonging to a layer, whether viewed from the parent's layer (where
    // the container endpoint is trivially visible) or from inside the child's own layer.
    const parentChildFlow = { id: 'F-PC', from: 'N-MCU', to: 'N-FW' };
    assert.equal(isParentChildNodeFlow(parentChildFlow, fixture.nodes), true);

    assert.equal(
        flowBelongsToLayerContext({
            flow: parentChildFlow,
            currentParent: 'N-DEV',
            visibleRealNodeIds: new Set(['N-MCU']),
            visibleIfaceIds: new Set(),
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
        }),
        false,
    );
    assert.equal(
        flowBelongsToLayerContext({
            flow: parentChildFlow,
            currentParent: 'N-MCU',
            visibleRealNodeIds: new Set(['N-FW']),
            visibleIfaceIds: new Set(),
            nodes: fixture.nodes,
            compById: fixture.compById,
            interfaces: fixture.interfaces,
        }),
        false,
    );
}

    testDeviceBoundaryExceptionAppliesOnlyToRootDeviceLayer();
    testL2DeviceBoundaryShowsExternalInterfaceFlow();
    testL3DoesNotShowDescendantInterfaceWithoutContextFlow();
    testExplicitHandoffMakesInterfaceVisible();
    testParentChildNodeFlowNeverBelongsToAnyLayer();
}

runLayerVisibilityTests();
console.log('dfd layer visibility tests passed');