import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@librechat/client';
import { HelpCircle, GripVertical } from 'lucide-react';
import { QueryKeys, request } from 'librechat-data-provider';
import type { HelpContext, TMessage } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

type Layout = { x: number; y: number; dock: 'left' | 'right' | null };
const key = 'garden-help-layout-v1';
const viewport = () => ({
  width: window.visualViewport?.width ?? innerWidth,
  height: window.visualViewport?.height ?? innerHeight,
  top: window.visualViewport?.offsetTop ?? 0,
});
function constrain(value?: Layout): Layout {
  const v = viewport();
  let width = v.width < 640 ? 48 : 172;
  if (v.width < 640 && value?.dock) width = 44;
  let x = Math.max(8, Math.min(value?.x ?? v.width - width - 16, v.width - width - 8));
  if (value?.dock === 'left') x = 0;
  else if (value?.dock === 'right') x = v.width - width;
  return {
    x,
    y: Math.max(8, Math.min(value?.y ?? v.height - (v.width < 640 ? 188 : 80), v.height - 80)),
    dock: value?.dock ?? null,
  };
}
function storedLayout(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      value &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      [null, 'left', 'right'].includes(value.dock)
    )
      return constrain(value);
  } catch {
    /* Browser storage is an optional layout preference. */
  }
  return constrain();
}

export default function HelpMount({
  conversationId,
  leafId,
  messages,
}: {
  conversationId?: string | null;
  leafId?: string;
  messages: TMessage[] | null;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { data: config } = useGetStartupConfig();
  const [layout, setLayout] = useState(storedLayout);
  const [opened, setOpened] = useState(false);
  const [started, setStarted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState(viewport);
  const [context, setContext] = useState<HelpContext | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const [attachmentChoices, setAttachmentChoices] = useState<
    Record<string, 'metadata' | 'content'>
  >({});
  const opener = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const drag = useRef<{ x: number; y: number; start: Layout; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const initialized = useRef(false);
  const session = useQuery<{
    conversationId: string;
    subject: string;
    context: HelpContext | null;
    siteURL: string;
  }>({
    queryKey: [QueryKeys.gardenHelpSession, user?.id],
    queryFn: () => request.get('/api/garden/help/session'),
    enabled: started,
    staleTime: 0,
    retry: false,
  });
  const update = useMutation({
    mutationFn: async (clear: boolean) => {
      const byId = new Map((messages ?? []).map((item) => [item.messageId, item]));
      const ids: string[] = [];
      let current = leafId;
      while (current && byId.has(current) && ids.length < 16) {
        ids.unshift(current);
        current = byId.get(current)?.parentMessageId ?? undefined;
      }
      const attachments = ids.flatMap((id) =>
        (byId.get(id)?.files ?? []).flatMap((file) => {
          const choice = attachmentChoices[`${id}/${file.file_id}`];
          return choice
            ? [{ messageId: id, fileId: file.file_id, content: choice === 'content' }]
            : [];
        }),
      );
      return request.post('/api/garden/help/context', {
        source:
          !clear && ids.length && conversationId
            ? { conversationId, messageIds: ids, attachments }
            : null,
      }) as Promise<{ context: HelpContext | null }>;
    },
    onSuccess: (value) => {
      setContext(value.context);
      setSourceError(false);
    },
    onError: () => setSourceError(true),
  });
  const persist = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Layout failure does not interrupt chat. */
    }
  };
  useEffect(() => {
    initialized.current = false;
    setOpened(false);
    setStarted(false);
    setContext(null);
    setSourceError(false);
    setAttachmentChoices({});
  }, [user?.id]);
  useEffect(() => {
    const resize = () => {
      setView(viewport());
      setLayout((old) => constrain(old));
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, []);
  useEffect(() => {
    if (!session.data || initialized.current) return;
    initialized.current = true;
    setContext(session.data.context);
    if (!session.data.context && leafId) update.mutate(false);
  }, [session.data, leafId, update]);
  const close = () => {
    setOpened(false);
    setExpanded(false);
    opener.current?.focus();
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== 'garden-help-close'
      )
        return;
      close();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  if (!config?.gardenHelp || new URLSearchParams(location.search).has('gardenHelp')) return null;
  const mobile = view.width < 640;
  const docked = mobile && layout.dock != null;
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, start: layout, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const origin = drag.current;
    if (!origin) return;
    const dx = event.clientX - origin.x,
      dy = event.clientY - origin.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) origin.moved = true;
    if (origin.moved)
      setLayout(constrain({ x: origin.start.x + dx, y: origin.start.y + dy, dock: null }));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const origin = drag.current;
    if (!origin) return;
    drag.current = null;
    if (!origin.moved) return;
    suppressClick.current = true;
    // Only suppress the click synthesized by this release, never the next deliberate tap.
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    let dock: Layout['dock'] = null;
    if (mobile && (event.clientX <= 12 || layout.x <= 12)) dock = 'left';
    else if (mobile && (event.clientX >= view.width - 12 || layout.x + 48 >= view.width - 12))
      dock = 'right';
    persist(constrain({ ...layout, dock }));
  };
  const dragProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: () => {
      if (drag.current) setLayout(drag.current.start);
      drag.current = null;
    },
  };
  let launcherWidth = mobile ? 48 : 128;
  if (docked) launcherWidth = 44;
  return (
    <>
      {!opened && (
        <div
          className="fixed z-50 flex items-center"
          style={{ left: layout.x, top: view.top + layout.y }}
        >
          {!mobile && (
            <button
              type="button"
              className="min-h-11 min-w-11 touch-none rounded-l-xl border border-border-light bg-surface-primary"
              aria-label={localize('com_ui_help_move')}
              title={localize('com_ui_help_move')}
              {...dragProps}
            >
              <GripVertical className="mx-auto size-4" />
            </button>
          )}
          <button
            ref={opener}
            type="button"
            title="Garden Help"
            aria-label="Garden Help"
            style={{
              width: launcherWidth,
              height: docked ? 64 : 48,
              touchAction: 'none',
            }}
            className="relative rounded-full border border-border-light bg-surface-primary text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy"
            {...(mobile ? dragProps : {})}
            onClick={(event) => {
              if (event.detail !== 0 && suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              suppressClick.current = false;
              setStarted(true);
              setOpened(true);
            }}
          >
            {docked && (
              <span
                aria-hidden="true"
                className="absolute top-0 flex h-16 w-6 items-center justify-center rounded-xl bg-surface-tertiary text-xl"
                style={{ [layout.dock === 'left' ? 'left' : 'right']: 0 }}
              >
                ?
              </span>
            )}
            {!docked && mobile && <HelpCircle className="mx-auto size-6" />}
            {!docked && !mobile && 'Garden Help'}
          </button>
        </div>
      )}
      {started && (
        <section
          aria-label="Garden Help"
          hidden={!opened}
          className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border-light bg-surface-primary text-text-primary"
          style={{
            display: opened ? 'flex' : 'none',
            ...(expanded
              ? { left: 8, right: 8, top: view.top + 8, height: view.height - 16 }
              : {
                  left: mobile ? 8 : Math.max(8, Math.min(layout.x, view.width - 428)),
                  top: view.top + Math.max(8, Math.min(layout.y - 520, view.height - 640)),
                  width: Math.min(420, view.width - 16),
                  height: Math.min(620, view.height - 16),
                }),
          }}
        >
          <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-light px-3">
            <h2 className="mr-auto font-semibold">{localize('com_ui_help_title')}</h2>
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center">
                {localize('com_ui_help_position')}
              </summary>
              <div className="absolute right-2 z-10 flex flex-col border border-border-light bg-surface-primary p-2">
                <Button
                  className="min-h-11"
                  onClick={() => persist(constrain({ ...layout, dock: 'right' }))}
                >
                  {localize('com_ui_help_dock')}
                </Button>
                <Button className="min-h-11" onClick={() => persist(constrain())}>
                  {localize('com_ui_help_reset')}
                </Button>
              </div>
            </details>
            <Button className="min-h-11" onClick={() => setExpanded(!expanded)}>
              {localize(expanded ? 'com_ui_collapse' : 'com_ui_expand')}
            </Button>
            <Button className="min-h-11" onClick={close}>
              {localize('com_ui_close')}
            </Button>
          </header>
          <details className="shrink-0 border-b border-border-light px-3 text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center">
              {localize('com_ui_help_source')} · {context?.evidence.length ?? 0}
            </summary>
            <div
              className="max-h-40 overflow-y-auto"
              tabIndex={0}
              role="region"
              aria-label={localize('com_ui_help_source')}
            >
              {context?.evidence.map((item) => (
                <p key={item.source.id} className="whitespace-pre-wrap">
                  {[item.source.range, item.text ?? item.name].join('\n')}
                </p>
              ))}
            </div>
            <fieldset className="max-h-40 overflow-y-auto">
              <legend>{localize('com_ui_help_attachments')}</legend>
              {(messages ?? []).flatMap((message) =>
                (message.files ?? []).map((file) => {
                  const id = `${message.messageId}/${file.file_id}`;
                  return (
                    <label key={id} className="flex min-h-11 items-center justify-between gap-2">
                      <span>{file.filename}</span>
                      <select
                        value={attachmentChoices[id] ?? ''}
                        onChange={(event) =>
                          setAttachmentChoices((old) => {
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
            <div className="flex gap-2">
              <Button disabled={update.isLoading} onClick={() => update.mutate(true)}>
                {localize('com_ui_help_without')}
              </Button>
              <Button disabled={update.isLoading} onClick={() => update.mutate(false)}>
                {localize('com_ui_help_update')}
              </Button>
            </div>
          </details>
          {sourceError && <p role="alert">{localize('com_ui_help_source_error')}</p>}
          {session.isError && (
            <div role="alert" className="p-4">
              <p>{localize('com_ui_help_unavailable')}</p>
              <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
            </div>
          )}
          {session.isLoading && <p role="status">{localize('com_ui_loading')}</p>}
          {session.data && (
            <iframe
              ref={frame}
              title="Garden Help"
              className="min-h-0 w-full flex-1 border-0"
              src={`/c/${encodeURIComponent(session.data.conversationId)}?gardenHelp=1`}
              onLoad={() => frame.current?.focus()}
            />
          )}
        </section>
      )}
    </>
  );
}
