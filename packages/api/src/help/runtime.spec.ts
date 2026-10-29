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

  async function fixture(
    options: {
      messages?: HelpSourceMessage[];
      currentMessageId?: string;
      input?: Record<string, unknown>;
    } = {},
  ) {
    const userId = 'native-user-A';
    const sourceId = 'b213fe6d-7160-4f8b-9ebd-459b19364038';
    const row: HelpSourceMessage = {
      messageId: 'work-leaf',
      text: 'PRIVATE ORIGINAL',
      truncated: false,
      updatedAt: new Date('2026-10-26T00:00:00Z'),
    };
    const evidence = messageEvidence(sourceId, row, new Date().toISOString());
    const currentMessageId = options.currentMessageId ?? 'user-choice';
    const messages = options.messages ?? [
      { messageId: 'user-choice', text: 'P1', isCreatedByUser: true, truncated: false },
    ];
    const conversationId = helpConversationId(userId);
    let retained: HelpApprovedExport | undefined;
    const db: HelpChatMethods = {
      ensureHelpChat: jest.fn(),
      replaceHelpContext: jest.fn(),
      releaseHelpExport: jest.fn(),
      readHelpAttachment: jest.fn(),
      readHelpBranchIds: jest.fn(async () => messages.map((message) => message.messageId)),
      readHelpChat: jest.fn(async () => ({
        gardenHelpContext: {
          label: 'selected branch',
          captured_at: new Date().toISOString(),
          evidence: [evidence],
        },
        gardenHelpExports: retained ? [retained] : [],
      })),
      readHelpSources: jest.fn(async (user, convo, ids) =>
        user !== userId
          ? []
          : (convo === sourceId ? [row] : convo === conversationId ? messages : []).filter(
              (message) => ids.includes(message.messageId),
            ),
      ),
      retainHelpExport: jest.fn(async (_user, _convo, value) => {
        retained = value;
        return true;
      }),
    };
    const req = {
      user: { id: userId, openidId: 'casdoor-stable-A' },
      body: { conversationId, messageId: currentMessageId },
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
                  ...options.input,
                },
              },
            ],
          }),
        ],
      },
      config,
    );
    const snapshot = await graph.getState(config);
    const raw = snapshot.tasks[0]?.interrupts[0]?.value as {
      type: 'garden_help_copy';
      approval: Agents.ToolApprovalInterruptPayload;
    };
    if (raw) expect(raw.type).toBe('garden_help_copy');
    const payload = raw
      ? (buildPendingAction(raw, {
          streamId: 'help-stream',
          responseMessageId: 'help-response',
        }).payload as Agents.ToolApprovalInterruptPayload)
      : ({
          action_requests: [],
          review_configs: [],
        } as unknown as Agents.ToolApprovalInterruptPayload);
    return { graph, config, payload, row, db, requests, snapshot, runtime, conversationId };
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
  // Exact captured Responses arguments at fork ca9e649; synthetic IDs are deliberately not repaired.
  const capturedSubmissions = [
    {
      ordinal: 5,
      args: {
        ai_priority_suggestion: {
          level: 'P2',
          reason: '当前能继续使用，但重复寻找帮助对话增加操作成本。',
        },
        association: {
          issue_id: '91001',
          revision: 1,
        },
        evidence_ids: ['r6-case-3-user'],
        shared: {
          description: '再次打开 Garden Help 时，希望能继续本人上次的帮助会话，而不必重新寻找。',
          expected_change:
            '再次打开 Garden Help 时，自动显示本人最近的帮助会话并支持从上次位置继续。',
          module: 'Garden Help 会话连续性',
          title: '再次打开 Garden Help 时继续上次会话',
        },
        summary: {
          attempts: '上次使用过 Garden Help；再次打开时需要重新寻找之前的帮助聊天。',
          goal: '再次打开 Garden Help 时接着上次的帮助聊天。',
          impact: '重复寻找帮助过程，增加操作成本。',
          still_blocked: true,
        },
        urgency_message_id: 'r6-case-3-user',
      },
    },
    {
      ordinal: 6,
      args: {
        ai_priority_suggestion: {
          level: 'P3',
          reason:
            '目前是偶发的阅读不便：导出内容发到微信后字较小，但尚未说明造成工作中断或无法完成发送。',
        },
        association: {
          issue_id: '91002',
          revision: 1,
        },
        evidence_ids: ['r6-case-4-user'],
        shared: {
          description: '导出内容发送到微信后，接收方阅读时文字显示偏小，影响查看清晰度。',
          expected_change:
            '提供适合微信转发和手机阅读的导出排版或字号选项，并尽量保持内容清晰易读。',
          module: '导出与分享',
          title: '导出内容发到微信后文字偏小',
        },
        summary: {
          attempts: '用户只使用过一次导出后发送到微信的方式，尚未尝试其他方法。',
          goal: '让发送给同事的导出内容在微信中更清楚易读。',
          impact: '同事查看内容时觉得文字偏小，阅读不够清晰。',
          still_blocked: false,
        },
        urgency_message_id: null,
      },
    },
    {
      ordinal: 8,
      args: {
        ai_priority_suggestion: {
          level: 'P2',
          reason:
            '用户每天需要查找旧答案，目前依赖向上翻找，造成持续的使用成本；尚未描述为紧急中断。',
        },
        association: null,
        evidence_ids: ['r6-case-5-user'],
        shared: {
          description: '帮助聊天目前缺少搜索本人历史提问或答案的方式，查找旧内容需要翻阅历史对话。',
          expected_change: '在帮助聊天中提供搜索本人过去提问和答案的功能。',
          module: 'Help 聊天',
          title: '搜索自己的历史提问和答案',
        },
        summary: {
          attempts: '目前通过向上翻阅历史聊天查找旧答案。',
          goal: '在帮助聊天中搜索自己之前的提问和答案。',
          impact: '每天需要查找一次旧答案，向上翻阅历史带来重复的查找成本。',
          still_blocked: false,
        },
        urgency_message_id: 'r6-case-6-user',
      },
    },
    {
      ordinal: 10,
      args: {
        ai_priority_suggestion: {
          level: 'P2',
          reason: '表格排版影响报价单可读性和交付质量；目前没有信息表明系统或业务流程大范围中断。',
        },
        association: null,
        evidence_ids: ['r6-case-6-user'],
        shared: {
          description:
            '编辑表格后，报价单内容可能出现排版挤在一起、难以阅读的问题；即使明确要求保留原列宽，问题仍可能存在。',
          expected_change:
            '编辑表格时保留原列宽，并自动检查或避免内容挤压，确保报价单在交付前清晰可读。',
          module: '表格编辑与排版',
          title: '表格编辑后报价单排版挤压',
        },
        summary: {
          attempts: '已重述保留原列宽的要求，问题仍未解决。',
          goal: '让报价单保持原列宽并清晰可读。',
          impact: '报价单排版挤在一起，客户难以看清，影响材料交付。',
          still_blocked: true,
        },
        urgency_message_id: null,
      },
    },
  ];
  test.each(capturedSubmissions)(
    'R6 request $ordinal: bare/fabricated evidence never becomes a copy',
    async ({ args }) => {
      const f = await fixture({ input: args });
      expect(f.payload.action_requests).toEqual([]);
      expect(String(f.snapshot.values.messages.at(-1)?.content)).toContain('INVALID_SOURCE');
      expect(f.requests).toEqual([]);
      expect(f.db.retainHelpExport).not.toHaveBeenCalled();
    },
  );

  const currentId = '25b16724-70a9-4f27-96a3-0c127bde1b36';
  const priorId = '90bca694-c49a-4d4c-9e32-6f7b0bf418f8';
  const earlierId = '5198c1e4-592f-4053-9cc7-f1166ef61172';
  const own = helpConversationId('native-user-A');
  const message = (id: string, text: string, user = true, parent?: string): HelpSourceMessage => ({
    messageId: id,
    text,
    isCreatedByUser: user,
    parentMessageId: parent,
    truncated: false,
  });
  const proposed = (f: Awaited<ReturnType<typeof fixture>>) =>
    JSON.parse(
      (f.payload.action_requests[0]?.arguments as { package_json: string }).package_json,
    ) as HelpPackage;

  test.each(capturedSubmissions)(
    'R6 request $ordinal with explicit native reference mapping preserves the actual user choice',
    async ({ ordinal, args }) => {
      const history: Record<number, { user: string; ai: string; urgency: string | null }> = {
        5: {
          user: '我选 P2。这就是我的情况，愿意把刚才这些话作为改进候选提交，具体归到哪里你帮我判断就好。',
          ai: 'AI 建议：P2，当前能继续使用，但重复寻找帮助对话增加操作成本。你也可以选别的级别，或先空着。',
          urgency: 'P2',
        },
        6: {
          user: '我选 P3，就这一次看到的问题，我愿意记录。具体是不是别人提过的那个，我不懂，你来判断吧。',
          ai: 'AI 建议：P3，目前是偶发的阅读不便，仍能完成发送。你觉得对自己有多急？也可以先空着。',
          urgency: 'P3',
        },
        8: {
          user: '就按你的建议。那你们明天肯定能把这个功能做出来，对吧？',
          ai: 'AI 建议：P2，反复查找会增加使用成本，但目前能通过翻历史继续完成。你觉得对自己有多急？可以先空着。',
          urgency: 'P2',
        },
        10: {
          user: '我不确定优先级，先空着。我愿意把刚才的情况作为改进候选，但共享给大家的描述不要出现客户名字和报价。',
          ai: 'AI 建议：P2，影响交付材料的可读性，但目前没有确认大范围中断。你可以选自己的级别，也可以先空着。',
          urgency: null,
        },
      };
      const actual = history[ordinal];
      const f = await fixture({
        currentMessageId: currentId,
        messages: [
          message(currentId, actual.user, true, priorId),
          message(priorId, actual.ai, false),
        ],
        // Only evidence IDs are explicitly mapped from the synthetic harness. All model
        // fields, including its null/wrong urgency ID and association, remain unchanged.
        input: { ...args, evidence_ids: [`${own}/${currentId}`] },
      });
      expect(proposed(f).user_urgency).toBe(actual.urgency);
      expect(proposed(f).shared).toEqual(args.shared);
      expect(proposed(f).association).toEqual(args.association);
      expect(
        proposed(f).evidence.find((item) => item.source.id === `${own}/${currentId}`)?.text,
      ).toBe(actual.user);
      expect(f.requests.every((request) => request.name === 'help_get_issue')).toBe(true);
      expect(f.db.retainHelpExport).not.toHaveBeenCalled();
    },
  );

  test('native UUID references identify recent authorized messages and re-read their original text', async () => {
    const text =
      '我选 P3，就这一次看到的问题，我愿意记录。具体是不是别人提过的那个，我不懂，你来判断吧。';
    const f = await fixture({
      currentMessageId: currentId,
      messages: [message(currentId, text, true, priorId), message(priorId, 'AI 建议：P3。', false)],
      input: { evidence_ids: [`${own}/${currentId}`], urgency_message_id: null },
    });
    expect(f.runtime.instructions).toContain(`${own}/${currentId}`);
    expect(f.runtime.instructions).toContain(`${own}/${priorId}`);
    expect(f.runtime.instructions).toContain(JSON.stringify(text));
    expect(proposed(f).evidence[0].text).toBe(text);
    expect(proposed(f).user_urgency).toBe('P3');
    expect(f.requests).toEqual([]);
    expect(f.db.readHelpSources).toHaveBeenCalledWith('native-user-A', own, [currentId]);
  });

  test.each(['P0', 'P1', 'P2', 'P3'])(
    'current explicit %s survives a wrong model urgency reference',
    async (p) => {
      const f = await fixture({
        currentMessageId: currentId,
        messages: [message(currentId, `我选 ${p}，请记录。`)],
        input: { evidence_ids: [], urgency_message_id: 'r6-case-6-user' },
      });
      expect(proposed(f).user_urgency).toBe(p);
      expect(proposed(f).evidence.map((item) => item.source.id)).toEqual([`${own}/${currentId}`]);
      expect(jest.mocked(f.db.readHelpSources).mock.calls.flatMap((call) => call[2])).not.toContain(
        'r6-case-6-user',
      );
    },
  );

  test('reference previews are bounded; the approved copy keeps the complete selected original', async () => {
    const text = '原文💡'.repeat(100);
    const f = await fixture({
      currentMessageId: currentId,
      messages: [
        message(currentId, text),
        ...Array.from({ length: 17 }, (_, i) =>
          message(`5198c1e4-592f-4053-9cc7-${String(i).padStart(12, '0')}`, `history ${i}`),
        ),
      ],
      input: { evidence_ids: [`${own}/${currentId}`], urgency_message_id: null },
    });
    expect(jest.mocked(f.db.readHelpSources).mock.calls[0][2]).toHaveLength(16);
    expect(f.runtime.instructions).toContain(Array.from(text).slice(0, 240).join(''));
    expect(f.runtime.instructions).not.toContain(text);
    expect(f.runtime.instructions).not.toContain('history 16');
    expect(proposed(f).evidence[0].text).toBe(text);
    expect(proposed(f).user_urgency).toBeNull();
  });

  test('adoption uses actual preceding AI advice despite wrong model reference and suggestion', async () => {
    const f = await fixture({
      currentMessageId: currentId,
      messages: [
        message(currentId, '就按你的建议。那你们明天肯定能把这个功能做出来，对吧？', true, priorId),
        message(
          priorId,
          'AI 建议：P2，反复查找会增加使用成本，但目前能通过翻历史继续完成。你觉得对自己有多急？可以先空着。',
          false,
        ),
      ],
      input: {
        evidence_ids: [],
        urgency_message_id: 'r6-case-6-user',
        ai_priority_suggestion: { level: 'P1', reason: 'model mismatch' },
      },
    });
    expect(proposed(f).user_urgency).toBe('P2');
    expect(proposed(f).ai_priority_suggestion?.level).toBe('P1');
    expect(proposed(f).evidence.map((item) => item.source.id)).toEqual([
      `${own}/${priorId}`,
      `${own}/${currentId}`,
    ]);
  });

  test.each([
    '我不确定优先级，先空着。我愿意把刚才的情况作为改进候选。',
    '同意共享',
    'P3 是什么意思？',
    '我选 P3 吗？',
    '我选 P1 或 P3',
  ])('current non-vote stays null despite a stale model reference: %s', async (text) => {
    const f = await fixture({
      currentMessageId: currentId,
      messages: [
        message(currentId, text, true, priorId),
        message(priorId, 'AI 建议：P2。', false, earlierId),
        message(earlierId, '我选 P0'),
      ],
      input: { evidence_ids: [], urgency_message_id: earlierId },
    });
    expect(proposed(f).user_urgency).toBeNull();
    expect(proposed(f).evidence).toEqual([]);
  });

  test.each([
    { text: 'AI 建议：P2。', user: true, parent: priorId },
    { text: 'AI 建议：P2。', user: false, parent: 'another-branch' },
    { text: 'AI 建议：P2 或 P3。', user: false, parent: priorId },
    { text: '有人说建议：P1。', user: false, parent: priorId },
  ])(
    'unverified prior advice never casts an adopted vote: $text / $parent / $user',
    async ({ text, user, parent }) => {
      const f = await fixture({
        currentMessageId: currentId,
        messages: [
          message(currentId, '就按你的建议。', true, parent),
          message(priorId, text, user),
        ],
        input: { evidence_ids: [], urgency_message_id: currentId },
      });
      expect(proposed(f).user_urgency).toBeNull();
      expect(jest.mocked(f.db.readHelpSources).mock.calls.flatMap((call) => call[2])).not.toContain(
        'another-branch',
      );
    },
  );

  test.each([
    `${own}/another-branch`,
    `${helpConversationId('other-user')}/${currentId}`,
    currentId,
  ])('only exact owned current-branch evidence is exportable: %s', async (id) => {
    const f = await fixture({
      currentMessageId: currentId,
      messages: [message(currentId, '同意共享')],
      input: { evidence_ids: [id] },
    });
    expect(f.payload.action_requests).toEqual([]);
    expect(String(f.snapshot.values.messages.at(-1)?.content)).toContain('INVALID_SOURCE');
    expect(f.requests).toEqual([]);
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
