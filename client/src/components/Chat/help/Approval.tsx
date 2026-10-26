import { useEffect, useMemo } from 'react';
import { Button } from '@librechat/client';
import type { Agents, HelpPackage, HelpSeal } from 'librechat-data-provider';
import { useApprovalContext, useResumeSubmit } from '../Messages/Content/ApprovalContext';
import { useLocalize } from '~/hooks';

export default function HelpApproval({
  pending,
}: {
  pending: Agents.PendingAction & { payload: Agents.ToolApprovalInterruptPayload };
}) {
  const localize = useLocalize();
  const { registerToolCall, unregisterToolCall, setDecision, getStatus } = useApprovalContext();
  const { submitToolApproval } = useResumeSubmit();
  const request = pending.payload.action_requests[0];
  const parsed = useMemo(() => {
    try {
      return JSON.parse((request.arguments as unknown as HelpSeal).package_json) as HelpPackage;
    } catch {
      return null;
    }
  }, [request]);
  useEffect(() => {
    registerToolCall(pending.actionId, request.tool_call_id);
    return () => unregisterToolCall(pending.actionId, request.tool_call_id);
  }, [pending.actionId, request.tool_call_id, registerToolCall, unregisterToolCall]);
  const status = getStatus(pending.actionId);
  const locked = ['submitting', 'submitted', 'expired'].includes(status);
  const decide = (decision: 'approve' | 'reject') => {
    setDecision(pending.actionId, request.tool_call_id, {
      tool_call_id: request.tool_call_id,
      decision,
      scope: 'once',
    });
    submitToolApproval(pending.actionId);
  };
  if (!parsed) return <p role="alert">{localize('com_ui_help_unavailable')}</p>;
  return (
    <section
      aria-label="Garden Help"
      className="absolute bottom-24 z-10 flex max-h-[calc(100dvh-7rem)] w-full flex-col overflow-hidden rounded-xl border border-border-light bg-surface-primary p-4 text-base text-text-primary"
    >
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto"
        tabIndex={0}
        role="region"
        aria-label={localize('com_ui_help_material')}
      >
        <h2 className="text-lg font-semibold">{localize('com_ui_help_submit')}</h2>
        <p>{localize('com_ui_help_shared')}</p>
        <h3 className="font-semibold">{parsed.shared.title}</h3>
        <p className="whitespace-pre-wrap">{parsed.shared.description}</p>
        <p>{parsed.shared.module}</p>
        <p className="whitespace-pre-wrap">{parsed.shared.expected_change}</p>
        <p>{localize('com_ui_help_private')}</p>
        <p>
          {localize('com_ui_help_urgency')}:{' '}
          {parsed.user_urgency ?? localize('com_ui_help_unspecified')}
        </p>
        <p>
          {localize('com_ui_help_ai')}:{' '}
          {parsed.ai_priority_suggestion?.level ?? localize('com_ui_help_unspecified')}{' '}
          {parsed.ai_priority_suggestion?.reason}
        </p>
        <details>
          <summary className="min-h-11 cursor-pointer">
            {localize('com_ui_help_material')} ({parsed.evidence.length})
          </summary>
          <p>{localize('com_ui_help_summary')}</p>
          <p className="whitespace-pre-wrap">
            {[parsed.summary.goal, parsed.summary.impact, parsed.summary.attempts].join('\n')}
          </p>
          {parsed.evidence.map((item, i) => (
            <div key={i} className="my-3 border-t border-border-light py-2">
              <p>
                {localize('com_ui_help_original')} · {item.source.id} · {item.source.range}
              </p>
              <pre className="whitespace-pre-wrap break-words font-sans">
                {item.text ?? item.name}
              </pre>
              {item.content_base64 && (
                <a
                  className="underline"
                  href={`data:application/octet-stream;base64,${item.content_base64}`}
                  download={item.name}
                >
                  {localize('com_ui_help_download')} · {item.media_type}
                </a>
              )}
            </div>
          ))}
        </details>
        <p>{localize('com_ui_help_independent')}</p>
      </div>
      {status === 'error' && <p role="alert">{localize('com_ui_help_unavailable')}</p>}
      <div className="mt-3 flex shrink-0 flex-wrap gap-2">
        <Button
          className="min-h-11"
          disabled={locked}
          variant="submit"
          onClick={() => decide('approve')}
        >
          {status === 'submitting' ? localize('com_ui_submitting') : localize('com_ui_help_submit')}
        </Button>
        <Button className="min-h-11" disabled={locked} onClick={() => decide('reject')}>
          {localize('com_ui_cancel')}
        </Button>
      </div>
    </section>
  );
}
