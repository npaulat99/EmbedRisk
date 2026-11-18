import * as vscode from "vscode";
import { resolve } from "node:path";

const RiskEngine = require("../media/risk-engine.js") as {
    createRiskEngine: (scheme: any) => { scheme: any; fingerprint: string };
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
const LIKELIHOOD_KINDS = ["criteria-max", "geometric-mean", "cost-based", "manual"];
const IMPACT_KINDS = ["criteria-max", "manual"];
const TREATMENTS = ["auto-accept", "optional", "required", "immediate"];

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function axis(scheme: any, name: "likelihood" | "impact", kinds: string[]) {
    const value = scheme[name];
    assert(value && Array.isArray(value.levels) && value.levels.length > 0, `${name}.levels must be a non-empty array`);
    assert(value.derivation && kinds.includes(value.derivation.kind), `${name}.derivation.kind is invalid`);
    value.levels.forEach((level: any, index: number) => {
        assert(level && level.value === index + 1 && Number.isInteger(level.value), `${name}.levels values must be contiguous from 1`);
        assert(typeof level.code === "string" && typeof level.label === "string", `${name}.levels[${index}] requires code and label`);
    });
    assert(Array.isArray(value.criteria), `${name}.criteria must be an array`);
    const ids = new Set<string>();
    value.criteria.forEach((criterion: any) => {
        assert(criterion && typeof criterion.id === "string" && criterion.id.length > 0, `${name}.criteria has an invalid id`);
        assert(!ids.has(criterion.id), `${name}.criteria contains duplicate id '${criterion.id}'`);
        ids.add(criterion.id);
    });
    if (name === "likelihood" && value.derivation.kind === "cost-based") {
        const thresholds = value.derivation.probabilityThresholds;
        assert(thresholds && Object.keys(thresholds).length > 0, "cost-based likelihood requires probability thresholds");
        let prior = 0;
        for (const [level, probability] of Object.entries(thresholds).sort(([a], [b]) => Number(a) - Number(b))) {
            assert(Number(level) >= 2 && Number(level) <= value.levels.length, `probability threshold level ${level} is out of range`);
            assert(typeof probability === "number" && probability > prior && probability <= 1, "probability thresholds must increase and be at most 1");
            prior = probability;
        }
    }
}

function normalizeRiskScheme(rawText: string, local: boolean) {
    assert(Buffer.byteLength(rawText, "utf8") <= 256 * 1024, "scheme exceeds the 256 KB limit");
    let scheme: any;
    try { scheme = JSON.parse(rawText); } catch { throw new Error("scheme JSON could not be parsed"); }
    assert(scheme && scheme.schemaVersion === 2, "schemaVersion must be 2");
    assert(typeof scheme.id === "string" && /^[a-z0-9][a-z0-9._:-]*$/.test(scheme.id), "id is invalid");
    if (local) assert(!scheme.id.startsWith("builtin:"), "the 'builtin:' prefix is reserved");
    assert(typeof scheme.title === "string" && scheme.title.trim(), "title is required");
    assert(typeof scheme.version === "string" && scheme.version.trim(), "version is required");
    axis(scheme, "likelihood", LIKELIHOOD_KINDS);
    axis(scheme, "impact", IMPACT_KINDS);

    const classification = scheme.classification;
    assert(classification && ["lookup", "product-bands"].includes(classification.kind), "classification.kind is invalid");
    assert(Array.isArray(classification.levels) && classification.levels.length > 0, "classification.levels must be a non-empty array");
    const levels = new Map<string, any>();
    const ranks = new Set<number>();
    classification.levels.forEach((level: any) => {
        assert(level && typeof level.id === "string" && /^[a-z][a-z0-9-]*$/.test(level.id), "classification level id is invalid");
        assert(!levels.has(level.id), `duplicate classification level id '${level.id}'`);
        assert(Number.isInteger(level.rank) && level.rank > 0 && !ranks.has(level.rank), "classification ranks must be unique positive integers");
        assert(typeof level.label === "string" && typeof level.color === "string" && /^#[0-9a-f]{6}$/i.test(level.color), "classification labels and six-digit colours are required");
        assert(TREATMENTS.includes(level.treatment), `classification level '${level.id}' has an invalid treatment`);
        if (level.acceptanceBy !== undefined) assert(level.acceptanceBy === "management", "acceptanceBy must be management");
        levels.set(level.id, level);
        ranks.add(level.rank);
    });
    for (let rank = 1; rank <= levels.size; rank++) assert(ranks.has(rank), "classification ranks must be contiguous from 1");
    const likelihoodCount = scheme.likelihood.levels.length;
    const impactCount = scheme.impact.levels.length;
    if (classification.kind === "lookup") {
        assert(classification.matrix && typeof classification.matrix === "object", "lookup matrix is required");
        for (let impact = 1; impact <= impactCount; impact++) {
            const row = classification.matrix[String(impact)];
            assert(row && typeof row === "object", `lookup matrix row ${impact} is missing`);
            for (let likelihood = 1; likelihood <= likelihoodCount; likelihood++)
                assert(levels.has(row[String(likelihood)]), `lookup matrix cell ${impact}/${likelihood} references an unknown level`);
        }
    } else {
        assert(Array.isArray(classification.bands) && classification.bands.length > 0, "product bands are required");
        const bands = [...classification.bands].sort((a: any, b: any) => a.min - b.min);
        let expected = 1;
        for (const band of bands) {
            assert(levels.has(band.level), `product band references an unknown level '${band.level}'`);
            assert(Number.isInteger(band.min) && Number.isInteger(band.max) && band.min === expected && band.max >= band.min, "product bands must be contiguous without overlaps");
            expected = band.max + 1;
        }
        assert(expected === likelihoodCount * impactCount + 1, "product bands must cover the full risk score range");
        classification.bands = bands;
    }
    assert(levels.has(scheme.highLevel || "high"), "highLevel references an unknown classification level");
    if (scheme.acceptance?.defaultLevel) assert(levels.has(scheme.acceptance.defaultLevel), "acceptance.defaultLevel references an unknown classification level");
    if (!scheme.highLevel) scheme.highLevel = "high";
    const engine = RiskEngine.createRiskEngine(scheme);
    return { scheme: engine.scheme, fingerprint: engine.fingerprint };
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
