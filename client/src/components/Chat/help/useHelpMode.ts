import { useLocation } from 'react-router-dom';
import useHelpSession from './useHelpSession';

/** View identity follows the server-owned chat, even when native navigation
 * normalizes away display parameters. Never infer authority from the flag. */
export default function useHelpMode(nativeHelp = false) {
  const { pathname, search } = useLocation();
  const requested = new URLSearchParams(search).has('gardenHelp');
  const session = useHelpSession(requested || nativeHelp);
  const path = session.data ? `/c/${encodeURIComponent(session.data.conversationId)}` : '';
  return { requested, session, path, isHelp: !!path && pathname === path };
}
