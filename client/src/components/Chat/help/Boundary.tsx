import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@librechat/client';
import { QueryKeys, request } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

/** A display flag cannot relabel a work chat as the read-only Help conversation. */
export default function HelpBoundary() {
  const { pathname, search } = useLocation();
  const requested = new URLSearchParams(search).has('gardenHelp');
  const { user } = useAuthContext();
  const localize = useLocalize();
  const session = useQuery<{ conversationId: string }>({
    queryKey: [QueryKeys.gardenHelpSession, user?.id],
    queryFn: () => request.get('/api/garden/help/session'),
    enabled: requested && !!user?.id,
    retry: false,
  });
  if (!requested) return <Outlet />;
  if (!session.data)
    return (
      <div role="status" className="p-4">
        <p>{localize(session.isError ? 'com_ui_help_unavailable' : 'com_ui_loading')}</p>
        {session.isError && (
          <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
        )}
      </div>
    );
  const path = `/c/${encodeURIComponent(session.data.conversationId)}`;
  if (pathname !== path) return <Navigate to={`${path}?gardenHelp=1`} replace />;
  return <Outlet />;
}
