import assert from 'node:assert/strict';
import { validate } from '../server/src/validate.js';

function baseProject() {
    return {
        project: {},
        assumptions: {
            attacker: [{ id: 'ATK-1', name: 'Remote attacker', capability: 3, access: 'remote' }],
            device: [],
            system: [],
            environment: [],
            operational: [],
        },
        system: {
            components: [{ id: 'C-1', name: 'Controller', kind: 'software', layer: 1, parent: null }],
            interfaces: [{ id: 'IF-1', name: 'Service port', component: 'C-1', exposure: 'remote' }],
            assets: [{ id: 'AS-1', name: 'Config', objectives: { confidentiality: 1, integrity: 2, availability: 1, safety: 0 } }],
            trustBoundaries: [],
        },
        threats: { threats: [] },
        requirements: { requirements: [] },
        countermeasures: { countermeasures: [] },
        dfd: { nodes: [], flows: [] },
        useCases: { diagrams: [] },
        attackTrees: { trees: [] },
        defects: { defects: [] },
    };
}

function issueMessages(issues, severity) {
    return issues.filter((issue) => !severity || issue.severity === severity).map((issue) => issue.message);
}

function testAssetWithoutThreatRequiresRationale() {
    const project = baseProject();
    const expected = 'AS-1: no threat is linked to this asset. Add a threat or state why none applies (noThreatRationale).';

    assert.equal(issueMessages(validate(project), 'warning').filter((message) => message === expected).length, 1);
    project.system.assets[0].noThreatRationale = 'This asset has no applicable threat.';
    assert.ok(!issueMessages(validate(project), 'warning').includes(expected));

    delete project.system.assets[0].noThreatRationale;
    project.threats.threats.push({ id: 'T-ASSET', assets: ['AS-1'] });
    assert.ok(!issueMessages(validate(project), 'warning').includes(expected));
}

function testClassificationNoticeAndTransferRequirementWarning() {
    const project = baseProject();
    project.threats.threats.push({
        id: 'T-1',
        title: 'Spoofed service response',
        stride: ['S'],
        components: ['C-1'],
        assets: ['AS-1'],
        attackerRef: 'ATK-1',
        interfaceRef: 'IF-1',
        likelihood: 3,
        impact: 2,
        status: 'transferred',
    });

    const issues = validate(project);
    assert.ok(issueMessages(issues, 'notice').includes('T-1: classification is unset for a spoofing/tampering/information-disclosure threat; classify whether this is a product vulnerability, protocol limitation, deployment risk, or shared responsibility.'));
    assert.ok(issueMessages(issues, 'warning').includes('T-1: transferred risk requires a linked requirement documenting the risk transfer in the user guide.'));
}

function testDeploymentConstraintsRuleSkipsAcceptedOrTransferredAndFlagsOpen() {
    const project = baseProject();
    project.threats.threats.push(
        {
            id: 'T-1',
            title: 'Open protocol limitation',
            stride: ['I'],
            components: ['C-1'],
            assets: ['AS-1'],
            attackerRef: 'ATK-1',
            interfaceRef: 'IF-1',
            likelihood: 3,
            impact: 1,
            classification: 'protocol-limitation',
            status: 'open',
        },
        {
            id: 'T-2',
            title: 'Accepted protocol limitation',
            stride: ['I'],
            components: ['C-1'],
            assets: ['AS-1'],
            attackerRef: 'ATK-1',
            interfaceRef: 'IF-1',
            likelihood: 3,
            impact: 1,
            classification: 'protocol-limitation',
            status: 'accepted',
        },
        {
            id: 'T-3',
            title: 'Transferred shared responsibility',
            stride: ['T'],
            components: ['C-1'],
            assets: ['AS-1'],
            attackerRef: 'ATK-1',
            interfaceRef: 'IF-1',
            likelihood: 3,
            impact: 1,
            classification: 'shared-responsibility',
            status: 'transferred',
        },
    );

    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(warnings.includes('T-1: protocol-limitation classification requires deploymentConstraints unless the risk is accepted or transferred.'));
    assert.ok(!warnings.includes('T-2: protocol-limitation classification requires deploymentConstraints unless the risk is accepted or transferred.'));
    assert.ok(!warnings.includes('T-3: shared-responsibility classification requires deploymentConstraints unless the risk is accepted or transferred.'));
}

function testContradictoryProductVulnerabilityClassification() {
    const project = baseProject();
    project.threats.threats.push({
        id: 'T-1',
        title: 'Misclassified product flaw',
        stride: ['T'],
        components: ['C-1'],
        assets: ['AS-1'],
        attackerRef: 'ATK-1',
        interfaceRef: 'IF-1',
        likelihood: 2,
        impact: 2,
        classification: 'product-vulnerability',
        responsibility: 'integrator-operator',
        deploymentConstraints: 'Segment the network.',
        status: 'open',
    });

    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(warnings.includes('T-1: product-vulnerability with integrator-operator responsibility and deploymentConstraints is contradictory.'));
}

function testTransferredThreatWithLinkedRequirementDoesNotWarn() {
    const project = baseProject();
    project.threats.threats.push({
        id: 'T-1',
        title: 'Transferred threat',
        stride: ['S'],
        components: ['C-1'],
        assets: ['AS-1'],
        attackerRef: 'ATK-1',
        interfaceRef: 'IF-1',
        likelihood: 2,
        impact: 2,
        classification: 'deployment-risk',
        status: 'transferred',
    });
    project.requirements.requirements.push({
        id: 'R-1',
        text: 'The user guide shall document this transferred risk.',
        derivedFromThreat: ['T-1'],
    });

    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(!warnings.includes('T-1: transferred risk requires a linked requirement documenting the risk transfer in the user guide.'));
}

function testCostBasedSlcValidation() {
    const project = baseProject();
    project.project = { slTarget: 'SL-C 2', riskScoringMethod: 'cost-based' };
    project.assumptions.attacker = [{ id: 'ATK-SLC-2', name: 'Managed SL-C attacker', capability: 2 }];
    project.threats.threats.push({
        id: 'T-1', title: 'Cost threat', stride: ['T'], components: ['C-1'], assets: ['AS-1'], attackerRef: 'ATK-SLC-2',
        likelihood: 1, impact: 3, requiredSkill: 3, requiredAccess: 3,
        costFactors: { time: 2, exploitability: 2, window: 3, detection: 3, notoriety: 2, prep: 2, abort: 2 },
        costRationales: { time: 'Measured effort', exploitability: 'Known weakness', window: 'Routine access', detection: 'Monitoring is limited', notoriety: 'Public knowledge', prep: 'Standard tools', abort: 'Low consequence' }, status: 'open',
    });
    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(warnings.includes('T-1: required capability exceeds the SL-C 2 attacker capability and should be marked unfeasible.'));
    assert.ok(!warnings.some((message) => message.includes('unassessed difficulty dimensions')));
}

function testUnfeasibleThreatHasNoResidualRiskWarning() {
    const project = baseProject();
    project.threats.threats.push({
        id: 'T-1', title: 'Unfeasible threat', stride: ['T'], components: ['C-1'], likelihood: 5, impact: 5, status: 'unfeasible',
    });
    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(!warnings.some((message) => message.includes('residual risk 25 exceeds')));
}

function testCostWeightLimitWarning() {
    const project = baseProject();
    project.project = {
        riskScoringMethod: 'cost-based',
        costFactorWeights: { time: 0.5, exploitability: 0.5, window: 0.5 },
    };
    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(warnings.includes('Cost-factor weights total 1.90; they must combine to 1.00.'));
}

function testCostWeightUnderAllocationWarning() {
    const project = baseProject();
    project.project = { riskScoringMethod: 'cost-based', costFactorWeights: { time: 0 } };
    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(warnings.includes('Cost-factor weights total 0.75; they must combine to 1.00.'));
}

function testAccessProbabilityAndLikelihoodOverrideNotices() {
    const project = baseProject();
    project.project = { riskScoringMethod: 'cost-based', accessProbabilities: { 3: 0.02 } };
    project.threats.threats.push({
        id: 'T-1', title: 'Manual likelihood override', stride: ['T'], components: ['C-1'], likelihood: 4, impact: 3,
        costLikelihoodProposal: 2,
    });
    const issues = validate(project);
    const warnings = issueMessages(issues, 'warning');
    const notices = issueMessages(issues, 'notice');
    assert.ok(warnings.includes('Access probability for level 3 must be between 0.05 and 1.00.'));
    assert.ok(notices.includes('T-1: manually selected likelihood (4) differs from the calculated cost-based proposal (2).'));
}

function testLikelihoodThresholdValidation() {
    const project = baseProject();
    project.project = { riskScoringMethod: 'cost-based', likelihoodProbabilityThresholds: { 2: 0.4, 3: 0.3, 4: 0.7, 5: 0.9 } };
    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(warnings.includes('Likelihood probability thresholds must be strictly increasing from L2 through L5 and within 0.01 to 1.00.'));
}

function slcProject(level, capability, requiredSkill) {
    const project = baseProject();
    const id = `ATK-SLC-${level}`;
    project.project = { slTarget: `SL-C ${level}`, riskScoringMethod: 'cost-based' };
    project.assumptions.attacker = [{ id, name: 'Managed', capability }];
    project.threats.threats.push({
        id: 'T-1', title: 'Cost threat', stride: ['T'], components: ['C-1'], assets: ['AS-1'], attackerRef: id,
        likelihood: 1, impact: 3, requiredSkill, requiredAccess: 3, status: 'open',
    });
    return validate(project);
}

function testActorScaleValidation() {
    const profileWarning = (issues) => issues.some((i) => i.key === 'slc-attacker-profile');
    const overCapability = (issues) => issueMessages(issues, 'warning').some((m) => m.includes('required capability exceeds'));
    const legacyKeys = (issues) => issues.filter((i) => i.key.startsWith('legacy-actor-level:')).map((i) => i.key);

    let issues = slcProject(4, 4, 4);
    assert.ok(!profileWarning(issues));
    assert.ok(!overCapability(issues));
    assert.deepEqual(legacyKeys(issues), []);

    issues = slcProject(4, 5, 5);
    assert.ok(!profileWarning(issues));
    assert.ok(!overCapability(issues));
    assert.deepEqual(legacyKeys(issues), ['legacy-actor-level:ATK-SLC-4', 'legacy-actor-level:T-1']);

    assert.ok(overCapability(slcProject(3, 3, 4)));
    assert.ok(!overCapability(slcProject(3, 3, 3)));

    const project = baseProject();
    project.attackTrees.trees.push({ id: 'AT-1', root: { id: 'N-1', children: [{ id: 'N-2', skill: 5 }] } });
    assert.deepEqual(validate(project).filter((i) => i.key.startsWith('legacy-actor-level:')).map((i) => i.key), ['legacy-actor-level:AT-1:N-2']);
}

testActorScaleValidation();
testActorScaleValidation();
testAssetWithoutThreatRequiresRationale();
testClassificationNoticeAndTransferRequirementWarning();
testDeploymentConstraintsRuleSkipsAcceptedOrTransferredAndFlagsOpen();
testContradictoryProductVulnerabilityClassification();
testTransferredThreatWithLinkedRequirementDoesNotWarn();
testCostBasedSlcValidation();
testUnfeasibleThreatHasNoResidualRiskWarning();
testCostWeightLimitWarning();
testCostWeightUnderAllocationWarning();
testAccessProbabilityAndLikelihoodOverrideNotices();
testLikelihoodThresholdValidation();

console.log('validation tests passed');
