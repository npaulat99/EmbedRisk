#!/usr/bin/env node
// TRA report generator: zero external dependencies. Loads a TRA project folder,
// computes initial and residual risk, runs the plausibility checker, and writes report/index.html.
// Usage: node tools/generate-report.mjs <project-dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeScheme, fingerprint } from "../webapp/shared/riskScheme.js";
import "../webapp/shared/riskEngine.js";

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
const RiskEngine = globalThis.RiskEngine;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const contrastTextColor = (background) => {
  const match = /^#?([\da-f]{6})$/i.exec(String(background || ''));
  if (!match) return '#1d2430';
  const channels = [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16) / 255);
  const luminance = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (value) => (Math.max(luminance, value) + 0.05) / (Math.min(luminance, value) + 0.05);
  return contrast(1) >= contrast(0.018) ? '#fff' : '#1d2430';
};
const safeHref = (value) => {
  const href = String(value ?? '').trim();
  if (!href || href.startsWith('/') || href.includes('\\') || /[\u0000-\u0020\u007f]/.test(href)) return null;
  let parsed;
  try { parsed = new URL(href, 'https://embedrisk.invalid/'); } catch { return null; }
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href)) return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && /^https?:\/\//i.test(href) ? href : null;
  if (parsed.origin !== 'https://embedrisk.invalid') return null;
  const path = href.split(/[?#]/, 1)[0];
  try {
    const decodedPath = decodeURIComponent(path);
    if (decodedPath.startsWith('/') || decodedPath.includes('\\') || decodedPath.split('/').some((part) => part === '..')) return null;
  } catch { return null; }
  return href;
};
const renderLink = (value, label) => {
  const href = safeHref(value);
  if (!href) return esc(label);
  const external = /^https?:\/\//i.test(href);
  return `<a href="${esc(href)}"${external ? ' target="_blank"' : ''} rel="noopener noreferrer">${esc(label)}</a>`;
};
const capLabel = (v) => (typeof v === 'number' && v >= 1 ? `capability ${Math.min(4, v)} · Threat actor ${Math.min(4, v)}` : `capability ${v ?? '—'}`);
const ID_PATTERN = /^[A-Za-z0-9 _\-:.]+$/;
const assumptionAnchor = (id) => `assumption-${String(id ?? '').replace(/[^A-Za-z0-9_.:-]/g, '-')}`;
const project = read("01-project-description/project.json");
const BUILTIN_SCHEME_FILES = {
  "builtin:5x5-exposure": "risk-scheme-5x5-exposure.json",
  "builtin:5x5-cost": "risk-scheme-5x5-cost.json",
};
function resolveScheme(project) {
  const requestedId = project.riskSchemeId || ({ "exposure-exploitability-impact": "builtin:5x5-exposure", "cost-based": "builtin:5x5-cost" }[project.riskScoringMethod] || "builtin:5x5-cost");
  const schemes = new Map();
  const errors = [];
  for (const [id, file] of Object.entries(BUILTIN_SCHEME_FILES)) {
    try {
      const scheme = normalizeScheme(readFileSync(join(root, "webapp/.assets/knowledge-base", file), "utf8"));
      if (scheme.id !== id) throw new Error(`expected built-in ID '${id}'`);
      schemes.set(id, scheme);
    } catch (error) { errors.push(String(error.message || error)); }
  }
  const localDirectory = process.env.EMBEDRISK_RISK_SCHEME_DIRECTORY || join(root, "webapp/.local/risk-schemes");
  try {
    for (const entry of readdirSync(localDirectory, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith(".json"))) {
      try {
        const scheme = normalizeScheme(readFileSync(join(localDirectory, entry.name), "utf8"), { local: true });
        if (schemes.has(scheme.id)) throw new Error(`duplicate scheme ID '${scheme.id}'`);
        schemes.set(scheme.id, scheme);
      } catch (error) { errors.push(`${entry.name}: ${String(error.message || error)}`); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push(String(error.message || error)); }
  const scheme = schemes.get(requestedId);
  if (!scheme) return { id: requestedId, scheme: null, fingerprint: null, warning: `Risk scheme '${requestedId}' is unavailable. ${errors.join("; ")}`.trim() };
  const activeFingerprint = fingerprint(scheme);
  if (project.riskSchemeFingerprint && project.riskSchemeFingerprint !== activeFingerprint)
    return { id: requestedId, scheme: null, fingerprint: activeFingerprint, warning: `Risk scheme '${requestedId}' has changed; classification is unavailable until reviewed.` };
  return { id: requestedId, scheme, fingerprint: activeFingerprint, warning: null };
}
const schemeResolution = resolveScheme(project);
const scheme = schemeResolution.scheme;
const riskEngine = scheme ? RiskEngine.createRiskEngine(scheme, project) : null;
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
let reqs = [];
try { reqs = read(project.steps["05-requirements"]).requirements || []; } catch { }
let useCases = { diagrams: [] };
try { useCases = read(project.steps["04b-use-cases"] || "04b-use-cases/use-cases.json"); } catch { }

// Mirrors webapp/client/src/lib/risk.ts: score <= 0 is its own "None" band, unfeasible threats carry
// no initial or residual risk, and deselected countermeasures (selected === false) do not reduce
// residual risk. (webapp/server/src/risk.js computeRisk only zeroes residual risk for unfeasible threats.)
const NONE_BAND = { name: 'None', min: 0, max: 0, color: '#6b7280' };
const UNFEASIBLE_CELL = `<b style="color:${NONE_BAND.color}">n/a (unfeasible)</b>`;
const AVOIDED_CELL = `<b style="color:${NONE_BAND.color}">n/a (avoided)</b>`;
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
const riskOf = (threat) => riskEngine ? riskEngine.riskOf(threat, cms) : null;
const withinAcceptanceCriteria = (threat, risk = riskOf(threat)) => {
  if (!riskEngine || !risk || risk.residual <= 0) return false;
  const level = riskEngine.classify(risk.residualLikelihood, risk.residualImpact);
  if (level.treatment === 'auto-accept') return true;
  const acceptableLevel = project.acceptableLevel || scheme.acceptance?.defaultLevel;
  const acceptableRank = acceptableLevel ? scheme.classification.levels.find((item) => item.id === acceptableLevel)?.rank : null;
  return Number.isInteger(acceptableRank)
    ? level.rank <= acceptableRank
    : level.score <= (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12);
};
const axisRisk = (risk, axes, stored) => {
  if (!risk) return `L${stored.likelihood ?? '—'} / I${stored.impact ?? '—'} (unavailable)`;
  if (risk.initial <= 0 && axes === 'initial') return 'n/a (unfeasible)';
  if (risk[axes] <= 0) return 'None';
  const band = risk[axes === 'initial' ? 'initialBand' : 'residualBand'];
  return scheme.classification.kind === 'lookup' ? band.label || band.name : `${risk[axes]} ${band.label || band.name}`;
};
const riskSchemeSection = (() => {
  if (!riskEngine) return `<h2>Risk scheme</h2><div class="warn"><b>Risk classification unavailable:</b> ${esc(schemeResolution.warning)} Raw stored L/I values are shown.</div>${riskCriteriaHtml(project.riskCriteria)}`;
  const likelihoods = riskEngine.likelihoodLevels();
  const impacts = riskEngine.impactLevels().slice().reverse();
  const cells = riskEngine.matrixCells();
  const rows = impacts.map((impact) => `<tr><th>${esc(impact.code)} · ${esc(impact.label)}</th>${likelihoods.map((likelihood) => {
    const cell = cells.find((item) => item.likelihood === likelihood.value && item.impact === impact.value);
    const level = riskEngine.classify(likelihood.value, impact.value);
    const label = scheme.classification.kind === 'lookup' ? level.label : cell.score;
    return `<td style="background:${esc(level.color)};color:${contrastTextColor(level.color)}" title="${esc(likelihood.code)} × ${esc(impact.code)} · ${esc(level.label)}">${esc(label)}</td>`;
  }).join('')}</tr>`).join('');
  const legend = scheme.classification.levels.map((level) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><i style="display:inline-block;width:10px;height:10px;background:${esc(level.color)}"></i>${esc(level.label)}</span>`).join('');
  return `<h2>Risk scheme</h2><p><b>${esc(scheme.title)}</b> · v${esc(scheme.version)} · fingerprint <code>${schemeResolution.fingerprint}</code></p><div>${legend}</div><table><caption>Active risk matrix</caption><thead><tr><th scope="col">Impact / Likelihood</th>${likelihoods.map((level) => `<th scope="col">${esc(level.code)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>${riskCriteriaHtml(project.riskCriteria)}`;
})();

function riskCriteriaHtml(criteria) {
  if (!criteria) return '';
  const inputs = [['Regulation', criteria.inputs?.regulation], ['Contracts', criteria.inputs?.contracts], ['Nature of risk', criteria.inputs?.riskNature], ['Users', criteria.inputs?.users], ['Product type', criteria.inputs?.productType], ['State of the art', criteria.inputs?.stateOfTheArt]].filter(([, value]) => value);
  if (!criteria.schemeJustification && !criteria.schemeSource && !inputs.length) return '';
  return `<h3>Scheme selection and criteria</h3>${criteria.schemeJustification ? `<p><b>Justification:</b> ${esc(criteria.schemeJustification)}</p>` : ''}${criteria.schemeSource ? `<p><b>Source:</b> ${esc(criteria.schemeSource)}</p>` : ''}${inputs.length ? `<ul>${inputs.map(([label, value]) => `<li><b>${esc(label)}:</b> ${esc(value)}</li>`).join('')}</ul>` : ''}`;
}

const productContextSection = (() => {
  const context = project.productContext || {}, functions = context.functions || [], users = context.users || {}, evidence = context.evidence || [], environment = ass.environment || [];
  if (!functions.length && !users.description && !users.vulnerableGroups?.length && !evidence.length && !environment.length) return '';
  const functionRows = functions.length ? `<ul>${functions.map((item) => `<li><b>${esc(item.name)}</b>${item.description ? ` — ${esc(item.description)}` : ''}</li>`).join('')}</ul>` : '<p>—</p>';
  const environmentRows = environment.length ? `<ul>${environment.map((item) => `<li>${renderLink(`#${assumptionAnchor(item.id)}`, item.id)} — ${esc(item.text || '')}</li>`).join('')}</ul>` : '<p>—</p>';
  const userRows = [users.description ? `<p>${esc(users.description)}</p>` : '', users.vulnerableGroups?.length ? `<ul>${users.vulnerableGroups.map((group) => `<li>${esc(group)}</li>`).join('')}</ul>` : ''].join('') || '<p>—</p>';
  const evidenceRows = evidence.length ? `<ul>${evidence.map((item) => {
    const href = safeHref(item.ref), external = href && /^https?:\/\//i.test(href);
    const reference = href ? `<a href="${esc(href)}"${external ? ' target="_blank"' : ''} rel="noopener noreferrer">${esc(item.ref)}</a>` : `${esc(item.ref)} <span>(not linked)</span>`;
    return `<li><b>${esc(item.title)}</b>${item.clause ? ` · ${esc(item.clause)}` : ''}<br>${reference}</li>`;
  }).join('')}</ul>` : '<p>—</p>';
  return `<h2>Product context</h2><h3>Functions</h3>${functionRows}<h3>Operating environment</h3>${environmentRows}<h3>Users</h3>${userRows}<h3>Evidence</h3>${evidenceRows}`;
})();

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
  const risk = riskOf(t), rr = risk ? { l: risk.residualLikelihood, i: risk.residualImpact } : residual(t);
  const unfeasible = t.status === 'unfeasible';
  const refs = (t.assumptionRefs || []).map((aid) => {
    if (!ID_PATTERN.test(aid)) return `<span>${esc(aid)}</span> (invalid ID)`;
    const a = assumptionById.get(aid);
    if (!a) return `<span>${esc(aid)}</span> (missing)`;
    return `${renderLink(`#${assumptionAnchor(aid)}`, aid)} (${esc(a.source)})`;
  }).join(', ');
  const rationale = [t.likelihoodRationale ? `L: ${esc(t.likelihoodRationale)}` : '', t.impactRationale ? `I: ${esc(t.impactRationale)}` : ''].filter(Boolean).join('<br>');
  const classification = [
    `<b>Classification:</b> ${esc(t.classification || '—')}`,
    `<b>Responsibility:</b> ${esc(t.responsibility || '—')}`,
    t.deploymentConstraints ? `<b>Deployment constraints:</b> ${esc(t.deploymentConstraints)}` : '',
  ].filter(Boolean).join('<br>');
  const initial = unfeasible ? UNFEASIBLE_CELL : risk ? axisRisk(risk, 'initial', t) : `L${esc(t.likelihood ?? '—')} / I${esc(t.impact ?? '—')} (unavailable)`;
  const residualCell = unfeasible ? UNFEASIBLE_CELL : t.status === 'avoided' ? AVOIDED_CELL : risk ? axisRisk(risk, 'residual', t) : `L${esc(rr.l ?? '—')} / I${esc(rr.i ?? '—')} (unavailable)`;
  const acceptanceSetting = project.acceptableLevel || scheme?.acceptance?.defaultLevel || (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12);
  const acceptanceText = withinAcceptanceCriteria(t, risk)
    ? `<br><span>Within acceptance criteria (scheme ${esc(scheme.id)} v${esc(scheme.version)}, level ${esc(risk.residualBand.label || risk.residualBand.name)}, acceptable ${esc(acceptanceSetting)}).</span>`
    : '';
  return `<tr id="threat-${esc(t.id)}"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc((t.stride || []).join(""))}</td><td>${refs || '—'}</td><td>${rationale || '—'}</td><td>${classification}</td><td>${initial}</td><td>${residualCell}</td><td>${esc(t.status || '')}${acceptanceText}</td><td>${esc((t.compromisedObjectives || []).join('; ')) || '—'}</td><td>${esc(t.cause || '') || '—'}</td></tr>`;
}).join("");

const ucRows = (useCases.diagrams || []).map((d) =>
  `<li><b>${d.name || d.id}</b> (${(d.entities || []).length} entities, ${(d.connections || []).length} connections)</li>`
).join("");
const assRows = ['device', 'system', 'environment', 'operational'].map((k) => {
  const items = ass[k] || [];
  if (!items.length) return '';
  return `<h3>${k[0].toUpperCase() + k.slice(1)} assumptions</h3><ul>${items.map((a) => {
    const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => renderLink(`#threat-${tid}`, tid)).join(', ');
    return `<li id="${esc(assumptionAnchor(a.id))}"><b>${esc(a.id)}</b> — ${esc(a.text || '')}${cited ? `<br><span style="font-size:11px;color:#555">cited by: ${cited}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}).join('');
const atkRows = (ass.attacker || []).map((a) => {
  const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => renderLink(`#threat-${tid}`, tid)).join(', ');
  return `<li id="${esc(assumptionAnchor(a.id))}"><b>${esc(a.id)}</b> · <b>${esc(a.name)}</b> ${esc(capLabel(a.capability))}, ${esc(a.access)}: ${esc(a.text || '')}${cited ? `<br><span style="font-size:11px;color:#555">cited by: ${cited}</span>` : ''}</li>`;
}).join('');

const disclosureRequirements = (threatId) => {
  const items = reqs.filter((requirement) => (requirement.derivedFromThreat || []).includes(threatId))
    .map((requirement) => `<li><b>${esc(requirement.id)}</b>${requirement.text ? ` — ${esc(requirement.text)}` : ''}</li>`);
  return items.length ? `<ul>${items.join('')}</ul>` : '—';
};
const disclosureStakeholderControls = (threatId) => {
  const items = cms.filter((cm) => cm.selected !== false && ['deployment', 'shared'].includes(cm.responsibility) && (cm.addresses || []).some((address) => address.threat === threatId))
    .map((cm) => `<li><b>${esc(cm.id)}</b> — ${esc(cm.title)}</li>`);
  return items.length ? `<br><b>Expected from integrators and operators:</b><ul>${items.join('')}</ul>` : '';
};
const disclosureItem = (threat, extra = '') =>
  `<li><b>${esc(threat.id)}</b> ${esc(threat.title)}${threat.responsibility ? ` · ${esc(threat.responsibility)}` : ''}${extra}${threat.deploymentConstraints ? `<br><b>Deployment constraints:</b> ${esc(threat.deploymentConstraints)}` : ''}${disclosureStakeholderControls(threat.id)}<br><b>Requirements:</b> ${disclosureRequirements(threat.id)}</li>`;
const byResponsibility = threats.filter((threat) => {
  if (threat.status === 'avoided') return false;
  const risk = riskOf(threat);
  const aboveAcceptable = risk?.residual > 0 && (riskEngine
    ? !riskEngine.isAcceptable(threat, cms, project)
    : risk.residual > (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12));
  return (threat.classification && threat.classification !== 'product-vulnerability')
    || ['accepted', 'transferred'].includes(threat.status) || aboveAcceptable;
});
const avoidedThreats = threats.filter((threat) => threat.status === 'avoided');
const acceptedDeviations = threats.filter((threat) => threat.status === 'accepted' && threat.acceptanceDeviation);
const riskDisclosureSection = byResponsibility.length || avoidedThreats.length || acceptedDeviations.length
  ? `<h2>Residual risks and expectations on users and integrators</h2>` +
  (byResponsibility.length ? `<h3>By responsibility</h3><ul>${byResponsibility.map((threat) => disclosureItem(threat)).join('')}</ul>` : '') +
  (avoidedThreats.length ? `<h3>Avoided</h3><ul>${avoidedThreats.map((threat) => disclosureItem(threat, `<br><b>Avoidance rationale:</b> ${esc(threat.avoidanceRationale || '—')}`)).join('')}</ul>` : '') +
  (acceptedDeviations.length ? `<h3>Accepted deviations from the acceptance criteria</h3><ul>${acceptedDeviations.map((threat) => disclosureItem(threat, `<br><b>Circumstance:</b> ${esc(threat.acceptanceDeviation.circumstance || '—')}<br><b>Communicated to:</b> ${esc(threat.acceptanceDeviation.communicatedTo || '—')}`)).join('')}</ul>` : '')
  : '';

const html = `<!doctype html><html lang="en"><head><meta charset=utf8><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>TRA ${esc(project.title)}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}h1{font-size:1.4rem}.warn{color:#c62828}@media print{body{margin:0;max-width:none}table{page-break-inside:auto}tr{break-inside:avoid;page-break-inside:avoid}}</style></head><body><main>
<h1>${esc(project.title)}</h1><p>Device: ${esc(project.device.name)} (${esc(project.device.type)}) | SL-C ${esc(project.slTarget)} | mode ${esc(project.scope.mode)} | status ${esc(project.status)}</p>
${productContextSection}
<h2>Attacker profiles</h2><ul>${atkRows}</ul>
${assRows ? `<h2>Assumptions</h2>${assRows}` : ''}
<h2>Assets</h2><ul>${sys.assets.map((a) => `<li>${esc(a.name)} (C${esc(a.objectives.confidentiality)}/I${esc(a.objectives.integrity)}/A${esc(a.objectives.availability)}/S${esc(a.objectives.safety)})</li>`).join("")}</ul>
${riskSchemeSection}
<h2>Threats & risk</h2><table><caption>Threats and risk</caption><thead><tr><th scope="col">ID</th><th scope="col">Threat</th><th scope="col">STRIDE</th><th scope="col">Assumptions</th><th scope="col">Rationale</th><th scope="col">Classification</th><th scope="col">Initial</th><th scope="col">Residual</th><th scope="col">Status</th><th scope="col">Compromised objectives</th><th scope="col">Cause</th></tr></thead><tbody>${rows}</tbody></table>
${riskDisclosureSection}
${project.reportOptions?.includeUseCases ? `<h2>Use-case diagrams</h2>${ucRows ? `<ul>${ucRows}</ul>` : '<p>No use-case diagrams defined.</p>'}` : ''}
<h2>Plausibility check</h2>${issues.length ? `<ul class=warn>${issues.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>No issues found.</p>"}</main></body></html>`;

mkdirSync(join(base, "report"), { recursive: true });
writeFileSync(join(base, "report/index.html"), html);
console.log(`Report written to ${join(proj, "report/index.html")}; ${issues.length} plausibility issue(s).`);
