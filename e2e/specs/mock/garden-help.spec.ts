import { test, expect, request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { fetchJson, getAccessToken, sendMessageAndWaitForCompletion } from './helpers';

const helpSite = 'http://127.0.0.1:25482';
const email = 'garden-help-u2@example.invalid';
const password = 'GardenHelpLocalFixture123!';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ baseURL }) => {
  const directory = process.env.E2E_HELP_FIXTURE;
  if (
    !directory ||
    readFileSync(resolve(directory, 'owner.txt'), 'utf8').trim() !==
      'U1_GARDEN_HELP_ISOLATED;run=8659e84ef17b;port=25479'
  )
    throw new Error('Requires the explicitly owned U2 local fixture');
  const context = await request.newContext({ baseURL });
  // The first native account is a local bootstrap; the employee remains a native USER.
  for (const [userEmail, name] of [
    ['garden-help-bootstrap@example.invalid', 'Local Bootstrap'],
    [email, 'U2 Employee'],
  ]) {
    const response = await context.post('/api/auth/register', {
      data: { email: userEmail, name, password, confirm_password: password },
    });
    if (![200, 201, 400, 409, 422].includes(response.status()))
      throw new Error(`Local registration failed (${response.status()})`);
  }
  await context.dispose();
  const { MONGO_URI } = JSON.parse(readFileSync(resolve(directory, 'native-mongo.json'), 'utf8'));
  const uri = new URL(MONGO_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/GardenHelpU2Fixture')
    throw new Error('Refusing non-fixture database');
  const db = await mongoose.createConnection(MONGO_URI).asPromise();
  const result = await db
    .collection('users')
    .updateOne({ email }, { $set: { openidId: 'u2-alice', emailVerified: true } });
  if (result.matchedCount !== 1) throw new Error('Missing isolated employee');
  await db.close();
});
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByTestId('login-button').click();
  await page.waitForURL('**/c/**');
});

test('work chat and one native Help frame keep separate drafts; expand, edge Handle and reload preserve the same chat', async ({
  page,
}) => {
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(
    page,
    'E2E_REPLY:U2 work goal is to preserve the sheet layout',
  );
  const workURL = page.url();
  const main = page.getByRole('textbox', { name: 'Message input' });
  await main.fill('PRIVATE WORK DRAFT');
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Garden Help', exact: true });
  const frame = page.frameLocator('iframe[title="Garden Help"]');
  const input = frame.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  const source = page.locator('iframe[title="Garden Help"]');
  const sourceURL = await source.getAttribute('src');
  await frame.getByRole('button', { name: 'I am having trouble with Garden', exact: true }).click();
  await expect(input).toHaveValue('I am having trouble with Garden');
  await input.fill('E2E_REPLY:NATIVE_HELP_SENTINEL');
  await input.press('Enter');
  await expect(
    frame.getByText('E2E reply NATIVE_HELP_SENTINEL', { exact: true }).last(),
  ).toBeVisible();
  await expect(
    frame.getByRole('button', { name: 'I am having trouble with Garden', exact: true }),
  ).toHaveCount(0);
  await input.fill('PRIVATE HELP DRAFT');
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  expect(await source.getAttribute('src')).toBe(sourceURL);
  await expect(main).toHaveValue('PRIVATE WORK DRAFT');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const launcher = page.getByRole('button', { name: 'Garden Help', exact: true });
  await expect(launcher).toBeVisible();
  const circle = (await launcher.boundingBox())!;
  expect(circle.width).toBe(48);
  expect(circle.height).toBe(48);
  await page.mouse.move(circle.x + 24, circle.y + 24);
  await page.mouse.down();
  await page.mouse.move(388, 450, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await launcher.boundingBox())?.width).toBe(44);
  expect((await launcher.boundingBox())?.height).toBe(64);
  await page.reload();
  await expect.poll(async () => (await launcher.boundingBox())?.width).toBe(44);
  await launcher.click();
  await expect(input).toHaveValue('PRIVATE HELP DRAFT');
  expect(await source.getAttribute('src')).toBe(sourceURL);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  const handle = (await launcher.boundingBox())!;
  await page.mouse.move(handle.x + 22, handle.y + 32);
  await page.mouse.down();
  await page.mouse.move(160, 420, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await launcher.boundingBox())?.width).toBe(48);
  await launcher.click();
  const position = panel.locator('summary').filter({ hasText: 'Position' });
  await position.focus();
  await position.press('Enter');
  await panel.getByRole('button', { name: 'Reset position', exact: true }).click();
  await expect(input).toHaveValue('PRIVATE HELP DRAFT');
  await page.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U2-native-narrow.png'),
    fullPage: false,
  });
  const bounded = await page.context().newPage();
  await bounded.goto(`${workURL}?gardenHelp=1`);
  const expected = new URL(sourceURL!, 'http://127.0.0.1:25483');
  await expect.poll(() => new URL(bounded.url()).pathname).toBe(expected.pathname);
  await expect(bounded.getByRole('button', { name: 'Select a model', exact: true })).toHaveCount(0);
  // Cold direct/history navigation must recover the server-owned Help marker.
  await bounded.goto(new URL(expected.pathname, 'http://127.0.0.1:25483').href);
  await expect.poll(() => new URL(bounded.url()).searchParams.get('gardenHelp')).toBe('1');
  await expect(bounded.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'PRIVATE HELP DRAFT',
  );
  await expect(bounded.getByRole('button', { name: 'Select a model', exact: true })).toHaveCount(0);
  await bounded.reload();
  await expect(bounded.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'PRIVATE HELP DRAFT',
  );
  await expect.poll(() => new URL(bounded.url()).pathname).toBe(expected.pathname);
  await bounded.close();
});

test('native once approval copies verified source to real Help/PG, then own/shared views show a real maintainer update', async ({
  page,
  browser,
}) => {
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Garden Help"]');
  const input = frame.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  const token = await getAccessToken(page);
  const session = await fetchJson<{ context: { evidence: { source: { id: string } }[] } }>(
    page,
    '/api/garden/help/session',
    token,
  );
  const evidenceId = session.context.evidence[0].source.id;
  await input.fill(`E2E_GARDEN_HELP_SUBMIT skip urgency E2E_HELP_EVIDENCE=${evidenceId}`);
  await input.press('Enter');
  await expect(
    frame.getByText('Visible to all signed-in Garden users', { exact: true }),
  ).toBeVisible();
  await frame.getByText(/Submitted materials \(1\)/).click();
  await expect(
    frame.getByText(/U2 work goal is to preserve the sheet layout/).last(),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U2-native-approval.png'),
  });
  await frame.getByRole('button', { name: 'Submit to Garden Help', exact: true }).click();
  const ownLink = frame.getByRole('link', { name: 'My feedback', exact: true });
  await expect(ownLink).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U2-native-receipt.png') });
  const ownURL = (await ownLink.getAttribute('href'))!;
  const issueURL = (await frame
    .getByRole('link', { name: 'Shared issue', exact: true })
    .getAttribute('href'))!;
  await page.context().addCookies([{ name: 'u2actor', value: 'u2-alice', url: helpSite }]);
  const own = await page.context().newPage();
  await own.goto(ownURL);
  await expect(own.getByText('仅你和 Garden Help 维护者可见', { exact: true })).toBeVisible();
  await expect(own.getByText(/PRIVATE WORK DRAFT/)).toHaveCount(0);
  await expect(own.getByText(/U2 work goal is to preserve the sheet layout/)).toBeVisible();
  const maintainer = await browser.newContext();
  await maintainer.addCookies([{ name: 'u2actor', value: 'u2-maintainer', url: helpSite }]);
  const manage = await maintainer.newPage();
  await manage.goto(issueURL);
  await manage.getByLabel('真实处理状态', { exact: true }).selectOption('planned');
  await manage
    .getByLabel('公开处理说明', { exact: true })
    .fill('U2 maintainer reviewed the approved summary.');
  await manage.getByLabel('维护者优先级', { exact: true }).selectOption('P2');
  await manage.getByRole('button', { name: '保存处理结果', exact: true }).click();
  await expect(
    manage.getByText('处理结果已保存，所有已登录 Garden 用户可见。', { exact: true }),
  ).toBeVisible();
  const bob = await browser.newContext();
  await bob.addCookies([{ name: 'u2actor', value: 'u2-bob', url: helpSite }]);
  const shared = await bob.newPage();
  await shared.goto(issueURL);
  await expect(
    shared.getByText('U2 maintainer reviewed the approved summary.', { exact: true }),
  ).toBeVisible();
  await expect(shared.getByText(/已计划/)).toBeVisible();
  const feedbackId = new URL(ownURL).searchParams.get('id');
  expect((await shared.request.get(`${helpSite}/api/help/feedback/${feedbackId}`)).status()).toBe(
    404,
  );
  await shared.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U2-shared-progress.png'),
    fullPage: false,
  });
  await maintainer.close();
  await bob.close();
  await own.close();
});
