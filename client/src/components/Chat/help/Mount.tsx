import { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@librechat/client';
import type { HelpSourceSelection, TMessage } from 'librechat-data-provider';
import { stageHelpEntry, helpChannelId, refreshPendingHelpEntry } from './entry';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import useHelpSession from './useHelpSession';
import { currentWorkSource } from './Source';
import { setDraft } from '~/utils';

type Layout = { x: number; y: number; dock: 'left' | 'right' | null };
const key = 'garden-help-layout-v1';
const viewport = () => ({
  width: window.visualViewport?.width ?? innerWidth,
  height: window.visualViewport?.height ?? innerHeight,
  top: window.visualViewport?.offsetTop ?? 0,
});
function constrain(value?: Layout): Layout {
  const v = viewport();
  let width = v.width < 640 ? 48 : 144;
  if (v.width < 640 && value?.dock) width = 44;
  let x = Math.max(8, Math.min(value?.x ?? v.width - width - 16, v.width - width - 8));
  if (value?.dock === 'left') x = 0;
  else if (value?.dock === 'right') x = v.width - width;
  return {
    x,
    y: Math.max(
      8,
      Math.min(
        value?.y ?? v.height - (v.width < 640 ? 188 : 80),
        v.height - (v.width < 640 ? 188 : 80),
      ),
    ),
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
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [view, setView] = useState(viewport);
  const [ready, setReady] = useState(false);

  const opener = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const drag = useRef<{ x: number; y: number; start: Layout; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const opening = useRef(false);
  const actor = useRef(user?.id);
  actor.current = user?.id;
  const session = useHelpSession(started);

  const show = async (selection?: HelpSourceSelection | null) => {
    setStarted(true);
    setOpened(true);
    if (opening.current || !user?.id) return;
    opening.current = true;
    const userId = user.id;
    stageHelpEntry(
      userId,
      selection === undefined
        ? (currentWorkSource({ conversationId, leafId, messages }) ?? null)
        : selection,
    );
    try {
      await session.refetch({ cancelRefetch: false });
      if (actor.current !== userId) return;
    } finally {
      opening.current = false;
      if (actor.current === userId) setReady(true);
    }
  };
  useEffect(() => {
    const open = (event: Event) => {
      void show((event as CustomEvent<HelpSourceSelection>).detail);
    };
    window.addEventListener('garden-help-open', open);
    return () => window.removeEventListener('garden-help-open', open);
  });
  useEffect(() => {
    if (opened && user?.id)
      refreshPendingHelpEntry(user.id, currentWorkSource({ conversationId, leafId, messages }));
  }, [opened, user?.id, conversationId, leafId, messages]);
  const persist = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Layout failure does not interrupt chat. */
    }
  };
  useEffect(() => {
    opening.current = false;
    setOpened(false);
    setStarted(false);
    setReady(false);
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
  const close = () => {
    setOpened(false);
  };
  useEffect(() => {
    // The launcher is unmounted while open. Restore focus only after React
    // has committed its return, rather than focusing a null ref in close().
    if (started && !opened) opener.current?.focus();
  }, [opened, started]);
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
  if (
    !config?.gardenHelp ||
    new URLSearchParams(location.search).has('gardenHelp') ||
    conversationId === session.data?.conversationId
  )
    return null;
  const expand = () => {
    const url = frame.current?.src;
    if (!url) return;
    const input = frame.current?.contentDocument?.querySelector<HTMLTextAreaElement>('textarea');
    if (session.data && input) setDraft({ id: session.data.conversationId, value: input.value });
    if (user?.id) helpChannelId(user.id);
    const tab = window.open(url, '_blank');
    if (!tab) {
      setPopupBlocked(true);
      return;
    }
    tab.opener = null;
    tab.focus();
    setPopupBlocked(false);
    close();
  };
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
  let launcherWidth = mobile ? 48 : 144;
  if (docked) launcherWidth = 44;
  return (
    <>
      {!opened && (
        <div
          className="fixed z-50 flex items-center"
          style={{ left: layout.x, top: view.top + layout.y }}
        >
          <button
            ref={opener}
            type="button"
            title={localize('com_ui_help_move')}
            aria-label={localize('com_ui_help_name')}
            style={{
              width: launcherWidth,
              height: docked ? 64 : 48,
              touchAction: 'none',
            }}
            className="garden-help-launcher relative flex items-center justify-center gap-2 rounded-full border border-border-light bg-surface-primary text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy"
            {...dragProps}
            onClick={(event) => {
              if (event.detail !== 0 && suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              suppressClick.current = false;
              void show();
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
            {!docked && <HelpCircle aria-hidden="true" className={mobile ? 'size-6' : 'size-4'} />}
            {!docked && !mobile && localize('com_ui_help_name')}
          </button>
        </div>
      )}
      {started && (
        <section
          aria-label={localize('com_ui_help_name')}
          hidden={!opened}
          className="garden-help-panel fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border-light bg-surface-primary text-text-primary"
          style={{
            display: opened ? 'flex' : 'none',
            left: mobile ? 8 : Math.max(8, Math.min(layout.x, view.width - 428)),
            top: view.top + Math.max(8, Math.min(layout.y - 520, view.height - 640)),
            width: Math.min(420, view.width - 16),
            height: Math.min(620, view.height - 16),
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
                  variant="ghost"
                  className="min-h-11"
                  onClick={(event) => {
                    persist(constrain({ ...layout, dock: 'right' }));
                    event.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                >
                  {localize('com_ui_help_dock')}
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={(event) => {
                    persist(constrain());
                    event.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                >
                  {localize('com_ui_help_reset')}
                </Button>
              </div>
            </details>
            <Button variant="ghost" className="min-h-11" onClick={expand}>
              {localize('com_ui_help_expand')}
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={close}>
              {localize('com_ui_close')}
            </Button>
          </header>
          {popupBlocked && <p role="alert">{localize('com_ui_help_popup_blocked')}</p>}
          {session.isError && (
            <div role="alert" className="p-4">
              <p>{localize('com_ui_help_unavailable')}</p>
              <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
            </div>
          )}
          {session.isLoading && <p role="status">{localize('com_ui_loading')}</p>}
          {ready && session.data && (
            <iframe
              ref={frame}
              data-garden-help-panel="true"
              onFocus={() => {
                void session.refetch({ cancelRefetch: false });
              }}
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
