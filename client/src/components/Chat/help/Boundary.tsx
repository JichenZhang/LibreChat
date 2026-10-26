import { Navigate, Outlet } from 'react-router-dom';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';
import useHelpMode from './useHelpMode';

/** A display flag cannot relabel a work chat as the read-only Help conversation. */
export default function HelpBoundary() {
  const { requested, session, path, isHelp } = useHelpMode();
  const localize = useLocalize();
  if (!requested && !isHelp) return <Outlet />;
  if (!session.data)
    return (
      <div role="status" className="p-4">
        <p>{localize(session.isError ? 'com_ui_help_unavailable' : 'com_ui_loading')}</p>
        {session.isError && (
          <Button onClick={() => session.refetch()}>{localize('com_ui_retry')}</Button>
        )}
      </div>
    );
  if (!isHelp) return <Navigate to={`${path}?gardenHelp=1`} replace />;
  return <Outlet />;
}
