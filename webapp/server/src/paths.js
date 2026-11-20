// Central path resolution for the TRA web application backend.
// The projects directory is configurable so the same server can drive either the
// self-contained example projects shipped with the webapp or an external project root.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Root of the tra-webapp package (…/tra-webapp). */
export const webappRoot = resolve(here, '..', '..');

/** Folder that holds one sub-folder per TRA project. Override with TRA_PROJECTS_DIR. */
export const projectsDir = process.env.TRA_PROJECTS_DIR
    ? resolve(process.env.TRA_PROJECTS_DIR)
    : join(webappRoot, 'projects');

export const assetsDir = join(webappRoot, '.assets');
export const knowledgeBaseDir = join(assetsDir, 'knowledge-base');
export const riskSchemePath = join(knowledgeBaseDir, 'risk-scheme.json');
export const localRiskSchemesDir = join(webappRoot, '.local', 'risk-schemes');
export const builtinRiskSchemePaths = Object.freeze({
    'builtin:5x5-exposure': join(knowledgeBaseDir, 'risk-scheme-5x5-exposure.json'),
    'builtin:5x5-cost': join(knowledgeBaseDir, 'risk-scheme-5x5-cost.json'),
});
export const fieldLibraryPath = join(knowledgeBaseDir, 'field-device-library.json');
export const bugBarPath = join(knowledgeBaseDir, 'bug-bar.json');

/** Built client (served in production). In dev the Vite server is used instead. */
export const clientDist = join(webappRoot, 'client', 'dist');

export const PORT = Number(process.env.PORT || 4317);
