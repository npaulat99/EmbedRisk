/* Threat-actor scale 1-4 (EN IEC 62443-4-1:2018/prAA:2026 draft). Keep in sync with webapp/shared/attackerScale.js.
   Isomorphic: window.EmbedRiskAttackerScale (webview) + module.exports (Node). */
(function (g) {
    "use strict";
    var ACTOR_LEVELS = [
        { level: 1, title: "Casual or coincidental violation", description: "Casual or coincidental violation", resources: "No intentional attack resources", motivation: "None (casual or coincidental)" },
        { level: 2, title: "Intentional violation using simple means", description: "Intentional violation using simple means with low resources, generic skills and low motivation", resources: "Simple means, low resources, generic skills", motivation: "Low" },
        { level: 3, title: "Intentional violation using sophisticated means, moderate resources", description: "Intentional violation using sophisticated means with moderate resources, ACS specific skills and moderate motivation", resources: "Sophisticated means, moderate resources, ACS specific skills", motivation: "Moderate" },
        { level: 4, title: "Intentional violation using sophisticated means, extended resources", description: "Intentional violation using sophisticated means with extended resources, ACS specific skills and high motivation", resources: "Sophisticated means, extended resources, ACS specific skills", motivation: "High" },
    ];
    var MAX_ACTOR_LEVEL = 4;

    // A persisted legacy 5 is read as 4.
    function normalizeActorLevel(value) {
        return typeof value === "number" && value >= 1 ? Math.min(MAX_ACTOR_LEVEL, value) : value;
    }
    function findLevel(value) {
        var level = normalizeActorLevel(Math.round(value));
        return ACTOR_LEVELS.filter(function (entry) { return entry.level === level; })[0];
    }
    function actorLevelLabel(value) {
        var entry = findLevel(value);
        return entry ? "Threat actor " + entry.level : "–";
    }
    function actorLevelOption(value) {
        var entry = findLevel(value);
        return entry ? entry.level + " · " + entry.description : "–";
    }
    function managedSlcAttacker(level) {
        var entry = ACTOR_LEVELS.filter(function (item) { return item.level === level; })[0];
        if (!entry) return undefined;
        return { id: "ATK-SLC-" + level, name: "Threat Actor " + level + ": " + entry.title, capability: level, motivation: entry.motivation, resources: entry.resources, text: entry.description };
    }

    var api = { ACTOR_LEVELS: ACTOR_LEVELS, MAX_ACTOR_LEVEL: MAX_ACTOR_LEVEL, normalizeActorLevel: normalizeActorLevel, actorLevelLabel: actorLevelLabel, actorLevelOption: actorLevelOption, managedSlcAttacker: managedSlcAttacker };
    g.EmbedRiskAttackerScale = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
