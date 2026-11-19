#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScheme, fingerprint } from '../webapp/shared/riskScheme.js';
import '../webapp/shared/riskEngine.js';
import { validate } from '../webapp/server/src/validate.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemeDirectory = join(root, 'webapp/.local/risk-schemes');

if (!existsSync(schemeDirectory)) {
  console.log('No local risk-schemes directory; skipping.');
  process.exit(0);
}

const schemes = new Map();
const files = readdirSync(schemeDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort();

for (const file of files) {
  const scheme = normalizeScheme(readFileSync(join(schemeDirectory, file), 'utf8'), { local: true });
  assert.ok(!schemes.has(scheme.id), `duplicate local scheme ID '${scheme.id}' in ${file}`);
  schemes.set(scheme.id, scheme);
  console.log(`Valid: ${scheme.id} (${fingerprint(scheme)})`);
}

if (files.length === 0) {
  console.log('No local risk schemes found; skipping scenarios.');
  process.exit(0);
}

const scheme = schemes.get('eigene-risikomatrix-4x4');
if (!scheme) {
  console.log('Eigene Risikomatrix 4x4 not present; user-scheme scenarios skipped.');
  process.exit(0);
}

const engine = globalThis.RiskEngine.createRiskEngine(scheme);
for (const impact of scheme.impact.levels) {
  for (const likelihood of scheme.likelihood.levels) {
    const expected = scheme.classification.matrix[String(impact.value)][String(likelihood.value)];
    assert.equal(engine.classify(likelihood.value, impact.value).id, expected, `matrix cell E${likelihood.value}/S${impact.value}`);
  }
}
assert.equal(engine.classify(2, 3).id, 'high');
assert.equal(engine.classify(3, 2).id, 'medium');

assert.equal(engine.deriveLikelihood({ likelihoodCriteria: { frequencyYears: 2, frequencyObserved: 3 } }), 3);
assert.equal(engine.deriveImpact({ impactCriteria: { financial: 1, reputation: 3 } }), 3);
assert.equal(engine.deriveLikelihood({ likelihoodCriteria: {} }), null);
assert.equal(engine.deriveImpact({ impactCriteria: {} }), null);

const residualThreat = { id: 'RESIDUAL', likelihood: 3, impact: 3 };
const residualControls = [{ addresses: [{ threat: 'RESIDUAL', residualLikelihood: 1, residualImpact: 3 }] }];
assert.equal(engine.riskOf(residualThreat, residualControls).residualBand.id, 'medium');
assert.equal(engine.isAcceptable(residualThreat, residualControls, { acceptableLevel: 'medium' }), true);

const base = (threat) => validate({
  project: { acceptableLevel: 'medium' },
  assumptions: { attacker: [{ id: 'ATK-1', capability: 3, access: 'remote' }] },
  system: { components: [{ id: 'C-1' }], assets: [], interfaces: [], trustBoundaries: [] },
  threats: { threats: [{ title: 'Scheme scenario', stride: ['T'], components: ['C-1'], ...threat }] },
  requirements: { requirements: [] },
  countermeasures: { countermeasures: [] },
  dfd: { nodes: [], flows: [] },
  useCases: { diagrams: [] },
  attackTrees: { trees: [] },
  defects: { defects: [] },
  riskScheme: scheme,
});

assert.ok(base({ id: 'HIGH', likelihood: 2, impact: 3 }).some((issue) => issue.key === 'risk-acceptance:HIGH'));
assert.ok(base({ id: 'CRITICAL', likelihood: 4, impact: 4 }).some((issue) => issue.key === 'risk-acceptance:CRITICAL'));
assert.ok(!base({ id: 'ACCEPTED', likelihood: 2, impact: 3, status: 'accepted', acceptedBy: 'manager' })
  .some((issue) => issue.key === 'risk-acceptance:ACCEPTED'));
assert.ok(!base({ id: 'LOW', likelihood: 1, impact: 1 })
  .some((issue) => issue.key === 'risk-acceptance:LOW' || issue.key === 'risk-over-acceptable:LOW'));
assert.ok(base({ id: 'OUT-OF-RANGE', likelihood: 5, impact: 2 })
  .some((issue) => issue.severity === 'error' && issue.key === 'risk-range:OUT-OF-RANGE'));

console.log('Passed: 4x4 lookup, criteria-max, residual acceptance, and validation scenarios.');
