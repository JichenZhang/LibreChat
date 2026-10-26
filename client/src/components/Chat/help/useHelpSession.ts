import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, request } from 'librechat-data-provider';
import type { HelpContext, HelpSession, HelpSourceSelection } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';

/** Older native snapshots predate the explicit recipe. Reconstruct only their
 * already selected IDs; never search for or append later work messages. */
export function helpSourceSelection(context: HelpContext | null): HelpSourceSelection | undefined {
  if (context?.selection) return context.selection;
  const evidence = context?.evidence ?? [];
  if (evidence.length === 1 && evidence[0].source.kind === 'help_document') {
    const match = evidence[0].source.id.match(/^([a-z0-9]+(?:[/-][a-z0-9]+)*)(?:#section=(\d+))?$/);
    if (!match) return;
    const heading = context!.label.split(' · ').slice(1).join(' · ');
    if (match[2] !== undefined && !heading) return;
    return {
      kind: 'document',
      id: match[1],
      ...(match[2] === undefined ? {} : { section: Number(match[2]), heading }),
    };
  }
  const rows = evidence
    .filter((e) => e.kind === 'original_text')
    .map((e) => e.source.id.split('/'));
  if (
    !rows.length ||
    evidence.some((e) => e.source.kind !== 'librechat_message') ||
    rows.some((parts) => parts.length !== 2 || parts[0] !== rows[0][0])
  )
    return;
  const attachments = evidence
    .filter((e) => e.kind !== 'original_text')
    .map((e) => {
      const parts = e.source.id.split('/');
      if (
        parts.length !== 5 ||
        parts[0] !== rows[0][0] ||
        parts[2] !== 'attachment' ||
        !rows.some((row) => row[1] === parts[1]) ||
        !['metadata', 'content'].includes(parts[4])
      )
        return;
      return { messageId: parts[1], fileId: parts[3], content: parts[4] === 'content' };
    });
  if (attachments.some((a) => !a)) return;
  return {
    kind: 'chat',
    conversationId: rows[0][0],
    messageIds: rows.map((row) => row[1]),
    attachments: attachments as { messageId: string; fileId: string; content: boolean }[],
  };
}

export default function useHelpSession(enabled = true) {
  const { user } = useAuthContext();
  const identity = useRef(user?.id);
  identity.current = user?.id;
  return useQuery<HelpSession>({
    queryKey: [QueryKeys.gardenHelpSession, user?.id],
    queryFn: async () => {
      const expected = user?.id;
      if (!expected) throw new Error('UNAUTHENTICATED');
      const session = await request.get<HelpSession>('/api/garden/help/session');
      if (session.userId !== expected || identity.current !== expected)
        throw new Error('IDENTITY_CHANGED');
      return session;
    },
    enabled: enabled && !!user?.id,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
}

/** Existing native context APIs, with one cache and no optimistic source copy. */
export function useHelpSourceUpdate() {
  const { user } = useAuthContext();
  const actor = useRef(user?.id);
  actor.current = user?.id;
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['gardenHelpSource', user?.id],
    mutationFn: async ({
      selection,
      userId,
    }: {
      selection: HelpSourceSelection | null;
      userId: string;
    }) => {
      if (actor.current !== userId) throw new Error('IDENTITY_CHANGED');
      if (selection?.kind === 'document') {
        const { id, section, heading } = selection;
        const document = { id, section, heading };
        return request.post('/api/garden/help/document', document) as Promise<{
          context: HelpContext;
        }>;
      }
      return request.post('/api/garden/help/context', {
        source: selection
          ? {
              conversationId: selection.conversationId,
              messageIds: selection.messageIds,
              attachments: selection.attachments ?? [],
            }
          : null,
      }) as Promise<{ context: HelpContext | null }>;
    },
    onMutate: async ({ userId }) => {
      await client.cancelQueries([QueryKeys.gardenHelpSession, userId]);
    },
    onSettled: async (_data, _error, { userId }) => {
      // An uncertain mutation must be reconciled against the actual stored
      // source too; never present an optimistic proposal as current background.
      await client.invalidateQueries([QueryKeys.gardenHelpSession, userId]);
    },
  });
}
