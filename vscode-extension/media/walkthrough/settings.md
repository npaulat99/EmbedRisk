# Tune project settings

Open **Settings** and search for `embedrisk.project` to configure:

- The project's risk scheme and acceptable level
- Risk-scoring method for legacy built-in project compatibility
- Cost-factor weights and access probabilities
- Likelihood probability thresholds
- Acceptable risk and rigorous mode
- STRIDE boundary analysis in reports

Project scoring settings are resource-scoped, so each workspace folder can use its own values. The
`embedrisk.riskSchemeDirectory` setting is machine-scoped; when empty, the extension uses its
global-storage `risk-schemes` folder. For instructions on creating and validating a local scheme,
see the [risk-scheme guide](../../../docs/RISK-SCHEMES.md).
