// Plausibility checker. Returns structured issues { key, message, severity } mirroring the client
// checker (reference integrity, coverage/completeness, residual sanity, control-type consistency,
// and the threat -> requirement -> control chain). Severity is 'error' | 'warning' | 'notice';
// notices (e.g. an intentionally standalone requirement) can be accepted via project.acceptedNotices.
import { residual } from './risk.js';
import { managedSlcAttacker, normalizeActorLevel } from '../../shared/attackerScale.js';
import '../../shared/riskEngine.js';

const arr = (x) => (Array.isArray(x) ? x : []);
const PROX = { remote: 1, adjacent: 2, local: 3, physical: 4 };
const reqProx = (e) => (e >= 4 ? 1 : e === 3 ? 2 : e === 2 ? 3 : 4);
const ID_PATTERN = /^[A-Za-z0-9 _\-:.]+$/;
const DEFAULT_ACCEPTABLE_RISK = 12;
const COST_WEIGHT_KEYS = ['time', 'exploitability', 'window', 'detection', 'notoriety', 'prep', 'abort'];
const DEFAULT_COST_WEIGHTS = { time: 0.25, exploitability: 0.2, window: 0.15, detection: 0.15, notoriety: 0.1, prep: 0.1, abort: 0.05 };

function costWeightTotal(weights = {}) {
    return COST_WEIGHT_KEYS.reduce((sum, key) => sum + Math.max(0, Number(weights[key] ?? DEFAULT_COST_WEIGHTS[key]) || 0), 0);
}

function slcLevel(value) {
    const match = /(?:SL(?:-C)?\s*)?([1-4])/i.exec(String(value || ''));
    return match ? Number(match[1]) : null;
}

export function validate({ project = {}, assumptions = {}, system = {}, threats = {}, requirements = {}, countermeasures = {}, dfd = {}, useCases = {}, attackTrees = {}, defects = {}, riskScheme = null, riskSchemeWarning = null } = {}) {
    const issues = [];
    const add = (severity, message, key) => issues.push({ severity, message, key: key ?? message });
    const hasText = (value) => String(value || '').trim().length > 0;
    const threatList = arr(threats.threats ?? threats);
    const cmList = arr(countermeasures.countermeasures ?? countermeasures);
    const reqList = arr(requirements.requirements ?? requirements);
    const components = arr(system.components);
    const interfaces = arr(system.interfaces);
    const compIds = new Set(components.map((c) => c.id));
    const assetIds = new Set(arr(system.assets).map((a) => a.id));
    const ifaceIds = new Set(interfaces.map((i) => i.id));
    const attackers = arr(assumptions.attacker);
    const assumptionIds = new Set([
        ...arr(assumptions.device).map((x) => x.id),
        ...arr(assumptions.system).map((x) => x.id),
        ...arr(assumptions.environment).map((x) => x.id),
        ...arr(assumptions.operational).map((x) => x.id),
        ...attackers.map((x) => x.id),
    ].filter(Boolean));
    const attackerById = new Map(attackers.map((a) => [a.id, a]));
    const tIds = new Set(threatList.map((t) => t.id));
    const cmIds = new Set(cmList.map((c) => c.id));
    const threatById = new Map(threatList.map((t) => [t.id, t]));

    const acceptableRisk = Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : DEFAULT_ACCEPTABLE_RISK;
    const selectedSlc = slcLevel(project.slTarget);
    const riskEngine = riskScheme ? globalThis.RiskEngine.createRiskEngine(riskScheme, project) : null;
    const criterionRatingsInRange = (axis, ratings) => !riskEngine.criteria(axis).some((criterion) =>
        ratings?.[criterion.id] != null && !riskEngine.inRange(axis, ratings[criterion.id]));
    const riskValueInRange = (axis, value) => value === 0 || riskEngine.inRange(axis, value);
    const costBased = riskEngine
        ? riskEngine.scheme.likelihood.derivation.kind === 'cost-based'
        : project.riskScoringMethod === 'cost-based';

    if (riskSchemeWarning) add('warning', riskSchemeWarning, 'risk-scheme-unavailable');

    if (costBased && Math.abs(costWeightTotal(project.costFactorWeights) - 1) > 1e-6)
        add('warning', `Cost-factor weights total ${costWeightTotal(project.costFactorWeights).toFixed(2)}; they must combine to 1.00.`, 'cost-factor-weights');
    if (costBased) {
        for (const level of [1, 2, 3, 4, 5]) {
            const probability = project.accessProbabilities?.[level];
            if (typeof probability === 'number' && (probability < 0.05 || probability > 1))
                add('warning', `Access probability for level ${level} must be between 0.05 and 1.00.`, `access-probability:${level}`);
        }
        const thresholdDefaults = { 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };
        const thresholds = [2, 3, 4, 5].map((level) => project.likelihoodProbabilityThresholds?.[level] ?? thresholdDefaults[level]);
        if (thresholds.some((value) => typeof value !== 'number' || value <= 0 || value > 1) || thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1]))
            add('warning', 'Likelihood probability thresholds must be strictly increasing from L2 through L5 and within 0.01 to 1.00.', 'likelihood-thresholds');
    }

    if (!attackers.length) add('warning', 'No attacker assumptions (required to ground the likelihood assessment).', 'no-attacker');
    if (selectedSlc) {
        const expectedId = `ATK-SLC-${selectedSlc}`;
        const expectedCapability = managedSlcAttacker(selectedSlc).capability;
        if (attackers.length !== 1 || attackers[0]?.id !== expectedId || normalizeActorLevel(attackers[0]?.capability) !== expectedCapability)
            add('warning', `SL-C ${selectedSlc} requires the managed attacker profile '${expectedId}' (capability ${expectedCapability}).`, 'slc-attacker-profile');
    }
    const tbIds = new Set(arr(system.trustBoundaries).map((b) => b.id));
    const allIds = [
        ...components.map((c) => ({ id: c.id, kind: 'component' })),
        ...interfaces.map((i) => ({ id: i.id, kind: 'interface' })),
        ...arr(system.trustBoundaries).map((b) => ({ id: b.id, kind: 'trust boundary' })),
        ...arr(system.assets).map((a) => ({ id: a.id, kind: 'asset' })),
        ...threatList.map((t) => ({ id: t.id, kind: 'threat' })),
        ...reqList.map((r) => ({ id: r.id, kind: 'requirement' })),
        ...cmList.map((c) => ({ id: c.id, kind: 'countermeasure' })),
        ...arr(attackTrees.trees).map((t) => ({ id: t.id, kind: 'attack tree' })),
        ...arr(defects.defects ?? defects).map((d) => ({ id: d.id, kind: 'defect' })),
        ...attackers.map((a) => ({ id: a.id, kind: 'attacker profile' })),
        // DFD nodes share the id-space, except a trust-boundary node deliberately reuses the id of
        // its system trust boundary (same entity) — skip that alias.
        ...arr(dfd.nodes).filter((n) => !tbIds.has(n.id)).map((n) => ({ id: n.id, kind: 'DFD node' })),
    ].filter((x) => x.id);
    const seenId = new Map();
    for (const { id, kind } of allIds) {
        if (seenId.has(id)) add('error', `Duplicate ID '${id}' — used by ${seenId.get(id)} and ${kind}. IDs must be unique across the project.`);
        else seenId.set(id, kind);
    }
    const today = new Date().toISOString().slice(0, 10);

    for (const t of threatList) {
        if (!t.id) add('error', 'A threat is missing its ID.');
        if (typeof t.likelihood !== 'number' || typeof t.impact !== 'number') add('warning', `${t.id || 'threat'}: missing risk rating (likelihood/impact).`);
        if (!arr(t.stride).length) add('warning', `${t.id || 'threat'}: no STRIDE category assigned.`);
        if (!arr(t.components).length) add('warning', `${t.id || 'threat'}: orphaned threat (no affected component).`);
        for (const c of arr(t.components)) if (!compIds.has(c)) add('error', `${t.id}: references unknown component '${c}'.`);
        for (const a of arr(t.assets)) if (!assetIds.has(a)) add('error', `${t.id}: references unknown asset '${a}'.`);
        if (t.attackerRef && !attackerById.has(t.attackerRef)) add('error', `${t.id}: references unknown attacker profile '${t.attackerRef}'.`);
        if (selectedSlc && t.attackerRef !== `ATK-SLC-${selectedSlc}`)
            add('warning', `${t.id}: must use the selected SL-C attacker profile 'ATK-SLC-${selectedSlc}'.`, `slc-attacker:${t.id}`);
        for (const iface of arr(t.interfaceRefs)) if (!ifaceIds.has(iface)) add('error', `${t.id}: references unknown interface '${iface}'.`);
        if (t.interfaceRef && !ifaceIds.has(t.interfaceRef)) add('error', `${t.id}: references unknown interface '${t.interfaceRef}'.`);
        for (const aid of arr(t.assumptionRefs)) {
            if (!ID_PATTERN.test(aid)) add('error', `${t.id}: references invalid assumption ID '${aid}'.`);
            else if (!assumptionIds.has(aid)) add('error', `${t.id}: references unknown assumption '${aid}'.`);
        }
        const atk = t.attackerRef ? attackerById.get(t.attackerRef) : null;
        const exposure = t.likelihoodFactors?.exposure;
        const exploit = t.likelihoodFactors?.exploitability;
        if (atk && typeof exposure === 'number' && (PROX[atk.access] ?? 4) < reqProx(exposure))
            add('warning', `${t.id}: attacker ${atk.id} (${atk.access}) is not proximate enough to reach an exposure-${exposure} surface.`);
        if (t.likelihood >= 3 && atk && typeof atk.capability === 'number' && typeof exploit === 'number' && normalizeActorLevel(atk.capability) + exploit < 6)
            add('notice', `${t.id}: likelihood may be over-stated based on attacker ${atk.id}'s capability. Accept if this is intentional.`, `capability-gate:${t.id}`);
        if (costBased) {
            if (typeof t.requiredSkill !== 'number' || typeof t.requiredAccess !== 'number' || !t.costFactors)
                add('warning', `${t.id}: cost-based scoring requires requiredSkill, requiredAccess, and all seven cost factors.`);
            const missingCostFactor = ['time', 'exploitability', 'window', 'detection', 'notoriety', 'prep', 'abort']
                .some((key) => typeof t.costFactors?.[key] !== 'number');
            if (t.costFactors && missingCostFactor)
                add('warning', `${t.id}: cost-based scoring has one or more unassessed difficulty dimensions.`);
            const missingRationale = ['time', 'exploitability', 'window', 'detection', 'notoriety', 'prep', 'abort']
                .some((key) => !hasText(t.costRationales?.[key]));
            if (missingRationale)
                add('warning', `${t.id}: cost-based scoring requires a rationale for each difficulty dimension.`);
            if (typeof t.costLikelihoodProposal === 'number' && t.likelihood !== t.costLikelihoodProposal)
                add('notice', `${t.id}: manually selected likelihood (${t.likelihood}) differs from the calculated cost-based proposal (${t.costLikelihoodProposal}).`, `cost-likelihood-override:${t.id}:${t.costLikelihoodProposal}`);
            if (selectedSlc && typeof t.requiredSkill === 'number' && normalizeActorLevel(t.requiredSkill) > managedSlcAttacker(selectedSlc).capability && t.status !== 'unfeasible')
                add('warning', `${t.id}: required capability exceeds the SL-C ${selectedSlc} attacker capability and should be marked unfeasible.`);
        }
        if (t.status === 'accepted' && (!t.acceptedBy || !t.acceptanceRationale || !t.reviewDate))
            add('warning', `${t.id}: accepted residual risk requires a sign-off owner (acceptedBy), a rationale (acceptanceRationale) and a next-review date (reviewDate).`);
        if (t.status === 'avoided' && !hasText(t.avoidanceRationale))
            add('warning', `${t.id}: an avoided risk requires avoidanceRationale describing the design or context change.`);
        if (t.status === 'avoided' && !reqList.some((requirement) => (requirement.derivedFromThreat || []).includes(t.id)) && !arr(t.assumptionRefs).length)
            add('notice', `${t.id}: avoided risk is not linked to a requirement or assumption; the changed context should be re-assessed.`, `avoided-link:${t.id}`);
        if (t.status === 'transferred' && !hasText(t.transferRationale))
            add('warning', `${t.id}: a transferred risk requires transferRationale (who receives the risk and how they are informed).`);
        if (arr(t.stride).some((s) => s === 'S' || s === 'T' || s === 'I') && !t.classification)
            add('notice', `${t.id}: classification is unset for a spoofing/tampering/information-disclosure threat; classify whether this is a product vulnerability, protocol limitation, deployment risk, or shared responsibility.`, `threat-classification:${t.id}`);
        if ((t.classification === 'protocol-limitation' || t.classification === 'deployment-risk' || t.classification === 'shared-responsibility') && !hasText(t.deploymentConstraints) && t.status !== 'accepted' && t.status !== 'transferred')
            add('warning', `${t.id}: ${t.classification} classification requires deploymentConstraints unless the risk is accepted or transferred.`);
        if (t.classification === 'product-vulnerability' && t.responsibility === 'integrator-operator' && hasText(t.deploymentConstraints))
            add('warning', `${t.id}: product-vulnerability with integrator-operator responsibility and deploymentConstraints is contradictory.`);
        if (t.reviewDate && t.reviewDate < today)
            add('warning', `${t.id}: re-assessment overdue (review date ${t.reviewDate}).`);
        if (t.status === 'mitigated') {
            const impl = cmList.some((c) => arr(c.addresses).some((a) => a.threat === t.id) && (c.status === 'implemented' || c.status === 'verified'));
            if (!impl) add('warning', `${t.id}: status 'mitigated' but no implemented/verified countermeasure addresses it.`);
        }
        const [rl, ri] = residual(t, cmList);
        const res = (rl || 0) * (ri || 0);
        if (riskEngine && !riskSchemeWarning) {
            const initialLikelihoodInRange = t.status === 'unfeasible' && t.likelihood === 0 || riskEngine.inRange('likelihood', t.likelihood);
            const initialInRange = initialLikelihoodInRange && riskEngine.inRange('impact', t.impact);
            const residualInRange = t.status === 'unfeasible'
                || ((rl === 0 || riskEngine.inRange('likelihood', rl)) && (ri === 0 || riskEngine.inRange('impact', ri)));
            const criteriaInRange = criterionRatingsInRange('likelihood', t.likelihoodCriteria)
                && criterionRatingsInRange('impact', t.impactCriteria);
            const legacyResidualInRange = (t.residualLikelihood == null || riskValueInRange('likelihood', t.residualLikelihood))
                && (t.residualImpact == null || riskValueInRange('impact', t.residualImpact));
            const countermeasureRatingsInRange = cmList.flatMap((cm) => arr(cm.addresses)).filter((address) => address.threat === t.id).every((address) =>
                (address.residualLikelihood == null || riskValueInRange('likelihood', address.residualLikelihood))
                && (address.residualImpact == null || riskValueInRange('impact', address.residualImpact))
                && criterionRatingsInRange('likelihood', address.likelihoodCriteria)
                && criterionRatingsInRange('impact', address.impactCriteria));
            if (!initialInRange || !residualInRange || !criteriaInRange || !legacyResidualInRange || !countermeasureRatingsInRange) {
                add('error', `${t.id}: stored risk rating or residual is outside the active scheme's range.`, `risk-range:${t.id}`);
            } else {
                const level = riskEngine.classify(rl, ri);
                if (level.id !== 'none' && level.treatment !== 'auto-accept') {
                    const acceptsByManagement = level.acceptanceBy === 'management';
                    const acceptedWithOwner = t.status === 'accepted' && hasText(t.acceptedBy);
                    const acceptableLevel = project.acceptableLevel
                        || (typeof project.acceptableRisk !== 'number' ? riskEngine.scheme.acceptance?.defaultLevel : null);
                    const acceptableRank = acceptableLevel
                        ? riskEngine.scheme.classification.levels.find((item) => item.id === acceptableLevel)?.rank
                        : null;
                    const withinThreshold = Number.isInteger(acceptableRank)
                        ? level.rank <= acceptableRank
                        : level.score <= acceptableRisk;
                    if (t.status === 'accepted' && !withinThreshold && !hasText(t.acceptanceDeviation?.circumstance))
                        add('warning', `${t.id}: acceptance above the acceptable level requires acceptanceDeviation.circumstance.`);
                    if (acceptsByManagement && !acceptedWithOwner) {
                        add('warning', `${t.id}: residual risk level '${level.label}' requires acceptance by management (status 'accepted' and acceptedBy).`, `risk-acceptance:${t.id}`);
                    } else if (!acceptsByManagement && !withinThreshold && t.status !== 'accepted' && t.status !== 'avoided') {
                        add('warning', `${t.id}: residual risk level '${level.label}' exceeds the acceptable level — reduce it or accept the residual.`, `risk-over-acceptable:${t.id}`);
                    }
                }
            }
        } else if (!riskSchemeWarning && res > acceptableRisk && t.status === 'accepted' && !hasText(t.acceptanceDeviation?.circumstance)) {
            add('warning', `${t.id}: acceptance above the acceptable level requires acceptanceDeviation.circumstance.`);
        } else if (!riskSchemeWarning && res > acceptableRisk && t.status !== 'accepted' && t.status !== 'avoided' && t.status !== 'unfeasible') {
            const threatLabel = t.id || 'threat';
            add('warning', `${threatLabel}: residual risk ${res} exceeds the acceptable risk (${acceptableRisk}) — reduce it or accept the residual.`, t.id ? `risk-over-acceptable:${t.id}` : undefined);
        }
        if (project.rigorousMode) {
            if (!t.impactDimensions) add('warning', `${t.id}: rigorous mode requires the Bug Bar impact dimensions to be set.`);
            const lf = t.likelihoodFactors;
            if (!lf || (typeof lf.exposure !== 'number' && typeof lf.exploitability !== 'number'))
                add('warning', `${t.id}: rigorous mode requires the exposure / exploitability factors to be set.`);
            if (!t.ratedBy) add('warning', `${t.id}: rigorous mode requires the rater to be recorded (ratedBy).`);
        }
    }

    const incompleteThreatCount = threatList.filter((threat) => !hasText(threat.cause) && !arr(threat.compromisedObjectives).length).length;
    if (incompleteThreatCount)
        add('notice', `${incompleteThreatCount} threats do not state a cause or the compromised objectives (EN 40000-1-2, 6.4.3.3).`, 'threat-structure-empty');

    for (const i of interfaces) {
        if (typeof i.hidden !== 'undefined' && typeof i.hidden !== 'boolean') {
            add('warning', `Interface '${i.id || i.name || 'unknown'}': hidden must be a boolean when set.`);
        }
    }

    const diagrams = Array.isArray(useCases?.diagrams) ? useCases.diagrams : [];
    if (diagrams.length > 0 && !project.reportOptions?.includeUseCases) {
        add(
            'notice',
            `Use-case diagrams exist (${diagrams.length}) but report inclusion is disabled. Accept this notice if the exclusion is intentional.`,
            'usecases-excluded',
        );
    }

    const reqCms = new Set(reqList.flatMap((r) => arr(r.satisfiedByCM)));
    for (const c of cmList) {
        if (!c.id) add('error', 'A countermeasure is missing its ID.');
        if (!arr(c.addresses).length) add('warning', `${c.id || 'countermeasure'}: addresses no threat (orphaned countermeasure).`);
        for (const a of arr(c.addresses)) if (!tIds.has(a.threat)) add('error', `${c.id}: addresses unknown threat '${a.threat}'.`);
        for (const comp of arr(c.components)) if (!compIds.has(comp)) add('error', `${c.id}: references unknown component '${comp}'.`);
        if (c.id && c.selected !== false && !reqCms.has(c.id)) add('warning', `${c.id}: no security requirement is associated with this countermeasure.`);
        const ticketCount = arr(c.ticketUrls).filter(Boolean).length || (c.ticketUrl ? 1 : 0);
        if ((c.status === 'implemented' || c.status === 'verified') && !ticketCount)
            add('warning', `${c.id}: status '${c.status}' requires a ticket link as proof of implementation.`);
        if (c.status === 'verified' && !c.verificationUrl)
            add('warning', `${c.id}: status 'verified' requires a verification link as evidence the control was tested.`);
        for (const a of arr(c.addresses)) {
            const th = threatById.get(a.threat);
            if (!th) continue;
            if (typeof a.residualImpact === 'number' && a.residualImpact > th.impact)
                add('warning', `${c.id}: residual impact for ${a.threat} (${a.residualImpact}) exceeds the initial impact (${th.impact}).`);
            if (typeof a.residualLikelihood === 'number' && a.residualLikelihood > th.likelihood)
                add('warning', `${c.id}: residual likelihood for ${a.threat} (${a.residualLikelihood}) exceeds the initial likelihood (${th.likelihood}).`);
            if (c.type === 'preventive' && typeof a.residualImpact === 'number' && a.residualImpact < th.impact)
                add('warning', `${c.id}: a preventive control should reduce likelihood, not impact — it lowers the impact of ${a.threat} (${th.impact}→${a.residualImpact}).`);
        }
    }

    for (const r of reqList) {
        const hasCm = arr(r.satisfiedByCM).length > 0;
        const hasThreat = arr(r.derivedFromThreat).length > 0;
        if (!hasCm) {
            if (hasThreat) add('warning', `${r.id}: security requirement derived from a threat has no countermeasure satisfying it.`);
            else add('notice', `${r.id}: standalone security requirement — not derived from a threat and not backed by a countermeasure. Accept if this is intentional.`, `req-standalone:${r.id}`);
        }
        for (const th of arr(r.derivedFromThreat)) if (!tIds.has(th)) add('error', `${r.id}: derived from unknown threat '${th}'.`);
        for (const cm of arr(r.satisfiedByCM)) if (!cmIds.has(cm)) add('error', `${r.id}: satisfied by unknown countermeasure '${cm}'.`);
    }
    const reqThreats = new Set(reqList.flatMap((r) => arr(r.derivedFromThreat)));
    for (const t of threatList) {
        const highOrAbove = riskEngine
            ? riskEngine.inRange('likelihood', t.likelihood) && riskEngine.inRange('impact', t.impact) && riskEngine.isHighOrAbove(riskEngine.classify(t.likelihood, t.impact))
            : !riskSchemeWarning && (t.likelihood || 0) * (t.impact || 0) >= 12;
        if (highOrAbove && !reqThreats.has(t.id) && t.status !== 'accepted' && t.status !== 'avoided')
            add('warning', `${t.id}: high/critical threat has no security requirement derived from it.`);
        if (t.status === 'transferred' && !reqThreats.has(t.id))
            add('warning', `${t.id}: transferred risk requires a linked requirement documenting the risk transfer in the user guide.`);
    }

    const parents = new Set(components.map((c) => c.parent).filter(Boolean));
    const threatComps = new Set(threatList.flatMap((t) => arr(t.components)));
    for (const c of components)
        if (c.kind !== 'external-entity' && c.kind !== 'device' && !parents.has(c.id) && !threatComps.has(c.id))
            add('warning', `Coverage: component '${c.id}' (${c.name}) has no threat — STRIDE-per-element coverage gap.`);
    const threatIfaces = new Set(threatList.flatMap((t) => [...arr(t.interfaceRefs), ...(t.interfaceRef ? [t.interfaceRef] : [])]).filter(Boolean));
    const threatAssets = new Set(threatList.flatMap((t) => arr(t.assets)));
    for (const asset of arr(system.assets))
        if (!threatAssets.has(asset.id) && !hasText(asset.noThreatRationale))
            add('warning', `${asset.id}: no threat is linked to this asset. Add a threat or state why none applies (noThreatRationale).`);
    for (const i of interfaces)
        if (!threatIfaces.has(i.id)) add('warning', `Coverage: interface '${i.id}' (${i.name}) has no threat — every external interface should have at least one.`);

    for (const n of arr(dfd.nodes))
        if (n.type === 'trust-boundary' && !arr(n.members).length)
            add('warning', `Trust boundary '${n.id}' has no members (a trust boundary must contain at least one node).`);
    const boundaryIds = new Set([
        ...arr(system.trustBoundaries).map((b) => b.id),
        ...arr(dfd.nodes).filter((n) => n.type === 'trust-boundary').map((n) => n.id),
    ]);
    for (const f of arr(dfd.flows)) {
        if (f.crossesBoundary && !boundaryIds.has(f.crossesBoundary))
            add('error', `Flow '${f.id}' references unknown trust boundary '${f.crossesBoundary}'.`);
        if (!f.label || !f.label.trim())
            add('warning', `Data flow '${f.id}' (${f.from}→${f.to}) has no label — every flow must state what data or command it carries.`);
    }
    for (const d of arr(defects.defects ?? defects)) {
        if (d.component && !compIds.has(d.component)) add('error', `${d.id || 'defect'}: references unknown component '${d.component}'.`);
        if (d.threatRef && !tIds.has(d.threatRef)) add('error', `${d.id || 'defect'}: references unknown threat '${d.threatRef}'.`);
        if ((d.status === 'open' || d.status === 'triaged') && (d.severity === 'high' || d.severity === 'critical') && d.threatRef)
            add('warning', `${d.id}: open ${d.severity} defect — re-assess the linked threat '${d.threatRef}'.`);
    }
    for (const tr of arr(attackTrees.trees)) {
        const refs = [...new Set([...arr(tr.threatRefs), ...(tr.threatRef ? [tr.threatRef] : [])])];
        for (const ref of refs)
            if (!tIds.has(ref)) add('error', `Attack tree '${tr.id}' references unknown threat '${ref}'.`);
    }
    const legacyNotice = (id, key) => add('notice', `${id} uses legacy level 5, read as threat actor 4. Re-save to update.`, `legacy-actor-level:${key}`);
    for (const a of attackers) if (a.capability === 5) legacyNotice(a.id, a.id);
    for (const t of threatList) if (t.requiredSkill === 5) legacyNotice(t.id, t.id);
    for (const tr of arr(attackTrees.trees)) {
        const visit = (node) => {
            if (!node) return;
            if (node.skill === 5) legacyNotice(`${tr.id}/${node.id}`, `${tr.id}:${node.id}`);
            arr(node.children).forEach(visit);
        };
        visit(tr.root);
    }

    const accepted = new Set(Array.isArray(project.acceptedNotices) ? project.acceptedNotices : []);
    return issues.filter((issue) => issue.severity !== 'notice' || !accepted.has(issue.key));
}
