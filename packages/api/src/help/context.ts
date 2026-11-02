import { z } from 'zod';
import type { HelpContext, HelpSourceSelection } from 'librechat-data-provider';
import type { HelpChatMethods } from '@librechat/data-schemas';
import type { HelpDependencies } from './attachments';
import type { ServerRequest } from '~/types/http';
import { captureHelpContext, resolveGardenHelpConfig } from './runtime';
import { helpDocumentSource, readHelpKnowledge } from './workspace';

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
