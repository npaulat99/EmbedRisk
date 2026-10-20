---
name: tra-challenge-assumptions
description: "Challenge the assumptions already recorded in an EmbedRisk TRA project (assumptions.json and confirmed entries in .tra-knowledge.json): question whether they still hold, explore what changes if they don't, and surface downstream impact on threats and ratings."
disable-model-invocation: true
argument-hint: "Path to the TRA project folder, optionally a specific assumption id"
---
Read `02-assumptions/assumptions.json` (and `.tra-knowledge.json` for anything confirmed but not yet
promoted into that file) for the project provided. For each assumption (or the one specified):

- State the assumption as recorded and its `confidence` if set.
- Ask: what evidence supports it still being true today, and has anything about the product,
  deployment, or attacker landscape changed since it was recorded?
- Trace forward: which threats (`06-threats/threats.json`, via `assumptionRefs`) or attacker profiles
  depend on this assumption, and how would their rating change if the assumption were false or
  weaker than stated? Use the project's `riskScoringMethod`: for cost-based threats, include any
  affected required access/skill, cost factor, cost rationale, or `costLikelihoodProposal`; for the
  other scheme, include affected exposure/exploitability and impact evidence.
- Offer at least one plausible alternative assumption and its consequence, explicitly labeled as
  speculation for discussion, not a recommendation to adopt.

This is a discussion, not an edit. Do not modify `assumptions.json` or any other TRA file — if the
user decides an assumption should change, hand off to the TRA Facilitator to run that through the
approval workflow.
