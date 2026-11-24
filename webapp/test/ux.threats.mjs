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
        await page.evaluate(() => { window.location.hash = '#/threats'; });
        await page.getByRole('heading', { name: 'Threats & risk' }).waitFor();

        const knowledgeSearch = page.getByRole('searchbox', { name: /Search knowledge base/ });
        const recordSearch = page.getByRole('searchbox', { name: /Search threats/ });
        const knowledgeCount = page.locator('.kb-threat-picker .filter-count');
        const recordCount = page.locator('.threat-record-search .filter-count');
        const sort = page.getByRole('combobox', { name: 'Sort by' });

        await sort.selectOption('name');
        const allKnowledge = await knowledgeCount.innerText();
        const allRecords = await recordCount.innerText();
        assert.match(allRecords, /^20 of 20$/);

        await knowledgeSearch.fill('HART');
        const filteredKnowledge = await knowledgeCount.innerText();
        assert.notEqual(filteredKnowledge, allKnowledge, 'Catalogue search should update its own result count.');
        assert.ok(Number(filteredKnowledge.split(' of ')[0]) > 0, 'The HART catalogue query should return results.');

        await recordSearch.fill('T-1');
        const filteredRecords = await recordCount.innerText();
        assert.notEqual(filteredRecords, allRecords, 'Record search should update its own result count.');
        assert.equal(await sort.inputValue(), 'name');

        await page.getByRole('button', { name: 'Clear knowledge-base search' }).click();
        assert.equal(await knowledgeCount.innerText(), allKnowledge);
        assert.equal(await recordSearch.inputValue(), 'T-1', 'Clearing catalogue search must preserve the record filter.');
        assert.equal(await recordCount.innerText(), filteredRecords);
        assert.equal(await sort.inputValue(), 'name');

        await page.getByRole('button', { name: 'Edit' }).first().click();
        const editLabel = await page.getByText(/^Editing T-/).innerText();
        await page.getByRole('button', { name: 'Back to list' }).click();
        assert.equal(await recordSearch.inputValue(), 'T-1', 'Returning from edit must preserve the record query.');
        assert.equal(await recordCount.innerText(), filteredRecords);
        assert.equal(await sort.inputValue(), 'name');
        assert.ok(editLabel.startsWith('Editing T-'));

        await recordSearch.fill('zz-no-match');
        const noMatch = page.locator('.empty-state [role="status"]');
        await noMatch.waitFor();
        assert.match(await noMatch.innerText(), /zz-no-match/);
        await page.getByRole('button', { name: 'Clear search' }).click();
        assert.equal(await recordCount.innerText(), allRecords);
        assert.equal(await page.locator('.itemcard.collapsed').count(), 20);

        const dimensions = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(dimensions.scrollWidth <= dimensions.innerWidth, `Threat workflow overflows at ${width}px: ${JSON.stringify(dimensions)}`);
        await context.close();
    }
    console.log('Threat filter/edit checks passed at 1440px and 390px.');
} finally {
    await browser?.close();
    await harness.cleanup();
}