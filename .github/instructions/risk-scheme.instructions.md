---
description: "Use when creating or modifying EmbedRisk v2 risk-scheme JSON, including translating a requested scoring policy into a local scheme. Covers matrix semantics, validation, project binding, and safe local storage."
applyTo: "**/risk-scheme*.json,**/.local/risk-schemes/*.json"
---
# Editing EmbedRisk Risk Schemes

Before editing, read [docs/RISK-SCHEMES.md](../../docs/RISK-SCHEMES.md) and the v2 JSON Schema at `webapp/shared/risk-scheme.schema.json`.

- Treat the user's rubric and examples as the policy source. Ask focused questions when axis levels, criteria, a matrix cell, a product-band boundary, treatment, or acceptance behavior is missing or ambiguous. Never infer a scoring rule from labels such as "high" or from the built-in 5x5 schemes.
- Preserve the requested terminology in level codes, labels, criteria, and descriptions. Use scheme-defined values; do not assume 1-5.
- Prefer a new user scheme in `webapp/.local/risk-schemes/<id>.json`. This directory is gitignored. Do not edit a built-in or commit a local scheme unless the user explicitly requests a shared built-in change.
- Local IDs must be lowercase and must not use the reserved `builtin:` prefix. Scheme IDs must be unique across built-ins and all local files.
- Keep scheme JSON limited to the supported v2 fields. Axis values are contiguous positive integers from 1. Lookup matrices must define every impact/likelihood pair exactly once; product bands must cover the full product range without gaps or overlaps.
- Do not store scheme paths in project artifacts. Projects bind to `riskSchemeId` and a normalized `riskSchemeFingerprint`; select/bind through the application UI rather than calculating fingerprints by hand.
- After editing, run `node tools/check-local-risk-schemes.mjs` and verify the file with `git check-ignore -v`. For a scheme other than `eigene-risikomatrix-4x4`, also test every matrix cell and the user's stated examples because the checker cannot infer those expectations.
- For a project-bound smoke test, use a temporary project copy with ratings within the new axes, select the scheme, generate the report, and verify its title, version, fingerprint, legend, matrix dimensions, and sample classifications.
