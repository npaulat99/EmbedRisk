import { useState } from 'react';
import { useStore, uid } from '../../state/store';
import { announce } from '../LiveStatus';
import { TableRegion, confirmDelete } from '../common';
import { isParentChildNodeFlow } from './layerVisibility.js';
import type { DfdNode, DfdNodeType } from '../../types';

const NODE_TYPES: DfdNodeType[] = ['process', 'multiprocess', 'store', 'external-entity', 'trust-boundary'];

export default function DfdElements() {
    const data = useStore((state) => state.data)!;
    const save = useStore((state) => state.save);
    const setDfdPath = useStore((state) => state.setDfdPath);
    const selectNode = useStore((state) => state.selectNode);
    const selectEdge = useStore((state) => state.selectEdge);
    const dfd = data.dfd;
    const boundaries = dfd.nodes.filter((node) => node.type === 'trust-boundary');
    const components = data.system.components || [];
    const interfaces = (data.system.interfaces || []).filter((iface) => !iface.hidden);
    const endpoints = [
        ...dfd.nodes.filter((node) => node.type !== 'trust-boundary').map((node) => ({ id: node.id, label: `${node.label} (${node.id})` })),
        ...interfaces.map((iface) => ({ id: iface.id, label: `${iface.name} (${iface.id})` })),
    ];
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [flowLabel, setFlowLabel] = useState('');

    const updateNode = (id: string, patch: Partial<DfdNode>) => {
        save('dfd', { ...dfd, nodes: dfd.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) });
    };
    const updateFlow = (id: string, patch: Record<string, unknown>) => {
        save('dfd', { ...dfd, flows: dfd.flows.map((flow) => flow.id === id ? { ...flow, ...patch } : flow) });
    };
    const updateFlowEndpoint = (id: string, patch: { from?: string; to?: string }) => {
        const flow = dfd.flows.find((item) => item.id === id);
        if (!flow) return;
        const next = { from: patch.from || flow.from, to: patch.to || flow.to };
        if (next.from === next.to || isParentChildNodeFlow(next, dfd.nodes)) {
            announce('A container and its own nested component cannot be connected directly.');
            return;
        }
        updateFlow(id, { ...patch, ...(patch.from ? { sourceHandle: undefined } : {}), ...(patch.to ? { targetHandle: undefined } : {}) });
    };
    const requestInspector = () => {
        if (window.matchMedia('(max-width: 1279px)').matches) window.dispatchEvent(new Event('embedrisk:open-inspector'));
    };
    const openInspector = (node: DfdNode) => {
        const path: string[] = [];
        let parent = node.parent ?? null;
        while (parent) {
            path.unshift(parent);
            parent = dfd.nodes.find((item) => item.id === parent)?.parent ?? null;
        }
        setDfdPath(path);
        selectEdge(null);
        selectNode(node.id);
        requestInspector();
    };
    const openInterfaceInspector = (id: string) => {
        selectEdge(null);
        selectNode(`iface:${id}`);
        requestInspector();
    };
    const openFlowInspector = (id: string) => {
        selectNode(null);
        selectEdge(id);
        requestInspector();
    };
    const setNodeBoundary = (node: DfdNode, boundaryId: string) => {
        const sameLayerBoundaries = boundaries.filter((boundary) => (boundary.parent ?? null) === (node.parent ?? null));
        save('dfd', {
            ...dfd,
            nodes: dfd.nodes.map((item) => {
                if (!sameLayerBoundaries.some((boundary) => boundary.id === item.id)) return item;
                const members = item.members || [];
                const nextMembers = item.id === boundaryId
                    ? [...new Set([...members, node.id])]
                    : members.filter((member) => member !== node.id);
                return { ...item, members: nextMembers };
            }),
        });
    };
    const deleteNode = async (node: DfdNode) => {
        if (node.id === 'TB-1') return;
        if (!(await confirmDelete(`DFD element ${node.id}`))) return;
        save('dfd', {
            ...dfd,
            nodes: dfd.nodes.filter((item) => item.id !== node.id),
            flows: dfd.flows.filter((flow) => flow.from !== node.id && flow.to !== node.id),
        });
        if (useStore.getState().selectedNodeId === node.id) selectNode(null);
        announce(`Deleted DFD element ${node.id}.`);
    };
    const deleteFlow = async (id: string) => {
        if (!(await confirmDelete(`data flow ${id}`))) return;
        save('dfd', { ...dfd, flows: dfd.flows.filter((flow) => flow.id !== id) });
        if (useStore.getState().selectedEdgeId === id) selectEdge(null);
        announce(`Deleted data flow ${id}.`);
    };
    const addFlow = (event: React.FormEvent) => {
        event.preventDefault();
        if (!from || !to || !flowLabel.trim()) return;
        if (isParentChildNodeFlow({ from, to }, dfd.nodes)) {
            announce('A container and its own nested component cannot be connected directly.');
            return;
        }
        const id = uid('F', dfd.flows.map((flow) => flow.id));
        save('dfd', { ...dfd, flows: [...dfd.flows, { id, from, to, label: flowLabel.trim() }] });
        announce(`Added data flow ${id}.`);
        setFrom('');
        setTo('');
        setFlowLabel('');
    };
    const endpointName = (id: string) => endpoints.find((endpoint) => endpoint.id === id)?.label || id;

    return (
        <div className="dfd-elements">
            <form className="dfd-elements-add" onSubmit={addFlow}>
                <h2>Add data flow</h2>
                <label>
                    <span>From</span>
                    <select className="inp" aria-label="Flow source" value={from} onChange={(event) => setFrom(event.target.value)} required>
                        <option value="">Select source…</option>
                        {endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
                    </select>
                </label>
                <label>
                    <span>To</span>
                    <select className="inp" aria-label="Flow target" value={to} onChange={(event) => setTo(event.target.value)} required>
                        <option value="">Select target…</option>
                        {endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
                    </select>
                </label>
                <label>
                    <span>Label</span>
                    <input className="inp" aria-label="Flow label" value={flowLabel} onChange={(event) => setFlowLabel(event.target.value)} required />
                </label>
                <button className="btn sm primary" type="submit" disabled={!from || !to || !flowLabel.trim()}>Add flow</button>
            </form>

            <TableRegion label="DFD elements">
                <table className="tbl">
                    <thead>
                        <tr>
                            <th scope="col">Layer</th>
                            <th scope="col">ID</th>
                            <th scope="col">Type</th>
                            <th scope="col">Name</th>
                            <th scope="col">From</th>
                            <th scope="col">To</th>
                            <th scope="col">Label</th>
                            <th scope="col">Trust boundary</th>
                            <th scope="col">Component</th>
                            <th scope="col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {dfd.nodes.map((node) => {
                            const memberBoundaries = boundaries.filter((boundary) => (boundary.members || []).includes(node.id));
                            const layerNodes = dfd.nodes.filter((item) => (item.parent ?? null) === (node.parent ?? null) && item.id !== node.id && item.type !== 'trust-boundary');
                            const layerBoundaryOptions = boundaries.filter((boundary) => (boundary.parent ?? null) === (node.parent ?? null));
                            return (
                                <tr key={`node:${node.id}`}>
                                    <td>{node.layer}</td>
                                    <th scope="row" className="mono">{node.id}</th>
                                    <td>
                                        <select className="inp" aria-label={`Type for ${node.id}`} value={node.type} onChange={(event) => updateNode(node.id, { type: event.target.value as DfdNodeType })}>
                                            {NODE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                                        </select>
                                    </td>
                                    <td><input className="inp" aria-label={`Name for ${node.id}`} value={node.label} onChange={(event) => updateNode(node.id, { label: event.target.value })} /></td>
                                    <td>—</td>
                                    <td>—</td>
                                    <td>—</td>
                                    <td>
                                        {node.type === 'trust-boundary' ? (
                                            <select
                                                className="inp"
                                                aria-label={`Boundary membership for ${node.id}`}
                                                multiple
                                                value={node.members || []}
                                                onChange={(event) => updateNode(node.id, { members: Array.from(event.target.selectedOptions, (option) => option.value) })}
                                            >
                                                {layerNodes.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.id})</option>)}
                                            </select>
                                        ) : (
                                            <select className="inp" aria-label={`Trust boundary for ${node.id}`} value={memberBoundaries[0]?.id || ''} onChange={(event) => setNodeBoundary(node, event.target.value)}>
                                                <option value="">— none —</option>
                                                {layerBoundaryOptions.map((boundary) => <option key={boundary.id} value={boundary.id}>{boundary.label}</option>)}
                                            </select>
                                        )}
                                    </td>
                                    <td>
                                        {node.type === 'trust-boundary' ? '—' : (
                                            <select className="inp" aria-label={`Linked component for ${node.id}`} value={node.componentRef || ''} onChange={(event) => updateNode(node.id, { componentRef: event.target.value || undefined })}>
                                                <option value="">— none —</option>
                                                {components.map((component) => <option key={component.id} value={component.id}>{component.name} ({component.id})</option>)}
                                            </select>
                                        )}
                                    </td>
                                    <td className="dfd-element-actions">
                                        <button className="btn sm" type="button" onClick={() => openInspector(node)}>Inspector</button>
                                        {node.id !== 'TB-1' && <button className="btn sm danger" type="button" aria-label={`Delete DFD element ${node.id}`} onClick={() => deleteNode(node)}>Delete</button>}
                                    </td>
                                </tr>
                            );
                        })}
                        {dfd.flows.map((flow) => (
                            <tr key={`flow:${flow.id}`}>
                                <td>—</td>
                                <th scope="row" className="mono">{flow.id}</th>
                                <td>Data flow</td>
                                <td>—</td>
                                <td>
                                    <select className="inp" aria-label={`Source for ${flow.id}`} value={flow.from} onChange={(event) => updateFlowEndpoint(flow.id, { from: event.target.value })}>
                                        {endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
                                    </select>
                                </td>
                                <td>
                                    <select className="inp" aria-label={`Target for ${flow.id}`} value={flow.to} onChange={(event) => updateFlowEndpoint(flow.id, { to: event.target.value })}>
                                        {endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
                                    </select>
                                </td>
                                <td><input className="inp" aria-label={`Label for ${flow.id}`} value={flow.label || ''} onChange={(event) => updateFlow(flow.id, { label: event.target.value })} /></td>
                                <td>
                                    <select className="inp" aria-label={`Crosses trust boundary for ${flow.id}`} value={flow.crossesBoundary || ''} onChange={(event) => updateFlow(flow.id, { crossesBoundary: event.target.value || null })}>
                                        <option value="">— none —</option>
                                        {boundaries.map((boundary) => <option key={boundary.id} value={boundary.id}>{boundary.label} ({boundary.id})</option>)}
                                    </select>
                                </td>
                                <td>—</td>
                                <td className="dfd-element-actions">
                                    <button className="btn sm" type="button" onClick={() => openFlowInspector(flow.id)}>Inspector</button>
                                    <button className="btn sm danger" type="button" aria-label={`Delete data flow ${flow.id}`} onClick={() => deleteFlow(flow.id)}>Delete</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </TableRegion>

            <div className="dfd-elements-derived">
                <h2>Interfaces</h2>
                {interfaces.map((iface) => (
                    <div className="dfd-element-interface" key={iface.id}>
                        <span className="mono">{iface.id}</span>
                        <span>{iface.name}</span>
                        <span className="muted">{iface.protocol || 'No protocol'} · {iface.exposure}</span>
                        <button className="btn sm" type="button" onClick={() => openInterfaceInspector(iface.id)}>Inspector</button>
                    </div>
                ))}
            </div>
        </div>
    );
}