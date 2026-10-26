import { createHash } from 'node:crypto';
import { FileSources, HELP_PACKAGE_MAX_BYTES } from 'librechat-data-provider';
import type { HelpEvidence } from 'librechat-data-provider';
import type { HelpChatMethods } from '@librechat/data-schemas';
import type { ProvisionDeps } from '~/files/provision/service';
import type { ServerRequest } from '~/types/http';
import { resolveDownloadPath } from '~/storage/path';

export type HelpDependencies = Partial<Pick<ProvisionDeps, 'getStrategyFunctions'>> & {
  workspaceSecret?: string;
};
type Selection = { messageId: string; fileId: string; content: boolean };

async function capture(
  req: ServerRequest,
  db: HelpChatMethods,
  conversationId: string,
  selected: Selection,
  deps?: HelpDependencies,
): Promise<HelpEvidence> {
  const file = await db.readHelpAttachment(
    req.user!.id,
    conversationId,
    selected.messageId,
    selected.fileId,
    selected.content,
  );
  if (
    !file ||
    (file.tenantId && String(file.tenantId) !== String(req.user?.tenantId ?? '')) ||
    file.filename.length > 512 ||
    file.type.length > 128 ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0
  )
    throw new Error('SOURCE_UNAVAILABLE');
  const metadata = JSON.stringify({
    name: file.filename,
    media_type: file.type,
    bytes: file.bytes,
  });
  let content: Buffer | undefined;
  if (selected.content) {
    if (file.bytes > HELP_PACKAGE_MAX_BYTES) throw new Error('TOO_LARGE');
    if (file.source === FileSources.text) content = Buffer.from(file.text ?? '', 'utf8');
    else {
      // Use the original native storage download, never Workspace import/preparation/execute.
      const download = deps?.getStrategyFunctions?.(file.source)?.getDownloadStream;
      if (!download) throw new Error('SOURCE_UNAVAILABLE');
      const stream = await download(req, resolveDownloadPath(file), {
        signal: AbortSignal.timeout(12000),
      });
      const parts: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > HELP_PACKAGE_MAX_BYTES) throw new Error('TOO_LARGE');
          parts.push(bytes);
        }
      } finally {
        stream.destroy();
      }
      content = Buffer.concat(parts);
      if (content.length !== file.bytes) throw new Error('SOURCE_CHANGED');
    }
    if (content.length > HELP_PACKAGE_MAX_BYTES) throw new Error('TOO_LARGE');
  }
  return {
    kind: selected.content ? 'attachment_content' : 'attachment_metadata',
    name: file.filename,
    media_type: file.type,
    ...(content ? { content_base64: content.toString('base64') } : { text: metadata }),
    source: {
      kind: 'librechat_message',
      id: `${conversationId}/${selected.messageId}/attachment/${selected.fileId}/${selected.content ? 'content' : 'metadata'}`,
      revision: createHash('sha256')
        .update(metadata)
        .update(content ?? '')
        .digest('hex'),
      retrieved_at: new Date().toISOString(),
      range: content
        ? `Original native attachment bytes [0,${content.length}); explicitly selected; no Workspace copy`
        : 'Attachment name, type and size only; file content excluded',
    },
  };
}

export async function captureHelpAttachments(
  req: ServerRequest,
  db: HelpChatMethods,
  source: { conversationId: string; messageIds: string[]; attachments?: Selection[] },
  deps?: HelpDependencies,
): Promise<HelpEvidence[]> {
  const selections = source.attachments ?? [];
  if (
    selections.length > 16 ||
    new Set(selections.map((s) => `${s.messageId}/${s.fileId}`)).size !== selections.length ||
    selections.some((s) => !source.messageIds.includes(s.messageId))
  )
    throw new Error('INVALID_SOURCE');
  const evidence: HelpEvidence[] = [];
  let bytes = 0;
  for (const selected of selections) {
    const item = await capture(req, db, source.conversationId, selected, deps);
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > HELP_PACKAGE_MAX_BYTES) throw new Error('TOO_LARGE');
    evidence.push(item);
  }
  return evidence;
}

export async function verifyHelpAttachment(
  req: ServerRequest,
  db: HelpChatMethods,
  item: HelpEvidence,
  deps?: HelpDependencies,
): Promise<boolean> {
  const parts = item.source.id.split('/');
  if (
    parts.length !== 5 ||
    parts[2] !== 'attachment' ||
    !['content', 'metadata'].includes(parts[4])
  )
    return false;
  try {
    const current = await capture(
      req,
      db,
      parts[0],
      { messageId: parts[1], fileId: parts[3], content: parts[4] === 'content' },
      deps,
    );
    return (
      current.kind === item.kind &&
      current.source.revision === item.source.revision &&
      current.content_base64 === item.content_base64 &&
      current.text === item.text
    );
  } catch {
    return false;
  }
}
