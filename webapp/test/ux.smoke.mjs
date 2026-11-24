import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createUxHarness, stopServer } from './lib/ux-harness.mjs';

const harness = await createUxHarness();
const { baseUrl, server } = harness;

let browser;
try {
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
    await page.setViewportSize({ width: 390, height: 900 });
    const editorDimensions = await page.locator('.layout > .main').evaluate((main) => ({
        clientWidth: main.clientWidth,
        scrollWidth: main.scrollWidth,
    }));
    assert.ok(editorDimensions.scrollWidth <= editorDimensions.clientWidth, `Threat editor overflows its workspace: ${JSON.stringify(editorDimensions)}`);

    await stopServer(server);
    await page.waitForFunction(() => document.querySelector('.conn')?.textContent?.includes('Offline, nothing unsaved'), { timeout: 10000 });
    const offlineLabel = await page.locator('.conn').getAttribute('aria-label');
    assert.match(offlineLabel || '', /Offline, nothing unsaved/i);

    assert.deepEqual(nativeDialogs, [], `Unexpected native browser dialogs: ${nativeDialogs.join(', ')}`);
    assert.deepEqual(pageErrors, [], `Browser page errors: ${pageErrors.join('; ')}`);
    console.log('UX smoke checks passed: 25 viewport/view combinations, mobile threat editor, offline status, settings focus, hash history, refresh deep link, no native dialogs.');
} finally {
    await browser?.close();
    await stopServer(server);
    await harness.cleanup();
}