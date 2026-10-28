#!/usr/bin/env node
// TRA report generator: zero external dependencies. Loads a TRA project folder,
// computes initial and residual risk, runs the plausibility checker, and writes report/index.html.
// Usage: node tools/generate-report.mjs <project-dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTraProject = (dir) => existsSync(join(dir, "01-project-description/project.json"));

function resolveProjectPath() {
  const fromArg = process.argv[2] || process.env.EMBEDRISK_PROJECT_DIR;
  if (fromArg) {
    const full = fromArg.startsWith("/") ? fromArg : join(root, fromArg);
    if (!hasTraProject(full)) throw new Error(`TRA project not found at: ${full}`);
    return { display: fromArg, base: full };
  }

  for (const searchRoot of [join(root, "projects"), join(root, "webapp/projects")]) {
    if (!existsSync(searchRoot)) continue;
    for (const entry of readdirSync(searchRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(searchRoot, entry.name);
      if (hasTraProject(full)) return { display: full.replace(`${root}/`, ""), base: full };
    }
  }

  throw new Error("No TRA project found. Pass a project path as argv[2] or EMBEDRISK_PROJECT_DIR.");
}

const { display: proj, base } = resolveProjectPath();
const read = (p) => JSON.parse(readFileSync(join(base, p), "utf8"));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ID_PATTERN = /^[A-Za-z0-9 _\-:.]+$/;
const assumptionAnchor = (id) => `assumption-${String(id ?? '').replace(/[^A-Za-z0-9_.:-]/g, '-')}`;
const scheme = JSON.parse(readFileSync(join(root, ".assets/knowledge-base/risk-scheme.json"), "utf8"));

const project = read("01-project-description/project.json");
// Webapp-created projects have no `steps` map (or a partial one): default to canonical step paths
// (mirrors STEP_FILES in webapp/server/src/artifacts.js).
const DEFAULT_STEPS = {
  "02-assumptions": "02-assumptions/assumptions.json",
  "03-system-assets": "03-system-assets/system.json",
  "04b-use-cases": "04b-use-cases/use-cases.json",
  "05-requirements": "05-requirements/requirements.json",
  "06-threats": "06-threats/threats.json",
  "08-countermeasures": "08-countermeasures/countermeasures.json",
};
project.steps = { ...DEFAULT_STEPS, ...(project.steps && typeof project.steps === "object" ? project.steps : {}) };
const ass = read(project.steps["02-assumptions"]);
const sys = read(project.steps["03-system-assets"]);
const threats = read(project.steps["06-threats"]).threats;
const cms = read(project.steps["08-countermeasures"]).countermeasures;
let useCases = { diagrams: [] };
try { useCases = read(project.steps["04b-use-cases"] || "04b-use-cases/use-cases.json"); } catch { }

// Mirrors webapp/client/src/lib/risk.ts: score <= 0 is its own "None" band, unfeasible threats carry
// no initial or residual risk, and deselected countermeasures (selected === false) do not reduce
// residual risk. (webapp/server/src/risk.js computeRisk only zeroes residual risk for unfeasible threats.)
const NONE_BAND = { name: 'None', min: 0, max: 0, color: '#6b7280' };
const UNFEASIBLE_CELL = `<b style="color:${NONE_BAND.color}">n/a (unfeasible)</b>`;
const band = (r) => (r <= 0 ? NONE_BAND : scheme.matrix.bands.find((b) => r >= b.min && r <= b.max) || scheme.matrix.bands[0]);
const initialRisk = (t) => (t.status === 'unfeasible' ? 0 : (t.likelihood || 0) * (t.impact || 0));
const residual = (t) => {
  if (t.status === 'unfeasible') return { l: 0, i: 0 };
  const links = cms.filter((c) => c.selected !== false).flatMap((c) => (c.addresses || []).filter((a) => a.threat === t.id));
  let l = t.likelihood, i = t.impact;
  for (const a of links) {
    l = Math.min(l, a.residualLikelihood ?? t.likelihood);
    i = Math.min(i, a.residualImpact ?? t.impact);
  }
  return { l, i };
};

// Plausibility checker (PR/NFR review step)
const ids = new Set(sys.components.map((c) => c.id));
const tids = new Set(threats.map((t) => t.id));
const assumptionRows = [
  ...(ass.device || []).map((a) => ({ id: a.id, text: a.text || '', source: 'Device' })),
  ...(ass.system || []).map((a) => ({ id: a.id, text: a.text || '', source: 'System' })),
  ...(ass.environment || []).map((a) => ({ id: a.id, text: a.text || '', source: 'Environment' })),
  ...(ass.operational || []).map((a) => ({ id: a.id, text: a.text || '', source: 'Operational' })),
  ...(ass.attacker || []).map((a) => ({ id: a.id, text: a.text || a.name || '', source: 'Attacker' })),
];
const assumptionIds = new Set(assumptionRows.map((a) => a.id).filter(Boolean));
const assumptionById = new Map(assumptionRows.map((a) => [a.id, a]));
const assumptionCitedBy = new Map();
const issues = [];
if (!ass.attacker?.length) issues.push("No attacker assumptions (required for likelihood).");
threats.forEach((t) => {
  if (!t.likelihood || !t.impact) issues.push(`${t.id}: missing risk rating.`);
  if (!t.components?.length) issues.push(`${t.id}: orphaned threat (no component).`);
  t.components?.forEach((c) => { if (!ids.has(c)) issues.push(`${t.id}: references unknown component ${c}.`); });
  (t.assumptionRefs || []).forEach((aid) => {
    if (!ID_PATTERN.test(aid)) issues.push(`${t.id}: references invalid assumption ID ${aid}.`);
    else if (!assumptionIds.has(aid)) issues.push(`${t.id}: references unknown assumption ${aid}.`);
    const refs = assumptionCitedBy.get(aid) || [];
    refs.push(t.id);
    assumptionCitedBy.set(aid, refs);
  });
});
cms.forEach((c) => (c.addresses || []).forEach((a) => { if (!tids.has(a.threat)) issues.push(`${c.id}: addresses unknown threat ${a.threat}.`); }));

const rows = threats.map((t) => {
  const r = initialRisk(t), rr = residual(t), rrv = (rr.l || 0) * (rr.i || 0);
  const unfeasible = t.status === 'unfeasible';
  const refs = (t.assumptionRefs || []).map((aid) => {
    if (!ID_PATTERN.test(aid)) return `<span>${esc(aid)}</span> (invalid ID)`;
    const a = assumptionById.get(aid);
    if (!a) return `<span>${esc(aid)}</span> (missing)`;
    return `<a href="#${esc(assumptionAnchor(aid))}">${esc(aid)}</a> (${esc(a.source)})`;
  }).join(', ');
  const rationale = [t.likelihoodRationale ? `L: ${esc(t.likelihoodRationale)}` : '', t.impactRationale ? `I: ${esc(t.impactRationale)}` : ''].filter(Boolean).join('<br>');
  const classification = [
    `<b>Classification:</b> ${esc(t.classification || '—')}`,
    `<b>Responsibility:</b> ${esc(t.responsibility || '—')}`,
    t.deploymentConstraints ? `<b>Deployment constraints:</b> ${esc(t.deploymentConstraints)}` : '',
  ].filter(Boolean).join('<br>');
  return `<tr id="threat-${esc(t.id)}"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc((t.stride || []).join(""))}</td><td>${refs || '—'}</td><td>${rationale || '—'}</td><td>${classification}</td><td>${unfeasible ? UNFEASIBLE_CELL : `${t.likelihood}x${t.impact}=<b style="color:${band(r).color}">${r} ${band(r).name}</b>`}</td><td>${unfeasible ? UNFEASIBLE_CELL : `${rr.l}x${rr.i}=<b style="color:${band(rrv).color}">${rrv} ${band(rrv).name}</b>`}</td><td>${esc(t.status || '')}</td></tr>`;
}).join("");

const ucRows = (useCases.diagrams || []).map((d) =>
  `<li><b>${d.name || d.id}</b> (${(d.entities || []).length} entities, ${(d.connections || []).length} connections)</li>`
).join("");
const assRows = ['device', 'system', 'environment', 'operational'].map((k) => {
  const items = ass[k] || [];
  if (!items.length) return '';
  return `<h3>${k[0].toUpperCase() + k.slice(1)} assumptions</h3><ul>${items.map((a) => {
    const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => `<a href="#threat-${esc(tid)}">${esc(tid)}</a>`).join(', ');
    return `<li id="${esc(assumptionAnchor(a.id))}"><b>${esc(a.id)}</b> — ${esc(a.text || '')}${cited ? `<br><span style="font-size:11px;color:#555">cited by: ${cited}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}).join('');
const atkRows = (ass.attacker || []).map((a) => {
  const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => `<a href="#threat-${esc(tid)}">${esc(tid)}</a>`).join(', ');
  return `<li id="${esc(assumptionAnchor(a.id))}"><b>${esc(a.id)}</b> · <b>${esc(a.name)}</b> cap ${a.capability}, ${esc(a.access)}: ${esc(a.text || '')}${cited ? `<br><span style="font-size:11px;color:#555">cited by: ${cited}</span>` : ''}</li>`;
}).join('');

const html = `<!doctype html><meta charset=utf8><title>TRA ${project.title}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}h1{font-size:1.4rem}.warn{color:#c62828}</style>
<h1>${project.title}</h1><p>Device: ${project.device.name} (${project.device.type}) | SL-C ${project.slTarget} | mode ${project.scope.mode} | status ${project.status}</p>
<h2>Attacker profiles</h2><ul>${atkRows}</ul>
${assRows ? `<h2>Assumptions</h2>${assRows}` : ''}
<h2>Assets</h2><ul>${sys.assets.map((a) => `<li>${a.name} (C${a.objectives.confidentiality}/I${a.objectives.integrity}/A${a.objectives.availability}/S${a.objectives.safety})</li>`).join("")}</ul>
<h2>Threats & risk</h2><table><tr><th>ID</th><th>Threat</th><th>STRIDE</th><th>Assumptions</th><th>Rationale</th><th>Classification</th><th>Initial</th><th>Residual</th><th>Status</th></tr>${rows}</table>
${project.reportOptions?.includeUseCases ? `<h2>Use-case diagrams</h2>${ucRows ? `<ul>${ucRows}</ul>` : '<p>No use-case diagrams defined.</p>'}` : ''}
<h2>Plausibility check</h2>${issues.length ? `<ul class=warn>${issues.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>No issues found.</p>"}`;

mkdirSync(join(base, "report"), { recursive: true });
writeFileSync(join(base, "report/index.html"), html);
console.log(`Report written to ${join(proj, "report/index.html")}; ${issues.length} plausibility issue(s).`);
