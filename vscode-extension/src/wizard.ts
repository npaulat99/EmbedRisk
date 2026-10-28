import * as vscode from "vscode";

interface PF { proj: vscode.Uri; }

const rdRaw = async (proj: vscode.Uri, rel: string, def: any) => {
  try { return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(proj, rel))).toString()); } catch { return def; }
};
const write = (proj: vscode.Uri, rel: string, obj: any) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(proj, rel), Buffer.from(JSON.stringify(obj, null, 2)));

function threatCostFields(row: any) {
  const out = { ...row };
  // Null explicitly clears these optional assessments; omitted snapshot fields stay absent.
  for (const key of ["requiredSkill", "requiredAccess", "costFactors", "costRationales", "costLikelihood", "costLikelihoodProposal"]) {
    if (out[key] === null) delete out[key];
  }
  return out;
}

async function locate(): Promise<PF | undefined> {
  const candidates = await vscode.workspace.findFiles("**/01-project-description/project.json", "**/node_modules/**");
  const norm = (u: vscode.Uri) => u.path.replace(/\\/g, "/");
  const active = vscode.window.activeTextEditor?.document?.uri;
  const activePath = active ? norm(active) : "";
  const score = (u: vscode.Uri) => {
    const p = norm(u);
    if (p.includes("/.local/") || p.includes("/10-tra-versions/")) return 100;
    if (activePath && activePath.startsWith(p.slice(0, p.lastIndexOf("/01-project-description/project.json")))) return -1;
    if (p.includes("/projects/")) return 0;
    if (p.includes("/webapp/projects/")) return 1;
    return 10;
  };
  const filtered = candidates.filter((u) => {
    const p = norm(u);
    return !p.includes("/.local/") && !p.includes("/10-tra-versions/");
  });
  const pool = (filtered.length ? filtered : candidates).sort((a, b) => score(a) - score(b));
  if (!pool[0]) return undefined;
  return { proj: vscode.Uri.joinPath(pool[0], "..", "..") };
}

async function countTrees(proj: vscode.Uri): Promise<number> {
  try {
    const doc = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(proj, "07-attack-trees/attack-trees.json"))).toString());
    return (doc.trees || []).length;
  } catch { return 0; }
}

async function readChangeTracker(proj: vscode.Uri) {
  const doc = await rdRaw(proj, "01-project-description/change-tracker.json", {});
  const entries: any[] = Array.isArray(doc.entries) ? doc.entries : [];
  const currentVersion: string | null = doc.currentVersion || (entries.length ? (entries[entries.length - 1]?.version || null) : null);
  return { currentVersion, entries };
}

async function writeSnapshot(proj: vscode.Uri, version: string): Promise<void> {
  const steps: Record<string, string> = {
    project: "01-project-description/project.json",
    assumptions: "02-assumptions/assumptions.json",
    system: "03-system-assets/system.json",
    dfd: "04-dfd/dfd.json",
    useCases: "04b-use-cases/use-cases.json",
    requirements: "05-requirements/requirements.json",
    threats: "06-threats/threats.json",
    attackTrees: "07-attack-trees/attack-trees.json",
    countermeasures: "08-countermeasures/countermeasures.json",
  };
  const base = vscode.Uri.joinPath(proj, "10-tra-versions", version);
  for (const [, rel] of Object.entries(steps)) {
    const data = await rdRaw(proj, rel, {});
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, dir));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(base, rel), Buffer.from(JSON.stringify(data, null, 2)));
  }
}

async function buildData(proj: vscode.Uri) {
  const project = await rdRaw(proj, "01-project-description/project.json", {});
  const threats = (await rdRaw(proj, "06-threats/threats.json", { threats: [] })).threats || [];
  const cms = (await rdRaw(proj, "08-countermeasures/countermeasures.json", { countermeasures: [] })).countermeasures || [];
  const defects = (await rdRaw(proj, "09-defects/defects.json", { defects: [] })).defects || [];
  const system = await rdRaw(proj, "03-system-assets/system.json", { components: [], assets: [] });
  const assumptions = await rdRaw(proj, "02-assumptions/assumptions.json", {});
  const dfd = await rdRaw(proj, "04-dfd/dfd.json", { nodes: [] });
  const useCases = await rdRaw(proj, "04b-use-cases/use-cases.json", { diagrams: [] });
  const reqs = (await rdRaw(proj, "05-requirements/requirements.json", { requirements: [] })).requirements || [];
  const tracker = await readChangeTracker(proj);
  const comps = (system.components || []).map((c: any) => ({ id: c.id, name: c.name }));
  const useCaseNoticePending = (useCases.diagrams || []).length > 0
    && !project.reportOptions?.includeUseCases
    && !((project.acceptedNotices || []).includes("usecases-excluded"));
  return {
    changeTracker: tracker,
    project: {
      title: project.title || "",
      status: project.status || "draft",
      name: project.device?.name || "",
      type: project.device?.type || "",
      version: project.device?.version || "",
      modelReference: project.device?.modelReference || "",
      sl: project.slTarget || "SL2",
      riskScoringMethod: project.riskScoringMethod || "cost-based",
      acceptableRisk: project.acceptableRisk,
      costFactorWeights: project.costFactorWeights,
      accessProbabilities: project.accessProbabilities,
      likelihoodProbabilityThresholds: project.likelihoodProbabilityThresholds,
      mode: project.scope?.mode || "graybox",
      boundary: project.scope?.boundary || "",
      inScope: project.scope?.inScope || [],
      outOfScope: project.scope?.outOfScope || [],
      intendedUse: project.intendedUse || "",
      foreseeableUse: project.foreseeableUse || [],
      projectBranchUrl: project.repo?.projectBranchUrl || "",
      kbUrl: project.repo?.kbUrl || "",
      sbom: project.sbom || {},
      includeUseCases: !!project.reportOptions?.includeUseCases,
      useCaseNames: (useCases.diagrams || []).map((d: any) => d.name || d.id),
      useCaseNoticePending,
    },
    threats, cms, defects, comps,
    requirements: reqs,
    assumptions: {
      attacker: assumptions.attacker || [],
      device: assumptions.device || [],
      system: assumptions.system || [],
      environment: assumptions.environment || [],
      operational: assumptions.operational || [],
    },
    system: {
      components: system.components || [],
      interfaces: system.interfaces || [],
      trustBoundaries: system.trustBoundaries || [],
      assets: system.assets || [],
    },
    counts: {
      project: !!(project.device?.name && project.scope?.boundary),
      assumptions: (assumptions.attacker || []).length,
      system: (system.components || []).length,
      systemAssets: (system.assets || []).length,
      dfd: (dfd.nodes || []).length,
      useCases: (useCases.diagrams || []).length,
      requirements: reqs.length,
      threats: threats.length,
      attackTrees: await countTrees(proj),
      countermeasures: cms.length,
      defects: defects.length,
      versions: tracker.entries.length,
    },
  };
}

function parseThreatCmImport(parsed: any): { threats: any[]; countermeasures: any[] } {
  let threats: any[] = [];
  let countermeasures: any[] = [];
  if (Array.isArray(parsed)) {
    if (!parsed.length) throw new Error("No threats or countermeasures found in the file.");
    countermeasures = parsed[0]?.addresses ? parsed : [];
    threats = parsed[0]?.addresses ? [] : parsed;
  } else if (parsed && typeof parsed === "object") {
    if (Object.prototype.hasOwnProperty.call(parsed, "threats")) {
      if (!Array.isArray(parsed.threats)) throw new Error("The threats field must be an array.");
      threats = parsed.threats;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "countermeasures")) {
      if (!Array.isArray(parsed.countermeasures)) throw new Error("The countermeasures field must be an array.");
      countermeasures = parsed.countermeasures;
    }
  } else throw new Error("Expected a JSON object or array.");

  if (!threats.length && !countermeasures.length) throw new Error("No threats or countermeasures found in the file.");
  const validateRows = (rows: any[], label: string) => rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${label} ${index + 1} must be a JSON object.`);
    if (row.id != null && (typeof row.id !== "string" || !row.id.trim())) throw new Error(`${label} ${index + 1} has an invalid ID.`);
    if (row.addresses != null && (!Array.isArray(row.addresses) || row.addresses.some((a: any) => !a || typeof a !== "object" || Array.isArray(a)))) {
      throw new Error(`${label} ${index + 1} has invalid addresses.`);
    }
    if (row.countermeasures != null && (!Array.isArray(row.countermeasures) || row.countermeasures.some((id: any) => typeof id !== "string"))) {
      throw new Error(`${label} ${index + 1} has invalid countermeasure references.`);
    }
  });
  validateRows(threats, "Threat");
  validateRows(countermeasures, "Countermeasure");
  return { threats, countermeasures };
}

async function projectIds(proj: vscode.Uri): Promise<Set<string>> {
  const docs: [string, string[]][] = [
    ["03-system-assets/system.json", ["components", "interfaces", "trustBoundaries", "assets"]],
    ["04-dfd/dfd.json", ["nodes"]],
    ["05-requirements/requirements.json", ["requirements"]],
    ["06-threats/threats.json", ["threats"]],
    ["07-attack-trees/attack-trees.json", ["trees"]],
    ["08-countermeasures/countermeasures.json", ["countermeasures"]],
    ["09-defects/defects.json", ["defects"]],
    ["02-assumptions/assumptions.json", ["device", "system", "environment", "operational", "attacker"]],
  ];
  const ids = new Set<string>();
  for (const [rel, keys] of docs) {
    const doc = await rdRaw(proj, rel, {});
    for (const key of keys) if (Array.isArray(doc[key])) {
      for (const row of doc[key]) if (typeof row?.id === "string") ids.add(row.id);
    }
  }
  return ids;
}

function nextImportedId(prefix: string, claimed: Set<string>): string {
  let n = 1;
  while (claimed.has(`${prefix}${n}`)) n++;
  const id = `${prefix}${n}`;
  claimed.add(id);
  return id;
}

function importedIdPrefix(id: any, fallback: string): string {
  const match = typeof id === "string" ? id.match(/^(.*?)\d+$/) : null;
  return match?.[1] || fallback;
}

function managedSlcAttacker(sl: string) {
  const level = Math.max(1, Math.min(4, Number(String(sl).replace(/\D/g, "")) || 2));
  const capability = ({ 1: 1, 2: 2, 3: 3, 4: 5 } as Record<number, number>)[level];
  const names = ["", "Casual or Coincidental Violation", "Simple Intentional Attacks", "Sophisticated ACS Attacks", "State-Sponsored/Professional Attacks"];
  return { id: `ATK-SLC-${level}`, name: `Threat Actor ${level}: ${names[level]}`, capability, motivation: "Managed by the selected SL-C level", resources: "Managed SL-C attacker profile", text: `SL-C ${level} attacker profile managed by EmbedRisk.` };
}

function cleanProjectList(items: string[]) {
  return items.map((item) => item.trim()).filter(Boolean);
}

function countermeasureSaveFields(c: { ticketUrls?: string[]; ticketUrl?: string; responsibility?: string }) {
  const tickets = cleanProjectList(c.ticketUrls?.length ? c.ticketUrls : c.ticketUrl ? [c.ticketUrl] : []);
  return {
    ...(c.ticketUrls !== undefined || c.ticketUrl !== undefined ? { ticketUrls: tickets, ticketUrl: tickets[0] || "" } : {}),
    ...(c.responsibility !== undefined ? { responsibility: c.responsibility || undefined } : {}),
  };
}

function countermeasureFieldError(rows: unknown): string | undefined {
  if (!Array.isArray(rows)) return "Countermeasures must be a list.";
  for (const c of rows) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return "Each countermeasure must be an object.";
    for (const key of ["ticketUrl", "verificationUrl"]) {
      if (c[key] !== undefined && typeof c[key] !== "string") return `Countermeasure ${key} must be text.`;
    }
    for (const key of ["ticketUrls", "negativeEffects"]) {
      if (c[key] !== undefined && (!Array.isArray(c[key]) || !c[key].every((v: unknown) => typeof v === "string"))) return `Countermeasure ${key} must be a list of text.`;
    }
    if (c.responsibility !== undefined && !["", "product", "deployment", "shared"].includes(c.responsibility)) return "Invalid countermeasure responsibility.";
    if (c.addresses !== undefined) {
      if (!Array.isArray(c.addresses)) return "Countermeasure addresses must be a list.";
      for (const a of c.addresses) {
        if (!a || typeof a !== "object" || Array.isArray(a)) return "Each countermeasure address must be an object.";
        for (const key of ["ratedBy", "ratedAt"]) {
          if (a[key] !== undefined && typeof a[key] !== "string") return `Residual ${key} must be text.`;
        }
      }
    }
  }
}

export async function openWizard(ctx: vscode.ExtensionContext, focusThreatId?: string) {
  const f = await locate();
  if (!f) { vscode.window.showWarningMessage("No EmbedRisk project found. Use 'EmbedRisk: New Project' to create one."); return; }
  const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
  const panel = vscode.window.createWebviewPanel("embedriskWizard", "EmbedRisk Wizard", vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [media] });
  const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "tra-ui.css"));
  const riskUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "risk-model.js"));
  const attackTreeUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "attacktree-model.js"));
  const threatUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "threat-model.js"));
  const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "embedrisk-logo.svg"));
  const nonce = String(Math.random()).slice(2);
  const csp = `default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource};`;
  panel.webview.html = shell(cssUri, riskUri, attackTreeUri, threatUri, logoUri, csp, nonce);

  const sendInit = async () => panel.webview.postMessage({ cmd: "init", data: await buildData(f.proj), focusThreatId, bugBar: await rdRaw(ctx.extensionUri, "runtime/.assets/knowledge-base/bug-bar.json", null), scheme: await rdRaw(ctx.extensionUri, "runtime/.assets/knowledge-base/risk-scheme.json", null) });
  const counts = async () => (await buildData(f.proj)).counts;

  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.cmd === "ready") return sendInit();

    if (m.cmd === "threatCmExport") {
      try {
        const threatDoc = await rdRaw(f.proj, "06-threats/threats.json", { threats: [] });
        const cmDoc = await rdRaw(f.proj, "08-countermeasures/countermeasures.json", { countermeasures: [] });
        const threatIds = new Set(Array.isArray(m.threatIds) ? m.threatIds.filter((id: any) => typeof id === "string") : []);
        const cmIds = new Set(Array.isArray(m.cmIds) ? m.cmIds.filter((id: any) => typeof id === "string") : []);
        const selectedThreats = (threatDoc.threats || []).filter((t: any) => threatIds.has(t.id));
        const selectedCms = (cmDoc.countermeasures || []).filter((c: any) => cmIds.has(c.id));
        if (!selectedThreats.length && !selectedCms.length) {
          return panel.webview.postMessage({ cmd: "threatCmIo", text: "Select at least one threat or countermeasure to export.", ok: false });
        }
        const out: any = {};
        if (selectedThreats.length) out.threats = selectedThreats;
        if (selectedCms.length) out.countermeasures = selectedCms;
        const project = await rdRaw(f.proj, "01-project-description/project.json", {});
        const base = String(project.projectId || project.title || "embedrisk").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "embedrisk";
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${base}-threats-countermeasures.json`),
          filters: { JSON: ["json"] },
          saveLabel: "Export JSON",
        });
        if (!uri) return;
        if (uri.scheme !== "file" || !uri.path.toLowerCase().endsWith(".json")) {
          return panel.webview.postMessage({ cmd: "threatCmIo", text: "Choose a local .json file for export.", ok: false });
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(out, null, 2)));
        return panel.webview.postMessage({ cmd: "threatCmIo", text: `Exported ${selectedThreats.length} threat(s) and ${selectedCms.length} countermeasure(s).`, ok: true });
      } catch {
        return panel.webview.postMessage({ cmd: "threatCmIo", text: "Export failed.", ok: false });
      }
    }

    if (m.cmd === "threatCmImport") {
      try {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          openLabel: "Import JSON", filters: { JSON: ["json"] },
        });
        if (!picked?.length) return;
        const source = picked[0];
        if (source.scheme !== "file" || !source.path.toLowerCase().endsWith(".json")) {
          return panel.webview.postMessage({ cmd: "threatCmIo", text: "Import only supports local .json files.", ok: false });
        }
        let parsed: any;
        try { parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(source)).toString()); }
        catch { return panel.webview.postMessage({ cmd: "threatCmIo", text: "Import failed: not valid JSON.", ok: false }); }
        const { threats: rawThreats, countermeasures: rawCms } = parseThreatCmImport(parsed);
        const claimed = await projectIds(f.proj);
        const threatIdMap = new Map<string, string>();
        const cmIdMap = new Map<string, string>();
        const newThreats = rawThreats.map((row: any) => {
          const id = row.id && !claimed.has(row.id)
            ? (claimed.add(row.id), row.id)
            : nextImportedId(importedIdPrefix(row.id, "T"), claimed);
          if (row.id) threatIdMap.set(row.id, id);
          return { ...row, id };
        });
        const newCms = rawCms.map((row: any) => {
          const id = row.id && !claimed.has(row.id)
            ? (claimed.add(row.id), row.id)
            : nextImportedId(importedIdPrefix(row.id, "CM"), claimed);
          if (row.id) cmIdMap.set(row.id, id);
          return { ...row, id };
        });
        for (const cm of newCms) cm.addresses = (cm.addresses || []).map((address: any) => ({
          ...address, threat: threatIdMap.get(address.threat) || address.threat,
        }));
        for (const threat of newThreats) if (threat.countermeasures) {
          threat.countermeasures = threat.countermeasures.map((id: string) => cmIdMap.get(id) || id);
        }
        const threatDoc = await rdRaw(f.proj, "06-threats/threats.json", { threats: [] });
        const cmDoc = await rdRaw(f.proj, "08-countermeasures/countermeasures.json", { countermeasures: [] });
        if (newThreats.length) await write(f.proj, "06-threats/threats.json", { ...threatDoc, threats: [...(threatDoc.threats || []), ...newThreats] });
        if (newCms.length) await write(f.proj, "08-countermeasures/countermeasures.json", { ...cmDoc, countermeasures: [...(cmDoc.countermeasures || []), ...newCms] });
        const remapped = [...threatIdMap.entries(), ...cmIdMap.entries()].filter(([oldId, newId]) => oldId !== newId).length;
        return panel.webview.postMessage({
          cmd: "threatCmImported", threats: newThreats, cms: newCms,
          text: `Imported ${newThreats.length} threat(s) and ${newCms.length} countermeasure(s).${remapped ? ` ${remapped} id(s) renamed to avoid collisions.` : ""}`,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : "Import failed.";
        return panel.webview.postMessage({ cmd: "threatCmIo", text: `Import failed: ${text}`, ok: false });
      }
    }

    const cmInput = m.cmd === "cms" ? m.cms : m.cmd === "autoSave" ? m.data?.cms : undefined;
    if (cmInput !== undefined || m.cmd === "cms") {
      const error = countermeasureFieldError(cmInput);
      if (error) return panel.webview.postMessage({ cmd: "err", text: error });
    }
    const projectInput = m.cmd === "project" ? m : m.cmd === "autoSave" ? m.data?.project : undefined;
    const status: unknown = projectInput?.status;
    if (status !== undefined && (typeof status !== "string" || !["draft", "in-progress", "review", "released"].includes(status))) {
      return panel.webview.postMessage({ cmd: "err", text: "Invalid project status. Choose draft, in-progress, review or released." });
    }
    for (const key of ["intendedUse", "projectBranchUrl", "kbUrl"]) {
      if (projectInput?.[key] !== undefined && typeof projectInput[key] !== "string") {
        return panel.webview.postMessage({ cmd: "err", text: `Invalid ${key}. Enter text.` });
      }
    }
    for (const key of ["inScope", "outOfScope", "foreseeableUse"]) {
      const items: unknown = projectInput?.[key];
      if (items !== undefined && (!Array.isArray(items) || !items.every((item) => typeof item === "string"))) {
        return panel.webview.postMessage({ cmd: "err", text: `Invalid ${key} list. Each item must be text.` });
      }
    }

    if (m.cmd === "project") {
      const project = await rdRaw(f.proj, "01-project-description/project.json", {});
      if (typeof m.title === "string") project.title = m.title;
      if (typeof m.intendedUse === "string") project.intendedUse = m.intendedUse;
      if (Array.isArray(m.foreseeableUse)) project.foreseeableUse = cleanProjectList(m.foreseeableUse);
      for (const key of ["projectBranchUrl", "kbUrl"]) {
        if (typeof m[key] === "string") {
          project.repo = project.repo || {};
          project.repo[key] = m[key];
        }
      }
      if (status !== undefined) project.status = status;
      project.device = project.device || {}; project.device.name = m.name; project.slTarget = m.sl;
      for (const key of ["type", "version", "modelReference"]) {
        if (typeof m[key] === "string") project.device[key] = m[key];
      }
      project.scope = project.scope || {}; project.scope.mode = m.mode; project.scope.boundary = m.bnd;
      for (const key of ["inScope", "outOfScope"]) {
        if (Array.isArray(m[key])) project.scope[key] = cleanProjectList(m[key]);
      }
      project.reportOptions = project.reportOptions || {};
      project.reportOptions.includeUseCases = !!m.includeUseCases;
      if (project.reportOptions.includeUseCases && Array.isArray(project.acceptedNotices)) {
        project.acceptedNotices = project.acceptedNotices.filter((k: string) => k !== "usecases-excluded");
      }
      if (m.sbom && typeof m.sbom === "object") project.sbom = m.sbom;
      await write(f.proj, "01-project-description/project.json", project);
      return panel.webview.postMessage({ cmd: "msg", text: "Project saved.", counts: await counts() });
    }

    if (m.cmd === "ackUseCaseNotice") {
      const project = await rdRaw(f.proj, "01-project-description/project.json", {});
      const notices = Array.isArray(project.acceptedNotices) ? project.acceptedNotices : [];
      if (!notices.includes("usecases-excluded")) notices.push("usecases-excluded");
      project.acceptedNotices = notices;
      await write(f.proj, "01-project-description/project.json", project);
      return sendInit();
    }

    if (m.cmd === "threats") {
      const rows = m.threats as any[];
      const compIds = new Set((m.compIds as string[]) || []);
      const assumptionsDoc = await rdRaw(f.proj, "02-assumptions/assumptions.json", {});
      const assumptionIds = new Set([
        ...((assumptionsDoc.device || []).map((x: any) => x.id)),
        ...((assumptionsDoc.system || []).map((x: any) => x.id)),
        ...((assumptionsDoc.environment || []).map((x: any) => x.id)),
        ...((assumptionsDoc.operational || []).map((x: any) => x.id)),
        ...((assumptionsDoc.attacker || []).map((x: any) => x.id)),
      ].filter(Boolean));
      const idPattern = /^[A-Za-z0-9 _:.-]+$/;
      const problems: string[] = []; const seen = new Set<string>();
      rows.forEach((t, i) => {
        const id = (t.id || "").trim();
        if (!id) problems.push(`Row ${i + 1}: missing ID.`);
        else if (seen.has(id)) problems.push(`Duplicate threat ID '${id}'.`); else seen.add(id);
        if (!(t.components || []).length) problems.push(`Threat '${id || i + 1}': at least one affected component is required.`);
        (t.components || []).forEach((c: string) => { if (!compIds.has(c)) problems.push(`Threat '${id}': unknown component '${c}'.`); });
        if (!(t.stride || []).length) problems.push(`Threat '${id}': assign at least one STRIDE category.`);
        (t.assumptionRefs || []).forEach((a: string) => {
          if (!idPattern.test(String(a))) problems.push(`Threat '${id}': invalid assumption ID '${a}'.`);
          else if (!assumptionIds.has(a)) problems.push(`Threat '${id}': unknown assumption '${a}'.`);
        });
      });
      if (problems.length) return panel.webview.postMessage({ cmd: "err", text: "Cannot save:\n" + problems.join("\n") });
      const threatDoc = await rdRaw(f.proj, "06-threats/threats.json", { threats: [] });
      const prev = new Map((threatDoc.threats || []).map((t: any) => [t.id, t]));
      const norm = rows.map((t: any) => {
        const base: any = prev.get(t.id) || {};
        const out: any = {
          ...base, ...t,
          id: t.id, title: t.title,
          stride: (t.stride || []).map((s: string) => s.toUpperCase()),
          components: t.components || [],
          likelihood: Math.max(0, Math.min(5, +(t.likelihood ?? 3))),
          impact: Math.max(1, Math.min(5, +t.impact || 3)),
          status: t.status || base.status || "open",
          assets: t.assets || base.assets || [],
        };
        // Preserve extended risk-calculator fields from the frontend
        const pick = (k: string) => { if (t[k] != null) out[k] = t[k]; else if (base[k] != null) out[k] = base[k]; };
        ['attackerRef', 'interfaceRefs', 'interfaceLabel',
          'impactDimensions', 'likelihoodFactors', 'cvss',
          'likelihoodRationale', 'impactRationale',
          'acceptedBy', 'acceptanceRationale', 'reviewDate',
          'assumptionRefs'].forEach(pick);
        return threatCostFields(out);
      });
      await write(f.proj, "06-threats/threats.json", { ...threatDoc, threats: norm });
      return panel.webview.postMessage({ cmd: "threats", threats: norm, counts: await counts(), text: "Threats saved." });
    }

    if (m.cmd === "cms") {
      const rows = m.cms as any[];
      const threats = (await rdRaw(f.proj, "06-threats/threats.json", { threats: [] })).threats || [];
      const tById = new Map(threats.map((t: any) => [t.id, t]));
      const problems: string[] = []; const seen = new Set<string>();
      rows.forEach((c, i) => {
        const id = (c.id || "").trim();
        if (!id) problems.push(`CM row ${i + 1}: missing ID.`);
        else if (seen.has(id)) problems.push(`Duplicate countermeasure ID '${id}'.`); else seen.add(id);
        if (!(c.addresses || []).length) problems.push(`Countermeasure '${id || i + 1}': must address at least one threat.`);
        (c.addresses || []).forEach((a: any) => {
          const th: any = tById.get(a.threat);
          if (!th) { problems.push(`Countermeasure '${id}': unknown threat '${a.threat}'.`); return; }
          if (a.residualImpact > th.impact) problems.push(`${id}: residual impact for ${a.threat} (${a.residualImpact}) exceeds initial (${th.impact}).`);
          if (a.residualLikelihood > th.likelihood) problems.push(`${id}: residual likelihood for ${a.threat} (${a.residualLikelihood}) exceeds initial (${th.likelihood}).`);
          if (c.type === "preventive" && a.residualImpact < th.impact) problems.push(`${id}: a preventive control should reduce likelihood, not impact (${a.threat}).`);
        });
      });
      if (problems.length) return panel.webview.postMessage({ cmd: "err", text: "Cannot save:\n" + problems.join("\n") });
      const cmDoc = await rdRaw(f.proj, "08-countermeasures/countermeasures.json", { countermeasures: [] });
      const prev = new Map((cmDoc.countermeasures || []).map((c: any) => [c.id, c]));
      const norm = rows.map((c: any) => {
        const base: any = prev.get(c.id) || {};
        return {
          ...base,
          id: c.id, title: c.title, type: c.type || "preventive", status: c.status || "proposed",
          components: c.components || base.components || [],
          ...(c.iec62443Ref ? { iec62443Ref: c.iec62443Ref } : base.iec62443Ref ? { iec62443Ref: base.iec62443Ref } : {}),
          ...(c.description ? { description: c.description } : base.description ? { description: base.description } : {}),
          ...(c.negativeEffects !== undefined ? { negativeEffects: c.negativeEffects } : {}),
          ...(c.verificationUrl !== undefined ? { verificationUrl: c.verificationUrl } : {}),
          ...countermeasureSaveFields(c),
          addresses: (c.addresses || []).map((a: any) => {
            const prevA: any = ((base.addresses || []) as any[]).find((x: any) => x.threat === a.threat) || {};
            const addr: any = {
              ...prevA,
              threat: a.threat,
              residualLikelihood: a.residualLikelihood == null || a.residualLikelihood === "" ? 2 : Math.max(0, Math.min(5, +a.residualLikelihood || 0)),
              residualImpact: a.residualImpact == null || a.residualImpact === "" ? 2 : Math.max(0, Math.min(5, +a.residualImpact || 0)),
            };
            const pickA = (k: string) => { if (a[k] != null) addr[k] = a[k]; else if (prevA[k] != null) addr[k] = prevA[k]; };
            ['attackerRef', 'interfaceRefs', 'interfaceLabel',
              'likelihoodFactors', 'impactDimensions', 'cvss', 'ratedBy', 'ratedAt'].forEach(pickA);
            return addr;
          }),
        };
      });
      await write(f.proj, "08-countermeasures/countermeasures.json", { ...cmDoc, countermeasures: norm });
      return panel.webview.postMessage({ cmd: "cms", cms: norm, counts: await counts(), text: "Countermeasures saved." });
    }

    if (m.cmd === "assumptions") {
      const a = m.assumptions || {};
      const attacker = a.attacker || [];
      const problems: string[] = []; const seen = new Set<string>();
      if (!attacker.length) problems.push("At least one attacker profile is required (it grounds the likelihood).");
      attacker.forEach((p: any, i: number) => {
        const id = (p.id || "").trim();
        if (!id) problems.push(`Attacker row ${i + 1}: missing ID.`);
        else if (seen.has(id)) problems.push(`Duplicate attacker ID '${id}'.`); else seen.add(id);
        if (!(p.name || "").trim()) problems.push(`Attacker '${id || i + 1}': name is required.`);
      });
      if (problems.length) return panel.webview.postMessage({ cmd: "err", text: "Cannot save assumptions:\n" + problems.join("\n") });
      const prev = await rdRaw(f.proj, "02-assumptions/assumptions.json", {});
      const doc = {
        ...prev,
        attacker: attacker.map((p: any) => ({ ...p, capability: Math.max(1, Math.min(5, +p.capability || 2)) })),
        device: a.device || [], system: a.system || [], environment: a.environment || [], operational: a.operational || [],
      };
      await write(f.proj, "02-assumptions/assumptions.json", doc);
      return panel.webview.postMessage({ cmd: "assumptions", assumptions: doc, counts: await counts(), text: "Assumptions saved." });
    }

    if (m.cmd === "system") {
      const s = m.system || {};
      const components = s.components || [];
      const problems: string[] = []; const seen = new Set<string>();
      components.forEach((c: any, i: number) => {
        const id = (c.id || "").trim();
        if (!id) problems.push(`Component row ${i + 1}: missing ID.`);
        else if (seen.has(id)) problems.push(`Duplicate component ID '${id}'.`); else seen.add(id);
        if (!(c.name || "").trim()) problems.push(`Component '${id || i + 1}': name is required.`);
      });
      const aseen = new Set<string>();
      (s.assets || []).forEach((a: any, i: number) => {
        const id = (a.id || "").trim();
        if (!id) problems.push(`Asset row ${i + 1}: missing ID.`);
        else if (aseen.has(id)) problems.push(`Duplicate asset ID '${id}'.`); else aseen.add(id);
      });
      if (problems.length) return panel.webview.postMessage({ cmd: "err", text: "Cannot save system:\n" + problems.join("\n") });
      const clampO = (o: any) => ({
        confidentiality: Math.max(0, Math.min(5, +(o?.confidentiality ?? 0))),
        integrity: Math.max(0, Math.min(5, +(o?.integrity ?? 0))),
        availability: Math.max(0, Math.min(5, +(o?.availability ?? 0))),
        safety: Math.max(0, Math.min(5, +(o?.safety ?? 0))),
      });
      const prev = await rdRaw(f.proj, "03-system-assets/system.json", {});
      const doc = {
        ...prev,
        components: components.map((c: any) => ({ ...c, layer: +c.layer || 1, parent: c.parent || null })),
        interfaces: s.interfaces || [],
        trustBoundaries: s.trustBoundaries || [],
        assets: (s.assets || []).map((a: any) => ({ ...a, objectives: clampO(a.objectives) })),
      };
      await write(f.proj, "03-system-assets/system.json", doc);
      const comps = doc.components.map((c: any) => ({ id: c.id, name: c.name }));
      return panel.webview.postMessage({ cmd: "system", system: doc, comps, counts: await counts(), text: "System & assets saved." });
    }

    if (m.cmd === "requirements") {
      const rows = (m.requirements as any[]) || [];
      const problems: string[] = []; const seen = new Set<string>();
      rows.forEach((r: any, i: number) => {
        const id = (r.id || "").trim();
        if (!id) problems.push(`Requirement row ${i + 1}: missing ID.`);
        else if (seen.has(id)) problems.push(`Duplicate requirement ID '${id}'.`); else seen.add(id);
      });
      if (problems.length) return panel.webview.postMessage({ cmd: "err", text: "Cannot save requirements:\n" + problems.join("\n") });
      const norm = rows.map((r: any) => ({
        ...r, id: r.id, text: r.text || "",
        standardRef: r.standardRef || "", slFr: r.slFr || "",
        derivedFromThreat: r.derivedFromThreat || [], satisfiedByCM: r.satisfiedByCM || [],
      }));
      await write(f.proj, "05-requirements/requirements.json", { requirements: norm });
      return panel.webview.postMessage({ cmd: "requirements", requirements: norm, counts: await counts(), text: "Requirements saved." });
    }

    if (m.cmd === "versionRecord") {
      const validReasons = ["initial", "functional changes", "new vulnerabilities", "regular reassessment"];
      if (!validReasons.includes(m.reason)) {
        return panel.webview.postMessage({ cmd: "versionResult", ok: false, error: "Invalid reason." });
      }
      const assessors: string[] = Array.isArray(m.assessors)
        ? m.assessors.map((x: any) => String(x).trim()).filter(Boolean)
        : [];
      if (!assessors.length) {
        return panel.webview.postMessage({ cmd: "versionResult", ok: false, error: "At least one assessor is required." });
      }
      const tracker = await readChangeTracker(f.proj);
      const isFirst = tracker.entries.length === 0;
      if (isFirst && m.reason !== "initial") {
        return panel.webview.postMessage({ cmd: "versionResult", ok: false, error: "The first recorded version must have reason 'initial'." });
      }
      if (!isFirst && m.reason === "initial") {
        return panel.webview.postMessage({ cmd: "versionResult", ok: false, error: "An initial version has already been recorded." });
      }
      let nextVer = "v1.0";
      if (!isFirst && tracker.currentVersion) {
        const mm = /^v?(\d+)\.(\d+)$/.exec(tracker.currentVersion);
        const maj = mm ? Number(mm[1]) : 1;
        const min = mm ? Number(mm[2]) : 0;
        nextVer = m.reason === "functional changes" ? `v${maj + 1}.0` : `v${maj}.${min + 1}`;
      }
      try { await writeSnapshot(f.proj, nextVer); } catch { /* non-critical */ }
      const entry = {
        version: nextVer,
        reason: m.reason,
        assessedAt: String(m.assessedAt || new Date().toISOString().slice(0, 10)),
        assessors,
        summary: String(m.summary || ""),
      };
      const nextTracker = { currentVersion: nextVer, entries: [...tracker.entries, entry] };
      await write(f.proj, "01-project-description/change-tracker.json", nextTracker);
      return panel.webview.postMessage({ cmd: "versionResult", ok: true, tracker: nextTracker, counts: await counts(), text: `Recorded ${nextVer}.` });
    }

    if (m.cmd === "autoSave") {
      try {
        const d = m.data || {};
        if (d.project) {
          const proj = await rdRaw(f.proj, "01-project-description/project.json", {});
          if (typeof d.project.title === "string") proj.title = d.project.title;
          if (typeof d.project.intendedUse === "string") proj.intendedUse = d.project.intendedUse;
          if (Array.isArray(d.project.foreseeableUse)) proj.foreseeableUse = cleanProjectList(d.project.foreseeableUse);
          for (const key of ["projectBranchUrl", "kbUrl"]) {
            if (typeof d.project[key] === "string") {
              proj.repo = proj.repo || {};
              proj.repo[key] = d.project[key];
            }
          }
          if (status !== undefined) proj.status = status;
          proj.device = proj.device || {}; proj.device.name = d.project.name;
          for (const key of ["type", "version", "modelReference"]) {
            if (typeof d.project[key] === "string") proj.device[key] = d.project[key];
          }
          proj.slTarget = d.project.sl; proj.riskScoringMethod = d.project.riskScoringMethod || "cost-based"; proj.scope = proj.scope || {};
          proj.scope.mode = d.project.mode; proj.scope.boundary = d.project.boundary;
          for (const key of ["inScope", "outOfScope"]) {
            if (Array.isArray(d.project[key])) proj.scope[key] = cleanProjectList(d.project[key]);
          }
          proj.reportOptions = proj.reportOptions || {};
          proj.reportOptions.includeUseCases = !!d.project.includeUseCases;
          if (proj.reportOptions.includeUseCases && Array.isArray(proj.acceptedNotices)) {
            proj.acceptedNotices = proj.acceptedNotices.filter((k: string) => k !== "usecases-excluded");
          }
          if (d.project.sbom) proj.sbom = d.project.sbom;
          await write(f.proj, "01-project-description/project.json", proj);
          const attacker = managedSlcAttacker(proj.slTarget);
          const assumptions = await rdRaw(f.proj, "02-assumptions/assumptions.json", {});
          await write(f.proj, "02-assumptions/assumptions.json", { ...assumptions, attacker: [attacker] });
          const threatDoc = await rdRaw(f.proj, "06-threats/threats.json", { threats: [] });
          await write(f.proj, "06-threats/threats.json", { ...threatDoc, threats: (threatDoc.threats || []).map((threat: any) => ({ ...threat, attackerRef: attacker.id, status: typeof threat.requiredSkill === "number" && threat.requiredSkill > attacker.capability ? "unfeasible" : threat.status === "unfeasible" ? "open" : threat.status })) });
        }
        if (Array.isArray(d.threats)) {
          const threatDoc = await rdRaw(f.proj, "06-threats/threats.json", { threats: [] });
          await write(f.proj, "06-threats/threats.json", { ...threatDoc, threats: d.threats.map(threatCostFields) });
        }
        if (Array.isArray(d.cms)) {
          const cmDoc = await rdRaw(f.proj, "08-countermeasures/countermeasures.json", { countermeasures: [] });
          await write(f.proj, "08-countermeasures/countermeasures.json", { ...cmDoc, countermeasures: d.cms.map((c: any) => ({ ...c, ...countermeasureSaveFields(c) })) });
        }
        if (Array.isArray(d.defects)) {
          const defectDoc = await rdRaw(f.proj, "09-defects/defects.json", { defects: [] });
          await write(f.proj, "09-defects/defects.json", { ...defectDoc, defects: d.defects });
        }
        if (d.assumptions) await write(f.proj, "02-assumptions/assumptions.json", d.assumptions);
        if (d.system) {
          const prev = await rdRaw(f.proj, "03-system-assets/system.json", {});
          await write(f.proj, "03-system-assets/system.json", { ...prev, components: d.system.components || [], interfaces: d.system.interfaces || [], trustBoundaries: d.system.trustBoundaries || [], assets: d.system.assets || [] });
        }
        if (Array.isArray(d.requirements)) await write(f.proj, "05-requirements/requirements.json", { requirements: d.requirements });
        return panel.webview.postMessage({ cmd: "saved", counts: await counts() });
      } catch { return panel.webview.postMessage({ cmd: "err", text: "Auto-save failed." }); }
    }

    if (m.cmd === "openFile") {
      try { const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(f.proj, m.rel)); await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside); }
      catch { vscode.window.showInformationMessage(`${m.rel} does not exist yet.`); }
      return;
    }
    if (m.cmd === "dfd") return void vscode.commands.executeCommand("vscode.openWith", vscode.Uri.joinPath(f.proj, "04-dfd/dfd.json"), "embedrisk.dfdNative");
    if (m.cmd === "useCases") return void vscode.commands.executeCommand("embedrisk.useCases");
    if (m.cmd === "report") return void vscode.commands.executeCommand("embedrisk.report");
    if (m.cmd === "kb") return void vscode.commands.executeCommand("embedrisk.kbBrowse");
    if (m.cmd === "atree") return void vscode.commands.executeCommand("embedrisk.newAttackTree");
  }, undefined, ctx.subscriptions);
}

function shell(cssUri: vscode.Uri, riskUri: vscode.Uri, attackTreeUri: vscode.Uri, threatUri: vscode.Uri, logoUri: vscode.Uri, csp: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
<style>
.bbselect { overflow-x:auto; }
.bbselect table { width:100%; table-layout:fixed; min-width:600px; }
.bbselect th, .bbselect td { padding:4px; vertical-align:top; text-align:left; }
.bbselect th:first-child { width:90px; }
.bbsel-badge { margin-left:6px; font-weight:bold; }
.bbcell { width:100%; padding:8px; text-align:left; cursor:pointer; font:inherit; color:var(--text); background:var(--surface); border:1px solid var(--border); border-radius:4px; }
.bbcell.filled { background:color-mix(in srgb, var(--accent) 16%, var(--surface)); }
.bbcell.selected { border:2px solid var(--accent); font-weight:bold; }
</style>
</head><body>
<div class="app">
  <div class="topbar">
    <div class="brand"><img class="logo" src="${logoUri}" alt="" width="22" height="22"><span>EmbedRisk <small id="devname"></small></span></div>
    <span class="spacer"></span>
    <button class="btn" id="undoBtn" data-act="undo" title="Undo (Ctrl+Z)" disabled>&#8630; Undo</button>
    <button class="btn" id="redoBtn" data-act="redo" title="Redo (Ctrl+Y / Ctrl+Shift+Z)" disabled>&#8631; Redo</button>
    <span id="savingStatus" style="font-size:11px;margin-left:4px"></span>
    <button class="btn" data-cmd="kb">Knowledge base</button>
    <button class="btn primary" data-cmd="report">Generate report</button>
  </div>
  <div class="layout">
    <nav class="stepnav" id="rail"></nav>
    <div class="main" id="main">
      <div id="err" class="errbox" style="display:none"></div>
      <div id="ok" class="okbox" style="display:none"></div>

      <div class="card" id="card-project">
        <h2>01 · Project</h2>
        <div class="desc">Device, scope, and target security level.</div>
        <div class="field"><label for="p-title">Project title</label><input class="inp" id="p-title" placeholder="TRA: ..."></div>
        <div class="row">
          <div class="field"><label for="p-type">Device type</label><input class="inp" id="p-type" placeholder="radar level sensor"></div>
          <div class="field"><label for="p-version">Version under assessment</label><input class="inp" id="p-version" placeholder="FW 2.4 / HW B"></div>
          <div class="field"><label for="p-modelReference">Model reference</label><input class="inp" id="p-modelReference"></div>
        </div>
        <div class="row">
          <div class="field" style="flex:2"><label>Device name</label><input class="inp" id="p-name"></div>
          <div class="field"><label>SL target</label>
            <select class="inp" id="p-sl"><option>SL1</option><option>SL2</option><option>SL3</option><option>SL4</option></select></div>
          <div class="field"><label>Risk scoring</label><select class="inp" id="p-risk"><option value="exposure-exploitability-impact">Exposure x Exploitability x Impact</option><option value="cost-based">Cost-based</option></select></div>
          <div class="field"><label>Scope mode</label>
            <select class="inp" id="p-mode"><option>blackbox</option><option>graybox</option><option>whitebox</option></select></div>
          <div class="field"><label for="p-status">Status</label>
            <select class="inp" id="p-status"><option>draft</option><option>in-progress</option><option>review</option><option>released</option></select></div>
        </div>
        <div class="field"><label>Boundary</label><input class="inp" id="p-bnd"></div>
        <div class="grid2">
          <div class="field"><label>In scope</label><div id="p-inScope"></div></div>
          <div class="field"><label>Out of scope</label><div id="p-outOfScope"></div></div>
        </div>
        <h3>Intended purpose and reasonably foreseeable use (CRA)</h3>
        <div class="field"><label for="p-intendedUse">Intended purpose</label><textarea class="inp" id="p-intendedUse" rows="3" placeholder="The manufacturer's intended purpose and operating conditions."></textarea></div>
        <div class="field"><label>Reasonably foreseeable use</label><div id="p-foreseeableUse"></div></div>
        <h3>Repositories</h3>
        <div class="field"><label for="p-projectBranchUrl">Project branch / PR URL</label><input class="inp" id="p-projectBranchUrl" placeholder="https://github.com/owner/project/tree/branch"></div>
        <div class="field"><label for="p-kbUrl">Knowledge-base Git URL</label><input class="inp" id="p-kbUrl" placeholder="https://github.com/owner/knowledge-base.git"></div>
        <div class="field" style="margin-top:8px">
          <label class="hint" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="p-uc-inc"> Include use-case diagrams in report</label>
        </div>
        <div class="field" style="margin-top:6px"><button class="btn" data-cmd="useCases">Open use-case editor</button></div>
        <div class="field" id="p-uc-note" style="display:none;border:1px solid var(--warn);border-radius:8px;padding:8px;background:var(--surface-2)">
          <b style="color:var(--warn)">Notice:</b> Use-case diagrams exist but are excluded from the report.
          <div style="margin-top:6px"><button class="btn sm" data-cmd="ackUseCaseNotice">Acknowledge intentional exclusion</button></div>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Use-case diagrams</label>
          <ul id="p-uc-list" class="hint" style="margin:4px 0 0 18px"></ul>
        </div>
        <details style="margin-top:8px"><summary class="hint" style="cursor:pointer;list-style:none;padding:3px 0">&#9654; Software Bill of Materials (SBOM)</summary>
          <div class="grid3" style="margin-top:6px">
            <div class="field"><label>SBOM source</label>
              <select class="inp" id="p-sbom-mode">
                <option value="in-tool">In-tool</option>
                <option value="external">External</option>
              </select></div>
            <div class="field" id="p-sbom-fmt"><label>Format</label>
              <select class="inp" id="p-sbom-format"><option value="cyclonedx">CycloneDX</option><option value="spdx">SPDX 2.3</option></select></div>
            <div class="field" id="p-sbom-url" style="display:none"><label>External SBOM URL</label>
              <input class="inp" id="p-sbom-url-inp" placeholder="https://…/device-sbom.cdx.json"></div>
          </div>
        </details>
        <p class="hint" style="margin:6px 0 0">Changes save automatically.</p>
      </div>

      <div class="card" id="card-assumptions">
        <h2>02 · Assumptions</h2>
        <div class="desc">Device, system, environment, and operational assumptions. The attacker is selected by SL-C.</div>
        <div class="tabs" id="asm-tabs"></div>
        <div id="asm-body"></div>

      </div>

      <div class="card" id="card-system">
        <h2>03 · System &amp; assets</h2>
        <div class="desc">Components, interfaces, trust boundaries, and protected assets.</div>
        <div class="tabs" id="sys-tabs"></div>
        <div id="sys-body"></div>

      </div>

      <div class="card" id="card-requirements">
        <h2>05 · Security requirements</h2>
        <div class="desc">Testable requirements linked to threats and controls.</div>
        <div id="req-body"></div>
        <div style="margin-top:10px"><button class="btn" data-act="addReq">+ Requirement</button></div>
      </div>

      <div class="card" id="card-threats">
        <h2>06 · Threats &amp; risk</h2>
        <div class="desc">Each threat needs a unique ID, STRIDE category, and affected component.</div>
        <div class="row" style="margin:8px 0">
          <button class="btn sm" data-act="importThreatCm">⇑ Import JSON…</button>
          <button class="btn sm" data-act="exportThreatCm">⇓ Export selected…</button>
          <span class="hint">Select records with the Export checkboxes; all fields and metadata are preserved.</span>
        </div>
        <div class="risk-matrix" id="threats-matrix" aria-label="Threat risk matrix"></div>
        <table class="grid"><thead><tr><th>Export</th><th class="narrow">ID</th><th>Title</th><th>STRIDE</th><th>Components</th><th class="num">L</th><th class="num">I</th><th>Risk &rarr; residual</th><th class="stat">Status</th><th></th></tr></thead><tbody id="threats-body"></tbody></table>
        <div style="margin-top:10px"><button class="btn" data-act="addT">+ Threat</button></div>
      </div>

      <div class="card" id="card-cms">
        <h2>08 · Countermeasures</h2>
        <div class="desc">Countermeasures set residual L/I per threat.</div>
        <div class="hint" style="margin:8px 0">Use the Export checkboxes to include selected countermeasures in JSON exports.</div>
        <div class="risk-matrix" id="cms-matrix" aria-label="Countermeasure risk matrix"></div>
        <div id="cms-list"></div>
        <div style="margin-top:10px"><button class="btn" data-act="addC">+ Countermeasure</button></div>
      </div>

      <div class="card" id="card-defects">
        <h2>09 · Defects &amp; vulnerabilities</h2>
        <div class="desc">Track known defects and CVEs per component, and link threats for reassessment.</div>
        <div id="defects-list"></div>
        <div style="margin-top:10px"><button class="btn" data-act="addDefect">+ Defect</button></div>
      </div>

      <div class="card" id="card-versions">
        <h2>11 · TRA versions</h2>
        <div class="desc">Tag assessment baselines so you can track changes across reassessments.</div>
        <div id="versions-body"></div>
      </div>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${riskUri}"></script>
<script nonce="${nonce}" src="${attackTreeUri}"></script>
<script nonce="${nonce}" src="${threatUri}"></script>
<script nonce="${nonce}">
(function(){
const vs=acquireVsCodeApi(), R=window.RiskModel||{
  bandClass:function(n){return String(n||'').toLowerCase();},
  residual:function(t,cms){
    if(t.status==='unfeasible')return [0,0];
    var links=[];(cms||[]).forEach(function(cm){if(cm.selected===false)return;(cm.addresses||[]).forEach(function(a){if(a.threat===t.id)links.push(a);});});
    var rl=t.likelihood||0,ri=t.impact||0;
    links.forEach(function(a){rl=Math.min(rl,a.residualLikelihood==null?(t.likelihood||0):a.residualLikelihood);ri=Math.min(ri,a.residualImpact==null?(t.impact||0):a.residualImpact);});
    return [rl,ri];
  },
  riskOf:function(t,cms){var i=t.status==='unfeasible'?0:(t.likelihood||0)*(t.impact||0),r=this.residual(t,cms),rs=(r[0]||0)*(r[1]||0),b=function(s){return {name:s<=0?'None':'Medium'};};return {initial:i,initialBand:b(i),residual:rs,residualBand:b(rs),residualLikelihood:r[0],residualImpact:r[1]};},
  deriveImpact:function(d){if(!d)return null;var v=[d.confidentiality,d.integrity,d.availability,d.safety].filter(function(x){return typeof x==='number';});return v.length?Math.max.apply(null,v):null;},
  deriveLikelihood:function(f){if(!f)return null;var has=typeof f.exposure==='number'||typeof f.exploitability==='number';if(!has)return null;var e=typeof f.exposure==='number'?f.exposure:3;var x=typeof f.exploitability==='number'?f.exploitability:3;return Math.min(5,Math.max(1,Math.round(Math.sqrt(e*x))));},
  cvssBaseScore:function(){return null;},
  cvssExploitability:function(){return null;},
  exposureFromInterface:function(){return null;}
};
const STRIDE=[['S','Spoofing'],['T','Tampering'],['R','Repudiation'],['I','Info disclosure'],['D','Denial of service'],['E','Elevation']];
const T_STATUS=[['open','Open'],['mitigated','Mitigated'],['accepted','Accepted'],['transferred','Transferred'],['unfeasible','Unfeasible']];
const SKILL_OPTS=[[1,'Script kiddie'],[2,'Experienced hacker'],[3,'Security engineer'],[4,'Expert team'],[5,'Nation-state']];
const COST_ACCESS_OPTS=[[1,'Remote (unauth.)'],[2,'Remote (auth.)'],[3,'Adjacent / fieldbus'],[4,'Local (on site)'],[5,'Physical (open enclosure)']];
const COST_FACTORS=[
  ['time','Time effort',['Minutes','Hours','Days','Weeks','Months+']],
  ['exploitability','Exploitability',['Trivial','Easy','Moderate','Difficult','Very Difficult']],
  ['window','Window of opportunity',['Permanent','Regular','Occasional','Brief','One-Time']],
  ['detection','Detection probability',['None','Low','Moderate','High','Very High']],
  ['notoriety','Prior knowledge',['Public','Known','Limited','Internal','Unknown']],
  ['prep','Preparation effort',['None','Software setup','Test environment','Procure','Infrastructure']],
  ['abort','Abort risk',['Robust','Rare','Moderate','Frequent','Very Likely']]
];
const ACCESS=[['remote','Remote'],['adjacent','Adjacent'],['local','Local'],['physical','Physical']];
const ASM_CATS=[['device','Device'],['system','System'],['environment','Environment'],['operational','Operational']];
const COMP_KINDS=['device','hardware','software','interface','external-entity','store'];
const PROVENANCE=['own','third-party (OSS)','third-party (commercial)','subcontracted'];
const IF_CATS=['network','external','user'];
const EXPOSURE=['physical','local','adjacent','remote'];
const ASSET_TYPES=['data','function','credential','firmware','config','physical-process'];
const OBJS=[['confidentiality','C'],['integrity','I'],['availability','A'],['safety','S']];
const EXPOSURE_OPTS=[[1,'Physical (open enclosure)'],[2,'Local (on site)'],[3,'Adjacent / fieldbus'],[4,'Remote (authenticated)'],[5,'Remote (unauthenticated)']];
const EXPLOIT_OPTS=[[1,'Very hard (nation-state)'],[2,'Hard (specialist)'],[3,'Moderate'],[4,'Easy'],[5,'Trivial / automated']];
const DIM_KEYS=['confidentiality','integrity','availability','safety'];
let bugBar=null;
let riskScheme=null, matrixMode='residual';
let threats=[], cms=[], comps=[], counts={};
let defects=[];
let changeTracker={currentVersion:null,entries:[]};
let assumptions={attacker:[],device:[],system:[],environment:[],operational:[]};
let system={components:[],interfaces:[],trustBoundaries:[],assets:[]};
let requirements=[];
let project={title:'',status:'draft',name:'',type:'',version:'',modelReference:'',sl:'SL2',mode:'graybox',boundary:'',includeUseCases:false,useCaseNames:[],useCaseNoticePending:false};
const PROJECT_LIST_LABELS={inScope:'In scope',outOfScope:'Out of scope',foreseeableUse:'Reasonably foreseeable use'};
let undoStack=[], redoStack=[], histKey='', histTime=0;
let asmTab='device', sysTab='components';
const $=function(s){return document.querySelector(s);};
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function uid(prefix,ids){var used={};(ids||[]).forEach(function(id){if(typeof id!=='string'||id.indexOf(prefix)!==0)return;var rest=id.slice(prefix.length);if(/^[0-9]+$/.test(rest))used[Number(rest)]=true;});var n=1;while(used[n])n++;return prefix+n;}
var ASM_PREFIX={device:'AD-',system:'SYSA-',environment:'AE-',operational:'AO-'};
function optTags(list,val){return list.map(function(o){var v=o&&o.length&&typeof o!=='string'?o[0]:o;var l=o&&o.length&&typeof o!=='string'?o[1]:o;return '<option value="'+esc(v)+'"'+(String(val)===String(v)?' selected':'')+'>'+esc(l)+'</option>';}).join('');}
function statusLabel(s){var m={open:'Open',mitigated:'Mitigated',accepted:'Accepted',transferred:'Transferred',unfeasible:'Unfeasible'};return m[s||'open']||'Open';}
// ---- undo / redo history: snapshots of the editable project state (toolbar buttons + Ctrl+Z / Ctrl+Y) ----
function snapshot(){return JSON.stringify({project:project,threats:threats,cms:cms,defects:defects,assumptions:assumptions,system:system,requirements:requirements});}
function updUndoBtns(){var u=$('#undoBtn'),r=$('#redoBtn');if(u)u.disabled=!undoStack.length;if(r)r.disabled=!redoStack.length;}
function pushUndo(state){undoStack.push(state);if(undoStack.length>150)undoStack.shift();redoStack=[];updUndoBtns();}
function recordBefore(key){var now=Date.now();if(undoStack.length&&key===histKey&&(now-histTime<800)){histTime=now;return;}pushUndo(snapshot());histKey=key;histTime=now;}
function recordChanged(before){if(before===snapshot())return;pushUndo(before);histKey='';histTime=Date.now();}
function keyOf(t){var d=t.dataset,k=(t.id||t.tagName);for(var p in d)k+='|'+p+'='+d[p];return k;}
function applyState(s){var d=JSON.parse(s);project=d.project||project;threats=d.threats||[];cms=d.cms||[];defects=d.defects||[];assumptions=d.assumptions||assumptions;system=d.system||system;requirements=d.requirements||[];comps=(system.components||[]).map(function(c){return {id:c.id,name:c.name};});try{renderProject(project);}catch(e){console.error('project',e);}try{renderRail();}catch(e){console.error('rail',e);}try{renderThreats();}catch(e){console.error('threats',e);}try{renderCms();}catch(e){console.error('cms',e);}try{renderDefects();}catch(e){console.error('defects',e);}try{renderAssumptions();}catch(e){console.error('assumptions',e);}try{renderSystem();}catch(e){console.error('system',e);}try{renderRequirements();}catch(e){console.error('requirements',e);}}
function undo(){if(!undoStack.length)return;redoStack.push(snapshot());applyState(undoStack.pop());histKey='';updUndoBtns();scheduleAutoSave();}
function redo(){if(!redoStack.length)return;undoStack.push(snapshot());applyState(redoStack.pop());histKey='';updUndoBtns();scheduleAutoSave();}
function clearHistory(){undoStack=[];redoStack=[];histKey='';histTime=0;updUndoBtns();}
var autoSaveTimer=null;
function scheduleAutoSave(){clearTimeout(autoSaveTimer);var st=$('#savingStatus');if(st){st.textContent='Saving…';st.style.color='var(--text-faint)';}autoSaveTimer=setTimeout(doAutoSave,1500);}
function readSbom(){
  var sbomMode=($('#p-sbom-mode')||{}).value||'in-tool';
  var sbomObj={mode:sbomMode,format:($('#p-sbom-format')||{}).value||'cyclonedx'};
  if(sbomMode!=='in-tool')sbomObj.url=($('#p-sbom-url-inp')||{}).value||'';
  return sbomObj;
}
function showSbomFields(sbomMode){
  var fmtEl=$('#p-sbom-fmt');if(fmtEl)fmtEl.style.display=sbomMode==='in-tool'?'':'none';
  var urlEl=$('#p-sbom-url');if(urlEl)urlEl.style.display=sbomMode!=='in-tool'?'':'none';
}
function doAutoSave(){
  var proj=Object.assign({},project,{sbom:readSbom()});
  vs.postMessage({cmd:'autoSave',data:{project:proj,threats:threats,cms:cms,defects:defects,assumptions:assumptions,system:system,requirements:requirements}});
}
function pill(score,band){return '<span class="pill '+R.bandClass(band.name)+'">'+score+' · '+band.name+'</span>';}
function riskCell(t){var r=R.riskOf(t,cms);return pill(r.initial,r.initialBand)+'<span class="arrow">&rarr;</span>'+pill(r.residual,r.residualBand);}
function chip(text,on,attrs,title){return '<span class="chip'+(on?' on':'')+'" role="button" tabindex="0" '+attrs+(title?' title="'+esc(title)+'"':'')+'>'+esc(text)+'</span>';}
function navigateThreat(id){
  if(!threats.some(function(t){return t.id===id;}))return;
  var card=$('#card-threats');
  if(card&&card.scrollIntoView)card.scrollIntoView({behavior:'smooth',block:'start'});
  var row=Array.prototype.find.call(document.querySelectorAll('#threats-body tr[data-threat-row]'),function(el){return el.dataset.threatRow===id;});
  if(row){if(row.scrollIntoView)row.scrollIntoView({behavior:'smooth',block:'center'});row.focus();}
}
function matrixThreatChooser(ids,opener){
  if(ids.length===1){navigateThreat(ids[0]);return;}
  if(ids.length<2)return;
  var overlay=document.createElement('div');overlay.className='matrix-threat-overlay';
  var dialog=document.createElement('div');dialog.className='matrix-threat-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','matrix-threat-title');
  var title=document.createElement('h2');title.id='matrix-threat-title';title.textContent='Threats at selected risk';
  var close=document.createElement('button');close.type='button';close.className='btn sm';close.setAttribute('aria-label','Close threat chooser');close.textContent='Close';
  var head=document.createElement('div');head.className='matrix-threat-head';head.appendChild(title);head.appendChild(close);dialog.appendChild(head);
  var finish=function(){overlay.remove();if(opener&&opener.focus)opener.focus();};
  close.addEventListener('click',finish);
  overlay.addEventListener('click',function(e){if(e.target===overlay)finish();});
  ids.forEach(function(id){
    var threat=threats.find(function(t){return t.id===id;});if(!threat)return;
    var button=document.createElement('button');button.type='button';button.className='matrix-threat-choice';
    button.textContent=String(id)+' — '+String(threat.title||'Untitled threat');
    button.addEventListener('click',function(){finish();navigateThreat(id);});
    dialog.appendChild(button);
  });
  overlay.appendChild(dialog);document.body.appendChild(overlay);close.focus();
}
function activateMatrixCell(cell){
  if(!cell||!cell.dataset.matrixThreats)return;
  var ids;try{ids=JSON.parse(cell.dataset.matrixThreats);}catch(_){return;}
  if(Array.isArray(ids))matrixThreatChooser(ids,cell);
}

const STEPS=[
  ['01','Project','Scope, device, SL-C','scroll','#card-project','project'],
  ['02','Assumptions','Device, system, environment, operational','scroll','#card-assumptions','assumptions'],
  ['03','System & Assets','Components, C/I/A/S','scroll','#card-system','system'],
  ['04','Data Flow Diagram','Layered DeMarco model','cmd','dfd','dfd'],
  ['05','Requirements','Security requirements','scroll','#card-requirements','requirements'],
  ['06','Threats','STRIDE + risk rating','scroll','#card-threats','threats'],
  ['07','Attack trees','Optional · AND/OR','cmd','atree','attackTrees'],
  ['08','Countermeasures','Residual risk','scroll','#card-cms','countermeasures'],
  ['09','Defects','Vulnerabilities and reassessment','scroll','#card-defects','defects'],
  ['10','Review & Report','Plausibility check','cmd','report','review'],
  ['11','TRA versions','Assessment history','scroll','#card-versions','versions']
];
function clientIssues(){
  var out=[],seen={};
  threats.forEach(function(t){if(!t.id)out.push('threat missing id');else if(seen[t.id])out.push('dup '+t.id);else seen[t.id]=1;
    if(!(t.components||[]).length)out.push(t.id+' no component');if(!(t.stride||[]).length)out.push(t.id+' no STRIDE');});
  var tid={};threats.forEach(function(t){tid[t.id]=t;});var sc={};
  cms.forEach(function(c){if(!c.id)out.push('cm missing id');else if(sc[c.id])out.push('dup '+c.id);else sc[c.id]=1;
    if(!(c.addresses||[]).length)out.push(c.id+' addresses nothing');
    (c.addresses||[]).forEach(function(a){var th=tid[a.threat];if(!th){out.push(c.id+' unknown '+a.threat);return;}
      if(a.residualImpact>th.impact||a.residualLikelihood>th.likelihood)out.push(c.id+' residual>initial');});});
  return out;
}
function renderRail(){
  var issues=clientIssues();
  var html='<div class="grouplabel">Methodology</div>'+STEPS.map(function(s){
    var key=s[5],badge='';
    if(key==='review'){badge=issues.length?'<span class="warnmark">'+issues.length+' &#9888;</span>':'<span class="check">&#10003;</span>';}
    else if(key==='project'){badge=counts.project?'<span class="check">&#10003;</span>':'';}
    else if(counts[key]!==undefined){badge='<span class="count">'+counts[key]+'</span>';}
    return '<button class="stepitem" data-kind="'+s[3]+'" data-target="'+esc(s[4])+'"><span class="num">'+s[0]+'</span><span class="txt"><b>'+esc(s[1])+'</b><span>'+esc(s[2])+'</span></span>'+badge+'</button>';
  }).join('');
  html+='<div class="grouplabel">Views</div><button class="stepitem" data-kind="cmd" data-target="kb"><span class="num">&#128218;</span><span class="txt"><b>Knowledge base</b><span>Reusable library</span></span></button>';
  $('#rail').innerHTML=html;
}
function renderProjectList(key){
  $('#p-'+key).innerHTML=project[key].map(function(item,i){
    var attrs=' class="inp grow" data-project-list="'+key+'" data-list-index="'+i+'" aria-label="'+esc(PROJECT_LIST_LABELS[key])+' item '+(i+1)+'"';
    var input=key==='foreseeableUse'?'<textarea'+attrs+' rows="2">'+esc(item)+'</textarea>':'<input'+attrs+' value="'+esc(item)+'">';
    return '<div class="row" style="gap:6px;margin:3px 0">'+input+
      '<button class="btn sm danger" data-act="delProjectList" data-list="'+key+'" data-list-index="'+i+'" aria-label="Remove '+esc(PROJECT_LIST_LABELS[key])+' item '+(i+1)+'">Remove</button></div>';
  }).join('')+'<button class="btn sm" data-act="addProjectList" data-list="'+key+'">+ Add item</button>';
}
function renderProject(p){
  p=p||{};
  project={title:p.title||'',name:p.name||'',sl:p.sl||'SL2',riskScoringMethod:p.riskScoringMethod||'cost-based',mode:p.mode||'graybox',boundary:p.boundary||'',sbom:p.sbom||{},includeUseCases:!!p.includeUseCases,useCaseNames:p.useCaseNames||[],useCaseNoticePending:!!p.useCaseNoticePending};
  ['acceptableRisk','costFactorWeights','accessProbabilities','likelihoodProbabilityThresholds'].forEach(function(key){project[key]=p[key];});
  project.status=p.status||'draft';$('#p-status').value=project.status;
  project.intendedUse=p.intendedUse||'';$('#p-intendedUse').value=project.intendedUse;
  Object.keys(PROJECT_LIST_LABELS).forEach(function(key){project[key]=p[key]||[];renderProjectList(key);});
  ['type','version','modelReference','projectBranchUrl','kbUrl'].forEach(function(key){project[key]=p[key]||'';$('#p-'+key).value=project[key];});
  $('#devname').textContent=project.name?('· '+project.name):'';
  $('#p-title').value=project.title;
  $('#p-name').value=project.name;$('#p-sl').value=project.sl;$('#p-risk').value=project.riskScoringMethod;$('#p-mode').value=project.mode;$('#p-bnd').value=project.boundary;
  var ucInc=$('#p-uc-inc'); if(ucInc) ucInc.checked=!!project.includeUseCases;
  var ucList=$('#p-uc-list'); if(ucList) ucList.innerHTML=(project.useCaseNames||[]).length?(project.useCaseNames||[]).map(function(n){return '<li>'+esc(n)+'</li>';}).join(''):'<li>No use-case diagrams yet.</li>';
  var ucNote=$('#p-uc-note'); if(ucNote) ucNote.style.display=project.useCaseNoticePending?'block':'none';
  var sbom=project.sbom||{},sbomMode=sbom.mode||'in-tool';
  var mSel=$('#p-sbom-mode');if(mSel)mSel.value=sbomMode;
  var fmtSel=$('#p-sbom-format');if(fmtSel)fmtSel.value=sbom.format||'cyclonedx';
  showSbomFields(sbomMode);
  var urlInp=$('#p-sbom-url-inp');if(urlInp)urlInp.value=sbom.url||'';
}
function bugBarSelector(dims,dAttr,dimAttr){
  var dimensions=bugBar&&bugBar.dimensions||[];
  if(!dimensions.length)return '<p class="hint">Bug bar reference not available.</p>';
  var missing=DIM_KEYS.filter(function(k){return typeof dims[k]!=='number';}),impact=R.deriveImpact(dims);
  return (bugBar.rule?'<p class="hint">'+esc(bugBar.rule)+'</p>':'')+
    '<table><thead><tr><th>Level</th>'+dimensions.map(function(d){
      return '<th>'+esc(d.label)+'<span class="bbsel-badge'+(typeof dims[d.key]==='number'?'':' unset')+'">'+esc(typeof dims[d.key]==='number'?dims[d.key]:'–')+'</span></th>';
    }).join('')+'</tr></thead><tbody>'+[5,4,3,2,1].map(function(score){
      var label=dimensions[0].levels.find(function(l){return l.score===score;});
      return '<tr><td><b>'+score+'</b> · '+esc(label&&label.label)+'</td>'+dimensions.map(function(d){
        var level=d.levels.find(function(l){return l.score===score;}),selected=dims[d.key];
        return '<td><button type="button" class="bbcell'+(typeof selected==='number'&&score<=selected?' filled':'')+(selected===score?' selected':'')+
          '" aria-pressed="'+(selected===score)+'" data-act="bugBar" '+dAttr+' '+dimAttr+'="'+esc(d.key)+'" data-score="'+score+'">'+esc(level&&level.scenario)+'</button></td>';
      }).join('')+'</tr>';
    }).join('')+'</tbody></table><p class="hint">'+
    (impact!=null?'Impact = worst selected dimension — currently <b>'+impact+'</b>.':'Select the applicable scenario in every column.')+
    (missing.length&&missing.length<4?' Still missing: '+missing.join(', ')+'.':'')+'</p>';
}
function calcBlock(dims,fac,cv,dAttr,dimAttr,facAttr,cvssAttr,seedAct){
  var derivedL=R.deriveLikelihood(fac);
  var autoBase=cv.vector?R.cvssBaseScore(cv.vector):null;
  var cvssVer=cv.version||'3.1';
  if(cv.vector&&String(cv.vector).indexOf('CVSS:4.0/')===0)cvssVer='4.0';
  else if(cv.vector&&String(cv.vector).indexOf('CVSS:3.')===0)cvssVer='3.1';
  var cvssPlaceholder=cvssVer==='4.0'?'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H':'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  var suggestExp=R.cvssExploitability(cv.vector);
  var expSel='<div class="field"><label title="How reachable is the attack surface">Exposure</label>'+
    '<select class="inp" '+dAttr+' '+facAttr+'="exposure"><option value="">—</option>'+
    EXPOSURE_OPTS.map(function(o){return '<option value="'+o[0]+'"'+(+fac.exposure===o[0]?' selected':'')+'>'+o[0]+' · '+o[1]+'</option>';}).join('')+
    '</select></div>';
  var xplSel='<div class="field"><label title="How easy to exploit once reached">Exploitability</label>'+
    '<select class="inp" '+dAttr+' '+facAttr+'="exploitability"><option value="">—</option>'+
    EXPLOIT_OPTS.map(function(o){return '<option value="'+o[0]+'"'+(+fac.exploitability===o[0]?' selected':'')+'>'+o[0]+' · '+o[1]+'</option>';}).join('')+
    '</select></div>';
  return '<details><summary class="hint" style="cursor:pointer;list-style:none;padding:4px 0">'+
    '&#9654; Guided rating — Bug Bar · Exposure × Exploitability · CVSS</summary>'+
    '<div style="margin-top:8px">'+
      '<b style="font-size:11px">Bug Bar impact</b> '+
      '<div class="bbselect">'+bugBarSelector(dims,dAttr,dimAttr)+'</div>'+
    '</div>'+
    '<div style="margin-top:8px">'+
      '<b style="font-size:11px">Likelihood — Exposure × Exploitability</b> '+
      '<span class="hint">'+(derivedL!=null?'→ <b>'+derivedL+'</b>':'set both to auto-derive likelihood')+'</span>'+
      '<div class="grid2" style="margin-top:4px">'+expSel+xplSel+'</div>'+
      (seedAct?'<button class="btn sm" '+seedAct+' style="margin-top:4px">Seed exposure from interface</button>':'')+
    '</div>'+
    '<div style="margin-top:8px">'+
      '<b style="font-size:11px">CVSS '+esc(cvssVer)+'</b> '+
      '<span class="hint">optional'+(suggestExp!=null?' · suggests exploitability '+suggestExp:'')+'</span>'+
      '<div class="grid4" style="margin-top:4px">'+
        '<div class="field"><label>Version</label>'+
          '<select class="inp" '+dAttr+' '+cvssAttr+'="version">'+
            ['3.1','4.0'].map(function(v){return '<option value="'+v+'"'+(cvssVer===v?' selected':'')+'>CVSS '+v+'</option>';}).join('')+
          '</select></div>'+
        '<div class="field"><label>Base score'+(autoBase!=null?' (calculated)':'')+'</label>'+
          '<input class="inp" type="number" min=0 max=10 step=0.1 '+dAttr+' '+cvssAttr+'="baseScore"'+
          ' value="'+esc(autoBase!=null?autoBase:(cv.baseScore!=null?cv.baseScore:''))+'"'+
          (autoBase!=null?' readonly title="Auto-calculated from vector"':' title="Enter a score or paste a vector below"')+'></div>'+
        '<div class="field" style="grid-column:span 2"><label>Vector</label>'+
          '<input class="inp" '+dAttr+' '+cvssAttr+'="vector" value="'+esc(cv.vector||'')+'"'+
          ' placeholder="'+esc(cvssPlaceholder)+'"></div>'+
      '</div>'+
    '</div>'+
  '</details>';
}
function selectedAttacker(){return {capability:({SL1:1,SL2:2,SL3:3,SL4:5})[project.sl]||2};}
function costWarning(t,proposal){
  var accepted=t.likelihood??3;
  return (accepted!==proposal?'Accepted likelihood L'+accepted+' differs from calculated proposal L'+proposal+'. ':'')+
    (typeof t.costLikelihoodProposal==='number'&&accepted!==t.costLikelihoodProposal?'Manual value differs from saved proposal L'+t.costLikelihoodProposal+'.':'');
}
function costSummary(t){
  var result=window.ThreatModel.calculate(t,project,selectedAttacker());
  return '<div class="grid2"><div>Calculated vector probability: <b data-cost-probability>'+ (result.probability*100).toFixed(1)+'%</b></div>'+
    '<div>Proposed matrix likelihood: <b data-cost-proposal>L'+result.proposal+' · '+['None','Very low','Low','Moderate','High','Very high'][result.proposal]+'</b></div></div>'+
    (!result.feasible?'<p class="hint warnmark">Required skill exceeds the selected SL-C attacker capability ('+selectedAttacker().capability+'); proposal is unfeasible (L0). Edit skill/access to accept.</p>':'')+
    '<p class="hint warnmark" data-cost-warning data-proposal="'+result.proposal+'">'+esc(costWarning(t,result.proposal))+'</p>';
}
function costBlock(t,i){
  return '<div style="margin-top:8px"><b>Bug Bar impact</b><div class="bbselect">'+bugBarSelector(t.impactDimensions||{},'data-i='+i,'data-dim')+'</div></div>'+
    '<div style="margin-top:8px"><b>Cost-based likelihood</b><div class="grid2">'+
    [['requiredSkill','Required skill',SKILL_OPTS,t.requiredSkill||1],['requiredAccess','Required access',COST_ACCESS_OPTS,t.requiredAccess||3]].map(function(f){
      return '<label class="field">'+f[1]+'<select class="inp" data-i='+i+' data-cost="'+f[0]+'">'+optTags(f[2].map(function(o){return [o[0],o[0]+' · '+o[1]];}),f[3])+'</select></label>';
    }).join('')+'</div><div class="grid2">'+COST_FACTORS.map(function(f){
      return '<div class="field"><label>'+f[1]+'<select class="inp" data-i='+i+' data-cost="costFactors" data-cost-key="'+f[0]+'">'+
        optTags(f[2].map(function(label,n){return [n+1,(n+1)+' · '+label];}),(t.costFactors||{})[f[0]]??3)+'</select></label>'+
        '<textarea class="inp" rows="2" data-i='+i+' data-cost="costRationales" data-cost-key="'+f[0]+'" aria-label="'+f[1]+' rationale" placeholder="Assessment reason">'+
        esc((t.costRationales||{})[f[0]]||'')+'</textarea></div>';
    }).join('')+'</div><div id="cost-summary-'+i+'">'+costSummary(t)+'</div></div>';
}
function renderMatrices(){
  var mounts=[$('#threats-matrix'),$('#cms-matrix')];
  if(!R.matrix){mounts.forEach(function(el){el.textContent='Risk matrix not available.';});return;}
  var m=R.matrix(threats,cms,riskScheme,project.acceptableRisk,matrixMode);
  var html='<div class="row" role="group" aria-label="Risk matrix mode">'+['initial','residual'].map(function(mode){
    return '<button type="button" class="btn sm" data-act="matrixMode" data-mode="'+mode+'" aria-pressed="'+(matrixMode===mode)+'">'+(mode==='initial'?'Initial':'Residual')+'</button>';
  }).join('')+'</div><table aria-label="'+matrixMode+' risk"><tbody>';
  m.cells.forEach(function(c){
    if(c.likelihood===1)html+='<tr><th scope="row">'+c.impact+'</th>';
    html+='<td data-l="'+c.likelihood+'" data-i="'+c.impact+'" '+(c.ids.length?'role="button" tabindex="0" data-matrix-threats="'+esc(JSON.stringify(c.ids))+'" aria-label="'+esc('Likelihood '+c.likelihood+' by impact '+c.impact+', '+c.band.name+', '+c.ids.length+' threat(s): '+c.ids.join(', ')+'. Activate to open.')+'" ':'')+'class="'+(c.ids.length?'hit ':'')+(c.boundaryTop?'boundary-top ':'')+(c.boundaryRight?'boundary-right':'')+'" title="'+esc('L'+c.likelihood+' × I'+c.impact+' = '+c.score+' ('+c.band.name+')'+(c.ids.length?' — '+c.ids.join(', '):''))+'">'+
      '<span class="matrix-colour"></span><span>'+c.score+'</span><small class="bandmark" aria-hidden="true">'+esc(c.band.name[0])+'</small><b class="n" aria-label="'+c.ids.length+' threats">'+(c.ids.length||'')+'</b></td>';
    if(c.likelihood===5)html+='</tr>';
  });
  html+='</tbody><tfoot><tr><td></td>'+[1,2,3,4,5].map(function(l){return '<th scope="col">'+l+'</th>';}).join('')+'</tr></tfoot></table><div class="hint">Likelihood → · Impact ↑ · '+matrixMode+' risk</div><div class="matrix-legend">'+
    m.bands.map(function(b){return '<span><i></i> '+esc(b.name)+'</span>';}).join('')+'<span><i class="threshold-key"></i> acceptable risk: '+esc(m.threshold)+'</span></div>';
  mounts.forEach(function(el){
    el.innerHTML=html;
    el.querySelectorAll('.matrix-colour').forEach(function(bg,i){bg.style.backgroundColor=m.cells[i].band.color;});
    el.querySelectorAll('.matrix-legend i:not(.threshold-key)').forEach(function(key,i){key.style.backgroundColor=m.bands[i].color;});
  });
}
function renderThreats(){
  renderMatrices();
  $('#threats-body').innerHTML=threats.length?threats.map(function(t,i){
    var st=STRIDE.map(function(s){return chip(s[0],(t.stride||[]).indexOf(s[0])>=0,'data-i='+i+' data-role="stride" data-val="'+s[0]+'"',s[1]);}).join('');
    var cc=comps.length?comps.map(function(c){return chip(c.id,(t.components||[]).indexOf(c.id)>=0,'data-i='+i+' data-role="comp" data-val="'+esc(c.id)+'"',c.name);}).join(''):'<span class="hint">Add components in step 03</span>';
    var asmOpts=[].concat(
      (assumptions.device||[]).map(function(a){return {id:a.id,text:a.text||'',src:'Device'};}),
      (assumptions.system||[]).map(function(a){return {id:a.id,text:a.text||'',src:'System'};}),
      (assumptions.environment||[]).map(function(a){return {id:a.id,text:a.text||'',src:'Environment'};}),
      (assumptions.operational||[]).map(function(a){return {id:a.id,text:a.text||'',src:'Operational'};}),
      (assumptions.attacker||[]).map(function(a){return {id:a.id,text:(a.text||a.name||''),src:'Attacker'};})
    );
    var asmById={}; asmOpts.forEach(function(a){asmById[a.id]=a;});
    var asms=asmOpts.length?asmOpts.map(function(a){return chip(a.id,(t.assumptionRefs||[]).indexOf(a.id)>=0,'data-i='+i+' data-role="asm" data-val="'+esc(a.id)+'"',a.src+(a.text?': '+a.text.slice(0,60):''));}).join(''):'<span class="hint">Define assumptions in step 02 first.</span>';
    var asmNote=(t.assumptionRefs||[]).length?'<ul style="margin:6px 0 0 18px">'+(t.assumptionRefs||[]).map(function(aid){
      var valid=/^[A-Za-z0-9 _:.-]+$/.test(String(aid));
      if(!valid)return '<li><b>'+esc(aid)+'</b> · invalid ID format</li>';
      var row=asmById[aid];
      if(!row)return '<li><b>'+esc(aid)+'</b> · assumption not found</li>';
      return '<li><b>'+esc(aid)+'</b> ('+esc(row.src)+') · '+esc(row.text||'No detail text')+'</li>';
    }).join('')+'</ul>':'';
    var dims=t.impactDimensions||{}, fac=t.likelihoodFactors||{};
    var costMode=project.riskScoringMethod==='cost-based';
    var hasFac=costMode||R.deriveLikelihood(fac)!=null||R.deriveImpact(dims)!=null;
    var primaryIfaceId=(t.interfaceRefs&&t.interfaceRefs[0]);
    var primaryIface=(system.interfaces||[]).find(function(f){return f.id===primaryIfaceId;});
    var seedAct=primaryIface?'data-act="seedExp" data-i='+i+' title="Seed from '+esc(primaryIface.name)+'"':'';
    var moreDetails='<div class="grid3" style="margin-top:8px">'+
      '<div class="field"><label>SL-C attacker</label><span class="hint">'+esc(project.sl)+' · capability '+selectedAttacker().capability+'</span></div>'+
      '<div class="field"><label>Interfaces / vectors</label>'+
        '<div class="chips">'+(system.interfaces||[]).map(function(itf){return chip(itf.tag||itf.name,(t.interfaceRefs||[]).indexOf(itf.id)>=0,'data-act="tIface" data-i='+i+' data-val="'+esc(itf.id)+'"',itf.protocol||itf.category||'');}).join('')+
        (!(system.interfaces||[]).length?'<span class="hint">Define in step 03 first.</span>':'')+
        '</div>'+
        '<input class="inp" style="margin-top:4px" data-i='+i+' data-k="interfaceLabel" value="'+esc(t.interfaceLabel||'')+'" placeholder="Custom vector label (optional)">'+
      '</div>'+
      '<div class="field"><label>Assets</label>'+
        '<div class="chips">'+(system.assets||[]).map(function(a){return chip(a.name,(t.assets||[]).indexOf(a.id)>=0,'data-act="tAsset" data-i='+i+' data-val="'+esc(a.id)+'"',a.type||'');}).join('')+
        (!(system.assets||[]).length?'<span class="hint">Define in step 03 first.</span>':'')+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div class="grid2" style="margin-top:6px">'+
      '<div class="field"><label>Likelihood rationale</label><textarea class="inp" rows=2 data-i='+i+' data-k="likelihoodRationale">'+esc(t.likelihoodRationale||'')+'</textarea></div>'+
      '<div class="field"><label>Impact rationale</label><textarea class="inp" rows=2 data-i='+i+' data-k="impactRationale">'+esc(t.impactRationale||'')+'</textarea></div>'+
    '</div>'+
    '<div class="field" style="margin-top:6px"><label>Supporting assumptions</label><div class="chips">'+asms+'</div>'+asmNote+'</div>';
    var acceptedFields=t.status==='accepted'?
      '<div class="grid3" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">'+
        '<div class="field"><label>Accepted by</label><input class="inp" data-i='+i+' data-k="acceptedBy" value="'+esc(t.acceptedBy||'')+'" placeholder="name / role"></div>'+
        '<div class="field"><label>Acceptance rationale</label><input class="inp" data-i='+i+' data-k="acceptanceRationale" value="'+esc(t.acceptanceRationale||'')+'" placeholder="compensating controls..."></div>'+
        '<div class="field"><label>Next review date</label><input class="inp" type="date" data-i='+i+' data-k="reviewDate" value="'+esc(t.reviewDate||'')+'"></div>'+
      '</div>':
      '';
    var mainRow='<tr id="threat-row-'+i+'" data-threat-row="'+esc(t.id)+'" tabindex="-1">'+
      '<td><input type="checkbox" data-export-kind="threat" data-export-id="'+esc(t.id)+'" checked aria-label="Export threat '+esc(t.id)+'"></td>'+
      '<td class="narrow"><input class="inp" data-i='+i+' data-k="id" value="'+esc(t.id)+'"></td>'+
      '<td><input class="inp" data-i='+i+' data-k="title" value="'+esc(t.title)+'"></td>'+
      '<td><div class="chips">'+st+'</div></td>'+
      '<td><div class="chips">'+cc+'</div></td>'+
      '<td class="num"><input class="inp" type="number" min=0 max=5 data-i='+i+' data-k="likelihood" value="'+(t.likelihood??3)+'"></td>'+
      '<td class="num"><input class="inp" type="number" min=1 max=5 data-i='+i+' data-k="impact" value="'+(t.impact??3)+'"></td>'+
      '<td id="tp-'+i+'">'+riskCell(t)+'</td>'+
      '<td class="stat"><div class="statwrap"><span class="badge st-'+esc(t.status||'open')+'">'+esc(statusLabel(t.status))+'</span>'+
        '<select class="inp" data-i='+i+' data-k="status">'+T_STATUS.map(function(s){return '<option value="'+s[0]+'"'+((t.status||'open')===s[0]?' selected':'')+'>'+s[1]+'</option>';}).join('')+'</select></div></td>'+
      '<td><button class="btn sm danger" data-act="delT" data-i='+i+'>&#10005;</button></td></tr>';
    var detailRow='<tr><td colspan="9" style="padding:0 8px 10px;border-top:none">'+
      '<details'+(hasFac?' open':'')+'>'+
      '<summary class="hint" style="cursor:pointer;list-style:none;padding:3px 0">&#9654; More details — attacker · interfaces · assets · guided rating</summary>'+
      moreDetails+
      (costMode?costBlock(t,i):calcBlock(dims,fac,t.cvss||{},'data-i='+i,'data-dim','data-fac','data-cvss',seedAct))+
      acceptedFields+
      '</details>'+
    '</td></tr>';
    return mainRow+detailRow;
  }).join(''):'<tr><td colspan=10 class="hint">No threats yet.</td></tr>';
}
function updatePills(){threats.forEach(function(t,i){var el=document.getElementById('tp-'+i);if(el)el.innerHTML=riskCell(t);});renderMatrices();}
function ticketRows(c){return c.ticketUrls&&c.ticketUrls.length?c.ticketUrls:c.ticketUrl?[c.ticketUrl]:[''];}
function setTicketRows(c,rows){c.ticketUrls=rows;c.ticketUrl=rows.map(function(url){return url.trim();}).filter(Boolean)[0]||'';}
function markResidualRated(i,j){var date=new Date().toISOString().slice(0,10);cms[i].addresses[j].ratedAt=date;$('#rated-at-'+i+'-'+j).textContent='Last rated '+date;}
function renderCms(){
  renderMatrices();
  $('#cms-list').innerHTML=cms.length?cms.map(function(c,i){
    var addressed=(c.addresses||[]).map(function(a){return a.threat;});
    var addrRows=(c.addresses||[]).map(function(a,j){
      var thr=threats.find(function(x){return x.id===a.threat;})||{};
      var rDims=a.impactDimensions||{}, rFac=a.likelihoodFactors||{}, rCv=a.cvss||{};
      var rBlock=calcBlock(rDims,rFac,rCv,'data-ri='+i+' data-rj='+j,'data-rdim','data-rfac','data-rcvss','');
      return '<div class="itemcard" style="margin:6px 0">'+
        '<div class="row" style="gap:8px;align-items:center">'+
          '<span class="chip static">'+esc(a.threat)+'</span>'+
          '<span class="hint" style="flex:1">'+esc(thr.title||'')+'</span>'+
          '<span class="hint">initial '+esc(thr.likelihood||'?')+'×'+esc(thr.impact||'?')+'</span>'+
        '</div>'+
        '<div class="grid2" style="margin-top:6px">'+
          '<div class="field"><label>Residual likelihood</label>'+
            '<input class="inp" type="number" min=0 max=5 data-c='+i+' data-j='+j+' data-k="residualLikelihood" value="'+(a.residualLikelihood??2)+'"></div>'+
          '<div class="field"><label>Residual impact</label>'+
            '<input class="inp" type="number" min=0 max=5 data-c='+i+' data-j='+j+' data-k="residualImpact" value="'+(a.residualImpact??2)+'"></div>'+
        '</div>'+
        rBlock+
        '<div class="row" style="margin-top:6px"><div class="field"><label for="rated-by-'+i+'-'+j+'">Rated by</label><input class="inp" id="rated-by-'+i+'-'+j+'" data-c='+i+' data-j='+j+' data-k="ratedBy" value="'+esc(a.ratedBy||'')+'" placeholder="name / initials"></div>'+
          '<span class="hint" id="rated-at-'+i+'-'+j+'">'+(a.ratedAt?'Last rated '+esc(a.ratedAt):'')+'</span></div>'+
        '<div style="margin-top:6px;text-align:right">'+
          '<button class="btn sm danger" data-act="delAddr" data-c='+i+' data-j='+j+'>remove</button>'+
        '</div>'+
      '</div>';
    }).join('');
    var avail=threats.filter(function(t){return addressed.indexOf(t.id)<0;}).map(function(t){return chip(t.id,false,'data-act="addAddr" data-c='+i+' data-val="'+esc(t.id)+'"',t.title);}).join('');
    return '<div class="card" style="margin:10px 0;background:var(--surface-2)">'+
      '<div class="row"><label class="hint"><input type="checkbox" data-export-kind="countermeasure" data-export-id="'+esc(c.id)+'" checked aria-label="Export countermeasure '+esc(c.id)+'"> Export</label><div class="field narrow" style="flex:0 0 90px"><label>ID</label><input class="inp" data-ci='+i+' data-k="id" value="'+esc(c.id)+'"></div>'+
      '<div class="field" style="flex:2"><label>Title</label><input class="inp" data-ci='+i+' data-k="title" value="'+esc(c.title)+'"></div>'+
      '<div class="field"><label>Type</label><select class="inp" data-ci='+i+' data-k="type">'+['preventive','detective','corrective','organizational'].map(function(o){return '<option'+(c.type===o?' selected':'')+'>'+o+'</option>';}).join('')+'</select></div>'+
      '<div class="field"><label>Status</label><select class="inp" data-ci='+i+' data-k="status">'+['proposed','planned','implemented','verified'].map(function(o){return '<option'+(c.status===o?' selected':'')+'>'+o+'</option>';}).join('')+'</select></div>'+
      '<button class="btn sm danger" data-act="delC" data-i='+i+' style="align-self:center">&#10005;</button></div>'+
      '<div class="field"><label for="cm-responsibility-'+i+'">Responsibility</label><select class="inp" id="cm-responsibility-'+i+'" data-ci='+i+' data-k="responsibility">'+optTags([['','-- none --'],'product','deployment','shared'],c.responsibility||'')+'</select></div>'+
      '<div class="field"><label for="cm-negative-'+i+'">Negative effects / trade-offs (one per line)</label><textarea class="inp" id="cm-negative-'+i+'" rows="2" data-ci='+i+' data-k="negativeEffects">'+esc((c.negativeEffects||[]).join('\\n'))+'</textarea></div>'+
      (c.status==='implemented'||c.status==='verified'?
        '<div style="margin-top:6px">'+
          '<div class="hint" style="margin-bottom:4px">Implementation ticket URLs'+(!ticketRows(c).some(function(url){return url.trim();})?' <span style="color:var(--warn)">(at least one required)</span>':'')+'</div>'+
          (ticketRows(c).map(function(url,ti){
            return '<div class="row" style="gap:6px;margin:3px 0"><input class="inp grow" data-ci='+i+' data-ti='+ti+' data-k="ticketUrls" value="'+esc(url||'')+'" placeholder="https://dev.azure.com/…/workitems/edit/123"'+(!url?' style="border-color:var(--warn);"':'')+'>'+
              '<button class="btn sm danger" data-act="delTicket" data-ci='+i+' data-ti='+ti+'>✕</button></div>';
          }).join(''))+
          '<button class="btn sm" data-act="addTicket" data-ci='+i+' style="margin-top:4px">+ Add ticket URL</button>'+
          '<div class="field"><label for="cm-verification-'+i+'">Verification evidence link</label><input class="inp" id="cm-verification-'+i+'" data-ci='+i+' data-k="verificationUrl" value="'+esc(c.verificationUrl||'')+'"></div>'+
        '</div>':'')+
      '<div style="margin-top:6px"><div class="hint">Addresses</div>'+(addrRows||'<span class="hint">No threats addressed yet.</span>')+'</div>'+
      (avail?'<div style="margin-top:6px"><div class="hint">Add threat</div><div class="chips">'+avail+'</div></div>':'')+
      '</div>';
  }).join(''):'<span class="hint">No countermeasures yet.</span>';
}
function renderDefects(){
  var severityOrder={critical:0,high:1,medium:2,low:3};
  var statusOptions=['open','triaged','fixed','wont-fix'];
  var severityOptions=['low','medium','high','critical'];
  var compOpts=(system.components||[]).map(function(c){return [c.id,c.name+' ('+c.id+')'];});
  var threatOpts=threats.map(function(t){return [t.id,t.id+' · '+t.title];});
  var ordered=defects.map(function(d,i){return {d:d,i:i};}).sort(function(a,b){
    var ao=a.d.status==='fixed'||a.d.status==='wont-fix'?1:0,bo=b.d.status==='fixed'||b.d.status==='wont-fix'?1:0;
    return ao-bo||(severityOrder[a.d.severity]??9)-(severityOrder[b.d.severity]??9);
  });
  var select=function(key,value,options,i,extra){
    var optionValue=function(o){return Array.isArray(o)?o[0]:o;};
    var optionLabel=function(o){return Array.isArray(o)?o[1]:o;};
    var known=options.some(function(o){return String(optionValue(o))===String(value||'');});
    return '<select class="inp" data-di='+i+' data-k="'+key+'"'+(extra||'')+'>'+
      (key==='component'||key==='threatRef'?'<option value="">-- none --</option>':'')+
      (!known&&value?'<option value="'+esc(value)+'" selected>'+esc(value)+' (existing)</option>':'')+
      options.map(function(o){return '<option value="'+esc(optionValue(o))+'"'+(String(value||'')===String(optionValue(o))?' selected':'')+'>'+esc(optionLabel(o))+'</option>';}).join('')+
      '</select>';
  };
  $('#defects-list').innerHTML='<div class="toolbar"><span class="tag">'+defects.length+' total</span><span class="tag'+(defects.some(function(d){return d.status!=='fixed'&&d.status!=='wont-fix';})?' warnmark':'')+'">'+defects.filter(function(d){return d.status!=='fixed'&&d.status!=='wont-fix';}).length+' open</span></div>'+
    (ordered.length?ordered.map(function(row){
      var d=row.d,i=row.i;
      return '<div class="card" style="margin:10px 0;background:var(--surface-2)" id="defect-'+esc(d.id)+'">'+
        '<div class="grid3">'+
          '<div class="field"><label>ID</label><input class="inp" data-di='+i+' data-k="id" value="'+esc(d.id)+'"></div>'+
          '<div class="field" style="grid-column:span 2"><label>Title</label><input class="inp" data-di='+i+' data-k="title" value="'+esc(d.title||'')+'"></div>'+
        '</div>'+
        '<div class="grid4">'+
          '<div class="field"><label>CVE / advisory</label><input class="inp" data-di='+i+' data-k="cve" value="'+esc(d.cve||'')+'" placeholder="CVE-2024-…"></div>'+
          '<div class="field"><label>Affected component</label>'+select('component',d.component,compOpts,i)+'</div>'+
          '<div class="field"><label>Severity</label>'+select('severity',d.severity||'',severityOptions,i)+'</div>'+
          '<div class="field"><label>Status</label>'+select('status',d.status||'open',statusOptions,i)+'</div>'+
        '</div>'+
        '<div class="grid3">'+
          '<div class="field"><label>Discovered</label><input class="inp" type="date" data-di='+i+' data-k="discovered" value="'+esc(d.discovered||'')+'"></div>'+
          '<div class="field"><label>Fixed in (version)</label><input class="inp" data-di='+i+' data-k="fixedIn" value="'+esc(d.fixedIn||'')+'" placeholder="FW 2.5"></div>'+
          '<div class="field"><label>Re-assess threat</label>'+select('threatRef',d.threatRef,threatOpts,i)+'</div>'+
        '</div>'+
        '<div class="field"><label>Note</label><textarea class="inp" data-di='+i+' data-k="note">'+esc(d.note||'')+'</textarea></div>'+
        '<div style="text-align:right"><button class="btn sm danger" data-act="delDefect" data-i='+i+' aria-label="Delete defect '+esc(d.id)+'">Delete</button></div>'+
      '</div>';
    }).join(''):'<p class="hint">No defects yet.</p>');
}
function renderVersions(){
  var el=$('#versions-body');
  if(!el)return;
  var tracker=changeTracker||{currentVersion:null,entries:[]};
  var entries=tracker.entries||[];
  var current=tracker.currentVersion||null;
  var isFirst=!entries.length;
  var reasons=isFirst?['initial']:['functional changes','new vulnerabilities','regular reassessment'];
  var history=entries.length?entries.map(function(entry){
    return '<div class="itemcard" style="margin:6px 0">'+
      '<div class="row" style="gap:10px"><strong>'+esc(entry.version)+'</strong>'+
      '<span class="badge">'+esc(entry.reason)+'</span></div>'+
      '<div class="hint">'+esc(entry.assessedAt||'')+
      (entry.assessors&&entry.assessors.length?' \u00b7 '+esc(entry.assessors.join(', ')):'')+'</div>'+
      (entry.summary?'<p style="margin:4px 0 0">'+esc(entry.summary)+'</p>':'')+
      '</div>';
  }).join(''):'<p class="hint">No TRA versions yet.</p>';
  el.innerHTML=
    '<div class="itemcard" style="margin-bottom:10px">'+
      '<b>'+(current?'Current: '+esc(current):'No version tagged yet')+'</b>'+
    '</div>'+
    '<div class="itemcard" style="margin-bottom:10px">'+
      '<div class="grid3">'+
        '<div class="field"><label>Reason</label><select class="inp" id="vReason">'+
          reasons.map(function(r){return '<option value="'+esc(r)+'">'+esc(r)+'</option>';}).join('')+
        '</select></div>'+
        '<div class="field"><label>Assessment date</label><input class="inp" id="vDate" type="date" value="'+esc(new Date().toISOString().slice(0,10))+'"></div>'+
        '<div class="field"><label>Assessors (comma-separated)</label><input class="inp" id="vAssessors" placeholder="Jane Doe, John Smith"></div>'+
      '</div>'+
      '<div class="field" style="margin-top:6px"><label>Summary note</label>'+
        '<textarea class="inp" id="vSummary" rows=2 placeholder="Short description of what changed or was assessed."></textarea>'+
      '</div>'+
      '<div style="margin-top:8px"><button class="btn primary" data-act="recordVersion">Record version</button></div>'+
    '</div>'+
    '<div class="itemcard"><h3 style="margin:0 0 8px">History ('+entries.length+')</h3>'+history+'</div>';
}
function renderAssumptions(){
  var tabs=ASM_CATS.map(function(c){return [c[0],c[1],(assumptions[c[0]]||[]).length];});
  $('#asm-tabs').innerHTML=tabs.map(function(t){return '<button class="tab'+(asmTab===t[0]?' active':'')+'" data-asmtab="'+t[0]+'">'+esc(t[1])+' <span class="badge">'+t[2]+'</span></button>';}).join('');
  var html='';
  {
    var key=asmTab, arr=assumptions[key]||[];
    html+=arr.length?arr.map(function(item,i){
      return '<div class="itemcard"><div class="head" style="align-items:flex-start"><span class="idtag">'+esc(item.id||(ASM_PREFIX[key]+(i+1)))+'</span>'+
        '<textarea class="inp grow" rows=2 data-asm="'+key+'" data-ai='+i+' data-k="text" placeholder="Assumption text">'+esc(item.text||'')+'</textarea>'+
        '<select class="inp" style="width:120px" data-asm="'+key+'" data-ai='+i+' data-k="confidence">'+['','low','medium','high'].map(function(c){return '<option value="'+c+'"'+((item.confidence||'')===c?' selected':'')+'>'+(c||'confidence…')+'</option>';}).join('')+'</select>'+
        '<button class="btn sm danger" data-act="delAsm" data-asm="'+key+'" data-i='+i+'>&#10005;</button></div></div>';
    }).join(''):'<p class="hint">No assumptions yet.</p>';
    html+='<button class="btn sm" data-act="addAsm" data-asm="'+key+'">+ Add</button>';
  }
  $('#asm-body').innerHTML=html;
}
function assetSummary(a){
  var o=a.objectives||{};
  return '<span class="badge">'+esc(a.type||'function')+'</span> <span class="badge" title="Confidentiality / Integrity / Availability / Safety">'+
    OBJS.map(function(ob){return ob[1]+esc(o[ob[0]]==null?0:o[ob[0]]);}).join('/')+'</span>';
}
function renderSystem(){
  var tabs=[['components','Components',(system.components||[]).length],['interfaces','Interfaces',(system.interfaces||[]).length],['boundaries','Trust boundaries',(system.trustBoundaries||[]).length],['assets','Assets',(system.assets||[]).length]];
  $('#sys-tabs').innerHTML=tabs.map(function(t){return '<button class="tab'+(sysTab===t[0]?' active':'')+'" data-systab="'+t[0]+'">'+esc(t[1])+' <span class="badge">'+t[2]+'</span></button>';}).join('');
  var cList=system.components||[], html='';
  if(sysTab==='components'){
    html+=cList.length?cList.map(function(c,i){
      var parentSel='<option value="">— none —</option>'+cList.filter(function(x){return x.id!==c.id;}).map(function(x){return '<option value="'+esc(x.id)+'"'+((c.parent||'')===x.id?' selected':'')+'>'+esc(x.name)+' ('+esc(x.id)+')</option>';}).join('');
      return '<div class="itemcard"><div class="head"><span class="idtag">'+esc(c.id||('C-'+(i+1)))+'</span>'+
        '<input class="inp grow" data-comp='+i+' data-k="name" value="'+esc(c.name||'')+'">'+
        '<button class="btn sm danger" data-act="delComp" data-i='+i+'>&#10005;</button></div>'+
        '<div class="grid4">'+
          '<div class="field"><label>Kind</label><select class="inp" data-comp='+i+' data-k="kind">'+optTags(COMP_KINDS,c.kind||'software')+'</select></div>'+
          '<div class="field"><label>Provenance</label><select class="inp" data-comp='+i+' data-k="provenance">'+optTags(PROVENANCE,c.provenance||'own')+'</select></div>'+
          '<div class="field"><label>Layer</label><input class="inp" type="number" min=1 max=6 data-comp='+i+' data-k="layer" value="'+(+c.layer||1)+'"></div>'+
          '<div class="field"><label>Parent</label><select class="inp" data-comp='+i+' data-k="parent">'+parentSel+'</select></div>'+
        '</div>'+
        '<div class="grid2">'+
          '<div class="field"><label for="comp-zone-'+i+'">Trust zone</label><input class="inp" id="comp-zone-'+i+'" data-comp='+i+' data-k="trustZone" value="'+esc(c.trustZone||'')+'"></div>'+
          '<div class="field"><label for="comp-description-'+i+'">Description</label><textarea class="inp" id="comp-description-'+i+'" rows="2" data-comp='+i+' data-k="description">'+esc(c.description||'')+'</textarea></div>'+
        '</div>'+
        '<details style="margin-top:4px"><summary class="hint" style="cursor:pointer;list-style:none;padding:2px 0">&#9654; SBOM metadata</summary>'+
          '<div class="grid4" style="margin-top:6px">'+
            '<div class="field"><label>Version</label><input class="inp" data-comp='+i+' data-k="version" value="'+esc(c.version||'')+'" placeholder="1.2.3"></div>'+
            '<div class="field"><label>Supplier</label><input class="inp" data-comp='+i+' data-k="supplier" value="'+esc(c.supplier||'')+'" placeholder="Vendor name"></div>'+
            '<div class="field"><label>License (SPDX)</label><input class="inp" data-comp='+i+' data-k="license" value="'+esc(c.license||'')+'" placeholder="MIT, GPL-2.0, ..."></div>'+
            '<div class="field"><label>CPE / purl</label><input class="inp" data-comp='+i+' data-k="cpe" value="'+esc(c.cpe||'')+'" placeholder="cpe:2.3:a:… or pkg:..."></div>'+
          '</div></details>'+
        '</div>';
    }).join(''):'<p class="hint">No components yet.</p>';
    html+='<button class="btn sm" data-act="addComp">+ Component</button>';
  } else if(sysTab==='interfaces'){
    var iList=system.interfaces||[];
    html+=iList.length?iList.map(function(f,i){
      return '<div class="itemcard"><div class="head"><span class="idtag">'+esc(f.id||('I-'+(i+1)))+'</span>'+
        '<input class="inp grow" data-if='+i+' data-k="name" value="'+esc(f.name||'')+'">'+
        '<button class="btn sm danger" data-act="delIf" data-i='+i+'>&#10005;</button></div>'+
        '<div class="grid4">'+
          '<div class="field"><label>Component</label><select class="inp" data-if='+i+' data-k="component"><option value="">—</option>'+cList.map(function(c){return '<option value="'+esc(c.id)+'"'+((f.component||'')===c.id?' selected':'')+'>'+esc(c.name)+'</option>';}).join('')+'</select></div>'+
          '<div class="field"><label>Category</label><select class="inp" data-if='+i+' data-k="category">'+optTags(IF_CATS,f.category||'network')+'</select></div>'+
          '<div class="field"><label>Exposure</label><select class="inp" data-if='+i+' data-k="exposure">'+optTags(EXPOSURE,f.exposure||'local')+'</select></div>'+
          '<div class="field"><label>Protocol</label><input class="inp" data-if='+i+' data-k="protocol" value="'+esc(f.protocol||'')+'"></div>'+
          '<div class="field"><label for="iface-tag-'+i+'">Chip tag</label><input class="inp" id="iface-tag-'+i+'" data-if='+i+' data-k="tag" value="'+esc(f.tag||'')+'" placeholder="BLE, HMI, JTAG"></div>'+
          (f.hidden?'<div class="field"><label>DFD visibility</label><label><input type="checkbox" data-if='+i+' data-k="hidden" checked> Hide this interface</label><p class="hint">Untick to unhide this interface in the DFD view.</p></div>':'')+
        '</div></div>';
    }).join(''):'<p class="hint">No interfaces yet.</p>';
    html+='<button class="btn sm" data-act="addIf">+ Interface</button>';
  } else if(sysTab==='boundaries'){
    var bList=system.trustBoundaries||[];
    html+=bList.length?bList.map(function(b,i){
      var mem=cList.length?cList.map(function(c){return chip(c.id,(b.members||[]).indexOf(c.id)>=0,'data-act="tbMem" data-tb='+i+' data-val="'+esc(c.id)+'"',c.name);}).join(''):'<span class="hint">Add components first.</span>';
      return '<div class="itemcard"><div class="head"><span class="idtag">'+esc(b.id||('TB-'+(i+1)))+'</span>'+
        '<input class="inp grow" data-tb='+i+' data-k="name" value="'+esc(b.name||'')+'">'+
        '<button class="btn sm danger" data-act="delTb" data-i='+i+'>&#10005;</button></div>'+
        '<div class="hint">Members</div><div class="chips">'+mem+'</div></div>';
    }).join(''):'<p class="hint">No trust boundaries yet.</p>';
    html+='<button class="btn sm" data-act="addTb">+ Trust boundary</button>';
  } else {
    var aList=system.assets||[];
    html+=aList.length?aList.map(function(a,i){
      var o=a.objectives||{};
      var comp=cList.length?cList.map(function(c){return chip(c.id,(a.components||[]).indexOf(c.id)>=0,'data-act="asComp" data-as='+i+' data-val="'+esc(c.id)+'"',c.name);}).join(''):'<span class="hint">Add components first.</span>';
      var objs=OBJS.map(function(ob){return '<div class="field"><label>'+ob[1]+' · '+ob[0]+'</label><select class="inp" data-as='+i+' data-obj="'+ob[0]+'">'+[0,1,2,3,4,5].map(function(n){return '<option'+((+o[ob[0]]||0)===n?' selected':'')+'>'+n+'</option>';}).join('')+'</select></div>';}).join('');
      return '<div class="itemcard"><div class="head"><span class="idtag">'+esc(a.id||('AST-'+(i+1)))+'</span>'+
        '<input class="inp grow" data-as='+i+' data-k="name" value="'+esc(a.name||'')+'">'+
        '<span id="asset-summary-'+i+'">'+assetSummary(a)+'</span>'+
        '<button class="btn sm danger" data-act="delAs" data-i='+i+'>&#10005;</button></div>'+
        '<div class="grid3"><div class="field"><label>Type</label><select class="inp" data-as='+i+' data-k="type">'+optTags(ASSET_TYPES,a.type||'function')+'</select></div>'+
          '<div class="field" style="grid-column:span 2"><label>Storage</label><input class="inp" data-as='+i+' data-k="storage" value="'+esc(a.storage||'')+'"></div></div>'+
        '<div class="hint" style="margin-top:6px">Components</div><div class="chips">'+comp+'</div>'+
        '<div class="hint" style="margin-top:6px">Security objectives (0–5)</div><div class="objgrid">'+objs+'</div></div>';
    }).join(''):'<p class="hint">No assets yet.</p>';
    html+='<button class="btn sm" data-act="addAs">+ Asset</button>';
  }
  $('#sys-body').innerHTML=html;
}
function renderRequirements(){
  var list=requirements||[];
  var html=list.length?list.map(function(r,i){
    var linkedCm=(r.satisfiedByCM||[]).length>0, realisesCm=!!r.fromCountermeasure||linkedCm;
    var badge=realisesCm?'<span class="badge" data-req-badge="'+i+'" title="Realises a countermeasure that reduces a threat&#39;s risk">Realises CM</span>':
      !(r.derivedFromThreat||[]).length?'<span class="badge" data-req-badge="'+i+'" title="Not derived from a threat or countermeasure">Not derived</span>':'';
    var th=threats.length?threats.map(function(t){return chip(t.id,(r.derivedFromThreat||[]).indexOf(t.id)>=0,'data-act="reqThreat" data-req='+i+' data-val="'+esc(t.id)+'"',t.title);}).join(''):'<span class="hint">No threats yet (step 06).</span>';
    var cc=cms.length?cms.map(function(c){return chip(c.id,(r.satisfiedByCM||[]).indexOf(c.id)>=0,'data-act="reqCm" data-req='+i+' data-val="'+esc(c.id)+'"',c.title);}).join(''):'<span class="hint">No countermeasures yet (step 08).</span>';
    return '<div class="itemcard"><div class="head" style="align-items:flex-start"><span class="idtag">'+esc(r.id||('R'+(i+1)))+'</span>'+
      badge+
      '<textarea class="inp grow" rows=2 data-req='+i+' data-k="text" placeholder="Testable security requirement">'+esc(r.text||'')+'</textarea>'+
      '<button class="btn sm danger" data-act="delReq" data-i='+i+'>&#10005;</button></div>'+
      '<div class="grid2">'+
        '<div class="field"><label>Standard reference</label><input class="inp" data-req='+i+' data-k="standardRef" value="'+esc(r.standardRef||'')+'" placeholder="IEC 62443-4-2 CR 1.2"></div>'+
        '<div class="field"><label>SL / Foundational Requirement</label><input class="inp" data-req='+i+' data-k="slFr" value="'+esc(r.slFr||'')+'" placeholder="FR1 SL2"></div>'+
      '</div>'+
      '<div class="hint" style="margin-top:6px">Derived from threats</div><div class="chips">'+th+'</div>'+
      '<div class="hint" style="margin-top:6px">Satisfied by countermeasures</div><div class="chips">'+cc+'</div>'+
      '<label class="hint"><input type="checkbox" data-req='+i+' data-k="fromCountermeasure"'+(realisesCm?' checked':'')+(linkedCm?' disabled':'')+'> This requirement realises a countermeasure</label></div>';
  }).join(''):'<p class="hint">No requirements yet.</p>';
  $('#req-body').innerHTML=html;
}
function toast(kind,text){var e=$('#'+kind);e.textContent=text;e.style.display='block';var o=$(kind==='err'?'#ok':'#err');o.style.display='none';if(kind==='ok')setTimeout(function(){e.style.display='none';},2500);}

document.addEventListener('click',function(e){
  var matrixCell=e.target.closest('[data-matrix-threats]');
  if(matrixCell){activateMatrixCell(matrixCell);return;}
  var tabEl=e.target.closest('[data-asmtab],[data-systab]');
  if(tabEl){if(tabEl.dataset.asmtab){asmTab=tabEl.dataset.asmtab;renderAssumptions();}else{sysTab=tabEl.dataset.systab;renderSystem();}return;}
  var el=e.target.closest('[data-act],[data-kind],[data-cmd],[data-role]');
  if(!el)return;
  var act=el.dataset.act, kind=el.dataset.kind, cmd=el.dataset.cmd;
  if(act==='undo'){undo();return;}
  if(act==='redo'){redo();return;}
  if(act==='matrixMode'){matrixMode=el.dataset.mode;var mount=el.closest('.risk-matrix');renderMatrices();var button=mount.querySelector('[data-mode="'+matrixMode+'"]');if(button)button.focus();return;}
  if(act==='importThreatCm'){vs.postMessage({cmd:'threatCmImport'});return;}
  if(act==='exportThreatCm'){
    var selectedThreatIds=Array.prototype.filter.call(document.querySelectorAll('[data-export-kind="threat"]:checked'),function(input){return input.checked;}).map(function(input){return input.dataset.exportId;});
    var selectedCmIds=Array.prototype.filter.call(document.querySelectorAll('[data-export-kind="countermeasure"]:checked'),function(input){return input.checked;}).map(function(input){return input.dataset.exportId;});
    vs.postMessage({cmd:'threatCmExport',threatIds:selectedThreatIds,cmIds:selectedCmIds});return;
  }
  if(kind){
    if(kind==='scroll'){var n=document.querySelector(el.dataset.target);if(n)n.scrollIntoView({behavior:'smooth',block:'start'});}
    else if(kind==='cmd'){vs.postMessage({cmd:el.dataset.target});}
    else if(kind==='file'){vs.postMessage({cmd:'openFile',rel:el.dataset.target});}
    return;
  }
  if(cmd){vs.postMessage({cmd:cmd});return;}
  var before=snapshot();
  if(act==='bugBar'){
    var residual=el.dataset.rdim!==undefined,bi=+(residual?el.dataset.ri:el.dataset.i),bj=+el.dataset.rj;
    var target=residual?cms[bi].addresses[bj]:threats[bi],dim=residual?el.dataset.rdim:el.dataset.dim,score=+el.dataset.score;
    var dims=Object.assign({},target.impactDimensions||{});
    if(dims[dim]===score)delete dims[dim];else dims[dim]=score;
    target.impactDimensions=dims;
    var impact=R.deriveImpact(dims)??0;
    target[residual?'residualImpact':'impact']=impact;
    target.ratedAt=new Date().toISOString().slice(0,10);
    if(residual)markResidualRated(bi,bj);
    var input=residual?'[data-c="'+bi+'"][data-j="'+bj+'"][data-k="residualImpact"]':'[data-i="'+bi+'"][data-k="impact"]';
    $(input).value=impact;
    var container=el.closest('.bbselect'),dAttr=residual?'data-ri='+bi+' data-rj='+bj:'data-i='+bi;
    container.innerHTML=bugBarSelector(dims,dAttr,residual?'data-rdim':'data-dim');
    container.querySelector('[data-score="'+score+'"]['+(residual?'data-rdim':'data-dim')+'="'+dim+'"]').focus();
    updatePills();
  }
  else if(act==='addProjectList'){project[el.dataset.list].push('');renderProjectList(el.dataset.list);}
  else if(act==='delProjectList'){project[el.dataset.list].splice(+el.dataset.listIndex,1);renderProjectList(el.dataset.list);}
  else if(act==='addT'){threats.push({id:uid('T',threats.map(function(x){return x.id;})),title:'New threat',stride:['T'],components:[],likelihood:3,impact:3,status:'open'});renderThreats();renderRail();}
  else if(act==='delT'){threats.splice(+el.dataset.i,1);renderThreats();renderRail();}
  else if(act==='addC'){cms.push({id:uid('CM',cms.map(function(x){return x.id;})),title:'New countermeasure',type:'preventive',status:'proposed',addresses:[]});renderCms();renderRail();}
  else if(act==='delC'){cms.splice(+el.dataset.i,1);renderCms();updatePills();renderRail();}
  else if(act==='addDefect'){defects.push({id:uid('D',defects.map(function(x){return x.id;})),title:'New defect',severity:'medium',status:'open',discovered:new Date().toISOString().slice(0,10)});renderDefects();renderRail();}
  else if(act==='delDefect'){defects.splice(+el.dataset.i,1);renderDefects();renderRail();}
  else if(act==='delAddr'){cms[+el.dataset.c].addresses.splice(+el.dataset.j,1);renderCms();updatePills();}
  else if(act==='addAddr'){var sourceThreat=threats.find(function(t){return t.id===el.dataset.val;})||{};cms[+el.dataset.c].addresses.push({threat:el.dataset.val,residualLikelihood:2,residualImpact:2,ratedBy:sourceThreat.ratedBy,ratedAt:sourceThreat.ratedAt});renderCms();updatePills();}
  else if(act==='addTicket'){var cm2=cms[+el.dataset.ci],urls2=ticketRows(cm2).slice();urls2.push('');setTicketRows(cm2,urls2);renderCms();}
  else if(act==='delTicket'){var cm3=cms[+el.dataset.ci],urls3=ticketRows(cm3).slice();urls3.splice(+el.dataset.ti,1);setTicketRows(cm3,urls3);renderCms();}
  else if(act==='addAsm'){var ak=el.dataset.asm;assumptions[ak]=assumptions[ak]||[];assumptions[ak].push({id:uid(ASM_PREFIX[ak],assumptions[ak].map(function(x){return x.id;})),text:''});renderAssumptions();}
  else if(act==='delAsm'){assumptions[el.dataset.asm].splice(+el.dataset.i,1);renderAssumptions();}
  else if(act==='addComp'){system.components=system.components||[];system.components.push({id:uid('C-',system.components.map(function(x){return x.id;})),name:'New component',kind:'software',layer:2,parent:(system.components[0]||{}).id||null});sysTab='components';renderSystem();renderThreats();}
  else if(act==='delComp'){system.components.splice(+el.dataset.i,1);renderSystem();renderThreats();}
  else if(act==='addIf'){system.interfaces=system.interfaces||[];system.interfaces.push({id:uid('I-',system.interfaces.map(function(x){return x.id;})),name:'New interface',exposure:'local',category:'network'});sysTab='interfaces';renderSystem();}
  else if(act==='delIf'){system.interfaces.splice(+el.dataset.i,1);renderSystem();}
  else if(act==='addTb'){system.trustBoundaries=system.trustBoundaries||[];system.trustBoundaries.push({id:uid('TB-',system.trustBoundaries.map(function(x){return x.id;})),name:'New boundary',members:[]});sysTab='boundaries';renderSystem();}
  else if(act==='delTb'){system.trustBoundaries.splice(+el.dataset.i,1);renderSystem();}
  else if(act==='addAs'){system.assets=system.assets||[];system.assets.push({id:uid('AST-',system.assets.map(function(x){return x.id;})),name:'New asset',type:'function',components:[],objectives:{confidentiality:1,integrity:3,availability:3,safety:1}});sysTab='assets';renderSystem();}
  else if(act==='delAs'){system.assets.splice(+el.dataset.i,1);renderSystem();}
  else if(act==='tbMem'){var bb=system.trustBoundaries[+el.dataset.tb];bb.members=bb.members||[];var mk=bb.members.indexOf(el.dataset.val);if(mk>=0)bb.members.splice(mk,1);else bb.members.push(el.dataset.val);renderSystem();}
  else if(act==='asComp'){var aa=system.assets[+el.dataset.as];aa.components=aa.components||[];var ck=aa.components.indexOf(el.dataset.val);if(ck>=0)aa.components.splice(ck,1);else aa.components.push(el.dataset.val);renderSystem();}
  else if(act==='addReq'){requirements=requirements||[];requirements.push({id:uid('R',requirements.map(function(x){return x.id;})),text:'',standardRef:'',slFr:'',derivedFromThreat:[],satisfiedByCM:[]});renderRequirements();}
  else if(act==='delReq'){requirements.splice(+el.dataset.i,1);renderRequirements();}
  else if(act==='reqThreat'){var rq=requirements[+el.dataset.req];rq.derivedFromThreat=rq.derivedFromThreat||[];var rk=rq.derivedFromThreat.indexOf(el.dataset.val);if(rk>=0)rq.derivedFromThreat.splice(rk,1);else rq.derivedFromThreat.push(el.dataset.val);renderRequirements();}
  else if(act==='reqCm'){var rc=requirements[+el.dataset.req];rc.satisfiedByCM=rc.satisfiedByCM||[];var rck=rc.satisfiedByCM.indexOf(el.dataset.val);if(rck>=0)rc.satisfiedByCM.splice(rck,1);else rc.satisfiedByCM.push(el.dataset.val);if(rc.satisfiedByCM.length)rc.fromCountermeasure=true;renderRequirements();}
  else if(act==='recordVersion'){
    var assessors=String(($('#vAssessors')||{}).value||'').split(',').map(function(x){return x.trim();}).filter(Boolean);
    if(!assessors.length){toast('err','Add at least one assessor name.');return;}
    var vReason=($('#vReason')||{}).value||'', vDate=($('#vDate')||{}).value||'', vSummary=($('#vSummary')||{}).value||'';
    vs.postMessage({cmd:'versionRecord',reason:vReason,assessedAt:vDate,assessors:assessors,summary:vSummary});
    return;
  }
  else if(act==='tIface'){
    var tIfIdx=+el.dataset.i,tIfVal=el.dataset.val;
    threats[tIfIdx].interfaceRefs=threats[tIfIdx].interfaceRefs||[];
    var tIfK=threats[tIfIdx].interfaceRefs.indexOf(tIfVal);
    if(tIfK>=0)threats[tIfIdx].interfaceRefs.splice(tIfK,1);else threats[tIfIdx].interfaceRefs.push(tIfVal);
    renderThreats();
  }
  else if(act==='tAsset'){
    var tAsIdx=+el.dataset.i,tAsVal=el.dataset.val;
    threats[tAsIdx].assets=threats[tAsIdx].assets||[];
    var tAsK=threats[tAsIdx].assets.indexOf(tAsVal);
    if(tAsK>=0)threats[tAsIdx].assets.splice(tAsK,1);else threats[tAsIdx].assets.push(tAsVal);
    renderThreats();
  }
  else if(act==='seedExp'){
    var sIdx=+el.dataset.i,sThr=threats[sIdx];
    var sPrimId=(sThr.interfaceRefs&&sThr.interfaceRefs[0]);
    var sItf=(system.interfaces||[]).find(function(f){return f.id===sPrimId;});
    if(sItf){
      var sExp=R.exposureFromInterface(sItf.exposure);
      if(sExp!=null){
        sThr.likelihoodFactors=sThr.likelihoodFactors||{};sThr.likelihoodFactors.exposure=sExp;
        var sLv=R.deriveLikelihood(sThr.likelihoodFactors);
        if(sLv!=null){sThr.likelihood=sLv;}
        renderThreats();
      }
    }
  }
  else if(el.classList.contains('chip')&&el.dataset.role){
    var i=+el.dataset.i,val=el.dataset.val;
    var arrKey=el.dataset.role==='stride'?'stride':(el.dataset.role==='asm'?'assumptionRefs':'components');
    var arr=threats[i][arrKey]||(threats[i][arrKey]=[]);var k=arr.indexOf(val);if(k>=0)arr.splice(k,1);else arr.push(val);
    renderThreats();
  }
  recordChanged(before);
  scheduleAutoSave();
});
document.addEventListener('input',function(e){
  var t=e.target;
  scheduleAutoSave();
  recordBefore(keyOf(t));
  if(t.dataset.projectList){project[t.dataset.projectList][+t.dataset.listIndex]=t.value;return;}
  if(t.id==='p-title'){project.title=t.value;return;}
  if(t.id==='p-intendedUse'){project.intendedUse=t.value;return;}
  if(t.id==='p-status'){project.status=t.value;return;}
  if(t.id==='p-name'){project.name=t.value;$('#devname').textContent=t.value?('· '+t.value):'';return;}
  if(t.id==='p-type'||t.id==='p-version'||t.id==='p-modelReference'){project[t.id.slice(2)]=t.value;return;}
  if(t.id==='p-projectBranchUrl'||t.id==='p-kbUrl'){project[t.id.slice(2)]=t.value;return;}
  if(t.id==='p-sl'){project.sl=t.value;renderThreats();return;}
  if(t.id==='p-risk'){project.riskScoringMethod=t.value;renderThreats();return;}
  if(t.id==='p-mode'){project.mode=t.value;return;}
  if(t.id==='p-bnd'){project.boundary=t.value;return;}
  if(t.id==='p-uc-inc'){project.includeUseCases=!!t.checked;return;}
  if(t.id==='p-sbom-mode'||t.id==='p-sbom-format'||t.id==='p-sbom-url-inp'){project.sbom=readSbom();showSbomFields(project.sbom.mode);return;}
  if(t.dataset.i!==undefined&&t.dataset.cost){
    var i=+t.dataset.i,patch={},cost=t.dataset.cost;
    if(t.dataset.costKey){patch[cost]=Object.assign({},threats[i][cost]);patch[cost][t.dataset.costKey]=cost==='costRationales'?t.value:+t.value;}
    else patch[cost]=+t.value;
    threats[i]=window.ThreatModel.applyUpdate(threats[i],patch,project,selectedAttacker());
    $('#cost-summary-'+i).innerHTML=costSummary(threats[i]);
    $('[data-i="'+i+'"][data-k="likelihood"]').value=threats[i].likelihood;
    var status=$('[data-i="'+i+'"][data-k="status"]'),badge=status.closest('td').querySelector('.badge');
    status.value=threats[i].status||'open';badge.className='badge st-'+status.value;badge.textContent=statusLabel(status.value);
    updatePills();return;
  }
  if(t.dataset.i!==undefined&&t.dataset.k){var i=+t.dataset.i,k=t.dataset.k;
    if(k==='likelihood'||k==='impact'){var min=k==='likelihood'?0:1;threats[i][k]=Math.max(min,Math.min(5,+t.value||min));var el=document.getElementById('tp-'+i);if(el)el.innerHTML=riskCell(threats[i]);var warning=$('#cost-summary-'+i+' [data-cost-warning]');if(warning)warning.textContent=costWarning(threats[i],+warning.dataset.proposal);}
    else if(k==='status'){threats[i].status=t.value;var cell=t.closest('td');var bd=cell&&cell.querySelector('.badge');if(bd){bd.className='badge st-'+t.value;bd.textContent=statusLabel(t.value);}}
    else threats[i][k]=t.value;renderMatrices();return;}
  if(t.dataset.ci!==undefined&&t.dataset.k){
    if(t.dataset.k==='ticketUrls'&&t.dataset.ti!==undefined){
      var cmi=cms[+t.dataset.ci];
      var urls=ticketRows(cmi).slice();urls[+t.dataset.ti]=t.value;setTicketRows(cmi,urls);
    } else if(t.dataset.k==='negativeEffects'){cms[+t.dataset.ci].negativeEffects=t.value===''?[]:t.value.split('\\n');}
    else {cms[+t.dataset.ci][t.dataset.k]=t.value; if(t.dataset.k==='status')renderCms();}
    return;
  }
  if(t.dataset.di!==undefined&&t.dataset.k){
    var di=+t.dataset.di,dk=t.dataset.k;
    if(defects[di]){defects[di][dk]=t.value||((dk==='component'||dk==='threatRef')?undefined:t.value);if(dk==='status'||dk==='severity')renderDefects();}
    return;
  }
  if(t.dataset.c!==undefined&&t.dataset.j!==undefined&&t.dataset.k){var ci=+t.dataset.c,cj=+t.dataset.j;if(t.dataset.k==='ratedBy'){cms[ci].addresses[cj].ratedBy=t.value;markResidualRated(ci,cj);}else{var residualValue=t.value===''?1:+t.value;cms[ci].addresses[cj][t.dataset.k]=Math.max(0,Math.min(5,residualValue||0));updatePills();}return;}
  if(t.dataset.asm!==undefined&&t.dataset.ai!==undefined&&t.dataset.k){var arr=assumptions[t.dataset.asm];if(arr&&arr[+t.dataset.ai])arr[+t.dataset.ai][t.dataset.k]=t.value;return;}
  if(t.dataset.comp!==undefined&&t.dataset.k){var c=system.components[+t.dataset.comp];if(c)c[t.dataset.k]=(t.dataset.k==='layer')?(+t.value||1):(t.dataset.k==='parent'?(t.value||null):t.value);return;}
  if(t.dataset.if!==undefined&&t.dataset.k){var f=system.interfaces[+t.dataset.if];if(f){f[t.dataset.k]=t.dataset.k==='hidden'?t.checked:t.value;if(t.dataset.k==='hidden')renderSystem();}return;}
  if(t.dataset.tb!==undefined&&t.dataset.k){var b=system.trustBoundaries[+t.dataset.tb];if(b)b[t.dataset.k]=t.value;return;}
  if(t.dataset.as!==undefined){var a=system.assets[+t.dataset.as];if(!a)return;if(t.dataset.obj){a.objectives=a.objectives||{};a.objectives[t.dataset.obj]=Math.max(0,Math.min(5,+t.value||0));}else if(t.dataset.k){a[t.dataset.k]=t.value;}$('#asset-summary-'+t.dataset.as).innerHTML=assetSummary(a);return;}
  if(t.dataset.req!==undefined&&t.dataset.k){var rr=requirements[+t.dataset.req];if(rr){rr[t.dataset.k]=t.dataset.k==='fromCountermeasure'?t.checked:t.value;if(t.dataset.k==='fromCountermeasure')renderRequirements();}return;}
  // Likelihood factor (threat)
  if(t.dataset.fac!==undefined&&t.dataset.i!==undefined){
    var tIdx=+t.dataset.i,fk=t.dataset.fac;
    threats[tIdx].likelihoodFactors=threats[tIdx].likelihoodFactors||{};
    if(t.value!=='')threats[tIdx].likelihoodFactors[fk]=+t.value;else delete threats[tIdx].likelihoodFactors[fk];
    var lv=R.deriveLikelihood(threats[tIdx].likelihoodFactors);
    if(lv!=null){threats[tIdx].likelihood=lv;var lInp=document.querySelector('[data-i="'+tIdx+'"][data-k="likelihood"]');if(lInp)lInp.value=lv;var lEl=document.getElementById('tp-'+tIdx);if(lEl)lEl.innerHTML=riskCell(threats[tIdx]);}
    renderMatrices();
    return;
  }
  // CVSS field (threat)
  if(t.dataset.cvss!==undefined&&t.dataset.i!==undefined){
    var tIdx=+t.dataset.i,ck=t.dataset.cvss;
    threats[tIdx].cvss=threats[tIdx].cvss||{};
    if(ck==='baseScore')threats[tIdx].cvss.baseScore=t.value===''?undefined:+t.value;
    else threats[tIdx].cvss[ck]=t.value||undefined;
    if(ck==='vector'&&t.value){
      var cbs=R.cvssBaseScore(t.value);
      if(cbs!=null){threats[tIdx].cvss.baseScore=cbs;var bsInp=document.querySelector('[data-cvss="baseScore"][data-i="'+tIdx+'"]');if(bsInp){bsInp.value=cbs;bsInp.setAttribute('readonly','');}}
      var cexp=R.cvssExploitability(t.value);
      if(cexp!=null){threats[tIdx].likelihoodFactors=threats[tIdx].likelihoodFactors||{};threats[tIdx].likelihoodFactors.exploitability=cexp;var clv=R.deriveLikelihood(threats[tIdx].likelihoodFactors);if(clv!=null){threats[tIdx].likelihood=clv;var clInp=document.querySelector('[data-i="'+tIdx+'"][data-k="likelihood"]');if(clInp)clInp.value=clv;var clEl=document.getElementById('tp-'+tIdx);if(clEl)clEl.innerHTML=riskCell(threats[tIdx]);}}
    }
    renderMatrices();
    return;
  }
  // Residual likelihood factor (CM address)
  if(t.dataset.rfac!==undefined&&t.dataset.ri!==undefined&&t.dataset.rj!==undefined){
    var ri=+t.dataset.ri,rj=+t.dataset.rj,rfk=t.dataset.rfac;
    if(!cms[ri]||!cms[ri].addresses[rj])return;
    markResidualRated(ri,rj);
    cms[ri].addresses[rj].likelihoodFactors=cms[ri].addresses[rj].likelihoodFactors||{};
    if(t.value!=='')cms[ri].addresses[rj].likelihoodFactors[rfk]=+t.value;else delete cms[ri].addresses[rj].likelihoodFactors[rfk];
    var rlv=R.deriveLikelihood(cms[ri].addresses[rj].likelihoodFactors);
    if(rlv!=null){cms[ri].addresses[rj].residualLikelihood=rlv;var rlInp=document.querySelector('[data-ri="'+ri+'"][data-rj="'+rj+'"][data-k="residualLikelihood"]');if(rlInp)rlInp.value=rlv;updatePills();}
    return;
  }
  // Residual CVSS field (CM address)
  if(t.dataset.rcvss!==undefined&&t.dataset.ri!==undefined&&t.dataset.rj!==undefined){
    var ri=+t.dataset.ri,rj=+t.dataset.rj,rck=t.dataset.rcvss;
    if(!cms[ri]||!cms[ri].addresses[rj])return;
    cms[ri].addresses[rj].cvss=cms[ri].addresses[rj].cvss||{};
    if(rck==='baseScore')cms[ri].addresses[rj].cvss.baseScore=t.value===''?undefined:+t.value;
    else cms[ri].addresses[rj].cvss[rck]=t.value||undefined;
    if(rck==='vector'&&t.value){
      var rcbs=R.cvssBaseScore(t.value);
      if(rcbs!=null){cms[ri].addresses[rj].cvss.baseScore=rcbs;var rbsInp=document.querySelector('[data-rcvss="baseScore"][data-ri="'+ri+'"][data-rj="'+rj+'"]');if(rbsInp){rbsInp.value=rcbs;rbsInp.setAttribute('readonly','');}}
      var rcexp=R.cvssExploitability(t.value);
      if(rcexp!=null){cms[ri].addresses[rj].likelihoodFactors=cms[ri].addresses[rj].likelihoodFactors||{};cms[ri].addresses[rj].likelihoodFactors.exploitability=rcexp;var rclv=R.deriveLikelihood(cms[ri].addresses[rj].likelihoodFactors);if(rclv!=null){cms[ri].addresses[rj].residualLikelihood=rclv;var rclInp=document.querySelector('[data-ri="'+ri+'"][data-rj="'+rj+'"][data-k="residualLikelihood"]');if(rclInp)rclInp.value=rclv;updatePills();}}
    }
    return;
  }
});

window.addEventListener('message',function(ev){
  var m=ev.data;
  if(m.cmd==='init'){bugBar=m.bugBar||null;riskScheme=m.scheme||null;}
  if(m.cmd==='init'){threats=m.data.threats||[];cms=m.data.cms||[];defects=m.data.defects||[];comps=m.data.comps||[];counts=m.data.counts||{};changeTracker=m.data.changeTracker||changeTracker;assumptions=m.data.assumptions||assumptions;system=m.data.system||system;requirements=m.data.requirements||[];try{renderProject(m.data.project);}catch(e){console.error('project',e);}try{renderRail();}catch(e){console.error('rail',e);}try{renderThreats();}catch(e){console.error('threats',e);}try{renderCms();}catch(e){console.error('cms',e);}try{renderDefects();}catch(e){console.error('defects',e);}try{renderAssumptions();}catch(e){console.error('assumptions',e);}try{renderSystem();}catch(e){console.error('system',e);}try{renderRequirements();}catch(e){console.error('requirements',e);}try{renderVersions();}catch(e){console.error('versions',e);}clearHistory();if(m.focusThreatId)navigateThreat(m.focusThreatId);}
  else if(m.cmd==='threats'){threats=m.threats||[];counts=m.counts||counts;renderThreats();renderCms();renderRequirements();renderRail();toast('ok',m.text);}
  else if(m.cmd==='cms'){cms=m.cms||[];counts=m.counts||counts;renderCms();updatePills();renderRequirements();renderRail();toast('ok',m.text);}
  else if(m.cmd==='assumptions'){assumptions=m.assumptions||assumptions;counts=m.counts||counts;renderAssumptions();renderRail();toast('ok',m.text);}
  else if(m.cmd==='system'){system=m.system||system;comps=m.comps||comps;counts=m.counts||counts;renderSystem();renderThreats();renderRail();toast('ok',m.text);}
  else if(m.cmd==='requirements'){requirements=m.requirements||requirements;counts=m.counts||counts;renderRequirements();renderRail();toast('ok',m.text);}
  else if(m.cmd==='msg'){counts=m.counts||counts;renderRail();toast('ok',m.text);}
  else if(m.cmd==='saved'){counts=m.counts||counts;renderRail();var st=$('#savingStatus');if(st){st.textContent='Saved';st.style.color='#4caf50';setTimeout(function(){if(st&&st.textContent==='Saved')st.textContent='';},2500);}}
  else if(m.cmd==='threatCmIo'){toast(m.ok?'ok':'err',m.text||'Import/export finished.');}
  else if(m.cmd==='threatCmImported'){
    threats=threats.concat(m.threats||[]);cms=cms.concat(m.cms||[]);
    counts.threats=threats.length;counts.countermeasures=cms.length;
    renderThreats();renderCms();updatePills();renderRail();toast('ok',m.text||'Imported threats and countermeasures.');
  }
  else if(m.cmd==='versionResult'){if(!m.ok)toast('err',m.error||'Could not record version.');else{changeTracker=m.tracker||changeTracker;counts=m.counts||counts;try{renderVersions();}catch(e){}renderRail();toast('ok',m.text);}}
  else if(m.cmd==='err'){toast('err',m.text);}
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    var dialog=document.querySelector('.matrix-threat-overlay');if(dialog){var close=dialog.querySelector('[aria-label="Close threat chooser"]');if(close)close.click();e.preventDefault();return;}
  }
  if(e.key==='Enter'||e.key===' '){
    var cell=e.target.closest&&e.target.closest('[data-matrix-threats]');
    if(cell){e.preventDefault();activateMatrixCell(cell);return;}
  }
  if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
  var k=e.key.toLowerCase();
  if(k==='z'&&!e.shiftKey){e.preventDefault();undo();}
  else if(k==='y'||(k==='z'&&e.shiftKey)){e.preventDefault();redo();}
});
vs.postMessage({cmd:'ready'});
})();
</script></body></html>`;
}
