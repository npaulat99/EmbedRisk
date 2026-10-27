/* Isomorphic core validator: error-severity identity, duplicate-ID and reference-integrity rules
   ported from webapp/server/src/validate.js. Side-effect free; issues are { severity, message, key }. */
(function (g) {
  "use strict";

  const arr = (x) => (Array.isArray(x) ? x : []);
  const ID_PATTERN = /^[A-Za-z0-9 _\-:.]+$/;
  const PROX = { remote: 1, adjacent: 2, local: 3, physical: 4 };
  const reqProx = (exposure) => (exposure >= 4 ? 1 : exposure === 3 ? 2 : exposure === 2 ? 3 : 4);
  const SLC_CAPABILITY = { 1: 1, 2: 2, 3: 3, 4: 5 };
  const COST_WEIGHT_KEYS = ["time", "exploitability", "window", "detection", "notoriety", "prep", "abort"];
  const DEFAULT_COST_WEIGHTS = { time: 0.25, exploitability: 0.2, window: 0.15, detection: 0.15, notoriety: 0.1, prep: 0.1, abort: 0.05 };

  function costWeightTotal(weights = {}) {
    return COST_WEIGHT_KEYS.reduce((sum, key) => sum + Math.max(0, Number(weights[key] ?? DEFAULT_COST_WEIGHTS[key]) || 0), 0);
  }

  function slcLevel(value) {
    const match = /(?:SL(?:-C)?\s*)?([1-4])/i.exec(String(value || ""));
    return match ? Number(match[1]) : null;
  }

  function residual(threat, cms) {
    if (threat.status === "unfeasible") return [0, 0];
    const links = [];
    cms.forEach((c) => {
      if (c.selected === false) return;
      arr(c.addresses).forEach((a) => { if (a.threat === threat.id) links.push(a); });
    });
    if (!links.length) return [threat.likelihood, threat.impact];
    let likelihood = threat.likelihood;
    let impact = threat.impact;
    links.forEach((a) => {
      likelihood = Math.min(likelihood, a.residualLikelihood == null ? threat.likelihood : a.residualLikelihood);
      impact = Math.min(impact, a.residualImpact == null ? threat.impact : a.residualImpact);
    });
    return [likelihood, impact];
  }

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

  function validate({ project = {}, assumptions = {}, system = {}, threats = {}, requirements = {}, countermeasures = {}, dfd = {}, useCases = {}, attackTrees = {}, defects = {} } = {}) {
    const issues = [];
    const add = (severity, message, key) => issues.push({ severity, message, key: key ?? message });
    const hasText = (value) => String(value || "").trim().length > 0;
    const threatList = arr(threats.threats ?? threats);
    const cmList = arr(countermeasures.countermeasures ?? countermeasures);
    const reqList = arr(requirements.requirements ?? requirements);
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
    const attackerById = new Map(attackers.map((a) => [a.id, a]));
    const tIds = new Set(threatList.map((t) => t.id));
    const cmIds = new Set(cmList.map((c) => c.id));
    const threatById = new Map(threatList.map((t) => [t.id, t]));
    const acceptableRisk = Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12;
    const selectedSlc = slcLevel(project.slTarget);
    const costBased = project.riskScoringMethod === "cost-based";

    if (costBased && Math.abs(costWeightTotal(project.costFactorWeights) - 1) > 1e-6)
      add("warning", `Cost-factor weights total ${costWeightTotal(project.costFactorWeights).toFixed(2)}; they must combine to 1.00.`, "cost-factor-weights");
    if (costBased) {
      for (const level of [1, 2, 3, 4, 5]) {
        const probability = project.accessProbabilities?.[level];
        if (typeof probability === "number" && (probability < 0.05 || probability > 1))
          add("warning", `Access probability for level ${level} must be between 0.05 and 1.00.`, `access-probability:${level}`);
      }
      const defaults = { 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };
      const thresholds = [2, 3, 4, 5].map((level) => project.likelihoodProbabilityThresholds?.[level] ?? defaults[level]);
      if (thresholds.some((value) => typeof value !== "number" || value <= 0 || value > 1) ||
        thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1]))
        add("warning", "Likelihood probability thresholds must be strictly increasing from L2 through L5 and within 0.01 to 1.00.", "likelihood-thresholds");
    }

    if (!attackers.length) add("warning", "No attacker assumptions (required to ground the likelihood assessment).", "no-attacker");
    if (selectedSlc) {
      const expectedId = `ATK-SLC-${selectedSlc}`;
      if (attackers.length !== 1 || attackers[0]?.id !== expectedId || attackers[0]?.capability !== SLC_CAPABILITY[selectedSlc])
        add("warning", `SL-C ${selectedSlc} requires the managed attacker profile '${expectedId}' (capability ${SLC_CAPABILITY[selectedSlc]}).`, "slc-attacker-profile");
    }

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
      ...arr(defects.defects ?? defects).map((d) => ({ id: d.id, kind: "defect" })),
      ...attackers.map((a) => ({ id: a.id, kind: "attacker profile" })),
      ...arr(dfd.nodes).filter((n) => !tbIds.has(n.id)).map((n) => ({ id: n.id, kind: "DFD node" })),
    ].filter((x) => x.id);
    const seenId = new Map();
    for (const { id, kind } of allIds) {
      if (seenId.has(id)) add("error", `Duplicate ID '${id}' — used by ${seenId.get(id)} and ${kind}. IDs must be unique across the project.`);
      else seenId.set(id, kind);
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const t of threatList) {
      if (!t.id) add("error", "A threat is missing its ID.");
      if (typeof t.likelihood !== "number" || typeof t.impact !== "number") add("warning", `${t.id || "threat"}: missing risk rating (likelihood/impact).`);
      if (!arr(t.stride).length) add("warning", `${t.id || "threat"}: no STRIDE category assigned.`);
      if (!arr(t.components).length) add("warning", `${t.id || "threat"}: orphaned threat (no affected component).`);
      for (const c of arr(t.components)) if (!compIds.has(c)) add("error", `${t.id}: references unknown component '${c}'.`);
      for (const a of arr(t.assets)) if (!assetIds.has(a)) add("error", `${t.id}: references unknown asset '${a}'.`);
      if (t.attackerRef && !attackerById.has(t.attackerRef)) add("error", `${t.id}: references unknown attacker profile '${t.attackerRef}'.`);
      if (selectedSlc && t.attackerRef !== `ATK-SLC-${selectedSlc}`)
        add("warning", `${t.id}: must use the selected SL-C attacker profile 'ATK-SLC-${selectedSlc}'.`, `slc-attacker:${t.id}`);
      for (const iface of arr(t.interfaceRefs)) if (!ifaceIds.has(iface)) add("error", `${t.id}: references unknown interface '${iface}'.`);
      if (t.interfaceRef && !ifaceIds.has(t.interfaceRef)) add("error", `${t.id}: references unknown interface '${t.interfaceRef}'.`);
      for (const aid of arr(t.assumptionRefs)) {
        if (!ID_PATTERN.test(aid)) add("error", `${t.id}: references invalid assumption ID '${aid}'.`);
        else if (!assumptionIds.has(aid)) add("error", `${t.id}: references unknown assumption '${aid}'.`);
      }
      const attacker = t.attackerRef ? attackerById.get(t.attackerRef) : null;
      const exposure = t.likelihoodFactors?.exposure;
      const exploit = t.likelihoodFactors?.exploitability;
      if (attacker && typeof exposure === "number" && (PROX[attacker.access] ?? 4) < reqProx(exposure))
        add("warning", `${t.id}: attacker ${attacker.id} (${attacker.access}) is not proximate enough to reach an exposure-${exposure} surface.`);
      if (t.likelihood >= 3 && attacker && typeof attacker.capability === "number" && typeof exploit === "number" && attacker.capability + exploit < 6)
        add("notice", `${t.id}: likelihood may be over-stated based on attacker ${attacker.id}'s capability. Accept if this is intentional.`, `capability-gate:${t.id}`);
      if (costBased) {
        if (typeof t.requiredSkill !== "number" || typeof t.requiredAccess !== "number" || !t.costFactors)
          add("warning", `${t.id}: cost-based scoring requires requiredSkill, requiredAccess, and all seven cost factors.`);
        const missingFactor = COST_WEIGHT_KEYS.some((key) => typeof t.costFactors?.[key] !== "number");
        if (t.costFactors && missingFactor)
          add("warning", `${t.id}: cost-based scoring has one or more unassessed difficulty dimensions.`);
        if (COST_WEIGHT_KEYS.some((key) => !hasText(t.costRationales?.[key])))
          add("warning", `${t.id}: cost-based scoring requires a rationale for each difficulty dimension.`);
        if (typeof t.costLikelihoodProposal === "number" && t.likelihood !== t.costLikelihoodProposal)
          add("notice", `${t.id}: manually selected likelihood (${t.likelihood}) differs from the calculated cost-based proposal (${t.costLikelihoodProposal}).`, `cost-likelihood-override:${t.id}:${t.costLikelihoodProposal}`);
        if (selectedSlc && typeof t.requiredSkill === "number" && t.requiredSkill > SLC_CAPABILITY[selectedSlc] && t.status !== "unfeasible")
          add("warning", `${t.id}: required skill exceeds the SL-C ${selectedSlc} attacker capability and should be marked unfeasible.`);
      }
      if (t.status === "accepted" && (!t.acceptedBy || !t.acceptanceRationale || !t.reviewDate))
        add("warning", `${t.id}: accepted residual risk requires a sign-off owner (acceptedBy), a rationale (acceptanceRationale) and a next-review date (reviewDate).`);
      if (arr(t.stride).some((s) => s === "S" || s === "T" || s === "I") && !t.classification)
        add("notice", `${t.id}: classification is unset for a spoofing/tampering/information-disclosure threat; classify whether this is a product vulnerability, protocol limitation, deployment risk, or shared responsibility.`, `threat-classification:${t.id}`);
      if (["protocol-limitation", "deployment-risk", "shared-responsibility"].includes(t.classification) && !hasText(t.deploymentConstraints) && t.status !== "accepted" && t.status !== "transferred")
        add("warning", `${t.id}: ${t.classification} classification requires deploymentConstraints unless the risk is accepted or transferred.`);
      if (t.classification === "product-vulnerability" && t.responsibility === "integrator-operator" && hasText(t.deploymentConstraints))
        add("warning", `${t.id}: product-vulnerability with integrator-operator responsibility and deploymentConstraints is contradictory.`);
      if (t.reviewDate && t.reviewDate < today) add("warning", `${t.id}: re-assessment overdue (review date ${t.reviewDate}).`);
      if (t.status === "mitigated") {
        const implemented = cmList.some((c) => arr(c.addresses).some((a) => a.threat === t.id) && (c.status === "implemented" || c.status === "verified"));
        if (!implemented) add("warning", `${t.id}: status 'mitigated' but no implemented/verified countermeasure addresses it.`);
      }
      const [rl, ri] = residual(t, cmList);
      const res = (rl || 0) * (ri || 0);
      if (res > acceptableRisk && t.status !== "accepted")
        add("warning", `${t.id || "threat"}: residual risk ${res} exceeds the acceptable risk (${acceptableRisk}) — reduce it or accept the residual.`, t.id ? `risk-over-acceptable:${t.id}` : undefined);
      if (project.rigorousMode) {
        if (!t.impactDimensions) add("warning", `${t.id}: rigorous mode requires the Bug Bar impact dimensions to be set.`);
        const factors = t.likelihoodFactors;
        if (!factors || (typeof factors.exposure !== "number" && typeof factors.exploitability !== "number"))
          add("warning", `${t.id}: rigorous mode requires the exposure / exploitability factors to be set.`);
        if (!t.ratedBy) add("warning", `${t.id}: rigorous mode requires the rater to be recorded (ratedBy).`);
      }
    }

    for (const i of interfaces) {
      if (typeof i.hidden !== "undefined" && typeof i.hidden !== "boolean")
        add("warning", `Interface '${i.id || i.name || "unknown"}': hidden must be a boolean when set.`);
    }
    const diagrams = Array.isArray(useCases?.diagrams) ? useCases.diagrams : [];
    if (diagrams.length > 0 && !project.reportOptions?.includeUseCases)
      add("notice", `Use-case diagrams exist (${diagrams.length}) but report inclusion is disabled. Accept this notice if the exclusion is intentional.`, "usecases-excluded");

    const reqCms = new Set(reqList.flatMap((r) => arr(r.satisfiedByCM)));
    for (const c of cmList) {
      if (!c.id) add("error", "A countermeasure is missing its ID.");
      if (!arr(c.addresses).length) add("warning", `${c.id || "countermeasure"}: addresses no threat (orphaned countermeasure).`);
      for (const a of arr(c.addresses)) if (!tIds.has(a.threat)) add("error", `${c.id}: addresses unknown threat '${a.threat}'.`);
      for (const comp of arr(c.components)) if (!compIds.has(comp)) add("error", `${c.id}: references unknown component '${comp}'.`);
      if (c.id && c.selected !== false && !reqCms.has(c.id)) add("warning", `${c.id}: no security requirement is associated with this countermeasure.`);
      const ticketCount = arr(c.ticketUrls).filter(Boolean).length || (c.ticketUrl ? 1 : 0);
      if ((c.status === "implemented" || c.status === "verified") && !ticketCount)
        add("warning", `${c.id}: status '${c.status}' requires a ticket link as proof of implementation.`);
      if (c.status === "verified" && !c.verificationUrl)
        add("warning", `${c.id}: status 'verified' requires a verification link as evidence the control was tested.`);
      for (const a of arr(c.addresses)) {
        const threat = threatById.get(a.threat);
        if (!threat) continue;
        if (typeof a.residualImpact === "number" && a.residualImpact > threat.impact)
          add("warning", `${c.id}: residual impact for ${a.threat} (${a.residualImpact}) exceeds the initial impact (${threat.impact}).`);
        if (typeof a.residualLikelihood === "number" && a.residualLikelihood > threat.likelihood)
          add("warning", `${c.id}: residual likelihood for ${a.threat} (${a.residualLikelihood}) exceeds the initial likelihood (${threat.likelihood}).`);
        if (c.type === "preventive" && typeof a.residualImpact === "number" && a.residualImpact < threat.impact)
          add("warning", `${c.id}: a preventive control should reduce likelihood, not impact — it lowers the impact of ${a.threat} (${threat.impact}→${a.residualImpact}).`);
      }
    }
    for (const r of reqList) {
      const hasCm = arr(r.satisfiedByCM).length > 0;
      const hasThreat = arr(r.derivedFromThreat).length > 0;
      if (!hasCm) {
        if (hasThreat) add("warning", `${r.id}: security requirement derived from a threat has no countermeasure satisfying it.`);
        else add("notice", `${r.id}: standalone security requirement — not derived from a threat and not backed by a countermeasure. Accept if this is intentional.`, `req-standalone:${r.id}`);
      }
      for (const th of arr(r.derivedFromThreat)) if (!tIds.has(th)) add("error", `${r.id}: derived from unknown threat '${th}'.`);
      for (const cm of arr(r.satisfiedByCM)) if (!cmIds.has(cm)) add("error", `${r.id}: satisfied by unknown countermeasure '${cm}'.`);
    }
    const reqThreats = new Set(reqList.flatMap((r) => arr(r.derivedFromThreat)));
    for (const t of threatList) {
      if ((t.likelihood || 0) * (t.impact || 0) >= 12 && !reqThreats.has(t.id) && t.status !== "accepted")
        add("warning", `${t.id}: high/critical threat has no security requirement derived from it.`);
      if (t.status === "transferred" && !reqThreats.has(t.id))
        add("warning", `${t.id}: transferred risk requires a linked requirement documenting the risk transfer in the user guide.`);
    }

    const parents = new Set(components.map((c) => c.parent).filter(Boolean));
    const threatComps = new Set(threatList.flatMap((t) => arr(t.components)));
    for (const c of components)
      if (c.kind !== "external-entity" && c.kind !== "device" && !parents.has(c.id) && !threatComps.has(c.id))
        add("warning", `Coverage: component '${c.id}' (${c.name}) has no threat — STRIDE-per-element coverage gap.`);
    const threatIfaces = new Set(threatList.flatMap((t) => [...arr(t.interfaceRefs), ...(t.interfaceRef ? [t.interfaceRef] : [])]).filter(Boolean));
    for (const i of interfaces)
      if (!threatIfaces.has(i.id))
        add("warning", `Coverage: interface '${i.id}' (${i.name}) has no threat — every external interface should have at least one.`);
    for (const n of arr(dfd.nodes))
      if (n.type === "trust-boundary" && !arr(n.members).length)
        add("warning", `Trust boundary '${n.id}' has no members (a trust boundary must contain at least one node).`);
    const boundaryIds = new Set([
      ...arr(system.trustBoundaries).map((b) => b.id),
      ...arr(dfd.nodes).filter((n) => n.type === "trust-boundary").map((n) => n.id),
    ]);
    for (const f of arr(dfd.flows)) {
      if (f.crossesBoundary && !boundaryIds.has(f.crossesBoundary))
        add("error", `Flow '${f.id}' references unknown trust boundary '${f.crossesBoundary}'.`);
      if (!f.label || !f.label.trim())
        add("warning", `Data flow '${f.id}' (${f.from}→${f.to}) has no label — every flow must state what data or command it carries.`);
    }
    for (const d of arr(defects.defects ?? defects)) {
      if (d.component && !compIds.has(d.component)) add("error", `${d.id || "defect"}: references unknown component '${d.component}'.`);
      if (d.threatRef && !tIds.has(d.threatRef)) add("error", `${d.id || "defect"}: references unknown threat '${d.threatRef}'.`);
      if ((d.status === "open" || d.status === "triaged") && (d.severity === "high" || d.severity === "critical") && d.threatRef)
        add("warning", `${d.id}: open ${d.severity} defect — re-assess the linked threat '${d.threatRef}'.`);
    }
    for (const tr of arr(attackTrees.trees)) {
      const refs = [...new Set([...arr(tr.threatRefs), ...(tr.threatRef ? [tr.threatRef] : [])])];
      for (const ref of refs)
        if (!tIds.has(ref)) add("error", `Attack tree '${tr.id}' references unknown threat '${ref}'.`);
    }
    const accepted = new Set(Array.isArray(project.acceptedNotices) ? project.acceptedNotices : []);
    return issues.filter((issue) => issue.severity !== "notice" || !accepted.has(issue.key));
  }

  const api = { validateCore, validate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.ValidationModel = api;
})(typeof window !== "undefined" ? window : globalThis);
