---
name: tra-prepare-interview
description: "Prepare a TRA interview before talking to the user: run context extraction and gap analysis on an EmbedRisk project and return a prioritized, de-duplicated list of open questions for the TRA Facilitator to ask — without asking the user anything yet."
disable-model-invocation: true
argument-hint: "Path to the TRA project folder"
---
Prepare (do not start) a TRA interview for the project provided:

1. Read `.tra-knowledge.json` if it exists — do not re-ask anything already recorded there as an
   answered fact or confirmed assumption.
2. Delegate to `tra-context-extractor` for a facts/gaps report on the current step files.
3. Turn the gap list into a prioritized queue: correctness-blocking gaps first (e.g. no attacker
   profile at all, no interfaces documented), then completeness gaps (e.g. a component with no
   description), then nice-to-have detail. Also read `project.riskScoringMethod`: for
   `cost-based`, add correctness-blocking questions for missing attacker access/skill evidence,
   cost weights or thresholds, cost factors, and factor rationales; for
   `exposure-exploitability-impact`, add questions for missing exposure/exploitability or Bug Bar
   impact evidence when rigorous mode is enabled.
4. Write the queue into `.tra-knowledge.json` under `interview.openQuestions` (creating the file if
   needed — no approval required, it's the AI sidecar file, not a TRA artifact).

Return the prioritized list to the user as a preview (grouped by category: assets, communication
paths, trust boundaries, authentication, maintenance access, availability requirements, constraints)
and ask whether to begin the one-question-at-a-time interview now or later. Do not ask the
substantive questions themselves in this step.
