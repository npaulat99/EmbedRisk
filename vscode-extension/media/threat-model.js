/* Threat feasibility, matching CostRiskCalculator and lib/attackTree.ts in the webapp.
   Browser: load attacktree-model.js before this script (window.ThreatModel).
   CommonJS: require("./threat-model.js"). Project settings use the on-disk field names;
   attacker is the selected assumptions.attacker[0], or absent for no capability gate. */
(function (g) {
  "use strict";
  var AtModel = typeof module !== "undefined" && module.exports ? require("./attacktree-model.js") : g.AtModel;
  var DEFAULT_ACCESS_PROBABILITIES = { 1: 0.9, 2: 0.7, 3: 0.5, 4: 0.3, 5: 0.1 };

  function accessProbability(access, probabilities) {
    var level = Math.round(access);
    var value = probabilities?.[level] ?? DEFAULT_ACCESS_PROBABILITIES[level] ?? 0.05;
    return Math.max(0.05, Math.min(1, value));
  }
  function costProbability(factors, weights) {
    // Do not use AtModel.stepProb: its public unassessed-tree probability is 1.
    return Math.max(0, Math.min(1, (6 - AtModel.weightedCost(factors, weights)) / 5));
  }

  // Read/propose only: never replace the accepted likelihood or fill absent saved fields.
  function calculate(threat, project, attacker) {
    project = project || {};
    var feasible = !attacker || (threat.requiredSkill || 1) <= attacker.capability;
    var cost = costProbability(threat.costFactors || {}, project.costFactorWeights);
    var probability = feasible ? accessProbability(threat.requiredAccess || 3, project.accessProbabilities) * cost : 0;
    return {
      feasible: feasible, costProbability: cost, probability: probability,
      proposal: AtModel.likelihoodFromProb(probability, project.likelihoodProbabilityThresholds),
    };
  }

  // Explicit calculator edit: returns a new full record and accepts the resulting proposal.
  // Nullish patch values use current effective values for computation, just like the webapp;
  // the patch itself is retained verbatim. Maps are replacements ({} intentionally clears).
  function applyUpdate(threat, patch, project, attacker) {
    project = project || {};
    var factors = patch.costFactors ?? (threat.costFactors || {});
    var skill = patch.requiredSkill ?? (threat.requiredSkill || 1);
    var access = patch.requiredAccess ?? (threat.requiredAccess || 3);
    var status = attacker && skill > attacker.capability ? "unfeasible" : threat.status === "unfeasible" ? "open" : threat.status;
    var cost = costProbability(factors, project.costFactorWeights);
    var probability = status === "unfeasible" ? 0 : accessProbability(access, project.accessProbabilities) * cost;
    var proposal = AtModel.likelihoodFromProb(probability, project.likelihoodProbabilityThresholds);
    // Unrelated top-level and nested metadata survive; never merge back cleared maps.
    return Object.assign({}, threat, patch, {
      status: status, costLikelihood: probability, costLikelihoodProposal: proposal, likelihood: proposal,
    });
  }

  var api = { accessProbability: accessProbability, calculate: calculate, applyUpdate: applyUpdate };
  g.ThreatModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
