/* Isomorphic STRIDE boundary-pair and authored-content rules. */
(function (g) {
  "use strict";

  const STRIDE_KEYS = ["S", "T", "R", "I", "D", "E"];
  const STRIDE_LABEL = {
    S: "Spoofing",
    T: "Tampering",
    R: "Repudiation",
    I: "Information disclosure",
    D: "Denial of service",
    E: "Elevation of privilege",
  };

  function boundaryPairs(system, dfd, tbId) {
    const tbDfdNode = (dfd.nodes || []).find((n) => n.id === tbId && n.type === "trust-boundary");
    if (!tbDfdNode) return [];
    const insideNodeIds = new Set(tbDfdNode.members || []);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of dfd.nodes || []) {
        if (n.parent && insideNodeIds.has(n.parent) && !insideNodeIds.has(n.id)) {
          insideNodeIds.add(n.id);
          changed = true;
        }
      }
    }

    const nodeById = new Map((dfd.nodes || []).map((n) => [n.id, n]));
    const ifaceById = new Map((system.interfaces || []).map((i) => [i.id, i]));
    const dfdNodeForComp = (compId) => (dfd.nodes || []).find((n) => n.componentRef === compId);
    const isInsideEndpoint = (ep) => {
      if (insideNodeIds.has(ep)) return true;
      const iface = ifaceById.get(ep);
      if (iface?.component) {
        const compNode = dfdNodeForComp(iface.component);
        if (compNode && insideNodeIds.has(compNode.id)) return true;
      }
      return false;
    };
    const endpointLabel = (ep) => nodeById.get(ep)?.label ?? ifaceById.get(ep)?.name ?? ep;

    const seen = new Map();
    for (const f of dfd.flows || []) {
      if (!f.from || !f.to) continue;
      const fromIn = isInsideEndpoint(f.from);
      const toIn = isInsideEndpoint(f.to);
      if (fromIn === toIn) continue;
      const key = [f.from, f.to].sort().join("~");
      if (seen.has(key)) continue;
      const [insideEp, outsideEp] = fromIn ? [f.from, f.to] : [f.to, f.from];
      seen.set(key, {
        key,
        inside: { id: insideEp, label: endpointLabel(insideEp) },
        outside: { id: outsideEp, label: endpointLabel(outsideEp) },
      });
    }
    return [...seen.values()];
  }

  const hasText = (items) => (items || []).some((x) => x && x.trim());
  const cellHasContent = (cell) => !!cell && (hasText(cell.strengths) || hasText(cell.weaknesses));
  function analysisHasContent(a) {
    if (!a?.endpoints) return false;
    return Object.values(a.endpoints).some((side) =>
      side && Object.values(side.cells || {}).some((c) => cellHasContent(c)));
  }
  function anyPairHasContent(analyses) {
    return !!analyses && Object.values(analyses).some((a) => analysisHasContent(a));
  }

  const api = { STRIDE_KEYS, STRIDE_LABEL, boundaryPairs, analysisHasContent, anyPairHasContent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.StrideModel = api;
})(typeof window !== "undefined" ? window : globalThis);
