import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@librechat/client';
import { ChevronDown, FileText } from 'lucide-react';
import { useIsMutating } from '@tanstack/react-query';
import type { HelpSourceSelection, TMessage } from 'librechat-data-provider';
import useHelpSession, { helpSourceSelection, useHelpSourceUpdate } from './useHelpSession';
import { useAuthContext, useLocalize } from '~/hooks';

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

/** The native iframe uses its host's identical controls, including when expanded.
 * This marker changes presentation only; JWT/session always decides authority. */
export function hostedHelpSource() {
  try {
    return (
      window.parent !== window && !!window.frameElement?.hasAttribute('data-garden-help-panel')
    );
  } catch {
    return false;
  }
}

export default function HelpSource({
  work,
  active = true,
}: {
  work?: WorkSource;
  active?: boolean;
}) {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const session = useHelpSession(active);
  const update = useHelpSourceUpdate();
  const pending = useIsMutating({ mutationKey: ['gardenHelpSource', user?.id] }) > 0;
  const [choices, setChoices] = useState<Record<string, 'metadata' | 'content'>>({});
  const context = session.data?.context ?? null;
  useEffect(() => {
    const selected = helpSourceSelection(context);
    setChoices(
      selected?.kind === 'chat' && selected.conversationId === work?.conversationId
        ? Object.fromEntries(
            (selected.attachments ?? []).map((a) => [
              `${a.messageId}/${a.fileId}`,
              a.content ? 'content' : 'metadata',
            ]),
          )
        : {},
    );
  }, [context, work?.conversationId, user?.id]);
  const busy = session.isLoading || session.isFetching || pending;
  const known = !!session.data && !session.isError && !busy;
  const selected = helpSourceSelection(context);
  const proposal = work ? currentWorkSource(work, choices) : undefined;
  const attachmentMessages = (work?.messages ?? []).filter(
    (message) => proposal?.kind === 'chat' && proposal.messageIds.includes(message.messageId),
  );
  let sourceLabel = localize(session.isError ? 'com_ui_help_unavailable' : 'com_ui_loading');
  if (known) {
    sourceLabel = localize('com_ui_help_no_source');
    if (context) {
      sourceLabel = localize('com_ui_help_chat_source');
      if (selected?.kind === 'document') {
        sourceLabel =
          selected.heading ||
          context.evidence[0]?.text?.match(/^#{1,6}\s+(.+)$/m)?.[1] ||
          localize('com_ui_help_document_source');
      }
    }
  }
  const apply = async (clear: boolean) => {
    if (!user?.id) return;
    const userId = user.id;
    const intended = proposal; // Freeze this work branch at the user's click.
    const current = await session.refetch({ cancelRefetch: false });
    if (!current.data || current.isError) return;
    const selection = clear ? null : (intended ?? helpSourceSelection(current.data.context));
    if (selection === undefined) return;
    update.mutate({ selection, userId });
  };
  return (
    <section
      aria-label={localize('com_ui_help_source')}
      className="garden-help-source shrink-0 border-b border-border-light px-3 py-2 text-sm text-text-primary"
    >
      <details
        className="group"
        onToggle={(event) => {
          if (event.currentTarget.open) void session.refetch({ cancelRefetch: false });
        }}
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
          <span role="status" className="min-w-0 flex-1 break-words font-medium">
            {sourceLabel}
          </span>
          <span className="shrink-0 text-xs text-text-secondary">
            {localize('com_ui_help_view_source')}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open:rotate-180" />
        </summary>
        <div className="garden-help-source-body max-h-64 overflow-y-auto overscroll-contain py-2">
          {known && context && (
            <div
              className="space-y-3 break-words"
              tabIndex={0}
              role="region"
              aria-label={localize('com_ui_help_source_details')}
            >
              {context.evidence.map((item) => (
                <div
                  key={item.source.id}
                  className="garden-help-source-text border-t border-border-light pt-2"
                >
                  {item.source.kind === 'help_document' ? (
                    <ReactMarkdown
                      skipHtml
                      components={{
                        // Reviewing a source must not load remote images or execute HTML.
                        img: ({ alt }) => <span>{alt}</span>,
                        a: ({ children, href }) => (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {item.text ?? item.name ?? ''}
                    </ReactMarkdown>
                  ) : (
                    <p className="whitespace-pre-wrap">{item.text ?? item.name}</p>
                  )}
                  {item.content_base64 && (
                    <a
                      className="underline"
                      href={`data:application/octet-stream;base64,${item.content_base64}`}
                      download={item.name}
                    >
                      {localize('com_ui_help_download')} · {item.media_type}
                    </a>
                  )}
                  <details className="mt-2 text-xs text-text-secondary">
                    <summary className="flex min-h-11 cursor-pointer items-center underline-offset-4 hover:underline">
                      {localize('com_ui_help_source_record')}
                    </summary>
                    <p>{context.label}</p>
                    <p>{context.captured_at}</p>
                    <p>{item.source.id}</p>
                    <p>{item.source.range}</p>
                    <p>{item.source.revision}</p>
                    <pre className="whitespace-pre-wrap font-sans">{item.text ?? item.name}</pre>
                  </details>
                </div>
              ))}
            </div>
          )}
          {attachmentMessages.some((message) => message.files?.length) && (
            <fieldset className="mt-3" disabled={!known}>
              <legend>{localize('com_ui_help_attachments')}</legend>
              {attachmentMessages.flatMap((message) =>
                (message.files ?? []).map((file) => {
                  const id = `${message.messageId}/${file.file_id}`;
                  return (
                    <label key={id} className="flex min-h-11 items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 break-words">{file.filename}</span>
                      <select
                        value={choices[id] ?? ''}
                        onChange={(event) =>
                          setChoices((old) => {
                            const next = { ...old };
                            if (event.target.value)
                              next[id] = event.target.value as 'metadata' | 'content';
                            else delete next[id];
                            return next;
                          })
                        }
                      >
                        <option value="">{localize('com_ui_help_exclude')}</option>
                        <option value="metadata">{localize('com_ui_help_metadata')}</option>
                        <option value="content">{localize('com_ui_help_content')}</option>
                      </select>
                    </label>
                  );
                }),
              )}
            </fieldset>
          )}
        </div>
      </details>
      <div className="flex flex-wrap gap-x-2">
        <Button
          variant="ghost"
          className="min-h-11 px-2 font-normal text-text-secondary"
          disabled={!known || !context}
          onClick={() => apply(true)}
        >
          {localize('com_ui_help_without')}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11 px-2 font-normal text-text-secondary"
          disabled={!known || (!proposal && !selected)}
          onClick={() => apply(false)}
        >
          {localize(proposal ? 'com_ui_help_update_chat' : 'com_ui_help_update')}
        </Button>
      </div>
      {known && !context && !proposal && <p>{localize('com_ui_help_choose_source')}</p>}
      {update.isError && <p role="alert">{localize('com_ui_help_source_error')}</p>}
      {session.isError && (
        <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
      )}
    </section>
  );
}
