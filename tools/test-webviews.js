// Syntax checks for the inline <script> bodies of every VS Code extension webview (no VS Code needed).
// Each vscode-extension/src/*.ts module that assigns `webview.html` is bundled with esbuild against a
// stubbed `vscode` module, its exported entry points are invoked with fake panels to capture the generated
// HTML, and every inline script is parsed with vm.Script. This catches template-literal pitfalls such as
// `\-` / `\d` being silently cooked away inside the TS template (e.g. "Range out of order" in a regex).
// Run: node tools/test-webviews.js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const extDir = path.join(root, "vscode-extension");
const srcDir = path.join(extDir, "src");
const esbuild = require(path.join(extDir, "node_modules/esbuild"));
const ts = require(path.join(extDir, "node_modules/typescript"));

/* ---------- Minimal vscode stub ---------- */
const FAKE_PROJECT = "/fake-workspace/project";

class Uri {
  constructor(p) { this.scheme = "file"; this.path = p; this.fsPath = p; }
  toString() { return "file://" + this.path; }
  with() { return this; }
  static file(p) { return new Uri(p); }
  static parse(s) { return new Uri(String(s).replace(/^file:\/\//, "")); }
  static joinPath(base, ...parts) { return new Uri(path.posix.join(base.path, ...parts)); }
}

const disposable = () => ({ dispose() { } });
const notFound = async () => { throw new Error("ENOENT (test stub)"); };

function createPanel(captured) {
  const webview = {
    options: {},
    cspSource: "vscode-webview://test",
    asWebviewUri: (u) => new Uri(u.path),
    postMessage: async () => true,
    onDidReceiveMessage: disposable,
  };
  Object.defineProperty(webview, "html", {
    get: () => captured.html,
    set: (v) => { captured.html = v; },
  });
  return {
    webview,
    visible: true,
    active: true,
    onDidDispose: disposable,
    onDidChangeViewState: disposable,
    reveal() { },
    dispose() { },
  };
}

function createVscodeStub(captured) {
  return {
    Uri,
    ViewColumn: { One: 1, Two: 2, Beside: -2, Active: -1 },
    Range: class Range { constructor(...a) { this.args = a; } },
    WorkspaceEdit: class WorkspaceEdit { replace() { } },
    EventEmitter: class EventEmitter { constructor() { this.event = disposable; } fire() { } dispose() { } },
    commands: { executeCommand: async () => undefined, registerCommand: disposable },
    window: {
      activeTextEditor: undefined,
      createWebviewPanel: () => createPanel(captured),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showTextDocument: async () => undefined,
    },
    workspace: {
      findFiles: async (glob) => (String(glob).includes("project.json")
        ? [Uri.file(FAKE_PROJECT + "/01-project-description/project.json")]
        : []),
      fs: { readFile: notFound, stat: notFound, writeFile: async () => { }, createDirectory: async () => { } },
      onDidChangeTextDocument: disposable,
      applyEdit: async () => true,
      openTextDocument: async () => ({}),
    },
  };
}

function createDocument(rel) {
  return {
    uri: Uri.file(FAKE_PROJECT + "/" + rel),
    lineCount: 1,
    getText: () => "",
    save: async () => true,
  };
}

/* ---------- Bundling and HTML capture ---------- */
// Bundles a src/*.ts module with esbuild and evaluates it with `vscodeStub` as its `vscode` import.
async function bundleModule(file, vscodeStub) {
  const result = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["vscode"],
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  const req = (id) => (id === "vscode" ? vscodeStub : require(id));
  new Function("require", "module", "exports", "__filename", "__dirname", code)(req, mod, mod.exports, file, path.dirname(file));
  return mod.exports;
}

function loadModule(file, captured) {
  return bundleModule(file, createVscodeStub(captured));
}

// Invokes every exported webview entry point and returns the captured HTML documents.
async function captureHtml(file) {
  const pages = [];
  const captured = { html: undefined };
  const exportsObj = await loadModule(file, captured);
  const ctx = {
    extensionUri: Uri.file("/fake-extension"),
    globalStorageUri: Uri.file("/fake-global-storage"),
    subscriptions: [],
  };
  for (const [name, value] of Object.entries(exportsObj)) {
    if (typeof value !== "function") continue;
    captured.html = undefined;
    const isClass = /^class\b/.test(Function.prototype.toString.call(value));
    if (isClass && typeof value.prototype.resolveCustomTextEditor === "function") {
      const provider = new value(ctx.extensionUri);
      await provider.resolveCustomTextEditor(createDocument("doc.json"), createPanel(captured), {});
    } else if (!isClass && /^open/.test(name)) {
      await value(ctx);
    } else {
      continue;
    }
    if (typeof captured.html === "string") pages.push({ entry: name, html: captured.html });
  }
  return pages;
}

function inlineScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const line = html.slice(0, m.index).split("\n").length;
    scripts.push({ body: m[2], line });
  }
  return scripts;
}

/* ---------- Template-literal escape pitfalls ---------- */
// Inside a template literal, `\X` for a character X without escape meaning (an "identity escape") silently
// drops the backslash, so `/[\-]/`, `\d`, `\.` or `<\/script>` emitted into a webview lose their intent.
const MEANINGFUL_ESCAPE = /[nrtbfv0xu'"`\\$\r\n\u2028\u2029]/;

function templateEscapePitfalls(file) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    const isTemplate = ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node);
    if (isTemplate && /<script\b/i.test(node.getText(sf))) {
      const parts = ts.isTemplateExpression(node)
        ? [node.head, ...node.templateSpans.map((s) => s.literal)]
        : [node];
      for (const part of parts) {
        const raw = text.slice(part.getStart(sf), part.getEnd());
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] !== "\\") continue;
          const next = raw[i + 1];
          if (!MEANINGFUL_ESCAPE.test(next)) {
            const pos = sf.getLineAndCharacterOfPosition(part.getStart(sf) + i);
            found.push(`line ${pos.line + 1}: "\\${next}" in a template literal emits "${next}" (backslash dropped)`);
          }
          i++;
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/* ---------- Run ---------- */
async function main() {
  const files = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(srcDir, f))
    .filter((f) => /\bwebview\.html\s*=/.test(fs.readFileSync(f, "utf8")));
  assert.ok(files.length > 0, "no webview modules found in " + srcDir);

  const failures = [];
  let scriptCount = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    for (const p of templateEscapePitfalls(file)) failures.push(`${rel}: ${p}`);

    let pages;
    try {
      pages = await captureHtml(file);
    } catch (err) {
      failures.push(`${rel}: could not generate webview HTML: ${err && err.stack ? err.stack : err}`);
      continue;
    }
    if (!pages.length) {
      failures.push(`${rel}: assigns webview.html but no exported entry point produced HTML`);
      continue;
    }
    for (const page of pages) {
      const scripts = inlineScripts(page.html);
      if (/<script\b/i.test(page.html) && !scripts.length && !/<script\b[^>]*\bsrc\s*=/i.test(page.html)) {
        failures.push(`${rel} (${page.entry}): <script> tag found but no parsable script block`);
      }
      scripts.forEach((s, i) => {
        scriptCount++;
        try {
          new vm.Script(s.body, { filename: `${rel}#${page.entry}:script${i + 1}` });
        } catch (err) {
          failures.push(`${rel} (${page.entry}, inline script ${i + 1} at HTML line ${s.line}): ${err.name}: ${err.message}`);
        }
      });
    }
  }

  if (failures.length) {
    console.error("Webview script check FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log(`All ${scriptCount} inline webview scripts in ${files.length} modules parsed successfully.`);
}

module.exports = { Uri, bundleModule };

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
