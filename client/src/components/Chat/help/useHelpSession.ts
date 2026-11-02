import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, request } from 'librechat-data-provider';
import type { HelpSession } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';

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
