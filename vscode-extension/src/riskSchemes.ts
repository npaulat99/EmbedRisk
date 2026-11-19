import * as vscode from "vscode";
import { resolve } from "node:path";

const RiskEngine = require("../media/risk-engine.js") as {
    createRiskEngine: (scheme: any) => { scheme: any; fingerprint: string };
};
const { normalizeScheme, fingerprint } = require("./vendor/risk-scheme.js") as {
    normalizeScheme: (input: string, options?: { local?: boolean }) => any;
    fingerprint: (scheme: any) => string;
};

export interface RiskSchemeRegistry {
    schemes: any[];
    fingerprints: Record<string, string>;
    errors: { file: string; message: string }[];
}

export interface ProjectRiskScheme {
    id: string;
    scheme: any | null;
    fingerprint: string | null;
    warning: string | null;
}
export interface RiskSchemeContext {
    extensionUri: vscode.Uri;
    globalStorageUri: vscode.Uri;
}

const BUILTIN_FILES: Record<string, string> = {
    "builtin:5x5-exposure": "risk-scheme-5x5-exposure.json",
    "builtin:5x5-cost": "risk-scheme-5x5-cost.json",
};
function normalizeRiskScheme(rawText: string, local: boolean) {
    const scheme = normalizeScheme(rawText, { local });
    const engine = RiskEngine.createRiskEngine(scheme);
    return { scheme: engine.scheme, fingerprint: fingerprint(scheme) };
}

function localDirectory(ctx: RiskSchemeContext): vscode.Uri {
    const configured = vscode.workspace.getConfiguration?.("embedrisk")?.get<string>("riskSchemeDirectory", "")?.trim() || "";
    return configured ? vscode.Uri.file(resolve(configured)) : vscode.Uri.joinPath(ctx.globalStorageUri || ctx.extensionUri, "risk-schemes");
}

export async function loadRiskSchemes(ctx: RiskSchemeContext): Promise<RiskSchemeRegistry> {
    const schemes = new Map<string, any>();
    const fingerprints: Record<string, string> = {};
    const errors: { file: string; message: string }[] = [];
    const readFile = async (uri: vscode.Uri, label: string, local: boolean, expectedId?: string) => {
        try {
            const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
            const result = normalizeRiskScheme(text, local);
            if (expectedId && result.scheme.id !== expectedId) throw new Error(`expected built-in scheme ID '${expectedId}'`);
            if (schemes.has(result.scheme.id)) throw new Error(`duplicate risk scheme ID '${result.scheme.id}'`);
            schemes.set(result.scheme.id, result.scheme);
            fingerprints[result.scheme.id] = result.fingerprint;
        } catch (error: any) {
            errors.push({ file: label, message: String(error?.message || error) });
        }
    };

    for (const [id, file] of Object.entries(BUILTIN_FILES)) {
        const uri = vscode.Uri.joinPath(ctx.extensionUri, "runtime", ".assets", "knowledge-base", file);
        await readFile(uri, file, false, id);
    }

    const directory = localDirectory(ctx);
    try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
            if (!name.endsWith(".json") || !(type & vscode.FileType.File) || (type & vscode.FileType.SymbolicLink)) continue;
            await readFile(vscode.Uri.joinPath(directory, name), name, true);
        }
    } catch (error: any) {
        if (error?.code !== "FileNotFound") errors.push({ file: directory.fsPath, message: String(error?.message || error) });
    }
    return { schemes: [...schemes.values()], fingerprints, errors };
}

export function resolveProjectRiskScheme(project: any, registry: RiskSchemeRegistry): ProjectRiskScheme {
    const id = project?.riskSchemeId || (project?.riskScoringMethod === "exposure-exploitability-impact" ? "builtin:5x5-exposure" : "builtin:5x5-cost");
    const scheme = registry.schemes.find((item) => item.id === id);
    if (!scheme) return { id, scheme: null, fingerprint: null, warning: `Risk scheme '${id}' is unavailable. Risk ratings are read-only.` };
    const currentFingerprint = registry.fingerprints[id];
    if (project?.riskSchemeFingerprint && project.riskSchemeFingerprint !== currentFingerprint)
        return { id, scheme: null, fingerprint: currentFingerprint, warning: `Risk scheme '${id}' has changed since this project was assessed. Risk ratings are read-only.` };
    return { id, scheme, fingerprint: currentFingerprint, warning: null };
}
