# EmbedRisk

<div align="center">
  <img src="vscode-extension/media/embedrisk-logo.svg" alt="EmbedRisk" width="120" />
  <h1>EmbedRisk</h1>
  <p><strong>Threat and Risk Assessment (TRA) for embedded OT field devices, built for engineering teams.</strong></p>
</div>

EmbedRisk provides a practical TRA workflow with two tools that share one JSON-based project format:

- a web application for collaborative modeling and review,
- a VS Code extension for native editor-based workflows.

Both tools focus on structured, traceable assessments for IEC 62443-oriented product security engineering.

## Repository contents

| Directory | Purpose |
|---|---|
| [webapp/](webapp/) | TRA web application (React + Node): guided workflow, layered DFD canvas, risk logic, report generation |
| [vscode-extension/](vscode-extension/) | EmbedRisk VS Code extension: guided wizard, native DFD and attack-tree editors, report command |
| [knowledge_base/](knowledge_base/) | Embedded OT threat knowledge base (EMB3D, CWE, CAPEC, ESTM, OWASP) |
| [tools/](tools/) | Utility scripts (DFD conversion, report generation, model tests) |

## What EmbedRisk supports

- Structured TRA steps with one artifact file per step.
- STRIDE-based threat modeling grounded in OT device context.
- Layered DFD modeling with trust boundaries and interfaces.
- In VS Code, the Explorer DFD Overview presents project layers as a read-only tree; selecting a node opens its layer in draw.io, but cannot focus that specific node.
- Risk scoring with a configurable 5x5 scheme (Likelihood x Impact).
- Optional attack trees for deeper threat decomposition.
- Threat to requirement to countermeasure traceability.
- HTML report generation from project artifacts.

## Quick start

### Web app

1. Open a terminal in [webapp/](webapp/).
2. Install dependencies.
3. Build the client.
4. Start the server.

Commands:

    cd webapp
    npm install
    npm run build
    npm start

Default URL: http://localhost:4317

### VS Code extension

Install the latest VSIX from [vscode-extension/](vscode-extension/) or build from source:

    cd vscode-extension
    npm install
    npm run compile

Then in VS Code run the command: EmbedRisk: New Project

## Shared project format

The web app and extension read and write the same on-disk format (one folder per TRA project):

    <project-root>/
      01-project-description/project.json
      02-assumptions/assumptions.json
      03-system-assets/system.json
      04-dfd/dfd.json
      05-requirements/requirements.json
      06-threats/threats.json
      07-attack-trees/attack-trees.json
      08-countermeasures/countermeasures.json
      09-defects/defects.json
      report/index.html

Use either tool interchangeably, or edit JSON directly when needed.

## How to perform TRA with EmbedRisk

Read [docs/HOW-TO-TRA.md](docs/HOW-TO-TRA.md) for:

- what TRA is and where it fits in development,
- what to prepare before modeling in EmbedRisk,
- a practical step-by-step modeling workflow,
- a short list of high-value further reading.

## AI-assisted TRA workflow

This repository also ships a GitHub Copilot agent/prompt framework (under `.github/agents/`,
`.github/prompts/`, `.github/instructions/`) that can interview an engineer through a TRA, review a
project for consistency, or spar on assumptions — see [.ai/README.md](.ai/README.md) for the full
framework.

**Write policy**: the TRA Facilitator agent writes to a project's step JSON files by default, as
soon as a change is ready, rather than pausing for a separate approval message before every write.
This is a deliberate choice: the intended workspace is VS Code with git integration alongside the
EmbedRisk webapp, so every change is already easily reverted and tracked — even purely locally,
without a remote — through git history. The webapp itself only ever inspects whatever is already
written to the JSON files (it is a viewer/editor for a TRA, not an approval mechanism), so gating
writes in chat added friction without a matching safety benefit. If you'd rather review changes
before they're written, just tell the agent so during the session.

## Methodology and compliance context

EmbedRisk is designed to support secure product development workflows aligned with IEC 62443-4-1 and related regulatory expectations (for example, CRA-aligned traceability and evidence generation).

The risk method uses:

- Likelihood x Impact on a 5x5 matrix,
- impact dimensions across Confidentiality, Integrity, Availability, and Safety,
- attacker-profile-grounded assumptions to reduce subjective scoring.

## Knowledge base

The repository-level examples in [knowledge-base/](knowledge-base/) are intended as starter content. Teams should adapt and extend them with product-specific attacker assumptions, threat patterns, and approved controls.

## Data Attribution & AI Context

The `knowledge_base/` folder contains datasets derived from third-party sources used by the AI-assisted
TRA workflow. These datasets are **not** under GPLv3; each retains its upstream license. The key
sources and their required attributions are:

| Dataset | Rights holder | License |
|---|---|---|
| EMB3D™ | The MITRE Corporation | MITRE custom (permissive); notify [EMB3D@mitre.org](mailto:EMB3D@mitre.org) |
| CAPEC™ | The MITRE Corporation | MITRE custom (permissive) |
| CWE™ | The MITRE Corporation | MITRE custom (permissive) |
| ESTM | The MITRE Corporation / U.S. Government | Distribution Statement A (unlimited release) |
| OWASP Top Ten 2025 | OWASP Top 10 Team | [CC BY 3.0 Unported](http://creativecommons.org/licenses/by/3.0/deed.en_US) |

**Required EMB3D notice:** ©2026 The MITRE Corporation. This work is reproduced and distributed
with the permission of The MITRE Corporation.

Full attribution text, verbatim disclaimer blocks, and redistribution obligations are in
[knowledge_base/README.md](knowledge_base/README.md). Third-party software notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

EmbedRisk repository-authored code is licensed under GNU GPLv3. See [LICENSE](LICENSE).

This repository also ships third-party materials (notably the optional vendored draw.io webapp in
`vscode-extension/media/drawio/`) that remain under their own upstream licenses.

For details and distribution obligations, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
