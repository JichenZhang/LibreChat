import { z } from 'zod';
import { createHash } from 'node:crypto';
import { HELP_PACKAGE_MAX_BYTES, configSchema } from 'librechat-data-provider';
import type {
  HelpContext,
  HelpSourceSelection,
  HelpEvidence,
  TCustomConfig,
} from 'librechat-data-provider';
import type { HelpChatMethods, HelpSourceMessage } from '@librechat/data-schemas';
import type { HelpDependencies } from './attachments';
import type { ServerRequest } from '~/types/http';
import { helpDocumentSource, readHelpKnowledge } from './workspace';
import { captureHelpAttachments } from './attachments';

export type Config = NonNullable<z.output<typeof configSchema>['gardenHelp']>;

export function resolveGardenHelpConfig(value: TCustomConfig['gardenHelp']): Config | undefined {
  return configSchema.shape.gardenHelp.parse(value);
}

export const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export function messageEvidence(
  conversationId: string,
  row: HelpSourceMessage,
  now: string,
): HelpEvidence {
  return {
    kind: 'original_text',
    text: row.text,
    source: {
      kind: 'librechat_message',
      id: `${conversationId}/${row.messageId}`,
      revision: hash(JSON.stringify([row.text, row.updatedAt, row.parentMessageId])),
      retrieved_at: now,
      range: `text characters [0,${Array.from(row.text).length}); ${row.truncated ? 'remaining text excluded; ' : ''}attachment content excluded`,
    },
  };
}

export async function captureHelpContext(
  db: HelpChatMethods,
  userId: string,
  source: {
    conversationId: string;
    messageIds: string[];
    attachments?: { messageId: string; fileId: string; content: boolean }[];
  },
  req?: ServerRequest,
  deps?: HelpDependencies,
): Promise<HelpContext> {
  if (!z.string().uuid().safeParse(source.conversationId).success || source.messageIds.length > 16)
    throw new Error('INVALID_SOURCE');
  const rows = await db.readHelpSources(userId, source.conversationId, source.messageIds);
  const byId = new Map(rows.map((row) => [row.messageId, row]));
  const ordered = source.messageIds.map((id) => byId.get(id));
  if (
    ordered.some((row) => row == null) ||
    ordered.some((row, i) => i > 0 && row?.parentMessageId !== ordered[i - 1]?.messageId)
  )
    throw new Error('INVALID_SOURCE');
  const now = new Date().toISOString();
  const attachments =
    source.attachments?.length && req ? await captureHelpAttachments(req, db, source, deps) : [];
  const context = {
    captured_at: now,
    selection: {
      kind: 'chat' as const,
      conversationId: source.conversationId,
      messageIds: [...source.messageIds],
      attachments: source.attachments ?? [],
    },
    label:
      'Selected chat branch; at most 16 messages, 16384 characters per message; attachment content only when explicitly selected',
    evidence: [
      ...rows.map((row) => messageEvidence(source.conversationId, row, now)),
      ...attachments,
    ],
  };
  if (Buffer.byteLength(JSON.stringify(context)) > HELP_PACKAGE_MAX_BYTES)
    throw new Error('TOO_LARGE');
  return context;
}

const selectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('chat'),
      conversationId: z.string().uuid(),
      messageIds: z.array(z.string().min(1).max(256)).min(1).max(16),
      attachments: z
        .array(
          z
            .object({
              messageId: z.string().max(256),
              fileId: z.string().max(256),
              content: z.boolean(),
            })
            .strict(),
        )
        .max(16)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('document'),
      id: z.string().max(128),
      version: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      section: z.number().int().min(0).max(1000).optional(),
      heading: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('settings'),
      tab: z.enum(['general', 'chat', 'speech', 'langfuse', 'data', 'account', 'about']),
      section: z
        .enum([
          'appearance',
          'layout',
          'accessibility',
          'admin',
          'sending',
          'commands',
          'messages',
          'conversations',
          'prompts',
          'stt',
          'tts',
          'memory',
          'codeExecution',
          'data',
          'apiKeys',
          'langfuse',
          'danger',
          'profile',
          'security',
          'billing',
          'about',
        ])
        .optional(),
    })
    .strict(),
]);

/** The browser supplies a bounded selection, never captured text or form values. */
export async function captureHelpSelection(
  req: ServerRequest,
  db: HelpChatMethods,
  input: HelpSourceSelection,
  deps?: HelpDependencies,
): Promise<HelpContext> {
  const source = selectionSchema.parse(input);
  if (source.kind === 'chat') return captureHelpContext(db, req.user!.id, source, req, deps);
  const now = new Date().toISOString();
  if (source.kind === 'settings')
    return {
      captured_at: now,
      selection: source,
      label: `Settings · ${source.tab}${source.section ? ` · ${source.section}` : ''}`,
      evidence: [],
    };
  const config = resolveGardenHelpConfig(req.config?.gardenHelp)!;
  const document = await readHelpKnowledge(
    config.workspaceURL,
    req.user!.openidId!,
    deps?.workspaceSecret,
    source.id,
  );
  if (source.version && source.version !== document.version) throw new Error('SOURCE_STALE');
  const selected = helpDocumentSource(source.id, document, source.section, source.heading);
  return {
    captured_at: now,
    selection: { ...source, heading: selected.heading },
    label: selected.label,
    evidence: [
      {
        kind: 'original_text',
        text: selected.content,
        source: {
          kind: 'help_document',
          id: selected.id,
          revision: selected.revision,
          retrieved_at: now,
          range: selected.range,
        },
      },
    ],
  };
}
