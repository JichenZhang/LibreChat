import { useState } from 'react';
import { Button } from '@librechat/client';
import { request } from 'librechat-data-provider';
import type { HelpReceipt } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Result = Partial<HelpReceipt> & {
  submission_id?: string;
  site_url?: string;
  cancelled?: boolean;
  error?: { code: string };
};
export default function HelpReceiptView({ output }: { output?: string }) {
  const localize = useLocalize();
  const [checked, setChecked] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  let initial: Result = {};
  try {
    initial = JSON.parse(output ?? '{}');
  } catch {
    if (output) initial = { error: { code: 'RESULT_UNKNOWN' } };
  }
  const value = checked ?? initial;
  const check = async () => {
    if (!initial.submission_id) return;
    setBusy(true);
    try {
      setChecked(
        await request.post(
          `/api/garden/help/submissions/${encodeURIComponent(initial.submission_id)}/retry`,
          {},
        ),
      );
    } catch {
      setChecked({ error: { code: 'RESULT_UNKNOWN' } });
    } finally {
      setBusy(false);
    }
  };
  if (value.cancelled) return <p>{localize('com_ui_cancelled')}</p>;
  const saved = /^\d+$/.test(value.feedback_id ?? '') && /^\d+$/.test(value.issue_id ?? '');
  let site: URL | undefined;
  try {
    site = new URL(initial.site_url ?? '');
    if (!['http:', 'https:'].includes(site.protocol)) site = undefined;
  } catch {
    /* A missing destination never becomes an arbitrary link. */
  }
  const knownFailure = value.error && !['UNAVAILABLE', 'RESULT_UNKNOWN'].includes(value.error.code);
  let message = localize('com_ui_help_preparing');
  if (saved) message = localize('com_ui_help_saved');
  else if (knownFailure) message = localize('com_ui_help_not_saved');
  else if (value.error) message = localize('com_ui_help_unknown');
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-2 border-y border-border-light py-3 text-base"
    >
      <p>{message}</p>
      {saved && (
        <>
          <p>
            #{value.feedback_id} ·{' '}
            {localize(
              value.association_result === 'associated'
                ? 'com_ui_help_associated'
                : 'com_ui_help_candidate',
            )}
          </p>
          <p>
            {localize('com_ui_help_urgency')}:{' '}
            {value.submitted_urgency ?? localize('com_ui_help_unspecified')}
          </p>
          {value.opinion_result === 'newer_preserved' && <p>{localize('com_ui_help_newer')}</p>}
          {site && (
            <div className="flex flex-wrap gap-4">
              <a
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
                href={new URL(`/feedback/?id=${value.feedback_id}`, site).href}
              >
                {localize('com_ui_help_own')}
              </a>
              <a
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
                href={new URL(`/issues/?id=${value.issue_id}`, site).href}
              >
                {localize('com_ui_help_issues')}
              </a>
            </div>
          )}
        </>
      )}
      {!saved && !knownFailure && initial.submission_id && (
        <Button className="min-h-11" disabled={busy} onClick={check}>
          {localize('com_ui_help_check')}
        </Button>
      )}
    </div>
  );
}
