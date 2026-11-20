# How To: Threat and Risk Assessment (TRA) with EmbedRisk

This guide explains:

- what TRA is,
- what to prepare before modeling,
- how to run a practical TRA workflow in EmbedRisk,
- where to read more without getting buried in references.

## 1. What TRA is (in plain terms)

Threat modeling is a structured process for identifying, analyzing, and addressing potential security threats to a system.

In practice, this aligns with the four core questions from the Threat Modeling Manifesto:

1. What are we working on?
2. What can go wrong?
3. What are we going to do about it?
4. Did we do a good job?

For embedded OT field devices, these questions translate to concrete engineering work:

- Understand the device architecture, boundaries, interfaces, protocols, and system role.
- Identify realistic threats and attacker paths for the specific device context.
- Define and prioritize mitigations and security requirements.
- Verify quality and completeness with traceable, auditable links across artifacts.

TRA in EmbedRisk is designed to keep this chain explicit and reviewable:

- asset -> threat -> risk rating -> requirement -> countermeasure -> residual risk.

For embedded OT devices, TRA is not only an IT exercise. It includes:

- device behavior in industrial environments,
- long lifecycle constraints,
- safety and availability consequences,
- realistic attacker capabilities and access paths.

A good TRA is repeatable and traceable so teams can justify decisions and revisit them after design changes.

## 2. What to do before modeling in EmbedRisk

Do this preparation first. It will make the actual modeling much faster and more consistent.

### Scope and context

- Define the product boundary (what is in scope and what is not).
- Decide the lifecycle phase (concept, design, update, maintenance).
- Clarify intended use and reasonably foreseeable use.

### System input data

- Architecture inputs: block diagram, interfaces, trust zones, external dependencies.
- Asset inventory: safety-critical functions, sensitive data, critical services.
- Third-party elements: libraries, firmware dependencies, external modules.

### Security baseline inputs

- Existing controls already implemented (secure boot, authentication, hardening, etc.).
- Known constraints (legacy protocol requirements, hardware limits, update limitations).
- Applicable internal standards and target assurance/security level.

### Team and process setup

- Name the participants (engineering + security + system owner).
- Define reviewer and decision owner for accepted residual risk.
- Decide how evidence will be tracked (tickets, tests, verification artifacts).

### Knowledge base readiness

- Start with [knowledge-base/README.md](../knowledge-base/README.md).
- Align threat and countermeasure catalog entries with your domain language.
- Add organization-specific threat patterns where possible.

## 3. TRA workflow in EmbedRisk

Use the same step order for every project to keep assessments comparable.

### Step 01: Project description

Capture product identity, scope, assumptions about operating context, and target security level.

Output: clear model boundary and assessment goal.

### Step 02: Assumptions

Document attacker profiles and environmental assumptions. Avoid generic attackers only; describe realistic access and capability.

The target SL-C selects the managed attacker profile; see [Target SL-C and the modelled attacker](../README.md#target-sl-c-and-the-modelled-attacker).

Output: explicit threat plausibility basis.

### Step 03: System assets

Model components, interfaces, trust boundaries, and assets with CIA + Safety relevance.

Output: consistent asset and architecture map for the threat analysis.

### Step 04: DFD

Create the layered data flow model. Focus on actual communication paths and boundary crossings.

Output: attack surface map used by threats and risk scoring.

### Step 05: Requirements

Derive security requirements from threat scenarios and planned risk treatment.

Output: testable, traceable requirements linked to threats and controls.

### Step 06: Threats

Identify threats (typically STRIDE-oriented), link them to affected elements, and rate initial risk (Likelihood x Impact).

Use the scheme selected for the project: it defines valid likelihood and impact values, their
criteria, and how each pair is classified. Do not assume every project uses a 1-5 scale or a fixed
numeric high-risk threshold. To add a local scheme, follow the [risk-scheme guide](RISK-SCHEMES.md).

Output: prioritized threat list with rationale.

### Step 07: Attack trees (optional but recommended for critical threats)

Use attack trees where a threat is complex, multi-stage, or safety-critical.

Output: deeper attacker-path analysis and stronger mitigation reasoning.

### Step 08: Countermeasures

Assign controls to threats, define implementation status, and estimate residual risk.

Output: actionable mitigation plan with residual-risk visibility.

### Step 09: Defects and vulnerabilities

Track known vulnerabilities, open defects, and lifecycle findings that affect the risk picture.

Output: operationally usable backlog and evidence for reassessment.

### Step 10: Reporting and review

Generate the report, review unresolved high risks, and document acceptance decisions with owner and rationale.

Output: auditable TRA baseline for release or milestone decisions.

## 4. Practical quality checks

Before closing a TRA iteration, verify:

- Every risk at or above the active scheme's `highLevel` has a treatment decision.
- Threats have clear links to assets and affected components.
- Requirements are testable and mapped to controls.
- Assumptions are explicit and dated (so they can be revisited later).

## 5. When to revisit the TRA

Re-run or update the model when:

- architecture changes,
- new interfaces are added,
- third-party components change,
- major vulnerabilities are disclosed,
- product usage context changes.

For long-lived OT products, periodic reassessment is part of normal engineering, not a one-time activity.

## 6. Further reading

Start with these, then go deeper only as needed:

- Threat Modeling Manifesto: https://www.threatmodelingmanifesto.org
- Adam Shostack (resources and articles): https://shostack.org/resources/
- IEC 62443 overview (ISA): https://www.isa.org/standards-and-publications/isa-standards/isa-iec-62443-series-of-standards
- Attacker scale used by EmbedRisk: [Target SL-C and the modelled attacker](../README.md#target-sl-c-and-the-modelled-attacker)

## 7. Suggested operating rhythm

- Run a lightweight TRA early in design.
- Expand depth before implementation freeze.
- Reassess at major release gates and significant change events.

Consistent cadence is more valuable than one very detailed model done too late.
