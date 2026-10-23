import { logger } from '@librechat/data-schemas';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TFile } from 'librechat-data-provider';

export type WorkspaceExportContext = {
  /** Authenticated tool-creation owner; the safe runnable user can omit tenantId. */
  owner?: Owner;
  messageId?: string;
  conversationId?: string;
  toolCallId?: string;
  toolName: string;
  signal?: AbortSignal;
};

type Owner = { id?: string; tenantId?: string | null };
type Identity = Required<Omit<WorkspaceExportContext, 'signal' | 'owner'>>;
type StoredFile = Pick<
  TFile,
  | 'file_id'
  | 'user'
  | 'tenantId'
  | 'filename'
  | 'filepath'
  | 'type'
  | 'bytes'
  | 'source'
  | 'context'
> & { expiredAt?: Date | null };
type Attachment = StoredFile & {
  messageId: string;
  conversationId: string;
  toolCallId: string;
  agentId?: string;
  stepId?: string;
};
type Completion = {
  output?: {
    artifact?: { workspaceExport?: WorkspaceExport };
    tool_call_id?: string;
    name?: string;
  };
};
type Metadata = {
  run_id?: string;
  thread_id?: string;
  executingAgentId?: string;
  agentId?: string;
  agent_id?: string;
  stepId?: string;
};

/** Request-local authority: MCP JSON cannot construct or replay this receipt. */
export class WorkspaceExport {
  #claimed = false;

  constructor(
    readonly fileId: string,
    readonly userId: string,
    readonly tenantId: string | null,
    readonly identity: Identity,
    readonly signal: AbortSignal | undefined,
  ) {}

  claim(user: Owner, output: NonNullable<Completion['output']>, metadata: Metadata): boolean {
    if (
      this.#claimed ||
      this.signal?.aborted ||
      user.id !== this.userId ||
      (user.tenantId ?? null) !== this.tenantId ||
      output.name !== this.identity.toolName ||
      output.tool_call_id !== this.identity.toolCallId ||
      metadata.run_id !== this.identity.messageId ||
      metadata.thread_id !== this.identity.conversationId
    ) {
      return false;
    }
    this.#claimed = true;
    return true;
  }
}

/** Called only after the actual native MCP transport has completed successfully. */
export function formatWorkspaceExport<Artifact extends object>({
  result,
  formatted,
  serverName,
  serverConfig,
  toolName,
  user,
  context,
}: {
  result: CallToolResult;
  formatted: [string, Artifact | undefined];
  serverName: string;
  serverConfig: { source?: string; url?: string };
  toolName: string;
  user?: Owner;
  context?: WorkspaceExportContext;
}): [string, Artifact | { workspaceExport: WorkspaceExport } | undefined] {
  const owner = context?.owner;
  // This is the existing Garden service identity, not a generic MCP file protocol.
  if (
    serverName !== 'workspace-mcp' ||
    toolName !== 'workspace_chat_download' ||
    !['yaml', 'config'].includes(serverConfig.source ?? '') ||
    serverConfig.url !== 'http://workspace-mcp:8080/mcp' ||
    result.isError === true ||
    result.structuredContent?.ok !== true ||
    typeof result.structuredContent.file_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      result.structuredContent.file_id,
    ) ||
    !owner?.id ||
    user?.id !== owner.id ||
    (user.tenantId !== undefined && (user.tenantId ?? null) !== (owner.tenantId ?? null)) ||
    !context?.messageId ||
    !context.conversationId ||
    !context.toolCallId ||
    !context.toolName ||
    context.signal?.aborted
  ) {
    return formatted;
  }
  const { messageId, conversationId, toolCallId, toolName: name } = context;
  return [
    formatted[0],
    {
      ...formatted[1],
      workspaceExport: new WorkspaceExport(
        result.structuredContent.file_id,
        owner.id,
        owner.tenantId ?? null,
        { messageId, conversationId, toolCallId, toolName: name },
        context.signal,
      ),
    },
  ];
}

/** Reuse the native completion promise/event channel; never publish bytes a second time. */
export function enqueueWorkspaceExport({
  data,
  metadata,
  user,
  artifactPromises,
  findFileById,
  emit,
}: {
  data?: Completion;
  metadata?: Metadata;
  user: Owner;
  artifactPromises: Promise<Attachment | null>[];
  findFileById: (
    id: string,
    scope: { user: string; tenantId: string | null },
  ) => Promise<StoredFile | null>;
  emit: (attachment: Attachment) => void;
}): void {
  const output = data?.output;
  const receipt = output?.artifact?.workspaceExport;
  if (
    !output ||
    !(receipt instanceof WorkspaceExport) ||
    !receipt.claim(user, output, metadata ?? {})
  ) {
    return;
  }
  artifactPromises.push(
    (async () => {
      const file = await findFileById(receipt.fileId, {
        user: receipt.userId,
        tenantId: receipt.tenantId,
      });
      if (
        !file ||
        receipt.signal?.aborted ||
        String(file.user) !== receipt.userId ||
        (file.tenantId ?? null) !== receipt.tenantId ||
        file.file_id !== receipt.fileId ||
        file.context !== FileContext.message_attachment ||
        file.source !== FileSources.local ||
        !file.filepath ||
        (file.expiredAt != null && new Date(file.expiredAt).getTime() <= Date.now())
      ) {
        return null;
      }
      const attachment: Attachment = {
        file_id: file.file_id,
        user: receipt.userId,
        tenantId: file.tenantId,
        filename: file.filename,
        filepath: file.filepath,
        type: file.type,
        bytes: file.bytes,
        source: file.source,
        context: file.context,
        messageId: receipt.identity.messageId,
        conversationId: receipt.identity.conversationId,
        toolCallId: receipt.identity.toolCallId,
        agentId: metadata?.executingAgentId ?? metadata?.agentId ?? metadata?.agent_id,
        stepId: metadata?.stepId,
      };
      emit(attachment);
      return attachment;
    })().catch(() => {
      logger.error('Workspace export attachment completion failed');
      return null;
    }),
  );
}
