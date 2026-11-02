import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { setupHelpFixture } from './garden-help-fixture';
import { sendMessageAndWaitForCompletion } from './helpers';

const helpSite = 'http://127.0.0.1:25482';
const email = 'garden-help-u2@example.invalid';
const password = 'GardenHelpLocalFixture123!';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ baseURL }) => setupHelpFixture(baseURL));
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByTestId('login-button').click();
  await page.waitForURL('**/c/**');
});

async function dragHeader(
  page: Page,
  panel: Locator,
  target: Locator,
  dx: number,
  dy: number,
  blank = false,
) {
  const before = (await panel.boundingBox())!;
  const box = (await target.boundingBox())!;
  const x = blank ? box.x + 145 : box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.x))
    .toBe(Math.round(Math.max(8, Math.min(before.x + dx, viewport.width - before.width - 8))));
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.y))
    .toBe(Math.round(Math.max(8, Math.min(before.y + dy, viewport.height - before.height - 8))));
}

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
  let agentRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/agents/'))
      agentRequests++;
  });
  const preference = () => page.evaluate(() => localStorage.getItem('lastConversationSetup_0'));
  const ordinaryPreference = await preference();
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Garden Help', exact: true });
  const frame = page.frameLocator('iframe[title="Garden Help"]');
  const input = frame.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  expect(await preference()).toBe(ordinaryPreference);
  await expect(panel.getByRole('region', { name: 'Source snapshot', exact: true })).toHaveCount(0);
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
  const popupPromise = page.waitForEvent('popup');
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  const expanded = await popupPromise;
  await expect(panel).not.toBeVisible();
  await expect(expanded.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'PRIVATE HELP DRAFT',
  );
  await expanded.getByRole('textbox', { name: 'Message input' }).fill('EXPANDED HELP DRAFT');
  await expanded.close();
  await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
  await expect(input).toHaveValue('EXPANDED HELP DRAFT');
  await input.fill('PRIVATE HELP DRAFT');
  expect(await preference()).toBe(ordinaryPreference);
  expect(await source.getAttribute('src')).toBe(sourceURL);
  await expect(panel.getByRole('region', { name: 'Source snapshot', exact: true })).toHaveCount(0);
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
  const grip = panel.getByRole('button', {
    name: 'Move Help window (arrow keys to move, Home to reset)',
    exact: true,
  });
  await grip.focus();
  await grip.press('Home');
  await expect(input).toHaveValue('PRIVATE HELP DRAFT');
  await page.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'H1-UI-native-narrow.png'),
    fullPage: false,
  });
  const requestsBeforeHeader = agentRequests;
  // Title, empty header space and grip all move the actual panel, without launcher clamps.
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        localStorage.setItem('color-theme', value);
        localStorage.setItem('lang', JSON.stringify('zh-Hans'));
      }, theme);
      await page.reload();
      await page.getByRole('button', { name: 'Garden 帮助', exact: true }).click();
      const localizedPanel = page.getByRole('region', { name: 'Garden 帮助', exact: true });
      const header = localizedPanel.locator('header');
      const move = localizedPanel.getByRole('button', {
        name: '移动帮助窗口（方向键移动，Home 恢复默认位置）',
        exact: true,
      });
      const close = localizedPanel.getByRole('button', { name: '关闭', exact: true });
      const expand = localizedPanel.getByRole('button', { name: '展开', exact: true });
      await expect(frame.getByRole('textbox', { name: '消息输入' })).toHaveValue(
        'PRIVATE HELP DRAFT',
      );
      const assertInViewport = async () => {
        const box = (await localizedPanel.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(8);
        expect(box.y).toBeGreaterThanOrEqual(8);
        expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
        expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(page.viewportSize()!.height - 8);
      };
      await assertInViewport();
      await expect(header.locator('summary')).toHaveCount(0);
      await expect(close).toHaveText('');
      await expect(expand).toHaveText('');
      await expect(expand).toHaveAttribute('title', '在新标签页中展开');
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      await move.focus();
      await move.press('Home');
      await frame.getByRole('textbox', { name: '消息输入' }).focus();
      await page.screenshot({
        path: resolve(
          process.env.E2E_HELP_EVIDENCE!,
          'H1-UI-' + width + '-' + theme + '-before.png',
        ),
      });
      await dragHeader(page, localizedPanel, header.getByRole('heading'), -24, -24);
      await dragHeader(page, localizedPanel, header, 0, -24, true);
      await dragHeader(page, localizedPanel, move, 0, 12);
      const beforeKeys = (await localizedPanel.boundingBox())!;
      await move.focus();
      await move.press('ArrowDown');
      await expect
        .poll(async () => Math.round((await localizedPanel.boundingBox())!.y))
        .toBe(Math.round(beforeKeys.y + 10));
      await page.screenshot({
        path: resolve(
          process.env.E2E_HELP_EVIDENCE!,
          'H1-UI-' + width + '-' + theme + '-after.png',
        ),
      });
      if (width === 375 && theme === 'light') {
        const touch = await page.context().newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 1,
        });
        const beforeTouch = (await localizedPanel.boundingBox())!;
        const point = { x: beforeTouch.x + 145, y: beforeTouch.y + 24 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: point.x, y: point.y - 18 }],
        });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect
          .poll(async () => Math.round((await localizedPanel.boundingBox())!.y))
          .toBe(Math.round(beforeTouch.y - 18));
        await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await touch.detach();
      }
      if (width === 375 && theme === 'dark') {
        await page.setViewportSize({ width, height: 500 });
        await assertInViewport();
        await expect(close).toBeVisible();
        await page.setViewportSize({ width, height: 900 });
        await assertInViewport();
      }
      // Dragging from an icon must not move the window or close it on release outside.
      const beforeControl = await localizedPanel.boundingBox();
      const icon = (await close.boundingBox())!;
      await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
      await page.mouse.down();
      await page.mouse.move(icon.x - 30, icon.y + 70);
      await page.mouse.up();
      expect(await localizedPanel.boundingBox()).toEqual(beforeControl);
      await expect(localizedPanel).toBeVisible();
      await close.click();
      await expect(page.getByRole('button', { name: 'Garden 帮助', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Garden 帮助', exact: true }).click();
      expect(await localizedPanel.boundingBox()).toEqual(beforeControl);
      await move.focus();
      await move.press('Home');
      await move.press('Escape');
    }
  }
  expect(agentRequests).toBe(requestsBeforeHeader);
  // Restore the existing journey's language before its cold/native navigation assertions.
  await page.evaluate(() => localStorage.setItem('lang', JSON.stringify('en')));
  await page.reload();
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
  const frame = page.frameLocator('iframe[title="Garden Help"]');
  const input = frame.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  await input.fill('P2，E2E_GARDEN_HELP_SUBMIT synthetic own current message');
  await input.press('Enter');
  await expect(
    frame.getByText('Visible to all signed-in Garden users', { exact: true }),
  ).toBeVisible();
  await frame.getByText(/Submitted materials \(1\)/).click();
  await expect(frame.getByText(/synthetic own current message/).last()).toBeVisible();
  await page.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'H1-R1-native-approval.png'),
  });
  await frame.getByRole('button', { name: 'Submit to Garden Help', exact: true }).click();
  const ownLink = frame.getByRole('link', { name: 'My feedback', exact: true });
  await expect(ownLink).toBeVisible({ timeout: 30000 });
  await page.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'H1-R1-native-receipt.png'),
  });
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
  await expect(own.getByText(/synthetic own current message/)).toBeVisible();
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
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'H1-R1-shared-progress.png'),
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
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'H1-R1-participation-narrow.png'),
    fullPage: true,
  });
  const issueId = new URL(issueURL).searchParams.get('id');
  await manage.goto(helpSite + '/manage/?id=' + issueId);
  await expect(manage.getByText(/P1：1 人/)).toBeVisible();
  await manage.getByText('查看个人建议', { exact: true }).click();
  await expect(manage.getByText(/u2-bob · P1/)).toBeVisible();
  await expect(manage.getByText('已授权的反馈摘要', { exact: true })).toBeVisible();
  await manage.screenshot({
    path: resolve(process.env.E2E_HELP_EVIDENCE!, 'H1-R1-maintainer.png'),
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
  await own.close();
});
