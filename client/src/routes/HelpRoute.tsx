import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@librechat/client';
import { QueryKeys, request } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

export default function HelpRoute() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const localize = useLocalize();
  const { user } = useAuthContext();
  const client = useQueryClient();
  const [sourceFailed, setSourceFailed] = useState(false);
  const session = useQuery<{ conversationId: string }>({
    queryKey: [QueryKeys.gardenHelpSession, user?.id],
    queryFn: () => request.get('/api/garden/help/session'),
    retry: false,
  });
  const conversationId = session.data?.conversationId;
  useEffect(() => {
    if (!conversationId) return;
    setSourceFailed(false);
    let cancelled = false;
    const open = () => {
      if (!cancelled)
        navigate(`/c/${encodeURIComponent(conversationId)}?gardenHelp=1`, {
          replace: true,
        });
    };
    const params = new URLSearchParams(search);
    const id = params.get('document');
    if (id)
      request
        .post('/api/garden/help/document', {
          id,
          ...(params.has('version') ? { version: params.get('version') } : {}),
          ...(params.has('section')
            ? { section: Number(params.get('section')), heading: params.get('heading') }
            : {}),
        })
        .then(async () => {
          await client.invalidateQueries([QueryKeys.gardenHelpSession, user?.id]);
          open();
        })
        .catch(() => {
          if (!cancelled) setSourceFailed(true);
        });
    else open();
    return () => {
      cancelled = true;
    };
  }, [conversationId, navigate, client, user?.id, search]);
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
          onClick={async () => {
            // Explicitly continue without a source; never silently reuse the
            // previous document/work-chat context after this source failed.
            try {
              await request.post('/api/garden/help/context', { source: null });
              await client.invalidateQueries([QueryKeys.gardenHelpSession, user?.id]);
              navigate(`/c/${encodeURIComponent(session.data!.conversationId)}?gardenHelp=1`, {
                replace: true,
              });
            } catch {
              setSourceFailed(true);
            }
          }}
        >
          {localize('com_ui_help_without')}
        </Button>
      )}
    </div>
  );
}
