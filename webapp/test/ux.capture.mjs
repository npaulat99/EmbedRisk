import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createUxHarness, webappRoot } from './lib/ux-harness.mjs';

const label = process.argv[2];
if (!label || !/^[a-z0-9][a-z0-9-]*$/i.test(label)) {
    throw new Error('Pass a simple capture label, for example: npm run capture:ux -- baseline-d3b2365');
}

const outputDir = resolve(webappRoot, '..', 'temp', 'webapp-ui-ux-evidence', label);
const emptyProjectId = 'UX-EMPTY';
const widths = [1440, 390];
const themes = ['light', 'dark'];
const screenshots = [];

async function prepareEmptyProject(projectDir) {
    const projectPath = join(projectDir, '01-project-description', 'project.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.title = 'Empty UX project';
    project.projectId = emptyProjectId;
    if (project.device) project.device.name = 'Empty UX project';
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await writeFile(join(projectDir, '06-threats', 'threats.json'), `${JSON.stringify({ threats: [] }, null, 2)}\n`);
}

async function settle(page) {
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function gotoView(page, route, ready) {
    await page.evaluate((nextRoute) => { window.location.hash = `#/${nextRoute}`; }, route);
    await ready.waitFor();
    await settle(page);
}

async function capture(page, name, description) {
    const path = join(outputDir, `${name}.png`);
    await mkdir(dirname(path), { recursive: true });
    await settle(page);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    screenshots.push({ file: `${name}.png`, description });
}

const harness = await createUxHarness({
    projects: [
        { id: 'RL-100', sourceId: 'RL-100' },
        { id: emptyProjectId, sourceId: 'RL-100' },
    ]
});
let browser;

try {
    await prepareEmptyProject(join(harness.projectsDir, emptyProjectId));
    browser = await chromium.launch({ headless: true });

    for (const theme of themes) {
        const context = await browser.newContext({
            viewport: { width: widths[0], height: 900 },
            colorScheme: theme,
            reducedMotion: 'reduce',
            locale: 'en-GB',
            timezoneId: 'UTC',
        });
        const page = await context.newPage();
        await page.clock.install({ time: new Date('2026-11-23T12:00:00Z') });
        await page.goto(`${harness.baseUrl}/#/project`);
        await page.getByRole('heading', { name: 'Project', exact: true }).waitFor();

        for (const width of widths) {
            await page.setViewportSize({ width, height: 900 });
            await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
            await page.locator('header select.project-select').selectOption('RL-100');
            await gotoView(page, 'project', page.getByRole('heading', { name: 'Project', exact: true }));
            await capture(page, `project-${width}-${theme}`, `Project screen; populated RL-100; ${width}px; ${theme}.`);

            await gotoView(page, 'threats', page.getByRole('heading', { name: 'Threats & risk' }));
            await page.locator('.itemcard.collapsed').first().waitFor();
            await capture(page, `threats-populated-${width}-${theme}`, `Populated Threats list; RL-100; ${width}px; ${theme}.`);

            await page.getByRole('searchbox', { name: 'Search threats' }).fill('zz-no-match');
            await page.locator('.empty-state [role="status"]').waitFor();
            await capture(page, `threats-no-match-${width}-${theme}`, `No-match threat filter; ${width}px; ${theme}.`);
            await page.getByRole('button', { name: 'Clear search' }).click();

            await page.getByRole('button', { name: 'Edit' }).first().click();
            await page.getByText(/^Editing T-/).waitFor();
            await capture(page, `threats-edit-${width}-${theme}`, `Threat editor; RL-100; ${width}px; ${theme}.`);
            await page.getByRole('button', { name: 'Back to list' }).click();

            await page.locator('header select.project-select').selectOption(emptyProjectId);
            await gotoView(page, 'threats', page.getByRole('heading', { name: 'Threats & risk' }));
            await page.getByRole('heading', { name: 'No threats yet' }).waitFor();
            await capture(page, `threats-empty-${width}-${theme}`, `Zero-threat project; ${width}px; ${theme}.`);
            await page.locator('header select.project-select').selectOption('RL-100');

            await gotoView(page, 'dfd', page.locator('.dfd-canvas'));
            await capture(page, `dfd-canvas-${width}-${theme}`, `DFD Canvas mode; ${width}px; ${theme}.`);
            const nodePicker = page.locator('.dfd-nav select');
            const nodeId = await nodePicker.locator('option').nth(1).getAttribute('value');
            assert.ok(nodeId, 'The DFD node picker should contain at least one selectable node.');
            await nodePicker.selectOption(nodeId);
            if (width < 1024) {
                const inspectorToggle = page.getByRole('button', { name: 'Inspector' });
                if (await inspectorToggle.count()) await inspectorToggle.click();
            }
            await capture(page, `dfd-selected-inspector-${width}-${theme}`, `Selected DFD element and Inspector; ${width}px; ${theme}.`);
            const inspectorDrawer = page.locator('.inspector-drawer[open]');
            if (await inspectorDrawer.count()) await inspectorDrawer.getByRole('button', { name: 'Close dialog' }).click();

            await page.getByRole('button', { name: 'Connect flows' }).click();
            await capture(page, `dfd-connections-${width}-${theme}`, `DFD Connections mode; ${width}px; ${theme}.`);
            await page.getByRole('button', { name: 'Overview' }).click();
            await capture(page, `dfd-overview-${width}-${theme}`, `DFD Overview mode; ${width}px; ${theme}.`);
            await page.getByRole('button', { name: 'Elements' }).click();
            await capture(page, `dfd-elements-${width}-${theme}`, `DFD Elements mode; ${width}px; ${theme}.`);

            await gotoView(page, 'dashboard', page.getByRole('heading', { name: 'Compliance dashboard' }));
            await capture(page, `dashboard-${width}-${theme}`, `Dashboard with populated RL-100 data; ${width}px; ${theme}.`);

            await gotoView(page, 'review', page.getByRole('heading', { name: 'Review & report' }));
            await capture(page, `review-${width}-${theme}`, `Review and report screen; RL-100; ${width}px; ${theme}.`);
        }

        await context.close();
    }

    if (label === 'final') {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            colorScheme: 'light',
            reducedMotion: 'reduce',
            locale: 'en-GB',
            timezoneId: 'UTC',
        });
        const page = await context.newPage();
        await page.clock.install({ time: new Date('2026-11-23T12:00:00Z') });
        await page.goto(`${harness.baseUrl}/#/project`);
        await page.getByRole('heading', { name: 'Project', exact: true }).waitFor();
        await page.locator('header select.project-select').selectOption('RL-100');
        await gotoView(page, 'threats', page.getByRole('heading', { name: 'Threats & risk' }));
        const addThreat = page.getByRole('button', { name: '+ Threat' });
        await addThreat.focus();
        await capture(page, 'threats-focus-1440-light', 'Threats primary action focused by keyboard; 1440px; light.');
        await addThreat.hover();
        await capture(page, 'threats-hover-1440-light', 'Threats primary action hovered; 1440px; light.');

        await gotoView(page, 'project', page.getByRole('heading', { name: 'Project', exact: true }));
        const title = page.getByRole('textbox', { name: 'Project title' });
        const originalTitle = await title.inputValue();
        await title.fill(`${originalTitle} temporary`);
        await page.waitForFunction(() => document.querySelector('.conn')?.textContent?.trim() === 'Saving');
        await capture(page, 'saving-1440-light', 'Project title edit in the debounce/saving state; 1440px; light.');
        await title.fill(originalTitle);
        await page.waitForFunction(() => document.querySelector('.conn')?.textContent?.trim() === 'Saved');
        await context.close();

        const saveTest = spawnSync(process.execPath, [join(webappRoot, 'test', 'ux.save.mjs')], {
            cwd: webappRoot,
            env: { ...process.env, UX_CAPTURE_DIR: outputDir },
            stdio: 'inherit',
        });
        if (saveTest.error) throw saveTest.error;
        if (saveTest.status !== 0) throw new Error(`Save-state capture failed with exit code ${saveTest.status}.`);

        for (const file of await readdir(outputDir)) {
            if (!file.endsWith('.png') || screenshots.some((shot) => shot.file === file)) continue;
            screenshots.push({ file, description: file.replace(/\.png$/, '').replaceAll('-', ' ') });
        }
    }

    assert.ok(screenshots.length > 0, 'No screenshots were captured.');
    const checklist = [
        `# UX Screenshot Review: ${label}`,
        '',
        `- Browser: Chromium ${browser.version()} (Playwright; not Edge certification)`,
        '- OS: Linux workspace runtime',
        '- Data: isolated temporary copy of RL-100 plus an empty-threat variant',
        '- Motion: reduced',
        '- Clock: 2026-11-23 12:00 UTC',
        '',
        '| Screenshot | State | Review (intended / neutral / regression) | Issue / notes |',
        '|---|---|---|---|',
        ...screenshots.map((shot) => `| ${shot.file} | ${shot.description} |  |  |`),
        '',
        ...(label === 'final' ? [
            '## Grouped Visual Review',
            '',
            '| Screen/state family | Review | Issue / notes |',
            '|---|---|---|',
            '| Project, 390/1440, light/dark |  |  |',
            '| Threats populated, 390/1440, light/dark |  |  |',
            '| Threats empty/no-match/edit, 390/1440, light/dark |  |  |',
            '| DFD Canvas/Overview/Elements/connection/selection/Inspector |  |  |',
            '| Dashboard and Review, 390/1440, light/dark |  |  |',
            '| Focus, hover, saving, offline pending, conflict, resolved |  |  |',
            '',
        ] : []),
        'Screenshots support human visual review; they are not pixel-diff pass/fail tests.',
    ].join('\n');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'checklist.md'), `${checklist}\n`);
    console.log(`Captured ${screenshots.length} screenshots to ${outputDir}`);
} finally {
    await browser?.close();
    await harness.cleanup();
}