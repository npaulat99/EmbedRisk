# Set up a project

Run **EmbedRisk: New Project** to scaffold a TRA folder. Each step lives in its own JSON file:

| Folder | Content |
|---|---|
| `01-project-description` | Scope, intended use, security-level target |
| `02-assumptions` | Device, system, environment, operational and attacker assumptions |
| `03-system-assets` | Components and assets with CIA + Safety objectives |
| `04-dfd` | Layered data flow diagrams |
| `04b-use-cases` | Optional use-case scenarios |
| `05-requirements` | Security requirements derived from decisions |
| `06-threats` | STRIDE threats with risk ratings |
| `07-attack-trees` | Attack-defence trees |
| `08-countermeasures` | Countermeasures mapped to threats |
| `09-defects` | Review findings |

Projects share the JSON format with the EmbedRisk web app, so either tool can open them.
