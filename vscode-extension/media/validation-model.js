/* Isomorphic core validator: error-severity identity, duplicate-ID and reference-integrity rules
   ported from webapp/server/src/validate.js. Side-effect free; issues are { severity, message, key }. */
(function (g) {
  "use strict";

  const arr = (x) => (Array.isArray(x) ? x : []);
  const ID_PATTERN = /^[A-Za-z0-9 _\-:.]+$/;

  function validateCore({ assumptions = {}, system = {}, threats = {}, requirements = {}, countermeasures = {}, dfd = {}, attackTrees = {}, defects = {} } = {}) {
    const issues = [];
    const add = (severity, message, key) => issues.push({ severity, message, key: key ?? message });
    const threatList = arr(threats.threats ?? threats);
    const cmList = arr(countermeasures.countermeasures ?? countermeasures);
    const reqList = arr(requirements.requirements ?? requirements);
    const defectList = arr(defects.defects ?? defects);
    const components = arr(system.components);
    const interfaces = arr(system.interfaces);
    const compIds = new Set(components.map((c) => c.id));
    const assetIds = new Set(arr(system.assets).map((a) => a.id));
    const ifaceIds = new Set(interfaces.map((i) => i.id));
    const attackers = arr(assumptions.attacker);
    const assumptionIds = new Set([
      ...arr(assumptions.device).map((x) => x.id),
      ...arr(assumptions.system).map((x) => x.id),
      ...arr(assumptions.environment).map((x) => x.id),
      ...arr(assumptions.operational).map((x) => x.id),
      ...attackers.map((x) => x.id),
    ].filter(Boolean));
    const attackerIds = new Set(attackers.map((a) => a.id));
    const tIds = new Set(threatList.map((t) => t.id));
    const cmIds = new Set(cmList.map((c) => c.id));

    const tbIds = new Set(arr(system.trustBoundaries).map((b) => b.id));
    const allIds = [
      ...components.map((c) => ({ id: c.id, kind: "component" })),
      ...interfaces.map((i) => ({ id: i.id, kind: "interface" })),
      ...arr(system.trustBoundaries).map((b) => ({ id: b.id, kind: "trust boundary" })),
      ...arr(system.assets).map((a) => ({ id: a.id, kind: "asset" })),
      ...threatList.map((t) => ({ id: t.id, kind: "threat" })),
      ...reqList.map((r) => ({ id: r.id, kind: "requirement" })),
      ...cmList.map((c) => ({ id: c.id, kind: "countermeasure" })),
      ...arr(attackTrees.trees).map((t) => ({ id: t.id, kind: "attack tree" })),
      ...defectList.map((d) => ({ id: d.id, kind: "defect" })),
      ...attackers.map((a) => ({ id: a.id, kind: "attacker profile" })),
      // A trust-boundary DFD node reuses the id of its system trust boundary (same entity).
      ...arr(dfd.nodes).filter((n) => !tbIds.has(n.id)).map((n) => ({ id: n.id, kind: "DFD node" })),
    ].filter((x) => x.id);
    const seenId = new Map();
    for (const { id, kind } of allIds) {
      if (seenId.has(id)) add("error", `Duplicate ID '${id}' — used by ${seenId.get(id)} and ${kind}. IDs must be unique across the project.`);
      else seenId.set(id, kind);
    }

    for (const t of threatList) {
      if (!t.id) add("error", "A threat is missing its ID.");
      for (const c of arr(t.components)) if (!compIds.has(c)) add("error", `${t.id}: references unknown component '${c}'.`);
      for (const a of arr(t.assets)) if (!assetIds.has(a)) add("error", `${t.id}: references unknown asset '${a}'.`);
      if (t.attackerRef && !attackerIds.has(t.attackerRef)) add("error", `${t.id}: references unknown attacker profile '${t.attackerRef}'.`);
      for (const iface of arr(t.interfaceRefs)) if (!ifaceIds.has(iface)) add("error", `${t.id}: references unknown interface '${iface}'.`);
      if (t.interfaceRef && !ifaceIds.has(t.interfaceRef)) add("error", `${t.id}: references unknown interface '${t.interfaceRef}'.`);
      for (const aid of arr(t.assumptionRefs)) {
        if (!ID_PATTERN.test(aid)) add("error", `${t.id}: references invalid assumption ID '${aid}'.`);
        else if (!assumptionIds.has(aid)) add("error", `${t.id}: references unknown assumption '${aid}'.`);
      }
    }

    for (const c of cmList) {
      if (!c.id) add("error", "A countermeasure is missing its ID.");
      for (const a of arr(c.addresses)) if (!tIds.has(a.threat)) add("error", `${c.id}: addresses unknown threat '${a.threat}'.`);
      for (const comp of arr(c.components)) if (!compIds.has(comp)) add("error", `${c.id}: references unknown component '${comp}'.`);
    }

    for (const r of reqList) {
      for (const th of arr(r.derivedFromThreat)) if (!tIds.has(th)) add("error", `${r.id}: derived from unknown threat '${th}'.`);
      for (const cm of arr(r.satisfiedByCM)) if (!cmIds.has(cm)) add("error", `${r.id}: satisfied by unknown countermeasure '${cm}'.`);
    }

    const boundaryIds = new Set([
      ...arr(system.trustBoundaries).map((b) => b.id),
      ...arr(dfd.nodes).filter((n) => n.type === "trust-boundary").map((n) => n.id),
    ]);
    for (const f of arr(dfd.flows)) {
      if (f.crossesBoundary && !boundaryIds.has(f.crossesBoundary))
        add("error", `Flow '${f.id}' references unknown trust boundary '${f.crossesBoundary}'.`);
    }
    for (const d of defectList) {
      if (d.component && !compIds.has(d.component)) add("error", `${d.id || "defect"}: references unknown component '${d.component}'.`);
      if (d.threatRef && !tIds.has(d.threatRef)) add("error", `${d.id || "defect"}: references unknown threat '${d.threatRef}'.`);
    }
    for (const tr of arr(attackTrees.trees)) {
      const refs = [...new Set([...arr(tr.threatRefs), ...(tr.threatRef ? [tr.threatRef] : [])])];
      for (const ref of refs)
        if (!tIds.has(ref)) add("error", `Attack tree '${tr.id}' references unknown threat '${ref}'.`);
    }

    return issues;
  }

  const api = { validateCore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.ValidationModel = api;
})(typeof window !== "undefined" ? window : globalThis);
