import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { Constants, FileContext, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import {
  createWorkspacePreparation,
  snapshotWorkspaceBranch,
  workspaceAttachmentBranch,
} from './workspacePreparation';

const file: TFile = {
  file_id: 'ppt',
  filename: '演示.pptx',
  context: FileContext.message_attachment,
  source: FileSources.local,
  user: 'owner',
  tenantId: 'tenant',
  type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  bytes: 100,
  object: 'file',
  embedded: false,
  usage: 0,
  filepath: '/native/ppt',
};
const key = `workspace_execute${Constants.mcp_delimiter}workspace-mcp`;
function fixture({
  deadline = false,
  requestFiles = [file],
  controller = new AbortController(),
  authorized = true,
} = {}) {
  let claimed = false;
  const req = { user: { id: 'owner', tenantId: 'tenant' }, config: {} } as ServerRequest;
  const invoke = jest.fn(async (args: { path?: string }) => {
    if (args.path === '聊天上传')
      return JSON.stringify({ ok: true, entries: [{ name: '演示.pptx', type: 'regular' }] });
    if (deadline) return new Promise<string>(() => {});
    return JSON.stringify({ ok: true });
  });
  const loadTools = jest.fn(async (names: string[]) => ({
    loadedTools: names.map(
      (name) =>
        new DynamicStructuredTool({
          name,
          description: name,
          schema: { type: 'object', additionalProperties: true },
          func: invoke,
        }),
    ),
  }));
  const db = {
    getFile: jest.fn(async () => ({ metadata: {} })),
    claim: jest.fn(async () => {
      claimed = true;
      return {};
    }),
    advance: jest.fn(async () => ({})),
    complete: jest.fn(async () => ({})),
    release: jest.fn(async () => true),
  };
  const prepare = createWorkspacePreparation({
    req,
    requestFiles,
    signal: controller.signal,
    getContext: (id) =>
      authorized && id === 'selected'
        ? { toolRegistry: new Map([[key, { name: key }]]) }
        : undefined,
    loadTools,
    db,
    conversationId: 'conversation',
  });
  const input = {
    agent: { id: 'selected', endpoint: 'openAI', currentRequestAttachments: [file] },
    messages: [],
    historicalFiles: [],
  };
  return { prepare, input, req, invoke, loadTools, db, controller, claimed: () => claimed };
}

describe('request-bound Workspace preparation', () => {
  it('requires the selected Agent admitted registry even when a loader exists', async () => {
    const state = fixture({ authorized: false });
    expect(await state.prepare(state.input)).toBeUndefined();
    expect(state.loadTools).not.toHaveBeenCalled();
  });
  it('honors a native canonical alias only when that exact tool is in this Agent registry', async () => {
    const req = { user: { id: 'owner', tenantId: 'tenant' }, config: {} } as ServerRequest;
    const aliased = `execute${Constants.mcp_delimiter}workspace-mcp`;
    const loadTools = jest.fn(async () => ({ loadedTools: [] }));
    const state = fixture();
    const prepare = createWorkspacePreparation({
      req,
      requestFiles: [file],
      getContext: () => ({ toolRegistry: new Map([[aliased, { name: aliased }]]) }),
      loadTools,
      db: state.db,
    });
    expect(
      await prepare({
        ...state.input,
        agent: { ...state.input.agent, mcpToolAliases: [{ name: aliased, aliasName: key }] },
      }),
    ).toContain('workspace_copy_preparation_unavailable');
    expect(loadTools).toHaveBeenCalledTimes(1);
    loadTools.mockClear();
    expect(
      await prepare({
        ...state.input,
        agent: { ...state.input.agent, mcpToolAliases: [{ name: 'unselected', aliasName: key }] },
      }),
    ).toBeUndefined();
    expect(loadTools).not.toHaveBeenCalled();
  });

  it('does not give another Agent files or capability from the primary Agent', async () => {
    const state = fixture();
    expect(
      await state.prepare({ ...state.input, agent: { ...state.input.agent, id: 'other' } }),
    ).toBeUndefined();
    expect(state.loadTools).not.toHaveBeenCalled();
  });
  it('rejects foreign owner and tenant rows before loading', async () => {
    const state = fixture();
    for (const rejected of [
      { ...file, user: 'foreign' },
      { ...file, tenantId: 'foreign' },
    ]) {
      expect(
        await state.prepare({
          ...state.input,
          agent: { ...state.input.agent, currentRequestAttachments: [rejected] },
        }),
      ).toBeUndefined();
    }
    expect(state.loadTools).not.toHaveBeenCalled();
  });
  it('reports an invalid flat filename without dropping its valid sibling', async () => {
    const invalid = { ...file, file_id: 'invalid-name', filename: '../bad.pptx' };
    const state = fixture({ requestFiles: [invalid, file] });
    const result = await state.prepare({
      ...state.input,
      agent: { ...state.input.agent, currentRequestAttachments: [invalid, file] },
    });
    expect(result).toContain('invalid_attachment_filename');
    expect(result).toContain('/workspace/Personal/聊天上传/演示.pptx');
    expect(state.invoke.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ attachment_id: invalid.file_id })]),
    );
    expect(state.db.claim).toHaveBeenCalledTimes(1);
  });

  it('uses one finite batch deadline without releasing an ambiguous transfer claim', async () => {
    const state = fixture({ deadline: true });
    const result = await state.prepare({
      ...state.input,
      configServers: { 'workspace-mcp': { timeout: 25 } },
    });
    expect(result).toContain('workspace_copy_deadline');
    expect(result).not.toContain('"workspace_path"');
    expect(state.claimed()).toBe(true);
    expect(state.db.release).not.toHaveBeenCalled();
    expect(state.db.complete).not.toHaveBeenCalled();
  });
  it.each([undefined, 0])(
    'uses the existing 60-second effective timeout for %s',
    async (timeout) => {
      jest.useFakeTimers();
      try {
        const state = fixture({ deadline: true });
        const pending = state.prepare({
          ...state.input,
          configServers: { 'workspace-mcp': { timeout } },
        });
        await jest.advanceTimersByTimeAsync(59_999);
        expect(state.db.release).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(await pending).toContain('workspace_copy_deadline');
      } finally {
        jest.useRealTimers();
      }
    },
  );
  it('request cancellation stops planning even if native transport never settles', async () => {
    const state = fixture({ deadline: true });
    const pending = state.prepare(state.input);
    const rejection = pending.catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    state.controller.abort(new Error('cancelled'));
    expect(await rejection).toEqual(new Error('cancelled'));
    expect(state.db.release).not.toHaveBeenCalled();
  });
  it('preserves unhydrated nearest-group presence and excludes sibling branches', async () => {
    const stored = snapshotWorkspaceBranch([
      { messageId: 'old', isCreatedByUser: true, files: [{ file_id: 'ppt' }] },
      {
        messageId: 'denied',
        parentMessageId: 'old',
        isCreatedByUser: true,
        files: [{ file_id: 'foreign' }],
      },
      {
        messageId: 'sibling',
        parentMessageId: 'old',
        isCreatedByUser: true,
        files: [{ file_id: 'ppt' }],
      },
    ]);
    const messages = workspaceAttachmentBranch(
      [{ messageId: 'now', parentMessageId: 'denied', isCreatedByUser: true }],
      stored,
    );
    expect(messages.map((message) => message.messageId)).toEqual(['old', 'denied', 'now']);
    const state = fixture({ requestFiles: [] });
    expect(
      await state.prepare({ ...state.input, messages, historicalFiles: [file] }),
    ).toBeUndefined();
    expect(state.loadTools).not.toHaveBeenCalled();
  });
});
