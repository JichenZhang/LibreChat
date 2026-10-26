import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, request } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';

/** View identity follows the server-owned chat, even when native navigation
 * normalizes away display parameters. Never infer authority from the flag. */
export default function useHelpMode(nativeHelp = false) {
  const { pathname, search } = useLocation();
  const { user } = useAuthContext();
  const requested = new URLSearchParams(search).has('gardenHelp');
  const session = useQuery<{ conversationId: string }>({
    queryKey: [QueryKeys.gardenHelpSession, user?.id],
    queryFn: () => request.get('/api/garden/help/session'),
    enabled: (requested || nativeHelp) && !!user?.id,
    staleTime: Infinity,
    retry: false,
  });
  const path = session.data ? `/c/${encodeURIComponent(session.data.conversationId)}` : '';
  return { requested, session, path, isHelp: !!path && pathname === path };
}
