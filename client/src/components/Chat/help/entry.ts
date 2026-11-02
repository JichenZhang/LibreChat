import type { HelpSourceSelection } from 'librechat-data-provider';

const key = (userId: string) => `garden-help-entry-v2:${userId}`;
type Entry = {
  entryId: string;
  selection: HelpSourceSelection | null;
  consumed: boolean;
  messageId?: string;
};
const identity = (source: HelpSourceSelection | null) => JSON.stringify(source);

/** Only a descriptor is staged. Opening never captures or persists work.
 * sessionStorage belongs to the originating tab and its same-origin frame. */
export function stageHelpEntry(userId: string, selection: HelpSourceSelection | null) {
  const previous = readEntry(userId);
  const consumed =
    previous && identity(previous.selection) === identity(selection) ? previous.consumed : false;
  sessionStorage.setItem(
    key(userId),
    JSON.stringify({
      entryId:
        previous?.entryId && identity(previous.selection) === identity(selection)
          ? previous.entryId
          : crypto.randomUUID(),
      selection,
      consumed,
      ...(consumed ? { messageId: previous?.messageId } : {}),
    }),
  );
}
function readEntry(userId: string): Entry | null {
  try {
    return JSON.parse(sessionStorage.getItem(key(userId)) ?? 'null');
  } catch {
    return null;
  }
}
export function pendingHelpEntry(userId: string): HelpSourceSelection | null | undefined {
  const entry = readEntry(userId);
  if (!entry || entry.consumed) return undefined;
  return entry.selection;
}
export function consumeHelpEntry(userId: string, messageId?: string) {
  const entry = readEntry(userId);
  if (!entry) return;
  sessionStorage.setItem(key(userId), JSON.stringify({ ...entry, consumed: true, messageId }));
  const channel = new BroadcastChannel('garden-help:' + userId + ':' + helpChannelId(userId));
  channel.postMessage({
    type: 'consumed',
    entryId: entry.entryId,
    previousMessageId: entry.messageId,
    messageId,
  });
  channel.close();
}

export function helpChannelId(userId: string): string {
  const name = key(userId) + ':channel';
  let value = sessionStorage.getItem(name);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(name, value);
  }
  return value;
}

export function refreshPendingHelpEntry(
  userId: string,
  selection: HelpSourceSelection | undefined,
) {
  const entry = readEntry(userId);
  if (
    selection?.kind === 'chat' &&
    entry?.selection?.kind === 'chat' &&
    !entry.consumed &&
    selection.conversationId === entry.selection.conversationId
  )
    stageHelpEntry(userId, selection);
}

export function helpContextMessageId(userId: string): string | undefined {
  return readEntry(userId)?.messageId;
}

/** Only the matching originating entry may adopt an expanded tab's consumed anchor. */
export function receiveHelpEntry(
  userId: string,
  value: { entryId?: string; previousMessageId?: string; messageId?: string },
) {
  const entry = readEntry(userId);
  if (
    !entry ||
    !value.entryId ||
    entry.entryId !== value.entryId ||
    entry.messageId !== value.previousMessageId ||
    !value.messageId
  )
    return;
  sessionStorage.setItem(
    key(userId),
    JSON.stringify({ ...entry, consumed: true, messageId: value.messageId }),
  );
}
