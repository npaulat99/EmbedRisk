import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createUxHarness } from './lib/ux-harness.mjs';

const harness = await createUxHarness();
let browser;

try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
        const page = await context.newPage();
        await page.goto(`${harness.baseUrl}/#/project`);
        await page.getByRole('heading', { name: 'Project', exact: true }).waitFor();
        await page.locator('header select.project-select').selectOption('RL-100');
        await page.evaluate(() => { window.location.hash = '#/dfd'; });
        await page.locator('.dfd-canvas').waitFor();

        const existingNodes = await page.locator('.react-flow__node').count();
        if (width < 720) await page.getByRole('button', { name: 'Add element' }).click();
        await page.getByRole('button', { name: '+ Process' }).click();
        await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length > count, existingNodes);

        const connectToggle = page.getByRole('button', { name: 'Connect flows' });
        await connectToggle.click();
        assert.equal(await page.getByRole('button', { name: 'Exit connections' }).getAttribute('aria-pressed'), 'true');

        await page.getByRole('button', { name: 'Elements' }).click();
        await page.getByRole('heading', { name: 'Add data flow' }).waitFor();
        const source = page.getByRole('combobox', { name: 'Flow source' });
        const target = page.getByRole('combobox', { name: 'Flow target' });
        await source.selectOption('N-DEV');
        await target.selectOption('N-EXT-CTRL');
        const flowLabel = page.getByRole('textbox', { name: 'Flow label' });
        await flowLabel.fill(`UX flow ${width}`);
        const rowCount = await page.locator('.dfd-elements tbody tr').count();
        await page.getByRole('button', { name: 'Add flow' }).click();
        await page.waitForFunction((count) => document.querySelectorAll('.dfd-elements tbody tr').length > count, rowCount);
        const newFlowRow = page.getByRole('row').filter({ has: page.getByText('Data flow', { exact: true }) }).last();
        const flowId = await newFlowRow.locator('th[scope="row"]').innerText();
        assert.equal(await page.getByRole('textbox', { name: `Label for ${flowId}` }).inputValue(), `UX flow ${width}`);

        const nodeNameInputs = await page.getByRole('textbox', { name: /Name for N-/ }).all();
        let newNodeNameInput;
        for (const input of nodeNameInputs) {
            if (await input.inputValue() === 'New process') {
                newNodeNameInput = input;
                break;
            }
        }
        assert.ok(newNodeNameInput, 'The DFD Elements table should expose the newly added process by its name field.');
        const newNodeName = await newNodeNameInput.getAttribute('aria-label');
        const newNodeRow = page.getByRole('row').filter({ has: page.getByRole('textbox', { name: newNodeName }) });
        await newNodeRow.getByRole('button', { name: 'Inspector' }).click();
        if (width < 1280) {
            const inspector = page.locator('.inspector-drawer[open]');
            await inspector.waitFor();
            await inspector.getByRole('heading', { name: 'Inspector' }).waitFor();
            await inspector.getByRole('button', { name: 'Close dialog' }).click();
        } else {
            await page.locator('.layout > .inspector').waitFor();
        }

        await page.getByRole('button', { name: 'Overview' }).click();
        await page.locator('.dfd-overview').waitFor();
        await page.getByRole('button', { name: 'Canvas' }).click();
        await page.locator('.dfd-canvas').waitFor();

        const dimensions = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(dimensions.scrollWidth <= dimensions.innerWidth, `DFD task path overflows at ${width}px: ${JSON.stringify(dimensions)}`);
        await context.close();
    }
    console.log('DFD task checks passed at 1440px and 390px using named controls.');
} finally {
    await browser?.close();
    await harness.cleanup();
}