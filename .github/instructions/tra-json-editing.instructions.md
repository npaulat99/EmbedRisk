---
description: "Use when creating or modifying TRA step JSON files (project.json, assumptions.json, system.json, dfd.json, requirements.json, threats.json, attack-trees.json, countermeasures.json, defects.json) in an EmbedRisk project. Covers the write policy, id conventions, and field names shared by both the webapp and the VS Code extension."
applyTo: "**/01-project-description/*.json,**/02-assumptions/*.json,**/03-system-assets/*.json,**/04-dfd/*.json,**/04b-use-cases/*.json,**/05-requirements/*.json,**/06-threats/*.json,**/07-attack-trees/*.json,**/08-countermeasures/*.json,**/09-defects/*.json"
---
# Editing TRA step JSON files

These files are the shared, on-disk TRA schema read and written by both `webapp/server` and
`vscode-extension`. Do not add, rename, or remove fields — only populate the existing schema (see
`webapp/client/src/types.ts` for the authoritative field list per step).

## Write policy

By default, write each change immediately after presenting its summary — do not wait for a separate
confirmation message. This default exists because the intended workspace pairs VS Code with git and
the EmbedRisk webapp (a viewer/editor that only ever displays whatever is already written), so every
write is reversible and auditable through git history and the `.tra-knowledge.json` decision log.
This applies whether you are the TRA Facilitator or invoked directly for a quick edit.

The only exception: if the user explicitly requests review before writing (for this session or as a
standing preference), stop and wait for confirmation before writing. Still clearly label
recommendation-derived content versus facts/assumptions in the summary you present, and log what
changed and why in `.tra-knowledge.json.decisionLog` (if the project has one) so the change stays
auditable after the fact.

## Identifiers

- Every id (component, interface, trust boundary, asset, threat, requirement, countermeasure, attack
  tree, defect, attacker profile, DFD node) must match `^[A-Za-z0-9 _\-:.]+$` and be **unique across
  the whole project**, not just within its own file — id-space is shared project-wide.
- **One documented exception**: a `04-dfd/dfd.json` node of `type: trust-boundary` is allowed, and
  expected, to reuse the id of the matching `03-system-assets/system.json` trust boundary it
  represents — they are the same entity viewed from two files, not a duplicate. Do not "fix" this by
  renaming one of them; it is exactly what `webapp/server/src/validate.js` allows.
- Prefer short, stable, human-readable ids with a step-scoped prefix already used in the project
  (e.g. `AS-` assets, `T` threats, `CM-`/`ATK-` etc.) — check existing ids in the project before
  inventing a new prefix.

## Component hierarchy (layer/parent convention)

`system.components[]` models the device as a small tree, not a flat list — get this wrong and the
generated DFD layering breaks. The convention used by both the wizard scaffold
(`vscode-extension/src/extension.ts`) and hand-authored projects:

- **Layer 1** is reserved for the device itself (one root component, `kind: "device"`, `parent:
  null`) plus any layer-1 `external-entity` components (other systems the device talks to, e.g. a
  cloud backend or companion app) — external entities also have `parent: null`.
- **Layer 2** is every component that is a direct physical/logical part of the device — hardware
  blocks (MCU, radar front-end, HMI, power supply, external flash chip, etc.) and top-level software
  blocks, each with `parent` set to the layer-1 device id.
- **Layer 3+** is for sub-parts nested inside a layer-2 component (e.g. firmware/RTOS running on the
  MCU, or a secure element inside a cellular modem module) — `parent` is the containing layer-2 (or
  deeper) component's id, and `layer` increments accordingly.
- Do not put the device's own internal parts at layer 1, and do not leave a component's `parent`
  pointing at `null` unless it truly has no container (the device root, or an external entity).

## DFD flows and interface ports

`dfd.flows[].from`/`.to` are not limited to `dfd.nodes[].id` — they may, and for interface-mediated
traffic **should**, be a `system.interfaces[].id` instead. Interfaces are not DFD nodes: both tools
auto-render each interface as a chip/port wherever its owning component (or nearest visible ancestor
component) sits on the current layer (`webapp/client/src/components/dfd/DfdView.tsx`'s
`targetForComponent`/`visibleIfaceIds`, `webapp/client/src/state/store.ts`'s
`inferFlowBoundaryId`/`boundaryDepthsForEndpoint`, and `vscode-extension/src/nativeDfdEditor.ts`'s
ancestor-lookup chip rendering all resolve interface ids this way).

- **A flow that represents traffic over a modeled interface must use that interface's id as its
  `from` or `to` endpoint — not the component/device node the interface happens to resolve to on the
  current layer.** E.g. a Modbus RTU flow from the field device to the control system is `{"from":
  "IF-3", "to": "N-EXT-CTRL"}`, not `{"from": "N-DEV", "to": "N-EXT-CTRL"}`, even though at layer 1
  the chip visually renders on the device because `IF-3`'s actual component is nested deeper in the
  tree. Anchoring to the device/component node instead of the interface is a common mistake: it looks
  fine at a glance (the chip still appears, since chips render independent of flows) but leaves the
  flow line disconnected from the interface it is supposed to depict, and produces orphaned chips
  with no visible edge once you drill into a deeper layer.
- If one aggregate description would otherwise span several distinct interfaces (e.g. "process I/O"
  covering a 4-20 mA loop, HART, and Modbus interfaces), model one flow per interface rather than a
  single flow to the device/component node.
- Only connect two `dfd.nodes[]` ids directly for a path between modeled components that is **not**
  already represented by a `system.interfaces[]` entry (e.g. an internal signal path between two
  hardware blocks with no externally-modeled interface).
- `crossesBoundary` still works the same way with an interface-anchored flow — set it to the id of
  the trust boundary the flow crosses (usually the one containing the interface's resolved
  component), same as for a node-to-node flow.

### Only model what a user could draw through the actual UI

Editing the raw JSON gives you capabilities the webapp/extension UI does not expose to a real user —
do not use that extra reach. A `dfd.flows[]` entry (and, by extension, a `dfd.nodes[]`/`portPos`
entry) must only ever represent a connection a user could actually create by drag-connecting two
entities that are simultaneously rendered on the **same layer view** in the DFD editor. Concretely:

- Before adding a flow between an interface and a node, check both endpoints' effective layer: an
  interface resolves to the nearest ancestor node that is a **direct child of the layer currently
  being viewed** (see `resolveTargetNodeId` in `webapp/client/src/components/dfd/layerVisibility.js`).
  Only connect the interface to that resolved node (or to an external entity at layer 1) — never to
  a node nested one or more layers deeper than that resolution point, even if such a node happens to
  exist in `system.json`/`dfd.json`. A real user drilling into a layer never sees that deeper node
  and its own children simultaneously with the interface chip, so they could never draw that edge.
- If you need to depict what an attacker could reach *after* crossing an interface into a deeply
  nested internal asset (e.g. a debug interface's reach into secure key storage two layers down),
  that is attack-tree/threat-rationale content (`07-attack-trees/attack-trees.json`,
  `Threat.likelihoodRationale`), not a DFD flow — the DFD models normal data flow per layer, it does
  not model post-compromise reachability.
- The same principle applies to any other structured content you edit directly as JSON: only ever
  produce a state a user could reach with the tools/buttons the webapp or extension UI actually
  offers (drag-connect, drill-into, add-node, the property panels) for that step. Do not add content
  that requires knowledge of the raw schema a normal user wouldn't have.

## Traceability chain

Keep every new entry connected to the chain **asset -> threat -> risk rating -> requirement ->
countermeasure -> residual risk**:

- A threat should reference real `components`/`assets`/`interfaceRef` ids and, where a rating is
  claimed, an `attackerRef` whose `access` can plausibly reach the referenced interface's `exposure`.
- A threat at or above the active scheme's `highLevel` should get a `requirement` derived from it
  unless deliberately `status: accepted` (with `acceptedBy`, `acceptanceRationale`, `reviewDate` set).
- A countermeasure's `addresses[].threat` must reference an existing threat id, and a `preventive`
  countermeasure should lower `residualLikelihood`, not `residualImpact` (and vice versa for
  controls that reduce consequence rather than probability).

## Scheme-bound risk values

- Resolve `project.riskSchemeId` and verify `riskSchemeFingerprint` before interpreting ratings. For
  legacy projects without an ID, use the built-in mapping documented in
  [docs/RISK-SCHEMES.md](../../docs/RISK-SCHEMES.md).
- `likelihood`, `impact`, residual values, and `*Criteria` ratings must use values and criterion IDs
  defined by that active scheme. Do not assume a 1-5 range or infer a fixed score cutoff from the
  word "high"; use the scheme's levels, `highLevel`, and classification.
- If a scheme is unavailable or its fingerprint is stale, report the stored axis values as
  unclassified and ask for resolution. Do not silently reinterpret, clamp, or rewrite them.
- To create a user scheme from a requested rubric, follow
  [docs/RISK-SCHEMES.md](../../docs/RISK-SCHEMES.md); do not put scheme definitions in TRA step JSON.

## Attacker capability scale

Attacker `capability`, threat `requiredSkill` and attack-tree node `skill` use the 4-level threat-actor scale (1-4); a persisted legacy 5 is read as 4. Do not write 5 into these fields.

## Product context and risk criteria

The optional `project.productContext` fields are:

- `functions[]`: `name`, optional `description`.
- `users`: optional `description` and `vulnerableGroups[]`.
- `evidence[]`: `title`, `ref`, optional `clause`.

The optional `project.riskCriteria` fields are `schemeJustification`, `schemeSource`, and `inputs` (`regulation`, `contracts`, `riskNature`, `users`, `productType`, `stateOfTheArt`). These fields justify the active scheme and acceptance criteria; they do not alter the scheme or its fingerprint. List items have no IDs and are keyed by position. Keep the UI/schema limits: 50 functions, evidence items, or vulnerable groups; 200 characters for short labels/inputs and 2,000 for descriptions/justifications/references.

Evidence `ref` values may be HTTP(S) URLs or project-relative paths only. Never write credentials into a reference. Reject schemes other than HTTP(S), protocol-relative/absolute paths, backslashes, control characters, and any `..` path segment. Reports must pass refs through `safeHref`; an unsafe ref is rendered as escaped text, not a link.

For a remote data processing solution (RDPS), use an existing `external-entity` component and record the known operator/responsibility in `description`, supplier/provenance where known, exchanged data in DFD flows and asset links, trust/authentication in interface protocol and system assumptions, and offline/degraded behavior in requirements. This is a convention, not a new schema. Leave unknown facts open and ask; do not infer an operator or trust relationship from the component name.

## Threat structure and treatment

`Threat.compromisedObjectives` is an optional array drawn from `confidentiality`, `integrity`, `availability`, and `safety`; `Threat.cause` is optional free text. STRIDE may suggest objectives for discussion, but never silently preselect or persist a suggestion as an assessed fact. Preserve the existing `STRIDE` and impact-rating meanings; these new fields do not change scoring.

`status: avoided` is a closed treatment only when an evidenced design or context change removes the threat. Record that change in `avoidanceRationale`; do not use `avoided` to suppress a high rating. `acceptanceDeviation` records `circumstance` and optional `communicatedTo` only when an accepted residual is above the active acceptance criteria. The existing sign-off fields remain `acceptedBy`, `acceptanceRationale`, and `reviewDate`. `transferred` needs a `transferRationale` naming the recipient and how they are informed.

V-09 is one dismissible notice when at least one threat has neither `cause` nor `compromisedObjectives`; it is not a requirement to fill either field or a license to invent rationale. For all new narrative values, use evidence from the project or label a proposed value as a recommendation and ask the owner before treating it as fact.

## Do not silently default

Leave a field absent (or explicitly flag it as an open question) rather than filling it with a
plausible-sounding value the user has not confirmed — especially `likelihood`, `impact`,
`likelihoodFactors`, `impactDimensions`, `attackerRef`, and any `status`/date field.

## Protocol limitations vs. product vulnerabilities

An inherent limitation of a communication protocol (e.g. Modbus RTU's lack of cryptographic source
authentication) must **not** be silently classified as a vulnerability of the component using it, nor
silently dismissed as "not relevant to the component TRA" because the ultimate impact lands outside
the component. Use `Threat.classification` to record the root cause once it can be determined:

- `product-vulnerability` — a weakness in this component's own implementation/security architecture
  that the manufacturer could reasonably mitigate.
- `protocol-limitation` — a security capability the selected protocol fundamentally does not provide;
  the component merely exposes/relies on that limitation.
- `deployment-risk` — the risk comes from how the component is used in a particular plant
  architecture/trust environment, not from the component or protocol themselves.
- `shared-responsibility` — meaningful risk reduction requires both a product-level capability and a
  system/deployment-level control.

Pair it with `Threat.responsibility` (`manufacturer` / `integrator-operator` / `shared`) and, where
applicable, `Threat.deploymentConstraints` (free text: the compensating controls or conditions — e.g.
network segmentation, physical bus protection, gateway architecture, monitoring — required outside
the product boundary for the residual risk to be acceptable). Leave all three fields absent rather
than guessing if the evidence doesn't support a classification yet; ask the user instead (see
`.ai/README.md`'s "Protocol limitations vs. product vulnerabilities" section for the full reasoning
and the six questions to work through). A `Countermeasure` can carry the mirrored
`responsibility: 'product' | 'deployment' | 'shared'` field for the same reason, at the control level.

Never remove a threat from the component TRA merely because its ultimate impact occurs outside the
component (e.g. at the plant control system) — it stays in scope; only its classification/
responsibility changes to reflect where the mitigation must actually happen.

