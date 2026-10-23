// Runtime smoke test for every VS Code extension webview (no VS Code needed).
// Each webview module in vscode-extension/src is bundled with esbuild (see test-webviews.js) and run against a
// stubbed `vscode` API whose workspace file system reads the real webapp/projects/RL-100 example project (writes
// stay in memory). The generated HTML is loaded into jsdom with scripts enabled, external media/*.js models are
// inlined from vscode-extension/media, and acquireVsCodeApi() is wired to the real extension-host message handler,
// so the host <-> webview round trip (ready -> load/init -> save) runs exactly as in VS Code. The UI is then
// exercised (wizard rail, tabs and add buttons; editor node selection and documented keyboard shortcuts).
// Any uncaught exception, unhandled rejection, console.error, host handler failure, invalid saved JSON or
// CSP-blocked inline handler fails the run with the webview name, error and stack.
// Run: node tools/test-webviews-runtime.js   (needs `npm install` in vscode-extension for esbuild + jsdom)
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const { Uri, bundleModule } = require("./test-webviews.js");

const root = path.resolve(__dirname, "..");
const extDir = path.join(root, "vscode-extension");
const srcDir = path.join(extDir, "src");
const mediaDir = path.join(extDir, "media");
// Committed copy of webapp/projects/RL-100 (project folders are gitignored).
const projectDir = path.join(root, "tools/fixtures/RL-100");
const { JSDOM, VirtualConsole } = require(path.join(extDir, "node_modules/jsdom"));

// Failures that are known and tracked instead of fixed. Each entry needs a TODO explaining why it is not fixed
// yet; matching failures are reported loudly but do not fail the run. An entry that no longer matches fails the
// run so it gets removed.
const KNOWN_FAILURES = [
  // { webview: "wizard", match: /some message/, todo: "TODO(EXT-xxx): why this is not fixed yet" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e && e.stack ? e.stack : typeof e === "object" ? util.inspect(e, { depth: 4 }) : String(e));

let current = null; // harness of the webview under test, for process-level unhandled rejections
process.on("unhandledRejection", (err) => {
  if (current) current.fail("unhandled promise rejection: " + errText(err));
  else { console.error("unhandled promise rejection outside a webview test: " + errText(err)); process.exitCode = 1; }
});

/* ---------- Harness: stubbed extension host + jsdom webview ---------- */
class Harness {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.overlay = new Map();   // fsPath -> text written by the host (never touches disk)
    this.writes = [];           // { path, text } for every host write / workspace edit
    this.toWebview = [];        // messages posted by the host
    this.toHost = [];           // messages posted by the webview
    this.commands = [];         // vscode.commands.executeCommand ids
    this.pending = new Set();
    this.outbox = [];           // host messages posted before the DOM exists
    this.fileWatchers = [];
    this.html = undefined;
    this.hostHandler = null;
    this.dom = null;
  }

  fail(msg) { this.failures.push(msg); }

  track(promise) {
    const p = Promise.resolve(promise).finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  readText(p) { return this.overlay.has(p) ? this.overlay.get(p) : fs.readFileSync(p, "utf8"); }

  recordWrite(p, text) {
    try { JSON.parse(text); } catch (err) { this.fail(`host wrote invalid JSON to ${path.relative(root, p)}: ${err.message}`); }
    this.overlay.set(p, text);
    this.writes.push({ path: p, text });
  }

  vscodeStub() {
    const h = this;
    const disposable = () => ({ dispose() { } });
    return {
      Uri,
      RelativePattern: class RelativePattern { constructor(baseUri, pattern) { this.baseUri = baseUri; this.pattern = pattern; } },
      ViewColumn: { One: 1, Two: 2, Beside: -2, Active: -1 },
      Range: class Range { constructor(...a) { this.args = a; } },
      WorkspaceEdit: class WorkspaceEdit {
        constructor() { this.ops = []; }
        replace(uri, range, text) { this.ops.push({ uri, text }); }
      },
      EventEmitter: class EventEmitter { constructor() { this.event = disposable; } fire() { } dispose() { } },
      commands: {
        executeCommand: async (id) => { h.commands.push(id); return undefined; },
        registerCommand: disposable,
      },
      window: {
        activeTextEditor: undefined,
        createWebviewPanel: () => h.createPanel(),
        showInformationMessage: async () => undefined,
        showWarningMessage: async (msg) => { h.fail("host showed warning: " + msg); return undefined; },
        showErrorMessage: async (msg) => { h.fail("host showed error: " + msg); return undefined; },
        showTextDocument: async () => undefined,
      },
      workspace: {
        findFiles: async (glob) => {
          const g = String(glob);
          if (g.includes("project.json")) return [Uri.file(path.join(projectDir, "01-project-description/project.json"))];
          if (g.includes("knowledge-base")) {
            const kbDir = path.join(root, "webapp/.assets/knowledge-base");
            return fs.readdirSync(kbDir).filter((f) => f.endsWith(".json")).map((f) => Uri.file(path.join(kbDir, f)));
          }
          return [];
        },
        fs: {
          readFile: async (u) => Buffer.from(h.readText(u.fsPath)),
          stat: async () => { throw new Error("ENOENT (test stub)"); }, // forces the hosted draw.io URL (never fetched)
          writeFile: async (u, data) => h.recordWrite(u.fsPath, Buffer.from(data).toString("utf8")),
          createDirectory: async () => { },
        },
        onDidChangeTextDocument: disposable,
        createFileSystemWatcher: (pattern) => {
          const watcher = {
            pattern,
            onDidChange(handler) { this.change = handler; return disposable(); },
            onDidCreate(handler) { this.create = handler; return disposable(); },
            onDidDelete(handler) { this.delete = handler; return disposable(); },
            dispose() { this.disposed = true; },
          };
          h.fileWatchers.push(watcher);
          return watcher;
        },
        applyEdit: async (edit) => { edit.ops.forEach((op) => h.recordWrite(op.uri.fsPath, op.text)); return true; },
        openTextDocument: async () => ({}),
      },
    };
  }

  createPanel() {
    const h = this;
    const disposeHandlers = [];
    const webview = {
      options: {},
      cspSource: "vscode-webview://test",
      asWebviewUri: (u) => new Uri(u.path),
      postMessage: (msg) => h.track(h.deliverToWebview(msg)),
      onDidReceiveMessage: (handler) => { h.hostHandler = handler; return { dispose() { } }; },
    };
    Object.defineProperty(webview, "html", { get: () => h.html, set: (v) => { h.html = v; } });
    return {
      webview,
      visible: true,
      active: true,
      onDidDispose: (handler) => { disposeHandlers.push(handler); return { dispose() { } }; },
      onDidChangeViewState: () => ({ dispose() { } }),
      reveal() { },
      dispose() { h.disposed = true; disposeHandlers.forEach((handler) => handler()); },
    };
  }

  createDocument(rel) {
    const h = this;
    const p = path.join(projectDir, rel);
    return {
      uri: Uri.file(p),
      get lineCount() { return h.readText(p).split("\n").length; },
      getText: () => h.readText(p),
      save: async () => true,
    };
  }

  async deliverToWebview(msg) {
    this.toWebview.push(msg);
    if (!this.dom) { this.outbox.push(msg); return true; }
    await new Promise((r) => setImmediate(r));
    const win = this.dom.window;
    // Structured-clone into the webview realm, like VS Code does.
    win.dispatchEvent(new win.MessageEvent("message", { data: win.JSON.parse(JSON.stringify(msg)) }));
    return true;
  }

  deliverToHost(msg) {
    const clone = JSON.parse(JSON.stringify(msg));
    this.toHost.push(clone);
    this.track((async () => {
      await new Promise((r) => setImmediate(r));
      if (!this.hostHandler) { this.fail("webview posted a message but no host handler is registered: " + JSON.stringify(clone)); return; }
      try { await this.hostHandler(clone); } catch (err) { this.fail(`host handler threw for ${JSON.stringify(clone).slice(0, 80)}: ${errText(err)}`); }
    })());
  }

  /** Loads the captured webview HTML into jsdom and runs its scripts. */
  openDom() {
    assert.ok(typeof this.html === "string", `${this.name}: no webview HTML was generated`);
    const html = inlineMediaScripts(this.html, (msg) => this.fail(msg));
    checkCsp(html, (msg) => this.fail(msg));
    const h = this;
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("error", (...args) => h.fail("console.error: " + args.map(errText).join(" ")));
    virtualConsole.on("jsdomError", (err) => {
      if (err && err.type === "css-parsing") return; // jsdom's CSS parser lags browsers; not a webview fault
      h.fail("jsdom error: " + errText(err && err.cause ? err.cause : err));
    });
    this.dom = new JSDOM(html, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "https://webview.test/index.html",
      virtualConsole,
      beforeParse(window) {
        let acquired = false, state;
        window.acquireVsCodeApi = () => {
          if (acquired) throw new Error("acquireVsCodeApi() may only be called once per webview");
          acquired = true;
          return { postMessage: (m) => h.deliverToHost(m), getState: () => state, setState: (s) => { state = s; } };
        };
        // Present in VS Code's Chromium webviews but not implemented by jsdom.
        window.Element.prototype.scrollIntoView = function () { };
        window.addEventListener("error", (e) => {
          h.fail("uncaught exception: " + errText(e.error || e.message));
          e.preventDefault(); // already reported; keep jsdom from reporting it a second time
        });
      },
    });
    const queued = this.outbox.splice(0);
    queued.forEach((m) => { this.toWebview.pop(); this.track(this.deliverToWebview(m)); });
    return this.dom;
  }

  /** Waits until all host <-> webview message traffic and host handlers have finished. */
  async settle(extraMs = 0) {
    if (extraMs) await sleep(extraMs);
    for (let idle = 0; idle < 3;) {
      await sleep(5);
      if (this.pending.size) { idle = 0; await Promise.allSettled([...this.pending]); } else idle++;
    }
  }

  get document() { return this.dom.window.document; }
  $(sel) { return this.document.querySelector(sel); }
  $$(sel) { return [...this.document.querySelectorAll(sel)]; }

  must(sel) {
    const el = this.$(sel);
    assert.ok(el, `${this.name}: element not found: ${sel}`);
    return el;
  }

  click(elOrSel) {
    const el = typeof elOrSel === "string" ? this.must(elOrSel) : elOrSel;
    const win = this.dom.window;
    el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  mouse(type, el) {
    const win = this.dom.window;
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  }

  key(key, opts = {}) {
    const win = this.dom.window;
    const target = opts.target || this.document.body;
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  }

  setValue(elOrSel, value) {
    const el = typeof elOrSel === "string" ? this.must(elOrSel) : elOrSel;
    const win = this.dom.window;
    el.value = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  lastToHost(pred) { return [...this.toHost].reverse().find(pred); }

  close() {
    if (this.dom) this.dom.window.close();
  }
}

/* ---------- HTML preparation ---------- */
// Replaces <script src=".../media/<file>.js"> by the real file from vscode-extension/media (jsdom loads no resources).
function inlineMediaScripts(html, fail) {
  return html.replace(/<script\b([^>]*?)\bsrc\s*=\s*"([^"]*)"([^>]*)>\s*<\/script>/gi, (whole, pre, src, post) => {
    const m = /\/media\/([A-Za-z0-9_.-]+\.js)$/.exec(src);
    const file = m && path.join(mediaDir, m[1]);
    if (!file || !fs.existsSync(file)) { fail(`external script not found in vscode-extension/media: ${src}`); return whole; }
    const code = fs.readFileSync(file, "utf8");
    if (/<\/script/i.test(code)) { fail(`${m[1]} contains "</script" and cannot be inlined`); return whole; }
    return `<script${pre}${post}>${code}</script>`;
  });
}

// VS Code enforces the webview CSP; jsdom does not. With a nonce-only script-src, inline event handler attributes
// (onclick=...) and scripts without the nonce are blocked, so a feature can work here but be dead in VS Code.
function checkCsp(html, fail) {
  const meta = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]*)"/i.exec(html);
  if (!meta) return;
  const scriptSrc = (/(?:^|;)\s*script-src\s+([^;]*)/.exec(meta[1]) || [])[1] || "";
  if (/'unsafe-inline'/.test(scriptSrc)) return;
  const nonce = (/'nonce-([^']+)'/.exec(scriptSrc) || [])[1];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tagNonce = (/\bnonce\s*=\s*"([^"]*)"/.exec(m[1]) || [])[1];
    if (!nonce || tagNonce !== nonce) fail(`<script${m[1]}> is blocked by the CSP (missing/mismatched nonce)`);
  }
  const handler = /<[a-z][^>]*\s(on[a-z]+)\s*=/i.exec(html.replace(/<script\b[\s\S]*?<\/script>/gi, ""));
  if (handler) fail(`inline event handler attribute "${handler[1]}" is blocked by the CSP (script-src without 'unsafe-inline')`);
}

// Inline handlers can also be created later via innerHTML; scan the live DOM.
function checkLiveDomHandlers(h) {
  const meta = h.$('meta[http-equiv="Content-Security-Policy"]');
  if (!meta || /script-src[^;]*'unsafe-inline'/.test(meta.getAttribute("content"))) return;
  for (const el of h.$$("*")) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) h.fail(`<${el.tagName.toLowerCase()} ${attr.name}=...> rendered at runtime is blocked by the CSP`);
    }
  }
}

/* ---------- Shared helpers ---------- */
const ctx = {
  extensionUri: Uri.file(extDir),
  globalStorageUri: Uri.file(path.join(extDir, ".nonexistent-global-storage")),
  subscriptions: [],
};

async function load(h, file) {
  return bundleModule(path.join(srcDir, file), h.vscodeStub());
}

function readProjectJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, rel), "utf8"));
}

function lastWriteJson(h, rel) {
  const p = path.join(projectDir, rel);
  const w = [...h.writes].reverse().find((x) => x.path === p);
  return w ? JSON.parse(w.text) : undefined;
}

/* ---------- Scenarios ---------- */
async function checkProjectList(h, mod, key, readList) {
  const projectPath = "01-project-description/project.json";
  const original = readList(JSON.parse(h.readText(path.join(projectDir, projectPath)))) || [];
  const inputs = () => h.$$(`[data-project-list="${key}"]`);
  const values = () => inputs().map((input) => input.value);
  const add = () => h.click(`[data-act="addProjectList"][data-list="${key}"]`);
  assert.deepStrictEqual(values(), original, key + " not loaded");
  add();
  h.key("z", { ctrlKey: true });
  assert.deepStrictEqual(values(), original, key + " add undo failed");
  h.key("y", { ctrlKey: true });
  assert.deepStrictEqual(values(), [...original, ""], key + " add redo failed");
  const text = key === "foreseeableUse" ? '<scenario> & "use"\nSecond line' : '<scope> & "scenario"';
  h.setValue(inputs()[original.length], "  " + text + "  ");
  h.key("z", { ctrlKey: true });
  assert.strictEqual(inputs()[original.length].value, "", key + " edit undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(inputs()[original.length].value, "  " + text + "  ", key + " edit redo failed");
  add();
  add();
  h.setValue(inputs()[original.length + 2], "   ");
  await h.settle(1700);
  const expected = [...original.map((item) => item.trim()).filter(Boolean), text];
  assert.deepStrictEqual(readList(lastWriteJson(h, projectPath)), expected, key + " must save trimmed nonempty rows only");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  assert.deepStrictEqual(values(), expected, key + " not restored on reopen");
  h.click(`[data-act="delProjectList"][data-list="${key}"][data-list-index="${expected.length - 1}"]`);
  h.key("z", { ctrlKey: true });
  assert.deepStrictEqual(values(), expected, key + " remove undo failed");
  h.key("y", { ctrlKey: true });
  assert.deepStrictEqual(values(), expected.slice(0, -1), key + " remove redo failed");
  while (inputs().length) h.click(`[data-act="delProjectList"][data-list="${key}"]`);
  await h.settle(1700);
  assert.deepStrictEqual(readList(lastWriteJson(h, projectPath)), [], key + " removal was not persisted");
}

async function checkSystemFields(h, mod) {
  const systemPath = "03-system-assets/system.json";
  const original = JSON.parse(h.readText(path.join(projectDir, systemPath)));
  original.components[0] = {
    ...original.components[0], trustZone: "Imported zone", description: "Imported description\nSecond line",
    futureMetadata: { tags: ["preserve"] },
  };
  h.overlay.set(path.join(projectDir, systemPath), JSON.stringify(original));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  h.click('[data-systab="components"]');
  const edits = { trustZone: 'Zone <trusted> & "internal"', description: 'Description </textarea> & "text"\nSecond line' };
  for (const [key, value] of Object.entries(edits)) {
    const selector = `[data-comp="0"][data-k="${key}"]`;
    assert.strictEqual(h.must(selector).value, original.components[0][key], "component field not loaded: " + key);
    h.setValue(selector, value);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must(selector).value, original.components[0][key], "component field undo failed: " + key);
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must(selector).value, value, "component field redo failed: " + key);
  }
  h.click('[data-systab="interfaces"]');
  h.click('[data-systab="components"]');
  for (const [key, value] of Object.entries(edits)) assert.strictEqual(h.must(`[data-comp="0"][data-k="${key}"]`).value, value, "tab switch lost component field");
  const expected = { ...original, components: original.components.map((c, i) => i === 0 ? { ...c, ...edits } : c) };
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, systemPath), expected, "component edits changed unrelated system metadata");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  h.click('[data-systab="components"]');
  for (const [key, value] of Object.entries(edits)) {
    const selector = `[data-comp="0"][data-k="${key}"]`;
    assert.strictEqual(h.must(selector).value, value, "component field not restored on reopen: " + key);
    const newIndex = original.components.length - 1;
    assert.strictEqual(h.must(`[data-comp="${newIndex}"][data-k="${key}"]`).value, original.components[newIndex][key] || "", "optional component field has incorrect default");
    h.setValue(selector, "");
  }
  await h.settle(1700);
  expected.components[0] = { ...expected.components[0], trustZone: "", description: "" };
  assert.deepStrictEqual(lastWriteJson(h, systemPath), expected, "clearing component fields changed other metadata");

  const beforeInterfaces = lastWriteJson(h, systemPath);
  beforeInterfaces.interfaces[0] = {
    ...beforeInterfaces.interfaces[0], tag: "Imported tag", hidden: true,
    futureMetadata: { tags: ["preserve"] },
  };
  h.overlay.set(path.join(projectDir, systemPath), JSON.stringify(beforeInterfaces));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  h.click('[data-systab="interfaces"]');
  const tagSelector = '[data-if="0"][data-k="tag"]';
  const hiddenSelector = '[data-if="0"][data-k="hidden"]';
  const visibleIndex = beforeInterfaces.interfaces.length - 1;
  assert.strictEqual(h.must(tagSelector).value, "Imported tag", "interface tag not loaded");
  assert.strictEqual(h.must(hiddenSelector).checked, true, "hidden interface has no visibility reset");
  assert.strictEqual(h.$(`[data-if="${visibleIndex}"][data-k="hidden"]`), null, "visible interface must not offer a hide control in the wizard");
  assert.strictEqual(h.must(`[data-if="${visibleIndex}"][data-k="tag"]`).value, beforeInterfaces.interfaces[visibleIndex].tag || "", "optional tag default is incorrect");
  const tag = 'BLE <&"tag">';
  h.setValue(tagSelector, tag);
  h.key("z", { ctrlKey: true });
  assert.strictEqual(h.must(tagSelector).value, "Imported tag", "interface tag undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(h.must(tagSelector).value, tag, "interface tag redo failed");
  h.click(hiddenSelector);
  assert.strictEqual(h.$(hiddenSelector), null, "visibility reset should disappear after unhiding");
  h.key("z", { ctrlKey: true });
  assert.strictEqual(h.must(hiddenSelector).checked, true, "unhide undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(h.$(hiddenSelector), null, "unhide redo failed");
  await h.settle(1700);
  const expectedInterfaces = {
    ...beforeInterfaces,
    interfaces: beforeInterfaces.interfaces.map((itf, i) => i === 0 ? { ...itf, tag, hidden: false } : itf),
  };
  assert.deepStrictEqual(lastWriteJson(h, systemPath), expectedInterfaces, "tag or boolean visibility was not saved losslessly");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  h.click('[data-systab="interfaces"]');
  assert.strictEqual(h.must(tagSelector).value, tag, "interface tag not restored on reopen");
  assert.strictEqual(h.$(hiddenSelector), null, "unhidden interface was hidden again on reopen");
  h.setValue(tagSelector, "");
  await h.settle(1700);
  expectedInterfaces.interfaces[0].tag = "";
  assert.deepStrictEqual(lastWriteJson(h, systemPath), expectedInterfaces, "clearing interface tag changed other metadata");
}

async function checkAssetSummaries(h, mod) {
  const systemPath = "03-system-assets/system.json";
  const original = JSON.parse(h.readText(path.join(projectDir, systemPath)));
  original.assets[0] = {
    ...original.assets[0], type: '<asset> & "custom"',
    objectives: { confidentiality: 0, integrity: 5, availability: 2 },
    futureMetadata: { tags: ["preserve"] },
  };
  original.assets.push({ id: "AST-SUMMARY-TEST", name: "Default summary", components: [] });
  h.overlay.set(path.join(projectDir, systemPath), JSON.stringify(original));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  h.click('[data-systab="assets"]');
  const badges = (i) => h.$$(`#asset-summary-${i} .badge`).map((badge) => badge.textContent);
  assert.deepStrictEqual(badges(0), ['<asset> & "custom"', "C0/I5/A2/S0"], "asset summary must escape type and retain zero/default objectives");
  assert.deepStrictEqual(badges(original.assets.length - 1), ["function", "C0/I0/A0/S0"], "asset summary defaults differ from the webapp");
  const typeInput = h.must('[data-as="0"][data-k="type"]');
  h.setValue(typeInput, "data");
  assert.strictEqual(h.must('[data-as="0"][data-k="type"]'), typeInput, "summary update must not replace the active editor");
  assert.strictEqual(badges(0)[0], "data", "type summary did not update immediately");
  h.key("z", { ctrlKey: true });
  assert.strictEqual(badges(0)[0], original.assets[0].type, "type summary undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(badges(0)[0], "data", "type summary redo failed");
  const objectives = { confidentiality: 1, integrity: 0, availability: 5, safety: 3 };
  for (const [key, value] of Object.entries(objectives)) {
    const before = badges(0)[1];
    h.setValue(`[data-as="0"][data-obj="${key}"]`, String(value));
    const after = badges(0)[1];
    assert.notStrictEqual(after, before, "objective summary did not update: " + key);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(badges(0)[1], before, "objective summary undo failed: " + key);
    h.key("y", { ctrlKey: true });
    assert.strictEqual(badges(0)[1], after, "objective summary redo failed: " + key);
  }
  assert.deepStrictEqual(badges(0), ["data", "C1/I0/A5/S3"]);
  await h.settle(1700);
  const expected = {
    ...original, assets: original.assets.map((asset, i) => i === 0 ? { ...asset, type: "data", objectives } : asset),
  };
  assert.deepStrictEqual(lastWriteJson(h, systemPath), expected, "asset summary edits changed unrelated metadata");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  h.click('[data-systab="assets"]');
  assert.deepStrictEqual(badges(0), ["data", "C1/I0/A5/S3"], "asset summary not restored on reopen");
}

async function checkRequirementDerivation(h, mod) {
  const reqPath = "05-requirements/requirements.json";
  const original = JSON.parse(h.readText(path.join(projectDir, reqPath))).requirements;
  const cms = JSON.parse(h.readText(path.join(projectDir, "08-countermeasures/countermeasures.json"))).countermeasures;
  const threats = JSON.parse(h.readText(path.join(projectDir, "06-threats/threats.json"))).threats;
  assert.ok(cms.length >= 2 && threats.length, "requirement parity checks need two countermeasures and a threat");
  const cases = [
    { derivedFromThreat: [], satisfiedByCM: [] },
    { fromCountermeasure: false, derivedFromThreat: [], satisfiedByCM: [] },
    { fromCountermeasure: true, derivedFromThreat: [], satisfiedByCM: [] },
    { fromCountermeasure: false, derivedFromThreat: [threats[0].id], satisfiedByCM: [] },
    { fromCountermeasure: true, derivedFromThreat: [threats[0].id], satisfiedByCM: [] },
    { derivedFromThreat: [], satisfiedByCM: [cms[0].id] },
    { fromCountermeasure: false, derivedFromThreat: [threats[0].id], satisfiedByCM: [cms[0].id] },
  ];
  const rows = original.concat(cases.map((state, i) => ({
    id: "R-PARITY-" + i, text: "Requirement parity " + i, standardRef: "IEC 62443-4-2 CR 1.1",
    futureMetadata: { tags: ["preserve"] }, ...state,
  })));
  h.overlay.set(path.join(projectDir, reqPath), JSON.stringify({ requirements: rows }));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  const index = (i) => original.length + i;
  const checkbox = (i) => h.must(`[data-req="${index(i)}"][data-k="fromCountermeasure"]`);
  const badge = (i) => h.$(`[data-req-badge="${index(i)}"]`)?.textContent || null;
  function state(i, checked, disabled, text) {
    assert.strictEqual(checkbox(i).checked, checked, "requirement checkbox state: " + i);
    assert.strictEqual(checkbox(i).disabled, disabled, "requirement checkbox lock: " + i);
    assert.strictEqual(badge(i), text, "requirement derivation badge: " + i);
  }
  state(0, false, false, "Not derived");
  state(1, false, false, "Not derived");
  state(2, true, false, "Realises CM");
  state(3, false, false, null);
  state(4, true, false, "Realises CM");
  state(5, true, true, "Realises CM");
  state(6, true, true, "Realises CM");

  h.click(checkbox(0));
  state(0, true, false, "Realises CM");
  await h.settle(1700);
  assert.strictEqual(lastWriteJson(h, reqPath).requirements[index(0)].fromCountermeasure, true, "manual CM flag not saved as a boolean");
  h.key("z", { ctrlKey: true });
  state(0, false, false, "Not derived");
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, reqPath).requirements, rows, "undo did not persist the original requirements");
  h.key("y", { ctrlKey: true });
  state(0, true, false, "Realises CM");
  await h.settle(1700);
  assert.strictEqual(lastWriteJson(h, reqPath).requirements[index(0)].fromCountermeasure, true, "redo did not persist CM flag");
  h.click(checkbox(0));
  rows[index(0)].fromCountermeasure = false;
  state(0, false, false, "Not derived");

  const cmChip = (i, cm) => `[data-act="reqCm"][data-req="${index(i)}"][data-val="${cm.id}"]`;
  h.click(cmChip(3, cms[0]));
  state(3, true, true, "Realises CM");
  h.key("z", { ctrlKey: true });
  state(3, false, false, null);
  h.key("y", { ctrlKey: true });
  state(3, true, true, "Realises CM");
  h.click(cmChip(3, cms[1]));
  h.click(cmChip(3, cms[0]));
  state(3, true, true, "Realises CM");
  h.click(cmChip(3, cms[1]));
  state(3, true, false, "Realises CM");
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, reqPath).requirements[index(3)], { ...rows[index(3)], fromCountermeasure: true }, "removing the last CM must preserve the flag set by linking");
  h.click(checkbox(3));
  state(3, false, false, null);
  const threatChip = `[data-act="reqThreat"][data-req="${index(3)}"][data-val="${threats[0].id}"]`;
  h.click(threatChip);
  state(3, false, false, "Not derived");
  h.click(threatChip);
  state(3, false, false, null);

  // Imported links imply a checked UI without silently rewriting an explicit false flag.
  h.click(cmChip(6, cms[0]));
  state(6, false, false, null);
  rows[index(6)].satisfiedByCM = [];
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, reqPath).requirements, rows, "requirement derivation edits lost unrelated fields or links");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  state(0, false, false, "Not derived");
  state(2, true, false, "Realises CM");
  state(3, false, false, null);
  state(5, true, true, "Realises CM");
  state(6, false, false, null);
}

async function checkCountermeasureFields(h, mod) {
  const cmPath = "08-countermeasures/countermeasures.json";
  const threatPath = "06-threats/threats.json";
  const threatDoc = JSON.parse(h.readText(path.join(projectDir, threatPath)));
  const threats = threatDoc.threats.filter((t) => t.likelihood >= 2 && t.impact >= 2);
  assert.ok(threats.length >= 2, "countermeasure parity checks need two rated threats");
  Object.assign(threats[1], { ratedBy: "Threat assessor", ratedAt: "2021-06-07" });
  h.overlay.set(path.join(projectDir, threatPath), JSON.stringify(threatDoc));
  const initial = [
    {
      id: "CM-PARITY-1", title: "Parity control", type: "corrective", status: "implemented", components: [],
      negativeEffects: ["Imported effect"], verificationUrl: "https://example.com/old-evidence", responsibility: "product",
      ticketUrl: "https://example.com/one", ticketUrls: ["https://example.com/one", "https://example.com/two"],
      futureMetadata: { tags: ["preserve"] },
      addresses: threats.slice(0, 2).map((t, i) => ({
        threat: t.id, residualLikelihood: 1, residualImpact: 1, ratedBy: "Imported assessor " + i,
        ratedAt: "2020-01-02T03:04:05Z", futureMetadata: { tags: ["link " + i] },
      })),
    },
    {
      id: "CM-PARITY-2", title: "Legacy tickets", type: "corrective", status: "proposed", components: [],
      ticketUrl: "https://example.com/legacy",
      addresses: [{ threat: threats[0].id, residualLikelihood: 1, residualImpact: 1 }],
    },
  ];
  h.overlay.set(path.join(projectDir, cmPath), JSON.stringify({ countermeasures: initial }));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  const field = (key, i = 0) => `[data-ci="${i}"][data-k="${key}"]`;
  const tickets = (i = 0) => h.$$(`[data-ci="${i}"][data-k="ticketUrls"]`);
  const saved = () => lastWriteJson(h, cmPath).countermeasures;
  assert.deepStrictEqual(h.$$(field("responsibility") + " option").map((o) => o.value), ["", "product", "deployment", "shared"]);
  assert.strictEqual(h.must(field("negativeEffects")).value, "Imported effect");
  assert.strictEqual(h.must(field("negativeEffects", 1)).value, "");
  assert.strictEqual(h.$(field("verificationUrl", 1)), null, "evidence should be hidden for proposed controls");
  h.click(`[data-act="addAddr"][data-c="1"][data-val="${threats[1].id}"]`);
  assert.strictEqual(h.must("#rated-by-1-1").value, "Threat assessor", "new residual link did not inherit assessor");
  assert.strictEqual(h.must("#rated-at-1-1").textContent, "Last rated 2021-06-07", "new residual link did not inherit rating date");
  h.key("z", { ctrlKey: true });
  assert.strictEqual(h.$("#rated-by-1-1"), null, "new residual link undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(h.must("#rated-by-1-1").value, "Threat assessor", "new residual link redo lost provenance");
  h.key("z", { ctrlKey: true });
  const effects = 'Extra <effort> & "cost"\n\nReduced throughput';
  const evidence = "https://example.com/evidence?a=1&b=2";
  for (const [key, value] of [["negativeEffects", effects], ["verificationUrl", evidence]]) {
    const previous = h.must(field(key)).value;
    h.setValue(field(key), value);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must(field(key)).value, previous, key + " undo failed");
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must(field(key)).value, value, key + " redo failed");
  }
  for (const responsibility of ["deployment", "shared", "", "product", "shared"]) {
    const previous = h.must(field("responsibility")).value;
    h.setValue(field("responsibility"), responsibility);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must(field("responsibility")).value, previous, "responsibility undo failed");
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must(field("responsibility")).value, responsibility, "responsibility redo failed");
  }
  const today = new Date().toISOString().slice(0, 10);
  const assessor = '[data-c="0"][data-j="0"][data-k="ratedBy"]';
  assert.strictEqual(h.must(assessor).value, initial[0].addresses[0].ratedBy);
  assert.strictEqual(h.must("#rated-at-0-0").textContent, "Last rated " + initial[0].addresses[0].ratedAt);
  h.setValue(assessor, 'Reviewer <&"name">');
  assert.strictEqual(h.must("#rated-at-0-0").textContent, "Last rated " + today, "assessor edit did not stamp the date");
  h.key("z", { ctrlKey: true });
  assert.strictEqual(h.must("#rated-at-0-0").textContent, "Last rated " + initial[0].addresses[0].ratedAt, "date undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(h.must(assessor).value, 'Reviewer <&"name">', "assessor redo failed");
  for (const selector of ['[data-ri="0"][data-rj="1"][data-rdim="confidentiality"][data-score="1"]', '[data-ri="0"][data-rj="1"][data-rfac="exposure"]']) {
    if (h.must(selector).tagName === "BUTTON") h.click(selector); else h.setValue(selector, "1");
    assert.strictEqual(h.must("#rated-at-0-1").textContent, "Last rated " + today, "guided rating did not stamp date");
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must("#rated-at-0-1").textContent, "Last rated " + initial[0].addresses[1].ratedAt, "guided rating undo lost date");
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must("#rated-at-0-1").textContent, "Last rated " + today, "guided rating redo lost date");
    h.key("z", { ctrlKey: true });
  }
  h.setValue(tickets()[0], "  https://example.com/new-primary  ");
  h.click('[data-act="addTicket"][data-ci="0"]');
  h.setValue(tickets()[2], "https://example.com/third");
  h.click('[data-act="delTicket"][data-ci="0"][data-ti="1"]');
  h.key("z", { ctrlKey: true });
  assert.strictEqual(tickets().length, 3, "ticket delete undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(tickets().length, 2, "ticket delete redo failed");
  h.click('[data-act="addTicket"][data-ci="0"]');
  h.setValue(tickets()[2], "   ");
  h.setValue(field("status", 1), "verified");
  assert.strictEqual(tickets(1)[0].value, initial[1].ticketUrl, "legacy primary ticket was not displayed");
  assert.strictEqual(h.must(field("verificationUrl", 1)).value, "");
  h.click('[data-act="delTicket"][data-ci="1"][data-ti="0"]');
  assert.strictEqual(tickets(1)[0].value, "", "deleted legacy ticket reappeared");
  await h.settle(1700);
  const expected = JSON.parse(JSON.stringify(initial));
  Object.assign(expected[0], {
    negativeEffects: effects.split("\n"), verificationUrl: evidence, responsibility: "shared",
    ticketUrl: "https://example.com/new-primary", ticketUrls: ["https://example.com/new-primary", "https://example.com/third"],
  });
  Object.assign(expected[0].addresses[0], { ratedBy: 'Reviewer <&"name">', ratedAt: today });
  Object.assign(expected[1], { status: "verified", ticketUrl: "", ticketUrls: [] });
  assert.deepStrictEqual(saved(), expected, "countermeasure auto-save lost fields, provenance or unknown metadata");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  assert.strictEqual(h.must(field("negativeEffects")).value, effects);
  assert.strictEqual(h.must(field("verificationUrl")).value, evidence);
  assert.strictEqual(h.must(field("responsibility")).value, "shared");
  assert.deepStrictEqual(tickets().map((input) => input.value), expected[0].ticketUrls);
  assert.strictEqual(h.must(assessor).value, expected[0].addresses[0].ratedBy);
  assert.strictEqual(h.must("#rated-at-0-0").textContent, "Last rated " + today);
  h.setValue(field("status"), "planned");
  assert.strictEqual(tickets().length, 0);
  assert.strictEqual(h.$(field("verificationUrl")), null);
  h.setValue(field("status"), "implemented");
  assert.strictEqual(h.must(field("verificationUrl")).value, evidence, "status toggle lost hidden evidence");

  // Explicit saves must preserve omitted extension fields, and allow intentional clearing.
  const omitted = JSON.parse(JSON.stringify(expected));
  for (const c of omitted) {
    for (const key of ["negativeEffects", "verificationUrl", "responsibility", "ticketUrl", "ticketUrls"]) delete c[key];
    for (const a of c.addresses) { delete a.ratedBy; delete a.ratedAt; }
  }
  await h.settle(1700);
  h.deliverToHost({ cmd: "cms", cms: omitted });
  await h.settle();
  assert.deepStrictEqual(saved(), expected, "explicit save lost omitted countermeasure fields");
  const explicit = JSON.parse(JSON.stringify(expected));
  Object.assign(explicit[0], { negativeEffects: ["Explicit edit"], verificationUrl: "https://example.com/explicit", responsibility: "deployment", ticketUrls: ["  https://example.com/explicit-ticket  ", ""], ticketUrl: "stale" });
  Object.assign(explicit[0].addresses[0], { ratedBy: "Explicit assessor", ratedAt: "2022-03-04" });
  h.deliverToHost({ cmd: "cms", cms: explicit });
  await h.settle();
  explicit[0].ticketUrls = ["https://example.com/explicit-ticket"];
  explicit[0].ticketUrl = explicit[0].ticketUrls[0];
  assert.deepStrictEqual(saved(), explicit, "explicit save ignored new countermeasure edits");
  h.setValue(field("negativeEffects"), "");
  h.setValue(field("verificationUrl"), "");
  h.setValue(field("responsibility"), "");
  h.setValue(assessor, "");
  h.click('[data-act="delTicket"][data-ci="0"][data-ti="0"]');
  await h.settle(1700);
  const cleared = JSON.parse(JSON.stringify(explicit));
  Object.assign(cleared[0], { negativeEffects: [], verificationUrl: "", ticketUrls: [], ticketUrl: "" });
  delete cleared[0].responsibility;
  Object.assign(cleared[0].addresses[0], { ratedBy: "", ratedAt: today });
  assert.deepStrictEqual(saved(), cleared, "auto-save did not clear optional fields");
  const clearExplicit = JSON.parse(JSON.stringify(explicit));
  Object.assign(clearExplicit[0], { negativeEffects: [], verificationUrl: "", responsibility: "", ticketUrls: [], ticketUrl: "" });
  Object.assign(clearExplicit[0].addresses[0], { ratedBy: "", ratedAt: "" });
  h.deliverToHost({ cmd: "cms", cms: clearExplicit });
  await h.settle();
  cleared[0].addresses[0].ratedAt = "";
  assert.deepStrictEqual(saved(), cleared, "explicit save resurrected cleared fields");
  for (const patch of [{ negativeEffects: ["valid", 42] }, { verificationUrl: 42 }, { responsibility: "manufacturer" }, { ticketUrls: "invalid" }, { ticketUrl: 42 }, { addresses: [{ ratedBy: 42 }] }, { addresses: [{ ratedAt: 42 }] }]) {
    for (const cmd of ["cms", "autoSave"]) {
      const writesBefore = h.writes.length;
      const rows = [{ ...cleared[0], ...patch }];
      h.deliverToHost(cmd === "cms" ? { cmd, cms: rows } : { cmd, data: { cms: rows } });
      await h.settle();
      assert.strictEqual(h.writes.length, writesBefore, "invalid countermeasure fields must not write artifacts");
      assert.strictEqual(h.toWebview[h.toWebview.length - 1].cmd, "err", "invalid countermeasure fields must report an error");
    }
  }
}

async function checkDocumentEnvelopes(h, mod) {
  const cases = [
    ["threats", "06-threats/threats.json", "threats", '[data-i="0"][data-k="title"]'],
    ["cms", "08-countermeasures/countermeasures.json", "countermeasures", '[data-ci="0"][data-k="title"]'],
  ];
  const threat = { ...readProjectJson(cases[0][1]).threats[0], likelihood: 3, impact: 3 };
  const cm = { id: "CM-ENVELOPE", title: "Envelope control", type: "corrective", status: "proposed",
    addresses: [{ threat: threat.id, residualLikelihood: 2, residualImpact: 2 }] };
  const metadata = { futureMetadata: { nested: ["preserve", { enabled: false }] }, revision: 0, note: null };
  for (const [i, [, rel, key]] of cases.entries()) {
    h.overlay.set(path.join(projectDir, rel), JSON.stringify({ ...metadata, [key]: [i ? cm : threat] }));
  }
  const reopen = async () => { h.close(); await mod.openWizard(ctx); h.openDom(); await h.settle(); };
  await reopen();
  for (const [cmd, rel, key, selector] of cases) {
    for (const mode of ["explicit", "autoSave"]) {
      const title = `${cmd} ${mode} envelope regression`;
      const start = h.writes.length;
      if (mode === "explicit") {
        const rows = JSON.parse(h.readText(path.join(projectDir, rel)))[key];
        rows[0].title = title;
        const compIds = JSON.parse(h.readText(path.join(projectDir, "03-system-assets/system.json"))).components.map((c) => c.id);
        h.deliverToHost({ cmd, [cmd]: rows, compIds });
        await h.settle();
      } else {
        h.setValue(selector, title);
        await h.settle(1700);
      }
      assert.strictEqual(lastWriteJson(h, rel)[key][0].title, title, `${cmd} ${mode} did not save`);
      // Also check the intermediate threat write made by project autosave.
      for (const [, docRel, docKey] of cases) {
        for (const write of h.writes.slice(start).filter((w) => w.path === path.join(projectDir, docRel))) {
          const envelope = JSON.parse(write.text);
          delete envelope[docKey];
          assert.deepStrictEqual(envelope, metadata, `${cmd} ${mode} lost ${docKey} envelope`);
        }
      }
      await reopen();
      assert.strictEqual(h.must(selector).value, title, `${cmd} ${mode} not restored on reopen`);
      const doc = JSON.parse(h.readText(path.join(projectDir, rel)));
      assert.deepStrictEqual(h.toWebview.filter((m) => m.cmd === "init").at(-1).data[cmd], doc[key]);
      delete doc[key];
      assert.deepStrictEqual(doc, metadata, `${cmd} ${mode} envelope lost on reopen`);
    }
  }
}

async function checkThreatCostPersistence(h, mod) {
  const rel = "06-threats/threats.json", file = path.join(projectDir, rel);
  const compIds = JSON.parse(h.readText(path.join(projectDir, "03-system-assets/system.json"))).components.map((c) => c.id);
  const envelope = { revision: 0, futureMetadata: { nested: ["keep envelope"] } };
  const metadata = { nested: ["keep row", { enabled: false }] };
  const costs = { requiredSkill: 2, requiredAccess: 4,
    costFactors: { time: 5, exploitability: 2, futureMetadata: metadata },
    costRationales: { time: "Assessed time", exploitability: "", futureMetadata: metadata },
    costLikelihood: 0, costLikelihoodProposal: 0 };
  const keys = Object.keys(costs);
  const bare = { id: "T-COST", title: "Cost persistence", stride: ["T"], components: [compIds[0]],
    likelihood: 3, impact: 3, status: "open", assets: [], futureMetadata: metadata };
  const saved = () => JSON.parse(h.readText(file)).threats[0];
  const absent = (row) => keys.forEach((key) => assert.ok(!Object.hasOwn(row, key), `${key} must remain absent`));
  const reopen = async () => {
    h.close(); await mod.openWizard(ctx); h.openDom(); await h.settle();
    assert.deepStrictEqual(h.toWebview.filter((m) => m.cmd === "init").at(-1).data.threats, [saved()]);
  };
  const save = async (mode, row) => {
    const start = h.writes.length;
    h.deliverToHost(mode === "explicit" ? { cmd: "threats", threats: [row], compIds }
      : { cmd: "autoSave", data: { threats: [row] } });
    await h.settle();
    assert.ok(h.writes.length > start, `${mode} did not save`);
    const doc = JSON.parse(h.readText(file)); delete doc.threats;
    assert.deepStrictEqual(doc, envelope, `${mode} lost document envelope`);
    return saved();
  };
  for (const mode of ["explicit", "autoSave"]) {
    h.overlay.set(file, JSON.stringify({ ...envelope, threats: [] }));
    const defaults = { ...bare }; delete defaults.likelihood;
    absent(await save(mode, defaults));
    if (mode === "explicit") assert.strictEqual(saved().likelihood, 3, "missing likelihood defaults to 3");
    await reopen();
    assert.strictEqual(h.must('[data-i="0"][data-k="likelihood"]').value, "3");
    // New row with zero probability/proposal and an independently accepted likelihood.
    let expected = { ...bare, id: `T-COST-${mode}`, likelihood: 4, ...costs, incomingMetadata: metadata };
    assert.deepStrictEqual(await save(mode, expected), expected);
    expected = { ...expected, requiredSkill: 5, requiredAccess: 1, costLikelihood: 0.75,
      costLikelihoodProposal: 5, costFactors: { ...costs.costFactors, time: 1 },
      costRationales: { ...costs.costRationales, time: "Reassessed" } };
    assert.deepStrictEqual(await save(mode, expected), expected, "existing cost edits lost or accepted automatically");
    expected = { ...expected, likelihood: 0 };
    assert.deepStrictEqual(await save(mode, expected), expected, "manual zero likelihood replaced by proposal");
    await reopen();
    assert.strictEqual(h.must('[data-i="0"][data-k="likelihood"]').value, "0");
    assert.strictEqual(h.must('[data-i="0"][data-k="likelihood"]').min, "0");
    const omitted = { ...expected, title: "Unrelated edit" }; keys.forEach((key) => delete omitted[key]);
    if (mode === "explicit") delete omitted.futureMetadata;
    assert.deepStrictEqual(await save(mode, omitted), mode === "explicit" ? { ...expected, title: omitted.title } : omitted,
      "explicit omission must preserve; autosave omission must remove");
    await save(mode, expected);
    const cleared = { ...expected }; keys.forEach((key) => { cleared[key] = null; });
    const removed = { ...expected }; keys.forEach((key) => delete removed[key]);
    assert.deepStrictEqual(await save(mode, cleared), removed, "null must remove every optional cost field");
    absent(saved());
    await save(mode, expected);
    expected = { ...expected, costFactors: {}, costRationales: { time: "" } };
    assert.deepStrictEqual(await save(mode, expected), expected, "empty map/string resurrected assessment");
    expected = { ...expected, costRationales: {} };
    assert.deepStrictEqual(await save(mode, expected), expected, "empty rationales resurrected assessment");
    await reopen();
  }
  // Real UI edits/history must carry the complete assessment without recomputation.
  const assessed = { ...bare, likelihood: 0, ...costs, costLikelihoodProposal: 4 };
  await save("explicit", { ...assessed, likelihood: 3 }); await reopen();
  const likelihood = '[data-i="0"][data-k="likelihood"]';
  h.setValue(likelihood, "0"); await h.settle(1700);
  assert.deepStrictEqual(saved(), assessed, "UI likelihood zero must survive autosave independently of proposal");
  h.click("#undoBtn"); await h.settle(1700);
  assert.deepStrictEqual(saved(), { ...assessed, likelihood: 3 }, "undo must restore selected likelihood");
  h.click("#redoBtn"); await h.settle(1700);
  assert.deepStrictEqual(saved(), assessed, "redo must restore likelihood zero");
  await reopen();
  assert.strictEqual(h.must(likelihood).value, "0", "UI likelihood zero must survive reopen");
  await save("explicit", assessed); await reopen();
  const title = '[data-i="0"][data-k="title"]';
  h.setValue(title, "Title only");
  await h.settle(1700);
  assert.deepStrictEqual(saved(), { ...assessed, title: "Title only" });
  h.click("#undoBtn"); await h.settle(1700);
  assert.deepStrictEqual(saved(), assessed);
  h.click("#redoBtn"); await h.settle(1700);
  assert.deepStrictEqual(saved(), { ...assessed, title: "Title only" });
  await reopen();
  assert.strictEqual(h.must(title).value, "Title only");
  // Factor controls are separate: a real title edit records the pre-update snapshot, then the
  // explicit host response supplies cost changes. Undo/redo persists those full snapshots.
  await save("autoSave", bare); await reopen();
  for (const next of [assessed, { ...assessed, costFactors: {}, costRationales: { time: "" } }]) {
    const previous = saved();
    h.setValue(title, "History checkpoint");
    await save("explicit", next);
    h.click("#undoBtn"); await h.settle(1700);
    assert.deepStrictEqual(saved(), previous, "undo must restore full snapshot, including absent cost fields");
    h.click("#redoBtn"); await h.settle(1700);
    assert.deepStrictEqual(saved(), next, "redo must restore cost edits/clearing without recomputation");
    await reopen();
  }
  console.log("  Threat cost persistence: both save paths, omission/null/empty/zero, metadata, reopen and history passed.");
}

async function checkThreatCostControls(h, mod) {
  const file = path.join(projectDir, "06-threats/threats.json");
  const projectFile = path.join(projectDir, "01-project-description/project.json");
  const compIds = JSON.parse(h.readText(path.join(projectDir, "03-system-assets/system.json"))).components.map((c) => c.id);
  const project = { ...JSON.parse(h.readText(projectFile)), slTarget: "SL2" };
  for (const key of ["riskScoringMethod", "costFactorWeights", "accessProbabilities", "likelihoodProbabilityThresholds"]) delete project[key];
  const metadata = { nested: ["preserve", { enabled: false }] };
  const bare = { id: "T-CONTROLS", title: "Cost controls", stride: ["T"], components: [compIds[0]], assets: [],
    likelihood: 4, impact: 3, status: "mitigated", futureMetadata: metadata };
  const saved = () => JSON.parse(h.readText(file)).threats[0];
  const field = (key) => `[data-i="0"][data-k="${key}"]`;
  const cost = (key) => `[data-i="0"][data-cost="${key}"]`;
  const factor = (key, rationale = false) => `${cost(rationale ? "costRationales" : "costFactors")}[data-cost-key="${key}"]`;
  const factors = [
    ["time", "Time effort", ["Minutes", "Hours", "Days", "Weeks", "Months+"]],
    ["exploitability", "Exploitability", ["Trivial", "Easy", "Moderate", "Difficult", "Very Difficult"]],
    ["window", "Window of opportunity", ["Permanent", "Regular", "Occasional", "Brief", "One-Time"]],
    ["detection", "Detection probability", ["None", "Low", "Moderate", "High", "Very High"]],
    ["notoriety", "Prior knowledge", ["Public", "Known", "Limited", "Internal", "Unknown"]],
    ["prep", "Preparation effort", ["None", "Software setup", "Test environment", "Procure", "Infrastructure"]],
    ["abort", "Abort risk", ["Robust", "Rare", "Moderate", "Frequent", "Very Likely"]],
  ];
  const reopen = async () => { h.close(); await mod.openWizard(ctx); h.openDom(); await h.settle(); };
  const preview = (probability, proposal) => {
    assert.strictEqual(h.must("[data-cost-probability]").textContent, probability);
    assert.strictEqual(h.must("[data-cost-proposal]").textContent, proposal);
  };
  const persist = async (expected) => { await h.settle(1700); assert.deepStrictEqual(saved(), expected); };
  h.overlay.set(projectFile, JSON.stringify(project));
  h.overlay.set(file, JSON.stringify({ threats: [bare] }));
  await reopen();
  assert.strictEqual(h.must("#p-risk").value, "cost-based");
  assert.strictEqual(h.must(cost("requiredSkill")).value, "1");
  assert.strictEqual(h.must(cost("requiredAccess")).value, "3");
  assert.deepStrictEqual(Array.from(h.document.querySelectorAll(cost("costFactors")), (el) => el.dataset.costKey), factors.map(([key]) => key));
  for (const [key, label, options] of factors) {
    const select = h.must(factor(key)), rationale = h.must(factor(key, true));
    assert.strictEqual(select.closest("label").firstChild.textContent, label);
    assert.strictEqual(select.value, "3");
    assert.deepStrictEqual(Array.from(select.options, (o) => [o.value, o.textContent]),
      options.map((text, i) => [String(i + 1), `${i + 1} · ${text}`]));
    assert.strictEqual(rationale.tagName, "TEXTAREA");
    assert.strictEqual(rationale.placeholder, "Assessment reason");
    assert.strictEqual(rationale.value, "");
  }
  for (const [key, labels] of [
    ["requiredSkill", ["Script kiddie", "Experienced hacker", "Security engineer", "Expert team", "Nation-state"]],
    ["requiredAccess", ["Remote (unauth.)", "Remote (auth.)", "Adjacent / fieldbus", "Local (on site)", "Physical (open enclosure)"]],
  ]) assert.deepStrictEqual(Array.from(h.must(cost(key)).options, (o) => o.textContent), labels.map((label, i) => `${i + 1} · ${label}`));
  preview("30.0%", "L2 · Low");
  assert.ok(h.must("[data-cost-warning]").textContent.includes("Accepted likelihood L4"));
  assert.ok(h.must('[data-i="0"][data-dim="safety"]').closest(".bbselect"));
  h.setValue(field("title"), "Unrelated edit");
  await persist({ ...bare, title: "Unrelated edit" });
  h.click("#undoBtn"); await persist(bare); // Defaults must not become saved cost fields.
  h.setValue(cost("requiredSkill"), "5");
  await persist({ ...bare, requiredSkill: 5, status: "unfeasible", likelihood: 0, costLikelihood: 0, costLikelihoodProposal: 0 });
  preview("0.0%", "L0 · None");

  const configured = { ...project, riskScoringMethod: "cost-based",
    costFactorWeights: { time: 1, exploitability: 0, window: 0, detection: 0, notoriety: 0, prep: 0, abort: 0 },
    accessProbabilities: { 1: 0.5, 4: 0.625 }, likelihoodProbabilityThresholds: { 2: 0.1, 3: 0.125, 4: 0.3, 5: 0.8 } };
  let expected = { ...bare, requiredSkill: 2, requiredAccess: 3,
    costFactors: { time: 5, exploitability: 1, futureMetadata: metadata },
    costRationales: { time: "Keep rationale", futureMetadata: metadata },
    costLikelihood: 0.99, costLikelihoodProposal: 5 };
  h.overlay.set(projectFile, JSON.stringify(configured));
  h.overlay.set(file, JSON.stringify({ threats: [expected] }));
  await reopen();
  preview("10.0%", "L2 · Low");
  assert.ok(h.must("[data-cost-warning]").textContent.includes("saved proposal L5"));
  const likelihood = h.must(field("likelihood")); likelihood.focus();
  h.setValue(likelihood, "5"); expected = { ...expected, likelihood: 5 };
  assert.strictEqual(h.document.activeElement, likelihood);
  assert.ok(!h.must("[data-cost-warning]").textContent.includes("saved proposal"));
  assert.ok(h.must("[data-cost-warning]").textContent.includes("Accepted likelihood L5"));
  await persist(expected);
  for (const mode of ["exposure-exploitability-impact", "cost-based"]) {
    h.setValue("#p-risk", mode);
    assert.strictEqual(h.document.querySelector(cost("requiredSkill")) !== null, mode === "cost-based");
    assert.strictEqual(h.document.querySelector('[data-i="0"][data-fac="exposure"]') !== null, mode !== "cost-based");
    if (mode !== "cost-based") assert.ok(h.must('[data-i="0"][data-cvss="vector"]'));
    assert.ok(h.must('[data-i="0"][data-dim="safety"]').closest(".bbselect"));
    await persist(expected);
    assert.strictEqual(JSON.parse(h.readText(projectFile)).riskScoringMethod, mode);
    await reopen(); assert.strictEqual(h.must("#p-risk").value, mode);
    assert.deepStrictEqual(saved(), expected);
  }
  const access = h.must(cost("requiredAccess")); access.focus();
  h.setValue(access, "4");
  assert.strictEqual(h.document.activeElement, access);
  expected = { ...expected, requiredAccess: 4, likelihood: 3, costLikelihood: 0.125, costLikelihoodProposal: 3 };
  preview("12.5%", "L3 · Moderate");
  assert.strictEqual(h.must("[data-cost-warning]").textContent, "");
  await persist(expected);
  const feasible = expected;
  h.setValue(cost("requiredSkill"), "3");
  expected = { ...expected, requiredSkill: 3, status: "unfeasible", likelihood: 0, costLikelihood: 0, costLikelihoodProposal: 0 };
  await persist(expected);
  assert.strictEqual(h.must(field("status")).value, "unfeasible");
  assert.strictEqual(h.must(field("status")).closest("td").querySelector(".badge").textContent, "Unfeasible");
  assert.strictEqual(h.must(field("likelihood")).value, "0");
  assert.ok(h.must("#tp-0").textContent.includes("0 · None"));
  h.click("#undoBtn"); await persist(feasible); preview("12.5%", "L3 · Moderate");
  h.click("#redoBtn"); await persist(expected);
  await reopen(); preview("0.0%", "L0 · None"); assert.deepStrictEqual(saved(), expected);
  h.setValue("#p-sl", "SL3"); // Capability change is preview-only until an explicit calculator edit.
  preview("12.5%", "L3 · Moderate"); await persist(expected);
  h.setValue(cost("requiredAccess"), "1");
  expected = { ...expected, requiredAccess: 1, status: "open", likelihood: 2, costLikelihood: 0.1, costLikelihoodProposal: 2 };
  await persist(expected); preview("10.0%", "L2 · Low");
  h.setValue("#p-sl", "SL4");
  h.setValue(cost("requiredSkill"), "5");
  expected = { ...expected, requiredSkill: 5 };
  await persist(expected); preview("10.0%", "L2 · Low"); // SL4 capability is 5, not 4.
  h.setValue(field("likelihood"), "0"); expected = { ...expected, likelihood: 0 };
  assert.ok(h.must("[data-cost-warning]").textContent.includes("saved proposal L2"));
  await persist(expected);
  h.setValue(field("title"), "Manual override retained"); expected = { ...expected, title: "Manual override retained" };
  await persist(expected);
  await reopen(); assert.deepStrictEqual(saved(), expected);
  assert.strictEqual(h.must(field("likelihood")).value, "0");
  preview("10.0%", "L2 · Low");
  for (const key of ["costFactorWeights", "accessProbabilities", "likelihoodProbabilityThresholds"]) {
    assert.deepStrictEqual(JSON.parse(h.readText(projectFile))[key], configured[key]);
    assert.deepStrictEqual(h.lastToHost((m) => m.cmd === "autoSave").data.project[key], configured[key]);
  }
  // Every real factor/rationale control uses explicit-update semantics, including clearing.
  // Only time is weighted here: time=2 and configured access=0.5 yield 0.4 => configured L4.
  const edit = async (selector, value, patch) => {
    h.setValue(field("likelihood"), "0"); expected = { ...expected, likelihood: 0 };
    const previous = expected, control = h.must(selector);
    control.focus(); h.setValue(control, value);
    assert.strictEqual(h.document.activeElement, control, "cost edit replaced the focused control");
    expected = { ...expected, ...patch, likelihood: 4, costLikelihood: 0.4, costLikelihoodProposal: 4 };
    assert.strictEqual(h.must(field("likelihood")).value, "4");
    assert.strictEqual(h.must("[data-cost-warning]").textContent, "");
    preview("40.0%", "L4 · High");
    await persist(expected);
    h.click("#undoBtn"); await persist(previous);
    h.click("#redoBtn"); await persist(expected);
    await reopen();
    assert.deepStrictEqual(saved(), expected);
    assert.strictEqual(h.must(selector).value, value, "cost edit did not survive reopen");
    preview("40.0%", "L4 · High");
  };
  for (const [index, [key]] of factors.entries()) {
    const level = index % 4 + 2;
    await edit(factor(key), String(level), { costFactors: { ...expected.costFactors, [key]: level } });
    const reason = `${key}: </textarea><b>not markup</b> & "quoted"\nAssessment`;
    await edit(factor(key, true), reason, { costRationales: { ...expected.costRationales, [key]: reason } });
  }
  const explicitSave = async () => {
    const start = h.writes.length;
    // The wizard autosaves; exercise the explicit host save path with its real UI payload.
    const rows = h.lastToHost((m) => m.cmd === "autoSave").data.threats;
    h.deliverToHost({ cmd: "threats", threats: rows, compIds });
    await h.settle();
    assert.ok(h.writes.length > start, "explicit save did not write");
    assert.deepStrictEqual(saved(), expected);
    await reopen(); assert.deepStrictEqual(saved(), expected);
    for (const [key] of factors) {
      assert.strictEqual(h.must(factor(key)).value, String(expected.costFactors[key]));
      assert.strictEqual(h.must(factor(key, true)).value, expected.costRationales[key]);
    }
  };
  await explicitSave();
  for (const [key] of factors) {
    await edit(factor(key, true), "", { costRationales: { ...expected.costRationales, [key]: "" } });
  }
  await explicitSave();
  h.setValue(field("likelihood"), "1"); expected = { ...expected, likelihood: 1 };
  h.setValue(field("title"), "Factor assessments retained"); expected = { ...expected, title: "Factor assessments retained" };
  await persist(expected); await reopen();
  assert.deepStrictEqual(saved(), expected);
  assert.strictEqual(h.must(field("likelihood")).value, "1");
  preview("40.0%", "L4 · High");
  assert.ok(h.must("[data-cost-warning]").textContent.includes("Accepted likelihood L1"));
  console.log("  Threat cost controls: seven factors/rationales, clearing, defaults, configured proposals, SL-C, modes, overrides, saves and history passed.");
}

async function checkBugBar(h, mod) {
  const threatPath = "06-threats/threats.json", cmPath = "08-countermeasures/countermeasures.json";
  const kbPath = path.join(extDir, "runtime/.assets/knowledge-base/bug-bar.json");
  const catalogue = JSON.parse(h.readText(kbPath)), today = new Date().toISOString().slice(0, 10);
  const unknownDims = { futureScore: 99, futureMetadata: { tags: ["keep dimensions"] } };
  const threat = {
    ...JSON.parse(h.readText(path.join(projectDir, threatPath))).threats[0],
    likelihood: 3, impact: 2, status: "open", impactDimensions: unknownDims, ratedAt: "2020-01-02",
    futureMetadata: { nested: ["keep threat"] },
  };
  const cm = {
    id: "CM-BUGBAR", title: "Bug Bar regression", selected: true, futureMetadata: { nested: ["keep CM"] },
    addresses: [{ threat: threat.id, residualLikelihood: 2, residualImpact: 2, impactDimensions: unknownDims,
      ratedAt: "2020-01-02", ratedBy: "Reviewer", futureMetadata: { nested: ["keep link"] } }],
  };
  h.overlay.set(path.join(projectDir, threatPath), JSON.stringify({ threats: [threat] }));
  h.overlay.set(path.join(projectDir, cmPath), JSON.stringify({ countermeasures: [cm] }));
  const reopen = async () => { h.close(); await mod.openWizard(ctx); h.openDom(); await h.settle(); };
  await reopen();
  for (const residual of [false, true]) {
    const attrs = residual ? '[data-ri="0"][data-rj="0"]' : '[data-i="0"]';
    const dimAttr = residual ? "data-rdim" : "data-dim";
    const button = (key, score) => `${attrs}[${dimAttr}="${key}"][data-score="${score}"]`;
    const matrix = () => h.must(button("confidentiality", 3)).closest(".bbselect");
    const numeric = residual ? '[data-c="0"][data-j="0"][data-k="residualImpact"]' : '[data-i="0"][data-k="impact"]';
    const saved = () => residual ? lastWriteJson(h, cmPath).countermeasures[0].addresses[0] : lastWriteJson(h, threatPath).threats[0];
    const expected = JSON.parse(JSON.stringify(residual ? cm.addresses[0] : threat));
    assert.ok(matrix().textContent.includes(catalogue.rule), "bundled rule missing");
    assert.deepStrictEqual([...matrix().querySelectorAll(":scope > table > tbody > tr")].map((r) => r.cells[0].textContent),
      [5, 4, 3, 2, 1].map((score) => `${score} · ${catalogue.dimensions[0].levels.find((l) => l.score === score).label}`));
    for (const d of catalogue.dimensions) {
      assert.ok(matrix().textContent.includes(d.label), "bundled dimension label missing");
      for (const l of d.levels) assert.strictEqual(h.must(button(d.key, l.score)).textContent, l.scenario);
    }
    assert.strictEqual(matrix().querySelectorAll(".unset").length, 4);
    assert.ok(matrix().textContent.includes("Select the applicable scenario in every column."));
    const details = matrix().closest("details"); details.open = true;
    const savesBefore = h.toHost.filter((m) => m.cmd === "autoSave").length;
    h.click(button("confidentiality", 3));
    assert.ok(details.open && details.isConnected, "selection collapsed or replaced guided details");
    assert.strictEqual(h.document.activeElement, h.must(button("confidentiality", 3)), "selection lost keyboard focus");
    assert.strictEqual(h.must(numeric).value, "3");
    assert.strictEqual(matrix().querySelectorAll('[aria-pressed="true"]').length, 1);
    assert.strictEqual(h.must(button("confidentiality", 3)).getAttribute("aria-pressed"), "true");
    assert.strictEqual(matrix().querySelectorAll(".filled").length, 3);
    assert.strictEqual(h.must(button("confidentiality", 2)).getAttribute("aria-pressed"), "false");
    assert.ok(matrix().textContent.includes("Still missing: integrity, availability, safety."));
    h.click(button("safety", 5));
    assert.strictEqual(h.must(numeric).value, "5", "impact must be max of known dimensions only");
    assert.ok(matrix().textContent.includes("currently 5"));
    assert.deepStrictEqual(h.$$("#tp-0 .pill").map((p) => Number(p.textContent.split(" · ")[0])), residual ? [15, 10] : [15, 4]);
    h.click(button("safety", 5));
    assert.strictEqual(h.must(numeric).value, "3", "exact scenario click must unset");
    h.click(button("confidentiality", 3));
    assert.strictEqual(h.must(numeric).value, "0", "clearing final known dimension must reset impact");
    assert.strictEqual(matrix().querySelectorAll(".filled, .selected").length, 0);
    assert.strictEqual(matrix().querySelectorAll(".unset").length, 4);
    assert.deepStrictEqual(h.$$("#tp-0 .pill").map((p) => Number(p.textContent.split(" · ")[0])), residual ? [15, 0] : [0, 0]);
    Object.assign(expected, { [residual ? "residualImpact" : "impact"]: 0, ratedAt: today });
    await h.settle(1700);
    assert.strictEqual(h.toHost.filter((m) => m.cmd === "autoSave").length, savesBefore + 1, "selector double-saved");
    assert.deepStrictEqual(saved(), expected, "auto-save lost date or unrelated nested metadata");
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must(numeric).value, "3");
    await h.settle(1700);
    assert.deepStrictEqual(saved(), { ...expected, [residual ? "residualImpact" : "impact"]: 3,
      impactDimensions: { ...unknownDims, confidentiality: 3 } }, "undo was not persisted");
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must(numeric).value, "0");
    await h.settle(1700);
    assert.deepStrictEqual(saved(), expected, "redo was not persisted");
    await reopen();
    assert.strictEqual(h.must(numeric).value, "0", "reopen replaced zero with default impact");
    assert.strictEqual(matrix().querySelectorAll(".unset").length, 4);
    if (residual) assert.strictEqual(h.must("#rated-at-0-0").textContent, "Last rated " + today);
    else {
      // Give residual edits an initial impact ceiling so their risk pill changes are observable.
      h.click(button("safety", 5));
      await h.settle(1700);
    }
  }
  assert.deepStrictEqual(lastWriteJson(h, cmPath).countermeasures[0].futureMetadata, cm.futureMetadata);
  assert.ok(!JSON.stringify(h.lastToHost((m) => m.cmd === "autoSave").data).includes(catalogue.rule), "catalogue leaked into project state");
  const escaped = '<img src=x onerror="alert(1)"> & "catalogue"';
  catalogue.rule = escaped;
  catalogue.dimensions[0].label = escaped;
  catalogue.dimensions[0].levels.find((l) => l.score === 5).label = escaped;
  catalogue.dimensions[0].levels.find((l) => l.score === 5).scenario = escaped;
  h.overlay.set(kbPath, JSON.stringify(catalogue));
  await reopen();
  const matrix = h.must('[data-dim="confidentiality"][data-score="5"]').closest(".bbselect");
  assert.strictEqual(matrix.querySelector("p").textContent, escaped);
  assert.ok(matrix.querySelector("thead").textContent.includes(escaped));
  assert.ok(matrix.querySelector("tbody td").textContent.includes(escaped));
  assert.strictEqual(h.must('[data-dim="confidentiality"][data-score="5"]').textContent, escaped);
  assert.strictEqual(matrix.querySelector("img"), null, "catalogue text was rendered as HTML");
  checkLiveDomHandlers(h);
  // Invalid/unreadable JSON uses the same host fallback as an unavailable installed bundle.
  h.overlay.set(kbPath, "");
  await reopen();
  assert.strictEqual(h.$$('[data-act="bugBar"]').length, 0);
  assert.ok(h.$$(".bbselect").every((el) => el.textContent === "Bug bar reference not available."));
  h.overlay.delete(kbPath);
}

async function checkRiskMatrices(h, mod) {
  await h.settle(1700);
  const tp = "06-threats/threats.json", cp = "08-countermeasures/countermeasures.json", pp = "01-project-description/project.json";
  const kb = path.join(extDir, "runtime/.assets/knowledge-base/risk-scheme.json");
  const futureMetadata = { nested: ["preserve matrix metadata"] };
  const threats = [
    { id: "M1", title: "Matrix", likelihood: 5, impact: 5, futureMetadata },
    { id: "M2", likelihood: 2, impact: 3 },
    { id: "L0", likelihood: 0, impact: 5 },
    { id: "I0", likelihood: 5, impact: 0 },
    { id: "U", likelihood: 5, impact: 5, status: "unfeasible" },
  ];
  const cms = [
    { id: "C1", futureMetadata, addresses: [{ threat: "M1", residualLikelihood: 2, futureMetadata }] },
    { id: "C2", addresses: [{ threat: "M1", residualImpact: 3 }] },
    { id: "C3", selected: false, addresses: [{ threat: "M1", residualLikelihood: 0, residualImpact: 0 }] },
  ];
  const project = { ...JSON.parse(h.readText(path.join(projectDir, pp))), acceptableRisk: 6, futureMetadata };
  const name = '<img src=x onerror="alert(1)"> & "band"';
  for (const [rel, data] of [[tp, { threats }], [cp, { countermeasures: cms }], [pp, project]]) h.overlay.set(path.join(projectDir, rel), JSON.stringify(data));
  h.overlay.set(kb, JSON.stringify({ matrix: { bands: [{ name, min: 1, max: 25, color: "#123456" }] } }));
  const reopen = async () => { h.close(); await mod.openWizard(ctx); h.openDom(); await h.settle(); };
  const cell = (mount, l, i) => h.must(`#${mount}-matrix td[data-l="${l}"][data-i="${i}"]`);
  const count = (l, i, n) => { for (const mount of ["threats", "cms"]) assert.strictEqual(cell(mount, l, i).querySelector(".n").textContent, n ? String(n) : ""); };
  const mode = (value, mount = "threats") => h.click(`#${mount}-matrix [data-mode="${value}"]`);
  const saves = () => h.toHost.filter((m) => m.cmd === "autoSave").length;
  await reopen();
  const before = saves(), diskBefore = [tp, cp, pp].map((p) => h.readText(path.join(projectDir, p)));
  for (const mount of ["threats", "cms"]) {
    const cells = h.$$(`#${mount}-matrix td[data-l]`);
    assert.deepStrictEqual(cells.map((c) => [Number(c.dataset.l), Number(c.dataset.i)]),
      Array.from({ length: 25 }, (_, n) => [n % 5 + 1, 5 - Math.floor(n / 5)]));
    assert.strictEqual(h.must(`#${mount}-matrix [aria-pressed="true"]`).textContent, "Residual");
    assert.strictEqual(cells.reduce((sum, c) => sum + Number(c.querySelector(".n").textContent), 0), 2);
    assert.strictEqual(cells[0].querySelector(".matrix-colour").style.backgroundColor, "rgb(18, 52, 86)");
    assert.ok(cell(mount, 2, 3).classList.contains("boundary-top") && cell(mount, 2, 3).classList.contains("boundary-right"));
    assert.ok(cell(mount, 2, 3).title.includes("= 6 (" + name + ") — M1, M2"));
    assert.ok(h.must(`#${mount}-matrix .matrix-legend`).textContent.includes(name));
    assert.strictEqual(h.$(`#${mount}-matrix img`), null);
  }
  count(2, 3, 2); mode("initial"); count(5, 5, 1); count(2, 3, 1); mode("residual", "cms"); count(2, 3, 2);
  await h.settle(1700);
  assert.strictEqual(saves(), before, "render/mode switch saved");
  assert.ok(h.must("#undoBtn").disabled && h.must("#redoBtn").disabled, "view-only mode entered history");
  assert.deepStrictEqual([tp, cp, pp].map((p) => h.readText(path.join(projectDir, p))), diskBefore);
  h.setValue('[data-i="0"][data-k="likelihood"]', "1"); count(1, 3, 1); count(2, 3, 1);
  mode("initial", "cms"); count(1, 5, 1);
  h.key("z", { ctrlKey: true }); count(5, 5, 1); assert.ok(h.must("#undoBtn").disabled, "mode added undo entry");
  h.key("y", { ctrlKey: true }); count(1, 5, 1); mode("residual");
  h.setValue('[data-c="1"][data-j="0"][data-k="residualImpact"]', "2"); count(1, 2, 1); count(1, 3, 0);
  h.key("z", { ctrlKey: true }); count(1, 3, 1);
  h.key("y", { ctrlKey: true }); count(1, 2, 1);
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, tp).threats, threats.map((t, i) => i ? t : { ...t, likelihood: 1 }));
  assert.deepStrictEqual(lastWriteJson(h, cp).countermeasures, cms.map((c, i) => i === 1 ? { ...c, addresses: [{ threat: "M1", residualImpact: 2 }] } : c));
  assert.strictEqual(lastWriteJson(h, pp).acceptableRisk, 6);
  assert.deepStrictEqual(lastWriteJson(h, pp).futureMetadata, futureMetadata);
  h.deliverToHost({ cmd: "ready" }); await h.settle(); count(1, 2, 1);
  assert.ok(h.must("#cms-matrix").textContent.includes("acceptable risk: 6"));
  const savedProject = JSON.parse(h.readText(path.join(projectDir, pp))); delete savedProject.acceptableRisk;
  h.overlay.set(path.join(projectDir, pp), JSON.stringify(savedProject)); h.overlay.set(kb, "");
  await reopen(); count(1, 2, 1);
  assert.ok(h.must("#threats-matrix").textContent.includes("acceptable risk: 12"));
  assert.ok(h.must("#cms-matrix .matrix-legend").textContent.includes("Critical"));
  assert.ok(cell("threats", 3, 4).classList.contains("boundary-top") && cell("threats", 3, 4).classList.contains("boundary-right"));
  h.dom.window.RiskModel.matrix = undefined;
  mode("initial");
  assert.ok(h.$$(".risk-matrix").every((el) => el.textContent === "Risk matrix not available."));
  h.overlay.delete(kb);
  console.log("  Risk matrices: orientation, counts, modes, bands, thresholds, edges, edits, history, reload and read-only metadata passed.");
}

async function wizard(h) {
  const mod = await load(h, "wizard.ts");
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();

  const init = h.toWebview.find((m) => m.cmd === "init");
  assert.ok(init, "host did not answer 'ready' with 'init'");
  const rl = readProjectJson("01-project-description/project.json");
  assert.strictEqual(h.must("#p-name").value, rl.device.name, "project name not rendered from init payload");
  assert.strictEqual(h.must("#p-title").value, rl.title || "", "project title not rendered independently from device name");
  assert.strictEqual(h.must("#p-status").value, rl.status || "draft", "project status not rendered from init payload");
  assert.strictEqual(h.must("#p-intendedUse").value, rl.intendedUse || "", "intended use not rendered from init payload");

  // Every step in the rail (scroll targets and host commands).
  const steps = h.$$("#rail .stepitem").length;
  assert.ok(steps >= 10, `expected at least 10 rail steps, found ${steps}`);
  for (let i = 0; i < steps; i++) { h.click(h.$$("#rail .stepitem")[i]); await h.settle(); }
  for (const id of ["vscode.openWith", "embedrisk.newAttackTree", "embedrisk.report", "embedrisk.kbBrowse"]) {
    assert.ok(h.commands.includes(id), `rail click did not reach host command ${id} (got ${h.commands.join(", ")})`);
  }

  // Assumption tabs: open each and add one assumption per category.
  const prefixes = { device: "AD-", system: "SYSA-", environment: "AE-", operational: "AO-" };
  const asmTabs = h.$$("[data-asmtab]").map((b) => b.dataset.asmtab);
  assert.deepStrictEqual([...asmTabs].sort(), Object.keys(prefixes).sort(), "unexpected assumption tabs");
  for (const tab of asmTabs) {
    h.click(`[data-asmtab="${tab}"]`);
    assert.ok(h.must(`[data-asmtab="${tab}"]`).classList.contains("active"), `assumption tab ${tab} not activated`);
    h.click(`[data-act="addAsm"][data-asm="${tab}"]`);
  }

  // System tabs: open each and click its add button.
  const sysAdd = { components: "addComp", interfaces: "addIf", boundaries: "addTb", assets: "addAs" };
  const sysTabs = h.$$("[data-systab]").map((b) => b.dataset.systab);
  assert.deepStrictEqual([...sysTabs].sort(), Object.keys(sysAdd).sort(), "unexpected system tabs");
  for (const tab of sysTabs) {
    h.click(`[data-systab="${tab}"]`);
    assert.ok(h.must(`[data-systab="${tab}"]`).classList.contains("active"), `system tab ${tab} not activated`);
    h.click(`[data-act="${sysAdd[tab]}"]`);
  }

  h.click('[data-act="addReq"]');
  h.click('[data-act="addT"]');
  h.click('[data-act="addC"]');

  // Edit a field, toggle a STRIDE chip, switch the SBOM source, then undo/redo via the documented shortcuts.
  h.setValue("#p-name", "RL-100 runtime test");
  h.click(h.must('#threats-body [data-role="stride"]'));
  h.setValue("#p-sbom-mode", "external");
  assert.notStrictEqual(h.must("#p-sbom-url").style.display, "none", "SBOM URL field not shown for external SBOM source");
  assert.strictEqual(h.must("#p-sbom-fmt").style.display, "none", "SBOM format field not hidden for external SBOM source");
  assert.ok(!h.must("#undoBtn").disabled, "undo not enabled after edits");
  h.key("z", { ctrlKey: true });
  h.key("y", { ctrlKey: true });
  h.key("z", { ctrlKey: true, shiftKey: true });

  const title = 'TRA: runtime <title> & "review"';
  h.setValue("#p-title", title);
  h.key("z", { ctrlKey: true });
  assert.strictEqual(h.must("#p-title").value, rl.title || "", "title undo did not restore the original value");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(h.must("#p-title").value, title, "title redo did not restore the edit");

  // Debounced auto-save (1.5 s) round trip through the real host handler.
  await h.settle(1700);
  const save = h.lastToHost((m) => m.cmd === "autoSave");
  assert.ok(save, "wizard never posted autoSave");
  assert.ok(h.toWebview.some((m) => m.cmd === "saved"), "host did not confirm the auto-save");
  const errs = h.toWebview.filter((m) => m.cmd === "err");
  assert.deepStrictEqual(errs, [], "host reported errors: " + JSON.stringify(errs));

  const rlAsm = readProjectJson("02-assumptions/assumptions.json");
  const d = save.data;
  for (const [cat, prefix] of Object.entries(prefixes)) {
    const before = new Set((rlAsm[cat] || []).map((a) => a.id));
    const added = (d.assumptions[cat] || []).filter((a) => !before.has(a.id));
    assert.strictEqual(added.length, 1, `expected one new ${cat} assumption, got ${JSON.stringify(added)}`);
    assert.match(added[0].id, new RegExp("^" + prefix + "[0-9]+$"), `new ${cat} assumption id has no webapp prefix`);
    assert.ok(h.document.body.innerHTML.includes(added[0].id) || cat !== "operational", `new ${cat} assumption ${added[0].id} not rendered`);
  }
  const newest = (list) => list[list.length - 1].id;
  assert.match(newest(d.system.components), /^C-[0-9]+$/, "new component id");
  assert.match(newest(d.system.interfaces), /^I-[0-9]+$/, "new interface id");
  assert.match(newest(d.system.trustBoundaries), /^TB-[0-9]+$/, "new trust boundary id");
  assert.match(newest(d.system.assets), /^AST-[0-9]+$/, "new asset id");
  assert.match(newest(d.requirements), /^R[0-9]+$/, "new requirement id");
  assert.match(newest(d.threats), /^T[0-9]+$/, "new threat id");
  assert.match(newest(d.cms), /^CM[0-9]+$/, "new countermeasure id");
  assert.strictEqual(d.project.name, "RL-100 runtime test", "edited project name not auto-saved");
  assert.strictEqual(d.project.title, title, "edited project title not auto-saved");
  assert.strictEqual(d.project.sbom.mode, "external", "SBOM source not auto-saved");
  assert.ok(lastWriteJson(h, "02-assumptions/assumptions.json"), "host did not write assumptions.json");
  const projectPath = "01-project-description/project.json";
  const savedProject = lastWriteJson(h, projectPath);
  assert.strictEqual(savedProject.title, title, "host did not persist project.title");
  const expectedDevice = { ...rl.device, name: "RL-100 runtime test" };
  for (const key of ["type", "version", "modelReference"]) expectedDevice[key] = rl.device[key] || "";
  assert.deepStrictEqual(savedProject.device, expectedDevice, "title editing changed device metadata");
  for (const key of Object.keys(rl)) {
    if (["title", "device", "scope", "slTarget", "riskScoringMethod", "reportOptions", "sbom", "acceptedNotices", "foreseeableUse", "repo"].includes(key)) continue;
    assert.deepStrictEqual(savedProject[key], rl[key], "project edit lost unrelated field: " + key);
  }

  // Undo/redo after the original save must persist, not merely update the DOM.
  h.click("#undoBtn");
  await h.settle(1700);
  assert.strictEqual(lastWriteJson(h, projectPath).title, rl.title || "", "undo was not saved");
  h.click("#redoBtn");
  await h.settle(1700);
  assert.strictEqual(lastWriteJson(h, projectPath).title, title, "redo was not saved");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  assert.strictEqual(h.must("#p-title").value, title, "title was not restored on reopen");
  assert.strictEqual(h.must("#p-name").value, "RL-100 runtime test", "device name was changed by title editing");
  h.setValue("#p-title", "");
  await h.settle(1700);
  assert.strictEqual(lastWriteJson(h, projectPath).title, "", "empty title did not clear the saved title");

  const deviceEdits = { type: 'Sensor <type> & "variant"', version: "FW 2.4 / HW B", modelReference: "RL-100/B" };
  for (const [key, value] of Object.entries(deviceEdits)) {
    const selector = "#p-" + key;
    assert.strictEqual(h.must(selector).value, expectedDevice[key], "device field not loaded: " + key);
    h.setValue(selector, value);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must(selector).value, expectedDevice[key], "device field undo failed: " + key);
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must(selector).value, value, "device field redo failed: " + key);
  }
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath).device, { ...expectedDevice, ...deviceEdits }, "device fields were not merged into existing metadata");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  for (const [key, value] of Object.entries(deviceEdits)) {
    assert.strictEqual(h.must("#p-" + key).value, value, "device field not restored on reopen: " + key);
    h.setValue("#p-" + key, "");
  }
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath).device, { ...expectedDevice, type: "", version: "", modelReference: "" }, "clearing device fields changed other metadata");

  const beforeStatusEdits = lastWriteJson(h, projectPath);
  delete beforeStatusEdits.status;
  h.overlay.set(path.join(projectDir, projectPath), JSON.stringify(beforeStatusEdits));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  assert.strictEqual(h.must("#p-status").value, "draft", "legacy project without status must default to draft");
  assert.deepStrictEqual(h.$$("#p-status option").map((option) => option.value), ["draft", "in-progress", "review", "released"]);
  for (const status of ["in-progress", "review", "released", "draft"]) {
    const previous = h.must("#p-status").value;
    h.setValue("#p-status", status);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must("#p-status").value, previous, "status undo failed");
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must("#p-status").value, status, "status redo failed");
    await h.settle(1700);
    assert.deepStrictEqual(lastWriteJson(h, projectPath), { ...beforeStatusEdits, status }, "status save changed other project metadata");
    h.close();
    await mod.openWizard(ctx);
    h.openDom();
    await h.settle();
    assert.strictEqual(h.must("#p-status").value, status, "status not restored on reopen");
  }
  for (const cmd of ["project", "autoSave"]) {
    const writesBefore = h.writes.length;
    h.deliverToHost(cmd === "project" ? { cmd, status: "invalid" } : { cmd, data: { project: { status: "invalid" } } });
    await h.settle();
    assert.strictEqual(h.writes.length, writesBefore, "invalid status must not write any artifacts");
    assert.match(h.toWebview[h.toWebview.length - 1].text, /Invalid project status/, "invalid status must report an error");
  }
  const beforeLists = lastWriteJson(h, projectPath);
  beforeLists.scope.futureMetadata = { tags: ["preserve"] };
  h.overlay.set(path.join(projectDir, projectPath), JSON.stringify(beforeLists));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  for (const key of ["inScope", "outOfScope"]) {
    await checkProjectList(h, mod, key, (doc) => doc.scope[key]);
  }
  assert.deepStrictEqual(lastWriteJson(h, projectPath), {
    ...beforeLists, scope: { ...beforeLists.scope, inScope: [], outOfScope: [] },
  }, "scope list editing lost other project or scope metadata");
  for (const cmd of ["project", "autoSave"]) {
    for (const key of ["inScope", "outOfScope", "foreseeableUse"]) {
      const writesBefore = h.writes.length;
      const invalid = { [key]: ["valid", 42] };
      h.deliverToHost(cmd === "project" ? { cmd, ...invalid } : { cmd, data: { project: invalid } });
      await h.settle();
      assert.strictEqual(h.writes.length, writesBefore, "invalid list must not write artifacts");
      assert.ok(h.toWebview[h.toWebview.length - 1].text.includes("Invalid " + key + " list"));
    }
  }
  const beforeCra = lastWriteJson(h, projectPath);
  const intendedUse = 'Level measurement <purpose> & "conditions"\nSecond line';
  h.setValue("#p-intendedUse", intendedUse);
  h.key("z", { ctrlKey: true });
  assert.strictEqual(h.must("#p-intendedUse").value, beforeCra.intendedUse, "intended use undo failed");
  h.key("y", { ctrlKey: true });
  assert.strictEqual(h.must("#p-intendedUse").value, intendedUse, "intended use redo failed");
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath), { ...beforeCra, intendedUse }, "intended use save changed other metadata");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  assert.strictEqual(h.must("#p-intendedUse").value, intendedUse, "intended use not restored on reopen");
  await checkProjectList(h, mod, "foreseeableUse", (doc) => doc.foreseeableUse);
  h.setValue("#p-intendedUse", "");
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath), { ...beforeCra, intendedUse: "", foreseeableUse: [] }, "clearing CRA fields changed other metadata");

  const beforeRepo = lastWriteJson(h, projectPath);
  beforeRepo.repo.futureMetadata = { tags: ["preserve"] };
  h.overlay.set(path.join(projectDir, projectPath), JSON.stringify(beforeRepo));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  const repoEdits = {
    projectBranchUrl: "https://example.com/_git/project?path=%2F&version=GBreview",
    kbUrl: "git@example.com:team/knowledge-base.git",
  };
  for (const [key, value] of Object.entries(repoEdits)) {
    assert.strictEqual(h.must("#p-" + key).value, beforeRepo.repo[key], "repository field not loaded: " + key);
    h.setValue("#p-" + key, value);
    h.key("z", { ctrlKey: true });
    assert.strictEqual(h.must("#p-" + key).value, beforeRepo.repo[key], "repository field undo failed: " + key);
    h.key("y", { ctrlKey: true });
    assert.strictEqual(h.must("#p-" + key).value, value, "repository field redo failed: " + key);
  }
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath), { ...beforeRepo, repo: { ...beforeRepo.repo, ...repoEdits } }, "repository edits did not preserve other metadata");
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  for (const [key, value] of Object.entries(repoEdits)) {
    assert.strictEqual(h.must("#p-" + key).value, value, "repository field not restored on reopen: " + key);
    h.setValue("#p-" + key, "");
  }
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath), { ...beforeRepo, repo: { ...beforeRepo.repo, projectBranchUrl: "", kbUrl: "" } }, "clearing repository URLs changed other metadata");
  const withoutRepo = lastWriteJson(h, projectPath);
  delete withoutRepo.repo;
  h.overlay.set(path.join(projectDir, projectPath), JSON.stringify(withoutRepo));
  h.close();
  await mod.openWizard(ctx);
  h.openDom();
  await h.settle();
  for (const key of Object.keys(repoEdits)) assert.strictEqual(h.must("#p-" + key).value, "", "missing repo did not default to empty fields");
  h.setValue("#p-projectBranchUrl", repoEdits.projectBranchUrl);
  await h.settle(1700);
  assert.deepStrictEqual(lastWriteJson(h, projectPath), { ...withoutRepo, repo: { projectBranchUrl: repoEdits.projectBranchUrl, kbUrl: "" } }, "editing a legacy project did not create repo");
  for (const cmd of ["project", "autoSave"]) {
    for (const key of ["intendedUse", "projectBranchUrl", "kbUrl"]) {
      const writesBefore = h.writes.length;
      const invalid = { [key]: 42 };
      h.deliverToHost(cmd === "project" ? { cmd, ...invalid } : { cmd, data: { project: invalid } });
      await h.settle();
      assert.strictEqual(h.writes.length, writesBefore, "invalid text must not write artifacts");
      assert.ok(h.toWebview[h.toWebview.length - 1].text.includes("Invalid " + key));
    }
  }
  const beforeLegacySave = lastWriteJson(h, projectPath);
  beforeLegacySave.repo.futureMetadata = { tags: ["preserve"] };
  h.overlay.set(path.join(projectDir, projectPath), JSON.stringify(beforeLegacySave));
  const form = h.lastToHost((m) => m.cmd === "autoSave" && typeof m.data?.project?.name === "string").data.project;
  const legacySave = {
    ...form, cmd: "project", bnd: form.boundary, ...repoEdits,
    inScope: ["  firmware  ", ""], outOfScope: ["  plant DCS  ", "   "],
    intendedUse: "Legacy save purpose", foreseeableUse: ["  Maintenance  ", ""],
  };
  h.deliverToHost(legacySave);
  await h.settle();
  const expectedLegacySave = {
    ...beforeLegacySave, repo: { ...beforeLegacySave.repo, ...repoEdits },
    scope: { ...beforeLegacySave.scope, inScope: ["firmware"], outOfScope: ["plant DCS"] },
    intendedUse: "Legacy save purpose", foreseeableUse: ["Maintenance"],
  };
  assert.deepStrictEqual(lastWriteJson(h, projectPath), expectedLegacySave, "explicit project save did not merge or clean new fields");
  for (const key of ["inScope", "outOfScope", "intendedUse", "foreseeableUse", "projectBranchUrl", "kbUrl"]) delete legacySave[key];
  h.deliverToHost(legacySave);
  await h.settle();
  assert.deepStrictEqual(lastWriteJson(h, projectPath), expectedLegacySave, "older save messages must preserve omitted fields");
  await checkSystemFields(h, mod);
  await checkAssetSummaries(h, mod);
  await checkRequirementDerivation(h, mod);
  await checkCountermeasureFields(h, mod);
  await checkDocumentEnvelopes(h, mod);
  await checkThreatCostPersistence(h, mod);
  await checkThreatCostControls(h, mod);
  await checkBugBar(h, mod);
  await checkRiskMatrices(h, mod);
  checkLiveDomHandlers(h);
}

async function attackTreeEditor(h) {
  const projectPath = path.join(projectDir, "01-project-description/project.json");
  const weights = { time: 1, exploitability: 0, window: 0, detection: 0, notoriety: 0, prep: 0, abort: 0 };
  h.overlay.set(projectPath, JSON.stringify({ costFactorWeights: weights }));
  h.overlay.set(path.join(projectDir, "07-attack-trees/attack-trees.json"), JSON.stringify({ trees: [{
    id: "AT1", title: "Weighted tree", root: { id: "g", kind: "goal", label: "Goal", gate: "AND", children: [
      { id: "s", kind: "step", label: "Weighted step", cost: { time: 1, exploitability: 5 }, skill: 2, access: 3 },
    ] },
  }] }));
  const stub = h.vscodeStub();
  let changeDocument, subscriptionDisposed = false;
  stub.workspace.onDidChangeTextDocument = (handler) => {
    changeDocument = handler;
    return { dispose() { subscriptionDisposed = true; } };
  };
  const mod = await bundleModule(path.join(srcDir, "attackTreeEditor.ts"), stub);
  const provider = new mod.AttackTreeEditor(ctx.extensionUri);
  const panel = h.createPanel();
  await provider.resolveCustomTextEditor(h.createDocument("07-attack-trees/attack-trees.json"), panel, {});
  h.openDom();
  await h.settle();
  assert.ok(h.toWebview.some((m) => m.type === "load"), "host did not answer 'ready' with 'load'");
  assert.ok(h.$$("#treesel option").length >= 1 && h.$$("#cv [data-id]").length > 1, "attack tree not rendered");
  assert.deepStrictEqual(h.toWebview.find((m) => m.type === "load").costFactorWeights, weights);
  assert.match(h.must("#metrics").textContent, /success ≈ 100%/, "initial project weights not evaluated");

  // Select a non-root node by clicking it on the canvas.
  const target = h.$$("#cv [data-id]")[1];
  const id = target.getAttribute("data-id");
  h.click(target);
  assert.strictEqual(h.must("#in-label").value.length > 0, true, "inspector not shown for selected node");
  assert.ok(h.$(`#cv [data-id="${id}"]`), "selected node vanished");

  // Unsaved project edits update metrics only; malformed intermediate JSON retains valid weights.
  for (const [text, probability] of [
    [JSON.stringify({ costFactorWeights: { ...weights, time: 0, exploitability: 1 } }), 20],
    ["{", 20], ["{}", 62],
  ]) {
    changeDocument({ document: { uri: Uri.file(projectPath), getText: () => text } });
    await h.settle();
    assert.match(h.must("#metrics").textContent, new RegExp(`success ≈ ${probability}%`));
    assert.strictEqual(h.must("#in-label").value, "Weighted step", "weight change reset selection");
  }
  assert.strictEqual(h.toHost.filter((m) => m.type === "save").length, 0, "weight changes wrote tree data");
  // Reopening/loading missing, malformed or empty project configuration defaults safely.
  const readFile = stub.workspace.fs.readFile;
  for (const text of [undefined, "{", "null", "{}"]) {
    stub.workspace.fs.readFile = async (uri) => {
      if (uri.fsPath !== projectPath) return readFile(uri);
      if (text === undefined) throw new Error("ENOENT (test project config)");
      return Buffer.from(text);
    };
    h.deliverToHost({ type: "ready" });
    await h.settle();
    assert.match(h.must("#metrics").textContent, /success ≈ 62%/, "project fallback did not restore default weights");
  }
  stub.workspace.fs.readFile = readFile;

  // Documented shortcuts: navigation, gate cycle, add child (+ prompt Enter), rename (+ Escape), delete, undo/redo.
  for (const k of ["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft"]) h.key(k);
  const savesBefore = h.toHost.filter((m) => m.type === "save").length;
  h.key("t");
  h.key("Enter");
  assert.strictEqual(h.must("#ov").style.display, "flex", "Enter did not open the label prompt");
  h.key("Enter", { target: h.must("#ovinput") });
  assert.strictEqual(h.must("#ov").style.display, "none", "Enter did not confirm the prompt");
  h.key("e");
  h.key("Escape", { target: h.must("#ovinput") });
  h.key("d");
  h.key("z", { ctrlKey: true });
  h.key("z", { ctrlKey: true, shiftKey: true });
  h.key("y", { ctrlKey: true });

  // Toolbar: add a tree, link a threat, switch trees.
  h.click('#bar [data-act="addtree"]');
  const linkOpt = h.$$("#threatsel option").find((o) => o.value);
  if (linkOpt) h.setValue("#threatsel", linkOpt.value);
  h.setValue("#treesel", "0");
  await h.settle();

  const saves = h.toHost.filter((m) => m.type === "save");
  assert.ok(saves.length > savesBefore + 3, `expected several saves, got ${saves.length - savesBefore}`);
  const saved = lastWriteJson(h, "07-attack-trees/attack-trees.json");
  assert.ok(saved && Array.isArray(saved.trees), "attack-trees.json not written by host");
  const added = saved.trees[saved.trees.length - 1];
  assert.match(added.id, /^AT[0-9]+$/, "new attack tree id has no webapp prefix");
  checkLiveDomHandlers(h);
  panel.dispose();
  assert.ok(subscriptionDisposed, "project document subscription was not disposed");
}

async function nativeDfdEditor(h) {
  const systemPath = "03-system-assets/system.json";
  const system = readProjectJson(systemPath);
  const fixtureDfd = readProjectJson("04-dfd/dfd.json");
  const anchor = fixtureDfd.nodes.find((n) => n.parent == null && n.componentRef && n.type !== "trust-boundary");
  assert.ok(anchor, "fixture needs a root component for interface visibility checks");
  system.interfaces.push(
    { id: "I-TEST-HIDDEN", name: "Hidden interface", component: anchor.componentRef, exposure: "local", hidden: true, tag: "HIDDEN" },
    { id: "I-TEST-VISIBLE", name: "Visible interface", component: anchor.componentRef, exposure: "local", tag: "VISIBLE" },
  );
  h.overlay.set(path.join(projectDir, systemPath), JSON.stringify(system));
  const mod = await load(h, "nativeDfdEditor.ts");
  const provider = new mod.NativeDfdEditor(ctx.extensionUri);
  const panel = h.createPanel();
  await provider.resolveCustomTextEditor(h.createDocument("04-dfd/dfd.json"), panel, {});
  h.openDom();
  await h.settle();
  assert.ok(h.toWebview.some((m) => m.type === "load"), "host did not answer 'ready' with 'load'");
  assert.strictEqual(h.$('[data-iface="I-TEST-HIDDEN"]'), null, "DFD rendered a hidden interface");
  assert.strictEqual(h.must('[data-iface="I-TEST-VISIBLE"] text').textContent, "VISIBLE", "DFD did not use the interface tag");
  const watcher = h.fileWatchers.find((w) => w.pattern.pattern === systemPath && w.pattern.baseUri.fsPath === projectDir);
  assert.ok(watcher, "DFD must watch system metadata for visibility resets");
  const hiddenInterface = system.interfaces.find((itf) => itf.id === "I-TEST-HIDDEN");
  hiddenInterface.hidden = false;
  hiddenInterface.tag = 'TAG<&"';
  h.overlay.set(path.join(projectDir, systemPath), JSON.stringify(system));
  h.track(watcher.change(Uri.file(path.join(projectDir, systemPath))));
  await h.settle();
  assert.strictEqual(h.must('[data-iface="I-TEST-HIDDEN"] text').textContent, 'TAG<&"', "system update did not restore the chip and its literal tag");
  hiddenInterface.hidden = true;
  h.overlay.set(path.join(projectDir, systemPath), JSON.stringify(system));
  h.track(watcher.change(Uri.file(path.join(projectDir, systemPath))));
  await h.settle();
  assert.strictEqual(h.$('[data-iface="I-TEST-HIDDEN"]'), null, "system update did not hide the chip");
  const nodes = h.$$("#cv [data-id]");
  assert.ok(nodes.length > 1, "DFD nodes not rendered");

  // Select a node with a click (mousedown + mouseup without movement).
  const target = nodes.find((n) => h.$("#sel option[value='" + n.getAttribute("data-id") + "']")) || nodes[0];
  h.mouse("mousedown", target);
  h.mouse("mouseup", target);
  assert.strictEqual(h.must("#sel").value, target.getAttribute("data-id"), "click did not select the node");
  assert.ok(h.$("#ins-label"), "inspector not shown for selected node");

  // Documented shortcuts.
  h.key("ArrowRight");
  h.key("ArrowLeft");
  h.key("t");
  assert.ok(h.must("#status").textContent.includes("Connect"), "t did not enter connect mode");
  h.key("t");
  h.key("p");
  assert.strictEqual(h.must("#ov").style.display, "flex", "p did not open the name prompt");
  h.key("Enter", { target: h.must("#ovinput") });
  const added = h.must("#sel").value;
  h.key("d");
  h.key("Enter", { target: h.must("#ovinput") });
  assert.ok(!h.$(`#cv [data-id="${added}"]`), "d + Enter did not delete the new node");
  h.key("z", { ctrlKey: true });
  h.key("z", { ctrlKey: true, shiftKey: true });
  h.key("y", { ctrlKey: true });

  // Drill into a component with children, then back up.
  const dfd = readProjectJson("04-dfd/dfd.json");
  const parent = dfd.nodes.find((n) => n.parent == null && dfd.nodes.some((c) => c.parent === n.id));
  if (parent) {
    h.setValue("#sel", parent.id);
    h.key("Enter");
    assert.ok(h.must("#crumb").textContent.includes(parent.label), "Enter did not drill into the component");
    h.key("Backspace");
    assert.strictEqual(h.must("#crumb").textContent, "root", "Backspace did not go up");
  }

  // Select a trust boundary from the dropdown and toggle a member.
  const tb = h.$$("#sel option").find((o) => /\(boundary\)$/.test(o.textContent));
  if (tb) {
    h.setValue("#sel", tb.value);
    const mem = h.$("#insp [data-mem]");
    if (mem) { h.click(mem); h.click(h.must("#insp [data-mem]")); }
  }
  await h.settle();

  const saved = lastWriteJson(h, "04-dfd/dfd.json");
  assert.ok(saved && Array.isArray(saved.nodes) && Array.isArray(saved.flows), "dfd.json not written by host");
  checkLiveDomHandlers(h);
  panel.dispose();
  assert.strictEqual(watcher.disposed, true, "system watcher was not disposed with the editor");
}

async function useCaseEditor(h) {
  const mod = await load(h, "useCaseEditor.ts");
  const provider = new mod.UseCaseEditor(ctx.extensionUri);
  await provider.resolveCustomTextEditor(h.createDocument("04b-use-cases/use-cases.json"), h.createPanel(), {});
  h.openDom();
  await h.settle();
  assert.ok(h.toWebview.some((m) => m.type === "load"), "host did not answer 'ready' with 'load'");
  const diagrams = readProjectJson("04b-use-cases/use-cases.json").diagrams || [];
  assert.strictEqual(h.$$("#diagSel option").length, Math.max(1, diagrams.length), "diagrams not listed");

  // draw.io iframe handshake (the frame itself is not loaded in jsdom).
  const win = h.dom.window;
  win.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ event: "init" }) }));

  for (const kind of ["actor", "misuse-actor", "action", "misuse-action"]) h.click(`[data-add-kind="${kind}"]`);
  h.click("#addConn");
  h.click("#addGroup");
  const member = h.$$("[data-group-member]").pop();
  if (member) h.click(member);
  h.setValue("#diagName", "Runtime test diagram");
  h.click("#addDiag");
  h.setValue("#diagSel", "0");
  h.click("#exitBtn");
  await h.settle();

  const saved = lastWriteJson(h, "04b-use-cases/use-cases.json");
  assert.ok(saved && Array.isArray(saved.diagrams), "use-cases.json not written by host");
  assert.match(saved.diagrams[saved.diagrams.length - 1].id, /^UC[0-9]+$/, "new diagram id has no webapp prefix");
  assert.ok(h.commands.includes("embedrisk.wizard") && h.disposed, "Exit did not return to the wizard");
  checkLiveDomHandlers(h);
}

async function kbBrowser(h) {
  const mod = await load(h, "kbBrowser.ts");
  await mod.openKbBrowser(ctx);
  h.openDom();
  await h.settle();
  const threatBtn = h.$('button[data-act="threat"]');
  const cmBtn = h.$('button[data-act="cm"]');
  assert.ok(threatBtn && cmBtn, "knowledge-base catalogue rows not rendered");
  h.click(threatBtn);
  h.click(cmBtn);
  await h.settle();
  const threats = lastWriteJson(h, "06-threats/threats.json");
  const cms = lastWriteJson(h, "08-countermeasures/countermeasures.json");
  assert.ok(threats && cms, "import did not write threats.json / countermeasures.json");
  assert.match(threats.threats[threats.threats.length - 1].id, /^T[0-9]+$/, "imported threat id");
  assert.match(cms.countermeasures[cms.countermeasures.length - 1].id, /^CM[0-9]+$/, "imported countermeasure id");
  checkLiveDomHandlers(h);
}

// The draw.io DFD editor only wraps an iframe: its own toolbar script is tested, the draw.io app is not loaded.
async function drawioDfdEditor(h) {
  const mod = await load(h, "dfdEditor.ts");
  const provider = new mod.DfdEditor(ctx.extensionUri);
  await provider.resolveCustomTextEditor(h.createDocument("04-dfd/dfd.json"), h.createPanel(), {});
  h.openDom();
  await h.settle(1300); // host pushes the first diagram after 1.2 s
  const loadMsg = h.toWebview.find((m) => m.type === "load");
  assert.ok(loadMsg && loadMsg.xml.includes("<mxGraphModel"), "host did not push the draw.io diagram");
  assert.ok(h.toWebview.some((m) => m.type === "status"), "host did not push the status line");

  const win = h.dom.window;
  win.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ event: "init" }) }));
  h.key("ArrowRight", { ctrlKey: true, altKey: true });
  h.key("ArrowLeft", { ctrlKey: true, altKey: true });
  await h.settle();
  win.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ event: "autosave", xml: loadMsg.xml }) }));
  await h.settle();
  assert.ok(h.toHost.some((m) => m.type === "sib") && h.toHost.some((m) => m.type === "save"), "toolbar/draw.io messages not forwarded");
  const saved = lastWriteJson(h, "04-dfd/dfd.json");
  assert.ok(saved && Array.isArray(saved.nodes), "dfd.json not written from the draw.io autosave");
}

const SCENARIOS = [
  ["wizard", wizard],
  ["attack-tree editor", attackTreeEditor],
  ["native DFD editor", nativeDfdEditor],
  ["use-case editor", useCaseEditor],
  ["KB browser", kbBrowser],
  ["draw.io DFD editor", drawioDfdEditor],
];

/* ---------- Run ---------- */
async function main() {
  const failures = [];
  const known = [];
  const knownHit = new Set();
  for (const [name, run] of SCENARIOS) {
    const h = new Harness(name);
    current = h;
    try {
      await run(h);
      await h.settle();
    } catch (err) {
      h.fail("scenario failed: " + errText(err));
    } finally {
      h.close();
    }
    for (const msg of h.failures) {
      const k = KNOWN_FAILURES.find((kf) => kf.webview === name && kf.match.test(msg));
      if (k) { known.push(`[${name}] ${msg}\n      ${k.todo}`); knownHit.add(k); } else failures.push(`[${name}] ${msg}`);
    }
    console.log(`${h.failures.length ? "FAIL" : "ok  "} ${name} (${h.toHost.length} webview->host, ${h.toWebview.length} host->webview messages)`);
  }
  current = null;
  for (const k of KNOWN_FAILURES) {
    if (!knownHit.has(k)) failures.push(`[${k.webview}] known failure no longer occurs, remove it from KNOWN_FAILURES: ${k.match}`);
  }
  if (known.length) console.warn("\nKNOWN FAILING (tracked, not fixed):\n  " + known.join("\n  "));
  if (failures.length) {
    console.error("\nWebview runtime check FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log(`\nAll ${SCENARIOS.length} webviews ran without runtime errors.`);
}

main().catch((err) => {
  console.error(errText(err));
  process.exit(1);
});
