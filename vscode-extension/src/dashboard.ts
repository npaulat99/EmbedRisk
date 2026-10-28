import * as vscode from "vscode";

const DashboardModel = require("../media/dashboard-model.js") as {
  buildDashboard: (input: any) => DashboardModel;
};

type DashboardNode = {
  label: string;
  description?: string;
  icon?: string;
  file?: string;
  collapsed?: boolean;
  command?: { command: string; args?: any[] };
  children?: DashboardNode[];
};
type DashboardModel = {
  title: string;
  description: string;
  stats: { label: string; value: number; file: string; warning?: boolean }[];
  initial: RiskSummary;
  residual: RiskSummary;
  threats: { id: string; label: string; description: string }[];
};
type RiskSummary = { maxScore: number; highCount: number; bands: { name: string; count: number }[] };

class DashboardProvider implements vscode.TreeDataProvider<DashboardNode> {
  private readonly changed = new vscode.EventEmitter<DashboardNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private model: DashboardModel = DashboardModel.buildDashboard({});

  refresh() {
    this.changed.fire();
  }

  setModel(model: DashboardModel) {
    this.model = model;
    this.refresh();
  }

  getTreeItem(node: DashboardNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length
      ? node.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.command) item.command = { ...node.command, title: node.label };
    else if (node.file) item.command = {
      command: "embedrisk.dashboardOpenFile",
      title: `Open ${node.file}`,
      arguments: [node.file],
    };
    return item;
  }

  getChildren(node?: DashboardNode): DashboardNode[] {
    if (node) return node.children || [];
    const stats = this.model.stats.map((stat) => ({
      label: stat.label,
      description: String(stat.value),
      icon: stat.warning ? "warning" : "symbol-number",
      file: stat.file,
    }));
    const riskNodes = (summary: RiskSummary): DashboardNode[] => [
      { label: `High+ (score ≥12): ${summary.highCount}`, icon: "warning" },
      { label: `Maximum score: ${summary.maxScore}`, icon: "graph" },
      ...summary.bands.map((band) => ({
        label: `${band.name}: ${band.count}`,
        icon: band.name === "Critical" || band.name === "High" ? "shield" : "circle-outline",
      })),
    ];
    const children: DashboardNode[] = [
      { label: "Summary counts", icon: "symbol-number", children: stats },
      { label: "Initial risk", description: `${this.model.initial.highCount} high+ · max ${this.model.initial.maxScore}`, icon: "warning", children: riskNodes(this.model.initial) },
      { label: "Residual risk", description: `${this.model.residual.highCount} high+ · max ${this.model.residual.maxScore}`, icon: "shield", children: riskNodes(this.model.residual) },
      {
        label: `Threats (${this.model.threats.length})`,
        icon: "bug",
        collapsed: true,
        children: this.model.threats.map((threat) => ({
          label: threat.label,
          description: threat.description,
          icon: "warning",
          command: threat.id ? { command: "embedrisk.wizard", args: [threat.id] } : undefined,
        })),
      },
      { label: "Open DFD canvas", icon: "device-desktop", command: { command: "embedrisk.dfdNative" } },
    ];
    return [{
      label: this.model.title,
      description: this.model.description,
      icon: "dashboard",
      children,
    }];
  }
}

async function readJson(uri: vscode.Uri) {
  try {
    return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return {};
  }
}

export function registerDashboard(ctx: vscode.ExtensionContext) {
  const provider = new DashboardProvider();
  const view = vscode.window.createTreeView("embedrisk.dashboard", { treeDataProvider: provider });
  const dashboardFiles = new Set([
    "03-system-assets/system.json",
    "05-requirements/requirements.json",
    "06-threats/threats.json",
    "08-countermeasures/countermeasures.json",
    "09-defects/defects.json",
  ]);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let projectRoot: vscode.Uri | undefined;
  const refresh = async () => {
    const [projectFile] = await vscode.workspace.findFiles("**/01-project-description/project.json", "**/node_modules/**", 1);
    if (!projectFile) {
      projectRoot = undefined;
      provider.setModel(DashboardModel.buildDashboard({}));
      return;
    }
    projectRoot = vscode.Uri.joinPath(projectFile, "..", "..");
    const [project, system, threats, countermeasures, requirements, defects, scheme] = await Promise.all([
      readJson(projectFile),
      readJson(vscode.Uri.joinPath(projectRoot, "03-system-assets", "system.json")),
      readJson(vscode.Uri.joinPath(projectRoot, "06-threats", "threats.json")),
      readJson(vscode.Uri.joinPath(projectRoot, "08-countermeasures", "countermeasures.json")),
      readJson(vscode.Uri.joinPath(projectRoot, "05-requirements", "requirements.json")),
      readJson(vscode.Uri.joinPath(projectRoot, "09-defects", "defects.json")),
      readJson(vscode.Uri.joinPath(ctx.extensionUri, "runtime", ".assets", "knowledge-base", "risk-scheme.json")),
    ]);
    provider.setModel(DashboardModel.buildDashboard({ project, system, threats, countermeasures, requirements, defects, scheme }));
  };
  const refreshSoon = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh().catch((error) => console.error("EmbedRisk dashboard refresh failed:", error));
    }, 120);
  };
  const watchers = [
    "**/01-project-description/*.json",
    "**/03-system-assets/*.json",
    "**/05-requirements/*.json",
    "**/06-threats/*.json",
    "**/08-countermeasures/*.json",
    "**/09-defects/*.json",
  ].map((pattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    watcher.onDidCreate(refreshSoon, undefined, ctx.subscriptions);
    watcher.onDidChange(refreshSoon, undefined, ctx.subscriptions);
    watcher.onDidDelete(refreshSoon, undefined, ctx.subscriptions);
    return watcher;
  });
  ctx.subscriptions.push(
    view,
    ...watchers,
    vscode.commands.registerCommand("embedrisk.dashboardRefresh", () => refresh()),
    vscode.commands.registerCommand("embedrisk.dashboardOpenFile", async (relative: string) => {
      if (!projectRoot || !dashboardFiles.has(relative)) return;
      const uri = vscode.Uri.joinPath(projectRoot, relative);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshSoon, undefined, ctx.subscriptions),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
  );
  void refresh().catch((error) => console.error("EmbedRisk dashboard refresh failed:", error));
}
