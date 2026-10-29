import { test, expect, request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import type { HelpSession } from 'librechat-data-provider';
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
  const { MONGO_URI } = JSON.parse(readFileSync(resolve(directory, 'native-mongo.json'), 'utf8'));
  const uri = new URL(MONGO_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/GardenHelpU2Fixture')
    throw new Error('Refusing non-fixture database');
  const db = await mongoose.createConnection(MONGO_URI).asPromise();
  const context = await request.newContext({ baseURL });
  // The first native account is a local bootstrap; the employee remains a native USER.
  for (const [userEmail, name] of [
    ['garden-help-bootstrap@example.invalid', 'Local Bootstrap'],
    [email, 'U2 Employee'],
  ]) {
    // Replaying this owned fixture must reuse its accounts, rather than
    // exhausting native registration limits before any journey can run.
    if (await db.collection('users').findOne({ email: userEmail })) continue;
    const response = await context.post('/api/auth/register', {
      data: { email: userEmail, name, password, confirm_password: password },
    });
    if (![200, 201, 400, 409, 422].includes(response.status()))
      throw new Error(`Local registration failed (${response.status()})`);
  }
  await context.dispose();
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
  const preference = () => page.evaluate(() => localStorage.getItem('lastConversationSetup_0'));
  const ordinaryPreference = await preference();
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Garden Help', exact: true });
  const frame = page.frameLocator('iframe[title="Garden Help"]');
  const input = frame.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  expect(await preference()).toBe(ordinaryPreference);
  await expect(panel.getByRole('region', { name: 'Source snapshot', exact: true })).toHaveCount(1);
  await expect(frame.getByRole('region', { name: 'Source snapshot', exact: true })).toHaveCount(0);
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
  await input.press('Escape');
  await expect(panel).not.toBeVisible();
  const keyboardLauncher = page.getByRole('button', { name: 'Garden Help', exact: true });
  await expect(keyboardLauncher).toBeFocused();
  await keyboardLauncher.press('Enter');
  await expect(input).toHaveValue('PRIVATE HELP DRAFT');
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  expect(await preference()).toBe(ordinaryPreference);
  expect(await source.getAttribute('src')).toBe(sourceURL);
  await expect(panel.getByRole('region', { name: 'Source snapshot', exact: true })).toHaveCount(1);
  await expect(frame.getByRole('region', { name: 'Source snapshot', exact: true })).toHaveCount(0);
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
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4-native-narrow.png'),
    fullPage: false,
  });
  const bounded = await page.context().newPage();
  await bounded.goto(`${workURL}?gardenHelp=1`);
  const expected = new URL(sourceURL!, 'http://127.0.0.1:25483');
  await expect.poll(() => new URL(bounded.url()).pathname).toBe(expected.pathname);
  await expect(bounded.getByRole('button', { name: 'Select a model', exact: true })).toHaveCount(0);
  // Cold direct/history navigation must recover the server-owned Help marker.
  await bounded.goto(new URL(expected.pathname, 'http://127.0.0.1:25483').href);
  // The server-owned marker can restore Help without normalizing its display query.
  await expect.poll(() => new URL(bounded.url()).pathname).toBe(expected.pathname);
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
  const ordinary = await page.context().newPage();
  await ordinary.goto('/c/new');
  await expect(ordinary.getByRole('button', { name: 'Select a model', exact: true })).toHaveText(
    'Work fixture',
  );
  await ordinary.close();
});

test('native once approval copies verified source to real Help/PG, then own/shared views show a real maintainer update', async ({
  page,
  browser,
}) => {
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Garden Help', exact: true });
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
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4-native-approval.png'),
  });
  await frame.getByRole('button', { name: 'Submit to Garden Help', exact: true }).click();
  const ownLink = frame.getByRole('link', { name: 'My feedback', exact: true });
  await expect(ownLink).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4-native-receipt.png') });
  const ownURL = (await ownLink.getAttribute('href'))!;
  const issueURL = (await frame
    .getByRole('link', { name: 'Shared issue', exact: true })
    .getAttribute('href'))!;
  await page.context().addCookies([{ name: 'u2actor', value: 'u2-alice', url: helpSite }]);
  const own = await page.context().newPage();
  await own.goto(ownURL);
  await expect(own.getByText('仅你和 Garden Help 维护者可见', { exact: true })).toBeVisible();
  await expect(own.getByText(/PRIVATE WORK DRAFT/)).toHaveCount(0);
  await own.getByText('原文片段 1', { exact: true }).click();
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
    shared.getByText('U2 maintainer reviewed the approved summary.', { exact: true }).first(),
  ).toBeVisible();
  await expect(shared.getByText(/已计划/).first()).toBeVisible();
  const feedbackId = new URL(ownURL).searchParams.get('id');
  expect((await shared.request.get(`${helpSite}/api/help/feedback/${feedbackId}`)).status()).toBe(
    404,
  );
  await shared.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4-shared-progress.png'),
    fullPage: false,
  });
  await shared.getByLabel('你的紧急程度', { exact: true }).selectOption('P1');
  await shared.getByRole('button', { name: '保存我的建议', exact: true }).click();
  await expect(shared.getByText('你的建议已保存。', { exact: true })).toBeVisible();
  await shared.goto(helpSite + '/feedback/');
  await expect(
    shared
      .locator('article')
      .filter({
        has: shared.locator(
          'a[href="' + new URL(issueURL).pathname + new URL(issueURL).search + '"]',
        ),
      })
      .getByText('仅给过建议 · 你的紧急程度：P1', { exact: true }),
  ).toBeVisible();
  await shared.setViewportSize({ width: 390, height: 844 });
  expect(await shared.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await shared.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4-participation-narrow.png'),
    fullPage: true,
  });
  const issueId = new URL(issueURL).searchParams.get('id');
  await manage.goto(helpSite + '/manage/?id=' + issueId);
  await expect(manage.getByText(/P1：1 人/)).toBeVisible();
  await manage.getByText('查看个人建议', { exact: true }).click();
  await expect(manage.getByText(/u2-bob · P1/)).toBeVisible();
  await expect(manage.getByText('已授权的反馈摘要', { exact: true })).toBeVisible();
  await manage.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4-maintainer.png'),
    fullPage: true,
  });
  await own.goto(issueURL);
  await own.getByLabel('你的紧急程度', { exact: true }).selectOption('P2');
  await own.getByRole('button', { name: '保存我的建议', exact: true }).click();
  await expect(own.getByText('你的建议已保存。', { exact: true })).toBeVisible();
  await own.goto(ownURL);
  await own.getByRole('button', { name: '删除我的反馈', exact: true }).click();
  const deletion = own.getByRole('dialog');
  await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(deletion.getByText(/原聊天和当前紧急程度建议会保留/)).toBeVisible();
  const deleting = own.waitForResponse(
    (response) =>
      response.url().includes('/api/help/feedback/') && response.request().method() === 'DELETE',
  );
  await deletion.getByRole('button', { name: '删除我的反馈', exact: true }).click();
  const deleted = await deleting;
  expect(await deleted.text()).toContain('deleted');
  expect(deleted.status()).toBe(200);
  await expect(
    own.getByText('反馈及你提交的材料已删除；原聊天和当前意见保留。', { exact: true }),
  ).toBeVisible();
  await expect(
    own
      .locator('article')
      .filter({
        has: own.locator('a[href="' + new URL(issueURL).pathname + new URL(issueURL).search + '"]'),
      })
      .getByText('仅给过建议 · 你的紧急程度：P2', { exact: true }),
  ).toBeVisible();
  await own.goto(issueURL);
  await own.getByRole('button', { name: '撤回我的建议', exact: true }).click();
  await expect(own.getByText('你的建议已撤回。', { exact: true })).toBeVisible();
  await shared.goto(helpSite + '/manage/');
  await expect(
    shared.getByText('你没有访问这份材料或管理操作的权限。', { exact: true }),
  ).toBeVisible();
  await shared.goto(issueURL);
  await shared.getByLabel('你的紧急程度', { exact: true }).selectOption('P0');
  await bob.addCookies([{ name: 'u2actor', value: 'u2-alice', url: helpSite }]);
  await shared.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(
    shared.getByText('身份或权限已变化，旧材料和编辑已清除。请重新加载。', { exact: true }),
  ).toBeVisible();
  await expect(shared.getByLabel('你的紧急程度', { exact: true })).toHaveCount(0);
  await bob.clearCookies();
  await shared.reload();
  await expect(shared.getByText('登录已失效，请重新登录。', { exact: true })).toBeVisible();
  await expect(shared.getByRole('link', { name: '重新登录', exact: true })).toBeVisible();
  await maintainer.close();
  await bob.close();
  // Extend this maintained journey at the actual native/source boundary.
  const currentSource = () => fetchJson<HelpSession>(page, '/api/garden/help/session', token);
  const beforeDocument = await currentSource();
  await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:LATER_WORK_NOT_AUTOMATICALLY_INCLUDED');
  expect((await currentSource()).context).toEqual(beforeDocument.context);
  await input.fill('DOCUMENT HELP DRAFT');
  await own.goto(helpSite + '/nas/');
  expect(
    await own.getByRole('link', { name: '就本页求助', exact: true }).getAttribute('href'),
  ).toMatch(/document=nas%2Findex&version=[a-f0-9]{64}/);
  await own.getByRole('link', { name: '就此节求助', exact: true }).first().click();
  const documentFrame = own.frameLocator('iframe[title="Garden Help"]');
  const nativeSource = documentFrame.getByRole('region', { name: 'Source snapshot', exact: true });
  await expect(documentFrame.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'DOCUMENT HELP DRAFT',
  );
  const sectionSource = await currentSource();
  expect(sectionSource.conversationId).toBe(beforeDocument.conversationId);
  expect(sectionSource.context!.evidence[0].source.id).toBe('nas/index#section=0');
  await nativeSource.getByText(/View source snapshot/).click();
  await expect(nativeSource.getByRole('region', { name: 'Selected source details' })).toContainText(
    sectionSource.context!.evidence[0].source.range,
  );
  await nativeSource.getByRole('button', { name: 'Update source snapshot', exact: true }).click();
  await expect
    .poll(async () => (await currentSource()).context!.captured_at)
    .not.toBe(sectionSource.context!.captured_at);
  expect((await currentSource()).context!.selection).toEqual(sectionSource.context!.selection);
  await expect(documentFrame.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'DOCUMENT HELP DRAFT',
  );
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const compactSource = panel.getByRole('region', { name: 'Source snapshot', exact: true });
  await expect(compactSource.getByRole('status')).toHaveText(sectionSource.context!.label);
  await expect(input).toHaveValue('DOCUMENT HELP DRAFT');

  // History/direct entry has the same controls and unsent draft. Clearing in
  // that view must remain clear in the already-open document/compact views.
  const full = await page.context().newPage();
  await full.goto('http://127.0.0.1:25483/c/' + encodeURIComponent(beforeDocument.conversationId));
  const fullSource = full.getByRole('region', { name: 'Source snapshot', exact: true });
  await expect(fullSource.getByRole('status')).toHaveText(sectionSource.context!.label);
  await expect(full.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'DOCUMENT HELP DRAFT',
  );
  await fullSource.getByRole('button', { name: 'Continue without source', exact: true }).click();
  await expect(fullSource.getByText('No source included', { exact: true })).toBeVisible();
  expect((await currentSource()).context).toBeNull();
  await own.bringToFront();
  await own.evaluate(() => window.dispatchEvent(new Event('focus')));
  await documentFrame.getByRole('textbox', { name: 'Message input' }).focus();
  await expect(nativeSource.getByText('No source included', { exact: true })).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(compactSource.getByText('No source included', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  await expect(compactSource.getByText('No source included', { exact: true })).toBeVisible();
  expect((await currentSource()).context).toBeNull();
  await expect(input).toHaveValue('DOCUMENT HELP DRAFT');
  await compactSource
    .getByRole('button', { name: 'Update from this work chat', exact: true })
    .click();
  await expect.poll(async () => (await currentSource()).context?.selection?.kind).toBe('chat');
  expect(
    (await currentSource()).context!.evidence.some((e) =>
      e.text?.includes('LATER_WORK_NOT_AUTOMATICALLY_INCLUDED'),
    ),
  ).toBe(true);
  await full.bringToFront();
  await full.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(fullSource.getByRole('status')).toContainText('Selected chat branch');
  const explicitWork = (await currentSource()).context!.selection;
  await fullSource.getByRole('button', { name: 'Update source snapshot', exact: true }).click();
  await expect.poll(async () => (await currentSource()).context!.selection).toEqual(explicitWork);
  await expect(full.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'DOCUMENT HELP DRAFT',
  );

  // The other directory index and the original ordinary leaf both work.
  await own.goto(helpSite + '/proxy/');
  expect(
    await own.getByRole('link', { name: '就本页求助', exact: true }).getAttribute('href'),
  ).toMatch(/document=proxy%2Findex&version=[a-f0-9]{64}/);
  await own.getByRole('link', { name: '就本页求助', exact: true }).click();
  await expect(documentFrame.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'DOCUMENT HELP DRAFT',
  );
  expect((await currentSource()).context!.evidence[0].source.id).toBe('proxy/index');
  await own.goto(helpSite + '/nas/windows/');
  await own.getByRole('link', { name: '就此节求助', exact: true }).first().click();
  await expect(documentFrame.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'DOCUMENT HELP DRAFT',
  );
  const leafSource = (await currentSource()).context!;
  expect(leafSource.evidence[0].source.id).toBe('nas/windows#section=0');
  expect(leafSource.evidence[0].text).toContain('## 第一步：打开 NAS 地址');
  expect(leafSource.evidence[0].text).not.toContain('## 第二步');
  await expect(nativeSource.getByRole('status')).toHaveText(leafSource.label);
  await own.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'U4R2-document-source.png'),
    fullPage: false,
  });
  await full.close();
  await own.close();
});
