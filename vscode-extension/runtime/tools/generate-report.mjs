#!/usr/bin/env node
// TRA report generator: zero external dependencies. Loads a TRA project folder,
// computes initial and residual risk, runs the plausibility checker, and writes report/index.html.
// Usage: node tools/generate-report.mjs <project-dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTraProject = (dir) => existsSync(join(dir, "01-project-description/project.json"));

function resolveProjectPath() {
  const fromArg = process.argv[2] || process.env.EMBEDRISK_PROJECT_DIR;
  if (fromArg) {
    const full = isAbsolute(fromArg) ? fromArg : join(root, fromArg);
    if (!hasTraProject(full)) throw new Error(`TRA project not found at: ${full}`);
    return { display: fromArg, base: full };
  }

  for (const searchRoot of [join(root, "projects"), join(root, "../../webapp/projects")]) {
    if (!existsSync(searchRoot)) continue;
    for (const entry of readdirSync(searchRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(searchRoot, entry.name);
      if (hasTraProject(full)) return { display: full, base: full };
    }
  }

  throw new Error("No TRA project found. Pass a project path as argv[2] or EMBEDRISK_PROJECT_DIR.");
}

const { display: proj, base } = resolveProjectPath();
const read = (p) => JSON.parse(readFileSync(join(base, p), "utf8"));
await import(pathToFileURL(join(root, "..", "media", "risk-engine.js")).href);
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
function validateV2Scheme(scheme, local) {
  if (!scheme || scheme.schemaVersion !== 2 || typeof scheme.id !== "string") throw new Error("scheme must use schemaVersion 2 and have an ID");
  if (local && scheme.id.startsWith("builtin:")) throw new Error("the 'builtin:' prefix is reserved");
  for (const axis of ["likelihood", "impact"]) {
    const definition = scheme[axis];
    if (!Array.isArray(definition?.levels) || !definition.levels.length || !Array.isArray(definition.criteria)) throw new Error(`${axis} axis is invalid`);
    definition.levels.forEach((level, index) => { if (level.value !== index + 1) throw new Error(`${axis} levels must be contiguous`); });
  }
  const { likelihood, impact, classification } = scheme;
  if (!classification || !Array.isArray(classification.levels) || !classification.levels.length) throw new Error("classification levels are required");
  const levels = new Set(classification.levels.map((level) => level.id));
  if (classification.kind === "lookup") {
    for (let i = 1; i <= impact.levels.length; i++) for (let l = 1; l <= likelihood.levels.length; l++)
      if (!levels.has(classification.matrix?.[i]?.[l])) throw new Error(`lookup cell ${i}/${l} is missing or invalid`);
  } else if (classification.kind === "product-bands") {
    const bands = [...(classification.bands || [])].sort((a, b) => a.min - b.min);
    let expected = 1;
    for (const band of bands) {
      if (!levels.has(band.level) || band.min !== expected || band.max < band.min) throw new Error("product bands have a gap, overlap, or unknown level");
      expected = band.max + 1;
    }
    if (expected !== likelihood.levels.length * impact.levels.length + 1) throw new Error("product bands do not cover the full risk range");
    classification.bands = bands;
  } else throw new Error("classification kind is invalid");
}
function resolveScheme(project) {
  const requestedId = project.riskSchemeId || ({ "exposure-exploitability-impact": "builtin:5x5-exposure", "cost-based": "builtin:5x5-cost" }[project.riskScoringMethod] || "builtin:5x5-cost");
  const schemes = new Map(), errors = [];
  const load = (file, local, expectedId) => {
    try {
      const text = readFileSync(file, "utf8");
      if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("scheme exceeds the 256 KB limit");
      const scheme = JSON.parse(text);
      validateV2Scheme(scheme, local);
      if (expectedId && scheme.id !== expectedId) throw new Error(`expected built-in ID '${expectedId}'`);
      if (schemes.has(scheme.id)) throw new Error(`duplicate scheme ID '${scheme.id}'`);
      const engine = RiskEngine.createRiskEngine(scheme, project);
      schemes.set(scheme.id, { scheme: engine.scheme, fingerprint: engine.fingerprint });
    } catch (error) { errors.push(`${file}: ${String(error.message || error)}`); }
  };
  for (const [id, file] of Object.entries(BUILTIN_SCHEME_FILES))
    load(join(root, ".assets/knowledge-base", file), false, id);
  const localDirectory = process.env.EMBEDRISK_RISK_SCHEME_DIRECTORY;
  if (localDirectory) {
    try {
      for (const entry of readdirSync(localDirectory, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith(".json")))
        load(join(localDirectory, entry.name), true);
    } catch (error) { if (error.code !== "ENOENT") errors.push(`${localDirectory}: ${String(error.message || error)}`); }
  }
  const selected = schemes.get(requestedId);
  if (!selected) return { id: requestedId, scheme: null, fingerprint: null, warning: `Risk scheme '${requestedId}' is unavailable. ${errors.join("; ")}`.trim() };
  if (project.riskSchemeFingerprint && project.riskSchemeFingerprint !== selected.fingerprint)
    return { id: requestedId, scheme: null, fingerprint: selected.fingerprint, warning: `Risk scheme '${requestedId}' has changed; classification is unavailable until reviewed.` };
  return { id: requestedId, scheme: selected.scheme, fingerprint: selected.fingerprint, warning: null };
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
let useCases = { diagrams: [] };
try { useCases = read(project.steps["04b-use-cases"] || "04b-use-cases/use-cases.json"); } catch { }
let reqs = [];
try { reqs = read(project.steps["05-requirements"]).requirements || []; } catch { }

// Mirrors webapp/client/src/lib/risk.ts: score <= 0 is its own "None" band, unfeasible threats carry
// no initial or residual risk, and deselected countermeasures (selected === false) do not reduce
// residual risk. (webapp/server/src/risk.js computeRisk only zeroes residual risk for unfeasible threats.)
const NONE_BAND = { name: 'None', min: 0, max: 0, color: '#6b7280' };
const UNFEASIBLE_CELL = `<b style="color:${NONE_BAND.color}">n/a (unfeasible)</b>`;
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
const riskCell = (risk, axes, threat, residualAxes) => {
  if (!risk) return `L${threat.likelihood ?? '—'} / I${threat.impact ?? '—'} (unavailable)`;
  if (axes === 'initial' && threat.status === 'unfeasible') return UNFEASIBLE_CELL;
  const band = risk[axes === 'initial' ? 'initialBand' : 'residualBand'];
  if (risk[axes] <= 0) return 'None';
  return scheme.classification.kind === 'lookup'
    ? esc(band.label || band.name)
    : `${residualAxes ? `${residualAxes.l}×${residualAxes.i}=` : `${threat.likelihood}×${threat.impact}=`}<b style="color:${esc(band.color)}">${risk[axes]} ${esc(band.label || band.name)}</b>`;
};
const strideOrder = ['S', 'T', 'R', 'I', 'D', 'E'];
const traceability = threats.map((t) => {
  const assetById = new Map((sys.assets || []).map((a) => [a.id, a]));
  const computed = riskOf(t);
  const rr = computed ? { l: computed.residualLikelihood, i: computed.residualImpact } : residual(t);
  const [rl, ri] = [rr.l, rr.i];
  const lookup = scheme?.classification.kind === 'lookup';
  const initial = computed ? (lookup ? computed.initialBand.rank ?? 0 : computed.initial) : null;
  const res = computed ? (lookup ? computed.residualBand.rank ?? 0 : computed.residual) : null;
  const rqs = reqs.filter((r) => (r.derivedFromThreat || []).includes(t.id));
  const ctrls = cms.filter((c) => c.selected !== false && (c.addresses || []).some((a) => a.threat === t.id));
  return {
    asset: (t.assets || []).map((a) => assetById.get(a)?.name || a).join('; '),
    cias: (t.assets || []).map((a) => {
      const o = assetById.get(a)?.objectives || {};
      return `C${o.confidentiality ?? '-'}/I${o.integrity ?? '-'}/A${o.availability ?? '-'}/S${o.safety ?? '-'}`;
    }).join('; '),
    threat: t.id, title: t.title, stride: [...(t.stride || [])].sort((a, b) => {
      const ai = strideOrder.indexOf(a), bi = strideOrder.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    }).join(''),
    assumptionRefs: t.assumptionRefs || [], likelihoodRationale: t.likelihoodRationale || '', impactRationale: t.impactRationale || '',
    initial, initialBand: computed?.initialBand.label || 'Unavailable',
    likelihood: computed ? undefined : t.likelihood ?? null,
    impact: computed ? undefined : t.impact ?? null,
    requirement: rqs.map((r) => `${r.id}${r.standardRef ? ` [${r.standardRef}]` : ''}${(r.satisfiedByCM || []).length ? ` → ${(r.satisfiedByCM || []).join('+')}` : ''}`).join('; '),
    control: ctrls.map((c) => `${c.id} (${c.status || '?'})`).join('; '),
    residual: res, residualBand: computed?.residualBand.label || 'Unavailable',
    residualLikelihood: computed ? undefined : rl,
    residualImpact: computed ? undefined : ri,
    evidence: ctrls.flatMap((c) => [...(c.ticketUrls || []), c.ticketUrl, c.verificationUrl]).filter(Boolean).join(' '),
    status: t.status || '', ratedBy: t.ratedBy || '',
    signoff: t.status === 'accepted' ? [t.acceptedBy && `by ${t.acceptedBy}`, t.reviewDate && `review ${t.reviewDate}`, t.acceptanceRationale].filter(Boolean).join(' · ') : '',
    classification: t.classification || '',
    responsibility: t.responsibility || '',
    deploymentConstraints: t.deploymentConstraints || '',
    compromisedObjectives: t.compromisedObjectives || [],
    cause: t.cause || '',
  };
});
const csvCell = (value) => {
  const text = String(value ?? '');
  const neutralized = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${neutralized.replace(/"/g, '""')}"`;
};
const traceabilityCsv = (() => {
  const headers = ['Asset', 'C/I/A/S', 'Threat', 'Title', 'STRIDE', 'Assumptions', 'Rationale', 'Initial', 'InitialBand', 'Requirement', 'Control', 'Residual', 'ResidualBand', 'Evidence', 'Status', 'RatedBy', 'SignOff', 'Classification', 'Responsibility', 'DeploymentConstraints', 'CompromisedObjectives', 'Cause'];
  const body = traceability.map((r) => [
    r.asset, r.cias, r.threat, r.title, r.stride, (r.assumptionRefs || []).join('; '),
    [r.likelihoodRationale && `L: ${r.likelihoodRationale}`, r.impactRationale && `I: ${r.impactRationale}`].filter(Boolean).join(' | '),
    r.initial, r.initialBand, r.requirement, r.control, r.residual, r.residualBand, r.evidence, r.status, r.ratedBy, r.signoff,
    r.classification, r.responsibility, r.deploymentConstraints, (r.compromisedObjectives || []).join('; '), r.cause,
  ].map(csvCell).join(','));
  return [headers.map(csvCell).join(','), ...body].join('\r\n') + '\r\n';
})();

// Plausibility checker
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
  const acceptanceSetting = project.acceptableLevel || scheme?.acceptance?.defaultLevel || (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12);
  const acceptanceText = withinAcceptanceCriteria(t, risk)
    ? `<br><span>Within acceptance criteria (scheme ${esc(scheme.id)} v${esc(scheme.version)}, level ${esc(risk.residualBand.label || risk.residualBand.name)}, acceptable ${esc(acceptanceSetting)}).</span>`
    : '';
  return `<tr id="threat-${esc(t.id)}"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc((t.stride || []).join(''))}</td>` +
    `<td>${refs || '—'}</td><td>${rationale || '—'}</td><td>${classification}</td>` +
    `<td>${riskCell(risk, 'initial', t, rr)}</td>` +
    `<td>${unfeasible ? UNFEASIBLE_CELL : riskCell(risk, 'residual', t, rr)}</td>` +
    `<td>${esc(t.status || 'open')}${t.status === 'accepted' && t.acceptedBy ? ` · <i>${esc(t.acceptedBy)}</i>` : ''}${acceptanceText}</td>` +
    `<td>${esc((t.compromisedObjectives || []).join('; ')) || '—'}</td><td>${esc(t.cause || '') || '—'}</td></tr>`;
}).join('');

const cmRows = cms.map((c) => {
  const tickets = (c.ticketUrls || []).filter(Boolean);
  return `<li><b>${esc(c.id)}</b> ${esc(c.title)} <i>(${esc(c.type || '')}, ${esc(c.status || '')})</i>` +
    ` → ${esc((c.addresses || []).map(a => a.threat).join(', '))}${tickets.map((u, i) => ` · ${renderLink(u, `ticket ${i + 1}`)}`).join('')}</li>`;
}).join('');

const reqRows = reqs.map((r) =>
  `<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.text)}</td><td>${esc(r.standardRef || '')}${r.slFr ? ` · ${esc(r.slFr)}` : ''}</td>` +
  `<td>${esc((r.derivedFromThreat || []).join(', '))}</td><td>${esc((r.satisfiedByCM || []).join(', '))}</td></tr>`
).join('');
const useCaseRows = (useCases.diagrams || []).map((d) => `<li><b>${esc(d.name || d.id)}</b> — ${(d.entities || []).length} entities, ${(d.connections || []).length} connections</li>`).join('');
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

// SBOM (CycloneDX) from component list
const sbomMode = project.sbom?.mode || 'in-tool';
const sbomFormat = project.sbom?.format || 'cyclonedx';
const sbomComps = (sys.components || []).filter(c => c.kind !== 'external-entity');

const buildCdx = () => ({
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: { timestamp: new Date().toISOString(), component: { type: 'device', name: project.device?.name || project.title || 'device', version: project.device?.version || '' } },
  components: sbomComps.map(c => ({
    'bom-ref': c.id, type: c.kind === 'hardware' ? 'device' : 'application',
    name: c.name, version: c.version || '',
    ...(c.supplier ? { supplier: { name: c.supplier } } : {}),
    ...(c.license ? { licenses: [{ license: { id: c.license } }] } : {}),
    ...(c.cpe && c.cpe.startsWith('cpe:') ? { cpe: c.cpe } : {}),
    ...(c.cpe && c.cpe.startsWith('pkg:') ? { purl: c.cpe } : {}),
    properties: [{ name: 'tra:provenance', value: c.provenance || 'unspecified' }],
  })),
});

const riskSchemeSection = (() => {
  if (!riskEngine) return `<div class="warn" role="alert"><b>Risk classification unavailable:</b> ${esc(schemeResolution.warning)} Raw stored L/I values are shown.</div>`;
  const likelihoods = riskEngine.likelihoodLevels();
  const impacts = riskEngine.impactLevels().slice().reverse();
  const cells = riskEngine.matrixCells();
  const rows = impacts.map((impact) => `<tr><th>${esc(impact.code)} · ${esc(impact.label)}</th>${likelihoods.map((likelihood) => {
    const level = riskEngine.classify(likelihood.value, impact.value);
    const cell = cells.find((item) => item.likelihood === likelihood.value && item.impact === impact.value);
    const label = scheme.classification.kind === 'lookup' ? level.label : cell.score;
    return `<td style="background:${esc(level.color)};color:${contrastTextColor(level.color)}" title="${esc(likelihood.code)} × ${esc(impact.code)} · ${esc(level.label)}">${esc(label)}</td>`;
  }).join('')}</tr>`).join('');
  const legend = scheme.classification.levels.map((level) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><i style="display:inline-block;width:10px;height:10px;background:${esc(level.color)}"></i>${esc(level.label)}</span>`).join('');
  return `<h2>Risk scheme</h2><p><b>${esc(scheme.title)}</b> · v${esc(scheme.version)} · fingerprint <code>${schemeResolution.fingerprint}</code></p><div>${legend}</div><table><caption>Active risk matrix</caption><thead><tr><th scope="col">Impact / Likelihood</th>${likelihoods.map((level) => `<th scope="col">${esc(level.code)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
})();
const buildSpdx = () => {
  const sid = id => 'SPDXRef-Package-' + String(id).replace(/[^A-Za-z0-9.\-]/g, '-');
  const created = new Date().toISOString();
  const name = (project.device?.name || project.title || 'device').replace(/[^A-Za-z0-9.\-]/g, '-');
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: `${name}-sbom`, documentNamespace: `https://spdx.org/spdxdocs/${name}-${created}`,
    creationInfo: { created, creators: ['Tool: embedrisk'] },
    packages: sbomComps.map(c => {
      const externalRefs = [];
      if (c.cpe && c.cpe.startsWith('cpe:')) externalRefs.push({ referenceCategory: 'SECURITY', referenceType: 'cpe23Type', referenceLocator: c.cpe });
      if (c.cpe && c.cpe.startsWith('pkg:')) externalRefs.push({ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.cpe });
      return { SPDXID: sid(c.id), name: c.name, versionInfo: c.version || 'NOASSERTION', supplier: c.supplier ? `Organization: ${c.supplier}` : 'NOASSERTION', downloadLocation: 'NOASSERTION', licenseConcluded: c.license || 'NOASSERTION', licenseDeclared: c.license || 'NOASSERTION', copyrightText: 'NOASSERTION', ...(externalRefs.length ? { externalRefs } : {}) };
    }),
    relationships: sbomComps.map(c => ({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: sid(c.id) })),
  };
};

const sbomTableRows = sbomComps.map(c =>
  `<tr><td>${esc(c.name)}</td><td>${esc(c.version || '')}</td><td>${esc(c.supplier || '')}</td><td>${esc(c.license || '')}</td><td><code>${esc(c.cpe || '')}</code></td><td>${esc(c.provenance || 'own')}</td></tr>`
).join('');

let sbomSection;
if (sbomMode !== 'in-tool') {
  sbomSection = project.sbom?.url
    ? `<h2>Software bill of materials (SBOM)</h2><p>Provided externally: ${renderLink(project.sbom.url, project.sbom.url)}</p>`
    : `<h2>Software bill of materials (SBOM)</h2><p>Declared as externally provided; no URL recorded.</p>`;
} else {
  const fmt = sbomFormat === 'spdx' ? 'SPDX 2.3' : 'CycloneDX';
  const file = sbomFormat === 'spdx' ? 'report/sbom.spdx.json' : 'report/sbom.cdx.json';
  sbomSection = sbomTableRows
    ? `<h2>Software bill of materials (SBOM)</h2><p>${fmt} — <code>${file}</code></p><table><caption>Software bill of materials</caption><thead><tr><th scope="col">Component</th><th scope="col">Version</th><th scope="col">Supplier</th><th scope="col">License</th><th scope="col">CPE / purl</th><th scope="col">Provenance</th></tr></thead><tbody>${sbomTableRows}</tbody></table>`
    : `<h2>Software bill of materials (SBOM)</h2><p>No components defined (add in step 03).</p>`;
}

const requirementIdsFor = (threatId) => reqs.filter((requirement) => (requirement.derivedFromThreat || []).includes(threatId)).map((requirement) => requirement.id);
const disclosureItem = (threat, extra = '') => {
  const requirementIds = requirementIdsFor(threat.id);
  return `<li><b>${esc(threat.id)}</b> ${esc(threat.title)}${threat.responsibility ? ` · ${esc(threat.responsibility)}` : ''}${extra}${threat.deploymentConstraints ? `<br><b>Deployment constraints:</b> ${esc(threat.deploymentConstraints)}` : ''}<br><b>Requirements:</b> ${esc(requirementIds.join(', ') || '—')}</li>`;
};
const byResponsibility = threats.filter((threat) => {
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

const html = `<!doctype html><html lang="en"><head><meta charset=utf8><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>TRA ${esc(project.title || project.device?.name || 'Report')}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:72rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f5f5f5;font-size:12px;text-transform:uppercase;letter-spacing:.04em}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}.warn{color:#c62828}code{font-size:12px}ul{padding-left:1.4rem}@media print{body{margin:0;max-width:none}table{page-break-inside:auto}tr{break-inside:avoid;page-break-inside:avoid}}</style></head><body><main>
<h1>${esc(project.title || project.device?.name || 'TRA Report')}</h1>
<p>Device: <b>${esc(project.device?.name || '—')}</b> | SL-C ${esc(project.slTarget || '—')} | scope ${esc(project.scope?.mode || '—')} | boundary: ${esc(project.scope?.boundary || '—')}</p>
<h2>Attacker profiles</h2><ul>${atkRows}</ul>
${assRows ? `<h2>Assumptions</h2>${assRows}` : ''}
<h2>Assets</h2><ul>${(sys.assets || []).map(a => `<li>${esc(a.name)} (C${a.objectives?.confidentiality}/I${a.objectives?.integrity}/A${a.objectives?.availability}/S${a.objectives?.safety})</li>`).join('')}</ul>
${riskSchemeSection}
<h2>Threats &amp; risk</h2><table><caption>Threats and risk</caption><thead><tr><th scope="col">ID</th><th scope="col">Threat</th><th scope="col">STRIDE</th><th scope="col">Assumptions</th><th scope="col">Rationale</th><th scope="col">Classification</th><th scope="col">Initial risk</th><th scope="col">Residual risk</th><th scope="col">Status</th><th scope="col">Compromised objectives</th><th scope="col">Cause</th></tr></thead><tbody>${rows}</tbody></table>
${riskDisclosureSection}
<h2>Countermeasures</h2><ul>${cmRows || '<li>None defined.</li>'}</ul>
${reqRows ? `<h2>Security requirements</h2><table><caption>Security requirements</caption><thead><tr><th scope="col">ID</th><th scope="col">Requirement</th><th scope="col">Standard ref</th><th scope="col">From threats</th><th scope="col">Satisfied by</th></tr></thead><tbody>${reqRows}</tbody></table>` : ''}
${project.reportOptions?.includeUseCases ? `<h2>Use-case diagrams</h2>${useCaseRows ? `<ul>${useCaseRows}</ul>` : '<p>No use-case diagrams defined.</p>'}` : ''}
${sbomSection}
<h2>Plausibility check</h2>${issues.length ? `<ul class=warn>${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p>No issues found.</p>'}</main></body></html>`;

mkdirSync(join(base, "report"), { recursive: true });
writeFileSync(join(base, "report/index.html"), html);
writeFileSync(join(base, "report/traceability.csv"), traceabilityCsv);
writeFileSync(join(base, "report/traceability.json"), JSON.stringify(traceability, null, 2) + '\n');
if (sbomMode === 'in-tool') {
  if (sbomFormat === 'spdx') {
    if (existsSync(join(base, "report/sbom.cdx.json"))) unlinkSync(join(base, "report/sbom.cdx.json"));
    writeFileSync(join(base, "report/sbom.spdx.json"), JSON.stringify(buildSpdx(), null, 2) + '\n');
  } else {
    if (existsSync(join(base, "report/sbom.spdx.json"))) unlinkSync(join(base, "report/sbom.spdx.json"));
    writeFileSync(join(base, "report/sbom.cdx.json"), JSON.stringify(buildCdx(), null, 2) + '\n');
  }
} else {
  for (const file of ["sbom.cdx.json", "sbom.spdx.json"]) {
    if (existsSync(join(base, `report/${file}`))) unlinkSync(join(base, `report/${file}`));
  }
}
console.log(`Report written to ${join(proj, "report/index.html")}; ${issues.length} plausibility issue(s).`);
