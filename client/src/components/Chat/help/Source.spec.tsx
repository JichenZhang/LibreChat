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
