import * as vscode from "vscode";
import * as path from "node:path";

const DiagnosticsModel = require("../media/validation-diagnostics.js") as {
  STEP_FILES: Record<string, string>;
  createValidationController: (deps: {
    findProjects: () => Promise<string[]>;
    readFile: (root: string, relative: string) => Promise<string>;
    clear: () => void;
    publish: (root: string, relative: string, issues: any[]) => Promise<void>;
  }) => { refresh: () => Promise<void> };
};
const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

export function registerValidationDiagnostics(ctx: vscode.ExtensionContext) {
  const collection = vscode.languages.createDiagnosticCollection("EmbedRisk");
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void controller.refresh().catch((error) => console.error("EmbedRisk validation refresh failed:", error));
    }, 120);
  };
  const controller = DiagnosticsModel.createValidationController({
    findProjects: async () => {
      const files = await vscode.workspace.findFiles("**/01-project-description/project.json", "**/node_modules/**");
      return files.map((file) => vscode.Uri.joinPath(file, "..", "..").fsPath);
    },
    readFile: async (root, relative) => Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, relative))),
    ).toString("utf8"),
    clear: () => collection.clear(),
    publish: async (root, relative, issues) => {
      const uri = vscode.Uri.file(path.join(root, relative));
      const diagnostics = issues.map((issue) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          issue.message,
          SEVERITY[issue.severity as keyof typeof SEVERITY] ?? vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = issue.source || "EmbedRisk";
        if (issue.key) diagnostic.code = issue.key;
        return diagnostic;
      });
      collection.set(uri, diagnostics);
    },
  });
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.json", false, false, false);
  watcher.onDidCreate(refresh, undefined, ctx.subscriptions);
  watcher.onDidChange(refresh, undefined, ctx.subscriptions);
  watcher.onDidDelete(refresh, undefined, ctx.subscriptions);
  ctx.subscriptions.push(
    collection,
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(refresh, undefined, ctx.subscriptions),
  );
  void controller.refresh().catch((error) => console.error("EmbedRisk validation refresh failed:", error));
  ctx.subscriptions.push({
    dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      collection.clear();
    },
  });
}
