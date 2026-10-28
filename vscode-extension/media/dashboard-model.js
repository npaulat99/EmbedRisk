/* Read-only native dashboard model. Uses the shared webapp-compatible field names and risk engine. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./risk-model.js"));
  else root.DashboardModel = factory(root.RiskModel);
})(typeof window !== "undefined" ? window : globalThis, function (RiskModel) {
  "use strict";

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function list(value) {
    return Array.isArray(value) ? value.filter(function (item) {
      return item && typeof item === "object" && !Array.isArray(item);
    }) : [];
  }
  function text(value, fallback) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function buildDashboard(input) {
    input = record(input);
    var project = record(input.project);
    var system = record(input.system);
    var threatsDoc = record(input.threats);
    var cmsDoc = record(input.countermeasures);
    var requirementsDoc = record(input.requirements);
    var defectsDoc = record(input.defects);
    var schemeInput = record(input.scheme);
    var matrix = record(schemeInput.matrix);
    var configuredBands = list(matrix.bands).filter(function (band) {
      return typeof band.name === "string" && typeof band.min === "number" && typeof band.max === "number";
    });
    var scheme = { matrix: Object.assign({}, matrix, {
      bands: configuredBands.length ? configuredBands : RiskModel.DEFAULT_BANDS,
    }) };
    var components = list(system.components);
    var interfaces = list(system.interfaces);
    var assets = list(system.assets);
    var threats = list(threatsDoc.threats);
    var cms = list(cmsDoc.countermeasures).map(function (item) {
      var copy = Object.assign({}, item);
      copy.addresses = list(item.addresses);
      return copy;
    });
    var requirements = list(requirementsDoc.requirements);
    var defects = list(defectsDoc.defects);
    var implementedCms = cms.filter(function (item) { return item.selected !== false; });
    var thirdParty = components.filter(function (item) {
      return !!item.provenance && !/^own\b/i.test(String(item.provenance));
    });
    var missingTicket = implementedCms.filter(function (item) {
      var tickets = Array.isArray(item.ticketUrls) && item.ticketUrls.length
        ? item.ticketUrls : item.ticketUrl ? [item.ticketUrl] : [];
      return (item.status === "implemented" || item.status === "verified") && !tickets.length;
    });
    var highNoReq = threats.filter(function (threat) {
      return (threat.likelihood || 0) * (threat.impact || 0) >= 12
        && threat.status !== "accepted"
        && !requirements.some(function (requirement) {
          return Array.isArray(requirement.derivedFromThreat) && requirement.derivedFromThreat.includes(threat.id);
        });
    });
    var stats = [
      { label: "Components", value: components.length, file: "03-system-assets/system.json" },
      { label: "3rd-party SW/HW", value: thirdParty.length, file: "03-system-assets/system.json" },
      { label: "Interfaces", value: interfaces.length, file: "03-system-assets/system.json" },
      { label: "Assets", value: assets.length, file: "03-system-assets/system.json" },
      { label: "Threats", value: threats.length, file: "06-threats/threats.json" },
      { label: "Open threats", value: threats.filter(function (item) { return item.status === "open"; }).length, file: "06-threats/threats.json" },
      { label: "Protocol limits", value: threats.filter(function (item) { return item.classification === "protocol-limitation"; }).length, file: "06-threats/threats.json" },
      { label: "Deployment risks", value: threats.filter(function (item) { return item.classification === "deployment-risk"; }).length, file: "06-threats/threats.json" },
      { label: "Shared controls", value: threats.filter(function (item) { return item.classification === "shared-responsibility"; }).length, file: "06-threats/threats.json" },
      { label: "Requirements", value: requirements.length, file: "05-requirements/requirements.json" },
      { label: "High threats w/o req.", value: highNoReq.length, file: "06-threats/threats.json", warning: highNoReq.length > 0 },
      { label: "Countermeasures", value: implementedCms.length, file: "08-countermeasures/countermeasures.json" },
      { label: "Missing ticket links", value: missingTicket.length, file: "08-countermeasures/countermeasures.json", warning: missingTicket.length > 0 },
      { label: "Open defects", value: defects.filter(function (item) {
        return item.status !== "fixed" && item.status !== "wont-fix";
      }).length, file: "09-defects/defects.json" },
    ];

    var risks = threats.map(function (threat) {
      var safeThreat = Object.assign({}, threat);
      return { threat: safeThreat, risk: RiskModel.riskOf(safeThreat, cms, scheme) };
    });
    function summarize(which) {
      var values = risks.map(function (item) { return item.risk[which]; });
      var bands = [{ name: "None", count: 0 }].concat(RiskModel.bandsOf(scheme).map(function (band) {
        return { name: band.name, count: 0 };
      }));
      risks.forEach(function (item) {
        var target = bands.find(function (band) { return band.name === item.risk[which + "Band"].name; });
        if (target) target.count++;
      });
      return {
        maxScore: values.reduce(function (max, value) { return Math.max(max, value); }, 0),
        highCount: values.filter(function (value) { return value >= 12; }).length,
        bands: bands,
      };
    }

    var device = record(project.device);
    return {
      title: text(device.name, text(project.title, "EmbedRisk project")),
      description: "SL-C " + (project.slTarget || "—") + " · " + text(record(project.scope).mode, "graybox")
        + " · status " + text(project.status, "draft"),
      stats: stats,
      initial: summarize("initial"),
      residual: summarize("residual"),
      threats: risks.map(function (item) {
        var threat = item.threat;
        var id = typeof threat.id === "string" ? threat.id : "";
        return {
          id: id,
          label: (id ? id + " · " : "") + text(threat.title, "Untitled threat"),
          description: "Initial " + item.risk.initial + " (" + item.risk.initialBand.name + ") · Residual "
            + item.risk.residual + " (" + item.risk.residualBand.name + ") · " + text(threat.status, "unknown status"),
        };
      }),
    };
  }

  return { buildDashboard: buildDashboard };
});
