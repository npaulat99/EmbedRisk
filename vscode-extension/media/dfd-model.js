/* DFD model + DeMarco SVG renderer. Isomorphic: attaches to window (webview) and module.exports (Node tests).
   No DOM, no Node APIs. Single source of truth for the native DFD canvas and its unit tests. */
(function (g) {
  "use strict";
  var ROW = { "external-entity": 0, process: 1, multiprocess: 1, store: 2 };
  // Same node sizes as the webapp canvas (webapp/client/src/components/dfd/DfdView.tsx NODE_SIZE).
  var NODE_SIZE = {
    "external-entity": { w: 150, h: 60 },
    process: { w: 124, h: 84 },
    multiprocess: { w: 124, h: 84 },
    store: { w: 140, h: 60 }
  };
  function sizeOf(type) { return NODE_SIZE[type] || { w: 150, h: 90 }; }
  var Engine = g.DfdEngine || (typeof require === "function" ? require("./dfd-engine.js") : null);

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


  // ---- Flow geometry (ported from webapp/client/src/components/dfd/DfdView.tsx) ----------------
  var HANDLE_RING = ["t", "tr", "r", "br", "b", "bl", "l", "tl"];
  var CURVE = 28;       // base bend of a data flow, so even a lone flow is a gentle half-oval
  var LANE_STEP = 32;   // extra spacing per additional same-direction flow
  var LABEL_WRAP = 34;  // characters per flow-label line

  /** Anchor point on the outline of box (ellipse flag selects the 8 points of an oval). */
  function handlePoint(box, handle) {
    var key = String(handle || "r").replace(/^[st]-/, "");
    var c = box.ellipse ? 0.146 : 0;
    var p = { t: [0.5, 0], tr: [1 - c, c], r: [1, 0.5], br: [1 - c, 1 - c], b: [0.5, 1], bl: [c, 1 - c], l: [0, 0.5], tl: [c, c] }[key] || [1, 0.5];
    return { x: box.x + box.w * p[0], y: box.y + box.h * p[1] };
  }
  function sideToward(from, to) {
    var dx = to.x + to.w / 2 - (from.x + from.w / 2);
    var dy = to.y + to.h / 2 - (from.y + from.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "r" : "l";
    return dy >= 0 ? "b" : "t";
  }
  /** Point where a line from the box centre toward (tx,ty) leaves the box outline. */
  function borderPointOf(box, tx, ty) {
    var cx = box.x + box.w / 2, cy = box.y + box.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    var t;
    if (box.ellipse) t = 1 / Math.sqrt((dx / (box.w / 2)) * (dx / (box.w / 2)) + (dy / (box.h / 2)) * (dy / (box.h / 2)));
    else t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  /** Spread flows over the 8 outline anchors so they never all meet in one point. Honours the
   *  sourceHandle/targetHandle stored on a flow (written by the webapp). */
  function assignHandles(flows, boxes) {
    var use = {};
    function usedBy(id, role, key) { return use[id + ":" + role + ":" + key] || 0; }
    function bump(id, role, key) { use[id + ":" + role + ":" + key] = usedBy(id, role, key) + 1; }
    function reserve(id, role, handle) { var key = String(handle).replace(/^[st]-/, ""); bump(id, role, key); return key; }
    function allocate(id, role, from, toward) {
      var closest = sideToward(from, toward), i = HANDLE_RING.indexOf(closest);
      var cands = [closest, HANDLE_RING[(i + 7) % 8], HANDLE_RING[(i + 1) % 8]];
      var tx = toward.x + toward.w / 2, ty = toward.y + toward.h / 2;
      function score(k) { var p = handlePoint(from, k); return Math.hypot(p.x - tx, p.y - ty) - (k.length === 1 ? 18 : 0); }
      cands.sort(function (a, b) { return (usedBy(id, role, a) - usedBy(id, role, b)) || (score(a) - score(b)); });
      var pick = cands.find(function (k) { return usedBy(id, role, k) === 0; }) || cands[0];
      bump(id, role, pick);
      return pick;
    }
    function pairKey(a, b) { return a < b ? a + "\u0001" + b : b + "\u0001" + a; }
    var pairs = {};
    var ordered = flows.slice().sort(function (a, b) {
      var ka = pairKey(a.from, a.to), kb = pairKey(b.from, b.to);
      return ka < kb ? -1 : ka > kb ? 1 : String(a.id) < String(b.id) ? -1 : 1;
    });
    return ordered.map(function (f) {
      var sb = boxes[f.from], tb = boxes[f.to], key = pairKey(f.from, f.to), paired = pairs[key];
      var reverse = paired && paired.from === f.to && paired.to === f.from;
      var sk, tk;
      if (f.sourceHandle) sk = reserve(f.from, "s", f.sourceHandle);
      else if (reverse) { sk = paired.tk; bump(f.from, "s", sk); }
      else sk = allocate(f.from, "s", sb, tb);
      if (f.targetHandle) tk = reserve(f.to, "t", f.targetHandle);
      else if (reverse) { tk = paired.sk; bump(f.to, "t", tk); }
      else tk = allocate(f.to, "t", tb, sb);
      if (!paired) pairs[key] = { from: f.from, to: f.to, sk: sk, tk: tk };
      var bidirectional = flows.some(function (o) { return o.from === f.to && o.to === f.from; });
      return { flow: f, sk: sk, tk: tk, bidirectional: bidirectional };
    });
  }

  function pointOnPolyline(pts, fraction) {
    var lens = [], total = 0, i;
    for (i = 1; i < pts.length; i++) { var l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l; }
    var rem = total * fraction;
    for (i = 0; i < lens.length; i++) {
      if (rem <= lens[i] || i === lens.length - 1) {
        var r = lens[i] ? Math.min(1, rem / lens[i]) : 0, a = pts[i], b = pts[i + 1], len = lens[i] || 1;
        return { x: a[0] + (b[0] - a[0]) * r, y: a[1] + (b[1] - a[1]) * r, nx: -(b[1] - a[1]) / len, ny: (b[0] - a[0]) / len };
      }
      rem -= lens[i];
    }
    return { x: pts[0][0], y: pts[0][1], nx: 0, ny: 1 };
  }

  /** Curved (half-oval) path between two anchors; routes around obstacle boxes when needed. */
  function edgeGeometry(sx, sy, tx, ty, obstacles, offset) {
    var route = Engine ? Engine.routeAround(sx, sy, tx, ty, obstacles, 16) : [[sx, sy], [tx, ty]];
    var direct = Math.hypot(tx - sx, ty - sy) || 1, polyLen = 0, i;
    for (i = 1; i < route.length; i++) polyLen += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
    if (route.length > 2 && polyLen <= 2.4 * direct) {
      return { path: Engine.roundedPath(route, 14), pointAt: function (f) { return pointOnPolyline(route, f); } };
    }
    var dx = tx - sx, dy = ty - sy, len = Math.hypot(dx, dy) || 1;
    var cx = (sx + tx) / 2 + (-dy / len) * offset, cy = (sy + ty) / 2 + (dx / len) * offset;
    return {
      path: "M " + sx + "," + sy + " Q " + cx + "," + cy + " " + tx + "," + ty,
      pointAt: function (f) {
        var inv = 1 - f;
        var tanX = 2 * inv * (cx - sx) + 2 * f * (tx - cx), tanY = 2 * inv * (cy - sy) + 2 * f * (ty - cy);
        var tl = Math.hypot(tanX, tanY) || 1;
        return {
          x: inv * inv * sx + 2 * inv * f * cx + f * f * tx,
          y: inv * inv * sy + 2 * inv * f * cy + f * f * ty,
          nx: -tanY / tl, ny: tanX / tl
        };
      }
    };
  }

  function wrapText(text, max) {
    var lines = [""];
    String(text == null ? "" : text).trim().split(/\s+/).filter(Boolean).forEach(function (word) {
      var cur = lines[lines.length - 1];
      if (cur && (cur + " " + word).length <= max) lines[lines.length - 1] = cur + " " + word;
      else if (word.length <= max) lines.push(word);
      else for (var i = 0; i < word.length; i += max) lines.push(word.slice(i, i + max));
    });
    return lines.filter(Boolean);
  }
  function labelSize(lines) {
    var maxLen = Math.max.apply(null, [1].concat(lines.map(function (l) { return l.length; })));
    return { w: Math.min(220, Math.max(54, maxLen * 6.1 + 16)), h: Math.max(1, lines.length) * 14 + 4 };
  }
  function overlapArea(a, b) {
    return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  }

  /** Geometry for every flow whose two endpoints have a box: {flow, path, label?:{lines,x,y,anchor}}. */
  function routeFlows(flows, boxes) {
    var usable = flows.filter(function (f) { return boxes[f.from] && boxes[f.to]; });
    var boxList = Object.keys(boxes).map(function (id) { var b = boxes[id]; return { id: id, x: b.x, y: b.y, w: b.w, h: b.h }; });
    var placed = [];
    var byId = {};
    assignHandles(usable, boxes).forEach(function (entry) {
      var f = entry.flow, group = usable.filter(function (o) { return o.from === f.from && o.to === f.to; })
        .sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
      var offset = CURVE + (group.findIndex(function (o) { return o.id === f.id; }) - (group.length - 1) / 2) * LANE_STEP;
      var p1 = handlePoint(boxes[f.from], entry.sk), p2 = handlePoint(boxes[f.to], entry.tk);
      var obstacles = boxList.filter(function (o) { return o.id !== f.from && o.id !== f.to; }).map(function (o) { return { x: o.x, y: o.y, w: o.w, h: o.h }; });
      var geo = edgeGeometry(p1.x, p1.y, p2.x, p2.y, obstacles, offset);
      var result = { flow: f, path: geo.path };
      if (f.label) {
        var lines = wrapText(f.label, LABEL_WRAP), size = labelSize(lines), best = null;
        var preferred = entry.bidirectional ? 0.36 : 0.5;
        (entry.bidirectional ? [0.36, 0.28, 0.44, 0.55, 0.2] : [0.5, 0.35, 0.65, 0.2, 0.8]).forEach(function (fraction) {
          var pt = geo.pointAt(fraction);
          [0, 16, -16, 32, -32, 48, -48].forEach(function (n) {
            var x = pt.x + pt.nx * n, y = pt.y + pt.ny * n;
            var box = { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h };
            var overlap = 0;
            boxList.concat(placed).forEach(function (o) { overlap += overlapArea(box, o); });
            var score = overlap * 1000 + Math.abs(fraction - preferred) * 140 + Math.abs(n);
            if (!best || score < best.score) best = { x: x, y: y, score: score, box: box, anchor: { x: pt.x, y: pt.y } };
          });
        });
        placed.push(best.box);
        result.label = { lines: lines, x: best.x, y: best.y, anchor: best.anchor };
      }
      byId[f.id] = result;
    });
    return usable.map(function (f) { return byId[f.id]; });
  }

  // ---- SVG rendering ---------------------------------------------------------------------------
  function shapeSvg(n, focus, riskColor) {
    var focusStroke = n.id === focus ? "stroke='#1565c0' stroke-width='3'" : "";
    var borderStroke = riskColor ? "stroke='" + riskColor + "' stroke-width='2.5'" : "stroke='currentColor' stroke-width='1.5'";
    var hl = n.id === focus ? focusStroke : borderStroke;
    var fill = riskColor ? "fill='" + riskColor + "' fill-opacity='0.18'" : "fill='#fff' fill-opacity='0.06'";
    var sz = sizeOf(n.type), x = n.x, y = n.y, w = sz.w, h = sz.h, cx = x + w / 2, cy = y + h / 2;
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
    // Wrap the full label over up to three lines (ellipsis only beyond that) instead of cutting it.
    var maxChars = n.type === "process" || n.type === "multiprocess" ? 16 : 22;
    var lines = wrapText(n.label, maxChars);
    if (lines.length > 3) { lines = lines.slice(0, 3); lines[2] = lines[2].slice(0, maxChars - 1) + "\u2026"; }
    var text = lines.map(function (line, i) {
      return "<tspan x='" + cx + "' y='" + (cy + 4 + (i - (lines.length - 1) / 2) * 14) + "'>" + esc(line) + "</tspan>";
    }).join("");
    return "<g data-id='" + esc(n.id) + "' class='node' style='cursor:move'>" + inner + badge +
      "<title>" + esc(n.label) + "</title>" +
      "<text text-anchor='middle' font-size='12' fill='currentColor' style='pointer-events:none'>" + text + "</text></g>";
  }

  function flowSvg(r, focus) {
    var f = r.flow, sel = focus === "flow:" + f.id, label = "";
    if (r.label) {
      var l = r.label;
      if (Math.hypot(l.x - l.anchor.x, l.y - l.anchor.y) > 4) {
        label += "<line x1='" + l.anchor.x + "' y1='" + l.anchor.y + "' x2='" + l.x + "' y2='" + l.y + "' stroke='#999' stroke-width='0.8' stroke-dasharray='2 2' style='pointer-events:none'/>";
      }
      label += "<text font-size='10' fill='#555' text-anchor='middle' dominant-baseline='middle' " +
        "style='paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round'>" +
        l.lines.map(function (line, i) {
          return "<tspan x='" + l.x + "' y='" + (l.y + (i - (l.lines.length - 1) / 2) * 12) + "'>" + esc(line) + "</tspan>";
        }).join("") + "</text>";
    }
    // A wide transparent path makes the thin curve easy to click.
    return "<g data-flow='" + esc(f.id) + "' class='flow' style='cursor:pointer'>" +
      "<path d='" + r.path + "' fill='none' stroke='transparent' stroke-width='14' pointer-events='stroke'/>" +
      "<path d='" + r.path + "' fill='none' stroke='" + (sel ? "#1565c0" : "#666") + "' stroke-width='" + (sel ? 2.5 : 1.5) +
      "' marker-end='url(#" + (sel ? "arrow-sel" : "arrow") + ")' pointer-events='none'/>" + label + "</g>";
  }

  /** opts.flows: flows to draw (default dfd.flows). opts.extraBoxes: id -> {x,y,w,h} for interface
   *  chips / context ports that flows may attach to and route around. */
  function render(dfd, parentId, focus, riskColors, opts) {
    opts = opts || {};
    var view = layout(dfd, parentId);
    var nodes = view.filter(function (n) { return n.type !== "trust-boundary"; });
    var tbs = view.filter(function (n) { return n.type === "trust-boundary"; });
    var pos = {};
    nodes.forEach(function (n) {
      var sz = sizeOf(n.type);
      pos[n.id] = { x: n.x, y: n.y, w: sz.w, h: sz.h, ellipse: n.type === "process" || n.type === "multiprocess" };
    });
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
      // (but not on a member node, which is painted on top) reselects it for editing.
      parts.push("<g data-id='" + esc(n.id) + "' class='node tb' style='cursor:pointer'><rect x='" + x + "' y='" + y + "' width='" + w + "' height='" + h +
        "' rx='10' fill='none' pointer-events='all' stroke='" + c + "' stroke-width='1.5' stroke-dasharray='6 4'/><text x='" + (x + 8) + "' y='" + (y + 16) +
        "' font-size='11' fill='" + c + "'>" + esc(n.label) + "</text></g>");
    });
    var boxes = {};
    Object.keys(opts.extraBoxes || {}).forEach(function (id) { boxes[id] = opts.extraBoxes[id]; });
    Object.keys(pos).forEach(function (id) { boxes[id] = pos[id]; });
    // Flows sit under the nodes: they end on the outline and can never cover a node's clickable area.
    routeFlows(opts.flows || dfd.flows, boxes).forEach(function (r) { parts.push(flowSvg(r, focus)); });
    nodes.forEach(function (n) { parts.push(shapeSvg(n, focus, riskColors && riskColors[n.id])); });
    return parts.join("");
  }

  var api = { ROW: ROW, esc: esc, siblings: siblings, children: children, viewNodes: viewNodes, layerOf: layerOf, nextId: nextId, uid: uid, layout: layout, addNode: addNode, addFlow: addFlow, deleteNode: deleteNode, render: render,
    sizeOf: sizeOf, handlePoint: handlePoint, borderPointOf: borderPointOf, routeFlows: routeFlows, wrapText: wrapText };
  g.DfdModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
