import { setupHelpFixture } from './garden-help-fixture';
import type { TMessage } from 'librechat-data-provider';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { fetchJson, getAccessToken, sendMessageAndWaitForCompletion } from './helpers';

test.beforeAll(async ({ baseURL }) =>
  setupHelpFixture(baseURL, 'garden-help-h1@example.invalid', 'u2-bob'),
);
const fixture = process.env.E2E_HELP_FIXTURE!;
const evidence = process.env.E2E_HELP_EVIDENCE!;
async function database() {
  if (
    readFileSync(resolve(fixture, 'owner.txt'), 'utf8').trim() !==
    'H1_GARDEN_HELP_ISOLATED;run=135b7bbee790;port=25479'
  )
    throw new Error('owner');
  const { MONGO_URI } = JSON.parse(readFileSync(resolve(fixture, 'native-mongo.json'), 'utf8'));
  if (
    new URL(MONGO_URI).hostname !== '127.0.0.1' ||
    new URL(MONGO_URI).pathname !== '/GardenHelpU2Fixture'
  )
    throw new Error('local fixture only');
  return mongoose.createConnection(MONGO_URI).asPromise();
}
test('send binds current branch; reading another entry cannot mutate it; native pause keeps exact approved bytes after metadata resave and source deletion', async ({
  page,
}) => {
  const sent: { messageId?: string; anchor?: string }[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.startsWith('/api/agents/'))
      return;
    try {
      const data = request.postDataJSON();
      sent.push({ messageId: data.messageId, anchor: data.gardenHelpContextMessageId });
    } catch {
      /* Other native request. */
    }
    writeFileSync(resolve(evidence, 'H1-native-send-ids.json'), JSON.stringify(sent, null, 2));
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('garden-help-h1@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('GardenHelpLocalFixture123!');
  await page.getByTestId('login-button').click();
  await page.waitForURL('**/c/**');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:H1_CURRENT_WORK');
  const workId = new URL(page.url()).pathname.split('/').pop()!;
  const token = await getAccessToken(page);
  const db = await database();
  try {
    const user = await db.collection('users').findOne({ email: 'garden-help-h1@example.invalid' });
    const before = await db
      .collection('messages')
      .countDocuments({ user: String(user!._id), 'metadata.gardenHelpContext': { $exists: true } });
    await page.getByRole('button', { name: 'Garden Help', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Garden Help"]');
    const input = frame.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    expect(
      await db.collection('messages').countDocuments({
        user: String(user!._id),
        'metadata.gardenHelpContext': { $exists: true },
      }),
    ).toBe(before);
    await input.fill('E2E_REPLY:H1_FIRST_HELP');
    await input.press('Enter');
    await expect(frame.getByText('E2E reply H1_FIRST_HELP', { exact: true }).last()).toBeVisible();
    const first = await db
      .collection('messages')
      .findOne({ user: String(user!._id), text: 'E2E_REPLY:H1_FIRST_HELP' });
    expect(first?.metadata?.gardenHelpContext?.context?.selection?.conversationId).toBe(workId);
    const captured = first!.metadata.gardenHelpContext;
    expect(
      captured.context.evidence.some((item: { text: string }) =>
        item.text.includes('H1_CURRENT_WORK'),
      ),
    ).toBe(true);
    const other = await page.context().newPage();
    await other.goto('/c/new');
    await sendMessageAndWaitForCompletion(other, 'E2E_REPLY:H1_OTHER_WORK');
    const otherWorkId = new URL(other.url()).pathname.split('/').pop()!;
    await other.getByRole('button', { name: 'Garden Help', exact: true }).click();
    const otherInput = other
      .frameLocator('iframe[title="Garden Help"]')
      .getByRole('textbox', { name: 'Message input' });
    await expect(otherInput).toBeVisible();
    expect(
      (await db.collection('messages').findOne({ _id: first!._id }))?.metadata.gardenHelpContext,
    ).toEqual(captured);
    await otherInput.fill('E2E_REPLY:H1_OTHER_HELP');
    await otherInput.press('Enter');
    await expect(
      other
        .frameLocator('iframe[title="Garden Help"]')
        .getByText('E2E reply H1_OTHER_HELP', { exact: true })
        .last(),
    ).toBeVisible();
    expect(
      (await db.collection('messages').findOne({ text: 'E2E_REPLY:H1_OTHER_HELP' }))?.metadata
        .gardenHelpContext.context.selection.conversationId,
    ).toBe(otherWorkId);
    await other.close();
    // This tab's continuation retains its own branch context after the other tab sends.
    const choice =
      'P2，E2E_GARDEN_HELP_SUBMIT H1_TIMESTAMP_AND_DELETE E2E_HELP_EVIDENCE=' +
      captured.context.evidence[0].source.id +
      ',' +
      first!.conversationId +
      '/' +
      first!.messageId;
    await input.fill(choice);
    await input.press('Enter');
    const approve = frame.getByRole('button', { name: 'Submit to Garden Help', exact: true });
    await expect(approve).toBeVisible();
    const paused = await db.collection('messages').findOne({
      user: String(user!._id),
      text: choice,
    });
    expect(paused!.updatedAt.getTime()).toBeGreaterThan(paused!.createdAt.getTime());
    // The real pause just re-saved the user message. No test patch replaces that write.
    await db.collection('messages').deleteMany({ user: String(user!._id), conversationId: workId });
    await db.collection('messages').deleteOne({ _id: first!._id, user: String(user!._id) });
    await approve.click();
    await expect(
      frame
        .getByText('Saved for evaluation. This does not mean development is scheduled.', {
          exact: true,
        })
        .last(),
    ).toBeVisible();
    const own = frame.getByRole('link', { name: 'My feedback', exact: true }).last();
    const ownURL = (await own.getAttribute('href'))!;
    let submission: string | undefined;
    await expect
      .poll(async () => {
        const messages = await fetchJson<TMessage[]>(
          page,
          '/api/messages/' + first!.conversationId,
          token,
        );
        const outputs = messages
          .flatMap((message) => message.content ?? [])
          .flatMap((part) =>
            part?.type === 'tool_call' && part.tool_call.output
              ? [JSON.parse(part.tool_call.output)]
              : [],
          );
        submission = outputs.filter((value) => value.feedback_id).at(-1)?.submission_id;
        return submission;
      })
      .toBeTruthy();
    const retry = await page.request.post('/api/garden/help/submissions/' + submission + '/retry', {
      headers: {
        Authorization: 'Bearer ' + token,
        Origin: 'http://127.0.0.1:25483',
        'Sec-Fetch-Site': 'same-origin',
      },
      data: {},
    });
    const receipt = await retry.json();
    expect(receipt.feedback_id).toBe(new URL(ownURL).searchParams.get('id'));
    await page
      .context()
      .addCookies([{ name: 'u2actor', value: 'u2-bob', url: 'http://127.0.0.1:25482' }]);
    const history = await page.context().newPage();
    await history.goto(ownURL);
    await history.getByText('原文片段 1', { exact: true }).click();
    await expect(history.getByText(/H1_CURRENT_WORK/)).toBeVisible();
    await history.getByText('原文片段 2', { exact: true }).click();
    await expect(history.getByText(/H1_FIRST_HELP/)).toBeVisible();
    await history.getByText('原文片段 3', { exact: true }).click();
    await expect(history.getByText(/H1_TIMESTAMP_AND_DELETE/)).toBeVisible();
    await history.screenshot({ path: resolve(evidence, 'H1-native-history.png') });
    await history.close();
    await page
      .getByRole('region', { name: 'Garden Help', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.getByTestId('nav-user').click();
    await page.getByTestId('nav-settings').click();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    const beforeSettings = await db
      .collection('messages')
      .countDocuments({ user: String(user!._id), 'metadata.gardenHelpContext': { $exists: true } });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Garden Help', exact: true })
      .click();
    await expect(input).toBeVisible();
    expect(
      await db.collection('messages').countDocuments({
        user: String(user!._id),
        'metadata.gardenHelpContext': { $exists: true },
      }),
    ).toBe(beforeSettings);
    await input.fill('E2E_REPLY:H1_SETTINGS_HELP');
    await input.press('Enter');
    await expect(
      frame.getByText('E2E reply H1_SETTINGS_HELP', { exact: true }).last(),
    ).toBeVisible();
    const settings = await db
      .collection('messages')
      .findOne({ user: String(user!._id), text: 'E2E_REPLY:H1_SETTINGS_HELP' });
    expect(settings?.metadata.gardenHelpContext.context.selection).toEqual({
      kind: 'settings',
      tab: 'account',
    });
    expect(settings?.metadata.gardenHelpContext.context.evidence).toEqual([]);
    await page.evaluate(() => localStorage.setItem('lang', JSON.stringify('zh-Hans')));
    await page.reload();
    await page.getByRole('button', { name: 'Garden 帮助', exact: true }).click();
    await expect(
      frame.getByText('已保存为改进候选，不代表已安排开发。', { exact: true }).last(),
    ).toBeVisible();
    await page.screenshot({ path: resolve(evidence, 'H1-native-chinese-receipt.png') });
    writeFileSync(
      resolve(evidence, 'H1-native-receipt.json'),
      JSON.stringify(
        {
          receipt,
          submission,
          nativePauseCreatedAt: paused!.createdAt,
          nativePauseUpdatedAt: paused!.updatedAt,
          workId,
          otherWorkId,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
});

test('document entry stages only a descriptor; actual send captures its exact authorized section', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('garden-help-h1@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('GardenHelpLocalFixture123!');
  await page.getByTestId('login-button').click();
  await page.waitForURL('**/c/**');
  const db = await database();
  try {
    const before = await db
      .collection('messages')
      .countDocuments({ 'metadata.gardenHelpContext': { $exists: true } });
    await page.goto('http://127.0.0.1:25482/nas/windows/');
    await page.getByRole('link', { name: '就此节求助', exact: true }).first().click();
    const frame = page.frameLocator('iframe[title="Garden Help"]');
    const input = frame.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    expect(
      await db
        .collection('messages')
        .countDocuments({ 'metadata.gardenHelpContext': { $exists: true } }),
    ).toBe(before);
    await input.fill('E2E_REPLY:H1_DOCUMENT_HELP');
    await input.press('Enter');
    await expect(
      frame.getByText('E2E reply H1_DOCUMENT_HELP', { exact: true }).last(),
    ).toBeVisible();
    const row = await db.collection('messages').findOne({ text: 'E2E_REPLY:H1_DOCUMENT_HELP' });
    expect(row?.metadata.gardenHelpContext.status).toBe('captured');
    expect(row?.metadata.gardenHelpContext.context.selection).toMatchObject({
      kind: 'document',
      id: 'nas/windows',
      section: 0,
    });
    expect(row?.metadata.gardenHelpContext.context.evidence[0].text).toContain(
      '## 第一步：打开 NAS 地址',
    );
    expect(row?.metadata.gardenHelpContext.context.evidence[0].text).not.toContain('## 第二步');
  } finally {
    await db.close();
  }
});
