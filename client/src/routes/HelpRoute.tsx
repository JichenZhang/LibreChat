import { useEffect } from 'react';
import { Button } from '@librechat/client';
import { useLocation, useNavigate } from 'react-router-dom';
import useHelpSession from '~/components/Chat/help/useHelpSession';
import { stageHelpEntry } from '~/components/Chat/help/entry';
import { useAuthContext, useLocalize } from '~/hooks';

export default function HelpRoute() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const localize = useLocalize();
  const { user } = useAuthContext();
  const session = useHelpSession();
  const conversationId = session.data?.conversationId;
  useEffect(() => {
    if (!conversationId || !user?.id) return;
    const params = new URLSearchParams(search);
    const id = params.get('document');
    stageHelpEntry(
      user.id,
      id
        ? {
            kind: 'document',
            id,
            ...(params.has('version') ? { version: params.get('version')! } : {}),
            ...(params.has('section')
              ? {
                  section: Number(params.get('section')),
                  heading: params.get('heading') ?? undefined,
                }
              : {}),
          }
        : null,
    );
    navigate(`/c/${encodeURIComponent(conversationId)}?gardenHelp=1`, { replace: true });
  }, [conversationId, navigate, user?.id, search]);
  return (
    <div className="p-4" role="status">
      <p>{localize(session.isError ? 'com_ui_help_unavailable' : 'com_ui_loading')}</p>
      {session.isError && (
        <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
      )}
    </div>
  );
}
