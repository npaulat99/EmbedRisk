import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from '../server/src/validate.js';
import { builtinRiskSchemePaths } from '../server/src/paths.js';

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

function testAvoidedThreatRequiresRationaleAndChangedContextLink() {
    const project = baseProject();
    project.requirements.requirements = [];
    project.threats.threats.push({ id: 'T-AVOID', title: 'Avoided', stride: ['D'], components: ['C-1'], assets: ['AS-1'], likelihood: 5, impact: 5, status: 'avoided' });
    const issues = validate(project);
    const rationaleWarning = 'T-AVOID: an avoided risk requires avoidanceRationale describing the design or context change.';
    const contextNotice = 'T-AVOID: avoided risk is not linked to a requirement or assumption; the changed context should be re-assessed.';
    assert.equal(issueMessages(issues, 'warning').filter((message) => message === rationaleWarning).length, 1);
    assert.ok(issues.some((issue) => issue.severity === 'notice' && issue.key === 'avoided-link:T-AVOID' && issue.message === contextNotice));
    assert.ok(!issueMessages(issues, 'warning').some((message) => message.includes('residual risk')));

    project.threats.threats[0].avoidanceRationale = 'The interface was removed from the product.';
    project.threats.threats[0].assumptionRefs = ['ATK-1'];
    const resolved = validate(project);
    assert.ok(!issueMessages(resolved, 'warning').includes(rationaleWarning));
    assert.ok(!resolved.some((issue) => issue.key === 'avoided-link:T-AVOID'));
}

function testAvoidedThreatSkipsManagementAcceptance() {
    const riskScheme = JSON.parse(readFileSync(builtinRiskSchemePaths['builtin:5x5-exposure'], 'utf8'));
    riskScheme.classification.levels.find((level) => level.id === 'critical').acceptanceBy = 'management';
    const project = baseProject();
    project.riskScheme = riskScheme;
    project.threats.threats.push({ id: 'T-AVOID', title: 'Avoided', stride: ['D'], components: ['C-1'], assets: ['AS-1'], likelihood: 5, impact: 5, status: 'avoided', avoidanceRationale: 'The interface was removed.' });
    const warnings = issueMessages(validate(project), 'warning');
    assert.ok(!warnings.some((message) => message.includes('requires acceptance by management')));
    project.threats.threats[0].status = 'mitigated';
    assert.ok(issueMessages(validate(project), 'warning').some((message) => message.includes('requires acceptance by management')));
}

function testTransferredThreatRequiresTransferRationale() {
    const project = baseProject();
    project.threats.threats.push({ id: 'T-TRANSFER', title: 'Transferred', stride: ['D'], components: ['C-1'], assets: ['AS-1'], likelihood: 2, impact: 2, status: 'transferred' });
    project.requirements.requirements.push({ id: 'R-TRANSFER', derivedFromThreat: ['T-TRANSFER'] });
    const expected = 'T-TRANSFER: a transferred risk requires transferRationale (who receives the risk and how they are informed).';
    assert.equal(issueMessages(validate(project), 'warning').filter((message) => message === expected).length, 1);
    project.threats.threats[0].transferRationale = 'The plant operator owns this risk and is notified in the deployment guide.';
    assert.ok(!issueMessages(validate(project), 'warning').includes(expected));
}

function testAcceptanceAboveThresholdRequiresDeviationCircumstance() {
    const project = baseProject();
    project.threats.threats.push({
        id: 'T-ACCEPT', title: 'Above threshold', stride: ['D'], components: ['C-1'], assets: ['AS-1'],
        likelihood: 5, impact: 5, status: 'accepted', acceptedBy: 'Risk owner', acceptanceRationale: 'Operational need', reviewDate: '2099-01-01',
    });
    project.requirements.requirements.push({ id: 'R-ACCEPT', derivedFromThreat: ['T-ACCEPT'] });
    const expected = 'T-ACCEPT: acceptance above the acceptable level requires acceptanceDeviation.circumstance.';
    assert.equal(issueMessages(validate(project), 'warning').filter((message) => message === expected).length, 1);
    project.threats.threats[0].acceptanceDeviation = { circumstance: 'Contractual requirement', communicatedTo: 'Plant operator' };
    assert.ok(!issueMessages(validate(project), 'warning').includes(expected));
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

function testThreatStructureNoticeIsAggregatedAndDismissible() {
    const project = baseProject();
    project.threats.threats = [
        { id: 'T-STRUCT-1', title: 'No structure fields', stride: ['S'], components: ['C-1'], likelihood: 2, impact: 2 },
        { id: 'T-STRUCT-2', title: 'Also incomplete', stride: ['T'], components: ['C-1'], likelihood: 2, impact: 2 },
        { id: 'T-STRUCT-3', title: 'Cause only', stride: ['R'], components: ['C-1'], likelihood: 2, impact: 2, cause: 'Weak input validation.' },
        { id: 'T-STRUCT-4', title: 'Objective only', stride: ['I'], components: ['C-1'], likelihood: 2, impact: 2, compromisedObjectives: ['confidentiality'] },
    ];
    const message = '2 threats do not state a cause or the compromised objectives (EN 40000-1-2, 6.4.3.3).';
    const notice = validate(project).filter((issue) => issue.key === 'threat-structure-empty');
    assert.deepEqual(notice, [{ severity: 'notice', message, key: 'threat-structure-empty' }]);

    project.threats.threats[0].compromisedObjectives = ['integrity'];
    assert.ok(validate(project).some((issue) => issue.key === 'threat-structure-empty'));
    project.threats.threats[1].cause = 'Insufficient authorization checks.';
    assert.ok(!validate(project).some((issue) => issue.key === 'threat-structure-empty'));
    project.project.acceptedNotices = ['threat-structure-empty'];
    project.threats.threats[0].compromisedObjectives = [];
    project.threats.threats[1].cause = '';
    assert.ok(!validate(project).some((issue) => issue.key === 'threat-structure-empty'));
}

function testEvidenceReferencesMustBeSafeUrlsOrProjectPaths() {
    const project = baseProject();
    const evidenceIssues = () => validate(project).filter((issue) => issue.message.startsWith('Evidence reference '));
    project.project.productContext = {
        evidence: [
            { title: 'External evidence', ref: 'https://example.invalid/evidence' },
            { title: 'Project evidence', ref: 'docs/evidence.pdf' },
        ]
    };
    assert.deepEqual(evidenceIssues(), []);

    for (const ref of [
        'ftp://example.invalid/evidence',
        'javascript:alert(1)',
        'data:text/plain,unsafe',
        '../outside.pdf',
        '..\\outside.pdf',
        'C:\\outside.pdf',
        '//host/outside.pdf',
        '/absolute.pdf',
        '%2e%2e%2foutside.pdf',
    ]) {
        project.project.productContext.evidence = [{ title: 'Invalid evidence', ref }];
        const message = "Evidence reference 1: only http(s) URLs and project-relative paths without '..' are allowed.";
        assert.deepEqual(evidenceIssues(), [{ severity: 'error', message, key: message }], `expected V-06 for ${ref}`);
    }
}

function testProductContextAndRiskCriteriaNotices() {
    const project = baseProject();
    const noticeKeys = () => validate(project).filter((issue) => ['product-context-empty', 'risk-criteria-empty'].includes(issue.key));
    project.project.status = 'draft';
    assert.deepEqual(noticeKeys(), []);

    project.project.status = 'review';
    assert.deepEqual(noticeKeys().map(({ key, message, severity }) => ({ severity, message, key })), [
        { severity: 'notice', message: 'Product context is incomplete: functions and users are not described (EN 40000-1-2, 6.2).', key: 'product-context-empty' },
        { severity: 'notice', message: 'The choice of the risk scheme and acceptance criteria is not justified (EN 40000-1-2, 6.3.3).', key: 'risk-criteria-empty' },
    ]);
    project.project.status = 'released';
    assert.equal(noticeKeys().length, 2);

    project.project.productContext = { functions: [{ name: 'Measure level' }], users: { description: 'Plant operators.' } };
    project.project.riskCriteria = { schemeJustification: 'Chosen for process-safety consequences.' };
    assert.deepEqual(noticeKeys(), []);

    project.project.productContext = {};
    project.project.riskCriteria = {};
    project.project.acceptedNotices = ['product-context-empty', 'risk-criteria-empty'];
    assert.deepEqual(noticeKeys(), []);
}

function testProductContextListsWarnAboveFiftyItems() {
    const project = baseProject();
    project.project.productContext = {
        functions: Array.from({ length: 51 }, (_, index) => ({ name: `Function ${index + 1}` })),
        evidence: Array.from({ length: 51 }, (_, index) => ({ title: `Evidence ${index + 1}`, ref: 'docs/evidence.pdf' })),
        users: { vulnerableGroups: Array.from({ length: 51 }, (_, index) => `Group ${index + 1}`) },
    };
    const limits = validate(project).filter((issue) => issue.key.startsWith('product-context-limit:'));
    assert.deepEqual(limits.map(({ severity, key, message }) => ({ severity, message, key })), [
        { severity: 'warning', message: 'Product context functions has 51 entries; the limit is 50.', key: 'product-context-limit:functions' },
        { severity: 'warning', message: 'Product context evidence has 51 entries; the limit is 50.', key: 'product-context-limit:evidence' },
        { severity: 'warning', message: 'Product context vulnerable groups has 51 entries; the limit is 50.', key: 'product-context-limit:vulnerable groups' },
    ]);
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
testAvoidedThreatRequiresRationaleAndChangedContextLink();
testAvoidedThreatSkipsManagementAcceptance();
testTransferredThreatRequiresTransferRationale();
testAcceptanceAboveThresholdRequiresDeviationCircumstance();
testThreatStructureNoticeIsAggregatedAndDismissible();
testEvidenceReferencesMustBeSafeUrlsOrProjectPaths();
testProductContextAndRiskCriteriaNotices();
testProductContextListsWarnAboveFiftyItems();
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
