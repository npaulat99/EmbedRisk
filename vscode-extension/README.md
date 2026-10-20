# EmbedRisk — Threat & Risk Assessment (VS Code extension)

**EmbedRisk** brings guided Threat & Risk Assessment (TRA) for embedded OT field devices into VS Code,
with native, keyboard-driven editors for **Data Flow Diagrams** and **attack-defence trees** rendered
directly in the editor (no external iframe), plus a guided wizard, a bundled knowledge-base catalogue,
and an HTML report generator. It uses the same on-disk JSON project format as the EmbedRisk web app, so
projects remain portable across tools.

New projects are created in `~/Documents/EmbedRisk/projects/<slug>` on the local machine. Each new
project is initialized as its own Git repository when `git` is available.

## Commands

All commands live under the **EmbedRisk** category in the Command Palette.
- **EmbedRisk: Open guided wizard** — forms for the whole methodology, so you never edit raw JSON: project scope, **assumptions** (incl. attacker profiles), **system & assets** (components, interfaces, trust boundaries, and assets rated C/I/A/Safety), **threats** (STRIDE, risk rating and handling **status**) and countermeasures.
- **EmbedRisk: New project** — scaffolds a clean project under the dedicated local EmbedRisk projects folder and opens it as its own workspace.
- **EmbedRisk: Open DFD canvas (native)** — the multi-layer DeMarco DFD editor for `04-dfd/dfd.json`.
- **EmbedRisk: New attack tree for a threat** — appends an attack-defence tree (AND/OR/SAND) for a chosen threat to `attack-trees.json`.
- **EmbedRisk: Browse knowledge base (catalogue)** — import reusable threats/countermeasures from the bundled catalogue and imported catalogues into the active project.
- **EmbedRisk: Import knowledge base (git)** — clone an external catalogue into the extension-managed knowledge-base storage.
- **EmbedRisk: Generate report** — builds `report/index.html` with the bundled report generator (no Python required).
- **EmbedRisk: Open DFD in draw.io editor** — optional draw.io embed (non-default; its iframe captures keyboard).

## Guided wizard

Run **EmbedRisk: Open guided wizard** from the Command Palette to open it (it no longer opens
automatically on startup). It covers every methodology step with proper forms — **no raw JSON editing**:

- **01 · Project** — device, scope and target security level.
- **02 · Assumptions** — tabbed editor for the mandatory **attacker profiles** (capability, access,
  motivation, resources) and device / system / environment / operational assumptions.
- **03 · System & assets** — tabbed editor for **components** (kind, provenance, layer, parent),
  **interfaces** (component, category, exposure, protocol), **trust boundaries** (pick member
  components) and **assets** (type, storage, member components, and C/I/A/Safety objectives 0–5).
- **05 · Security requirements** — derive testable requirements and link each to the **threats** it
  comes from and the **countermeasures** that satisfy it (with standard reference and SL / FR), for a
  traceable threat → requirement → control chain.
- **06 · Threats** — STRIDE, affected components, Likelihood × Impact with a live risk pill, and a
  colour-coded handling **status** (open / mitigated / accepted / transferred) shown on every row.
- **08 · Countermeasures** — residual risk per addressed threat.

Steps 04 (DFD) and 07 (attack trees) open their dedicated visual editors; step 09 generates the report.

Every change in the wizard is undoable: use the **Undo / Redo** buttons in the top bar or the
`Ctrl+Z` / `Ctrl+Y` (also `Ctrl+Shift+Z`) shortcuts. The DFD and attack-tree editors have the same.

## DFD canvas — keyboard shortcuts

The DFD editor is the default editor for `04-dfd/dfd.json`. Click a node to select it, or use the keys.

| Key | Action |
| --- | --- |
| `←` / `→` | Select previous / next component in the current layer |
| `↓` / `Enter` | Drill into the selected component (offers to create a child layer if none) |
| `↑` / `Backspace` | Go up to the parent layer |
| `e` / `F2` | Edit (rename) the selected component |
| `d` / `Delete` | Delete the selected component and its sub-components |
| `t` | Toggle connect mode (then click source, then target, to draw a data flow) |
| `x` | Add external entity |
| `p` | Add process |
| `m` | Add multiprocess |
| `s` | Add store |
| `b` | Add trust boundary |
| `Ctrl+Z` | Undo the last change |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |

Drag a node to reposition it (positions persist). The palette is restricted to DeMarco notation only
(multiprocess is a double concentric ellipse, per `DataFlowDiagram.xml`). Select a node to open the
**inspector** on the right: edit its label, type and linked component, add/label/delete **data flows**
(Connections), and — for a trust boundary — tick which nodes it **encloses** (it auto-sizes around them).

**Editing a trust boundary:** pick it from the toolbar **Select…** dropdown, or click anywhere inside the
boundary (member nodes stay clickable on top). The inspector then lets you rename it, change its type and
adjust its members — the same way as any other node. Use the **Undo / Redo** toolbar buttons (or `Ctrl+Z` /
`Ctrl+Shift+Z`) to step through structural changes.

The data model is identical to the EmbedRisk web app (`04-dfd/dfd.json` with `members`/`x`/`y`/`width`/`height`),
so a project opens in either tool.

## Attack-tree editor — keyboard shortcuts

Default editor for `07-attack-trees/attack-trees.json` (one file, many trees; schema-identical to the
EmbedRisk web app). Attack-defence trees use **AND / OR / SAND** gates and node **kinds** (goal, step, sub-step,
category, defence, vulnerability); steps carry required access/skill and cost factors, and the toolbar
shows the derived success probability and suggested likelihood. Pick or add a tree in the toolbar; the
inspector edits the selected node.

Step **07 · Attack trees** in the wizard opens a hub that **lists the existing trees** (each shown with
the threat it models, e.g. `T1 · …`) so you can reopen one, **create a new tree** ("New attack tree…",
which first asks which threat it models), or **delete a tree** via the trash icon next to it. Inside the
editor, `+ Tree` adds one and **Delete tree** removes the current tree (goal and all) — deleting a whole
tree is how you remove a root goal. Every change is saved immediately, so trees are never lost.

The tree is drawn graphically in the same notation as the web app: children branch downward under a
**gate badge** (OR = plain fan-out, AND = a connecting arc, SAND = an arc with a left→right sequence
arrow). **Click a gate badge** to cycle AND / OR / SAND, or click a node to select it.

| Key | Action |
| --- | --- |
| `←` / `→` | Select previous / next sibling |
| `↑` / `↓` | Move to parent / first child |
| `Enter` / `c` | Add a child step |
| `Insert` / `s` | Add a sibling step |
| `t` / `g` | Cycle the AND / OR / SAND gate of the selected node |
| `e` / `F2` | Edit (rename) the selected node |
| `d` / `Delete` | Delete the selected node (not the root goal) |
| `Ctrl+Z` | Undo the last change |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |

In both editors, while the rename/confirm dialog is open, `Enter` confirms and `Esc` cancels.

## Develop

```bash
npm install
npm run compile   # type-check + bundle to dist/extension.js
```
Press F5 to launch the Extension Development Host. The DFD and attack-tree models live in
`media/dfd-model.js` and `media/attacktree-model.js` (shared by the webviews and by the repository test
script in `tools/test-models.js`).

Webview HTML is built from TypeScript template literals, where backslash escapes are processed (`\-`, `\d`, `\.`
lose their backslash). After changing any webview markup or inline script, run from the repository root:

```bash
node tools/test-models.js     # isomorphic webview models
node tools/test-webviews.js   # bundles each src/*.ts webview with a stubbed vscode module and syntax-checks every inline <script>
```

`tools/test-webviews.js` needs `npm install` in this folder first (it uses the local `esbuild` and `typescript`).

## License

The EmbedRisk extension code is GPLv3-licensed. See [`LICENSE`](LICENSE) and [`../LICENSE`](../LICENSE).

The optional draw.io editor mode uses a vendored upstream draw.io webapp subtree in `media/drawio/`. That third-party subtree and its bundled dependencies remain under their own upstream licenses.

See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for details.
