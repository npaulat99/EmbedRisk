(function (g) {
    "use strict";

    var DEFAULT_BANDS = [
        { name: "Low", min: 1, max: 5, color: "#2e7d32" },
        { name: "Medium", min: 6, max: 11, color: "#f9a825" },
        { name: "High", min: 12, max: 19, color: "#ef6c00" },
        { name: "Critical", min: 20, max: 25, color: "#c62828" },
    ];
    var NONE = { id: "none", label: "None", rank: 0, color: "#6b7280", treatment: "auto-accept", score: 0 };

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function axisLevels(scale, prefix, fallback) {
        var source = Array.isArray(scale) && scale.length ? scale : fallback;
        return source.map(function (item, index) {
            var value = typeof item.value === "number" ? item.value : item.score;
            return { value: value || index + 1, code: prefix + (value || index + 1), label: item.label || String(value), description: item.description || item.desc };
        }).sort(function (a, b) { return a.value - b.value; });
    }

    function textMap(items) {
        var values = {};
        (items || []).forEach(function (item) { values[String(item.score)] = item.label; });
        return values;
    }

    function legacyScheme(scheme, project) {
        var source = scheme || {};
        var likelihoodScale = axisLevels(source.likelihood && source.likelihood.scale, "L", [
            { score: 1, label: "Very Low" }, { score: 2, label: "Low" }, { score: 3, label: "Medium" }, { score: 4, label: "High" }, { score: 5, label: "Very High" },
        ]);
        var impactScale = axisLevels(source.impact && source.impact.scale, "I", [
            { score: 1, label: "Negligible" }, { score: 2, label: "Minor" }, { score: 3, label: "Moderate" }, { score: 4, label: "Major" }, { score: 5, label: "Severe" },
        ]);
        var legacyFactors = source.likelihood && source.likelihood.factors || ["exposure", "exploitability"];
        var legacyDimensions = source.impact && source.impact.bugBarDimensions || ["confidentiality", "integrity", "availability", "safety"];
        var likelihoodCriteria = legacyFactors.map(function (id) {
            return { id: id, label: id, levelTexts: textMap(source.likelihood && source.likelihood.factorScale && source.likelihood.factorScale[id]) };
        });
        var impactTexts = {};
        impactScale.forEach(function (level) { impactTexts[String(level.value)] = level.description || level.label; });
        var impactCriteria = legacyDimensions.map(function (id) {
            return { id: id, label: id, levelTexts: impactTexts };
        });
        var sourceBands = source.matrix && Array.isArray(source.matrix.bands) && source.matrix.bands.length ? source.matrix.bands : DEFAULT_BANDS;
        var levels = sourceBands.map(function (band, index) {
            var id = String(band.name || "level-" + (index + 1)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
            var treatments = { low: "auto-accept", medium: "optional", high: "required", critical: "immediate" };
            return { id: id, label: band.name || id, rank: index + 1, color: band.color || "#6b7280", treatment: treatments[id] || "optional" };
        });
        var bands = sourceBands.map(function (band, index) {
            return { level: levels[index].id, min: band.min, max: band.max };
        });
        var likelihoodKind = project && project.riskScoringMethod === "cost-based" ? "cost-based" : "geometric-mean";
        var thresholds = project && project.likelihoodProbabilityThresholds || { 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };
        var derivation = likelihoodKind === "cost-based"
            ? { kind: likelihoodKind, probabilityThresholds: thresholds }
            : { kind: likelihoodKind };
        return {
            schemaVersion: 2,
            id: likelihoodKind === "cost-based" ? "builtin:5x5-cost" : "builtin:5x5-exposure",
            title: source.title || "Legacy risk scheme",
            version: String(source.version || "legacy"),
            likelihood: { levels: likelihoodScale, derivation: derivation, criteria: likelihoodCriteria },
            impact: { levels: impactScale, derivation: { kind: "criteria-max" }, criteria: impactCriteria },
            classification: { kind: "product-bands", levels: levels, bands: bands },
            highLevel: levels.some(function (level) { return level.id === "high"; }) ? "high" : levels[Math.min(2, levels.length - 1)].id,
            acceptance: { defaultLevel: levels.find(function (level) { return level.id === "medium"; })?.id || levels[0].id },
        };
    }

    function schemeFor(input, project) {
        var scheme = input && input.schemaVersion === 2 ? clone(input) : legacyScheme(input, project);
        if (!scheme.likelihood || !scheme.impact || !scheme.classification || !Array.isArray(scheme.classification.levels))
            throw new Error("Risk engine requires a valid normalized risk scheme");
        if (scheme.classification.kind === "product-bands" && Array.isArray(scheme.classification.bands))
            scheme.classification.bands.sort(function (a, b) { return a.min - b.min; });
        return scheme;
    }

    function stableStringify(value) {
        if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
        if (value && typeof value === "object") {
            return "{" + Object.keys(value).sort().map(function (key) {
                return JSON.stringify(key) + ":" + stableStringify(value[key]);
            }).join(",") + "}";
        }
        return JSON.stringify(value);
    }

    function sha256(text) {
        var constants = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];
        var bytes = Array.from(new TextEncoder().encode(text));
        var bitLength = bytes.length * 8;
        bytes.push(0x80);
        while (bytes.length % 64 !== 56) bytes.push(0);
        bytes.push(0, 0, 0, 0, (bitLength >>> 24) & 255, (bitLength >>> 16) & 255, (bitLength >>> 8) & 255, bitLength & 255);
        var hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        function rotate(value, count) { return (value >>> count) | (value << (32 - count)); }
        for (var offset = 0; offset < bytes.length; offset += 64) {
            var words = new Array(64);
            for (var index = 0; index < 16; index++) {
                var position = offset + index * 4;
                words[index] = ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
            }
            for (var word = 16; word < 64; word++) {
                var left = words[word - 15], right = words[word - 2];
                var sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
                var sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
                words[word] = (words[word - 16] + sigma0 + words[word - 7] + sigma1) >>> 0;
            }
            var a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], h = hash[7], gg = hash[6];
            for (var round = 0; round < 64; round++) {
                var sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
                var choose = (e & f) ^ (~e & gg);
                var temp1 = (h + sum1 + choose + constants[round] + words[round]) >>> 0;
                var sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
                var majority = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (sum0 + majority) >>> 0;
                h = gg; gg = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
            }
            hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
            hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
            hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
            hash[6] = (hash[6] + gg) >>> 0; hash[7] = (hash[7] + h) >>> 0;
        }
        return hash.map(function (value) { return value.toString(16).padStart(8, "0"); }).join("");
    }

    function createRiskEngine(input, project) {
        var scheme = schemeFor(input, project || {});
        var levelsById = new Map(scheme.classification.levels.map(function (level) { return [level.id, level]; }));
        var likelihoodLevels = scheme.likelihood.levels;
        var impactLevels = scheme.impact.levels;
        var highLevel = levelsById.get(scheme.highLevel || "high");
        var normalized = stableStringify(scheme);
        var schemeFingerprint = sha256(normalized);
        var lookupMatrix = scheme.classification.matrix;
        if (scheme.classification.kind === "product-bands") {
            lookupMatrix = {};
            impactLevels.forEach(function (impactLevel) {
                lookupMatrix[String(impactLevel.value)] = {};
                likelihoodLevels.forEach(function (likelihoodLevel) {
                    var score = likelihoodLevel.value * impactLevel.value;
                    var matchingBand = (scheme.classification.bands || []).find(function (item) { return score >= item.min && score <= item.max; });
                    lookupMatrix[String(impactLevel.value)][String(likelihoodLevel.value)] = matchingBand && matchingBand.level;
                });
            });
        }

        function range(axis) {
            if (axis === "likelihood") return likelihoodLevels;
            if (axis === "impact") return impactLevels;
            return [];
        }
        function inRange(axis, value) {
            return Number.isInteger(value) && range(axis).some(function (level) { return level.value === value; });
        }
        function criteria(axis) {
            return (scheme[axis] && scheme[axis].criteria || []).slice();
        }
        function criterionValues(threat, axis) {
            var definitions = criteria(axis);
            var explicit = threat && threat[axis + "Criteria"];
            var legacy = axis === "likelihood" ? threat && threat.likelihoodFactors : threat && threat.impactDimensions;
            return definitions.map(function (criterion) {
                var value = explicit && Object.prototype.hasOwnProperty.call(explicit, criterion.id)
                    ? explicit[criterion.id]
                    : legacy && legacy[criterion.id];
                return typeof value === "number" ? value : null;
            });
        }
        function deriveAxis(threat, axis) {
            if (!threat) return null;
            var axisScheme = scheme[axis];
            var derivation = axisScheme.derivation || { kind: "manual" };
            var stored = threat[axis];
            if (derivation.kind === "manual") return typeof stored === "number" ? stored : null;
            if (derivation.kind === "cost-based") {
                if (typeof threat.costLikelihoodProposal === "number") return threat.costLikelihoodProposal;
                var probability = typeof threat.costLikelihood === "number" ? threat.costLikelihood : threat.attackProbability;
                if (typeof probability !== "number") return null;
                var thresholds = derivation.probabilityThresholds || {};
                var matching = Object.entries(thresholds).map(function (entry) { return [Number(entry[0]), entry[1]]; })
                    .sort(function (a, b) { return b[0] - a[0]; });
                for (var thresholdIndex = 0; thresholdIndex < matching.length; thresholdIndex++) {
                    if (probability >= matching[thresholdIndex][1]) return matching[thresholdIndex][0];
                }
                return 1;
            }
            var values = criterionValues(threat, axis);
            var assessed = values.filter(function (value) { return typeof value === "number"; });
            if (!assessed.length) return null;
            if (derivation.kind === "criteria-max") return Math.max.apply(null, assessed);
            if (derivation.kind === "geometric-mean") {
                var completeValues = values.map(function (value) {
                    return typeof value === "number" ? value : Math.ceil(range(axis).length / 2);
                });
                return Math.round(Math.pow(completeValues.reduce(function (product, value) { return product * value; }, 1), 1 / completeValues.length));
            }
            return typeof stored === "number" ? stored : null;
        }
        function classify(likelihood, impact) {
            if (!inRange("likelihood", likelihood) || !inRange("impact", impact)) return NONE;
            var score = likelihood * impact;
            var id = lookupMatrix[String(impact)] && lookupMatrix[String(impact)][String(likelihood)];
            var level = id && levelsById.get(id);
            return level ? Object.assign({}, level, { score: score }) : NONE;
        }
        function classifyScore(score) {
            if (score <= 0) return NONE;
            if (scheme.classification.kind === "product-bands") {
                var band = (scheme.classification.bands || []).find(function (item) { return score >= item.min && score <= item.max; });
                var level = band && levelsById.get(band.level);
                return level ? Object.assign({}, level, { score: score }) : (scheme.classification.levels[0] || NONE);
            }
            return NONE;
        }
        function residual(threat, countermeasures) {
            if (threat.status === "unfeasible") return [0, 0];
            var links = (countermeasures || []).filter(function (cm) { return cm.selected !== false; })
                .flatMap(function (cm) { return (cm.addresses || []).filter(function (address) { return address.threat === threat.id; }); });
            if (!links.length) return [threat.likelihood, threat.impact];
            var likelihood = threat.likelihood, impact = threat.impact;
            links.forEach(function (address) {
                likelihood = Math.min(likelihood, address.residualLikelihood == null ? threat.likelihood : address.residualLikelihood);
                impact = Math.min(impact, address.residualImpact == null ? threat.impact : address.residualImpact);
            });
            return [likelihood, impact];
        }
        function riskOf(threat, countermeasures) {
            var initial = threat.status === "unfeasible" ? 0 : (threat.likelihood || 0) * (threat.impact || 0);
            var axes = residual(threat, countermeasures);
            var residualScore = (axes[0] || 0) * (axes[1] || 0);
            return {
                initial: initial,
                initialBand: initial <= 0 ? NONE : classify(threat.likelihood, threat.impact),
                residualLikelihood: axes[0],
                residualImpact: axes[1],
                residual: residualScore,
                residualBand: residualScore <= 0 ? NONE : classify(axes[0], axes[1]),
            };
        }
        function levelRank(value) {
            if (typeof value === "number") return value;
            if (typeof value === "string") return levelsById.get(value)?.rank || 0;
            return value && typeof value.rank === "number" ? value.rank : 0;
        }
        function isHighOrAbove(value) {
            return levelRank(value) >= (highLevel ? highLevel.rank : Infinity);
        }
        function requiresTreatment(level) {
            var treatment = typeof level === "string" ? levelsById.get(level)?.treatment : level && level.treatment;
            return treatment === "required" || treatment === "immediate";
        }
        function isAcceptable(threat, countermeasures, projectSettings) {
            var settings = projectSettings || {};
            var residualAxes = residual(threat, countermeasures);
            var level = classify(residualAxes[0], residualAxes[1]);
            if (level.id === "none") return false;
            if (level.treatment === "auto-accept") return true;
            if (level.acceptanceBy === "management")
                return threat.status === "accepted" && typeof threat.acceptedBy === "string" && !!threat.acceptedBy.trim();
            var acceptableLevel = settings.acceptableLevel || scheme.acceptance && scheme.acceptance.defaultLevel;
            if (acceptableLevel) return level.rank <= levelRank(acceptableLevel);
            var acceptableRisk = typeof settings.acceptableRisk === "number" ? settings.acceptableRisk : 12;
            return level.score <= acceptableRisk;
        }
        function bands() {
            if (scheme.classification.kind === "product-bands") {
                return (scheme.classification.bands || []).map(function (item) {
                    var level = levelsById.get(item.level) || {};
                    return { name: level.label || level.id, min: item.min, max: item.max, color: level.color || "#6b7280" };
                });
            }
            return scheme.classification.levels.map(function (level) {
                return { name: level.label, min: level.rank, max: level.rank, color: level.color };
            });
        }
        function band(score) {
            if (score <= 0) return { name: "None", min: 0, max: 0, color: NONE.color };
            var found = classifyScore(score);
            if (found === NONE) return bands()[0] || { name: "None", min: 0, max: 0, color: NONE.color };
            var definition = scheme.classification.kind === "product-bands"
                ? scheme.classification.bands.find(function (item) { return item.level === found.id; })
                : null;
            return { name: found.label, min: definition ? definition.min : found.rank, max: definition ? definition.max : found.rank, color: found.color };
        }
        function matrixCells() {
            var cells = [];
            for (var impactIndex = impactLevels.length - 1; impactIndex >= 0; impactIndex--) {
                var impact = impactLevels[impactIndex].value;
                likelihoodLevels.forEach(function (likelihoodLevel) {
                    var likelihood = likelihoodLevel.value;
                    cells.push({ likelihood: likelihood, impact: impact, score: likelihood * impact, level: classify(likelihood, impact) });
                });
            }
            return cells;
        }

        return {
            scheme: scheme,
            fingerprint: schemeFingerprint,
            likelihoodLevels: function () { return likelihoodLevels.slice(); },
            impactLevels: function () { return impactLevels.slice(); },
            criteria: criteria,
            deriveLikelihood: function (threat) { return deriveAxis(threat, "likelihood"); },
            deriveImpact: function (threat) { return deriveAxis(threat, "impact"); },
            classify: classify,
            residual: residual,
            riskOf: riskOf,
            isHighOrAbove: isHighOrAbove,
            isAcceptable: isAcceptable,
            requiresTreatment: requiresTreatment,
            inRange: inRange,
            matrixCells: matrixCells,
            bands: bands,
            band: band,
        };
    }

    var api = { DEFAULT_BANDS: DEFAULT_BANDS, createRiskEngine: createRiskEngine };
    g.RiskEngine = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);