/** Garden Help's copied material is separate from the native chat's lifecycle. */
export const HELP_PACKAGE_MAX_BYTES = 2_097_152;
export const HELP_SUBMIT_TOOL = 'help_submit_feedback';
export type HelpUrgency = 'P0' | 'P1' | 'P2' | 'P3' | null;
export interface HelpEvidence {
  kind: 'original_text' | 'attachment_metadata' | 'attachment_content';
  text?: string;
  name?: string;
  media_type?: string;
  content_base64?: string;
  source: {
    kind: 'librechat_message' | 'workspace_attachment' | 'help_document';
    id: string;
    revision: string;
    retrieved_at: string;
    range: string;
  };
}
export interface HelpPackage {
  schema_version: 1;
  shared: { title: string; description: string; module: string; expected_change: string };
  summary: { goal: string; impact: string; attempts: string; still_blocked: boolean | null };
  evidence: HelpEvidence[];
  visibility: { shared: 'garden_authenticated'; private: 'owner_and_help_maintainers' };
  association: { issue_id: string; revision: number } | null;
  opinion_revision: number;
  user_urgency: HelpUrgency;
  ai_priority_suggestion: { level: HelpUrgency; reason: string } | null;
}
export type HelpSourceSelection =
  | {
      kind: 'chat';
      conversationId: string;
      messageIds: string[];
      attachments?: { messageId: string; fileId: string; content: boolean }[];
    }
  | { kind: 'document'; id: string; section?: number; heading?: string };
export interface HelpContext {
  evidence: HelpEvidence[];
  captured_at: string;
  label: string;
  /** Server-verified selection recipe; refreshing it is always a user action. */
  selection?: HelpSourceSelection;
}
export interface HelpSession {
  userId: string;
  conversationId: string;
  subject: string;
  context: HelpContext | null;
  siteURL: string;
  parentOrigins: string[];
  /** True only for this request's successful native conversation insert. */
  created: boolean;
}
export interface HelpSeal {
  submission_id: string;
  package_json: string;
  sha256: string;
}
export interface HelpApprovedExport extends HelpSeal {
  action_id: string;
  tool_call_id: string;
  confirmed_at: string;
}
export interface HelpReceipt {
  feedback_id: string;
  issue_id: string;
  association_result: 'associated' | 'independent_candidate';
  saved_at: string;
  submitted_urgency: HelpUrgency;
  opinion_result: 'unspecified' | 'updated' | 'unchanged' | 'newer_preserved';
  opinion_at_save: { level: HelpUrgency; revision: number };
}
