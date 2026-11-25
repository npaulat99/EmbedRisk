# EmbedRisk AI framework

This folder documents the GitHub Copilot agent/prompt framework that assists engineers running a
Threat and Risk Assessment (TRA) with EmbedRisk. It supersedes the original concept draft in
[.ai/todo.md](./todo.md); that file is kept for historical reference only.

The framework is not a generic chatbot. It is a structured engineering assistant that guides the TRA
workflow described in [docs/HOW-TO-TRA.md](../docs/HOW-TO-TRA.md), asks targeted questions instead of
guessing, and writes to a TRA project's JSON files by default as soon as a change is ready — git (and
the `.tra-knowledge.json` decision log) provide the audit trail and revert path, unless the user
explicitly asks to review a change before it is written.

## Where the pieces live

VS Code discovers Copilot customizations from fixed locations, so the executable parts of this
framework live under `.github/`, following the same convention as the existing
[.github/copilot-instructions.md](../.github/copilot-instructions.md). This folder (`.ai/`) holds the
non-executable, human-facing parts: this README, the knowledge-file schema, and worked examples.

| What | Where | Notes |
|---|---|---|
| Agents | [.github/agents/](../.github/agents/) | Personas with restricted tools, see below |
| Chat skills | [.github/skills/](../.github/skills/) | On-demand interview, review, plausibility, and summary workflows |
| Instructions | [.github/instructions/](../.github/instructions/) | Auto-attached rules for TRA JSON / knowledge-file edits |
| Knowledge-file schema | [.ai/knowledge/tra-knowledge.schema.json](./knowledge/tra-knowledge.schema.json) (formal) + [knowledge-schema.md](./knowledge/knowledge-schema.md) (walkthrough) | The `.tra-knowledge.json` sidecar format |
| Examples | [.ai/examples/](./examples/) | A worked interview excerpt, a review report, a sample knowledge file |

## Agents

| Agent | File | Role | Writes files? |
|---|---|---|---|
| TRA Facilitator | [tra-facilitator.agent.md](../.github/agents/tra-facilitator.agent.md) | Primary orchestrator: interviews the user, coordinates the other agents, runs the state-based workflow, is the only agent that writes TRA JSON, by default immediately after summarizing a change | Yes, by default |
| Context Extractor | [tra-context-extractor.agent.md](../.github/agents/tra-context-extractor.agent.md) | Subagent: reads existing project files, reports facts found and gaps | No |
| Threat Analyst | [tra-threat-analyst.agent.md](../.github/agents/tra-threat-analyst.agent.md) | Subagent: proposes STRIDE threats and Likelihood x Impact ratings with cited evidence | No |
| Mitigation Advisor | [tra-mitigation-advisor.agent.md](../.github/agents/tra-mitigation-advisor.agent.md) | Subagent: proposes countermeasures mapped to threats, OT-constraint aware | No |
| TRA Reviewer | [tra-reviewer.agent.md](../.github/agents/tra-reviewer.agent.md) | Standalone or subagent: schema/consistency/plausibility review, structured report | No |
| Sparring Partner | [tra-sparring-partner.agent.md](../.github/agents/tra-sparring-partner.agent.md) | Standalone: discusses and challenges decisions, explores alternatives | Never |

Use the agent picker in VS Code chat to run **TRA Facilitator**, **TRA Reviewer**, or
**Sparring Partner** directly. The other three are subagents the Facilitator delegates to; they are
not meant to be picked directly (`user-invocable: false`).

## Chat skills

| Skill | File | Use for |
|---|---|---|
| Prepare a TRA interview | [tra-prepare-interview](../.github/skills/tra-prepare-interview/SKILL.md) | Run gap analysis and preview the question queue before interviewing |
| Review a single TRA | [tra-review-single](../.github/skills/tra-review-single/SKILL.md) | Full schema/plausibility review of one project |
| Review multiple TRAs | [tra-review-multiple](../.github/skills/tra-review-multiple/SKILL.md) | Cross-project consistency across comparable devices |
| Plausibility check | [tra-plausibility-check](../.github/skills/tra-plausibility-check/SKILL.md) | Quick sanity pass without a full audit |
| Challenge assumptions | [tra-challenge-assumptions](../.github/skills/tra-challenge-assumptions/SKILL.md) | Sparring session on recorded assumptions |
| Management summary | [tra-management-summary](../.github/skills/tra-management-summary/SKILL.md) | Non-technical release or milestone summary |

Run these through their skill descriptions in Copilot Chat.

## Structured knowledge persistence

Each TRA project folder (sibling to `01-project-description/`, ..., `09-defects/`) can have a
`.tra-knowledge.json` sidecar file. It is **not** part of the shared TRA schema — the webapp and the
VS Code extension never read it, and `webapp/server/src/validate.js` never validates it — it exists
purely so a Copilot session remembers what has already been asked and answered, across sessions,
without re-interviewing the user.

It stores, per [.ai/knowledge/tra-knowledge.schema.json](./knowledge/tra-knowledge.schema.json) (the
formal schema; [.ai/knowledge/knowledge-schema.md](./knowledge/knowledge-schema.md) is a prose
walkthrough of it):

- the open/answered interview question queue (tagged `fact`, `assumption`,
  `recommendation-accepted`, or `recommendation-rejected`),
- confirmed context not yet promoted into an official step file (assets, communication paths, trust
  boundaries, authentication methods, maintenance access, availability requirements, constraints),
- a decision log of every write to a TRA JSON file, with rationale and who authored/approved it.

The Facilitator reads and updates it freely (no approval needed — it's AI working memory, not a TRA
artifact) and always consults it before asking a question, so returning to a project in a new
session picks up where it left off. See
[.ai/examples/example.tra-knowledge.json](./examples/example.tra-knowledge.json) and
[.ai/examples/example-interview-excerpt.md](./examples/example-interview-excerpt.md) for a worked
example.

## The write workflow

The Facilitator runs a state-based workflow: **repository analysis -> context extraction -> gap
analysis -> user interview -> draft generation -> user review -> JSON update -> final review**. By
default, "user review" and "JSON update" happen back to back: the Facilitator presents a concise
summary of what changes, in which file(s), and why, then writes each change immediately after
presenting its summary — it does not wait for a separate confirmation message. This default exists
because the intended workspace pairs VS Code with git and the EmbedRisk webapp (a viewer/editor that
only ever displays whatever is already written, and cannot itself gate anything), so every write is
reversible and auditable through git history — even purely local, unpushed history — and through the
`.tra-knowledge.json` decision log.

The only exception: if the user explicitly requests review before writing (for this session or as a
standing preference), the Facilitator stops and waits for confirmation before writing. This is
documented consistently in
[tra-json-editing.instructions.md](../.github/instructions/tra-json-editing.instructions.md) and
partly enforced by tool restriction (only the Facilitator has the `edit` tool; every subagent and the
Reviewer/Sparring Partner are read-only), so no other agent can write TRA JSON without going through
the Facilitator's summarize-then-write step.

## No implicit assumptions

Whenever required information is missing, agents must ask a focused question rather than invent an
answer, and must label every statement as one of: **fact** (from a file or a prior answer),
**user-provided information** (this session's answer), **assumption** (a working assumption the user
explicitly confirmed), or **recommendation** (the AI's proposal, clearly flagged as AI-authored when
written). This applies to all agents, not just the Facilitator — see each agent file's own constraints
section.

## EN 40000-1-2 project fields

The shared project manifest can optionally record `productContext.functions[]` (name and description), `productContext.users` (description and vulnerable groups), `productContext.evidence[]` (title, reference, clause), and `riskCriteria` (scheme justification/source and the regulation, contract, risk-nature, user, product-type, and state-of-the-art inputs). Ask for missing facts; do not write a rationale simply to silence a notice.

For threats, `cause` and `compromisedObjectives` are optional 6.4.3.3 fields. STRIDE may suggest objectives, but the suggestion is never preselected or asserted as fact. The user must confirm the assessed objectives and cause. `avoided` is a valid treatment only when an evidenced design or context change removes the risk; record that change in `avoidanceRationale`. `transferred` needs a reason naming who receives the risk and how they are informed. Above-criteria acceptance records `acceptanceDeviation.circumstance` and, where known, `communicatedTo`; existing sign-off fields remain required. These rationales must be grounded in user-provided or project evidence, not generated by the agent to complete a form.

Use the RDPS convention in [EN 40000-1-2 Mapping](../docs/EN-40000-1-2-MAPPING.md): model a remote data processing solution as an external-entity component and record its operator, data paths, trust/authentication relationship, and restricted states only as those facts become known. A composite scenario is one threat or an attack-tree goal rated by the active scheme; dashboard band counts are not a combined score.

## Protocol limitations vs. product vulnerabilities

EmbedRisk assesses one OT component at a time, but that component is always deployed as part of a
larger industrial system. Many industrial communication protocols (Modbus RTU, HART, older fieldbus
variants) inherently lack modern capabilities such as cryptographic source authentication, integrity
protection, or encryption. This is a property of the protocol, not automatically a defect in the
component that uses it — and conflating the two produces a TRA that either invents a fictitious
product vulnerability, or drops a real threat because "the impact happens outside the component."

Both mistakes are wrong. The threat stays **in scope** of the component TRA whenever the component
exposes or relies on the limitation; what changes is who is responsible for closing the gap, and the
`Threat.classification` field on `06-threats/threats.json` records exactly that:

| classification | meaning | typical `responsibility` |
|---|---|---|
| `product-vulnerability` | a weakness in the component's own implementation/security architecture, reasonably fixable by the manufacturer | `manufacturer` |
| `protocol-limitation` | a capability the selected protocol fundamentally does not provide (e.g. no source authentication in Modbus RTU) | `integrator-operator` |
| `deployment-risk` | the risk comes from a particular plant architecture/trust environment, not the component or protocol | `integrator-operator` |
| `shared-responsibility` | meaningful risk reduction needs both a product capability and a system/deployment control | `shared` |

The manufacturer is never allowed to just "transfer" a threat away by relabeling it — the TRA must
still document the limitation, its security implications, any product-level mitigation actually
available (recorded in `08-countermeasures/countermeasures.json` with `responsibility: 'product'`),
and the deployment conditions required to make the residual risk acceptable
(`Threat.deploymentConstraints`, or a `responsibility: 'deployment'` countermeasure). The
integrator/operator is responsible for actually applying those deployment/architectural controls in
the real plant — evaluating that is a system-level TRA's job, not this component TRA's, but the
component TRA must state clearly what it is assuming the system level will provide.

**How an agent should reason about a protocol-related threat** — the Threat Analyst and Reviewer
should work through these questions explicitly, and ask the user rather than guessing whenever the
project's files don't yet answer them:

1. Is the security weakness inherent to the protocol itself?
2. Is there, additionally, a weakness in this component's own implementation?
3. Can the component reasonably mitigate the threat itself (e.g. a local write-protect switch, an
   optional authenticated transport mode)?
4. If not, which compensating controls must exist at the system/deployment level (segmentation,
   physical bus protection, gateway architecture, monitoring)?
5. Who is responsible for each mitigation — manufacturer, integrator/operator, or both?
6. Does the actual impact depend on the plant/system context the component will be deployed into?

Do not invent a product vulnerability merely because a protocol lacks a security capability, and do
not dismiss an inherent protocol limitation as irrelevant to the component TRA — it is relevant
whenever the component exposes or relies on it. If the distinction can't be made from the available
project information, ask the user instead of picking one silently; when reviewing an existing threat,
an agent may recommend changing its `classification`/`responsibility`, but must explain why, and must
never silently reclassify a threat the user already rated without flagging the change and its
rationale first.

## Using this with EmbedRisk in VS Code

1. Open the repository in VS Code with GitHub Copilot Chat.
2. To start or continue a TRA, select the **TRA Facilitator** agent and point it at a project folder
   (e.g. `webapp/projects/test`, or a folder created via the VS Code extension's "EmbedRisk: New
   Project" command).
3. To review without going through the interview, use the **TRA Reviewer** agent or the
  `tra-review-single` / `tra-review-multiple` skills directly.
4. To discuss a decision without risking a file change, use the **Sparring Partner** agent or the
  `tra-challenge-assumptions` skill.
5. Review the Facilitator's written changes like any other code change — the `.tra-knowledge.json`
   decision log and the project's own git history together give a full audit trail of what changed,
   when, and why, and let you revert anything you disagree with.

## Testing and validating the framework

Because these are prompt-engineered behaviors, not code, most validation exercises the workflow
rather than unit-testing prose — but two parts of the framework *are* plain executable checks:

- **Schema/plausibility validator, runnable directly**: `node webapp/server/src/validate-cli.js
  <path-to-project-folder>` (from the repository root), or `npm run validate -- <path-to-project>`
  from [webapp/](../webapp/) (e.g. `npm run validate -- projects/test`). It loads a project's step
  files exactly as the server does and runs the same `validate()` from
  [webapp/server/src/validate.js](../webapp/server/src/validate.js) — no file writes, safe for CI.
  Compare its output to what the `tra-reviewer` agent reports on the same project; a mismatch means
  an agent instruction has drifted from the actual schema in `webapp/client/src/types.ts`.
- **Knowledge-file schema check**: `node tools/validate-knowledge-file.mjs
  <path-to-.tra-knowledge.json>` checks a sidecar file against
  [.ai/knowledge/tra-knowledge.schema.json](./knowledge/tra-knowledge.schema.json).
- **Framework acceptance check**: `node tools/test-tra-framework.mjs` statically verifies the
  write-restriction mechanism (only `tra-facilitator` has the `edit` tool; every other agent is
  read-only), that the default-write policy and its explicit-review exception are documented
  consistently between the Facilitator and `tra-json-editing.instructions.md`, that the
  one-question-at-a-time interview rule is documented, and that the DFD trust-boundary id-alias
  exception is stated consistently. It falsifies a broken write restriction (e.g. someone adding
  `edit` to a subagent) without requiring a live model run.

The remaining behaviors still require exercising the workflow in chat:

- **Dry-run the Facilitator** against [webapp/projects/test](../webapp/projects/test/) (a
  deliberately sparse example project) and confirm it: asks one question at a time, creates
  `.tra-knowledge.json` without asking, and writes each step file right after summarizing it (no
  separate wait for a "yes").
- **Cross-session memory check**: answer a few interview questions, end the session, start a new one
  on the same project, and confirm the Facilitator does not re-ask anything already recorded in
  `.tra-knowledge.json`.
- **Explicit-review exception check (live)**: ask the Facilitator to review changes with you before
  writing them (for this session), then have it propose a change — it must stop and wait for your
  confirmation instead of writing immediately. Without that request, it should write directly.
- **Schema drift check**: whenever `webapp/client/src/types.ts` or `webapp/server/src/validate.js`
  changes, re-run `node tools/test-tra-framework.mjs` and re-check
  [tra-json-editing.instructions.md](../.github/instructions/tra-json-editing.instructions.md) and
  the Threat Analyst / Mitigation Advisor / Reviewer agent bodies for field names that no longer
  match.
- Treat `.tra-knowledge.json` as reviewable, git-tracked content: a PR that changes a project should
  make its knowledge-file diff (if any) as understandable as the JSON artifact diff.

## Future extension points

The structure is deliberately modular so new capability can be added as another subagent or prompt
without touching the Facilitator's core state machine:

- **IEC 62443 mapping**: a read-only subagent that maps requirements/countermeasures to IEC 62443-4-2
  CR/FR references, invoked from the Mitigation Advisor step.
- **Attack path analysis**: a subagent that reasons over `07-attack-trees/attack-trees.json` across
  multiple threats to find compound attack paths, invoked after the threat/countermeasure steps.
- **Project-wide consistency**: extend `tra-review-multiple` (or add a dedicated subagent) once more
  example projects exist, e.g. to check knowledge-base reuse drift across a whole product line.

Add new agents under `.github/agents/` and TRA skills under `.github/skills/`, and document them in
the tables above — do not create a parallel structure elsewhere.
