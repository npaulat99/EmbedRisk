# GitHub Copilot Instructions

## Project overview

EmbedRisk is a Threat and Risk Assessment (TRA) toolset for embedded OT/ICS field devices, aligned with IEC 62443-4-1 and CRA-style traceability. It ships **two independent tools that read/write the same on-disk JSON project format**:

- [webapp/](../webapp/) — React/TypeScript client (Vite) + Node/Express server (ESM JavaScript), for collaborative browser-based modeling with live WebSocket sync.
- [vscode-extension/](../vscode-extension/) — VS Code extension (TypeScript) with a guided wizard and native webview editors (DFD, attack tree) for editor-based workflows.
- [knowledge-base/](../knowledge-base/) — reusable JSON catalogues (`ot-attackers.json`, `ot-threats.json`, `ot-countermeasures.json`) of attacker profiles, STRIDE/CVSS v4.0 threats, and countermeasures.
- [tools/](../tools/) — standalone Node/Python scripts for DFD<->draw.io conversion and HTML report generation.

A TRA project is a folder with one JSON artifact per step: `01-project-description` -> `02-assumptions` -> `03-system-assets` -> `04-dfd` -> `05-requirements` -> `06-threats` -> `07-attack-trees` -> `08-countermeasures` -> `09-defects`, plus a generated `report/index.html`. The core traceability chain is **asset -> threat -> risk rating (common Likelihood x Impact matrix, CIA + Safety, optionally supported by exposure/exploitability or cost-based feasibility) -> requirement -> countermeasure -> residual risk**. See [README.md](../README.md) and [docs/HOW-TO-TRA.md](../docs/HOW-TO-TRA.md) for the full methodology.

### Repo-specific things to keep in mind

- **Shared JSON schema, two consumers.** The step artifact format (and the risk scheme / field-device library under `webapp/.assets/knowledge-base/`) is read and written by both `webapp/server` and `vscode-extension`. When changing a schema or field name, check both `webapp/server/src/validate.js` and the extension's own parsing/rendering code (`vscode-extension/src/*.ts`, `vscode-extension/media/*.js`), plus example projects under `webapp/projects/` and `webapp/docs/`, so the tools stay compatible.
- **Isomorphic webview models are CommonJS on purpose.** `vscode-extension/media/dfd-model.js` and `attacktree-model.js` use `module.exports` so they load unmodified both as a `<script>` in the webview and via `require()` in [tools/test-models.js](../tools/test-models.js) (`node tools/test-models.js`, plain `assert`-based, no test framework). Do not convert these to ES modules or add a bundler-only syntax without updating both consumers.
- **Duplicated report-generation tooling.** [tools/generate-report.mjs](../tools/generate-report.mjs)/[generate_report.py](../tools/generate_report.py) and [vscode-extension/runtime/tools/generate-report.mjs](../vscode-extension/runtime/tools/generate-report.mjs)/[generate_report.py](../vscode-extension/runtime/tools/generate_report.py) are vendored copies (the extension bundles its own runtime and has already diverged from `tools/`). When fixing a report-generation bug, check whether it applies to both copies instead of assuming a single source of truth.
- **Module conventions differ by package.** `webapp/server` is plain ESM JavaScript (`"type": "module"`, explicit `.js` import extensions, no build step). `webapp/client` is TypeScript + React + Vite, using `zustand` for state (`client/src/state/store.ts`) and `@xyflow/react` for the DFD canvas. `vscode-extension/src` is TypeScript compiled with the extension's own build; `vscode-extension/media` is unbundled vanilla JS served to webviews. Match the existing module style of the file you're editing rather than introducing a new one.
- **No repo-wide linter/formatter is configured.** Match the surrounding code's formatting, quote style, and semicolon usage within each package rather than reformatting whole files.
- **Domain vocabulary matters.** Use STRIDE categories, CVSS v4.0 vectors, and IEC 62443 terminology consistently with existing knowledge-base entries and docs — this is TRA/security-engineering domain content, not generic app data. Risk scales and classification are defined by the project's active risk scheme; built-ins are 5x5, but local schemes may differ. In particular, an inherent limitation of a communication protocol (e.g. no source authentication in Modbus RTU) is not automatically a vulnerability of the component using it — see [.ai/README.md](../.ai/README.md)'s "Protocol limitations vs. product vulnerabilities" section and `Threat.classification`/`responsibility` in `webapp/client/src/types.ts`.
- **Risk scheme changes.** Before creating or modifying an EmbedRisk v2 scheme, read [docs/RISK-SCHEMES.md](../docs/RISK-SCHEMES.md) and follow `.github/instructions/risk-scheme.instructions.md`. For a scheme described in prose, ask for missing axis definitions, criteria, complete matrix or bands, and acceptance rules; never invent unspecified scoring policy. User schemes belong in ignored `webapp/.local/risk-schemes/` by default and must not be added to a commit unless explicitly requested.
- **AI-assisted TRA workflow.** For interviewing users, reviewing, or sparring on TRA content itself (as opposed to writing tool code), use the agents in [.github/agents/](agents/) and prompts in [.github/prompts/](prompts/) — see [.ai/README.md](../.ai/README.md) for the full framework, including the `.tra-knowledge.json` per-project sidecar file and the default write-immediately policy for TRA JSON writes (git provides the audit/revert path; the user can ask for pre-write review instead).

## General principles

All code generated for this repository must prioritize **security, maintainability, readability, and simplicity**.

### Architecture

* Follow established architectural patterns already used in the repository.
* Prefer clear separation of concerns.
* Avoid unnecessary abstraction, indirection, or premature optimization.
* Design for maintainability and ease of modification.

### Simplicity

* Implement the **simplest solution that correctly solves the problem**.
* Keep code as simple as possible and as complex as necessary.
* Avoid clever or overly compact code that reduces readability.
* Prefer explicit behavior over implicit behavior.

### Readability and maintainability

* Write code that can be easily understood by a **mid-level software developer**.
* Use meaningful names for variables, functions, classes, and modules.
* Keep functions and methods focused on a single responsibility.
* Minimize nesting and reduce cognitive complexity.
* Prefer composition over duplication.

### Security

* Follow security best practices by default.
* Validate all external input.
* Avoid injection vulnerabilities, insecure deserialization, unsafe file operations, and insecure defaults.
* Never expose secrets, credentials, tokens, or sensitive information in code.
* Apply the principle of least privilege where applicable.

### Code quality

* Produce production-quality code.
* Follow consistent formatting and project conventions.
* Add comments only when they provide useful context or explain non-obvious decisions.
* Avoid redundant or obvious comments.
* Keep public APIs and interfaces well documented when appropriate.

### Refactoring

When modifying existing code:

* Improve readability and maintainability where it is safe to do so.
* Reduce duplication and simplify unnecessarily complex logic.
* Preserve existing behavior unless explicitly requested otherwise.
* **Never break existing functionality, public interfaces, dependencies, or integrations.**
* Prefer incremental refactoring over large rewrites.

### Error handling

* Handle errors explicitly and predictably.
* Fail securely.
* Provide useful error messages without leaking sensitive information.
* Avoid swallowing exceptions silently.

### Testing considerations

* Write code that is testable.
* Prefer deterministic behavior.
* Minimize hidden dependencies and global state.
* When appropriate, update or add tests to cover new behavior.

### Output expectations

Generated code should leave the repository **more maintainable than it was before the change**, while remaining fully compatible with existing functionality and dependencies.
