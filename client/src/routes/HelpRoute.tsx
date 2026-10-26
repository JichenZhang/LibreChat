import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@librechat/client';
import { QueryKeys, request } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

export default function HelpRoute() {
  const navigate = useNavigate();
  const localize = useLocalize();
  const { user } = useAuthContext();
  const [sourceFailed, setSourceFailed] = useState(false);
  const session = useQuery<{ conversationId: string }>({
    queryKey: [QueryKeys.gardenHelpSession, user?.id],
    queryFn: () => request.get('/api/garden/help/session'),
    retry: false,
  });
  useEffect(() => {
    if (!session.data) return;
    let cancelled = false;
    const open = () => {
      if (!cancelled)
        navigate(`/c/${encodeURIComponent(session.data!.conversationId)}?gardenHelp=1`, {
          replace: true,
        });
    };
    const id = new URLSearchParams(location.search).get('document');
    if (id)
      request
        .post('/api/garden/help/document', { id })
        .then(open)
        .catch(() => {
          if (!cancelled) setSourceFailed(true);
        });
    else open();
    return () => {
      cancelled = true;
    };
  }, [session.data, navigate]);
  let message = localize('com_ui_loading');
  if (session.isError) message = localize('com_ui_help_unavailable');
  if (sourceFailed) message = localize('com_ui_help_source_error');
  return (
    <div className="p-4" role="status">
      <p>{message}</p>
      {session.isError && (
        <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
      )}
      {sourceFailed && (
        <Button
          onClick={() =>
            navigate(`/c/${encodeURIComponent(session.data!.conversationId)}?gardenHelp=1`, {
              replace: true,
            })
          }
        >
          {localize('com_ui_help_without')}
        </Button>
      )}
    </div>
  );
}
