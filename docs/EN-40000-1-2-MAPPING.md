# EmbedRisk Mapping to EN 40000-1-2

EmbedRisk supports the risk-management workflow described in clause 6 of EN 40000-1-2; this mapping explains where the tool records and communicates the work. It is not a claim of compliance or certification, and the tool does not assess whether a project's content is adequate for its product or deployment.

## Diagrams

- [Risk-management overview](img/en40000-1-2-risk-management-overview.svg)
- [Risk-management process](img/en40000-1-2-risk-management.svg)

Regenerate both diagrams from this repository with `node docs/img/build-diagram.mjs`.

## EmbedRisk Methodology

A TRA project is a set of step artifacts under one project folder: project description, assumptions, system/assets, DFD, requirements, threats, attack trees, countermeasures, and defects. The central traceability chain is **asset -> threat -> risk rating -> requirement -> countermeasure -> residual risk**. Project versions and their reasons support lifecycle review; see [HOW-TO-TRA](HOW-TO-TRA.md).

The active risk scheme defines valid likelihood and impact values, their derivation, classification, and (where configured) acceptance levels. Projects bind to a scheme by ID and fingerprint. The report shows the scheme, version, fingerprint, matrix, justification, and recorded criteria inputs. See [RISK-SCHEMES](RISK-SCHEMES.md). A scheme's acceptance criteria apply to individual threats. EmbedRisk does not calculate an aggregate risk score across threats or assets.

## Clause Mapping

Coverage ratings describe tool support, not the adequacy of a particular assessment.

| Clause | Where in EmbedRisk | Coverage |
|---|---|---|
| 6.1 Risk management | Step artifacts, project status, version history, and the linked assessment workflow | Tool plus convention |
| 6.2 Product context | Project scope, intended and foreseeable use, `productContext`, environmental assumptions, components, interfaces, DFD, and evidence references | Tool plus convention |
| 6.3 Risk criteria and methodology | Active versioned risk scheme, acceptable level, project `riskCriteria`, and report rationale | Tool plus convention |
| 6.4 Risk assessment | Assets and objectives; STRIDE threats; optional `compromisedObjectives` and `cause`; scheme-driven likelihood/impact; residual-risk traceability | Tool |
| 6.5 Risk treatment | Mitigation, acceptance, transfer, avoidance, and feasibility statuses; rationale checks; countermeasure residual ratings | Tool plus convention |
| 6.6 Risk communication | Report disclosure of residual risks, responsibilities, deployment constraints, avoidance rationales, and accepted deviations | Tool plus convention |
| 6.7 Review | Version history, change reasons, per-threat `reviewDate`, defects, and risk-scheme fingerprint checks | Tool plus convention |

Project records and reports are structured by the tool. Judging whether the recorded functions, threats, ratings, controls, evidence, and disclosures are complete or technically adequate remains an assessor and organization responsibility. In particular, stakeholder-specific wording and the justified review frequency are outside the tool.

## 6.7 Review

EmbedRisk supports review with versioned baselines, assessors, summaries, and change reasons (`initial`, `functional changes`, `new vulnerabilities`, and `regular reassessment`). Threats can carry a next `reviewDate`; overdue dates and open defects linked to threats are surfaced by validation. A changed or unavailable risk-scheme fingerprint also prevents silent reclassification.

The justified reassessment frequency required by the organization is not calculated by EmbedRisk. The organization defines it. As a convention, record the frequency and its owner as an `operational` assumption so it travels with the project; this is not a dedicated project field. The source text available in this repository does not include the full requirements of clause 6.7, so this mapping describes only the support evidenced by the current tool and clause 6.1's review trigger.

## RDPS Convention

A remote data processing solution (RDPS) is modeled as a `Component` with `kind: "external-entity"`, outside the device trust boundary. Use the existing fields and connected artifacts to record these facts:

| RDPS fact | EmbedRisk location |
|---|---|
| Operator and responsibility | First sentence of `description`; use `supplier` and `provenance` (`own` or `third-party`) where known |
| Data exchanged | Step 04 flows; link relevant assets to the RDPS through `components` |
| Trust and authentication relationship | Interface `protocol` plus a `system` assumption for each trust or authentication premise |
| Restricted states, such as offline or degraded operation | A requirement per state, linked to the availability threat |
| Trust boundary | Keep the RDPS outside the device trust boundary |

This is a modeling convention, not a separate RDPS schema or automatic completeness check. Ask the project owner when operator, trust, or restricted-state details are unknown; do not infer them from the presence of a cloud component.

## Aggregation Convention

Model a composite scenario as one threat, or as an attack-tree goal linked to the relevant threat. Rate it with the project's active scheme. The dashboard can show counts per risk band, but those counts are not combined into a score. **EmbedRisk has no combined risk score across threats or assets.**

## Treatment Options

| Treatment | Data and checks |
|---|---|
| Mitigate | Link requirements and countermeasures; record residual likelihood and impact and re-evaluate against the active scheme. |
| Accept | Record `acceptedBy`, `acceptanceRationale`, and `reviewDate`. If the residual exceeds the acceptance criteria, add `acceptanceDeviation.circumstance` and, where applicable, `communicatedTo`. |
| Transfer | Record `transferRationale` (recipient and how they are informed) and link a requirement documenting the user-guide communication. The residual risk remains visible. |
| Avoid | Set `status: "avoided"` only when a design or context change removes the risk; record that change in `avoidanceRationale`. A missing rationale warns, and a dismissible notice asks for a requirement or assumption that records the changed context. Ratings remain visible; the risk engine is unchanged. |
| Unfeasible | The feasibility model can derive this status when the required attacker capability exceeds the selected attacker profile. It is not a substitute for documenting the threat assessment. |

The standard's treatment priority order is not enforced by the tool. The assessor should record and justify why a lower-priority option was selected when a higher-priority option was not suitable. `cause` and `compromisedObjectives` are optional for backward compatibility; one dismissible notice identifies threats with neither field, and does not invent their contents.

## Risk Communication

The generated report includes a traceability matrix and a residual-risk disclosure section. The disclosure groups risks by responsibility, lists avoided risks and accepted deviations, and shows deployment constraints and linked requirement IDs. Within-criteria statements are derived from the active scheme and project acceptance level; they are not stored as a separate user decision. Evidence references are linked only when they pass the safe HTTP(S)/project-relative path policy; unsafe references remain escaped text with a visible “not linked” hint.

These outputs support communication under 6.6. The organization remains responsible for choosing recipients, tailoring wording and accessibility to stakeholders, and ensuring users and integrators understand the assumptions and measures that apply to them.

## Known Limits

- The tool does not assess the adequacy of project-specific content or provide certification.
- The priority order of avoid, mitigate, accept, and transfer is not enforced.
- `compromisedObjectives` and `cause` remain optional; V-09 is a single dismissible notice, not a completeness gate.
- Product context is structured, but RDPS details use the convention above and are not independently validated.
- Aggregated-risk support is a modeling convention; no combined score is calculated.
- The justified review frequency is organizational, and full clause 6.7 requirements are not present in the source text currently available in the repository.
