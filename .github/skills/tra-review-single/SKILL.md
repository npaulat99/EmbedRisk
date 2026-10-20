---
name: tra-review-single
description: "Review a single EmbedRisk TRA project for schema compliance, plausibility, and traceability gaps, and produce a structured audit-ready review report."
disable-model-invocation: true
argument-hint: "Path to the TRA project folder (e.g. webapp/projects/test)"
---
Review the TRA project at the path provided (ask for it if not given). Read all step files present
(`01-project-description` through `09-defects`) and the project's `.tra-knowledge.json` if present.

Produce the structured Errors / Warnings / Notices report described in your instructions. Do not
propose or apply any file changes — this is a review-only task. If the project references the
knowledge-base examples (`knowledge-base/*.json`), check whether reused entries were adapted to the
actual device context rather than left generic.

End with a short "Recommended next actions" list (each pointing at whether it's fixable via the
TRA Facilitator, a decision for the project owner, or something to `accept` via
`project.acceptedNotices`).
