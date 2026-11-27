---
name: tra-plausibility-check
description: "Run a quick plausibility and internal-consistency check on an EmbedRisk TRA project: implausible ratings, contradictory assumptions, attacker/exposure mismatches — without a full review report."
disable-model-invocation: true
argument-hint: "Path to the TRA project folder, optionally a specific step or threat id"
---
Run a focused plausibility pass on the project (or the specific step/threat id) provided. Skip the
full schema/reference-integrity sweep (that's `tra-review-single`); focus only on:

- The active `project.riskSchemeId` and its fingerprint. Use that scheme's axis values,
  classification ranks, and `highLevel`; built-ins are 5x5 but local schemes may differ. If the
  scheme is unavailable or stale, do not infer classifications or apply a fixed cutoff. For a legacy
  project without an ID, use its built-in `riskScoringMethod` mapping. Cost-based evidence is needed
  only when the active likelihood derivation is `cost-based`.

- Attacker `access` vs. rated `exposure`/`likelihoodFactors.exposure` mismatches.
- Attacker `capability` vs. `likelihoodFactors.exploitability` mismatches.
- Assumptions that contradict each other or contradict a rated threat (e.g. an "air-gapped" or
  "no remote access" assumption alongside a threat rated for a remote attacker).
- Countermeasures whose `residualLikelihood`/`residualImpact` don't make sense for their `type`
  (a preventive control should move likelihood, not impact, and vice versa for some detective/
  corrective controls — explain the mismatch, don't just flag it).
- When the active likelihood derivation is `cost-based`: missing `requiredSkill`, `requiredAccess`, cost factors, cost rationales,
  configured weight/threshold problems, attacker access/skill mismatches, and unexplained
  differences between `costLikelihoodProposal` and the selected matrix likelihood. Also check that
  claimed countermeasure effects identify the changed cost input. Do not report the absence of
  cost-based fields for an exposure-exploitability-impact project.
- Check that an `avoided` threat has evidence of a design/context change and a matching
  `avoidanceRationale`; a missing requirement/assumption link is a dismissible re-assessment notice.
  For above-criteria acceptance, check `acceptanceDeviation.circumstance`; for transfer, check that
  the written rationale names the recipient and communication. Do not invent these rationales.
- In review/released projects, include open product-context and risk-criteria notices. For evidence
  references, flag V-06 unsafe schemes or paths (for example `javascript:`, `data:`, absolute paths,
  backslashes, or `..` segments); safe HTTP(S) and project-relative paths are allowed.
- `cause` and `compromisedObjectives` are optional; V-09 is one dismissible notice when both are
  absent. STRIDE-derived objectives are suggestions only, not a basis for asserting an objective.

Report only genuine implausibilities with a one-line rationale each — do not repeat things that are
merely incomplete (missing fields) unless they make a rating impossible to sanity-check. This is a
sparring-style plausibility pass, not a compliance audit.

For scheme definitions and adding a local scheme from a requested rubric, follow
[docs/RISK-SCHEMES.md](../../../docs/RISK-SCHEMES.md).
