---
name: tra-management-summary
description: "Generate a concise, non-technical management summary from a completed or in-progress EmbedRisk TRA project: scope, top risks, treatment status, and open decisions — suitable for a release or milestone gate review."
disable-model-invocation: true
argument-hint: "Path to the TRA project folder"
---
Read the project's `01-project-description/project.json` (scope, device, `slTarget`, `status`,
`riskScoringMethod`, cost weights and likelihood thresholds),
`06-threats/threats.json`, `08-countermeasures/countermeasures.json`, and `09-defects/defects.json`.
If `report/index.html` exists, you may use it to confirm figures, but generate the summary from the
JSON artifacts as the source of truth.

Produce a management summary with these sections, plain language, no STRIDE/CVSS jargon without a
one-line explanation the first time it's used:

1. **Scope** — device, assessment boundary, mode (blackbox/graybox/whitebox), target security level.
2. **Top risks** — highest initial-risk threats using the common likelihood x impact matrix, each
   with a one-line plain-language description and current `status`. If the project is cost-based,
   include the calculated cost likelihood/proposal and clearly identify any manual matrix override;
   do not silently rank by cost probability alone.
3. **Treatment status** — how many threats are mitigated / accepted / open, and the residual risk
   picture in one or two sentences (not a full table). For cost-based projects, mention material
   gaps in cost evidence or residual-cost assessment.
4. **Open decisions for management** — threats at or above `acceptableRisk` still `open`, or
   `accepted` without a `reviewDate`, framed as a decision the reader needs to make, not a technical
   defect list.
5. **Known vulnerabilities** — open high/critical `09-defects` items relevant to the current release
   decision.

Keep it to roughly one page. Do not modify any file — this is a read-only reporting task.
