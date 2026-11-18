// Client-side plausibility checker (mirrors server/src/validate.js) so the Review panel
// and progress indicators update live. Covers reference integrity, coverage/completeness,
// residual-risk sanity, control-type consistency and the threat -> requirement -> control chain.
//
// Each issue carries a severity: 'error' (broken/inconsistent), 'warning' (should be resolved)
// or 'notice' (informational — e.g. an intentionally standalone requirement). Notices can be
// accepted by the user (project.acceptedNotices); accepted notices are no longer open points.
import type { ProjectData, RiskScheme } from '../types';
import { DEFAULT_ACCEPTABLE_RISK } from '../types';
import { ID_PATTERN, idCollisions } from './ids';
import { createRiskEngine, residual } from './risk';
import { costWeightTotal } from './attackTree';
import { normalizeActorLevel } from '@shared/attackerScale.js';

export type IssueSeverity = 'error' | 'warning' | 'notice';
export interface Issue {
    key: string;
    message: string;
    severity: IssueSeverity;
}

const PROX: Record<string, number> = { remote: 1, adjacent: 2, local: 3, physical: 4 };
const reqProx = (exposure: number) => (exposure >= 4 ? 1 : exposure === 3 ? 2 : exposure === 2 ? 3 : 4);

/** True when an issue is a notice the user has accepted (so it is no longer an open point). */
export function isAccepted(issue: Issue, accepted?: string[]): boolean {
    return issue.severity === 'notice' && !!accepted?.includes(issue.key);
}

/** The issues that still require attention (everything except accepted notices). */
export function openIssues(issues: Issue[], accepted?: string[]): Issue[] {
    return issues.filter((i) => !isAccepted(i, accepted));
}

export function validate(data: ProjectData, scheme: RiskScheme | null = null, schemeWarning: string | null = null): Issue[] {
    const issues: Issue[] = [];
    const add = (severity: IssueSeverity, message: string, key?: string) => issues.push({ severity, message, key: key ?? message });
    const hasText = (value: unknown) => String(value || '').trim().length > 0;
    const project = data.project || ({} as any);
    const threats = data.threats?.threats || [];
    const cms = data.countermeasures?.countermeasures || [];
    const reqs = data.requirements?.requirements || [];
    const components = data.system?.components || [];
    const interfaces = data.system?.interfaces || [];
    const compIds = new Set(components.map((c) => c.id));
    const assetIds = new Set((data.system?.assets || []).map((a) => a.id));
    const ifaceIds = new Set(interfaces.map((i) => i.id));
    const attackers = data.assumptions?.attacker || [];
    const assumptionIds = new Set([
        ...(data.assumptions?.device || []).map((x) => x.id),
        ...(data.assumptions?.system || []).map((x) => x.id),
        ...(data.assumptions?.environment || []).map((x) => x.id),
        ...(data.assumptions?.operational || []).map((x) => x.id),
        ...attackers.map((x) => x.id),
    ].filter(Boolean));
    const attackerById = new Map(attackers.map((a) => [a.id, a]));
    const tIds = new Set(threats.map((t) => t.id));
    const cmIds = new Set(cms.map((c) => c.id));
    const threatById = new Map(threats.map((t) => [t.id, t]));
    const acceptableRisk = Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : DEFAULT_ACCEPTABLE_RISK;
    const riskEngine = scheme && !schemeWarning ? createRiskEngine(scheme) : null;
    const costBased = riskEngine ? riskEngine.scheme.likelihood.derivation.kind === 'cost-based' : project.riskScoringMethod === 'cost-based';

    if (schemeWarning) add('warning', schemeWarning, 'risk-scheme-unavailable');

    if (costBased && Math.abs(costWeightTotal(project.costFactorWeights) - 1) > 0.000001)
        add('warning', `Cost-factor weights total ${costWeightTotal(project.costFactorWeights).toFixed(2)}; they must combine to 1.00.`, 'cost-factor-weights');
    if (costBased) {
        for (const level of [1, 2, 3, 4, 5] as const) {
            const probability = project.accessProbabilities?.[level];
            if (typeof probability === 'number' && (probability < 0.05 || probability > 1))
                add('warning', `Access probability for level ${level} must be between 0.05 and 1.00.`, `access-probability:${level}`);
        }
        const thresholds = [2, 3, 4, 5].map((level) => project.likelihoodProbabilityThresholds?.[level as 2 | 3 | 4 | 5] ?? ({ 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 } as Record<number, number>)[level]);
        if (thresholds.some((value) => typeof value !== 'number' || value <= 0 || value > 1) || thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1]))
            add('warning', 'Likelihood probability thresholds must be strictly increasing from L2 through L5 and within 0.01 to 1.00.', 'likelihood-thresholds');
    }

    if (!attackers.length) add('warning', 'No attacker assumptions (required to ground the likelihood assessment).', 'no-attacker');
    for (const m of idCollisions(data)) add('error', m);
    const today = new Date().toISOString().slice(0, 10);

    for (const t of threats) {
        if (!t.id) add('error', 'A threat is missing its ID.');
        if (typeof t.likelihood !== 'number' || typeof t.impact !== 'number') add('warning', `${t.id || 'threat'}: missing risk rating.`);
        if (!(t.stride || []).length) add('warning', `${t.id || 'threat'}: no STRIDE category assigned.`);
        if (!(t.components || []).length) add('warning', `${t.id || 'threat'}: orphaned threat (no affected component).`);
        for (const c of t.components || []) if (!compIds.has(c)) add('error', `${t.id}: references unknown component '${c}'.`);
        for (const a of t.assets || []) if (!assetIds.has(a)) add('error', `${t.id}: references unknown asset '${a}'.`);
        if (t.attackerRef && !attackerById.has(t.attackerRef)) add('error', `${t.id}: references unknown attacker profile '${t.attackerRef}'.`);
        for (const iface of t.interfaceRefs || []) if (!ifaceIds.has(iface)) add('error', `${t.id}: references unknown interface '${iface}'.`);
        if (t.interfaceRef && !ifaceIds.has(t.interfaceRef)) add('error', `${t.id}: references unknown interface '${t.interfaceRef}'.`);
        for (const aid of t.assumptionRefs || []) {
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
            const costKeys = ['time', 'exploitability', 'window', 'detection', 'notoriety', 'prep', 'abort'] as const;
            if (typeof t.requiredSkill !== 'number' || typeof t.requiredAccess !== 'number' || costKeys.some((key) => typeof t.costFactors?.[key] !== 'number'))
                add('warning', `${t.id}: cost-based scoring requires required skill, required access, and all seven difficulty dimensions.`);
            if (costKeys.some((key) => !hasText(t.costRationales?.[key])))
                add('warning', `${t.id}: cost-based scoring requires a rationale for each difficulty dimension.`);
            if (typeof t.costLikelihoodProposal === 'number' && t.likelihood !== t.costLikelihoodProposal)
                add('notice', `${t.id}: manually selected likelihood (${t.likelihood}) differs from the calculated cost-based proposal (${t.costLikelihoodProposal}).`, `cost-likelihood-override:${t.id}:${t.costLikelihoodProposal}`);
        }
        if (t.status === 'accepted' && (!t.acceptedBy || !t.acceptanceRationale || !t.reviewDate))
            add('warning', `${t.id}: accepted residual risk requires a sign-off owner (acceptedBy), a rationale (acceptanceRationale) and a next-review date (reviewDate).`);
        if ((t.stride || []).some((s) => s === 'S' || s === 'T' || s === 'I') && !t.classification)
            add('notice', `${t.id}: classification is unset for a spoofing/tampering/information-disclosure threat; classify whether this is a product vulnerability, protocol limitation, deployment risk, or shared responsibility.`, `threat-classification:${t.id}`);
        if ((t.classification === 'protocol-limitation' || t.classification === 'deployment-risk' || t.classification === 'shared-responsibility') && !hasText(t.deploymentConstraints) && t.status !== 'accepted' && t.status !== 'transferred')
            add('warning', `${t.id}: ${t.classification} classification requires deploymentConstraints unless the risk is accepted or transferred.`);
        if (t.classification === 'product-vulnerability' && t.responsibility === 'integrator-operator' && hasText(t.deploymentConstraints))
            add('warning', `${t.id}: product-vulnerability with integrator-operator responsibility and deploymentConstraints is contradictory.`);
        if (t.reviewDate && t.reviewDate < today)
            add('warning', `${t.id}: re-assessment overdue (review date ${t.reviewDate}).`);
        if (t.status === 'mitigated') {
            const impl = cms.some((c) => (c.addresses || []).some((a) => a.threat === t.id) && (c.status === 'implemented' || c.status === 'verified'));
            if (!impl) add('warning', `${t.id}: status 'mitigated' but no implemented/verified countermeasure addresses it.`);
        }
        // Residual risk above the project's acceptable threshold — unless the residual is knowingly accepted.
        const [rl, ri] = residual(t, cms);
        const res = (rl || 0) * (ri || 0);
        if (riskEngine) {
            const initialLikelihoodInRange = t.status === 'unfeasible' && t.likelihood === 0 || riskEngine.inRange('likelihood', t.likelihood);
            const initialInRange = initialLikelihoodInRange && riskEngine.inRange('impact', t.impact);
            const residualInRange = t.status === 'unfeasible'
                || ((rl === 0 || riskEngine.inRange('likelihood', rl)) && (ri === 0 || riskEngine.inRange('impact', ri)));
            if (!initialInRange || !residualInRange) {
                add('error', `${t.id}: stored risk rating or residual is outside the active scheme's range.`, `risk-range:${t.id}`);
            } else {
                const level = riskEngine.classify(rl, ri);
                if (level.id !== 'none' && level.treatment !== 'auto-accept') {
                    const acceptedWithOwner = t.status === 'accepted' && hasText(t.acceptedBy);
                    const acceptableLevel = project.acceptableLevel
                        || (typeof project.acceptableRisk !== 'number' ? riskEngine.scheme.acceptance?.defaultLevel : null);
                    const acceptableRank = acceptableLevel
                        ? riskEngine.scheme.classification.levels.find((item: any) => item.id === acceptableLevel)?.rank
                        : null;
                    const withinThreshold = Number.isInteger(acceptableRank)
                        ? level.rank <= acceptableRank
                        : level.score <= acceptableRisk;
                    if (level.acceptanceBy === 'management' && !acceptedWithOwner) {
                        add('warning', `${t.id}: residual risk level '${level.label}' requires acceptance by management (status 'accepted' and acceptedBy).`, `risk-acceptance:${t.id}`);
                    } else if (level.acceptanceBy !== 'management' && !withinThreshold && t.status !== 'accepted') {
                        add('warning', `${t.id}: residual risk level '${level.label}' exceeds the acceptable level — reduce it or accept the residual.`, `risk-over-acceptable:${t.id}`);
                    }
                }
            }
        } else if (!schemeWarning && res > acceptableRisk && t.status !== 'accepted' && t.status !== 'unfeasible') {
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

    const reqCms = new Set(reqs.flatMap((r) => r.satisfiedByCM || []));
    for (const c of cms) {
        if (!c.id) add('error', 'A countermeasure is missing its ID.');
        if (!(c.addresses || []).length) add('warning', `${c.id || 'countermeasure'}: addresses no threat.`);
        for (const a of c.addresses || []) if (!tIds.has(a.threat)) add('error', `${c.id}: addresses unknown threat '${a.threat}'.`);
        for (const comp of c.components || []) if (!compIds.has(comp)) add('error', `${c.id}: references unknown component '${comp}'.`);
        // Every countermeasure chosen for implementation must be backed by a security requirement.
        if (c.id && c.selected !== false && !reqCms.has(c.id)) add('warning', `${c.id}: no security requirement is associated with this countermeasure.`);
        const ticketCount = c.ticketUrls?.filter(Boolean).length || (c.ticketUrl ? 1 : 0);
        if ((c.status === 'implemented' || c.status === 'verified') && !ticketCount)
            add('warning', `${c.id}: status '${c.status}' requires a ticket link as proof of implementation.`);
        if (c.status === 'verified' && !c.verificationUrl)
            add('warning', `${c.id}: status 'verified' requires a verification link as evidence the control was tested.`);
        for (const a of c.addresses || []) {
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

    for (const r of reqs) {
        const hasCm = (r.satisfiedByCM || []).length > 0;
        const hasThreat = (r.derivedFromThreat || []).length > 0;
        if (!hasCm) {
            if (hasThreat) add('warning', `${r.id}: security requirement derived from a threat has no countermeasure satisfying it.`);
            // A requirement that neither addresses a threat nor is backed by a control is a valid,
            // intentional standalone requirement — a notice the user can accept, not a warning.
            else add('notice', `${r.id}: standalone security requirement — not derived from a threat and not backed by a countermeasure. Accept if this is intentional.`, `req-standalone:${r.id}`);
        }
        for (const th of r.derivedFromThreat || []) if (!tIds.has(th)) add('error', `${r.id}: derived from unknown threat '${th}'.`);
        for (const cm of r.satisfiedByCM || []) if (!cmIds.has(cm)) add('error', `${r.id}: satisfied by unknown countermeasure '${cm}'.`);
    }
    const reqThreats = new Set(reqs.flatMap((r) => r.derivedFromThreat || []));
    for (const t of threats) {
        const highOrAbove = riskEngine
            ? riskEngine.inRange('likelihood', t.likelihood) && riskEngine.inRange('impact', t.impact) && riskEngine.isHighOrAbove(riskEngine.classify(t.likelihood, t.impact))
            : !schemeWarning && (t.likelihood || 0) * (t.impact || 0) >= 12;
        if (highOrAbove && !reqThreats.has(t.id) && t.status !== 'accepted')
            add('warning', `${t.id}: high/critical threat has no security requirement derived from it.`);
        if (t.status === 'transferred' && !reqThreats.has(t.id))
            add('warning', `${t.id}: transferred risk requires a linked requirement documenting the risk transfer in the user guide.`);
    }

    const parents = new Set(components.map((c) => c.parent).filter(Boolean) as string[]);
    const threatComps = new Set(threats.flatMap((t) => t.components || []));
    for (const c of components)
        if (c.kind !== 'external-entity' && c.kind !== 'device' && !parents.has(c.id) && !threatComps.has(c.id))
            add('warning', `Coverage: component '${c.id}' (${c.name}) has no threat — STRIDE-per-element coverage gap.`);
    const threatIfaces = new Set(threats.flatMap((t) => [...(t.interfaceRefs || []), ...(t.interfaceRef ? [t.interfaceRef] : [])]).filter(Boolean));
    for (const i of interfaces)
        if (!threatIfaces.has(i.id)) add('warning', `Coverage: interface '${i.id}' (${i.name}) has no threat — every external interface should have at least one.`);

    for (const n of data.dfd?.nodes || [])
        if (n.type === 'trust-boundary' && !(n.members || []).length)
            add('warning', `Trust boundary '${n.id}' has no members (a trust boundary must contain at least one node).`);
    const boundaryIds = new Set([
        ...(data.system?.trustBoundaries || []).map((b) => b.id),
        ...(data.dfd?.nodes || []).filter((n) => n.type === 'trust-boundary').map((n) => n.id),
    ]);
    for (const f of data.dfd?.flows || []) {
        if (f.crossesBoundary && !boundaryIds.has(f.crossesBoundary))
            add('error', `Flow '${f.id}' references unknown trust boundary '${f.crossesBoundary}'.`);
        if (!f.label || !f.label.trim())
            add('warning', `Data flow '${f.id}' (${f.from}→${f.to}) has no label — every flow must state what data or command it carries.`);
    }
    for (const d of data.defects?.defects || []) {
        if (d.component && !compIds.has(d.component)) add('error', `${d.id || 'defect'}: references unknown component '${d.component}'.`);
        if (d.threatRef && !tIds.has(d.threatRef)) add('error', `${d.id || 'defect'}: references unknown threat '${d.threatRef}'.`);
        if ((d.status === 'open' || d.status === 'triaged') && (d.severity === 'high' || d.severity === 'critical') && d.threatRef)
            add('warning', `${d.id}: open ${d.severity} defect — re-assess the linked threat '${d.threatRef}'.`);
    }
    for (const tr of data.attackTrees?.trees || []) {
        const refs = [...new Set([...(tr.threatRefs || []), ...(tr.threatRef ? [tr.threatRef] : [])])];
        for (const ref of refs) if (!tIds.has(ref)) add('error', `Attack tree '${tr.id}' references unknown threat '${ref}'.`);
    }

    const ucDiagrams = data.useCases?.diagrams || [];
    if (ucDiagrams.length > 0 && !project.reportOptions?.includeUseCases) {
        add(
            'notice',
            `Use-case diagrams exist (${ucDiagrams.length}) but report inclusion is disabled. Accept this notice if the exclusion is intentional.`,
            'usecases-excluded',
        );
    }
    return issues;
}
