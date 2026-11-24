import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { webappRoot } from './lib/ux-harness.mjs';

const testDir = join(webappRoot, 'test');
const tests = (await readdir(testDir))
    .filter((name) => /^ux\.(?!capture\.)[^/]+\.mjs$/.test(name))
    .sort();

for (const test of tests) {
    console.log(`\n> ${test}`);
    const result = spawnSync(process.execPath, [join(testDir, test)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

if (!tests.length) console.log('No UX tests found.');