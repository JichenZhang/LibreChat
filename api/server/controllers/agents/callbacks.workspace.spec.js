const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Constants, FileContext, FileSources } = require('librechat-data-provider');
const { createModels, tenantStorage, logger } = require('@librechat/data-schemas');
const {
  MCPManager,
  MCPServersRegistry,
  publishWorkspaceAttachment,
  createOwnedToolEndHandler,
  GenerationJobManager,
  createStreamServices,
  enqueueWorkspaceExport,
} = require('@librechat/api');

// Only external services/connection acquisition are replaced. Tool invocation, MCP SDK,
// result formatting, completion, BaseClient persistence and Mongo methods stay real.
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isMCPDomainAllowed: jest.fn(async () => true),
}));
jest.mock('~/models', () =>
  jest.requireActual('@librechat/data-schemas').createMethods(require('mongoose')),
);
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getMCPServersRegistry: jest.fn(() => ({})),
  getFlowStateManager: jest.fn(() => ({})),
}));
jest.mock('~/cache', () => ({ getLogStores: jest.fn(() => ({})) }));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({})),
}));
jest.mock('~/server/services/Tools/mcp', () => ({ reinitMCPServer: jest.fn() }));
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));
jest.mock('~/server/services/OboTokenService', () => ({ exchangeOboToken: jest.fn() }));
jest.mock('~/server/services/OboPolicyService', () => ({ createOboTrustChecker: jest.fn() }));
jest.mock('~/server/services/OpenIDSessionRefresh', () => ({}));
jest.mock('~/server/services/Schedules', () => ({ recordMCPToolAuthFailure: jest.fn() }));
jest.mock('~/server/services/Files/Citations', () => ({ processFileCitations: jest.fn() }));
jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));
jest.mock('~/server/services/Files/Code/preflight', () => ({
  preflightCodeOutputBatch: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({ saveBase64Image: jest.fn() }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));

const db = require('~/models');
const { createMCPTool } = require('~/server/services/MCP');
const { createToolEndCallback } = require('./callbacks');
const { initializeFakeClient } = require('~/app/clients/specs/FakeClient');
const BaseClient = require('~/app/clients/BaseClient');

describe('Workspace export through native MCP and attachment completion', () => {
  let mongo, sdk, server, manager, file, user, context, response, models;
  const name = `workspace_chat_download${Constants.mcp_delimiter}workspace-mcp`;
  const serverConfig = {
    type: 'streamable-http',
    source: 'yaml',
    url: 'http://workspace-mcp:8080/mcp',
    requiresOAuth: false,
  };
  const bytes = Buffer.from('synthetic selected export\n');
  const storedBytes = new Map();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    models = createModels(mongoose);
    sdk = new Client({ name: 'local-export-regression', version: '1' });
    server = new McpServer({ name: 'workspace-mcp', version: 'test' });
    server.tool('workspace_chat_download', {}, async () => response);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await sdk.connect(clientTransport);
    manager = new MCPManager();
    jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({});
    jest.spyOn(manager, 'getConnection').mockResolvedValue({
      client: sdk,
      timeout: 30000,
      isConnected: async () => true,
      usesOAuth: () => false,
      setRequestHeaders: () => {},
    });
    require('~/config').getMCPManager.mockReturnValue(manager);
  });

  afterAll(async () => {
    await sdk?.close();
    await server?.close();
    await mongoose.disconnect();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await models.File.collection.deleteMany({});
    await models.Message.collection.deleteMany({});
    storedBytes.clear();
    user = { id: new mongoose.Types.ObjectId().toString(), tenantId: 'synthetic-tenant' };
    context = {
      run_id: randomUUID(),
      thread_id: randomUUID(),
      provider: 'openai',
      agent_id: 'synthetic-agent',
    };
    file = await tenantStorage.run({ tenantId: user.tenantId }, async () =>
      publishWorkspaceAttachment(
        {
          bytes,
          filename: 'selected.txt',
          userId: user.id,
          tenantId: user.tenantId,
          maxBytes: 1024,
        },
        {
          createFile: db.createFile,
          saveBuffer: async ({ fileName, buffer }) => {
            const filepath = `/uploads/${user.id}/${fileName}`;
            storedBytes.set(filepath, buffer);
            return filepath;
          },
          getRetentionExpiry: async () => ({ expiredAt: new Date(Date.now() + 3600000) }),
          getMimeType: () => 'text/plain',
        },
      ),
    );
    response = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, file_id: file.file_id }) }],
      structuredContent: { ok: true, file_id: file.file_id },
    };
  });

  async function invoke(config = serverConfig, extra = {}) {
    const nativeTool = await createMCPTool({
      user,
      res: {},
      toolKey: name,
      provider: 'openai',
      config,
      mcpPermissionContext: { canUseServers: async () => true },
      availableTools: {
        [name]: {
          serverToolName: 'workspace_chat_download',
          function: {
            description: 'Export selected file',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    });
    return nativeTool.invoke(
      { type: 'tool_call', id: 'selected-call', name, args: {} },
      {
        configurable: { user },
        metadata: context,
        toolCall: { id: 'selected-call', name },
        ...extra,
      },
    );
  }

  async function complete(output, metadata = context, effectiveUser = user, res = {}) {
    const artifactPromises = [];
    const write = jest.fn();
    const callback = createToolEndCallback({
      req: { user: effectiveUser },
      res: { headersSent: true, write, ...res },
      artifactPromises,
    });
    const handler = createOwnedToolEndHandler(callback);
    const graph = { toolCallStepIds: new Map([['selected-call', 'native-step']]) };
    await tenantStorage.run({ tenantId: effectiveUser.tenantId }, async () => {
      await handler.handle('on_tool_end', { output }, metadata, graph);
      await handler.handle('on_tool_end', { output }, metadata, graph);
    });
    return {
      artifactPromises,
      attachments: (await Promise.all(artifactPromises)).filter(Boolean),
      write,
    };
  }

  it('emits once, persists without prose links, reloads, and reuses registered bytes', async () => {
    const output = await invoke();
    expect(output.artifact?.workspaceExport).toBeInstanceOf(
      require('@librechat/api').WorkspaceExport,
    );
    expect(output).toMatchObject({ name, tool_call_id: 'selected-call' });
    expect(output.artifact.workspaceExport.identity).toEqual({
      messageId: context.run_id,
      conversationId: context.thread_id,
      toolCallId: 'selected-call',
      toolName: name,
    });
    const { artifactPromises, attachments, write } = await complete(output);
    expect(attachments).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
    const attachment = attachments[0];
    expect(attachment).toMatchObject({
      file_id: file.file_id,
      user: user.id,
      tenantId: user.tenantId,
      messageId: context.run_id,
      conversationId: context.thread_id,
      toolCallId: 'selected-call',
      agentId: 'synthetic-agent',
      stepId: 'native-step',
      source: FileSources.local,
      context: FileContext.message_attachment,
    });
    expect(write.mock.calls[0][0]).toContain('event: attachment\n');
    expect(storedBytes.get(attachment.filepath)).toEqual(bytes);
    expect(await models.File.collection.countDocuments()).toBe(1);

    const client = initializeFakeClient(
      'synthetic',
      {
        endpoint: 'openAI',
        modelOptions: { model: 'synthetic' },
        req: { user, body: {}, config: {} },
      },
      [],
    );
    client.skipSaveConvo = true;
    client.artifactPromises = artifactPromises;
    const saved = await tenantStorage.run({ tenantId: user.tenantId }, async () =>
      client.sendMessage('Export the selected synthetic file.', {
        user: user.id,
        conversationId: context.thread_id,
        responseMessageId: context.run_id,
      }),
    );
    await saved.databasePromise;
    expect(saved.text).toBe('Mock response text');
    expect(saved.text).not.toMatch(/https?:|\]\(|\/api\/files/);
    expect(saved.attachments).toEqual(attachments);
    const reloaded = await tenantStorage.run({ tenantId: user.tenantId }, async () =>
      db.getMessages({ user: user.id, conversationId: context.thread_id }),
    );
    expect(reloaded.find((message) => !message.isCreatedByUser).attachments).toEqual(attachments);
    const resumed = await tenantStorage.run({ tenantId: user.tenantId }, async () =>
      BaseClient.prototype.loadHistory.call(client, context.thread_id, saved.messageId),
    );
    expect(resumed.find((message) => message.messageId === saved.messageId).attachments).toEqual(
      attachments,
    );
  });

  it.each(['user', 'plugin', undefined])('rejects non-operator source %s', async (source) => {
    expect((await complete(await invoke({ ...serverConfig, source }))).attachments).toEqual([]);
  });

  it('rejects another endpoint and caller-shaped JSON artifacts', async () => {
    expect(
      (await complete(await invoke({ ...serverConfig, url: 'https://example.invalid/mcp' })))
        .attachments,
    ).toEqual([]);
    const genuine = await invoke();
    expect((await complete(JSON.parse(JSON.stringify(genuine)))).attachments).toEqual([]);
  });

  it.each([
    'error',
    'unsuccessful',
    'text-only',
    'missing',
    'deleted',
    'expired',
    'other-owner',
    'other-tenant',
    'no-tenant',
    'upload',
  ])('does not attach %s', async (failure) => {
    if (failure === 'error') response.isError = true;
    if (failure === 'unsuccessful') response.structuredContent.ok = false;
    if (failure === 'text-only') delete response.structuredContent;
    if (failure === 'missing') response.structuredContent.file_id = randomUUID();
    if (failure === 'deleted') await models.File.collection.deleteOne({ file_id: file.file_id });
    if (failure === 'expired')
      await models.File.collection.updateOne(
        { file_id: file.file_id },
        { $set: { expiredAt: new Date(0) } },
      );
    if (failure === 'other-owner')
      await models.File.collection.updateOne(
        { file_id: file.file_id },
        { $set: { user: new mongoose.Types.ObjectId() } },
      );
    if (failure === 'other-tenant')
      await models.File.collection.updateOne(
        { file_id: file.file_id },
        { $set: { tenantId: 'another-tenant' } },
      );
    if (failure === 'no-tenant') delete user.tenantId;
    if (failure === 'upload')
      await models.File.collection.updateOne(
        { file_id: file.file_id },
        { $set: { context: FileContext.avatar } },
      );
    expect((await complete(await invoke())).attachments).toEqual([]);
  });

  it.each(['run_id', 'thread_id'])('does not redirect the result to another %s', async (field) => {
    const output = await invoke();
    expect((await complete(output, { ...context, [field]: randomUUID() })).attachments).toEqual([]);
    expect((await complete(output)).attachments).toHaveLength(1);
  });

  it('rejects another tool, caller and post-completion abort', async () => {
    const output = await invoke();
    expect((await complete({ ...output, tool_call_id: 'other-call' })).attachments).toEqual([]);
    expect((await complete(output, context, { ...user, id: randomUUID() })).attachments).toEqual(
      [],
    );
    const controller = new AbortController();
    const cancelled = await invoke(serverConfig, { signal: controller.signal });
    controller.abort();
    expect((await complete(cancelled)).attachments).toEqual([]);
  });

  it('keeps persistence on a closed response without writing after end', async () => {
    const { attachments, write } = await complete(await invoke(), context, user, {
      writableEnded: true,
    });
    expect(attachments).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('replays the native resumable attachment event under the owning generation', async () => {
    await GenerationJobManager.destroy();
    GenerationJobManager.configure({ ...createStreamServices(), cleanupOnComplete: false });
    GenerationJobManager.initialize();
    const emitted = jest.spyOn(GenerationJobManager, 'emitChunk');
    try {
      const job = await GenerationJobManager.createJob(
        context.thread_id,
        user.id,
        context.thread_id,
      );
      const artifactPromises = [];
      const callback = createToolEndCallback({
        req: { user },
        res: {},
        artifactPromises,
        streamId: context.thread_id,
        jobCreatedAt: job.createdAt,
      });
      const output = await invoke();
      await tenantStorage.run({ tenantId: user.tenantId }, async () => {
        await callback({ output }, context);
        await callback({ output }, context);
        await Promise.all(artifactPromises);
      });
      await Promise.all(emitted.mock.results.map(({ value }) => value));
      expect(emitted).toHaveBeenCalledTimes(1);
      expect(emitted.mock.calls[0][2]).toEqual({ expectedCreatedAt: job.createdAt });
      const resumedEvents = [];
      const resumed = await GenerationJobManager.subscribeWithResume(
        context.thread_id,
        (event) => resumedEvents.push(event),
        undefined,
        undefined,
        { expectedCreatedAt: job.createdAt },
      );
      expect(resumed.subscription).not.toBeNull();
      resumed.subscription.activate();
      resumed.subscription.unsubscribe();
      expect(
        [
          ...(resumed.resumeState?.replayEvents ?? []),
          ...resumed.pendingEvents,
          ...resumedEvents,
        ].filter((event) => event.event === 'attachment'),
      ).toEqual([{ event: 'attachment', data: await artifactPromises[0] }]);
    } finally {
      emitted.mockRestore();
      await GenerationJobManager.destroy();
    }
  });

  it('contains a lookup outage and cancellation during the lookup without emitting', async () => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      const output = await invoke(serverConfig, { signal: controller.signal });
      const artifactPromises = [];
      const emit = jest.fn();
      enqueueWorkspaceExport({
        data: { output },
        metadata: context,
        user,
        artifactPromises,
        emit,
        findFileById: async (...args) => {
          if (!cancelled) throw new Error('synthetic confidential database diagnostic');
          const stored = await tenantStorage.run({ tenantId: user.tenantId }, async () =>
            db.findFileById(...args),
          );
          controller.abort();
          return stored;
        },
      });
      expect(await Promise.all(artifactPromises)).toEqual([null]);
      expect(emit).not.toHaveBeenCalled();
    }
    expect(logger.error).toHaveBeenCalledWith('Workspace export attachment completion failed');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'confidential database diagnostic',
    );
  });
});
