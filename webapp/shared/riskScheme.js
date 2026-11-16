import { createHash } from "node:crypto";

const MAX_SCHEME_BYTES = 256 * 1024;
const LIKELIHOOD_KINDS = new Set(["criteria-max", "geometric-mean", "cost-based", "manual"]);
const IMPACT_KINDS = new Set(["criteria-max", "manual"]);
const TREATMENTS = new Set(["auto-accept", "optional", "required", "immediate"]);

function invalid(path, message) {
  throw new Error(`Invalid risk scheme ${path}: ${message}`);
}

function assertJsonValue(value, path, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "numbers must be finite");
    return;
  }
  if (typeof value !== "object") invalid(path, "must contain JSON data only");
  if (seen.has(value)) invalid(path, "must not contain circular references");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    invalid(path, "must contain plain JSON objects only");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") invalid(`${path}.${key}`, "is not allowed");
      assertJsonValue(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  return value;
}

function keysOnly(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "is not a supported property");
  }
}

function text(value, path) {
  if (typeof value !== "string" || !value.trim()) invalid(path, "must be a non-empty string");
  return value;
}

function normalizeAxis(axis, name, derivationKinds) {
  object(axis, name);
  keysOnly(axis, ["levels", "derivation", "criteria"], name);
  if (!Array.isArray(axis.levels) || axis.levels.length === 0) invalid(`${name}.levels`, "must be a non-empty array");
  const levels = axis.levels.map((level, index) => {
    const path = `${name}.levels[${index}]`;
    object(level, path);
    keysOnly(level, ["value", "code", "label", "description"], path);
    if (level.value !== index + 1) invalid(`${path}.value`, "values must be contiguous integers starting at 1");
    const normalized = { value: level.value, code: text(level.code, `${path}.code`), label: text(level.label, `${path}.label`) };
    if (level.description !== undefined) {
      if (typeof level.description !== "string") invalid(`${path}.description`, "must be a string");
      normalized.description = level.description;
    }
    return normalized;
  });

  object(axis.derivation, `${name}.derivation`);
  keysOnly(axis.derivation, ["kind", "probabilityThresholds"], `${name}.derivation`);
  if (!derivationKinds.has(axis.derivation.kind)) invalid(`${name}.derivation.kind`, `unknown kind '${axis.derivation.kind}'`);
  const derivation = { kind: axis.derivation.kind };
  if (axis.derivation.probabilityThresholds !== undefined) {
    if (name !== "likelihood" || derivation.kind !== "cost-based")
      invalid(`${name}.derivation.probabilityThresholds`, "is only supported for cost-based likelihood");
    const thresholds = object(axis.derivation.probabilityThresholds, `${name}.derivation.probabilityThresholds`);
    const entries = Object.entries(thresholds).sort(([a], [b]) => Number(a) - Number(b));
    let previous = 0;
    for (const [level, probability] of entries) {
      if (!/^[2-9]\d*$/.test(level) || Number(level) > levels.length)
        invalid(`${name}.derivation.probabilityThresholds.${level}`, "must refer to an existing likelihood level from 2 onward");
      if (typeof probability !== "number" || probability <= previous || probability > 1)
        invalid(`${name}.derivation.probabilityThresholds.${level}`, "must be strictly increasing and at most 1");
      previous = probability;
    }
    if (!entries.length) invalid(`${name}.derivation.probabilityThresholds`, "must not be empty");
    derivation.probabilityThresholds = Object.fromEntries(entries);
  }

  if (name === "likelihood" && derivation.kind === "cost-based" && !derivation.probabilityThresholds)
    invalid(`${name}.derivation.probabilityThresholds`, "is required for cost-based likelihood");
  if (!Array.isArray(axis.criteria)) invalid(`${name}.criteria`, "must be an array");
  const criterionIds = new Set();
  const criteria = axis.criteria.map((criterion, index) => {
    const path = `${name}.criteria[${index}]`;
    object(criterion, path);
    keysOnly(criterion, ["id", "label", "levelTexts"], path);
    const id = text(criterion.id, `${path}.id`);
    if (criterionIds.has(id)) invalid(`${path}.id`, `duplicate criterion id '${id}'`);
    criterionIds.add(id);
    const levelTexts = object(criterion.levelTexts, `${path}.levelTexts`);
    const normalizedTexts = {};
    for (const [level, description] of Object.entries(levelTexts)) {
      if (!/^[1-9]\d*$/.test(level) || Number(level) > levels.length)
        invalid(`${path}.levelTexts.${level}`, "must refer to an existing axis level");
      if (typeof description !== "string") invalid(`${path}.levelTexts.${level}`, "must be a string");
      normalizedTexts[level] = description;
    }
    return { id, label: text(criterion.label, `${path}.label`), levelTexts: normalizedTexts };
  });
  return { levels, derivation, criteria };
}

function normalizeClassification(input, likelihood, impact) {
  const path = "classification";
  object(input, path);
  keysOnly(input, ["kind", "levels", "matrix", "bands"], path);
  if (!["lookup", "product-bands"].includes(input.kind)) invalid(`${path}.kind`, `unknown kind '${input.kind}'`);
  if (!Array.isArray(input.levels) || input.levels.length === 0) invalid(`${path}.levels`, "must be a non-empty array");
  const ids = new Set();
  const ranks = new Set();
  const levels = input.levels.map((level, index) => {
    const entryPath = `${path}.levels[${index}]`;
    object(level, entryPath);
    keysOnly(level, ["id", "label", "rank", "color", "treatment", "acceptanceBy", "description"], entryPath);
    const id = text(level.id, `${entryPath}.id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) invalid(`${entryPath}.id`, "must be a lowercase identifier");
    if (ids.has(id)) invalid(`${entryPath}.id`, `duplicate level id '${id}'`);
    ids.add(id);
    if (!Number.isInteger(level.rank) || level.rank < 1 || ranks.has(level.rank)) invalid(`${entryPath}.rank`, "must be a unique positive integer");
    ranks.add(level.rank);
    if (typeof level.color !== "string" || !/^#[0-9a-f]{6}$/i.test(level.color)) invalid(`${entryPath}.color`, "must be a six-digit hex colour");
    if (!TREATMENTS.has(level.treatment)) invalid(`${entryPath}.treatment`, `unknown treatment '${level.treatment}'`);
    if (level.acceptanceBy !== undefined && level.acceptanceBy !== "management")
      invalid(`${entryPath}.acceptanceBy`, "must be 'management'");
    if (level.description !== undefined && typeof level.description !== "string") invalid(`${entryPath}.description`, "must be a string");
    const normalized = { id, label: text(level.label, `${entryPath}.label`), rank: level.rank, color: level.color, treatment: level.treatment };
    if (level.acceptanceBy !== undefined) normalized.acceptanceBy = level.acceptanceBy;
    if (level.description !== undefined) normalized.description = level.description;
    return normalized;
  });
  for (let rank = 1; rank <= levels.length; rank++) {
    if (!ranks.has(rank)) invalid(`${path}.levels`, "ranks must be contiguous starting at 1");
  }
  const idsByValue = new Set(ids);
  const maxRisk = likelihood.levels.length * impact.levels.length;
  const classification = { kind: input.kind, levels };
  if (input.kind === "lookup") {
    const matrix = object(input.matrix, `${path}.matrix`);
    if (input.bands !== undefined) invalid(`${path}.bands`, "is only supported for product-bands classification");
    const expectedImpact = impact.levels.map((level) => String(level.value));
    const expectedLikelihood = likelihood.levels.map((level) => String(level.value));
    for (const value of expectedImpact) {
      const row = object(matrix[value], `${path}.matrix.${value}`);
      keysOnly(row, expectedLikelihood, `${path}.matrix.${value}`);
      for (const likelihoodValue of expectedLikelihood) {
        if (row[likelihoodValue] === undefined) invalid(`${path}.matrix.${value}.${likelihoodValue}`, "matrix cell is missing");
        if (!idsByValue.has(row[likelihoodValue])) invalid(`${path}.matrix.${value}.${likelihoodValue}`, `unknown level id '${row[likelihoodValue]}'`);
      }
    }
    keysOnly(matrix, expectedImpact, `${path}.matrix`);
    classification.matrix = matrix;
  } else {
    if (input.matrix !== undefined) invalid(`${path}.matrix`, "is only supported for lookup classification");
    if (!Array.isArray(input.bands) || input.bands.length === 0) invalid(`${path}.bands`, "must be a non-empty array");
    const bands = input.bands.map((band, index) => {
      const bandPath = `${path}.bands[${index}]`;
      object(band, bandPath);
      keysOnly(band, ["level", "min", "max"], bandPath);
      if (!idsByValue.has(band.level)) invalid(`${bandPath}.level`, `unknown level id '${band.level}'`);
      if (!Number.isInteger(band.min) || !Number.isInteger(band.max) || band.min < 1 || band.max < band.min)
        invalid(bandPath, "min and max must be ordered positive integers");
      return { level: band.level, min: band.min, max: band.max };
    }).sort((a, b) => a.min - b.min);
    let nextMin = 1;
    for (const band of bands) {
      if (band.min !== nextMin) invalid(`${path}.bands`, "must cover risk scores without gaps or overlaps");
      nextMin = band.max + 1;
    }
    if (nextMin !== maxRisk + 1) invalid(`${path}.bands`, `must cover scores 1 through ${maxRisk}`);
    classification.bands = bands;
  }
  return classification;
}

function normalizeScheme(input, options = {}) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_SCHEME_BYTES) invalid("scheme", "exceeds the 256 KB limit");
    try {
      input = JSON.parse(input);
    } catch {
      invalid("JSON", "could not be parsed");
    }
  }
  assertJsonValue(input, "scheme");
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEME_BYTES) invalid("scheme", "exceeds the 256 KB limit");
  const source = JSON.parse(serialized);
  object(source, "scheme");
  keysOnly(source, ["schemaVersion", "id", "title", "version", "description", "likelihood", "impact", "classification", "highLevel", "acceptance"], "scheme");
  if (source.schemaVersion !== 2) invalid("schemaVersion", "must be 2");
  const id = text(source.id, "id");
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) invalid("id", "must be a lowercase scheme identifier");
  if (options.local === true && id.startsWith("builtin:")) invalid("id", "the 'builtin:' prefix is reserved");
  const likelihood = normalizeAxis(source.likelihood, "likelihood", LIKELIHOOD_KINDS);
  const impact = normalizeAxis(source.impact, "impact", IMPACT_KINDS);
  const classification = normalizeClassification(source.classification, likelihood, impact);
  const levelIds = new Set(classification.levels.map((level) => level.id));
  const highLevel = source.highLevel === undefined ? "high" : source.highLevel;
  if (!levelIds.has(highLevel)) invalid("highLevel", `unknown level id '${highLevel}'`);
  let acceptance;
  if (source.acceptance !== undefined) {
    object(source.acceptance, "acceptance");
    keysOnly(source.acceptance, ["defaultLevel"], "acceptance");
    if (!levelIds.has(source.acceptance.defaultLevel)) invalid("acceptance.defaultLevel", `unknown level id '${source.acceptance.defaultLevel}'`);
    acceptance = { defaultLevel: source.acceptance.defaultLevel };
  }
  const scheme = {
    schemaVersion: 2,
    id,
    title: text(source.title, "title"),
    version: text(source.version, "version"),
    likelihood,
    impact,
    classification,
    highLevel,
  };
  if (source.description !== undefined) {
    if (typeof source.description !== "string") invalid("description", "must be a string");
    scheme.description = source.description;
  }
  if (acceptance) scheme.acceptance = acceptance;
  return scheme;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(input) {
  const scheme = normalizeScheme(input);
  return createHash("sha256").update(stableStringify(scheme), "utf8").digest("hex");
}

export { MAX_SCHEME_BYTES, normalizeScheme, fingerprint };