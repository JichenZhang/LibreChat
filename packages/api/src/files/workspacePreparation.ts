import { Constants } from 'librechat-data-provider';
import type { LCTool, GenericTool } from '@librechat/agents';
import type { TFile } from 'librechat-data-provider';
import type { WorkspaceCopyDeps, WorkspaceCopyResult } from './workspaceCopy';
import type { MCPToolAlias } from '~/tools/classification';
import type { LCAvailableTools } from '~/mcp/types';
import type { ServerRequest } from '~/types';
import {
  trustedWorkspaceFiles,
  selectWorkspaceInputFiles,
  prepareWorkspaceCopiesWithTools,
  formatWorkspaceAttachmentReferences,
  withWorkspaceSignal,
} from './workspaceCopy';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { filterFilesByEndpointRuntimeConfig } from './filter';

type BranchMessage = {
  messageId?: string;
  parentMessageId?: string | null;
  isCreatedByUser?: boolean;
  files?: Array<{ file_id?: string } | null> | null;
};

/** Preserve only branch reference presence before native hydration drops denied files. */
export function snapshotWorkspaceBranch(messages: readonly BranchMessage[]): BranchMessage[] {
  return messages.map(({ messageId, parentMessageId, isCreatedByUser, files }) => ({
    messageId,
    parentMessageId,
    isCreatedByUser,
    files: files?.map((file) => (file ? { file_id: file.file_id } : null)),
  }));
}

export function workspaceAttachmentBranch(
  ordered: readonly BranchMessage[],
  stored?: readonly BranchMessage[],
): BranchMessage[] {
  if (!stored?.length) return [...ordered];
  const byId = new Map([...ordered, ...stored].map((message) => [message.messageId, message]));
  let current: BranchMessage | undefined = ordered[ordered.length - 1];
  const branch: BranchMessage[] = [];
  const seen = new Set<string>();
  while (current?.messageId && !seen.has(current.messageId)) {
    seen.add(current.messageId);
    branch.push(current);
    current = byId.get(current.parentMessageId ?? '');
  }
  return branch.reverse();
}
type PreparationAgent = {
  id: string;
  endpoint?: string | null;
  provider?: string;
  resendFiles?: boolean;
  currentRequestAttachments?: TFile[];
  mcpToolAliases?: MCPToolAlias[];
};
type ToolContext = {
  toolRegistry?: Map<string, LCTool>;
  mcpAvailableTools?: Record<string, LCAvailableTools>;
  userMCPAuthMap?: Record<string, Record<string, string>>;
};
type PreparationInput = {
  agent: PreparationAgent;
  messages: readonly BranchMessage[];
  historicalFiles: readonly TFile[];
  configServers?: Record<string, { timeout?: number }>;
  signal?: AbortSignal;
};

/** Request-private delivery callback. Authority and transport remain in native tool wrappers. */
export function createWorkspacePreparation({
  req,
  requestFiles,
  signal: requestSignal,
  getContext,
  loadTools,
  db,
  conversationId,
  runId,
}: {
  req: ServerRequest;
  requestFiles: readonly { file_id?: string }[];
  signal?: AbortSignal;
  getContext: (agentId: string) => ToolContext | undefined;
  loadTools: (
    names: string[],
    agentId: string,
    signal: AbortSignal,
  ) => Promise<{ loadedTools?: Array<Pick<GenericTool, 'name' | 'invoke'>> }>;
  db: Omit<WorkspaceCopyDeps, 'importAttachment' | 'exists'>;
  conversationId?: string;
  runId?: string;
}): (input: PreparationInput) => Promise<string | undefined> {
  return async ({ agent, messages, historicalFiles, configServers, signal }) => {
    const ctx = getContext(agent.id);
    const catalog = ctx?.mcpAvailableTools?.['workspace-mcp'];
    const delimiter = Constants.mcp_delimiter;
    const admitted = [...(ctx?.toolRegistry?.values() ?? [])].some((tool) => {
      const parts = tool.name.split(delimiter);
      const server = tool.serverName ?? parts[parts.length - 1];
      const alias = agent.mcpToolAliases?.find(
        (entry) =>
          entry.name === tool.name &&
          entry.aliasName === `workspace_execute${delimiter}workspace-mcp`,
      );
      const operation =
        catalog?.[tool.name]?.serverToolName ?? alias?.aliasName.split(delimiter)[0] ?? parts[0];
      return server === 'workspace-mcp' && operation === 'workspace_execute';
    });
    if (!admitted || !req.user?.id) return;
    const userId = String(req.user.id);
    const tenantId = req.user.tenantId;
    // Raw current presence is authoritative even when every reference was rejected.
    const priorFiles = agent.resendFiles === false ? [] : historicalFiles;
    const files =
      requestFiles.length > 0
        ? trustedWorkspaceFiles(agent.currentRequestAttachments ?? [], userId, tenantId)
        : selectWorkspaceInputFiles(
            messages,
            filterFilesByEndpointRuntimeConfig(req.config, {
              files: [...priorFiles],
              endpoint: agent.endpoint,
            }),
            userId,
            tenantId,
          );
    if (files.length === 0) return;
    const callerSignal =
      requestSignal && signal
        ? AbortSignal.any([requestSignal, signal])
        : (requestSignal ?? signal);
    callerSignal?.throwIfAborted();
    // Same effective timeout as MCP transport: unset/zero uses 60 seconds.
    const timeout = configServers?.['workspace-mcp']?.timeout || 60_000;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error('Workspace preparation deadline')),
      timeout,
    );
    const batchSignal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const results: WorkspaceCopyResult[] = [];
    try {
      const operations = ['workspace_import_attachment', 'workspace_list'];
      const keys = operations.map(
        (operation) =>
          Object.entries(catalog ?? {}).find(
            ([key, entry]) => (entry.serverToolName ?? key.split(delimiter)[0]) === operation,
          )?.[0] ?? `${operation}${delimiter}workspace-mcp`,
      );
      const loaded = await withWorkspaceSignal(batchSignal, () =>
        loadTools(keys, agent.id, batchSignal),
      );
      const tools = keys.map((key) => loaded.loadedTools?.find((tool) => tool.name === key));
      if (tools.some((tool) => !tool)) throw new Error('Workspace tools unavailable');
      for (const file of files) {
        const prepared = await prepareWorkspaceCopiesWithTools({
          files: [file],
          userId,
          tenantId,
          db,
          signal: batchSignal,
          callTool: (name, args, transferSignal) =>
            tools[operations.indexOf(name)]!.invoke(args, {
              signal: transferSignal,
              configurable: {
                user: req.user,
                user_id: userId,
                userMCPAuthMap: ctx?.userMCPAuthMap,
              },
              metadata: {
                provider: agent.provider,
                thread_id: conversationId,
                run_id: runId ?? conversationId,
                agentId: agent.id,
              },
            }),
        });
        results.push(...prepared);
      }
    } catch {
      callerSignal?.throwIfAborted();
      // A pending remote mutation or DB claim may still settle. Never release or remap it.
      for (const file of files.slice(results.length)) {
        results.push({
          filename: file.filename,
          status: 'failed',
          code: deadline.signal.aborted
            ? 'workspace_copy_deadline'
            : 'workspace_copy_preparation_unavailable',
        });
      }
    } finally {
      clearTimeout(timer);
    }
    callerSignal?.throwIfAborted();
    const context = formatWorkspaceAttachmentReferences(results);
    assertModelBoundContent({
      filters: req.config?.filters,
      files: context ? [context] : [],
      submittedMessages: context ? [{ role: 'user', content: context }] : [],
    });
    return context;
  };
}
