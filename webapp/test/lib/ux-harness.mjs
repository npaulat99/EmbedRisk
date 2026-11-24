import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const webappRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function reservePort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    if (!port) throw new Error('Could not reserve a port for the UX test.');
    return port;
}

async function waitForServer(url, child) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Webapp server exited early with code ${child.exitCode}.`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return;
        } catch { }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for the webapp server at ${url}.`);
}

export async function stopServer(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
    ]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}

export async function createUxHarness({ projects = [{ id: 'RL-100', sourceId: 'RL-100' }] } = {}) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'embedrisk-ux-'));
    const projectsDir = join(temporaryRoot, 'projects');
    await Promise.all(projects.map(({ id, sourceId }) => cp(
        join(webappRoot, 'projects', sourceId),
        join(projectsDir, id),
        { recursive: true },
    )));

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let server;
    const startServer = async () => {
        server = spawn(process.execPath, ['server/src/index.js'], {
            cwd: webappRoot,
            env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TRA_PROJECTS_DIR: projectsDir },
            stdio: 'ignore',
        });
        await waitForServer(baseUrl, server);
        return server;
    };

    try {
        await startServer();
    } catch (error) {
        await stopServer(server);
        await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
    }

    return {
        baseUrl,
        projectsDir,
        get server() { return server; },
        startServer,
        stopServer: async () => stopServer(server),
        cleanup: async () => {
            await stopServer(server);
            await rm(temporaryRoot, { recursive: true, force: true });
        },
    };
}