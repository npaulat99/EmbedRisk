# Migration backlog — VS Code extension → webapp feature parity

Goal: bring `vscode-extension/` to feature parity with `webapp/`. Both tools read and write the same
on-disk TRA project format, so **round-trip compatibility comes first**, then missing fields, then
missing features. VS Code-native equivalents (Problems panel, Source Control, settings, walkthroughs,
tree views) are preferred over porting web-only UI.

Workflow: driven by the `ext-orchestrator` agent ([.github/agents/ext-orchestrator.agent.md](.github/agents/ext-orchestrator.agent.md)).
In short: salvage uncommitted work first; size each item S/M/L; the orchestrator does **S** items itself,
delegates **M** items to one background `ext-implementer` plus one combined `ext-verifier` (review + test),
and **splits L** items before starting. Briefs carry exact file line ranges. At most one fix round. Every
finished item is committed immediately, so an interrupted session never loses verified work. An item is
`done` only when its ACs are met and the verification baseline passes. One item is in flight at a time.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done (impl + review + test passed) · `[-]` dropped

Verification baseline for every item:

- `cd vscode-extension && npm run compile` (type-check + bundle) passes.
- `node tools/test-models.js`, `node tools/test-webviews.js` (parse) and `node tools/test-webviews-runtime.js`
  (jsdom runtime smoke test on the `tools/fixtures/RL-100` copy) pass.
- Behaviour matches the webapp reference implementation named in the item.

---

## Epic 0 — Test baseline

- [x] **EXT-HOT1 Webview inline scripts fail to parse (critical, pre-existing).** Found while testing EXT-ID1:
  the wizard script has a template-literal regex `[ _\-:.]` → `[ _-:.]` ("Range out of order") and an
  unclosed `{` in `renderAssumptions()`; the use-case editor has `(d.connections||[])=` (invalid
  assignment). Each error stops the whole webview script from running.
  - AC1: All three are fixed; behaviour matches the intent (ID validation regex allows `-`; entity deletion
    drops its connections, as in webapp `UseCasesPanel.tsx`).
  - AC2: A regression test bundles every webview-producing module (`src/*.ts`), extracts every inline
    `<script>` from the generated HTML and syntax-checks it; it fails on HEAD~ and passes after the fix.
  - Deps: none.
- [x] **EXT-HOT2 Runtime smoke test for webviews.** Parse checks (EXT-HOT1) cannot catch runtime errors, and the
  wizard was completely dead at HEAD, so more runtime faults may be hiding.
  - AC1: `tools/test-webviews.js` (or a sibling) loads each webview's HTML in a DOM (jsdom as a devDependency of
    `vscode-extension`), stubs `acquireVsCodeApi`, feeds the same `load` message the extension sends
    (RL-100 data) and navigates every wizard step / editor view without uncaught exceptions.
  - AC2: Any runtime errors found are fixed (or split into new items if large).
  - Deps: EXT-HOT1.

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
- [x] **EXT-R1b Report generator + DFD heat overlay honour `selected:false` and `unfeasible`.**
  `runtime/tools/generate-report.mjs` and `src/nativeDfdEditor.ts` duplicate residual logic without these rules.
  - AC1: Both skip `selected === false` controls and treat unfeasible threats as 0/0, like `media/risk-model.js`.
  - AC2: Report numbers for `webapp/projects/RL-100` match the webapp report / `computeRisk`.
  - Deps: EXT-R1.
- [x] **EXT-K1 Sync bundled knowledge base.** `runtime/.assets/knowledge-base/risk-scheme.json` is missing
  `likelihood.factors` / `factorScale`; `bug-bar.json` is not bundled.
  - AC1: Both files are byte-identical to `webapp/.assets/knowledge-base/`.
  - AC2: A test fails if the copies drift.
  - Deps: EXT-00.
- [x] **EXT-A1 Attack trees support `threatRefs[]`.** The extension only reads/writes legacy `threatRef`.
  - AC1: Model helper `threatRefsOf(tree)` returns the de-duplicated union of `threatRefs` and `threatRef`
    (corrected during implementation to match the webapp's read rule).
  - AC2: Editor displays all linked threats; on save writes `threatRefs` and sets `threatRef` to the first
    entry; additional links are preserved.
  - AC3: Unit tests for the helper.
  - Deps: EXT-00.
- [x] **EXT-ID1 Webapp ID prefixes for new assumptions and assets.** Wizard creates `A-D-`, `A-S-`, `A-E-`,
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
reopen, undo/redo works. Items touch the same wizard code and run sequentially. Each is size **S**:
the orchestrator implements them directly (anchors: `renderProject()` and the delegated `input` listener in
`src/wizard.ts`), no subagents.

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

- [ ] **EXT-RPT1 Report generator tolerates projects without a `steps` map.** Webapp-created projects (e.g.
  `webapp/projects/RL-100`) have no `project.steps`; `runtime/tools/generate-report.mjs` crashes
  (`reading '02-assumptions'`). AC: falls back to default step paths (as `webapp/server/src/artifacts.js`
  does) and generates RL-100 unmodified; same fix in `tools/generate-report.mjs`.
- [ ] **EXT-RPT2 Python report generators follow webapp residual rules** (`generate_report.py` copies still use
  single-best-control, ignore `selected`/`unfeasible`; they also crash on projects without `steps` and with
  `KeyError: 'access'` on attackers lacking that field, e.g. RNI01). AC: same numbers as the `.mjs` generator on RL-100.

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
| EXT-HOT2 | ✅ (salvaged the interrupted subagent's harness instead of redoing it) | ✅ | ✅ PASS (`tools/test-webviews-runtime.js`: 6 webviews, all wizard rail steps; failed on the old wizard, passes now) | Found + fixed: wizard SBOM source `<select>` used an inline `onchange` blocked by the nonce CSP, and `project.sbom` was never updated in memory (re-render reverted it). RL-100 fixture vendored to `tools/fixtures/RL-100` (project folders are gitignored). |
| EXT-HOT1 | ✅ | ✅ PASS | ✅ PASS (new `tools/test-webviews.js` fails on old code, passes now; use-case delete matches webapp `Inspector.tsx`) | Runtime smoke test skipped (no jsdom) → EXT-HOT2 |
| EXT-ID1 | ✅ | ✅ PASS | ✅ PASS (19 parity cases vs webapp `uid`, prefixes cited per entity, RL-100 DFD round trip) | Shared `nextId` in `media/dfd-model.js`; surfaced EXT-HOT1 |
| EXT-A1 | ✅ (2 rounds: orchestrator corrected AC1 to webapp union semantics + "+ Tree" auto-link) | ✅ PASS | ✅ PASS (11 parity cases vs webapp, RL-100 round trip deep-equal, Python helper matches) | Also fixed unescaped `threatRef` in Python report heading |
| EXT-K1 | ✅ | ✅ PASS | ✅ PASS (cmp identical, drift test fails helpfully, `vsce ls` includes bug-bar.json) | `bug-bar.json` bundled but unused until EXT-B1 |
| EXT-R1b | ✅ | ❌→✅ PASS (2nd round: unfeasible rows printed false "4×5=0" arithmetic) | ✅ PASS (RL-100 20/20 threats match client `riskOf`; DFD heat matches DfdView; re-verified marker rendering) | Found pre-existing report crash on missing `steps` (EXT-RPT1) and Python drift (EXT-RPT2); `tools/generate-report.mjs` looks for `.assets/` at repo root (pre-existing, not extension) |
| EXT-R1 | ✅ | ❌→✅ PASS (2nd round: `None` pill had no CSS background) | ✅ PASS (0 mismatches vs webapp `riskOf`, RL-100 + 16 edge cases) | Webapp server `computeRisk` gives L×I initial for unfeasible threats while client gives 0 — webapp-internal inconsistency, reported |
| EXT-00 | ✅ | ✅ PASS | ✅ PASS | Fixture moved to `tools/fixtures/`; webapp evaluator gives identical metrics for all 4 trees |

## Architectural decisions

- **ADR-1** Webapp is the reference implementation for all computations and field names.
- **ADR-2** New pure logic goes into CommonJS modules under `vscode-extension/media/` (isomorphic: webview
  `<script>` + `require()` in `tools/test-models.js`), never ES modules.
- **ADR-3** Prefer VS Code-native surfaces (Problems, Source Control, settings, walkthroughs, tree views)
  over porting web-only UI.
- **ADR-4** Save handlers must preserve unknown keys so projects round-trip losslessly between tools.
