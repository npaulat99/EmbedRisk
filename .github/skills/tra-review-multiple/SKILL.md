---
name: tra-review-multiple
description: "Review multiple EmbedRisk TRA projects together for schema compliance and cross-project consistency: comparable devices rated very differently, diverging countermeasure choices for the same threat pattern, or knowledge-base drift."
disable-model-invocation: true
argument-hint: "Paths to two or more TRA project folders"
---
Review each of the TRA project folders provided (ask for the list if not given) individually first,
using the same Errors / Warnings / Notices structure as a single-project review.

Then add a **cross-project consistency** section:

- Same or similar component/interface `kind`+`protocol` rated with materially different likelihood or
  impact across projects, without an apparent reason (different attacker assumptions, different
  exposure) — flag as a possible inconsistency.
- Compare projects using their declared `riskScoringMethod`. For cost-based projects, compare
  required access/skill, cost-factor values, weights, calculated cost likelihood, proposed matrix
  likelihood, and documented overrides. Do not compare raw cost probabilities as if they were
  matrix scores, and do not flag a difference caused by a documented scheme or context change.
- The same threat pattern (matching a `knowledge-base/ot-threats.json` `key`, or clearly the same
  scenario) mitigated with different countermeasure types or left unmitigated in one project but
  addressed in another.
- Divergent use of status/acceptance fields (`acceptableRisk`, `status: accepted` without rationale)
  across projects that should follow the same organizational risk appetite.

Do not modify any file. End with a summary table: project, error count, warning count, notice count,
and one line on its overall readiness (draft-level gaps vs. close to review-ready).
