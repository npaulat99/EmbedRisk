// Shared TypeScript types mirroring the TRA JSON schemas (tra/.assets/schema/*).
export type StepKey = 'project' | 'assumptions' | 'system' | 'dfd' | 'useCases' | 'threats' | 'requirements' | 'countermeasures' | 'attackTrees' | 'defects';
export type ViewKey = StepKey | 'review' | 'versions';
export type ChangeReason = 'initial' | 'functional changes' | 'new vulnerabilities' | 'regular reassessment';

export interface ChangeTrackerEntry {
    version: string;
    reason: ChangeReason;
    assessedAt: string;
    assessors: string[];
    summary?: string;
    changedSteps?: StepKey[];
    changedFiles?: string[];
    hasChanges?: boolean;
    snapshotPath?: string;
}

export interface ChangeTracker {
    currentVersion: string | null;
    entries: ChangeTrackerEntry[];
}

export interface VersionDiffItem {
    path: string;
    value?: unknown;
    before?: unknown;
    after?: unknown;
}

export interface VersionDiffFile {
    step: StepKey;
    path: string;
    diff: {
        added: VersionDiffItem[];
        removed: VersionDiffItem[];
        changed: VersionDiffItem[];
    };
}

export interface VersionDiff {
    fromVersion: string;
    toVersion: string;
    changedFiles: { step: StepKey; path: string }[];
    files: VersionDiffFile[];
}

export interface DeviceInfo {
    name?: string;
    type?: string;
    modelReference?: string;
    purdueLevel?: string;
    version?: string;
}
export interface Scope {
    mode?: 'blackbox' | 'graybox' | 'whitebox';
    boundary?: string;
    inScope?: string[];
    outOfScope?: string[];
}
export interface RepoLinks {
    projectBranchUrl?: string; // link to the project's branch / PR in DevOps/GitHub
    kbUrl?: string; // git URL of the shared knowledge base (pull-only)
}
export interface SbomConfig {
    mode?: 'external' | 'in-tool'; // reference an external SBOM tool, or generate the SBOM here
    format?: 'cyclonedx' | 'spdx'; // only when mode = in-tool
    url?: string; // only when mode = external: link to the SBOM in the external tool
}
export interface Project {
    traVersion?: string;
    projectId?: string;
    title?: string;
    device?: DeviceInfo;
    scope?: Scope;
    slTarget?: string;
    riskScoringMethod?: 'exposure-exploitability-impact' | 'cost-based';
    riskSchemeId?: string;
    riskSchemeFingerprint?: string;
    costFactorWeights?: Partial<Record<keyof AdCost, number>>;
    accessProbabilities?: Partial<Record<1 | 2 | 3 | 4 | 5, number>>;
    likelihoodProbabilityThresholds?: Partial<Record<2 | 3 | 4 | 5, number>>; // lower probability bounds for L2-L5; L1 covers remaining positive values
    intendedUse?: string; // CRA: the manufacturer's intended purpose of the product
    foreseeableUse?: string[]; // CRA: reasonably foreseeable use scenarios
    repo?: RepoLinks;
    sbom?: SbomConfig;
    rigorousMode?: boolean; // when on, the structured Bug Bar + factor rubric is mandatory per threat
    acceptableRisk?: number; // residual risk at or below this value is acceptable; above it the checker warns (default 12)
    acceptableLevel?: string;
    acceptedNotices?: string[]; // keys of plausibility notices the user has explicitly accepted (no longer open points)
    reportOptions?: ReportOptions;
    steps?: Record<string, string>;
    status?: 'draft' | 'in-progress' | 'review' | 'released';
}

/** Report-generation toggles (Settings) — what optional sections to include in the HTML report. */
export interface ReportOptions {
    includeStrideBoundaryAnalysis?: boolean; // include the per-trust-boundary STRIDE strengths/weaknesses tables
    includeUseCases?: boolean; // include persisted use-case diagrams in the generated report
}

export type UseCaseEntityKind = 'actor' | 'misuse-actor' | 'action' | 'misuse-action';
export type UseCaseArrow = 'none' | 'forward' | 'backward' | 'both';

export interface UseCaseEntity {
    id: string;
    kind: UseCaseEntityKind;
    name: string;
    x?: number;
    y?: number;
}

export interface UseCaseConnection {
    id: string;
    from: string;
    to: string;
    dashed?: boolean;
    arrow?: UseCaseArrow;
    label?: string;
}

export interface UseCaseGroup {
    id: string;
    name: string;
    members: string[];
    x?: number;
    y?: number;
    w?: number;
    h?: number;
}

export interface UseCaseDiagram {
    id: string;
    name: string;
    kind?: 'use-case' | 'independent-dfd';
    entities: UseCaseEntity[];
    connections: UseCaseConnection[];
    groups: UseCaseGroup[];
    drawioXml?: string;
    dfd?: Dfd;
}

export interface UseCasesDoc {
    diagrams: UseCaseDiagram[];
}

export const DEFAULT_ACCEPTABLE_RISK = 12;

export interface Assumption {
    id: string;
    text: string;
    rationale?: string;
    confidence?: 'low' | 'medium' | 'high';
}
export interface AttackerProfile {
    id: string;
    name: string;
    capability: number;
    access?: 'remote' | 'adjacent' | 'local' | 'physical'; // legacy-only; access is now scored per threat/path
    motivation?: string;
    resources?: string;
    text?: string;
}
export interface Assumptions {
    device: Assumption[];
    system: Assumption[];
    environment: Assumption[];
    operational: Assumption[];
    attacker: AttackerProfile[];
}

export type ComponentKind = 'device' | 'hardware' | 'software' | 'interface' | 'external-entity' | 'store';
export type Provenance = 'own' | 'third-party';
export interface Component {
    id: string;
    name: string;
    kind: string; // suggested values in ComponentKind; free text allowed
    provenance?: string; // 'own' vs. third-party (OSS / commercial); free text allowed
    layer: number;
    parent?: string | null;
    trustZone?: string;
    description?: string;
    version?: string; // SBOM: component/package version
    supplier?: string; // SBOM: supplier / author
    license?: string; // SBOM: license (SPDX id)
    cpe?: string; // SBOM: CPE or purl identifier for CVE matching
}
export type InterfaceCategory = 'network' | 'external' | 'user';
export interface Interface {
    id: string;
    name: string;
    component?: string;
    category?: string; // suggested: network / external / user; free text allowed
    exposure: 'physical' | 'local' | 'adjacent' | 'remote';
    tag?: string; // short chip tag shown in the DFD (e.g. BLE, HMI, JTAG)
    protocol?: string;
    hidden?: boolean; // optional DFD presentation flag (true = hidden from step-04 rendering)
}
export interface TrustBoundary {
    id: string;
    name: string;
    members?: string[];
}

// ---- Per-trust-boundary STRIDE strengths/weaknesses analysis (a structured brainstorming aid) ----
// One table per *pair of entities* that communicate across a trust boundary (e.g. HART ⇄ Plant DCS
// vs. Bluetooth ⇄ maintenance app on the device-housing boundary), because different protocols give
// different security properties, so each pair may be analysed differently. For both sides of the
// pair and each STRIDE category, the strengths and weaknesses seen from that side's perspective.
// Stored in `system.strideAnalyses` keyed by trust-boundary id, then by a pair key derived from the
// two communicating endpoints; the side labels (entity names) are auto-derived and can be
// overridden. Only user-authored text is persisted, so it survives DFD/system reconciliation.
export interface StrideCategoryCell {
    strengths?: string[];
    weaknesses?: string[];
}
export interface StrideSideAnalysis {
    label?: string; // optional override of the auto-derived entity name for this endpoint
    cells?: Partial<Record<Stride, StrideCategoryCell>>;
}
export interface StridePairAnalysis {
    // Keyed by endpoint id (boundary-independent). The inside/outside role depends on which
    // boundary is being viewed, but the security properties of each endpoint are always shared.
    endpoints?: Record<string, StrideSideAnalysis>;
}
export interface Objectives {
    confidentiality?: number;
    integrity?: number;
    availability?: number;
    safety?: number;
}
export interface Asset {
    id: string;
    name: string;
    type?: string; // suggested: data | function | credential | firmware | config | physical-process
    components?: string[];
    storage?: string; // where the data/asset is stored (e.g. internal flash, secure element)
    objectives: Objectives;
}
export interface SystemDef {
    components: Component[];
    interfaces: Interface[];
    trustBoundaries: TrustBoundary[];
    assets: Asset[];
    // pairKey -> analysis; shared across every boundary that the pair's flow crosses, because
    // the channel's security properties are the same regardless of which boundary you view it from.
    strideAnalyses?: Record<string, StridePairAnalysis>;
}

export type DfdNodeType = 'external-entity' | 'process' | 'multiprocess' | 'store' | 'trust-boundary';
export interface DfdNode {
    id: string;
    label: string;
    type: DfdNodeType;
    layer: number;
    parent?: string | null;
    componentRef?: string;
    members?: string[];
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}
export interface Flow {
    id: string;
    label?: string;
    from: string;
    to: string;
    crossesBoundary?: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
}
export interface Dfd {
    nodes: DfdNode[];
    flows: Flow[];
    ifacePos?: Record<string, { x: number; y: number }>; // user-positioned interface chips, keyed "${parentId ?? 'root'}:${ifaceId}"
    ifaceRot?: Record<string, number>; // user-rotated interface chips in degrees, keyed "${parentId ?? 'root'}:${ifaceId}"
    ifaceLink?: Record<string, { sourceHandle?: string | null; targetHandle?: string | null }>; // dashed interface link handle overrides, keyed "${parentId ?? 'root'}:${ifaceId}"
    portPos?: Record<string, { x: number; y: number }>; // user-positioned deeper-layer context ports, keyed "${parentId ?? 'root'}:${endpointId}"
}

export type Stride = 'S' | 'T' | 'R' | 'I' | 'D' | 'E';
// Root-cause classification, distinguishing an inherent limitation of the communication
// technology from an actual weakness in this component's own implementation — see
// .ai/README.md's "Protocol limitations vs. product vulnerabilities" section for the reasoning.
export type ThreatClassification = 'product-vulnerability' | 'protocol-limitation' | 'deployment-risk' | 'shared-responsibility';
export type MitigationResponsibility = 'manufacturer' | 'integrator-operator' | 'shared';
export interface Threat {
    id: string;
    title: string;
    description?: string;
    stride: Stride[];
    components: string[];
    assets?: string[];
    attackerRef?: string;
    attackTreeRef?: string | null;
    likelihood: number;
    impact: number;
    likelihoodRationale?: string;
    impactRationale?: string;
    assumptionRefs?: string[]; // assumption IDs that justify threat feasibility/risk assessment
    interfaceRef?: string; // primary interface/attack vector id (system.interfaces) the threat enters through
    interfaceRefs?: string[]; // additional affected interfaces/vectors assessed together with the same threat
    interfaceLabel?: string; // free-text interface/vector when not in the interface list
    impactDimensions?: Objectives; // Bug Bar per-dimension impact (C/I/A/Safety); impact = max(...)
    likelihoodCriteria?: Record<string, number | null>;
    impactCriteria?: Record<string, number | null>;
    // Likelihood = f(Exposure × Exploitability), decomposing a single coarse "likelihood" into two
    // objectively-rateable factors (both 1-5, higher = more likely). Exposure = attack-surface
    // reachability; Exploitability = ease of exploitation once the surface is reached.
    likelihoodFactors?: { exposure?: number; exploitability?: number };
    requiredSkill?: number; // 1-4 (threat actor level; legacy 5 is read as 4); cost-based feasibility requirement
    requiredAccess?: number; // 1-5; cost-based access requirement
    costFactors?: AdCost; // cost-based difficulty dimensions; retained alongside legacy factors
    costRationales?: Partial<Record<keyof AdCost, string>>; // assessor rationale for each cost factor
    costLikelihood?: number; // 0-1 calculated cost-based success probability
    costLikelihoodProposal?: number; // 0-5 likelihood proposed from costLikelihood for the L x I matrix
    cvss?: { baseScore?: number; vector?: string; version?: string }; // CVSS 3.1 or 4.0
    countermeasures?: string[];
    residualLikelihood?: number | null;
    residualImpact?: number | null;
    status?: 'open' | 'mitigated' | 'accepted' | 'transferred' | 'unfeasible';
    ratedBy?: string; // inter-rater provenance: who rated this threat
    ratedAt?: string; // ISO timestamp of the last rating
    acceptedBy?: string; // residual-risk sign-off owner (required when status = accepted)
    acceptanceRationale?: string; // justification for accepting the residual risk
    reviewDate?: string; // next lifecycle re-assessment date (YYYY-MM-DD)
    // Root-cause boundary (optional; unset = not yet classified, treat as an open question, not
    // as an implicit 'product-vulnerability'). See .ai/README.md for the full reasoning and the
    // "an inherent protocol limitation is not automatically a product vulnerability" principle.
    classification?: ThreatClassification;
    classificationRationale?: string; // why this classification was chosen, esp. for anything other than product-vulnerability
    responsibility?: MitigationResponsibility; // who owns the residual mitigation for this threat
    deploymentConstraints?: string; // compensating controls/conditions required outside the product boundary (network segmentation, physical protection, gateway architecture, monitoring, ...) for residual risk to be acceptable in an actual deployment
}

export interface ThreatsDoc {
    threats: Threat[];
}

export interface CmAddress {
    threat: string;
    residualLikelihood?: number;
    residualImpact?: number;
    likelihoodCriteria?: Record<string, number | null>;
    impactCriteria?: Record<string, number | null>;
    attackerRef?: string;
    interfaceRef?: string;
    interfaceRefs?: string[];
    interfaceLabel?: string;
    likelihoodFactors?: { exposure?: number; exploitability?: number };
    impactDimensions?: Objectives;
    cvss?: { baseScore?: number; vector?: string; version?: string };
    ratedBy?: string;
    ratedAt?: string;
}
export interface Countermeasure {
    id: string;
    title: string;
    description?: string;
    type?: 'preventive' | 'detective' | 'corrective' | 'organizational';
    addresses: CmAddress[];
    components?: string[];
    iec62443Ref?: string;
    status?: 'proposed' | 'planned' | 'implemented' | 'verified';
    selected?: boolean; // chosen to be implemented — only selected controls appear in the main overview (undefined = selected, for backward compatibility)
    negativeEffects?: string[]; // consequences of adopting this control (e.g. extra implementation effort, higher compute, reduced throughput)
    ticketUrl?: string; // required once status is implemented/verified — proof of implementation
    ticketUrls?: string[]; // optional additional implementation tickets linked to the same control
    verificationUrl?: string; // link to the verification/test evidence
    responsibility?: 'product' | 'deployment' | 'shared'; // who implements this control: a manufacturer-provided product capability, an integrator/operator deployment control, or both
}
export interface CountermeasuresDoc {
    countermeasures: Countermeasure[];
}

// ---- Attack-Defense Trees (Kordy et al. 2010; Jhawar et al. 2015 SAND) -------------------
export type AdGate = 'AND' | 'OR' | 'SAND';
export type AdKind = 'goal' | 'path' | 'step' | 'substep' | 'category' | 'countermeasure' | 'vulnerability';
/** Per-step cost factors scored with the factor-specific 1-5 enumerations in lib/attackTree.ts. */
export interface AdCost {
    time?: number;
    exploitability?: number;
    window?: number;
    detection?: number;
    notoriety?: number;
    prep?: number;
    abort?: number;
}
export interface AdNode {
    id: string;
    kind: AdKind;
    label: string;
    gate?: AdGate; // combination of children, for goal/step/substep/category nodes
    access?: number; // 1-5 required access for a step, defence, or vulnerability assessment
    skill?: number; // 1-4 (threat actor level; legacy 5 is read as 4) required attacker capability for a step, defence, or vulnerability assessment
    cost?: AdCost;
    costRationales?: Partial<Record<keyof AdCost, string>>;
    residualCost?: AdCost; // defence/vulnerability assessment overriding the parent step cost
    residualCostRationales?: Partial<Record<keyof AdCost, string>>;
    impactDimensions?: Objectives; // Bug Bar impact assessed on an attack goal
    countermeasureRef?: string; // for kind 'countermeasure' -> links an existing countermeasure id
    note?: string;
    children?: AdNode[];
}
export interface AttackTree {
    id: string;
    title: string;
    threatRef?: string; // legacy single-link field (kept for backward compatibility)
    threatRefs?: string[]; // preferred: 0..n linked threats this tree decomposes
    description?: string;
    root: AdNode;
}
export interface AttackTreesDoc {
    trees: AttackTree[];
}

export interface ProjectData {
    project: Project;
    assumptions: Assumptions;
    system: SystemDef;
    dfd: Dfd;
    useCases: UseCasesDoc;
    threats: ThreatsDoc;
    requirements: RequirementsDoc;
    countermeasures: CountermeasuresDoc;
    attackTrees: AttackTreesDoc;
    defects: DefectsDoc;
    changeTracker: ChangeTracker;
}

// ---- Security requirements (step 05) — the threat -> risk -> requirement -> control chain ----
export interface Requirement {
    id: string;
    text: string;
    standardRef?: string; // e.g. IEC 62443-4-2 CR 1.2, ETSI EN 303 645 provision
    derivedFromThreat?: string[]; // threats that motivate this requirement
    satisfiedByCM?: string[]; // countermeasures that satisfy it
    fromCountermeasure?: boolean; // "is CM": this requirement realises a countermeasure and therefore reduces a threat's risk
    slFr?: string; // SL / Foundational Requirement reference (e.g. FR1 SL2)
}
export interface RequirementsDoc {
    requirements: Requirement[];
}

// ---- Defect / vulnerability register (lifecycle DM/SUM) ----
export interface Defect {
    id: string;
    title: string;
    cve?: string;
    component?: string; // affected component id
    threatRef?: string; // threat to re-assess when this defect is open (lifecycle DM/SUM)
    severity?: 'low' | 'medium' | 'high' | 'critical';
    status?: 'open' | 'triaged' | 'fixed' | 'wont-fix';
    discovered?: string; // ISO date
    fixedIn?: string; // firmware/version the fix ships in
    note?: string;
}
export interface DefectsDoc {
    defects: Defect[];
}

export interface ProjectSummary {
    id: string;
    title: string;
    device: DeviceInfo | null;
    status: string;
    slTarget: string;
}

export interface LaunchConfig {
    preselectProjectId: string | null;
}

export interface RiskBand {
    name: string;
    min: number;
    max: number;
    color: string;
}
export type RiskDerivationKind = 'criteria-max' | 'geometric-mean' | 'cost-based' | 'manual';
export interface RiskAxisLevel {
    value: number;
    code: string;
    label: string;
    description?: string;
}
export interface RiskCriterion {
    id: string;
    label: string;
    levelTexts: Record<string, string>;
}
export interface RiskLevel {
    id: string;
    label: string;
    rank: number;
    color: string;
    treatment: 'auto-accept' | 'optional' | 'required' | 'immediate';
    acceptanceBy?: 'management';
    description?: string;
}
export interface RiskSchemeV2 {
    schemaVersion: 2;
    id: string;
    title: string;
    version: string;
    description?: string;
    likelihood: {
        levels: RiskAxisLevel[];
        derivation: { kind: RiskDerivationKind; probabilityThresholds?: Record<string, number> };
        criteria: RiskCriterion[];
    };
    impact: {
        levels: RiskAxisLevel[];
        derivation: { kind: 'criteria-max' | 'manual' };
        criteria: RiskCriterion[];
    };
    classification: {
        kind: 'lookup' | 'product-bands';
        levels: RiskLevel[];
        matrix?: Record<string, Record<string, string>>;
        bands?: { level: string; min: number; max: number }[];
    };
    highLevel?: string;
    acceptance?: { defaultLevel: string };
}
export interface LegacyRiskScheme {
    likelihood: {
        scale: { score: number; label: string; desc: string }[];
        factors: string[];
        factorScale?: Record<string, { score: number; label: string }[]>;
        derivation?: string;
    };
    impact: { scale: { score: number; label: string; desc: string }[]; bugBarDimensions: string[]; rule: string };
    matrix: { axes: string; bands: RiskBand[] };
    cvss?: { role?: string; suggestion?: string };
    attackTree?: { description?: string; costFactors?: { key: string; label: string; weight: number }[] };
}
export type RiskScheme = RiskSchemeV2 | LegacyRiskScheme;
