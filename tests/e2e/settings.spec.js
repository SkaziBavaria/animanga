'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks } = require('./fixtures');

test.describe('Settings & logs', () => {
  test('configures GitHub as sync provider without a callback URL', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-view="settingsView"]');
    await page.selectOption('#syncProvider', 'github');
    await expect(page.locator('#githubSyncForm')).toBeVisible();
    await expect(page.locator('#syncForm')).toBeHidden();
    await page.fill('#githubSyncForm input[name="deviceName"]', 'Laptop');
    await page.fill('#githubSyncForm input[name="clientId"]', 'github-client-id');
    const save = page.waitForRequest((request) => request.url().endsWith('/api/sync/github/config') && request.method() === 'POST');
    await page.click('#githubSyncForm button[type="submit"]');
    expect((await save).postDataJSON()).toEqual({ deviceName: 'Laptop', clientId: 'github-client-id' });
    await expect(page.locator('#syncStatus')).toContainText('GitHub configured');
  });

  test('loads existing settings into the form', async ({ page }) => {
    await installApiMocks(page, {
      settings: { mode: 'dub', quality: '720', skipIntro: true, autoTrackPlayed: false },
    });
    await page.goto('/');
    await page.click('.tab[data-view="settingsView"]');

    await expect(page.locator('#settingsForm select[name="mode"]')).toHaveValue('dub');
    await expect(page.locator('#settingsForm select[name="quality"]')).toHaveValue('720');
    await expect(page.locator('#settingsForm input[name="skipIntro"]')).toBeChecked();
    await expect(page.locator('#settingsForm input[name="autoTrackPlayed"]')).not.toBeChecked();
  });

  test('saves updated settings', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-view="settingsView"]');
    await page.selectOption('#settingsForm select[name="mode"]', 'dub');
    await page.locator('#settingsForm input[name="skipIntro"]').check();

    const saveRequest = page.waitForRequest((req) => req.url().endsWith('/api/settings') && req.method() === 'POST');
    await page.click('#settingsForm button[type="submit"]');
    const req = await saveRequest;
    expect(req.postDataJSON()).toMatchObject({ mode: 'dub', skipIntro: true });
    await expect(page.locator('#toast')).toContainText('Settings saved');
  });

  test('fetches and clears job logs', async ({ page }) => {
    await installApiMocks(page, {
      jobs: [{ status: 'done', label: 'Play one piece', startedAt: '2026-01-01T00:00:00Z', output: 'Links Fetched' }],
    });
    await page.goto('/');
    await page.click('.tab[data-view="settingsView"]');
    await page.click('.advanced-panel summary');

    await page.click('#jobsBtn');
    await expect(page.locator('#jobsList .job-card')).toHaveCount(1);
    await expect(page.locator('#jobsList')).toContainText('Play one piece');

    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#clearJobsBtn');
    await expect(page.locator('#jobsList')).toContainText('No jobs.');
    await expect(page.locator('#toast')).toContainText('Jobs cleared');
  });
});
