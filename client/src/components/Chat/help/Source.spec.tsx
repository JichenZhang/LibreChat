import React from 'react';
import { request } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { HelpContext, TMessage } from 'librechat-data-provider';
import HelpSource from './Source';

let mockUser = { id: 'owner' };
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useLocalize: () => (key: string) => key,
}));
jest.mock('@librechat/client', () => ({
  Button: (props: Record<string, unknown>) =>
    jest.requireActual('react').createElement('button', props),
}));
jest.mock('librechat-data-provider', () => ({
  QueryKeys: { gardenHelpSession: 'gardenHelpSession' },
  request: { get: jest.fn(), post: jest.fn() },
}));

const conversationId = 'b213fe6d-7160-4f8b-9ebd-459b19364038';
function snapshot(label: string): HelpContext {
  return {
    label,
    captured_at: label,
    selection: { kind: 'document', id: 'nas/index', heading: label },
    evidence: [
      {
        kind: 'original_text',
        text: `${label} selected body`,
        source: {
          kind: 'help_document',
          id: 'nas/index',
          revision: label,
          range: `${label} exact range`,
          retrieved_at: '2026-10-27T00:00:00Z',
        },
      },
    ],
  };
}

test('one authoritative source follows A→B, clears without automatic recapture, then updates only on a deliberate click', async () => {
  let source: HelpContext | null = snapshot('WORK-A');
  (request.get as jest.Mock).mockImplementation(async () => ({
    userId: 'owner',
    conversationId: 'native-help',
    context: source,
    created: false,
  }));
  (request.post as jest.Mock).mockImplementation(async (_url, body) => {
    source = body.source === null ? null : snapshot('EXPLICIT-UPDATE');
    return { context: source };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  const work = { conversationId, leafId: 'm1', messages: [{ messageId: 'm1' }] as TMessage[] };
  const view = (value = work) => (
    <QueryClientProvider client={client}>
      <HelpSource work={value} />
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(view());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('WORK-A'));
  screen.getAllByText('WORK-A selected body').forEach((body) => expect(body).not.toBeVisible());
  expect(screen.getByText('WORK-A exact range')).not.toBeVisible();
  expect(request.post).not.toHaveBeenCalled();
  source = snapshot('DOCUMENT-B');
  fireEvent.click(screen.getByText(/com_ui_help_view_source/));
  await screen.findByText('DOCUMENT-B exact range');
  expect(screen.queryByText('WORK-A exact range')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_help_without' }));
  await screen.findByText('com_ui_help_no_source');
  expect(request.post).toHaveBeenCalledTimes(1);
  expect(request.post).toHaveBeenLastCalledWith('/api/garden/help/context', { source: null });
  const later = {
    ...work,
    leafId: 'm2',
    messages: [{ messageId: 'm1' }, { messageId: 'm2', parentMessageId: 'm1' }] as TMessage[],
  };
  rerender(view(later));
  await client.invalidateQueries(['gardenHelpSession', mockUser.id]);
  await screen.findByText('com_ui_help_no_source');
  expect(request.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_help_update_chat' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('EXPLICIT-UPDATE'));
  expect(request.post).toHaveBeenLastCalledWith('/api/garden/help/context', {
    source: { conversationId, messageIds: ['m1', 'm2'], attachments: [] },
  });
  unmount();
  client.clear();
});

test('a failed read or changed identity hides the previous private source until the current server session is known', async () => {
  mockUser = { id: 'owner' };
  let failing = false;
  let release: ((value: unknown) => void) | undefined;
  (request.get as jest.Mock).mockImplementation(() => {
    if (failing) return Promise.reject(new Error('unavailable'));
    if (mockUser.id === 'other')
      return new Promise((resolve) => {
        release = resolve;
      });
    return Promise.resolve({
      userId: 'owner',
      conversationId: 'native-help',
      context: snapshot('PRIVATE-A'),
      created: false,
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const view = () => (
    <QueryClientProvider client={client}>
      <HelpSource />
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(view());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('PRIVATE-A'));
  failing = true;
  await client.invalidateQueries(['gardenHelpSession', 'owner']);
  await screen.findByText('com_ui_help_unavailable');
  expect(screen.queryByText('PRIVATE-A')).toBeNull();
  failing = false;
  mockUser = { id: 'other' };
  rerender(view());
  expect(screen.queryByText('PRIVATE-A')).toBeNull();
  await waitFor(() => expect(release).toBeDefined());
  release!({ userId: 'owner', conversationId: 'native-help', context: snapshot('PRIVATE-A') });
  await screen.findByText('com_ui_help_unavailable');
  expect(screen.queryByText('PRIVATE-A')).toBeNull();
  release = undefined;
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(release).toBeDefined());
  release!({ userId: 'other', conversationId: 'other-native-help', context: null, created: false });
  await screen.findByText('com_ui_help_no_source');
  unmount();
  client.clear();
  mockUser = { id: 'owner' };
});

test.each([
  'https://help.garden.key-solution.com.cn/nas/',
  'https://help.garden.key-solution.com.cn/nas/ · 第一步：登录 My Garden',
])('document links use the captured canonical URL in %s', async (label) => {
  const source = snapshot('NAS');
  source.label = label;
  const markdown = [
    '[完成注册](/account/register/)',
    '[找回密码说明](/account/recover/)',
    '[Windows](windows/)',
    '[账号](../account/)',
    '[下方说明](#卡片没有显示已启用)',
    '[My Garden](https://my.garden.key-solution.com.cn/)',
    '[邮件](mailto:help@example.com)',
    '[站点](//help.garden.key-solution.com.cn/)',
    '[脚本](javascript:alert%281%29)',
    '[数据](data:text/html,unsafe)',
    '[无效](https://[invalid)',
  ].join('\n\n');
  source.evidence[0].text = markdown;
  (request.get as jest.Mock).mockResolvedValue({ userId: 'owner', context: source });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <HelpSource />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('NAS'));
  fireEvent.click(screen.getByText('com_ui_help_view_source'));
  const destinations = {
    完成注册: 'https://help.garden.key-solution.com.cn/account/register/',
    找回密码说明: 'https://help.garden.key-solution.com.cn/account/recover/',
    Windows: 'https://help.garden.key-solution.com.cn/nas/windows/',
    账号: 'https://help.garden.key-solution.com.cn/account/',
    下方说明:
      'https://help.garden.key-solution.com.cn/nas/#%E5%8D%A1%E7%89%87%E6%B2%A1%E6%9C%89%E6%98%BE%E7%A4%BA%E5%B7%B2%E5%90%AF%E7%94%A8',
    'My Garden': 'https://my.garden.key-solution.com.cn/',
    邮件: 'mailto:help@example.com',
    站点: 'https://help.garden.key-solution.com.cn/',
  };
  for (const [name, href] of Object.entries(destinations)) {
    const link = await screen.findByRole('link', { name });
    expect(link).toHaveAttribute('href', href);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  }
  for (const name of ['脚本', '数据', '无效']) {
    expect(screen.getByText(name).closest('a')).not.toHaveAttribute('href');
  }
  expect(document.querySelector('pre')?.textContent).toBe(markdown);
  expect(request.post).not.toHaveBeenCalled();
  unmount();
  client.clear();
});

test.each(['not a URL', 'javascript:alert(1)', 'mailto:help@example.com'])(
  'an unusable canonical base %s never redirects relative links to Chat',
  async (label) => {
    const source = snapshot('NAS');
    source.label = label;
    source.evidence[0].text =
      '[注册](/account/register/) [文档](windows/) [章节](#section) [工作台](https://my.garden.key-solution.com.cn/)';
    (request.get as jest.Mock).mockResolvedValue({ userId: 'owner', context: source });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <HelpSource />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('NAS'));
    for (const name of ['注册', '文档', '章节']) {
      expect(screen.getByText(name).closest('a')).not.toHaveAttribute('href');
    }
    expect(screen.getByText('工作台').closest('a')).toHaveAttribute(
      'href',
      'https://my.garden.key-solution.com.cn/',
    );
    unmount();
    client.clear();
  },
);
