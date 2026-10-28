#!/usr/bin/env node
// TRA report generator: zero external dependencies. Loads a TRA project folder,
// computes initial and residual risk, runs the plausibility checker, and writes report/index.html.
// Usage: node tools/generate-report.mjs <project-dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
let reqs = [];
try { reqs = read(project.steps["05-requirements"]).requirements || []; } catch { }

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
const strideOrder = ['S', 'T', 'R', 'I', 'D', 'E'];
const traceability = threats.map((t) => {
  const assetById = new Map((sys.assets || []).map((a) => [a.id, a]));
  const rr = residual(t), [rl, ri] = [rr.l, rr.i];
  const initial = (t.likelihood || 0) * (t.impact || 0), res = (rl || 0) * (ri || 0);
  const rqs = reqs.filter((r) => (r.derivedFromThreat || []).includes(t.id));
  const ctrls = cms.filter((c) => c.selected !== false && (c.addresses || []).some((a) => a.threat === t.id));
  const riskBand = (value) => value <= 0 ? { name: 'None' } : scheme.matrix.bands.find((b) => value >= b.min && value <= b.max) || scheme.matrix.bands[0];
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
    initial, initialBand: riskBand(initial).name,
    requirement: rqs.map((r) => `${r.id}${r.standardRef ? ` [${r.standardRef}]` : ''}${(r.satisfiedByCM || []).length ? ` → ${(r.satisfiedByCM || []).join('+')}` : ''}`).join('; '),
    control: ctrls.map((c) => `${c.id} (${c.status || '?'})`).join('; '),
    residual: res, residualBand: riskBand(res).name,
    evidence: ctrls.flatMap((c) => [...(c.ticketUrls || []), c.ticketUrl, c.verificationUrl]).filter(Boolean).join(' '),
    status: t.status || '', ratedBy: t.ratedBy || '',
    signoff: t.status === 'accepted' ? [t.acceptedBy && `by ${t.acceptedBy}`, t.reviewDate && `review ${t.reviewDate}`, t.acceptanceRationale].filter(Boolean).join(' · ') : '',
  };
});
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const traceabilityCsv = (() => {
  const headers = ['Asset', 'C/I/A/S', 'Threat', 'Title', 'STRIDE', 'Assumptions', 'Rationale', 'Initial', 'InitialBand', 'Requirement', 'Control', 'Residual', 'ResidualBand', 'Evidence', 'Status', 'RatedBy', 'SignOff'];
  const body = traceability.map((r) => [
    r.asset, r.cias, r.threat, r.title, r.stride, (r.assumptionRefs || []).join('; '),
    [r.likelihoodRationale && `L: ${r.likelihoodRationale}`, r.impactRationale && `I: ${r.impactRationale}`].filter(Boolean).join(' | '),
    r.initial, r.initialBand, r.requirement, r.control, r.residual, r.residualBand, r.evidence, r.status, r.ratedBy, r.signoff,
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
  return `<tr id="threat-${esc(t.id)}"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc((t.stride || []).join(''))}</td>` +
    `<td>${refs || '—'}</td><td>${rationale || '—'}</td><td>${classification}</td>` +
    `<td>${unfeasible ? UNFEASIBLE_CELL : `${t.likelihood}×${t.impact}=<b style="color:${band(r).color}">${r} ${esc(band(r).name)}</b>`}</td>` +
    `<td>${unfeasible ? UNFEASIBLE_CELL : `${rr.l}×${rr.i}=<b style="color:${band(rrv).color}">${rrv} ${esc(band(rrv).name)}</b>`}</td>` +
    `<td>${esc(t.status || 'open')}${t.status === 'accepted' && t.acceptedBy ? ` · <i>${esc(t.acceptedBy)}</i>` : ''}</td></tr>`;
}).join('');

const cmRows = cms.map((c) => {
  const tickets = (c.ticketUrls || []).filter(Boolean);
  return `<li><b>${esc(c.id)}</b> ${esc(c.title)} <i>(${esc(c.type || '')}, ${esc(c.status || '')})</i>` +
    ` → ${esc((c.addresses || []).map(a => a.threat).join(', '))}${tickets.map((u, i) => ` · <a href="${esc(u)}">ticket ${i + 1}</a>`).join('')}</li>`;
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
    const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => `<a href="#threat-${esc(tid)}">${esc(tid)}</a>`).join(', ');
    return `<li id="${esc(assumptionAnchor(a.id))}"><b>${esc(a.id)}</b> — ${esc(a.text || '')}${cited ? `<br><span style="font-size:11px;color:#555">cited by: ${cited}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}).join('');
const atkRows = (ass.attacker || []).map((a) => {
  const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => `<a href="#threat-${esc(tid)}">${esc(tid)}</a>`).join(', ');
  return `<li id="${esc(assumptionAnchor(a.id))}"><b>${esc(a.id)}</b> · <b>${esc(a.name)}</b> cap ${a.capability}, ${esc(a.access)}: ${esc(a.text || '')}${cited ? `<br><span style="font-size:11px;color:#555">cited by: ${cited}</span>` : ''}</li>`;
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
    ? `<h2>Software bill of materials (SBOM)</h2><p>Provided externally: <a href="${esc(project.sbom.url)}">${esc(project.sbom.url)}</a></p>`
    : `<h2>Software bill of materials (SBOM)</h2><p>Declared as externally provided; no URL recorded.</p>`;
} else {
  const fmt = sbomFormat === 'spdx' ? 'SPDX 2.3' : 'CycloneDX';
  const file = sbomFormat === 'spdx' ? 'report/sbom.spdx.json' : 'report/sbom.cdx.json';
  sbomSection = sbomTableRows
    ? `<h2>Software bill of materials (SBOM)</h2><p>${fmt} — <code>${file}</code></p><table><tr><th>Component</th><th>Version</th><th>Supplier</th><th>License</th><th>CPE / purl</th><th>Provenance</th></tr>${sbomTableRows}</table>`
    : `<h2>Software bill of materials (SBOM)</h2><p>No components defined (add in step 03).</p>`;
}

const html = `<!doctype html><meta charset=utf8><title>TRA ${esc(project.title || project.device?.name || 'Report')}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:72rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f5f5f5;font-size:12px;text-transform:uppercase;letter-spacing:.04em}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}.warn{color:#c62828}code{font-size:12px}ul{padding-left:1.4rem}</style>
<h1>${esc(project.title || project.device?.name || 'TRA Report')}</h1>
<p>Device: <b>${esc(project.device?.name || '—')}</b> | SL-C ${esc(project.slTarget || '—')} | scope ${esc(project.scope?.mode || '—')} | boundary: ${esc(project.scope?.boundary || '—')}</p>
<h2>Attacker profiles</h2><ul>${atkRows}</ul>
${assRows ? `<h2>Assumptions</h2>${assRows}` : ''}
<h2>Assets</h2><ul>${(sys.assets || []).map(a => `<li>${esc(a.name)} (C${a.objectives?.confidentiality}/I${a.objectives?.integrity}/A${a.objectives?.availability}/S${a.objectives?.safety})</li>`).join('')}</ul>
<h2>Threats &amp; risk</h2><table><tr><th>ID</th><th>Threat</th><th>STRIDE</th><th>Assumptions</th><th>Rationale</th><th>Classification</th><th>Initial risk</th><th>Residual risk</th><th>Status</th></tr>${rows}</table>
<h2>Countermeasures</h2><ul>${cmRows || '<li>None defined.</li>'}</ul>
${reqRows ? `<h2>Security requirements</h2><table><tr><th>ID</th><th>Requirement</th><th>Standard ref</th><th>From threats</th><th>Satisfied by</th></tr>${reqRows}</table>` : ''}
${project.reportOptions?.includeUseCases ? `<h2>Use-case diagrams</h2>${useCaseRows ? `<ul>${useCaseRows}</ul>` : '<p>No use-case diagrams defined.</p>'}` : ''}
${sbomSection}
<h2>Plausibility check</h2>${issues.length ? `<ul class=warn>${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p>No issues found.</p>'}`;

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
