import express from 'express';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { ToolNode } from '@librechat/agents';
import { AIMessage } from '@langchain/core/messages';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import {
  Command,
  END,
  START,
  MemorySaver,
  StateGraph,
  MessagesAnnotation,
} from '@langchain/langgraph';
import type { Agents, HelpApprovedExport, HelpPackage } from 'librechat-data-provider';
import type { HelpChatMethods, HelpSourceMessage } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import {
  createGardenHelpRuntime,
  helpConversationId,
  messageEvidence,
  sealHelpPackage,
} from './runtime';
import { captureHelpAttachments, verifyHelpAttachment } from './attachments';
import { helpDocumentSource, readHelpKnowledge } from './workspace';
import { resolveToolApprovalResume } from '~/agents/hitl/resume';
import { buildPendingAction } from '~/agents/hitl/policy';
import { createGardenHelpRouter } from './routes';

describe('Garden Help fixed native approval (R2; existing SDK ToolNode/MemorySaver fixture)', () => {
  let temporary: string;
  beforeAll(async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'garden-help-U2-'));
    await writeFile(resolve(temporary, 'secret'), Buffer.alloc(32, 9).toString('base64url'));
  });
  afterAll(async () => {
    if (!temporary.startsWith(resolve(tmpdir()) + sep) || !temporary.includes('garden-help-U2-'))
      throw new Error('Invalid fixture cleanup');
    await rm(temporary, { recursive: true });
  });
  afterEach(() => jest.restoreAllMocks());

  async function fixture() {
    const userId = 'native-user-A';
    const sourceId = 'b213fe6d-7160-4f8b-9ebd-459b19364038';
    const row: HelpSourceMessage = {
      messageId: 'work-leaf',
      text: 'PRIVATE ORIGINAL',
      truncated: false,
      updatedAt: new Date('2026-10-26T00:00:00Z'),
    };
    const evidence = messageEvidence(sourceId, row, new Date().toISOString());
    let retained: HelpApprovedExport | undefined;
    const db: HelpChatMethods = {
      ensureHelpChat: jest.fn(),
      replaceHelpContext: jest.fn(),
      releaseHelpExport: jest.fn(),
      readHelpAttachment: jest.fn(),
      readHelpBranchIds: jest.fn(async () => ['user-choice']),
      readHelpChat: jest.fn(async () => ({
        gardenHelpContext: {
          label: 'selected branch',
          captured_at: new Date().toISOString(),
          evidence: [evidence],
        },
        gardenHelpExports: retained ? [retained] : [],
      })),
      readHelpSources: jest.fn(async (_user, convo) =>
        convo === sourceId
          ? [row]
          : [{ messageId: 'user-choice', text: 'P1', isCreatedByUser: true, truncated: false }],
      ),
      retainHelpExport: jest.fn(async (_user, _convo, value) => {
        retained = value;
        return true;
      }),
    };
    const req = {
      user: { id: userId, openidId: 'casdoor-stable-A' },
      body: { conversationId: helpConversationId(userId), messageId: 'user-choice' },
      config: {
        gardenHelp: {
          preset: 'garden-help',
          serviceURL: 'http://127.0.0.1:25480/mcp',
          siteURL: 'https://help.example.test',
          toolSecretFile: resolve(temporary, 'secret'),
          workspaceURL: 'http://workspace-mcp:8080/mcp',
          parentOrigins: ['https://example.test'],
        },
      },
    } as ServerRequest;
    const requests: { name: string; packageJSON?: string; subject: string | undefined }[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => {
      const body = String(options?.body);
      const rpc = JSON.parse(body);
      const headers = options?.headers as Record<string, string>;
      requests.push({
        name: rpc.params.name,
        subject: headers['X-Garden-Help-Subject'],
        packageJSON: rpc.params.name === 'help_submit_feedback' ? body : undefined,
      });
      const result =
        rpc.params.name === 'help_submission_status'
          ? { error: { code: 'NOT_FOUND' } }
          : { feedback_id: '28', issue_id: '12', opinion_result: 'newer_preserved' };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        }),
        { status: 200 },
      );
    });
    const runtime = (await createGardenHelpRuntime(req, db))!;
    const saver = new MemorySaver();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode(
        'tools',
        new ToolNode<typeof MessagesAnnotation.State>({
          tools: runtime.tools,
          executingAgentId: 'help-agent',
          toolCallStepIds: new Map([['help-call', 'step-help']]),
        }),
      )
      .addEdge(START, 'tools')
      .addEdge('tools', END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: 'native-help-thread', run_id: 'native-help-run' } };
    await graph.invoke(
      {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'help-call',
                name: 'help_submit_feedback',
                args: {
                  shared: {
                    title: 'Preserve spreadsheet layout',
                    description: 'Formatting changes after editing.',
                    module: 'files',
                    expected_change: 'Keep layout',
                  },
                  summary: {
                    goal: 'Edit a sheet',
                    impact: 'Work blocked',
                    attempts: 'Retried once',
                    still_blocked: true,
                  },
                  evidence_ids: [evidence.source.id],
                  urgency_message_id: 'user-choice',
                  ai_priority_suggestion: { level: 'P2', reason: 'There may be a workaround' },
                  association: null,
                },
              },
            ],
          }),
        ],
      },
      config,
    );
    const snapshot = await graph.getState(config);
    const raw = snapshot.tasks[0].interrupts[0].value as {
      type: 'garden_help_copy';
      approval: Agents.ToolApprovalInterruptPayload;
    };
    expect(raw.type).toBe('garden_help_copy');
    const payload = buildPendingAction(raw, {
      streamId: 'help-stream',
      responseMessageId: 'help-response',
    }).payload as Agents.ToolApprovalInterruptPayload;
    return { graph, config, payload, row, db, requests };
  }

  test('a direct graph tool pauses with no generic HITL policy; only exact once approval exports trusted actor/material', async () => {
    const f = await fixture();
    expect(f.requests).toEqual([]);
    expect(f.payload.review_configs[0].allowed_decisions).toEqual(['approve', 'reject']);
    const proposal = f.payload.action_requests[0].arguments as { package_json: string };
    const value = JSON.parse(proposal.package_json) as HelpPackage;
    expect(value.evidence[0].text).toBe('PRIVATE ORIGINAL');
    expect(value.user_urgency).toBe('P1');
    expect(value.ai_priority_suggestion?.level).toBe('P2');
    const forbidden = resolveToolApprovalResume(
      f.payload,
      [{ tool_call_id: 'help-call', decision: 'approve', scope: 'always' }],
      { actionId: 'actual-action' },
    );
    expect(forbidden).toHaveProperty('status', 403);
    const accepted = resolveToolApprovalResume(
      f.payload,
      [{ tool_call_id: 'help-call', decision: 'approve', scope: 'once' }],
      { actionId: 'actual-action' },
    );
    if (!('resumeValue' in accepted)) throw new Error('Expected exact approval');
    await f.graph.invoke(new Command({ resume: accepted.resumeValue }), f.config);
    expect(f.requests.map((r) => r.name)).toEqual([
      'help_submission_status',
      'help_submit_feedback',
    ]);
    expect(f.requests[1].subject).toBe('casdoor-stable-A');
    expect(f.requests[1].packageJSON).toContain(`"package":${proposal.package_json}`);
    expect(f.db.releaseHelpExport).toHaveBeenCalledTimes(1);
  });
  test('refusal creates no Help draft; changed source cannot be exported after approval', async () => {
    const refused = await fixture();
    await refused.graph.invoke(
      new Command({ resume: { 'help-call': { type: 'reject' } } }),
      refused.config,
    );
    expect(refused.requests).toEqual([]);
    expect(refused.db.retainHelpExport).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    const changed = await fixture();
    changed.row.text = 'NEW UNAPPROVED CONTENT';
    const accepted = resolveToolApprovalResume(
      changed.payload,
      [{ tool_call_id: 'help-call', decision: 'approve' }],
      { actionId: 'changed-action' },
    );
    if (!('resumeValue' in accepted)) throw new Error('Expected exact approval');
    const result = await changed.graph.invoke(
      new Command({ resume: accepted.resumeValue }),
      changed.config,
    );
    expect(changed.requests.map((r) => r.name)).toEqual(['help_submission_status']);
    expect(String(result.messages[result.messages.length - 1]?.content)).toContain(
      'SOURCE_CHANGED',
    );
  });
  test('UTF-8 bytes include escaping at the exact 2 MiB boundary; changed urgency changes the seal', () => {
    const value: HelpPackage = {
      schema_version: 1,
      shared: { title: 't', description: 'd', module: '', expected_change: '' },
      summary: { goal: '', impact: '', attempts: '', still_blocked: null },
      evidence: [
        {
          kind: 'original_text',
          text: '',
          source: {
            kind: 'librechat_message',
            id: 'c/m',
            revision: 'original-v1',
            retrieved_at: '2026-10-26T00:00:00Z',
            range: 'Selected original text',
          },
        },
      ],
      visibility: { shared: 'garden_authenticated', private: 'owner_and_help_maintainers' },
      association: null,
      opinion_revision: 0,
      user_urgency: null,
      ai_priority_suggestion: null,
    };
    const empty = sealHelpPackage(value);
    value.evidence[0].text = 'a'.repeat(2097152 - Buffer.byteLength(empty.package_json));
    expect(Buffer.byteLength(sealHelpPackage(value).package_json)).toBe(2097152);
    value.evidence[0].text += '你';
    expect(() => sealHelpPackage(value)).toThrow('TOO_LARGE');
    value.evidence[0].text = '"\\你';
    const a = sealHelpPackage(value);
    value.user_urgency = 'P3';
    expect(sealHelpPackage(value).sha256).not.toBe(a.sha256);
  });
});

describe('Garden Help selected attachment and readonly Workspace boundaries (R2)', () => {
  afterEach(() => jest.restoreAllMocks());
  test('real document route replaces the previous source with the exact versioned section and refuses stale or mismatched scope', async () => {
    const version = 'a'.repeat(64);
    const content =
      '# Published title\n\n## First step\nFIRST BODY\n### Child step\nCHILD BODY\n```md\n## Not a heading\n```\n## Second step\nSECOND BODY\n';
    const manifest = JSON.stringify({
      version,
      documents: [
        {
          id: 'nas/windows',
          url: 'https://help.example.test/nas/windows/',
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => {
      const rpc = JSON.parse(String(options?.body));
      const data = rpc.params.arguments.path === 'Help/manifest.json' ? manifest : content;
      return new Response(
        JSON.stringify({
          result: {
            structuredContent: {
              ok: true,
              truncated: false,
              content_base64: Buffer.from(data).toString('base64'),
            },
          },
        }),
      );
    });
    let context: unknown = { label: 'previous work source' };
    const db = {
      replaceHelpContext: jest.fn(async (_user, _id, next) => {
        context = next;
        return true;
      }),
    } as unknown as HelpChatMethods;
    const app = express();
    app.use(express.json(), (req, _res, next) => {
      Object.assign(req, {
        user: { id: 'native-owner', openidId: 'trusted-subject' },
        config: {
          gardenHelp: {
            preset: 'garden-help',
            serviceURL: 'http://help/mcp',
            siteURL: 'https://help.example.test',
            toolSecretFile: '/fixture/secret',
            workspaceURL: 'http://workspace/mcp',
            parentOrigins: ['https://help.example.test'],
          },
        },
      });
      next();
    });
    app.use('/help', createGardenHelpRouter(db, { workspaceSecret: 'fixture' }));
    const post = (body: Record<string, unknown>) =>
      request(app).post('/help/document').set('Origin', 'https://help.example.test').send(body);
    const result = await post({ id: 'nas/windows', version, section: 0, heading: 'First step' });
    expect(result.status).toBe(200);
    const scope = helpDocumentSource(
      'nas/windows',
      { version, url: 'https://help.example.test/nas/windows/', content },
      0,
    );
    expect(result.body.context.evidence).toEqual([
      expect.objectContaining({
        text: scope.content,
        source: expect.objectContaining({
          id: scope.id,
          range: scope.range,
          revision: scope.revision,
        }),
      }),
    ]);
    expect(scope.content).toContain('CHILD BODY');
    expect(scope.content).not.toContain('SECOND BODY');
    expect(context).not.toEqual(expect.objectContaining({ label: 'previous work source' }));
    const retained = context;
    expect(
      (
        await post({
          id: 'nas/windows',
          version: 'b'.repeat(64),
          section: 0,
          heading: 'First step',
        })
      ).status,
    ).toBe(409);
    expect(
      (await post({ id: 'nas/windows', version, section: 1, heading: 'Second step' })).status,
    ).toBe(409);
    expect(context).toBe(retained);
    const whole = await post({ id: 'nas/windows', version });
    expect(whole.status).toBe(200);
    expect(whole.body.context.evidence[0].text).toBe(content);
    expect(whole.body.context.evidence[0].source.id).toBe('nas/windows');
    expect(whole.body.context.selection).toEqual({ kind: 'document', id: 'nas/windows' });
    expect(result.body.context.selection).toEqual({
      kind: 'document',
      id: 'nas/windows',
      section: 0,
      heading: 'First step',
    });
  });
  test('only explicit content selection reads original native bytes; a changed or inaccessible source fails revalidation', async () => {
    let bytes = 'ORIGINAL';
    const req = { user: { id: 'native-owner' } } as ServerRequest;
    const db = {
      readHelpAttachment: jest.fn(async () => ({
        file_id: 'file',
        filename: 'fixture.txt',
        type: 'text/plain',
        bytes: 8,
        source: 'local',
        filepath: '/fixture',
      })),
    } as unknown as HelpChatMethods;
    const download = jest.fn(async () => Readable.from([Buffer.from(bytes)]));
    const deps = { getStrategyFunctions: jest.fn(() => ({ getDownloadStream: download })) };
    const selected = {
      conversationId: 'conversation',
      messageIds: ['message'],
      attachments: [{ messageId: 'message', fileId: 'file', content: false }],
    };
    const metadata = await captureHelpAttachments(req, db, selected, deps);
    expect(download).not.toHaveBeenCalled();
    expect(metadata[0].content_base64).toBeUndefined();
    expect(JSON.parse(metadata[0].text!)).toEqual({
      name: 'fixture.txt',
      media_type: 'text/plain',
      bytes: 8,
    });
    // The scoped cross-repository contract check feeds these exact production
    // bytes to Go, including its approval and receiver boundary.
    if (process.env.HELP_ATTACHMENT_CONTRACT_OUTPUT) {
      const value: HelpPackage = {
        schema_version: 1,
        shared: {
          title: 'Selected attachment metadata',
          description: 'Metadata only',
          module: 'files',
          expected_change: 'Keep the selected metadata',
        },
        summary: {
          goal: 'Metadata without content',
          impact: '',
          attempts: '',
          still_blocked: null,
        },
        evidence: metadata,
        visibility: { shared: 'garden_authenticated', private: 'owner_and_help_maintainers' },
        user_urgency: null,
        opinion_revision: 0,
        association: null,
        ai_priority_suggestion: null,
      };
      await writeFile(
        process.env.HELP_ATTACHMENT_CONTRACT_OUTPUT,
        sealHelpPackage(value).package_json,
      );
    }
    selected.attachments[0].content = true;
    const evidence = await captureHelpAttachments(req, db, selected, deps);
    expect(evidence[0].content_base64).toBe(Buffer.from('ORIGINAL').toString('base64'));
    expect(db.readHelpAttachment).toHaveBeenCalledWith(
      'native-owner',
      'conversation',
      'message',
      'file',
      true,
    );
    expect(await verifyHelpAttachment(req, db, evidence[0], deps)).toBe(true);
    bytes = 'REVISED!';
    expect(await verifyHelpAttachment(req, db, evidence[0], deps)).toBe(false);
    (db.readHelpAttachment as jest.Mock).mockResolvedValue(null);
    expect(await verifyHelpAttachment(req, db, evidence[0], deps)).toBe(false);
    await expect(
      captureHelpAttachments(req, db, { ...selected, messageIds: ['different-branch'] }, deps),
    ).rejects.toThrow('INVALID_SOURCE');
  });
  test('knowledge uses only company Help manifest/allowlist and trusted subject, with immutable content hash', async () => {
    const content = 'Allowed published Help knowledge';
    const sha256 = createHash('sha256').update(content).digest('hex');
    const manifest = JSON.stringify({
      version: 'a'.repeat(64),
      documents: [{ id: 'index', sha256, url: 'https://help.example.test/' }],
    });
    const calls: { path: string; name: string; subject: string; scope: string }[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => {
      const rpc = JSON.parse(String(options!.body));
      calls.push({
        path: rpc.params.arguments.path,
        name: rpc.params.name,
        scope: rpc.params.arguments.scope,
        subject: (options!.headers as Record<string, string>)['X-Garden-Workspace-Subject'],
      });
      const text = rpc.params.arguments.path.endsWith('manifest.json') ? manifest : content;
      return new Response(
        JSON.stringify({
          result: {
            structuredContent: {
              ok: true,
              truncated: false,
              content_base64: Buffer.from(text).toString('base64'),
            },
          },
        }),
      );
    });
    expect(
      await readHelpKnowledge('http://workspace/mcp', 'trusted-subject', 'service-secret', 'index'),
    ).toMatchObject({ content, version: 'a'.repeat(64) });
    expect(calls).toEqual([
      {
        path: 'Help/manifest.json',
        name: 'workspace_read',
        scope: 'company',
        subject: 'trusted-subject',
      },
      {
        path: 'Help/index.md',
        name: 'workspace_read',
        scope: 'company',
        subject: 'trusted-subject',
      },
    ]);
    await expect(
      readHelpKnowledge(
        'http://workspace/mcp',
        'trusted-subject',
        'service-secret',
        '../restricted',
      ),
    ).rejects.toThrow('KNOWLEDGE_UNAVAILABLE');
    expect(calls).toHaveLength(2);
  });
});
