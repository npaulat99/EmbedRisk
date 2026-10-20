/* Attack-defense tree model + renderer — schema-identical to tra-webapp (types.ts AdNode / AttackTree
   and lib/attackTree.ts). Isomorphic: window (webview) + module.exports (Node tests).
   Tree: { id, title, threatRefs?: string[], threatRef?, description?, root: AdNode }.
   threatRefs is the preferred 0..n threat link list; threatRef is the legacy single link, kept equal to
   threatRefs[0] on write (removed when there are no links) exactly like the webapp. Read via threatRefsOf(),
   which returns the de-duplicated union of threatRefs and threatRef (webapp read rule).
  AdNode: { id, kind, label, gate?, access?, skill?, cost?, residualCost?, impactDimensions?, countermeasureRef?, note?, children? }.
   kind ∈ goal|step|substep|category|countermeasure|vulnerability ; gate ∈ AND|OR|SAND. */
(function (g) {
  "use strict";
  var KIND_LABEL = { goal: "Goal", step: "Step", substep: "Sub-step", category: "Category", countermeasure: "Defence", vulnerability: "Vulnerability" };
  var GATES = ["AND", "OR", "SAND"];
  var STRUCTURAL = ["goal", "step", "substep", "category"];
  var COST_FACTORS = [
    { k: "time", label: "Time effort", weight: 0.25 },
    { k: "exploitability", label: "Exploitability", weight: 0.2 },
    { k: "window", label: "Window of opportunity", weight: 0.15 },
    { k: "detection", label: "Detection probability", weight: 0.15 },
    { k: "notoriety", label: "Prior knowledge", weight: 0.1 },
    { k: "prep", label: "Preparation effort", weight: 0.1 },
    { k: "abort", label: "Abort risk", weight: 0.05 },
  ];
  var DEF_FACTOR = { proposed: 0.85, planned: 0.7, implemented: 0.5, verified: 0.35 };

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function isStructural(n) { return STRUCTURAL.indexOf(n.kind) >= 0; }
  function walk(node, fn, parent, depth) {
    fn(node, parent === undefined ? null : parent, depth || 0);
    (node.children || []).forEach(function (c) { walk(c, fn, node, (depth || 0) + 1); });
  }
  function find(root, id) { var hit = null; walk(root, function (n) { if (n.id === id) hit = n; }); return hit; }
  function parentOf(root, id) { var hit = null; walk(root, function (n, p) { if (n.id === id) hit = p; }); return hit; }
  function uid(root) { var used = {}; walk(root, function (n) { used[n.id] = true; }); var i = 1, id; do { id = "n" + i++; } while (used[id]); return id; }

  function newNode(kind, root) {
    var n = { id: uid(root), kind: kind, label: KIND_LABEL[kind] || "Node", children: [] };
    if (kind === "step" || kind === "substep") { n.access = 3; n.skill = 2; n.cost = {}; }
    if (kind === "countermeasure" || kind === "vulnerability") { n.access = 3; n.skill = 2; n.residualCost = {}; }
    if (isStructural(n)) n.gate = kind === "category" ? "OR" : "AND";
    return n;
  }
  function addChild(root, parentId, kind) {
    var p = find(root, parentId); if (!p) return null;
    if (p.kind === "substep" && ["step", "substep", "category"].indexOf(kind) >= 0) return null;
    if (!p.children) p.children = [];
    var n = newNode(kind || "step", root); p.children.push(n); return n;
  }
  function addSibling(root, id, kind) {
    var p = parentOf(root, id); if (!p) return null;
    var n = newNode(kind || "step", root); p.children.push(n); return n;
  }
  function remove(root, id) {
    var p = parentOf(root, id); if (!p) return false;
    p.children = (p.children || []).filter(function (c) { return c.id !== id; });
    return true;
  }
  function cycleGate(root, id) {
    var n = find(root, id); if (!n || !isStructural(n)) return null;
    n.gate = GATES[(GATES.indexOf(n.gate || "AND") + 1) % GATES.length];
    return n.gate;
  }
  function setKind(root, id, kind) {
    var n = find(root, id); if (!n) return;
    n.kind = kind;
    if (kind === "step" || kind === "substep") { if (n.access == null) n.access = 3; if (n.skill == null) n.skill = 2; if (!n.cost) n.cost = {}; }
    if (!isStructural(n)) delete n.gate; else if (!n.gate) n.gate = "AND";
  }

  // ---- deterministic bottom-up metrics (mirrors lib/attackTree.ts) ----
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function hasCost(cost) { return COST_FACTORS.some(function (f) { return typeof (cost || {})[f.k] === "number"; }); }
  function level(value) { return typeof value === "number" && value >= 1 && value <= 5 ? value : 0; }
  function stepProb(cost) {
    if (!hasCost(cost)) return 1;
    var weightedCost = COST_FACTORS.reduce(function (sum, f) {
      var value = typeof cost[f.k] === "number" ? cost[f.k] : 3;
      return sum + f.weight * Math.max(1, Math.min(5, value));
    }, 0);
    return clamp01((6 - weightedCost) / 5);
  }
  function evaluate(node, cmById) {
    var kids = (node.children || []).filter(function (c) { return c.kind !== "countermeasure" && c.kind !== "vulnerability"; });
    var defChildren = (node.children || []).filter(function (c) { return c.kind === "countermeasure"; });
    var vulnChildren = (node.children || []).filter(function (c) { return c.kind === "vulnerability"; });
    var ownVuln = vulnChildren.length;
    var leafAttackStep = (node.kind === "step" || node.kind === "substep") && !kids.length;
    var residualEntity = node.kind === "countermeasure" || node.kind === "vulnerability";
    var assessed = leafAttackStep || residualEntity;
    var assessmentCost = residualEntity ? node.residualCost : node.cost;
    var selfProb = assessed ? stepProb(assessmentCost) : 1, selfSkill = assessed ? level(node.skill) : 0, selfAccess = assessed ? level(node.access) : 0;
    var defenceResiduals = leafAttackStep ? defChildren.filter(function (c) { return hasCost(c.residualCost); }) : [];
    if (defenceResiduals.length) selfProb = Math.min.apply(null, defenceResiduals.map(function (c) { return stepProb(c.residualCost); }));
    var vulnerabilityResiduals = leafAttackStep ? vulnChildren.filter(function (c) { return hasCost(c.residualCost); }) : [];
    if (vulnerabilityResiduals.length) {
      var selected = vulnerabilityResiduals.reduce(function (best, c) { return stepProb(c.residualCost) > stepProb(best.residualCost) ? c : best; });
      selfProb = stepProb(selected.residualCost); selfSkill = level(selected.skill); selfAccess = level(selected.access);
    }
    var skillReq, accessReq, prob, defenses = defChildren.length, vulns = ownVuln;
    if (!kids.length) { skillReq = selfSkill; accessReq = selfAccess; prob = selfProb; }
    else {
      var cm = kids.map(function (k) { return evaluate(k, cmById); });
      defenses += cm.reduce(function (s, c) { return s + c.defenses; }, 0);
      vulns += cm.reduce(function (s, c) { return s + c.vulns; }, 0);
      if (node.kind === "category" || node.gate === "OR") {
        var alternatives = cm.concat(vulnChildren.map(function (c) { return evaluate(c, cmById); }));
        var best = alternatives.reduce(function (a, b) { return b.prob > a.prob ? b : a; });
        skillReq = Math.max(best.skillReq, selfSkill); accessReq = Math.max(best.accessReq, selfAccess); prob = best.prob * selfProb;
      } else {
        skillReq = Math.max.apply(null, [selfSkill].concat(cm.map(function (c) { return c.skillReq; })));
        accessReq = Math.max.apply(null, [selfAccess].concat(cm.map(function (c) { return c.accessReq; })));
        prob = cm.reduce(function (p, c) { return p * c.prob; }, 1) * selfProb;
      }
    }
    var legacyDefChildren = leafAttackStep ? defChildren.filter(function (c) { return !hasCost(c.residualCost); }) : [];
    var legacyVulns = leafAttackStep ? vulnChildren.filter(function (c) { return !hasCost(c.residualCost); }).length : 0;
    var defMult = legacyDefChildren.reduce(function (m, c) { var st = c.countermeasureRef && cmById ? (cmById[c.countermeasureRef] || {}).status : ""; return m * (DEF_FACTOR[st] || 0.6); }, 1);
    prob = clamp01(prob * defMult * Math.pow(1.6, legacyVulns));
    return { skillReq: skillReq, accessReq: accessReq, prob: prob, defenses: defenses, vulns: vulns };
  }
  var DEFAULT_LIKELIHOOD_THRESHOLDS = { 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };
  function likelihoodFromProb(p, thresholds) {
    if (p <= 0) return 0;
    for (var level = 5; level >= 2; level--) if (p >= (thresholds && thresholds[level] != null ? thresholds[level] : DEFAULT_LIKELIHOOD_THRESHOLDS[level])) return level;
    return 1;
  }

  var FILL = { goal: "#eef4ff", step: "#eef4ff", substep: "#f3f6fb", category: "#f0f0f5", countermeasure: "#e7f6ec", vulnerability: "#fdeaea" };
  // Graphical attack-defence tree — mirrors the tra-webapp AttackTreeDiagram notation:
  // root on top, children branch downward; a gate badge is drawn below a parent with >1 child
  // (OR = plain fan-out, AND = connecting arc, SAND = arc + left→right sequence arrow). The gate
  // badge carries data-gate so the editor can cycle AND/OR/SAND on click.
  function render(tree, focus) {
    var root = tree.root;
    var NW = 168, NH = 54, HGAP = 26, VGAP = 82, PAD = 16, GATE_DY = 26;
    function measure(n) { var k = n.children || []; if (!k.length) return NW; var w = k.map(measure).reduce(function (a, b) { return a + b; }, 0) + HGAP * (k.length - 1); return Math.max(NW, w); }
    var pos = {};
    function place(n, cx, top) {
      pos[n.id] = { cx: cx, x: cx - NW / 2, y: top };
      var k = n.children || []; if (!k.length) return;
      var ws = k.map(measure);
      var total = ws.reduce(function (a, b) { return a + b; }, 0) + HGAP * (k.length - 1);
      var x = cx - total / 2, ct = top + NH + VGAP;
      for (var i = 0; i < k.length; i++) { place(k[i], x + ws[i] / 2, ct); x += ws[i] + HGAP; }
    }
    place(root, PAD + measure(root) / 2, PAD);
    var maxX = 0, maxY = 0; walk(root, function (n) { var p = pos[n.id]; if (p.x + NW > maxX) maxX = p.x + NW; if (p.y + NH > maxY) maxY = p.y + NH; });
    var edges = [], gates = [], boxes = [];
    walk(root, function (n) {
      var p = pos[n.id], kids = n.children || []; if (!kids.length) return;
      var pb = p.y + NH;
      if (kids.length === 1) { var k = pos[kids[0].id]; edges.push("<path d='M " + p.cx + "," + pb + " L " + k.cx + "," + k.y + "' stroke='#8892a0' stroke-width='1.5' fill='none'/>"); return; }
      var gateY = pb + GATE_DY;
      edges.push("<path d='M " + p.cx + "," + pb + " L " + p.cx + "," + gateY + "' stroke='#8892a0' stroke-width='1.5' fill='none'/>");
      kids.forEach(function (c) { var k = pos[c.id]; edges.push("<path d='M " + p.cx + "," + gateY + " L " + k.cx + "," + k.y + "' stroke='#8892a0' stroke-width='1.5' fill='none'/>"); });
      var g = n.gate || "AND";
      if (g !== "OR") {
        var arcY = gateY + 18, first = pos[kids[0].id], last = pos[kids[kids.length - 1].id];
        var t = (arcY - gateY) / ((first.y - gateY) || 1);
        var lx = p.cx + (first.cx - p.cx) * t, rx = p.cx + (last.cx - p.cx) * t;
        gates.push("<path d='M " + lx + "," + arcY + " Q " + p.cx + "," + (arcY + 13) + " " + rx + "," + arcY + "' stroke='#1565c0' stroke-width='1.5' fill='none'/>");
        if (g === "SAND") gates.push("<path d='M " + (rx - 2) + "," + (arcY - 4.5) + " L " + (rx + 6) + "," + arcY + " L " + (rx - 2) + "," + (arcY + 4.5) + " Z' fill='#1565c0'/>");
      }
      gates.push("<g data-gate='" + esc(n.id) + "' style='cursor:pointer'><rect x='" + (p.cx - 20) + "' y='" + (gateY - 11) + "' width='40' height='22' rx='11' fill='#eaf1ff' stroke='#1565c0' stroke-width='1'/><text x='" + p.cx + "' y='" + (gateY + 4) + "' text-anchor='middle' font-size='10' fill='#1565c0' style='pointer-events:none'>" + g + "</text></g>");
    });
    walk(root, function (n) {
      var p = pos[n.id];
      var hl = n.id === focus ? "#1565c0" : "#555", sw = n.id === focus ? "2.5" : "1.2", fill = FILL[n.kind] || "#fff";
      var kind = "<text x='" + (p.x + 7) + "' y='" + (p.y + 14) + "' font-size='9' fill='#1565c0'>" + esc(KIND_LABEL[n.kind] || n.kind) + "</text>";
      var as = (n.kind === "step" || n.kind === "substep") ? "<text x='" + (p.x + NW / 2) + "' y='" + (p.y + NH - 7) + "' text-anchor='middle' font-size='8.5' fill='#777'>acc " + (n.access || "-") + " · skill " + (n.skill || "-") + "</text>" : "";
      boxes.push("<g data-id='" + esc(n.id) + "' class='atn' style='cursor:pointer'><rect x='" + p.x + "' y='" + p.y + "' width='" + NW + "' height='" + NH + "' rx='7' fill='" + fill + "' stroke='" + hl + "' stroke-width='" + sw + "'/>" + kind + as +
        "<text x='" + (p.x + NW / 2) + "' y='" + (p.y + 28) + "' text-anchor='middle' font-size='11' style='pointer-events:none'>" + esc(String(n.label).slice(0, 24)) + "</text></g>");
    });
    return { svg: edges.join("") + gates.join("") + boxes.join(""), width: Math.max(maxX + PAD, 240), height: Math.max(maxY + PAD, 180) };
  }

  function threatRefsOf(tree) {
    if (!tree) return [];
    var refs = (Array.isArray(tree.threatRefs) ? tree.threatRefs : []).concat(tree.threatRef ? [tree.threatRef] : []);
    var out = [];
    refs.forEach(function (r) { if (typeof r === "string" && r && out.indexOf(r) < 0) out.push(r); });
    return out;
  }
  function setThreatRefs(tree, refs) {
    var next = [];
    (refs || []).forEach(function (r) { if (typeof r === "string" && r && next.indexOf(r) < 0) next.push(r); });
    tree.threatRefs = next;
    if (next.length) tree.threatRef = next[0]; else delete tree.threatRef;
    return next;
  }

  function toHtml(root) {
    function ul(node) {
      var kids = node.children || [];
      var meta = (isStructural(node) && kids.length) ? " <em>[" + (node.gate || "AND") + "]</em>" : "";
      if (node.kind === "countermeasure") meta += ' <span class="cm">(defence' + (node.countermeasureRef ? " " + node.countermeasureRef : "") + ")</span>";
      if (node.kind === "vulnerability") meta += ' <span class="vuln">(vulnerability)</span>';
      var inner = kids.length ? "<ul>" + kids.map(function (c) { return "<li>" + ul(c) + "</li>"; }).join("") + "</ul>" : "";
      return esc(node.label) + meta + inner;
    }
    return "<ul><li>" + ul(root) + "</li></ul>";
  }

  var api = { KIND_LABEL: KIND_LABEL, GATES: GATES, COST_FACTORS: COST_FACTORS, DEFAULT_LIKELIHOOD_THRESHOLDS: DEFAULT_LIKELIHOOD_THRESHOLDS, esc: esc, isStructural: isStructural, walk: walk, find: find, parentOf: parentOf, uid: uid, newNode: newNode, addChild: addChild, addSibling: addSibling, remove: remove, cycleGate: cycleGate, setKind: setKind, stepProb: stepProb, evaluate: evaluate, likelihoodFromProb: likelihoodFromProb, render: render, toHtml: toHtml, threatRefsOf: threatRefsOf, setThreatRefs: setThreatRefs };
  g.AtModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
