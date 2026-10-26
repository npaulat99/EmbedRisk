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
- [x] **EXT-DFD1 DFD round-trip preservation test.** Lock in that unknown keys survive editing.
  - AC1: Fixture with `ifacePos`, `ifaceRot`, `ifaceLink`, `portPos`, `sourceHandle`/`targetHandle`,
    `componentRef`, `width`/`height`; after `addNode`/`addFlow`/`deleteNode` (unrelated node) and
    `layout`, those keys are deep-equal.
  - Deps: EXT-00.
- [x] **EXT-DFD2 Clean orphan layout keys on node delete.**
  - AC1: After deleting node X, no `ifacePos`/`ifaceRot`/`portPos`/`ifaceLink` key references X or its
    deleted descendants; unrelated entries survive (key format from webapp `types.ts`).
  - Deps: EXT-DFD1.
- [x] **EXT-R3 Preserve threat/CM document envelope metadata on save.**
  - AC1: Explicit save and autosave merge `threats` / `countermeasures` into the existing document,
    preserving unknown top-level keys; regression tests cover both paths and reopen.
  - Deps: none. Pre-existing envelope replacement identified during EXT-B1 verification.

## Epic 2 — Project (01) fields

- [x] **EXT-PRJ1 Project `title`** (separate from `device.name`).
- [x] **EXT-PRJ2 Device `type`, `version`, `modelReference`.**
- [x] **EXT-PRJ3 Project `status`** (draft / in-progress / review / released; default draft).
- [x] **EXT-PRJ4 `scope.inScope[]` / `scope.outOfScope[]` list editors** (empty rows dropped).
- [x] **EXT-PRJ5 CRA `intendedUse` + `foreseeableUse[]`** (Deps: EXT-PRJ4 list widget).
- [x] **EXT-PRJ6 `repo.projectBranchUrl` / `repo.kbUrl`** (merged into existing `repo`).

Common AC for PRJ items: field is shown in the wizard Project step, saved to the exact webapp field
name (`webapp/client/src/types.ts`, `ProjectPanel.tsx`), other keys preserved, value shown again on
reopen, undo/redo works. Items touch the same wizard code and run sequentially. Each is size **S**:
the orchestrator implements them directly (anchors: `renderProject()` and the delegated `input` listener in
`src/wizard.ts`), no subagents.

## Epic 3 — System & assets (03), requirements (05)

- [x] **EXT-SYS1 Component `trustZone` and `description`.**
- [x] **EXT-SYS2 Interface `tag` and `hidden` (DFD visibility reset).**
- [x] **EXT-SYS3 Asset row summary tags** (type + C/I/A/S).
- [x] **EXT-REQ1 Requirement `fromCountermeasure` checkbox + "Realises CM" / "Not derived" badges.**

## Epic 4 — Threats, countermeasures, defects (06/08/09)

- [x] **EXT-C1 Countermeasure fields** `negativeEffects[]`, `verificationUrl`, `responsibility`,
  `ticketUrls[]`, per-link `ratedBy`/`ratedAt`.
- [x] **EXT-B1 Bug Bar impact selector** driven by bundled `bug-bar.json` (Deps: EXT-K1).
- [x] **EXT-A2 Attack-tree cost weights** in `evaluate()` matching `webapp/client/src/lib/attackTree.ts`.
- [x] **EXT-T1 Cost-based feasibility fields on threats** (`costFactors`, `costRationales`,
  `costLikelihood`, `costLikelihoodProposal`) (Deps: EXT-A2).
  - Sized L after inspecting `RiskCalculator.tsx:20-65`, `attackTree.ts:6-55,200-204`,
    and wizard rendering/save handlers: split below; parent stays open until all children pass.
  - [x] **EXT-T1a Threat cost-field persistence** (M; Deps: EXT-A2).
    - AC1: The threat save handler round-trips `requiredSkill`, `requiredAccess`, `costFactors`,
      `costRationales`, `costLikelihood`, and `costLikelihoodProposal` without deriving or replacing
      the independently selected `likelihood`; preserve zero likelihood/probability/proposal.
    - AC2: Explicit-save omitted cost fields preserve existing values; null removes these optional fields
      on either save path (autosave remains a full snapshot, so omission there removes a field);
      empty maps and empty rationale strings clear assessments without resurrecting saved values.
      Unknown row/nested metadata and document envelopes survive unrelated edits.
    - AC3: Focused runtime tests cover new/existing threats, defaults remaining absent, edits/clearing,
      save/reopen and undo/redo round trips using in-memory fixtures. Full baseline passes.
      This child adds persistence only, not cost controls or automatic calculations.
  - [x] **EXT-T1b Threat feasibility computation model** (M; Deps: EXT-T1a).
    - AC: Isomorphic helpers match `RiskCalculator.tsx:20-47` and `attackTree.ts` for weighted costs
      (missing factors default to 3, unlike the extension's public unassessed tree `stepProb`),
      access probabilities, skill/capability gating, status transitions and configured likelihood
      thresholds. Tests compare actual webapp computations for defaults, edits/clearing, partial,
      zero/negative weights and threshold boundaries; calculations do not mutate accepted likelihood
      merely by reading a threat, or discard unknown metadata. Preserve existing tree behavior.
  - [x] **EXT-T1c Threat feasibility wizard controls** (L; Deps: EXT-T1b).
    - AC: Integrate seven factor selectors/rationales, required skill/access, probability/proposal
      display and cost-based/default scoring mode, retaining legacy exposure/exploitability mode.
      Match webapp explicit calculator-update behavior while preserving stored manual overrides on
      unrelated edits/reopen; show proposal/accepted-likelihood differences. Support unfeasible L0,
      configured project weights/access/thresholds and selected SL-C capability. Runtime tests cover
      controls, defaults, clearing, computation, metadata, persistence and undo/redo/reopen.
      Re-size before starting; split further if implementation plus tests exceeds M.
    - Re-sized L: scoring-mode integration, seven factors/rationales and end-to-end history coverage
      exceed 200 changed lines. Complete the independently runnable children below; parent stays open.
    - [x] **EXT-T1c1 Threat feasibility mode, skill/access and proposal controls** (M; Deps: EXT-T1b).
      - AC: Load the tested browser helpers; show required skill/access with webapp defaults and
        option labels, calculated probability/proposal and accepted-likelihood differences in
        cost-based/default mode. Keep Bug Bar impact available and retain the legacy calculator
        in exposure/exploitability mode. Mode changes and render/reopen do not recalculate saved values.
      - AC: Explicit skill/access changes use the helper with configured project weights/access/
        thresholds and selected SL-C capability, accepting the proposal and supporting unfeasible L0.
        Existing factor/rationale metadata and manual overrides survive unrelated edits.
      - AC: Real runtime controls cover defaults, configured computations, capability transitions,
        mode switching, manual overrides, persistence and undo/redo/reopen. Full baseline passes.
        Factor/rationale editing and clearing remain EXT-T1c2; schema changes remain EXT-T1d.
    - [x] **EXT-T1c2 Threat cost-factor and rationale controls** (M; Deps: EXT-T1c1).
      - AC: Add seven factor selectors and rationales using webapp labels/defaults and explicit-update
        semantics; edits and clearing preserve unknown metadata and accept the calculated proposal.
        Runtime tests exercise actual controls, defaults, clearing, configured computations and
        save/undo/redo/reopen. Full baseline passes; close EXT-T1c only when both children pass.
  - [x] **EXT-T1d Threat likelihood schema compatibility** (S; Deps: EXT-T1a).
    - AC: Align the bundled threat schema's likelihood range with the shared 0–5 matrix (currently
      `runtime/.assets/schema/threats.schema.json:23` rejects L0); check the corresponding webapp
      schema and add focused validation coverage for L0 and out-of-range values. No fixture edits.
    - The webapp has no corresponding threat JSON schema in this checkout; its threat type includes
      `unfeasible`. The bundled schema now accepts that status as well as integer likelihood 0–5,
      so a complete cost-calculator L0 assessment validates.
- [x] **EXT-M1 5×5 risk matrix heat map** (initial vs residual) (Deps: EXT-R1).
  - Sized L after inspecting `RiskMatrix.tsx:12-167`, `Inspector.tsx:545-562` and `risk.ts:34-93`:
    wizard display, DFD subtree filtering and cell navigation span multiple editors. Split into
    independently runnable children; parent closes only when all children are verified.
  - [x] **EXT-M1a Wizard initial/residual heat map** (M; Deps: EXT-R1).
    - AC: Threat and countermeasure cards show a real 5×5 matrix with likelihood 1→5 left-to-right,
      impact 5→1 top-to-bottom, scores, threat counts, configured band colours/legend and the webapp's
      acceptable-risk boundary (project threshold, default 12). Default residual; initial/residual
      switching is view-only, with no save, undo entry or project-data mutation.
    - AC: Reuse RiskModel and a shared pure matrix helper; honour selected:false, independent per-axis
      residual minima, unfeasible exclusion and L0/zero-impact omission from the 1–5 cells without
      clamping or changing stored values. Refresh both surfaces after edits, host reload and undo/redo.
    - AC: Model/reference and real-control jsdom tests cover 25-cell shape, orientation/count placement,
      modes, configured/default bands and threshold, edge cases and read-only rendering with unknown
      metadata preserved. Full baseline passes; no TRA fixture changes.
  - [x] **EXT-M1b DFD component heat map** (M; Deps: EXT-M1a).
    - AC: Native DFD inspector uses the shared matrix with all-project/selected-component scope,
      including transitive descendants, and initial/residual selection; selected:false, zero-risk,
      configured scheme and threshold behaviour match the wizard/webapp. Runtime tests cover
      selection, subtree rollup and read-only rendering; full baseline passes.
  - [x] **EXT-M1c Matrix cell threat navigation** (M; Deps: EXT-M1b).
    - AC: Occupied cells support mouse/Enter/Space navigation to a single threat or an accessible
      chooser for multiple threats, in wizard and DFD surfaces, matching RiskMatrix.tsx.
      Empty cells do not navigate; interaction does not edit data. Runtime tests and full baseline pass.
- [x] **EXT-D1 Defects (09) editor** writing `09-defects/defects.json` in webapp format.
- [x] **EXT-X1 Threat/countermeasure JSON import/export** compatible with `ThreatCmImportExport.tsx`.

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

- [ ] **EXT-C2 Preserve zero residual assessments on explicit CM save** (Deps: EXT-R1).
  - AC: Explicit CM save preserves zero residual likelihood/impact like RiskModel and autosave;
    regression tests cover both save paths and reopen without changing unknown link metadata.
    Pre-existing clamp found during EXT-M1a review (`src/wizard.ts:362-363`); not changed by the matrix.
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
| EXT-X1 | ✅ | ✅ PASS | ✅ PASS (compile, 142 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Added selectable full-record threat/countermeasure JSON export and import in the wizard. Accepts the webapp envelope, bare threat/CM arrays and raw step envelopes; imports allocate collision-free project-wide IDs, remap in-batch threat/CM references, preserve external references and unknown metadata, and retain step-document metadata. Invalid inputs report errors without writing; host persistence and reopen are covered by runtime tests. Verifier confirmed the runtime regression fails without the implementation. No webapp or fixture changes; no live VS Code validation. |
| EXT-D1 | ✅ | ✅ PASS (direct diff review; agent-depth limit prevented delegation) | ✅ PASS (compile, 142 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Added the wizard Defects (09) rail step and CRUD editor for webapp fields/defaults, severity/status ordering, and component/threat references. Defects load into state, participate in undo/redo and autosave, and write the `{ defects: [...] }` document envelope while retaining unrelated document metadata. Runtime regression covers defaults, every defect field, refs, save/reload/delete. Attempted the prescribed M-item implementer delegation, but the tool rejected it at maximum subagent depth; completed the bounded diff review directly. No fixtures changed or live VS Code/browser validation. |
| EXT-M1c | ✅ | ✅ PASS | ✅ PASS (compile, 142 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Occupied cells navigate to one threat or an accessible, dismissible chooser in both wizard matrices and the DFD matrix; empty cells do nothing. Keyboard Enter/Space and mouse activation are covered, and DFD navigation opens the wizard targeting the selected threat. Read-only behavior tests assert no project/DFD writes or history entries. Independent verifier also confirmed wizard regression test fails without implementation. No fixtures changed or live VS Code/browser validation; closes EXT-M1 after M1a/M1b/M1c pass. |
| EXT-M1b | ✅ | ✅ PASS | ✅ PASS (compile, 142 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Native DFD inspector now renders the shared read-only initial/residual matrix for all threats or the selected component and its transitive descendants. Uses configured scheme and acceptable-risk threshold (default 12); tests cover selected:false, unfeasible/zero/off-grid risks, mode/scope selection and no writes/history. Full baseline passed independently in implementation and verification. No fixtures changed; no live VS Code/browser validation. EXT-M1 was open for M1c at this stage; the parent is now closed. |
| EXT-M1a | ✅ | ✅ PASS | ✅ PASS (compile, 142 reported model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Split L EXT-M1 into three M children; this was the first completed child. Threat/CM cards share a read-only initial/residual matrix, configured KB bands and project acceptable-risk boundary (default 12). Actual client risk-engine parity and real-control tests cover all 25 cells, orientation/counts, selected:false, per-axis minima, unfeasible/zero/off-grid exclusion, modes, edits, undo/redo/reload and unknown metadata; verifier's negative controls reject missing helper, wrong residual axis and broken mode selection. Rendering/mode changes produce no saves/history. Full baseline independently passed implementation and verification. No fixture edits or live VS Code/browser validation; jsdom does not validate painted layout/colours. EXT-M1 was open for subsequent children at this stage and is now closed. Pre-existing explicit CM-save zero clamp recorded as EXT-C2, not changed. |
| EXT-T1d | ✅ | ✅ PASS | ✅ PASS (compile, 140 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Bundled threat schema accepts integer L0 and the webapp's unfeasible status. Full-document Ajv 2020-12 regressions cover L0–L5, existing statuses, unfeasible L0, missing likelihood, negative/above-range/fractional/string/null likelihoods and unknown status; the L0 regression failed before the fix. Declared the already-installed Ajv as a direct test dependency. No corresponding webapp threat schema exists in this checkout; checked its threat type and existing calculator parity coverage. No fixture changes or live VS Code validation. All EXT-T1 children are verified, closing EXT-T1. |
| EXT-T1c2 | ✅ | ✅ PASS | ✅ PASS (compile, 122 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Seven factor selectors and rationales match webapp labels/options and defaults. Explicit edits and rationale clearing accept the calculated proposal while preserving unknown nested metadata and input focus; unrelated edits/reopen retain manual overrides. Real-control regressions cover every factor/rationale, absent defaults, escaped text, configured computations, autosave, explicit-save handler, undo/redo and reopen; retained cost/legacy/Bug Bar and capability tests pass. No fixture/schema edits or live VS Code validation; explicit save uses the UI payload through the host handler (no save button). EXT-T1c closes with both children verified; EXT-T1 remains open for EXT-T1d schema compatibility. |
| EXT-T1c1 | ✅ | ✅ PASS | ✅ PASS (compile, 122 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Re-sized EXT-T1c L and split into two M children. Cost-based/default mode now offers skill/access controls, calculated probability/proposal and accepted-likelihood warnings using the tested browser helpers; Bug Bar remains available and legacy mode is retained. Explicit edits accept proposals with configured weights/access/thresholds and selected SL-C capability, including unfeasible L0 and recovery; render/mode changes and unrelated edits preserve stored manual overrides and metadata. Real-control regressions cover defaults, configured 12.5%→L3 and 10%→L2 calculations, capability transitions, mode switching, autosave and undo/redo/reopen; substituting the base wizard in memory fails on the missing skill control. No fixture/schema edits or manual VS Code validation. Parent EXT-T1/T1c remain open; factor/rationale controls and clearing remain EXT-T1c2, schema compatibility remains EXT-T1d. |
| EXT-T1b | ✅ | ✅ PASS | ✅ PASS (compile, 122 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | CommonJS/browser threat model reuses weighted costs and thresholds, defaults missing factors to 3, and matches configured access probabilities, capability gating and explicit-update status transitions. Pure reads preserve accepted likelihood; explicit immutable updates preserve unrelated metadata and support map clearing. Tests execute actual webapp calculator read/update code across defaults, edits, partial/zero/negative weights and threshold boundaries; frozen-input/browser checks pass. Negative controls reject tree-step probability substitution and metadata loss. Tree behavior unchanged; no UI/schema/fixture edits or manual VS Code session. Parent EXT-T1 remains open; controls and L0 schema compatibility remain EXT-T1c/d. |
| EXT-T1a | ✅ | ✅ Finding fixed and regression verified | ✅ PASS (compile, 116 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Split L EXT-T1; persistence child only. Both save paths retain six cost/skill/access fields and independent accepted likelihood, including zero. Explicit omission preserves saved fields; autosave snapshots retain omission; null removes optional fields; empty maps/strings clear assessments. Unknown row/nested metadata and document envelopes preserved. In-memory runtime coverage exercises new/existing rows, absent defaults, edits/clearing, reopen and undo/redo. Verifier found the UI likelihood clamp still forced L0 to L1; fixed in the one allowed round with a real input/autosave/undo/redo/reopen regression and full baseline rerun. Computation, cost controls and schema compatibility remain EXT-T1b/c/d; no fixtures changed or manual VS Code session. |
| EXT-A2 | ✅ | ✅ PASS | ✅ PASS (compile, 116 model assertions, 6 parsed scripts + 6 runtime webviews, diff check) | Normalizes project cost weights and propagates them through all gates, residual assessments and OR alternatives. Direct webapp parity tests cover defaults, configured/partial/zero/negative weights, clamping, unassessed nodes, ties and legacy modifiers; weighted-OR negative control fails against HEAD before this item. Editor loads `project.costFactorWeights` and refreshes metrics on valid project document edits without tree writes/history resets. CommonJS/browser compatibility and public unassessed `stepProb()` behavior preserved. No fixture edits or EXT-T1 work; no filesystem watcher or manual VS Code session. |
| EXT-R3 | ✅ | ✅ PASS (direct diff review) | ✅ PASS (compile, 112 model assertions, 6 parsed scripts + 6 runtime webviews) | Explicit save and autosave merge threat/CM arrays into existing envelopes, including the project-autosave threat update; row normalization is unchanged. In-memory regressions cover both document kinds and save paths, nested/zero/null metadata, intermediate writes and reopen. Uses webapp document field names; envelope preservation follows this round-trip AC (webapp save currently replaces envelopes too). No fixture JSON edits or manual VS Code UI session. |
| EXT-B1 | ✅ | ✅ PASS | ✅ PASS (compile, 112 model assertions, 6 parsed scripts + 6 runtime webviews) | Shared threat/residual scenario matrix loads bundled Bug Bar rule, labels and scenarios. Matches webapp toggle-clear, four-axis maximum (empty → 0), rating date, selected/filled states and missing/unavailable hints. Runtime tests cover escaped catalogue text, unknown row/link/dimension metadata, autosave, undo/redo and reopen; negative control fails against the previous wizard. No fixture/catalogue JSON edits. Pre-existing envelope metadata loss tracked separately as EXT-R3; no manual VS Code UI session. |
| EXT-C1 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Adds negative effects, product/deployment/shared responsibility, verification evidence and per-link assessor/date display. Assessor and guided residual edits stamp the date; new links inherit threat provenance. Ticket lists read legacy `ticketUrl`, trim blanks and synchronize the primary link. Tests cover both save paths, clearing/omission, undo/redo, reopen, status-dependent fields, unknown metadata and invalid-input rejection. |
| EXT-REQ1 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Checkbox and badges follow webapp derivation rules: CM links force checked/disabled and set the flag on linking; removing the last link retains the flag. Tests cover absent/false/true flags, threat-only and CM-linked rows, multiple links, persisted undo/redo, reopen and unknown row fields. Uses the backlog's badge wording (webapp labels these `is CM` / `standalone`). |
| EXT-SYS3 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Asset headers show type and C/I/A/S badges with webapp defaults. Summaries update immediately without replacing the active editor; tests cover zero/missing objectives, escaped custom types, every objective edit, undo/redo, save/reopen and metadata preservation. |
| EXT-SYS2 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Adds interface chip tags and the webapp's hidden-only visibility reset; unhide persists a boolean and supports undo/redo. Native DFD now respects `hidden` and watches system metadata so tag/visibility changes refresh open canvases. Tests cover save/reopen, clearing, metadata preservation, literal chip text, live hide/unhide and watcher disposal. |
| EXT-SYS1 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Adds trust-zone and multiline description fields using the existing component save/history paths. Tests cover populated/missing values, literal markup, edits, tab switches, undo/redo, save/reopen, clearing and unknown component metadata. Description is in the shared schema but not currently exposed by webapp `SystemPanel.tsx`. |
| EXT-PRJ6 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Branch/PR and KB Git URLs merge into `repo`, including on legacy projects without it. Tests cover HTTPS queries, SSH Git syntax, undo/redo, save/reopen, clearing, unknown repo keys and invalid text rejection. Also verifies explicit project-save messages normalize scope/CRA lists and preserve omitted new fields. |
| EXT-PRJ5 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Intended purpose and foreseeable-use scenarios use the webapp's top-level fields. Reuses the list editor with multiline scenario rows; tests cover literal markup/newlines, editing, add/remove, undo/redo, save/reopen, clearing and preservation of unrelated project metadata. |
| EXT-PRJ4 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Reusable add/edit/remove row editor follows the wizard's existing list UI; both save handlers trim text and drop blank rows while preserving other scope keys. Runtime tests cover list loading, add/edit/remove undo/redo, save/reopen, literal markup, whitespace-only rows, clearing and invalid-list rejection. |
| EXT-PRJ3 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Status selector matches all four webapp values and defaults legacy projects to draft. Runtime tests cover each value, undo/redo, save/reopen and whole-project metadata preservation; both save handlers reject invalid statuses with an explicit error before writing. |
| EXT-PRJ2 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Device type, version and model reference use the shared `device` fields; both save handlers merge into existing metadata. Runtime coverage verifies loading, editing, undo/redo, clearing and reopening all three fields. `modelReference` is defined in webapp `types.ts` but currently absent from `ProjectPanel.tsx`. |
| EXT-PRJ1 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests) | Project title is loaded, edited and saved independently of device name; runtime tests cover literal text, clearing, reopen, metadata preservation and persisted keyboard/toolbar undo/redo. Fixed undo/redo not scheduling auto-save after an earlier save completed. |
| EXT-DFD2 | ✅ | ✅ | ✅ PASS (compile, 112 model assertions, parse + runtime smoke tests; regression failed before fix) | Cleans parent and endpoint references in all four layout maps, including nested descendants; preserves absent/empty maps and similarly named IDs. Corrected stale reference: current webapp deletion is in `Inspector.tsx`, not the store, and does not clean these maps. Extension retains its existing recursive deletion behavior. |
| EXT-DFD1 | ✅ | ✅ | ✅ PASS (compile, 106 model assertions, parse + runtime smoke tests) | Synthetic webapp-format fixture checks all layout maps, handles, component references, dimensions and unknown nested metadata after each edit and JSON serialization; unrelated node/flow deletion restores the original document. |
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
