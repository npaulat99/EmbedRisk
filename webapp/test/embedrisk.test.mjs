import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { resolveLaunchTarget, resolveProjectsDir } from '../bin/embedrisk.js';

const here = dirname(fileURLToPath(import.meta.url));
const webappRoot = resolve(here, '..');

async function reservePort() {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise((resolvePort, rejectPort) => {
        server.once('error', rejectPort);
        server.listen(0, '127.0.0.1', resolvePort);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
    if (!port) throw new Error('Could not reserve an ephemeral port.');
    return port;
}

function waitForOutput(child, matcher, timeoutMs) {
    return new Promise((resolveOut, rejectOut) => {
        let combined = '';
        const onStdout = (chunk) => {
            const text = chunk.toString();
            combined += text;
            if (matcher.test(combined)) {
                cleanup();
                resolveOut(combined);
            }
        };
        const onStderr = (chunk) => {
            combined += chunk.toString();
        };
        const onExit = (code, signal) => {
            cleanup();
            rejectOut(new Error(`Process exited before readiness (code=${code}, signal=${signal}). Output:\n${combined}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            rejectOut(new Error(`Timed out waiting for output. Current output:\n${combined}`));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            child.stdout.off('data', onStdout);
            child.stderr.off('data', onStderr);
            child.off('exit', onExit);
        };

        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        child.on('exit', onExit);
    });
}

async function terminateChild(child) {
    if (child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    const exited = Promise.race([
        once(child, 'exit').then(() => true),
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 3000)),
    ]);
    if (!(await exited)) {
        child.kill('SIGKILL');
        await once(child, 'exit');
    }
}

async function testPrecedence() {
    const cwd = '/tmp/embedrisk-cwd';
    assert.equal(resolveProjectsDir(['/explicit/root'], { TRA_PROJECTS_DIR: '/env/root' }, cwd), '/explicit/root');
    assert.equal(resolveProjectsDir([], { TRA_PROJECTS_DIR: '/env/root' }, cwd), '/env/root');
    assert.equal(resolveProjectsDir([], {}, cwd), cwd);
    assert.equal(resolveProjectsDir(['relative-root'], {}, cwd), '/tmp/embedrisk-cwd/relative-root');
}

async function testLaunchTargetResolution() {
    const tempBase = mkdtempSync(join(tmpdir(), 'embedrisk-resolve-'));
    const containerDir = join(tempBase, 'projects-root');
    const projectDir = join(containerDir, 'device-a');

    try {
        mkdirSync(join(projectDir, '01-project-description'), { recursive: true });
        const container = resolveLaunchTarget([containerDir], {}, '/tmp/unrelated-cwd');
        assert.deepEqual(container, { projectsRoot: containerDir, preselectId: null });

        const single = resolveLaunchTarget([projectDir], {}, '/tmp/unrelated-cwd');
        assert.deepEqual(single, { projectsRoot: containerDir, preselectId: 'device-a' });

        const fromEnv = resolveLaunchTarget([], { TRA_PROJECTS_DIR: projectDir }, '/tmp/unrelated-cwd');
        assert.deepEqual(fromEnv, { projectsRoot: containerDir, preselectId: 'device-a' });
    } finally {
        rmSync(tempBase, { recursive: true, force: true });
    }
}

function scaffoldProject(projectDir, title) {
    mkdirSync(join(projectDir, '01-project-description'), { recursive: true });
    writeFileSync(join(projectDir, '01-project-description', 'project.json'), JSON.stringify({ title }, null, 2));
}

async function testSymlinkStartup() {
    const tempBase = mkdtempSync(join(tmpdir(), 'embedrisk-test-'));
    const symlinkPath = join(tempBase, 'embedrisk');
    const targetRoot = join(tempBase, 'projects-root');
    const singleProjectDir = join(targetRoot, 'device-a');
    const binPath = join(webappRoot, 'bin', 'embedrisk.js');
    const singleProjectId = basename(singleProjectDir);
    let child;

    try {
        scaffoldProject(singleProjectDir, 'Device A');
        symlinkSync(binPath, symlinkPath);
        const port = await reservePort();

        child = spawn(symlinkPath, [singleProjectDir], {
            cwd: tempBase,
            env: {
                ...process.env,
                HOST: '127.0.0.1',
                PORT: String(port),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const output = await waitForOutput(child, /Projects directory:\s*(.+)/, 15000);
        assert.match(output, new RegExp(`Projects directory:\\s*${targetRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

        const projectsRes = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(5000) });
        assert.equal(projectsRes.status, 200);
        const projects = await projectsRes.json();
        assert.ok(Array.isArray(projects));
        assert.ok(projects.some((p) => p.id === singleProjectId));

        const configRes = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(5000) });
        assert.equal(configRes.status, 200);
        const config = await configRes.json();
        assert.deepEqual(config, { preselectProjectId: singleProjectId });

        const schemesRes = await fetch(`http://127.0.0.1:${port}/api/risk-schemes`, { signal: AbortSignal.timeout(5000) });
        assert.equal(schemesRes.status, 200);
        const schemes = await schemesRes.json();
        assert.ok(schemes.schemes.some((scheme) => scheme.id === 'builtin:5x5-exposure'));
        assert.ok(schemes.schemes.some((scheme) => scheme.id === 'builtin:5x5-cost'));
        assert.match(schemes.fingerprints['builtin:5x5-exposure'], /^[a-f0-9]{64}$/);

        const schemeRes = await fetch(`http://127.0.0.1:${port}/api/risk-scheme?id=builtin%3A5x5-exposure`, { signal: AbortSignal.timeout(5000) });
        assert.equal(schemeRes.status, 200);
        assert.equal((await schemeRes.json()).id, 'builtin:5x5-exposure');

        const unknownSchemeRes = await fetch(`http://127.0.0.1:${port}/api/risk-scheme?id=unknown`, { signal: AbortSignal.timeout(5000) });
        assert.equal(unknownSchemeRes.status, 404);

        const fullKbRes = await fetch(`http://127.0.0.1:${port}/api/kb/full`, { signal: AbortSignal.timeout(5000) });
        assert.equal(fullKbRes.status, 200);
        const fullKb = await fullKbRes.json();
        assert.ok(fullKb.riskScheme && Array.isArray(fullKb.riskSchemes));
        assert.ok(fullKb.riskSchemes.some((scheme) => scheme.id === 'builtin:5x5-cost'));
    } finally {
        if (child) await terminateChild(child);
        rmSync(tempBase, { recursive: true, force: true });
    }
}

async function main() {
    await testPrecedence();
    await testLaunchTargetResolution();
    await testSymlinkStartup();
    console.log('embedrisk launcher tests passed');
}

main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
});
