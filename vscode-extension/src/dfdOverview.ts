import * as vscode from "vscode";

const DfdOverviewModel = require("../media/dfd-overview-model.js") as {
  buildOverview: (input: { project: any; system: any; dfd: any }) => OverviewModel;
  openAction: (node: OverviewNode) => { command: string; args: number[] };
};

type OverviewNode = {
  id: string;
  label: string;
  type: string;
  typeLabel: string;
  icon: string;
  layer: number;
  componentName?: string;
  memberCount: number;
  interfaces: string[];
  children: OverviewNode[];
};
type OverviewModel = { deviceName: string; roots: OverviewNode[] };
type Entry = { kind: "root" | "node" | "empty"; node?: OverviewNode };

class DfdOverviewProvider implements vscode.TreeDataProvider<Entry> {
  private readonly changed = new vscode.EventEmitter<Entry | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private model: OverviewModel = { deviceName: "Device", roots: [] };

  refresh() {
    this.changed.fire();
  }

  setModel(model: OverviewModel) {
    this.model = model;
    this.refresh();
  }

  getTreeItem(entry: Entry): vscode.TreeItem {
    if (entry.kind === "root") {
      const item = new vscode.TreeItem(this.model.deviceName, vscode.TreeItemCollapsibleState.Expanded);
      item.description = "Layer 1";
      item.iconPath = new vscode.ThemeIcon("device-desktop");
      return item;
    }
    if (entry.kind === "empty") return new vscode.TreeItem("No nodes yet.");

    const node = entry.node!;
    const item = new vscode.TreeItem(node.label, node.children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    const badges = [node.typeLabel, node.componentName, node.memberCount ? `${node.memberCount} members` : undefined, ...node.interfaces]
      .filter((badge): badge is string => !!badge);
    item.description = badges.join(" · ");
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.tooltip = `Open layer ${node.layer} in the draw.io editor. The editor cannot focus a specific node.`;
    item.command = { ...DfdOverviewModel.openAction(node), title: "Open DFD layer" };
    return item;
  }

  getChildren(entry?: Entry): Entry[] {
    if (!entry) return [{ kind: "root" }];
    if (entry.kind === "empty") return [];
    if (entry.kind === "node") return (entry.node?.children || []).map((node) => ({ kind: "node", node }));
    return this.model.roots.length
      ? this.model.roots.map((node) => ({ kind: "node", node }))
      : [{ kind: "empty" }];
  }
}

async function readJson(uri: vscode.Uri) {
  try {
    return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return {};
  }
}

export function registerDfdOverview(ctx: vscode.ExtensionContext) {
  const provider = new DfdOverviewProvider();
  const view = vscode.window.createTreeView("embedrisk.dfdOverview", { treeDataProvider: provider });
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    const [dfdFile] = await vscode.workspace.findFiles("**/04-dfd/dfd.json", "**/node_modules/**", 1);
    if (!dfdFile) {
      provider.setModel(DfdOverviewModel.buildOverview({ project: {}, system: {}, dfd: {} }));
      return;
    }
    const projectRoot = vscode.Uri.joinPath(dfdFile, "..", "..");
    const [project, system, dfd] = await Promise.all([
      readJson(vscode.Uri.joinPath(projectRoot, "01-project-description", "project.json")),
      readJson(vscode.Uri.joinPath(projectRoot, "03-system-assets", "system.json")),
      readJson(dfdFile),
    ]);
    provider.setModel(DfdOverviewModel.buildOverview({ project, system, dfd }));
  };
  const refreshSoon = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh().catch((error) => console.error("EmbedRisk DFD overview refresh failed:", error));
    }, 120);
  };
  const watchers = [
    "**/01-project-description/*.json",
    "**/03-system-assets/*.json",
    "**/04-dfd/*.json",
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
    vscode.commands.registerCommand("embedrisk.dfdOverviewRefresh", () => refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshSoon, undefined, ctx.subscriptions),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
  );
  void refresh().catch((error) => console.error("EmbedRisk DFD overview refresh failed:", error));
}
