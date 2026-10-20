/* DFD model + DeMarco SVG renderer. Isomorphic: attaches to window (webview) and module.exports (Node tests).
   No DOM, no Node APIs. Single source of truth for the native DFD canvas and its unit tests. */
(function (g) {
  "use strict";
  var ROW = { "external-entity": 0, process: 1, multiprocess: 1, store: 2 };
  var NW = 130, NH = 56;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function par(n) { return n.parent == null ? null : n.parent; }

  function siblings(dfd, parentId) {
    return dfd.nodes.filter(function (n) { return par(n) === parentId && n.type !== "trust-boundary"; });
  }
  function children(dfd, id) {
    return dfd.nodes.filter(function (n) { return par(n) === id; });
  }
  function viewNodes(dfd, parentId) {
    return dfd.nodes.filter(function (n) { return par(n) === parentId; });
  }
  function layerOf(dfd, parentId) {
    if (parentId == null) return 1;
    var p = dfd.nodes.find(function (n) { return n.id === parentId; });
    return (p && p.layer ? p.layer : 1) + 1;
  }
  // Same scheme as the webapp's uid() (webapp/client/src/state/store.ts): prefix + the lowest
  // positive integer not already taken by an existing id of the exact form <prefix><digits>.
  function nextId(prefix, existingIds) {
    var used = {};
    (existingIds || []).forEach(function (id) {
      if (typeof id !== "string" || id.indexOf(prefix) !== 0) return;
      var rest = id.slice(prefix.length);
      if (/^[0-9]+$/.test(rest)) used[Number(rest)] = true;
    });
    var n = 1;
    while (used[n]) n++;
    return prefix + n;
  }
  function uid(dfd, prefix, reservedIds) {
    return nextId(prefix, dfd.nodes.map(function (n) { return n.id; }).concat(reservedIds || []));
  }
  function layout(dfd, parentId) {
    var view = viewNodes(dfd, parentId);
    var col = { 0: 0, 1: 0, 2: 0 };
    view.filter(function (n) { return n.type !== "trust-boundary"; }).forEach(function (n) {
      var r = ROW[n.type]; if (r == null) r = 1;
      if (typeof n.x !== "number") n.x = 40 + col[r] * 210;
      if (typeof n.y !== "number") n.y = 70 + r * 150;
      col[r]++;
    });
    return view;
  }
  // Webapp prefixes: trust-boundary nodes "TB-<n>" (also avoiding system trust-boundary ids passed
  // in reservedIds, since a DFD boundary node shares its id with its system trust boundary), all
  // other nodes "N-<n>".
  function addNode(dfd, parentId, type, label, reservedIds) {
    var prefix = type === "trust-boundary" ? "TB-" : "N-";
    var node = { id: uid(dfd, prefix, reservedIds), label: label || ("New " + type), type: type, layer: layerOf(dfd, parentId), parent: parentId };
    dfd.nodes.push(node);
    return node;
  }
  function addFlow(dfd, from, to, label) {
    var id = nextId("F", dfd.flows.map(function (f) { return f.id; }));
    var flow = { id: id, label: label || "", from: from, to: to, crossesBoundary: null };
    dfd.flows.push(flow);
    return flow;
  }
  function deleteNode(dfd, id) {
    var doomed = Object.create(null); doomed[id] = true;
    var changed = true;
    while (changed) {
      changed = false;
      dfd.nodes.forEach(function (n) {
        if (!doomed[n.id] && par(n) != null && doomed[par(n)]) { doomed[n.id] = true; changed = true; }
      });
    }
    dfd.nodes = dfd.nodes.filter(function (n) { return !doomed[n.id]; });
    dfd.flows = dfd.flows.filter(function (f) { return !doomed[f.from] && !doomed[f.to]; });
    dfd.nodes.forEach(function (n) { if (n.members) n.members = n.members.filter(function (m) { return !doomed[m]; }); });
    ["ifacePos", "ifaceRot", "ifaceLink", "portPos"].forEach(function (field) {
      var entries = dfd[field];
      if (!entries) return;
      Object.keys(entries).forEach(function (key) {
        // Webapp layout keys are "<parent node or root>:<interface or endpoint>".
        var separator = key.indexOf(":");
        if (separator !== -1 && (doomed[key.slice(0, separator)] || doomed[key.slice(separator + 1)])) delete entries[key];
      });
    });
  }

  function shapeSvg(n, focus, riskColor) {
    var focusStroke = n.id === focus ? "stroke='#1565c0' stroke-width='3'" : "";
    var borderStroke = riskColor ? "stroke='" + riskColor + "' stroke-width='2.5'" : "stroke='currentColor' stroke-width='1.5'";
    var hl = n.id === focus ? focusStroke : borderStroke;
    var fill = riskColor ? "fill='" + riskColor + "' fill-opacity='0.18'" : "fill='#fff' fill-opacity='0.06'";
    var x = n.x, y = n.y, w = NW, h = NH, cx = x + w / 2, cy = y + h / 2, label = esc(String(n.label).slice(0, 22));
    var inner;
    if (n.type === "process" || n.type === "multiprocess") {
      inner = "<ellipse cx='" + cx + "' cy='" + cy + "' rx='" + (w / 2) + "' ry='" + (h / 2) + "' " + fill + " " + hl + "/>";
      if (n.type === "multiprocess") inner += "<ellipse cx='" + cx + "' cy='" + cy + "' rx='" + (w / 2 - 6) + "' ry='" + (h / 2 - 6) + "' fill='none' " + hl + "/>";
    } else if (n.type === "store") {
      inner = "<rect x='" + x + "' y='" + y + "' width='" + w + "' height='" + h + "' " + fill + " stroke='none'/>" +
        "<line x1='" + x + "' y1='" + y + "' x2='" + (x + w) + "' y2='" + y + "' " + hl + "/>" +
        "<line x1='" + x + "' y1='" + (y + h) + "' x2='" + (x + w) + "' y2='" + (y + h) + "' " + hl + "/>";
    } else {
      inner = "<rect x='" + x + "' y='" + y + "' width='" + w + "' height='" + h + "' " + fill + " " + hl + "/>";
    }
    var badge = riskColor ? "<circle cx='" + (x + w - 7) + "' cy='" + (y + 7) + "' r='5' fill='" + riskColor + "' opacity='0.95' style='pointer-events:none'/>" : "";
    return "<g data-id='" + esc(n.id) + "' class='node' style='cursor:move'>" + inner + badge +
      "<text x='" + cx + "' y='" + (cy + 4) + "' text-anchor='middle' font-size='12' fill='currentColor' style='pointer-events:none'>" + label + "</text></g>";
  }

  function render(dfd, parentId, focus, riskColors) {
    var view = layout(dfd, parentId);
    var nodes = view.filter(function (n) { return n.type !== "trust-boundary"; });
    var tbs = view.filter(function (n) { return n.type === "trust-boundary"; });
    var pos = {}; nodes.forEach(function (n) { pos[n.id] = { x: n.x, y: n.y, w: NW, h: NH }; });
    var parts = [];
    tbs.forEach(function (n) {
      var x = n.x, y = n.y, w = n.width, h = n.height;
      var mem = (n.members || []).map(function (id) { return pos[id]; }).filter(Boolean);
      if (mem.length) {
        var pad = 22;
        x = Math.min.apply(null, mem.map(function (b) { return b.x; })) - pad;
        y = Math.min.apply(null, mem.map(function (b) { return b.y; })) - pad;
        w = Math.max.apply(null, mem.map(function (b) { return b.x + b.w; })) - x + pad;
        h = Math.max.apply(null, mem.map(function (b) { return b.y + b.h; })) - y + pad;
      }
      if (typeof x !== "number") { x = 20; y = 20; w = 320; h = 170; }
      var c = n.id === focus ? "#1565c0" : "#999";
      // The dashed rectangle is given pointer-events:all so a click anywhere inside the boundary
      // (but not on a member node, which is painted on top) reselects it for editing — otherwise
      // only the thin border/label was clickable and a boundary became effectively uneditable.
      parts.push("<g data-id='" + esc(n.id) + "' class='node tb' style='cursor:pointer'><rect x='" + x + "' y='" + y + "' width='" + w + "' height='" + h +
        "' rx='10' fill='none' pointer-events='all' stroke='" + c + "' stroke-width='1.5' stroke-dasharray='6 4'/><text x='" + (x + 8) + "' y='" + (y + 16) +
        "' font-size='11' fill='" + c + "'>" + esc(n.label) + "</text></g>");
    });
    var ids = {}; nodes.forEach(function (n) { ids[n.id] = true; });
    // Group flows by direction so every arrow can bend to the RIGHT of its own
    // direction vector. Bidirectional pairs then naturally form an "eye" shape.
    var BASE_CURVE = 24; // minimum right-side bend so even a single flow is curved
    var LANE = 18;       // additional spacing for parallel same-direction flows
    var dirFlows = {};   // dirKey -> [flowId, ...]
    dfd.flows.forEach(function (f) {
      if (!ids[f.from] || !ids[f.to]) return;
      var key = f.from + "\u0001" + f.to;
      if (!dirFlows[key]) dirFlows[key] = [];
      dirFlows[key].push(f.id);
    });
    var flowOffset = {}; // flowId -> perpendicular offset
    Object.keys(dirFlows).forEach(function (key) {
      var group = dirFlows[key] || [];
      group.forEach(function (id, idx) {
        flowOffset[id] = BASE_CURVE + idx * LANE;
      });
    });
    dfd.flows.forEach(function (f) {
      if (!ids[f.from] || !ids[f.to]) return;
      var a = pos[f.from], b = pos[f.to];
      var x1 = a.x + a.w / 2, y1 = a.y + a.h / 2;
      var x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
      // Precomputed right-side lane offset for this flow.
      var off = typeof flowOffset[f.id] === "number" ? flowOffset[f.id] : BASE_CURVE;
      // RIGHT-hand normal to the segment.
      var dx = x2 - x1, dy = y2 - y1;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / len, ny = -dx / len;
      // Mid-point displaced by offset → quadratic Bezier control point.
      var mx = (x1 + x2) / 2 + nx * off;
      var my = (y1 + y2) / 2 + ny * off;
      var path = "M " + x1 + " " + y1 + " Q " + mx + " " + my + " " + x2 + " " + y2;
      // Label sits closer to the target along the curve (t=2/3) to reduce overlap
      // around the center where opposite-direction arcs pass near each other.
      var t = 2 / 3;
      var omt = 1 - t;
      var lx = omt * omt * x1 + 2 * omt * t * mx + t * t * x2;
      var ly = omt * omt * y1 + 2 * omt * t * my + t * t * y2;
      // Extra nudge so the label doesn't sit exactly on the arrow arc itself.
      var nudge = 7;
      lx += nx * nudge; ly += ny * nudge;
      parts.push("<path d='" + path + "' stroke='#666' stroke-width='1.5' fill='none' marker-end='url(#arrow)'/>" +
        (f.label ? "<text x='" + lx + "' y='" + ly + "' font-size='10' fill='#555' text-anchor='middle' dominant-baseline='middle' style='paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round'>" + esc(f.label) + "</text>" : ""));
    });
    nodes.forEach(function (n) { parts.push(shapeSvg(n, focus, riskColors && riskColors[n.id])); });
    return parts.join("");
  }

  var api = { ROW: ROW, esc: esc, siblings: siblings, children: children, viewNodes: viewNodes, layerOf: layerOf, nextId: nextId, uid: uid, layout: layout, addNode: addNode, addFlow: addFlow, deleteNode: deleteNode, render: render };
  g.DfdModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
