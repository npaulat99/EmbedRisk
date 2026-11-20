# Adding a Risk Scheme

EmbedRisk risk schemes define the likelihood and impact scales, how those axes are assessed, and how each pair is classified. Built-in schemes are 5x5, but local schemes may use other axis sizes and labels. Do not assume a universal 1-5 scale or a fixed numeric threshold such as 12; use the active scheme's axis values, level ranks, and `highLevel`.

This guide is the source of truth for users and AI agents creating or changing scheme files. The v2 JSON Schema is [risk-scheme-v2](../webapp/shared/risk-scheme.schema.json), and runtime normalization and fingerprinting live in [riskScheme.js](../webapp/shared/riskScheme.js).

## Where Schemes Live

The webapp loads built-ins from `webapp/.assets/knowledge-base/` and user schemes from `webapp/.local/risk-schemes/`. The latter is gitignored and is the default place for a personal scheme. Keep project-specific schemes there; do not commit them unless you explicitly intend to promote them as a shared built-in.

The VS Code extension loads its built-ins from `vscode-extension/runtime/.assets/knowledge-base/`. User schemes come from the machine setting `embedrisk.riskSchemeDirectory`; when empty, the extension uses its global storage `risk-schemes` folder. To share one local file between the webapp and extension on the same machine, set that extension setting to the webapp's `webapp/.local/risk-schemes` directory.

A project file is never a scheme registry. Do not add a scheme file path to `project.json`, and do not load schemes from paths supplied by a project. The project stores only the selected scheme ID and its fingerprint.

## Before Writing JSON

A prose description is not necessarily a complete scoring policy. Before creating a file, confirm any missing or ambiguous details with the user. Do not invent a matrix cell, threshold, treatment rule, or interpretation of missing criteria. In particular, collect:

- A stable lowercase ID, display title, version, and short description.
- The likelihood and impact level count, numeric values, codes, labels, and optional descriptions. Values must be contiguous integers starting at 1; each axis may have a different size.
- The criteria on each axis and their level descriptions, if the axes are criteria-based.
- How an axis value is obtained: highest assessed criterion, geometric mean, cost-based probability thresholds, or manual entry.
- The complete classification: either the exact level for every likelihood/impact pair, or product-score bands with exact inclusive bounds.
- Classification level IDs, labels, ranks, colors, treatment behavior, management-acceptance requirements, and the `highLevel` and default acceptable level.
- Expected example outcomes, including boundary cells and at least one residual-risk case. Use these examples as tests of the interpretation.

If the user gives only a narrative such as "low, medium, high, critical," ask for the axis scales and the full mapping or score thresholds. The labels alone do not define a risk scheme.

## V2 File Structure

Create one UTF-8 JSON object with `schemaVersion: 2` and exactly these top-level fields: `schemaVersion`, `id`, `title`, `version`, optional `description`, `likelihood`, `impact`, `classification`, optional `highLevel`, and optional `acceptance`. Unknown fields are rejected.

Each axis has:

- `levels`: a non-empty array with contiguous `value` integers starting at 1; each level has non-empty `code` and `label`, and may have a `description`.
- `derivation`: an axis-specific `kind`.
- `criteria`: an array of `{ "id", "label", "levelTexts" }`. Criterion IDs must be unique within the axis. `levelTexts` keys are strings for existing level numbers, and each value describes that rating.

Supported likelihood derivations are `criteria-max`, `geometric-mean`, `cost-based`, and `manual`. Supported impact derivations are `criteria-max` and `manual`.

- `criteria-max` uses the highest non-null criterion rating. If every criterion is null or absent, the axis is unrated.
- `geometric-mean` combines all defined criterion ratings geometrically; missing ratings use the middle axis value, rounded up. Document this behavior in the scheme description if it is intended.
- `manual` uses the stored axis value directly.
- `cost-based` maps a stored probability (`costLikelihood` or `attackProbability`) to an axis level using `probabilityThresholds`. Threshold keys are level numbers from 2 onward, values must increase strictly and be at most 1, and level 1 covers probabilities below the first threshold. A manually selected `costLikelihoodProposal` takes precedence for derivation.

A classification has a non-empty `levels` array. Every level has a unique lowercase `id`, display `label`, contiguous unique `rank` values from 1, six-digit hex `color`, and `treatment` of `auto-accept`, `optional`, `required`, or `immediate`. `acceptanceBy` may be `management`; optional `description` text appears in guidance.

Choose exactly one classification form:

- `lookup`: provide `matrix` rows keyed by impact values and columns keyed by likelihood values. Every cell must name an existing classification level ID. The matrix must contain exactly the required rows and columns. Use this when the policy has exceptions or is not reducible to likelihood times impact.
- `product-bands`: provide `bands` of `{ "level", "min", "max" }`. Bands must cover every integer product score from 1 through `likelihood level count × impact level count`, without gaps or overlaps. Use this only when classification is genuinely determined by the product.

`highLevel` is the classification level ID at which high-risk requirements begin; it defaults to the ID `high`, so schemes without that ID must set it explicitly. `acceptance.defaultLevel`, when supplied, is the classification level ID used as the default acceptance ceiling. A project may override that ceiling with `acceptableLevel`.

A minimal lookup fragment looks like this; it is illustrative, not a recommended policy:

```json
{
  "classification": {
    "kind": "lookup",
    "levels": [
      { "id": "low", "label": "Low", "rank": 1, "color": "#2e7d32", "treatment": "auto-accept" },
      { "id": "high", "label": "High", "rank": 2, "color": "#c62828", "treatment": "required", "acceptanceBy": "management" }
    ],
    "matrix": {
      "1": { "1": "low", "2": "high" },
      "2": { "1": "high", "2": "high" }
    }
  },
  "highLevel": "high",
  "acceptance": { "defaultLevel": "low" }
}
```

The complete axes and all required top-level fields must also be present. The schema limits a scheme file to 256 KB at runtime. Local IDs must not start with the reserved `builtin:` prefix.

## Add and Select a Scheme

1. Save a new file as `webapp/.local/risk-schemes/<scheme-id>.json`. Do not overwrite a built-in or another scheme with the same ID.
2. Run `node tools/check-local-risk-schemes.mjs`. It normalizes and fingerprints every local JSON file and runs the supplied 4x4 scenarios for `eigene-risikomatrix-4x4` when present. For a different scheme, also test every matrix cell and the user-provided examples; the checker cannot infer the intended policy from prose.
3. Confirm the file is ignored with `git check-ignore -v webapp/.local/risk-schemes/<scheme-id>.json`.
4. In the webapp, select the scheme in project settings. In the VS Code extension, use the wizard's scheme selector; configure `embedrisk.riskSchemeDirectory` first if the scheme is not in the extension's default global-storage folder.
5. Bind the scheme through the application UI. The project stores `riskSchemeId` and `riskSchemeFingerprint`; for rank-based acceptance it may also store `acceptableLevel`. Do not hand-calculate the fingerprint. The application computes it from the normalized scheme.
6. Re-rate or review project threats after changing schemes. If the selected scheme is unavailable or its fingerprint no longer matches, the tools warn and make risk classification read-only rather than silently reinterpreting stored numbers.
7. Generate a report and confirm its scheme title, version, fingerprint, legend, matrix dimensions, labels, and selected threat ratings.

The fingerprint identifies the normalized scheme content, not just its ID. If you edit an existing scheme, increment its version and treat every project bound to the old fingerprint as requiring review.

## AI Agent Workflow

When asked to add a scheme from a description, an AI agent should:

1. Read this guide and the v2 schema. Inspect the description for missing policy decisions and ask focused questions before writing if a level, criterion, matrix cell, band boundary, or acceptance rule is ambiguous.
2. Convert every axis rubric and classification outcome into explicit JSON. Preserve user wording for labels and criterion descriptions. Do not substitute the built-in Bug Bar, a product formula, or a remembered 1-5 convention unless requested.
3. Create a new local file under `webapp/.local/risk-schemes/` with a non-reserved ID. Do not change project data, built-ins, or the extension's global files unless the user asked for that.
4. Run `node tools/check-local-risk-schemes.mjs`, then verify every cell against the user's specification. Include the user's examples as executable checks where possible; specifically test all-null criteria, axis boundaries, high-level handling, and residual classification when they apply.
5. Smoke-test scheme selection and report output on a copy of a project whose ratings fit the new axes. Verify the generated fingerprint and ensure no report silently falls back to another scheme.
6. Report the file path, normalized fingerprint, checks performed, any unresolved policy questions, and that the file is intentionally gitignored.

A useful request template is:

```text
Scheme name and purpose:
Likelihood levels (value, code, label, description):
Impact levels (value, code, label, description):
Likelihood criteria and derivation:
Impact criteria and derivation:
Complete likelihood/impact-to-classification table OR exact product-score bands:
Classification labels, rank order, colors, and treatment for each level:
Which level is "high" and the default acceptable level:
Management-acceptance requirements:
Example scenarios with expected classifications:
Should this remain a local user scheme or become a shared built-in:
```

If the request does not answer enough of this template to define the scoring policy, ask rather than filling gaps by assumption.
