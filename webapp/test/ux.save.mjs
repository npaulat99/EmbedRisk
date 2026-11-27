import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createUxHarness } from './lib/ux-harness.mjs';

const harness = await createUxHarness({
    projects: [
        { id: 'RL-100', sourceId: 'RL-100' },
        { id: 'RL-200', sourceId: 'RL-100' },
    ]
});
const captureDir = process.env.UX_CAPTURE_DIR || null;
let browser;

async function captureState(page, name) {
    if (!captureDir) return;
    await mkdir(captureDir, { recursive: true });
    await page.screenshot({ path: join(captureDir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

try {
    browser = await chromium.launch({ headless: true });
    const isolatedContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const localPage = await isolatedContext.newPage();
    let allowWebSocket = true;
    let activeRoute = null;
    await localPage.routeWebSocket('**/ws', (route) => {
        if (!allowWebSocket) {
            activeRoute = route;
            route.close({ code: 1001, reason: 'Simulated offline tab' });
            return;
        }
        activeRoute = route;
        const server = route.connectToServer();
        route.onMessage((message) => server.send(message));
        server.onMessage((message) => route.send(message));
    });
    await localPage.goto(`${harness.baseUrl}/#/project`);
    await localPage.getByRole('heading', { name: 'Project', exact: true }).waitFor();
    await localPage.locator('header select.project-select').selectOption('RL-100');
    assert.equal(await localPage.getByRole('button', { name: 'Decide later' }).count(), 0, 'Conflict actions must not leak outside the closed dialog.');
    const localTitle = localPage.getByRole('textbox', { name: 'Project title' });
    await harness.stopServer();
    await localPage.waitForFunction(() => document.querySelector('.conn')?.textContent?.includes('Offline, nothing unsaved'));
    await localTitle.fill('Recovered local version');
    await localPage.getByText(/Offline, 1 change held in this tab only/).waitFor();
    await captureState(localPage, 'offline-pending-1440-light');
    await harness.startServer();
    await localPage.waitForFunction(() => document.querySelector('.conn')?.textContent?.trim() === 'Saved', { timeout: 15000 });
    let persisted = await (await fetch(`${harness.baseUrl}/api/projects/RL-100`)).json();
    assert.equal(persisted.project.title, 'Recovered local version', 'Reconnect should retry the held edit and persist it.');

    const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const peerPage = await peerContext.newPage();
    await peerPage.goto(`${harness.baseUrl}/#/project`);
    await peerPage.getByRole('heading', { name: 'Project', exact: true }).waitFor();
    await peerPage.locator('header select.project-select').selectOption('RL-100');
    await peerPage.getByText('Saved', { exact: true }).waitFor();
    const projectTitle = peerPage.getByRole('textbox', { name: 'Project title' });

    allowWebSocket = false;
    activeRoute?.close({ code: 1001, reason: 'Simulated second offline interval' });
    await localPage.getByText('Offline, nothing unsaved').waitFor();
    const localTitleAfterRecovery = localPage.getByRole('textbox', { name: 'Project title' });
    await localTitleAfterRecovery.fill('Local pending version');
    await localPage.getByText(/Offline, 1 change held in this tab only/).waitFor();
    await projectTitle.fill('Remote winner');
    await peerPage.getByText('Saved', { exact: true }).waitFor();

    assert.equal(await localPage.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    }), true, 'An unacknowledged edit must arm the beforeunload warning.');

    await localPage.locator('header select.project-select').selectOption('RL-200');
    const switchDialog = localPage.getByRole('dialog', { name: 'Unsynced changes' });
    await switchDialog.waitFor();
    await captureState(localPage, 'project-switch-pending-1440-light');
    assert.equal(await localPage.locator('header select.project-select').inputValue(), 'RL-100', 'Project selection must not change before pending edits are resolved.');
    await switchDialog.getByRole('button', { name: 'Stay here' }).click();

    allowWebSocket = true;
    activeRoute?.close({ code: 1001, reason: 'Reconnect local tab' });
    const conflictDialog = localPage.getByRole('dialog', { name: 'Sync conflict: Project' });
    await conflictDialog.waitFor({ timeout: 15000 });
    const conflictText = await conflictDialog.innerText();
    assert.match(conflictText, /group includes/);
    assert.equal(await conflictDialog.getByRole('button', { name: 'Decide later' }).count(), 1);
    assert.match(conflictText, /Project/);
    assert.match(conflictText, /System & Assets/);
    assert.match(conflictText, /Data Flow Diagram/);
    assert.equal(await localTitleAfterRecovery.inputValue(), 'Local pending version', 'Local pending text must remain intact while conflict is unresolved.');
    await captureState(localPage, 'sync-conflict-1440-light');

    await conflictDialog.getByRole('button', { name: 'Decide later' }).click();
    await localPage.getByRole('button', { name: 'Review conflict' }).click();
    const reopenedConflict = localPage.getByRole('dialog', { name: 'Sync conflict: Project' });
    await reopenedConflict.waitFor();
    await reopenedConflict.getByRole('button', { name: 'Use other version' }).click();
    await peerPage.waitForFunction(() => document.querySelector('.conn')?.textContent?.trim() === 'Saved');
    await localPage.waitForFunction(() => document.querySelector('.conn')?.textContent?.trim() === 'Saved');
    assert.equal(await localPage.getByRole('textbox', { name: 'Project title' }).inputValue(), 'Remote winner');
    persisted = await (await fetch(`${harness.baseUrl}/api/projects/RL-100`)).json();
    assert.equal(persisted.project.title, 'Remote winner', 'Conflict resolution must not overwrite the remote file.');
    await captureState(localPage, 'sync-resolved-1440-light');

    allowWebSocket = false;
    activeRoute?.close({ code: 1001, reason: 'Simulated discard interval' });
    await localPage.getByText('Offline, nothing unsaved').waitFor();
    await localPage.getByRole('textbox', { name: 'Project title' }).fill('Explicitly discarded version');
    await localPage.getByText(/Offline, 1 change held in this tab only/).waitFor();
    await localPage.locator('header select.project-select').selectOption('RL-200');
    const discardDialog = localPage.getByRole('dialog', { name: 'Unsynced changes' });
    await discardDialog.waitFor();
    await discardDialog.getByRole('button', { name: 'Discard unsynced changes and switch' }).click();
    await localPage.waitForFunction(() => document.querySelector('header select.project-select')?.value === 'RL-200');
    assert.equal(await localPage.getByRole('textbox', { name: 'Project title' }).inputValue(), 'RL-100 Radar Level Sensor');
    persisted = await (await fetch(`${harness.baseUrl}/api/projects/RL-100`)).json();
    assert.equal(persisted.project.title, 'Remote winner', 'Explicit discard must not write the pending version to disk.');

    await isolatedContext.close();
    await peerContext.close();
    console.log('Save UX checks passed: retry after server restart, unload warning, guarded switch, two-tab conflict, explicit remote acceptance/discard.');
} finally {
    await browser?.close();
    await harness.cleanup();
}