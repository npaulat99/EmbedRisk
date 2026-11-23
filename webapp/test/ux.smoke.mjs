import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const webappRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sampleProject = join(webappRoot, 'projects', 'RL-100');

async function reservePort() {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    if (!port) throw new Error('Could not reserve a port for the UX smoke test.');
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

async function stopServer(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
    ]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'embedrisk-ux-'));
const projectsDir = join(temporaryRoot, 'projects');
const temporaryProject = join(projectsDir, 'RL-100');
await cp(sampleProject, temporaryProject, { recursive: true });

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: webappRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TRA_PROJECTS_DIR: projectsDir },
    stdio: 'ignore',
});

let browser;
try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const nativeDialogs = [];
    const pageErrors = [];
    page.on('dialog', (dialog) => {
        nativeDialogs.push(dialog.type());
        void dialog.dismiss();
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`${baseUrl}/#/project`);
    await page.getByRole('link', { name: /Project Scope/ }).waitFor();
    const projectSelect = page.locator('header select.project-select');
    await projectSelect.selectOption('RL-100');

    const views = [
        { route: 'project', ready: () => page.getByRole('heading', { name: 'Project', exact: true }) },
        { route: 'system', ready: () => page.getByRole('heading', { name: /System definition & assets/ }) },
        { route: 'dfd', ready: () => page.locator('.dfd-canvas') },
        { route: 'threats', ready: () => page.getByRole('heading', { name: 'Threats & risk' }) },
        { route: 'dashboard', ready: () => page.getByRole('heading', { name: 'Compliance dashboard' }) },
    ];
    const widths = [320, 390, 768, 1024, 1440];
    for (const view of views) {
        await page.evaluate((route) => { window.location.hash = `#/${route}`; }, view.route);
        await view.ready().waitFor();
        for (const width of widths) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
            const dimensions = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
            assert.ok(dimensions.scrollWidth <= dimensions.innerWidth, `${view.route} overflows at ${width}px: ${JSON.stringify(dimensions)}`);
        }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { window.location.hash = '#/project'; });
    await page.getByRole('heading', { name: 'Project', exact: true }).waitFor();
    const settingsTrigger = page.getByRole('button', { name: 'Project settings' });
    await settingsTrigger.click();
    const activeInside = await page.locator('dialog[open]').evaluate((dialog) => dialog.contains(document.activeElement));
    assert.equal(activeInside, true, 'Settings must receive focus when opened.');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('dialog[open]').evaluate((dialog) => dialog.contains(document.activeElement)), true, 'Tab must remain inside Settings.');
    await page.getByRole('button', { name: 'Close dialog' }).last().click();
    assert.equal(await settingsTrigger.evaluate((button) => document.activeElement === button), true, 'Closing Settings must restore focus.');

    await page.getByRole('link', { name: /Dashboard/ }).click();
    const threatTable = page.locator('.tbl-scroll').filter({ has: page.locator('caption', { hasText: /^Threats$/ }) });
    await threatTable.locator('a.jump').first().click();
    const deepLink = await page.evaluate(() => window.location.hash);
    assert.match(deepLink, /^#\/threats\/T-/);
    await page.getByText(/^Editing T-/).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Compliance dashboard' }).waitFor();
    await page.goForward();
    await page.getByText(/^Editing T-/).waitFor();
    await page.reload();
    await page.getByText(/^Editing T-/).waitFor();

    assert.deepEqual(nativeDialogs, [], `Unexpected native browser dialogs: ${nativeDialogs.join(', ')}`);
    assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('; ')}`);
    console.log('UX smoke checks passed: 25 viewport/view combinations, settings focus, hash history, refresh deep link, no native dialogs.');
} finally {
    await browser?.close();
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
}