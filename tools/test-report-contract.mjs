#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "tools/fixtures/en40000-project");
const expectedMarkers = ["EN40000 contract fixture", "Asset marker", "Threat marker", "Deployment marker", "integrity; availability", "Cause marker &lt;img src=x onerror=alert(1)&gt;", "Residual risks and expectations on users and integrators", "Within acceptance criteria", "Avoided", "Avoidance rationale", "Accepted deviations from the acceptance criteria", "Contract exception marker", "R-1"];
const failures = new Set();
const reports = [];

function check(condition, failure) {
    if (!condition) failures.add(failure);
}

function readGeneratedReport(projectDir) {
    return readFileSync(join(projectDir, "report/index.html"), "utf8");
}

function findLinks(html) {
    return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
        .map((match) => match[1] ?? match[2]);
}

function hasInjectedEventAttribute(html) {
    const normalized = html.replace(/&#(?:x27|39);/gi, "ENTITY_APOSTROPHE");
    return [...normalized.matchAll(/<[a-z][^>]*>/gi)].find(([tag]) => {
        const attributes = tag.matchAll(/\s+([\w:-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g);
        return [...attributes].some(([, name]) => /^on(?:error|mouseover)$/i.test(name));
    })?.[0] || null;
}

function extractCsvCells(csv) {
    return [...csv.matchAll(/(?:^|,)"((?:[^"]|"")*)"/gm)]
        .map((match) => match[1].replace(/""/g, '"'));
}

function contrastChoiceFor(background) {
    const hex = background.replace(/^#/, "");
    const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const luminance = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (value) => (Math.max(luminance, value) + 0.05) / (Math.min(luminance, value) + 0.05);
    return contrast(1) >= contrast(0.018) ? "#fff" : "#1d2430";
}

function matrixTextContrastIsComputed(html) {
    const cells = [...html.matchAll(/<td\b[^>]*style=["']background:(#[\da-f]{6});color:(#[\da-f]{3,6})["']/gi)];
    return cells.length > 0 && cells.every(([, background, foreground]) => foreground.toLowerCase() === contrastChoiceFor(background).toLowerCase());
}

function copyFixture(tempRoot, name) {
    const projectDir = join(tempRoot, name);
    cpSync(fixtureDir, projectDir, { recursive: true });
    return projectDir;
}

function runCli(binary, script, projectDir) {
    const result = spawnSync(binary, [script, projectDir], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${script} failed:\n${result.stderr || result.stdout}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), "embedrisk-report-contract-"));
const previousProjectsDir = process.env.TRA_PROJECTS_DIR;
try {
    const reviewPanel = readFileSync(join(root, "webapp/client/src/components/panels/ReviewPanel.tsx"), "utf8");
    const reportIframe = reviewPanel.match(/<iframe\b[^>]*>/)?.[0] || "";
    check(/\bsandbox="allow-popups allow-popups-to-escape-sandbox"/.test(reportIframe)
        && !/\ballow-scripts\b|\ballow-same-origin\b/.test(reportIframe),
        "F1: report iframe sandbox is missing or grants script/origin privileges");

    copyFixture(tempRoot, "server-project");
    process.env.TRA_PROJECTS_DIR = tempRoot;
    const { buildReport } = await import(pathToFileURL(join(root, "webapp/server/src/report.js")).href);
    const serverResult = await buildReport("server-project");
    reports.push({ name: "webapp/server", html: serverResult.html, csv: serverResult.files["traceability.csv"], json: serverResult.files["traceability.json"] });

    const nodeGenerators = [
        ["tools/generate-report.mjs", "tools/generate-report.mjs"],
        ["extension/generate-report.mjs", "vscode-extension/runtime/tools/generate-report.mjs"],
    ];
    for (const [name, script] of nodeGenerators) {
        const projectDir = copyFixture(tempRoot, name.replaceAll("/", "-"));
        runCli(process.execPath, join(root, script), projectDir);
        reports.push({
            name,
            html: readGeneratedReport(projectDir),
            csv: existsSync(join(projectDir, "report/traceability.csv"))
                ? readFileSync(join(projectDir, "report/traceability.csv"), "utf8")
                : null,
            json: existsSync(join(projectDir, "report/traceability.json"))
                ? readFileSync(join(projectDir, "report/traceability.json"), "utf8")
                : null,
        });
    }

    const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (python.error || python.status !== 0) {
        console.log("SKIP: python3 is unavailable; Python report generators were not run.");
    } else {
        for (const [name, script] of [
            ["tools/generate_report.py", "tools/generate_report.py"],
            ["extension/generate_report.py", "vscode-extension/runtime/tools/generate_report.py"],
        ]) {
            const projectDir = copyFixture(tempRoot, name.replaceAll("/", "-"));
            runCli("python3", join(root, script), projectDir);
            reports.push({ name, html: readGeneratedReport(projectDir), csv: null });
        }
    }

    for (const report of reports) {
        for (const marker of expectedMarkers) {
            check(report.html.includes(marker), `${report.name}: expected fixture marker ${marker}`);
        }
        check(/^<!doctype html><html lang=["']en["']/i.test(report.html), `${report.name}: document language metadata is missing`);
        check(/<meta\s+name=["']viewport["']/i.test(report.html), `${report.name}: viewport metadata is missing`);
        check((report.html.match(/<h1\b/gi) || []).length === 1, `${report.name}: report must have exactly one h1`);
        check(/<main\b/i.test(report.html), `${report.name}: main landmark is missing`);
        check(/@media\s+print/i.test(report.html), `${report.name}: print styles are missing`);
        const tables = [...report.html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(([table]) => table);
        check(tables.length > 0 && tables.every((table) => /<caption\b/i.test(table) && /<th\b[^>]*\bscope=["'](?:col|row)["']/i.test(table)),
            `${report.name}: every report table needs a caption and scoped headers`);
        const traceTable = tables.find((table) => /<caption>Traceability matrix<\/caption>/i.test(table));
        if (report.name === "webapp/server") {
            const traceTable = tables.find((table) => /<caption>Traceability matrix<\/caption>/i.test(table));
            const traceRow = traceTable?.match(/<tr id=["']threat-T-1["']>([\s\S]*?)<\/tr>/i)?.[1] || "";
            const traceCells = [...traceRow.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
                .map(([, cell]) => cell.replace(/<[^>]+>/g, "").trim());
            check(traceCells.slice(-5).join("|") === "shared-responsibility|integrator-operator|Deployment marker &lt;img src=x onerror=alert(1)&gt;|integrity; availability|Cause marker &lt;img src=x onerror=alert(1)&gt;",
                `${report.name}: traceability matrix values do not match the appended column headers`);
        }
        check(matrixTextContrastIsComputed(report.html), `${report.name}: matrix text color is not selected by relative luminance`);
        check(report.html.includes("shared-responsibility") && report.html.includes("integrator-operator"),
            `${report.name}: classification/responsibility fields are missing from the report`);
        check((report.html.match(/Within acceptance criteria \(scheme/g) || []).length === 2,
            `${report.name}: only threats at or below the acceptable threshold should receive the EN-405 statement`);
        check(/Content-Security-Policy/i.test(report.html)
            && /default-src 'none'; img-src data:; style-src 'unsafe-inline'/.test(report.html),
            `${report.name}: report CSP is missing or incomplete`);
        check(!report.html.includes("href='https://example.invalid/path'quoted'"),
            `F2: ${report.name} contains an unescaped apostrophe inside an href`);
        check(!/<script\b/i.test(report.html), `${report.name}: generated report contains a script element`);
        const injectedAttribute = hasInjectedEventAttribute(report.html);
        check(!injectedAttribute, `F2: ${report.name} contains an unescaped injected attribute: ${injectedAttribute}`);

        for (const href of findLinks(report.html)) {
            try {
                const parsed = new URL(href, "https://report.invalid/");
                check(parsed.protocol !== "javascript:" && parsed.protocol !== "data:", `F3: ${report.name} contains an unsafe href`);
            } catch {
                check(false, `F3: ${report.name} contains an invalid href`);
            }
        }
    }

    const safeExternalReport = reports.find((report) => findLinks(report.html).includes("https://example.invalid/ticket"));
    check(!!safeExternalReport, "Safe HTTPS links must remain links after hardening");
    check(reports.some((report) => findLinks(report.html).some((href) => href.includes("path&#39;quoted"))),
        "A safe HTTPS URL containing an apostrophe must remain linked and escaped");
    check(reports.some((report) => findLinks(report.html).includes("docs/evidence.pdf")),
        "A safe project-relative URL must remain linked");
    check(reports.some((report) => findLinks(report.html).includes("#assumption-AT-1")),
        "In-report anchor links must remain usable");
    for (const unsafePath of ["../outside.pdf", "..\\outside.pdf", "%2e%2e%2foutside.pdf", "/absolute.pdf", "//host/outside.pdf", "C:\\outside.pdf"]) {
        check(!reports.some((report) => findLinks(report.html).includes(unsafePath)),
            `F3: unsafe path ${unsafePath} was rendered as a link`);
    }
    check(/target=(?:"_blank"|'_blank')/.test(safeExternalReport?.html || "")
        && /rel=(?:"noopener noreferrer"|'noopener noreferrer')/.test(safeExternalReport?.html || ""),
        "Safe HTTPS links must open separately with noopener noreferrer");

    const jsonReports = reports.filter((report) => report.json);
    check(jsonReports.length > 0, "At least one report generator must produce traceability JSON");
    for (const report of jsonReports) {
        const row = JSON.parse(report.json)[0];
        check(row.classification === "shared-responsibility"
            && row.responsibility === "integrator-operator"
            && row.deploymentConstraints.includes("Deployment marker")
            && JSON.stringify(row.compromisedObjectives) === JSON.stringify(["integrity", "availability"])
            && row.cause.includes("Cause marker"),
            `${report.name}: traceability JSON is missing WP2 fields`);
    }

    const csvReports = reports.filter((report) => report.csv);
    check(csvReports.length > 0, "At least one report generator must produce traceability CSV");
    for (const report of csvReports) {
        const cells = extractCsvCells(report.csv);
        const csvLines = report.csv.trimEnd().split("\r\n");
        const headers = extractCsvCells(csvLines[0]);
        const firstRow = extractCsvCells(csvLines[1]);
        check(JSON.stringify(headers.slice(-5)) === JSON.stringify(["Classification", "Responsibility", "DeploymentConstraints", "CompromisedObjectives", "Cause"]),
            `${report.name}: traceability CSV is missing the trailing WP2/WP4 columns`);
        check(JSON.stringify(firstRow.slice(-5)) === JSON.stringify(["shared-responsibility", "integrator-operator", "Deployment marker <img src=x onerror=alert(1)>", "integrity; availability", "Cause marker <img src=x onerror=alert(1)>"]),
            `${report.name}: traceability CSV is missing WP2/WP4 field values`);
        const formula = cells.find((cell) => cell.includes("=HYPERLINK"));
        check(formula?.startsWith("'") === true, `F4: ${report.name} CSV contains a formula-prefixed cell`);
        const sumFormula = cells.find((cell) => cell.includes("@SUM(1)"));
        check(sumFormula?.startsWith("'") === true, `F4: ${report.name} CSV contains an @-prefixed formula cell`);
    }

    assert.deepEqual([...failures].sort(), [], `Report contract failures:\n- ${[...failures].sort().join("\n- ")}`);
    console.log(`PASS: report contract checked ${reports.length} generators.`);
} finally {
    if (previousProjectsDir === undefined) delete process.env.TRA_PROJECTS_DIR;
    else process.env.TRA_PROJECTS_DIR = previousProjectsDir;
    rmSync(tempRoot, { recursive: true, force: true });
}
