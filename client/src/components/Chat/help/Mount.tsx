import { useEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { GripHorizontal, HelpCircle, Maximize2, X } from 'lucide-react';
import type { HelpSourceSelection, TMessage } from 'librechat-data-provider';
import { stageHelpEntry, helpChannelId, refreshPendingHelpEntry } from './entry';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import useHelpSession from './useHelpSession';
import { currentWorkSource } from './Source';
import { setDraft } from '~/utils';

type Point = { x: number; y: number };
type Layout = Point & { dock: 'left' | 'right' | null; panel?: Point };
const key = 'garden-help-layout-v1';
const viewport = () => ({
  width: window.visualViewport?.width ?? innerWidth,
  height: window.visualViewport?.height ?? innerHeight,
  top: window.visualViewport?.offsetTop ?? 0,
});
function panelBounds(value: Layout, view: ReturnType<typeof viewport>) {
  const width = Math.min(420, view.width - 16);
  const height = Math.min(620, view.height - 16);
  return {
    x: Math.max(8, Math.min(value.panel?.x ?? value.x, view.width - width - 8)),
    y: Math.max(8, Math.min(value.panel?.y ?? value.y - 520, view.height - height - 8)),
    width,
    height,
  };
}
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
    ...(Number.isFinite(value?.panel?.x) && Number.isFinite(value?.panel?.y)
      ? { panel: value?.panel }
      : {}),
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
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    start: Layout;
    next: Layout;
    moved: boolean;
    pointerId: number;
    panel?: Point;
  } | null>(null);
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
  const bounds = panelBounds(layout, view);
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || drag.current) return;
    const isHeader = event.currentTarget.tagName === 'HEADER';
    if (isHeader && (event.target as Element).closest('[data-help-control]')) return;
    const rect = isHeader ? panel.current?.getBoundingClientRect() : undefined;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      start: layout,
      next: layout,
      moved: false,
      pointerId: event.pointerId,
      ...(rect ? { panel: { x: rect.left, y: rect.top - view.top } } : {}),
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const origin = drag.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = event.clientX - origin.x,
      dy = event.clientY - origin.y;
    if (origin.panel ? dx !== 0 || dy !== 0 : Math.abs(dx) + Math.abs(dy) > 6) origin.moved = true;
    if (!origin.moved) return;
    if (origin.panel) {
      const next = panelBounds(
        { ...origin.start, panel: { x: origin.panel.x + dx, y: origin.panel.y + dy } },
        view,
      );
      origin.next = { ...origin.start, panel: { x: next.x, y: next.y } };
    } else {
      origin.next = constrain({ x: origin.start.x + dx, y: origin.start.y + dy, dock: null });
    }
    setLayout(origin.next);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const origin = drag.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!origin.moved) return;
    if (origin.panel) {
      persist(origin.next);
      return;
    }
    suppressClick.current = true;
    // Suppress only the click synthesized by a launcher drag.
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    let dock: Layout['dock'] = null;
    if (mobile && (event.clientX <= 12 || origin.next.x <= 12)) dock = 'left';
    else if (mobile && (event.clientX >= view.width - 12 || origin.next.x + 48 >= view.width - 12))
      dock = 'right';
    persist(constrain({ ...origin.next, dock }));
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
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      persist(constrain());
      return;
    }
    const step = event.shiftKey ? 40 : 10;
    const offsets: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const next = panelBounds(
      { ...layout, panel: { x: bounds.x + offset.x, y: bounds.y + offset.y } },
      view,
    );
    persist({ ...layout, panel: { x: next.x, y: next.y } });
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
          ref={panel}
          aria-label={localize('com_ui_help_name')}
          hidden={!opened}
          className="garden-help-panel fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border-light bg-surface-primary text-text-primary"
          style={{
            display: opened ? 'flex' : 'none',
            left: bounds.x,
            top: view.top + bounds.y,
            width: bounds.width,
            height: bounds.height,
          }}
        >
          <header
            className="relative flex h-12 shrink-0 cursor-grab touch-none select-none items-center border-b border-border-light px-2 active:cursor-grabbing"
            {...dragProps}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
            }}
          >
            <h2 className="mr-auto min-w-0 truncate text-sm font-semibold">
              {localize('com_ui_help_title')}
            </h2>
            <button
              type="button"
              aria-label={localize('com_ui_help_window_move')}
              title={localize('com_ui_help_window_move')}
              aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
              className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-md text-text-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy active:cursor-grabbing"
              onKeyDown={moveByKeyboard}
            >
              <GripHorizontal aria-hidden="true" className="size-4" />
            </button>
            <Button
              data-help-control="true"
              variant="ghost"
              className="size-11 shrink-0 p-0"
              aria-label={localize('com_ui_help_expand')}
              title={localize('com_ui_help_expand_hint')}
              onClick={expand}
            >
              <Maximize2 aria-hidden="true" className="size-4" />
            </Button>
            <Button
              data-help-control="true"
              variant="ghost"
              className="size-11 shrink-0 p-0"
              aria-label={localize('com_ui_close')}
              title={localize('com_ui_close')}
              onClick={close}
            >
              <X aria-hidden="true" className="size-4" />
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
