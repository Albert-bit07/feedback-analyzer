const { test, expect } = require('@playwright/test');

test('submit, process, correct, resolve and reopen through the real triage page', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/triage');
  const title = 'Browser report <img src=x onerror="window.injected=true">';
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Description', { exact: true }).fill('The submit button needs a clearer error message.');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('#message')).toContainText('saved. Analysis is pending.');
  const card = page.locator('article').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await expect(card.locator('img')).toHaveCount(0);
  await expect(card).toContainText('Analysis: pending');
  const rows = await (await request.get('/api/triage')).json();
  const report = rows.find(row => row.title === title);
  expect(report).toBeTruthy();
  expect((await request.post('/__test/process')).ok()).toBe(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card).toContainText('Analysis: completed');
  await expect(card).toContainText('Controlled analysis for browser integration.');
  await expect(page.locator('#processing-health')).toContainText('Completed: 1');
  await card.getByText('Review or correct analysis', { exact: true }).click();
  await card.getByLabel('Sentiment', { exact: true }).selectOption('neutral');
  await card.getByLabel('Category', { exact: true }).fill('usability');
  await card.getByLabel('Summary', { exact: true }).fill('Human-reviewed summary');
  await card.getByLabel('Reason for correction', { exact: true }).fill('Reviewed the original report.');
  await card.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(card).toContainText('Analyst correction (revision 1): Human-reviewed summary');
  await card.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(card).toContainText('Resolved');
  await page.reload();
  await expect(card).toContainText('Human-reviewed summary');
  await card.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(card).toContainText('Open');
  await card.getByText('Review or correct analysis', { exact: true }).click();
  await card.getByRole('button', { name: 'Show correction history', exact: true }).click();
  await expect(card).toContainText('Revision 1');
  const history = await (await request.get('/api/feedback/' + report.id + '/corrections')).json();
  expect(history).toHaveLength(1);
  expect(history[0].summary).toBe('Human-reviewed summary');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('failed submission retains input for retry and saves one report', async ({ page, request }) => {
  await page.goto('/triage');
  await page.getByLabel('Title', { exact: true }).fill('Retry browser report');
  await page.getByLabel('Description', { exact: true }).fill('Submission must survive a lost response.');
  // Let the server commit, then lose the response: retry must reuse its key.
  await page.route('**/api/feedback', async route => {
    await route.fetch();
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('#message')).toContainText('Failed to fetch');
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retry browser report');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('#message')).toContainText('saved. Analysis is pending.');
  const rows = await (await request.get('/api/triage')).json();
  expect(rows.filter(row => row.title === 'Retry browser report')).toHaveLength(1);
  const card = page.locator('article').filter({ hasText: 'Retry browser report' });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Suggest related reports', exact: true }).click();
  await expect(card).toContainText('No suggestions; this does not establish');
  expect((await (await request.get('/api/triage')).json()).length).toBe(rows.length);
});
