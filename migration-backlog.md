# Migration backlog — VS Code extension → webapp feature parity

Goal: bring `vscode-extension/` to feature parity with `webapp/`. Both tools read and write the same
on-disk TRA project format, so **round-trip compatibility comes first**, then missing fields, then
missing features. VS Code-native equivalents (Problems panel, Source Control, settings, walkthroughs,
tree views) are preferred over porting web-only UI.

Workflow per item: **PLAN → IMPLEMENT → REVIEW → TEST → APPROVE**. An item is `done` only when
implementation, review and testing have all passed. One backlog item is in flight at a time; the
reviewer and tester for an item run in parallel.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done (impl + review + test passed) · `[-]` dropped

Verification baseline for every item:

- `cd vscode-extension && npm run compile` (type-check + bundle) passes.
- `node tools/test-models.js` passes.
- Behaviour matches the webapp reference implementation named in the item.

---

## Epic 0 — Test baseline

- [x] **EXT-00 Restore the attack-tree aggregation fixture.**
  `tools/test-models.js` reads `webapp/projects/test/07-attack-trees/attack-trees.json`, which was never
  committed (project folders are gitignored), so the suite fails on a clean checkout.
  - AC1: Fixture lives in a committed path under `tools/fixtures/` and the test reads it from there.
  - AC2: The fixture contains trees `AT-TEST-OR`, `AT-TEST-AND`, `AT-TEST-SAND`, `AT-TEST-RESIDUAL`
    whose evaluated metrics satisfy the existing assertions unchanged.
  - AC3: `node tools/test-models.js` passes on a clean checkout.
  - Deps: none.

## Epic 1 — Data compatibility (round-trip safety)

- [x] **EXT-R1 Residual risk matches the webapp.** `media/risk-model.js` picks the single control with
  the lowest L×I product; the webapp (`webapp/client/src/lib/risk.ts`, `webapp/server/src/risk.js`)
  takes the per-axis minimum across all *selected* controls.
  - AC1: `residual()` = min residual likelihood and min residual impact across links, skipping
    countermeasures with `selected === false`.
  - AC2: `status === 'unfeasible'` ⇒ residual `[0,0]` and initial risk `0`.
  - AC3: `band(score <= 0)` returns `{ name: 'None' }` (grey), like the webapp.
  - AC4: Tests updated (the old "single most-protective control" assertion is replaced) and a parity
    test compares results with the webapp's `computeRisk` on shared fixtures.
  - AC5: The wizard's inline fallback `R` (used only if `risk-model.js` fails to load) follows the same rules.
  - Deps: EXT-00.
- [ ] **EXT-R1b Report generator + DFD heat overlay honour `selected:false` and `unfeasible`.**
  `runtime/tools/generate-report.mjs` and `src/nativeDfdEditor.ts` duplicate residual logic without these rules.
  - AC1: Both skip `selected === false` controls and treat unfeasible threats as 0/0, like `media/risk-model.js`.
  - AC2: Report numbers for `webapp/projects/RL-100` match the webapp report / `computeRisk`.
  - Deps: EXT-R1.
- [ ] **EXT-K1 Sync bundled knowledge base.** `runtime/.assets/knowledge-base/risk-scheme.json` is missing
  `likelihood.factors` / `factorScale`; `bug-bar.json` is not bundled.
  - AC1: Both files are byte-identical to `webapp/.assets/knowledge-base/`.
  - AC2: A test fails if the copies drift.
  - Deps: EXT-00.
- [ ] **EXT-A1 Attack trees support `threatRefs[]`.** The extension only reads/writes legacy `threatRef`.
  - AC1: Model helper `threatRefsOf(tree)` returns `threatRefs` or falls back to `[threatRef]`.
  - AC2: Editor displays all linked threats; on save writes `threatRefs` and sets `threatRef` to the first
    entry; additional links are preserved.
  - AC3: Unit tests for the helper.
  - Deps: EXT-00.
- [ ] **EXT-ID1 Webapp ID prefixes for new assumptions and assets.** Wizard creates `A-D-`, `A-S-`, `A-E-`,
  `A-O-`, `AS-`; webapp uses `AD-`, `SYSA-`, `AE-`, `AO-`, `AST-`.
  - AC1: New items get the webapp prefixes; existing IDs are untouched.
  - Deps: none.
- [ ] **EXT-DFD1 DFD round-trip preservation test.** Lock in that unknown keys survive editing.
  - AC1: Fixture with `ifacePos`, `ifaceRot`, `ifaceLink`, `portPos`, `sourceHandle`/`targetHandle`,
    `componentRef`, `width`/`height`; after `addNode`/`addFlow`/`deleteNode` (unrelated node) and
    `layout`, those keys are deep-equal.
  - Deps: EXT-00.
- [ ] **EXT-DFD2 Clean orphan layout keys on node delete.**
  - AC1: After deleting node X, no `ifacePos`/`portPos`/`ifaceLink` key references X (matching webapp
    store `deleteNode` semantics).
  - Deps: EXT-DFD1.

## Epic 2 — Project (01) fields

- [ ] **EXT-PRJ1 Project `title`** (separate from `device.name`).
- [ ] **EXT-PRJ2 Device `type`, `version`, `modelReference`.**
- [ ] **EXT-PRJ3 Project `status`** (draft / in-progress / review / released; default draft).
- [ ] **EXT-PRJ4 `scope.inScope[]` / `scope.outOfScope[]` list editors** (empty rows dropped).
- [ ] **EXT-PRJ5 CRA `intendedUse` + `foreseeableUse[]`** (Deps: EXT-PRJ4 list widget).
- [ ] **EXT-PRJ6 `repo.projectBranchUrl` / `repo.kbUrl`** (merged into existing `repo`).

Common AC for PRJ items: field is shown in the wizard Project step, saved to the exact webapp field
name (`webapp/client/src/types.ts`, `ProjectPanel.tsx`), other keys preserved, value shown again on
reopen, undo/redo works. Items touch the same wizard code and run sequentially.

## Epic 3 — System & assets (03), requirements (05)

- [ ] **EXT-SYS1 Component `trustZone` and `description`.**
- [ ] **EXT-SYS2 Interface `tag` and `hidden` (DFD visibility reset).**
- [ ] **EXT-SYS3 Asset row summary tags** (type + C/I/A/S).
- [ ] **EXT-REQ1 Requirement `fromCountermeasure` checkbox + "Realises CM" / "Not derived" badges.**

## Epic 4 — Threats, countermeasures, defects (06/08/09)

- [ ] **EXT-C1 Countermeasure fields** `negativeEffects[]`, `verificationUrl`, `responsibility`,
  `ticketUrls[]`, per-link `ratedBy`/`ratedAt`.
- [ ] **EXT-B1 Bug Bar impact selector** driven by bundled `bug-bar.json` (Deps: EXT-K1).
- [ ] **EXT-A2 Attack-tree cost weights** in `evaluate()` matching `webapp/client/src/lib/attackTree.ts`.
- [ ] **EXT-T1 Cost-based feasibility fields on threats** (`costFactors`, `costRationales`,
  `costLikelihood`, `costLikelihoodProposal`) (Deps: EXT-A2).
- [ ] **EXT-M1 5×5 risk matrix heat map** (initial vs residual) (Deps: EXT-R1).
- [ ] **EXT-D1 Defects (09) editor** writing `09-defects/defects.json` in webapp format.
- [ ] **EXT-X1 Threat/countermeasure JSON import/export** compatible with `ThreatCmImportExport.tsx`.

## Epic 5 — DFD editor

- [ ] **EXT-DFD3 Port layer-visibility rules** to CommonJS `media/layer-visibility.js`; webapp
  `test/dfd-layer-visibility.test.mjs` cases pass against it.
- [ ] **EXT-DFD4 Use visibility rules in DFD render** (Deps: EXT-DFD3).
- [ ] **EXT-DFD5 Interface chips + flows to interface endpoints** (Deps: EXT-DFD3).
- [ ] **EXT-DFD6 STRIDE boundary-pair model** `media/stride-model.js` (port of `lib/stride.ts`).
- [ ] **EXT-DFD7 STRIDE-per-boundary editor** writing `system.strideAnalyses` (Deps: EXT-DFD6).
- [ ] **EXT-DFD8 Edge routing engine** `media/dfd-engine.js` (port of `webapp/shared/dfdEngine.js`).
- [ ] **EXT-UC1 Preserve `independent-dfd` diagrams** in the use-case editor (read-only, byte-identical).
- [ ] **EXT-UC2 Create/edit independent DFD diagrams** (Deps: EXT-UC1).

## Epic 6 — Platform (VS Code-native equivalents)

- [ ] **EXT-V1 Validation diagnostics** in the Problems panel (port of `webapp/server/src/validate.js`).
- [ ] **EXT-E1 Traceability CSV/JSON + SBOM export commands** (parity with server endpoints).
- [ ] **EXT-KB1 Remove imported KB catalogue command.**
- [ ] **EXT-S1 `contributes.configuration` settings** for options in `SettingsModal.tsx`.
- [ ] **EXT-W1 Getting-started walkthrough** (replaces webapp tutorial).
- [ ] **EXT-O1 DFD layer overview tree view.**
- [ ] **EXT-DB1 Dashboard** (counts / risk summary).

## Dropped / out of scope

- [-] **Named versions** — already implemented (`writeSnapshot` / change tracker in `src/wizard.ts`);
  history browsing is covered by VS Code Source Control.
- [-] **Wizard uses its own risk stub (claimed EXT-R2)** — rejected on verification: the inline `R` is only a
  fallback when `media/risk-model.js` fails to load; consistency is covered by EXT-R1 AC5.
- [-] **Git prepare/refresh panel** — server-backed webapp feature; VS Code Source Control is the native equivalent.

---

## Progress log

| Item | Impl | Review | Test | Notes |
|---|---|---|---|---|
| EXT-R1 | ✅ | ❌→✅ PASS (2nd round: `None` pill had no CSS background) | ✅ PASS (0 mismatches vs webapp `riskOf`, RL-100 + 16 edge cases) | Webapp server `computeRisk` gives L×I initial for unfeasible threats while client gives 0 — webapp-internal inconsistency, reported |
| EXT-00 | ✅ | ✅ PASS | ✅ PASS | Fixture moved to `tools/fixtures/`; webapp evaluator gives identical metrics for all 4 trees |

## Architectural decisions

- **ADR-1** Webapp is the reference implementation for all computations and field names.
- **ADR-2** New pure logic goes into CommonJS modules under `vscode-extension/media/` (isomorphic: webview
  `<script>` + `require()` in `tools/test-models.js`), never ES modules.
- **ADR-3** Prefer VS Code-native surfaces (Problems, Source Control, settings, walkthroughs, tree views)
  over porting web-only UI.
- **ADR-4** Save handlers must preserve unknown keys so projects round-trip losslessly between tools.
