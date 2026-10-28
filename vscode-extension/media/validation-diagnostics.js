// Project-wide Problems-panel diagnostics. The controller is host-agnostic so its
// refresh, file association, and read-only behavior can be tested without VS Code.
(function (g) {
  "use strict";

  const STEP_FILES = {
    project: "01-project-description/project.json",
    assumptions: "02-assumptions/assumptions.json",
    system: "03-system-assets/system.json",
    dfd: "04-dfd/dfd.json",
    useCases: "04b-use-cases/use-cases.json",
    threats: "06-threats/threats.json",
    requirements: "05-requirements/requirements.json",
    countermeasures: "08-countermeasures/countermeasures.json",
    attackTrees: "07-attack-trees/attack-trees.json",
    defects: "09-defects/defects.json",
  };
  const EMPTY = {
    project: {}, assumptions: {}, system: {}, dfd: {}, useCases: {},
    threats: {}, requirements: {}, countermeasures: {}, attackTrees: {}, defects: {},
  };
  const severityFor = (severity, values = {}) => ({
    error: values.error ?? "error",
    warning: values.warning ?? "warning",
    notice: values.information ?? values.notice ?? "information",
  }[severity] ?? (values.warning ?? "warning"));
  const asRows = (value) => Array.isArray(value) ? value : [];

  function entityFiles(documents) {
    const ids = new Map();
    const add = (file, rows) => asRows(rows).forEach((row) => {
      if (row && typeof row.id === "string" && row.id && !ids.has(row.id)) ids.set(row.id, file);
    });
    const system = documents.system || {};
    const assumptions = documents.assumptions || {};
    add(STEP_FILES.system, system.components);
    add(STEP_FILES.system, system.interfaces);
    add(STEP_FILES.system, system.trustBoundaries);
    add(STEP_FILES.system, system.assets);
    add(STEP_FILES.assumptions, assumptions.device);
    add(STEP_FILES.assumptions, assumptions.system);
    add(STEP_FILES.assumptions, assumptions.environment);
    add(STEP_FILES.assumptions, assumptions.operational);
    add(STEP_FILES.assumptions, assumptions.attacker);
    add(STEP_FILES.threats, documents.threats && (documents.threats.threats ?? documents.threats));
    add(STEP_FILES.requirements, documents.requirements && (documents.requirements.requirements ?? documents.requirements));
    add(STEP_FILES.countermeasures, documents.countermeasures && (documents.countermeasures.countermeasures ?? documents.countermeasures));
    add(STEP_FILES.attackTrees, documents.attackTrees && documents.attackTrees.trees);
    add(STEP_FILES.defects, documents.defects && (documents.defects.defects ?? documents.defects));
    add(STEP_FILES.dfd, documents.dfd && documents.dfd.nodes);
    add(STEP_FILES.dfd, documents.dfd && documents.dfd.flows);
    add(STEP_FILES.useCases, documents.useCases && documents.useCases.diagrams);
    return ids;
  }

  function issueFile(issue, ids) {
    if (issue.key === "usecases-excluded") return STEP_FILES.useCases;
    if (/^A threat is missing its ID\./.test(issue.message || "")) return STEP_FILES.threats;
    if (/^A countermeasure is missing its ID\./.test(issue.message || "")) return STEP_FILES.countermeasures;
    if (/^No attacker assumptions\b/.test(issue.message || "")) return STEP_FILES.assumptions;
    if (/^Interface\b/.test(issue.message || "")) return STEP_FILES.system;
    if (/^Flow\b/.test(issue.message || "")) return STEP_FILES.dfd;
    // The earliest known entity ID in the message/key is the object being assessed.
    // This also maps global duplicate-ID messages to the duplicated entity.
    let best = null;
    for (const [id, file] of ids) {
      for (const text of [String(issue.message || ""), String(issue.key || "")]) {
        const index = text.indexOf(id);
        if (index >= 0 && (!best || index < best.index)) best = { index, file };
      }
    }
    return best ? best.file : STEP_FILES.project;
  }

  function createValidationController(deps) {
    const validate = deps.validate || (typeof module !== "undefined" && module.exports
      ? require("./validation-model.js").validate
      : g.ValidationModel.validate);

    async function refresh() {
      deps.clear();
      const roots = await deps.findProjects();
      for (const root of roots) {
        const documents = { ...EMPTY };
        const diagnostics = new Map();
        let projectReadable = false;
        for (const [key, file] of Object.entries(STEP_FILES)) {
          try {
            const text = await deps.readFile(root, file);
            documents[key] = JSON.parse(text);
            if (key === "project") projectReadable = true;
          } catch (error) {
            if (error && (error.code === "ENOENT" || error.code === "FileNotFound")) continue;
            const message = error instanceof SyntaxError
              ? `Invalid JSON: ${error.message}`
              : `Unable to read project file: ${error && error.message ? error.message : String(error)}`;
            diagnostics.set(file, [{ severity: "error", message, key: `invalid-json:${file}`, source: "EmbedRisk" }]);
            if (key === "project") break;
          }
        }
        if (projectReadable) {
          const ids = entityFiles(documents);
          for (const issue of validate(documents)) {
            const file = issueFile(issue, ids);
            if (!diagnostics.has(file)) diagnostics.set(file, []);
            diagnostics.get(file).push({
              severity: severityFor(issue.severity),
              message: issue.message,
              key: issue.key,
              source: "EmbedRisk",
            });
          }
        }
        for (const [file, entries] of diagnostics) await deps.publish(root, file, entries);
      }
    }
    return { refresh };
  }

  const api = { STEP_FILES, severityFor, issueFile, entityFiles, createValidationController };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.ValidationDiagnostics = api;
})(typeof window !== "undefined" ? window : globalThis);
