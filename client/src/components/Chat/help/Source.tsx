import type { HelpSourceSelection, HelpTurnContext, TMessage } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export type WorkSource = {
  conversationId?: string | null;
  leafId?: string;
  messages: TMessage[] | null;
};
export function currentWorkSource(
  work: WorkSource,
  choices: Record<string, 'metadata' | 'content'> = {},
): HelpSourceSelection | undefined {
  const byId = new Map((work.messages ?? []).map((item) => [item.messageId, item]));
  const ids: string[] = [];
  let current = work.leafId;
  while (current && byId.has(current) && ids.length < 16 && !ids.includes(current)) {
    ids.unshift(current);
    current = byId.get(current)?.parentMessageId ?? undefined;
  }
  if (!ids.length || !work.conversationId) return;
  return {
    kind: 'chat',
    conversationId: work.conversationId,
    messageIds: ids,
    attachments: ids.flatMap((id) =>
      (byId.get(id)?.files ?? []).flatMap((file) => {
        if (!file.file_id) return [];
        const choice = choices[`${id}/${file.file_id}`];
        return choice
          ? [{ messageId: id, fileId: file.file_id, content: choice === 'content' }]
          : [];
      }),
    ),
  };
}

/** Historical, message-bound hints. Reading never updates background. */
export default function HelpSource({ messages }: { messages: TMessage[] | null }) {
  const localize = useLocalize();
  return (
    <div className="px-3 text-sm text-text-secondary">
      {(messages ?? [])
        .filter((message) => message.isCreatedByUser && message.metadata?.gardenHelpContext != null)
        .map((message) => {
          const binding = message.metadata!.gardenHelpContext as HelpTurnContext;
          if (binding.status === 'none') return null;
          return (
            <details key={message.messageId} className="my-2">
              <summary className="min-h-11 cursor-pointer break-words">
                {localize(
                  binding.status === 'unavailable'
                    ? 'com_ui_help_source_error'
                    : 'com_ui_help_message_context',
                )}{' '}
                · {message.text.slice(0, 48)}
              </summary>
              {binding.context && (
                <div>
                  <p>{binding.context.label}</p>
                  <p>{binding.context.captured_at}</p>
                  {binding.context.evidence.map((item) => (
                    <pre key={item.source.id} className="whitespace-pre-wrap break-words font-sans">
                      {item.text ?? item.name}
                    </pre>
                  ))}
                </div>
              )}
            </details>
          );
        })}
    </div>
  );
}
