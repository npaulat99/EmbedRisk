# TRA Studio — web application

A browser-based application for the **Threat & Risk Assessment (TRA)** methodology for embedded
OT field devices. It is a parallel alternative to the VS Code extension in [`../tra`](../tra):
the **layered Data Flow Diagram is the centrepiece**, surrounded by guided panels for every
methodology step, with a **live, bidirectional link to the JSON files** on disk.

> Edit in the UI and the JSON files update instantly. Edit a JSON file in your editor and the UI
> updates instantly. The project folder remains the single source of truth.

**Browser support:** The client uses Baseline Widely available web platform features only. Do not add fallbacks or polyfills for newer features; if a feature is newer, do not use it. Existing progressive enhancement stays unchanged.

## Why this design

| Requirement (project.md)                     | How it is met                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| DFD as the centre, with recursive layers     | React Flow canvas; trust boundaries enclose their members; external interfaces stay visible as you zoom in |
| Intuitive, modern UI/UX                       | Step navigation, contextual inspector, live risk badges, toolbar drill/inspect |
| Store information as JSON per step            | One JSON file per step under `projects/<id>/` (identical schema to `tra/`)      |
| Edit via UI **and** via JSON files (live)     | WebSocket sync + `chokidar` file watching with echo-suppression                |
| Risk rating (Bug Bar + CVSS)                  | Guided per-threat calculator: Bug Bar impact (max of C/I/A/Safety) + 4-factor likelihood; CVSS informs exploitability |
| Optional attack-defence trees                 | AND/OR/SAND gates (Kordy/Jhawar), per-step access/skill/cost, defence + vulnerability nodes, deterministic metrics |
| Future export formats                         | The risk engine returns structured data; HTML report today, others pluggable   |

## Architecture

```
tra-webapp/
  server/            Node (Express + ws + chokidar) — REST + WebSocket, file watching, report
    src/index.js       wiring: API, WebSocket, file watcher
    src/artifacts.js   step <-> file mapping, read/write, hash-based echo suppression, scaffolding
    src/risk.js        Risk = Likelihood x Impact, bands, residual
    src/validate.js    plausibility checker (incl. trust-boundary + attack-tree checks)
    src/report.js      standalone HTML report (mirrors tra/tools/generate_report.py)
    src/git.js         pull shared knowledge base (read-only) + commit a project to its own repo
  client/            Vite + React + React Flow + zustand
    src/components/dfd/   the layered DFD canvas (the centrepiece)
    src/components/panels/ one panel per step
    src/state/store.ts    state + live-sync transport
  .assets/knowledge-base/  risk scheme + reusable threat/countermeasure library
  projects/<id>/           one folder per TRA project (seeded with the radar-sensor example)
```

### Live sync model

- A UI edit calls `save(step, value)` → optimistic local update → (debounced) WebSocket `save`
  → the server writes the JSON file and relays the change to **other** connected clients.
- The server watches the `projects/` tree. An **external** file edit (hash differs from the last
  value the server wrote) is broadcast to **all** clients, so the UI tracks hand-edited files live.
- Echoes of our own writes are suppressed by comparing content hashes, so there is no feedback loop.

## Run it

```bash
cd tra-webapp
npm install            # installs server + client (npm workspaces)
npm run build          # builds the client into client/dist
npm start              # serves UI + API + WebSocket on http://localhost:4317
```

Open <http://localhost:4317>.

The server binds to `0.0.0.0`, so it is reachable from outside the VM (e.g. the Windows host):
it prints a `network: http://<ip>:4317` URL on startup. Override the interface/port with the
`HOST` and `PORT` environment variables.

### Open a project from the shell

The webapp now ships a small CLI launcher named `embedrisk`.

- `embedrisk <folder>` opens the webapp against an existing TRA project folder or a projects root.
- `npm exec -- embedrisk <folder>` runs the same launcher from the local checkout without a global
  install.
- `npm install -g <path-to-webapp>` exposes the same `embedrisk` command anywhere on your machine.
- `npm run open -- <folder>` is a convenience alias inside the webapp package; it calls the same
  launcher.

If you already have a project folder on disk, the launcher can be started from **any shell location**
as long as the command is installed or you invoke it through `npm exec`. That is the main change
from the initial "clone the repo and run `npm start` inside `webapp/`" flow: `npm start` is still
the direct server start for the repo checkout, while `embedrisk` is the user-facing command for
opening an existing project root from the console.

Supported workflows:

1. Checkout-based (no global install; deterministic for scripts/CI)

```bash
# Run from anywhere, but execute the launcher from this checkout
npm --prefix /path/to/EmbedRisk/webapp exec -- embedrisk /path/to/projects-or-project
```

2. User-global command (best UX for daily use)

```bash
# One-time setup (Linux, no sudo; avoids /usr permission issues)
npm config set prefix "$HOME/.local"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm install -g /path/to/EmbedRisk/webapp

# Then from anywhere
embedrisk /path/to/projects-or-project
```

Recommended quick examples:

```bash
# From the cloned repository (no global install needed)
cd tra-webapp
npm exec -- embedrisk ../some-existing-projects-root

# From anywhere after a global install
embedrisk /path/to/projects
```

`embedrisk` is the console entry point. When it receives a single project folder, it opens the
project directly; when it receives a projects-container folder, it opens that container as-is.
The shell command is the same one the VS Code command uses internally.

### Development (hot reload)

```bash
npm run dev            # Vite dev server on :5173 (proxies API + WS to the backend on :4317)
```

### Point at a different project root

```bash
TRA_PROJECTS_DIR=/path/to/projects npm start
# e.g. reuse the extension's projects:  TRA_PROJECTS_DIR=../tra/projects npm start
```

### Webapp scripts reference

These are the npm scripts available in `webapp/`:

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the client and server together for hot reload. |
| `npm run dev:server` | Starts the Express/WebSocket backend only. |
| `npm run dev:client` | Starts the Vite client only. |
| `npm run build` | Builds the production client bundle into `client/dist`. |
| `npm run open -- <folder>` | Starts the `embedrisk` CLI launcher against `<folder>`. |
| `npm start` | Starts the low-level server entry point (`server/src/index.js`). |
| `npm run serve` | Builds the client, then runs `npm start`. |
| `npm test` | Runs the launcher regression tests. |
| `npm run lint` | Runs the package validation checks used by the repo workflow. |
| `npm run format:check` | Runs the package build check used by the repo workflow. |

Only `embedrisk`/`npm exec -- embedrisk` are meant to be the console-facing way to open an existing
project from anywhere. `npm start` remains the direct repo/server start path.

## DFD navigation

The DFD is the centrepiece. Navigation works through reliable toolbar controls and (where the
browser supports it) direct canvas interaction:

| Control                        | Action                                            |
| ------------------------------ | ------------------------------------------------- |
| **Select node…** menu / click  | select a node to edit in the inspector            |
| **double-click a node**        | open that component's sub-layer (offers to create one if none exists) |
| **▲ Up** button / breadcrumb   | return to the parent layer                        |
| **+ Process / Store / …**      | add a node to the current layer                   |
| Inspector → **Connections**    | add / label / delete data flows between nodes     |

Selecting a node also focuses the inspector's risk matrix on **that component** (the threats that
reference it), so the active scheme's grid doubles as a per-component view. Built-in schemes use
5×5 axes; a local scheme can use different axis sizes and labels.

Trust boundaries are drawn automatically around their member nodes (a boundary must contain at
least one node). External interfaces (HART, Bluetooth, JTAG …) are pinned on every layer and
re-attach to the most specific visible component as you zoom in.

## Data model

One JSON file per step under `projects/<id>/`, matching the `tra/` methodology and schemas
(`tra/.assets/schema/*`):

- `01-project-description/project.json` — device, scope, modelling depth, SL-C, optional product context, and risk-criteria justification.
- `02-assumptions/assumptions.json` — device/system/environment/operational + **mandatory** attacker profiles.
- `03-system-assets/system.json` — components, interfaces, trust boundaries, assets with C/I/A/Safety.
- `04-dfd/dfd.json` — layered DeMarco nodes + flows; nodes additionally carry `x`/`y` for layout.
- `06-threats/threats.json` — STRIDE, affected components, primary interface, Likelihood/Impact, plus
  optional `cause`, `compromisedObjectives`, treatment rationales, Bug Bar `impactDimensions`,
  `likelihoodFactors` and `cvss` from the guided calculator.
- `07-attack-trees/attack-trees.json` — optional attack-defence trees (AND/OR/SAND gates, per-step
  access/skill/cost, defence + vulnerability nodes), each linked to a threat.
- `08-countermeasures/countermeasures.json` — m:n `addresses` with residual L/I.

Risk ratings are classified by the scheme bound to the project. The built-in schemes use 5×5
likelihood and impact axes; a local v2 scheme can define different axes and either a lookup matrix
or product-score bands. The built-in rubrics use the Bug Bar (`max(C, I, A, Safety)`,
safety-dominant) and attacker-grounded likelihood; a local scheme defines its own criteria and
derivation. CVSS remains an optional exploitability signal.

The built-in v2 schemes are in `.assets/knowledge-base/`. To add a local scheme, use the
[risk-scheme guide](../docs/RISK-SCHEMES.md); user schemes are kept under the ignored
`.local/risk-schemes/` directory.

## Knowledge base

The **Knowledge base** view (left nav) has two tabs:

- **Bug Bar** — the department's C/I/A/Safety impact rubric (`.assets/knowledge-base/bug-bar.json`),
  used by the risk calculator.
- **Imported** — threat/countermeasure catalogues dropped into
  `.assets/knowledge-base/imported/<name>/*.json`, either pulled from a git URL (the "Pull a
  catalogue" box on this tab) or a plain folder you copy in yourself. Each catalogue is browsable
  here and can be de-imported again from the same tab.

### Adding your own threats and countermeasures

To make a set of common, reusable threats/countermeasures show up in the **Imported** tab (and
become available via "+ Add from knowledge base…" in the Threats/Countermeasures steps), add a
JSON file under `.assets/knowledge-base/imported/<your-catalogue-name>/*.json` with this shape:

```json
{
  "name": "My common OT threats",
  "version": "1.0",
  "threats": [
    {
      "key": "my-threat-1",
      "title": "Short, human-readable title",
      "stride": ["S", "T"],
      "appliesTo": ["component:processor"],
      "typicalImpact": 3,
      "description": "What the threat is and why it typically applies."
    }
  ],
  "countermeasures": [
    {
      "key": "my-cm-1",
      "title": "Short, human-readable title",
      "for": ["my-threat-1"],
      "maturity": "foundational"
    }
  ]
}
```

- `threats[].key` / `countermeasures[].key` must be unique across every imported catalogue —
  duplicates are silently skipped (first one wins).
- `stride` uses the single-letter STRIDE codes (`S T R I D E`); `appliesTo` is a free-text tag list
  (e.g. `component:...`, `interface:...`) shown as-is, not validated against the project.
- Optional fields (`emb3dId`, `cwe`, `category`, `tier` for threats; `iec62443`, `emb3dId`,
  `maturity` for countermeasures) are shown in each row's "Details" expander when present.
- Multiple `.json` files in the same folder are merged into one catalogue entry in the UI.
- This is a **catalogue** import (abstract, reusable definitions). To round-trip fully-rated project
  threats/countermeasures (with likelihood, impact, rationale, status, etc.) between projects, use
  the **Export…**/**Import…** buttons on the Threats/Countermeasures steps instead.

## Compliance & collaboration

- **Traceability matrix & exports** — the report renders the full **asset → threat → risk →
  requirement → control → residual → evidence** chain as one table, and writes machine-readable
  `traceability.csv`, `traceability.json` and a CycloneDX `sbom.cdx.json` into the project's
  `report/` folder (also downloadable from the Review step). The DFD is rendered across **all
  layers with trust boundaries**, and the report header pins the **knowledge-base version**.
- **Security requirements (step 05)** — a first-class requirement artifact links
  threats → requirements (with the standard clause / SL·FR) → countermeasures, closing the
  IEC 62443-4-1 SR chain.
- **Risk methodology (P11)** — the built-in exposure scheme combines **Exposure × Exploitability**
  geometrically and uses the Bug Bar `max(C/I/A/Safety)` for impact. The built-in cost scheme
  derives a likelihood proposal from cost-based feasibility. A project's active scheme defines its
  levels and classification; local schemes may use a lookup matrix and other axis sizes. The
  mandatory attacker profile grounds the built-in assessments. **Rigorous mode** (Project panel)
  makes the structured rubric and a named rater compulsory for reproducibility.
- **Dashboard (IEC 62443-4-1 overview)** — components (with SBOM version/supplier + third-party
  flag), interfaces, assets, threats, requirements, countermeasures and open defects, with
  ticket/verification-link gaps flagged. Every row links back to the underlying item.
- **SBOM & defect register** — components carry version/supplier/license/CPE (exported as
  CycloneDX); a **defect/vulnerability register** (step 09) tracks CVEs per component across the
  lifecycle, and accepted residual risks require a **sign-off owner, rationale and review date**.
- **Plausibility checker** — reference integrity, STRIDE-per-element/interface coverage,
  residual ≤ initial, mitigated-needs-implemented-control, preventive-control-must-not-cut-impact,
  attacker-proximity vs. exposure, and the requirement chain.
- **Knowledge base** — browse the department-shared **Bug Bar** and any pulled/hand-added catalogues
  of reusable threats/countermeasures (see [Knowledge base](#knowledge-base) above).
- **Cross-links, CRA intended purpose & foreseeable use, git integration, dark mode** — threats ↔ countermeasures
  ↔ requirements ↔ assets are click-navigable; the Project panel captures the intended purpose and
  reasonably foreseeable use (both in the report); the shared KB is pulled read-only and a project commits
  to its own repository.
- **Accessibility & guidance** — keyboard-operable navigation, chips and links with focus rings;
  delete confirmation; read-only IDs; an honest save/offline indicator; a Back/Next wizard with a
  per-step "done when"; and colour-blind-safe risk-matrix band letters.

> **Integrations roadmap.** Connecting countermeasures to Jira / Azure DevOps / Polarion is
> documented as a **plan only** in [`docs/integration-api-plan.md`](docs/integration-api-plan.md);
> no tracker connector is implemented yet.

## License

Unless a file states otherwise, repository-authored webapp code is part of the GPLv3-licensed EmbedRisk project. See [`../LICENSE`](../LICENSE).

Third-party bundled materials in this repository keep their original licenses. See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
