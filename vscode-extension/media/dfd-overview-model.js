/* Isomorphic read-only DFD overview tree model. */
(function (g) {
  "use strict";

  var TYPE_LABEL = {
    "external-entity": "External entity",
    process: "Process",
    multiprocess: "Multi-process",
    store: "Data store",
    "trust-boundary": "Trust boundary",
  };
  var TYPE_ICON = {
    "external-entity": "symbol-interface",
    process: "circle-outline",
    multiprocess: "layers",
    store: "database",
    "trust-boundary": "shield",
  };

  function buildOverview(input) {
    input = input || {};
    var project = input.project || {};
    var system = input.system || {};
    var dfd = input.dfd || {};
    var nodes = Array.isArray(dfd.nodes) ? dfd.nodes : [];
    var components = Array.isArray(system.components) ? system.components : [];
    var interfaces = Array.isArray(system.interfaces) ? system.interfaces : [];
    var componentById = new Map(components.map(function (component) { return [component.id, component]; }));
    var nodeIds = new Set(nodes.map(function (node) { return node.id; }));
    var childrenByParent = new Map();
    nodes.forEach(function (node) {
      var parent = node.parent == null ? null : node.parent;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(node);
    });
    var roots = [];
    var seen = new Set();

    function toItem(node, depth) {
      if (seen.has(node.id)) return null;
      seen.add(node.id);
      var component = node.componentRef ? componentById.get(node.componentRef) : undefined;
      var memberCount = node.type === "trust-boundary" && Array.isArray(node.members) ? node.members.length : 0;
      var item = {
        id: node.id,
        label: node.label,
        type: node.type,
        typeLabel: TYPE_LABEL[node.type] || node.type || "",
        icon: TYPE_ICON[node.type] || "symbol-misc",
        layer: Number.isInteger(node.layer) ? node.layer : depth,
        componentName: component ? component.name : undefined,
        memberCount: memberCount,
        interfaces: component ? interfaces.filter(function (iface) {
          return !iface.hidden && iface.component === component.id;
        }).map(function (iface) { return iface.name; }) : [],
        children: [],
      };
      (childrenByParent.get(node.id) || []).forEach(function (child) {
        var result = toItem(child, depth + 1);
        if (result) item.children.push(result);
      });
      return item;
    }

    nodes.forEach(function (node) {
      var parent = node.parent == null ? null : node.parent;
      if (parent !== null && nodeIds.has(parent)) return;
      var result = toItem(node, 1);
      if (result) roots.push(result);
    });

    return {
      deviceName: project.device && project.device.name || project.title || "Device",
      roots: roots,
    };
  }

  function openAction(node) {
    return { command: "embedrisk.dfdOverviewOpen", args: [node.layer] };
  }

  var api = { TYPE_LABEL: TYPE_LABEL, TYPE_ICON: TYPE_ICON, buildOverview: buildOverview, openAction: openAction };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.DfdOverviewModel = api;
})(typeof window !== "undefined" ? window : globalThis);
