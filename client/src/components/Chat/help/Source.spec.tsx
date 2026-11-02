import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import {
  stageHelpEntry,
  pendingHelpEntry,
  consumeHelpEntry,
  receiveHelpEntry,
  helpContextMessageId,
} from './entry';
import HelpSource, { currentWorkSource } from './Source';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
let posted: { entryId: string; previousMessageId?: string; messageId?: string };
beforeEach(() => {
  Object.defineProperty(global, 'BroadcastChannel', {
    configurable: true,
    value: class {
      postMessage(value: typeof posted) {
        posted = value;
      }

      close() {}
    },
  });
});
afterEach(() => sessionStorage.clear());
const selected = { kind: 'chat' as const, conversationId: 'work-A', messageIds: ['one'] };
test('opening only stages a tab-local descriptor; first send consumes it and continuation does not recapture', () => {
  stageHelpEntry('alice', selected);
  expect(pendingHelpEntry('alice')).toEqual(selected);
  consumeHelpEntry('alice');
  stageHelpEntry('alice', selected);
  expect(pendingHelpEntry('alice')).toBeUndefined();
  stageHelpEntry('alice', { ...selected, conversationId: 'work-B' });
  expect(pendingHelpEntry('alice')?.kind).toBe('chat');
  expect(pendingHelpEntry('bob')).toBeUndefined();
});
test('same-page draft reopening retains origin; different semantic settings entry replaces descriptor only', () => {
  stageHelpEntry('alice', selected);
  stageHelpEntry('alice', { kind: 'settings', tab: 'account' });
  expect(pendingHelpEntry('alice')).toEqual({ kind: 'settings', tab: 'account' });
});
test('selection follows the visible bounded branch and excludes attachments unless explicitly selected', () => {
  const messages = [
    { messageId: 'one', parentMessageId: null, files: [{ file_id: 'private' }] },
    { messageId: 'two', parentMessageId: 'one' },
    { messageId: 'sibling', parentMessageId: 'one' },
  ] as TMessage[];
  expect(currentWorkSource({ conversationId: 'work', leafId: 'two', messages })).toEqual({
    kind: 'chat',
    conversationId: 'work',
    messageIds: ['one', 'two'],
    attachments: [],
  });
});
test('no old conversation-wide source wall; hints are historical messages with optional details', () => {
  const context = { label: 'Settings · account', evidence: [], captured_at: 'now' };
  const messages = [
    {
      conversationId: 'help',
      parentMessageId: null,
      sender: 'User',
      messageId: 'a',
      isCreatedByUser: true,
      text: 'Synthetic question',
      metadata: { gardenHelpContext: { context, status: 'captured' } },
    },
  ] as TMessage[];
  const { rerender } = render(<HelpSource messages={messages} />);
  expect(screen.getByText('Settings · account')).not.toBeVisible();
  expect(screen.getByText(/Synthetic question/)).toBeVisible();
  rerender(<HelpSource messages={[]} />);
  expect(screen.queryByText('Settings · account')).toBeNull();
});
test('capture failure is truthful and never displays a previous source', () => {
  render(
    <HelpSource
      messages={
        [
          {
            conversationId: 'help',
            parentMessageId: null,
            sender: 'User',
            messageId: 'b',
            isCreatedByUser: true,
            text: 'Question',
            metadata: { gardenHelpContext: { context: null, status: 'unavailable' } },
          },
        ] as TMessage[]
      }
    />,
  );
  expect(screen.getByText(/com_ui_help_source_error/)).toBeVisible();
});

test('expanded consumption synchronizes both ways, rejects a different entry/account and never revives a newer anchor', () => {
  stageHelpEntry('alice', selected);
  const origin = sessionStorage.getItem('garden-help-entry-v2:alice')!;
  consumeHelpEntry('alice', 'expanded-first');
  const expanded = sessionStorage.getItem('garden-help-entry-v2:alice')!;
  const firstEvent = posted;
  sessionStorage.setItem('garden-help-entry-v2:alice', origin);
  receiveHelpEntry('bob', firstEvent);
  expect(helpContextMessageId('bob')).toBeUndefined();
  receiveHelpEntry('alice', firstEvent);
  expect(pendingHelpEntry('alice')).toBeUndefined();
  expect(helpContextMessageId('alice')).toBe('expanded-first');
  consumeHelpEntry('alice', 'origin-second');
  const secondEvent = posted;
  sessionStorage.setItem('garden-help-entry-v2:alice', expanded);
  receiveHelpEntry('alice', secondEvent);
  receiveHelpEntry('alice', firstEvent);
  expect(helpContextMessageId('alice')).toBe('origin-second');
  stageHelpEntry('alice', { kind: 'settings', tab: 'account' });
  receiveHelpEntry('alice', secondEvent);
  expect(pendingHelpEntry('alice')).toEqual({ kind: 'settings', tab: 'account' });
  expect(helpContextMessageId('alice')).toBeUndefined();
});
