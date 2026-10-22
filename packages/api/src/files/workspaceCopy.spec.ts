import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { WorkspaceCopyDeps } from './workspaceCopy';
import {
  prepareWorkspaceCopies,
  formatWorkspaceAttachmentReferences,
  prepareWorkspaceCopiesWithTools,
  workspaceCopyPath,
  selectWorkspaceInputFiles,
  WORKSPACE_BINARY_MAX_BYTES,
} from './workspaceCopy';

const file = (file_id: string, filename = '演示.pptx'): TFile => ({
  file_id,
  filename,
  user: 'owner',
  tenantId: 'tenant',
  context: FileContext.message_attachment,
  source: FileSources.local,
  type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  bytes: 13_393_065,
  usage: 1,
  embedded: false,
  filepath: '/uploads/owner/演示.pptx',
  object: 'file',
});

function fixture(existing: string[] = []) {
  const copies = new Map<string, { path: string; status: 'claimed' | 'ready'; claimId: string }>();
  const nas = new Map(existing.map((path) => [path, 'employee file']));
  const calls: string[] = [];
  const deps: WorkspaceCopyDeps = {
    getFile: async ({ fileId }) => ({ metadata: { workspaceCopy: copies.get(fileId) } }),
    claim: async ({ fileId, path, claimId }) => {
      if (copies.has(fileId)) return null;
      copies.set(fileId, { path, claimId, status: 'claimed' });
      return {};
    },
    advance: async ({ fileId, path, nextPath, claimId }) => {
      const copy = copies.get(fileId);
      if (copy?.path !== path || copy.claimId !== claimId || copy.status !== 'claimed') return null;
      copy.path = nextPath;
      return {};
    },
    complete: async ({ fileId, path, claimId }) => {
      const copy = copies.get(fileId);
      if (copy?.path !== path || copy.claimId !== claimId || copy.status !== 'claimed') return null;
      copy.status = 'ready';
      return {};
    },
    release: async ({ fileId, path, claimId }) => {
      const copy = copies.get(fileId);
      if (copy?.path !== path || copy.claimId !== claimId) return false;
      copies.delete(fileId);
      return true;
    },
    importAttachment: async (_fileId, path) => {
      calls.push(path);
      if (nas.has(path)) return { ok: false, code: 'conflict' };
      nas.set(path, 'raw bytes');
      return { ok: true };
    },
    exists: async (path) => nas.has(path),
  };
  return { copies, nas, calls, deps };
}

describe('Workspace copy preparation', () => {
  const ready = (name = '演示.pptx', path = name) => ({
    filename: name,
    status: 'ready',
    workspace_path: `/workspace/Personal/聊天上传/${path}`,
  });
  it('offers only the collision-resolved path and freshly verifies edited copies on every request', async () => {
    const state = fixture(['聊天上传/演示.pptx']);
    const input = [file('first')];
    expect(await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps)).toEqual([
      ready('演示.pptx', '演示 (2).pptx'),
    ]);
    state.nas.set('聊天上传/演示 (2).pptx', 'edited');
    expect(await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps)).toEqual([
      ready('演示.pptx', '演示 (2).pptx'),
    ]);
    expect(state.nas.get('聊天上传/演示 (2).pptx')).toBe('edited');
    expect(state.nas.get('聊天上传/演示.pptx')).toBe('employee file');
    expect(state.calls).toEqual(['聊天上传/演示.pptx', '聊天上传/演示 (2).pptx']);
    state.nas.delete('聊天上传/演示 (2).pptx');
    expect(await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps)).toMatchObject([
      { status: 'failed', code: 'workspace_copy_moved_or_deleted' },
    ]);
    expect(state.calls).toHaveLength(2);
  });

  it('keeps valid siblings before and after oversized and uncertain files', async () => {
    const state = fixture();
    state.copies.set('uncertain', {
      path: '聊天上传/uncertain.pptx',
      claimId: 'lost',
      status: 'claimed',
    });
    const results = await prepareWorkspaceCopies(
      [
        { ...file('large'), bytes: WORKSPACE_BINARY_MAX_BYTES + 1 },
        file('first', 'first.pptx'),
        file('uncertain', 'uncertain.pptx'),
        file('last', 'last.pptx'),
      ],
      'owner',
      'tenant',
      state.deps,
    );
    expect(results).toMatchObject([
      { status: 'failed', code: 'workspace_import_too_large' },
      ready('first.pptx'),
      { status: 'failed', code: 'workspace_copy_preparation_uncertain' },
      ready('last.pptx'),
    ]);
    expect(formatWorkspaceAttachmentReferences(results)).toContain('NAS Personal');
    expect(state.calls).toEqual(['聊天上传/first.pptx', '聊天上传/last.pptx']);
  });

  it('retains an uncertain claim after publication response loss and never duplicates or overwrites edits', async () => {
    const state = fixture();
    state.deps.importAttachment = async (_id, path) => {
      state.calls.push(path);
      state.nas.set(path, 'published then edited');
      throw Error('lost');
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await prepareWorkspaceCopies([file('lost')], 'owner', 'tenant', state.deps),
      ).toMatchObject([
        {
          status: 'failed',
          code: 'workspace_copy_preparation_uncertain',
          related_path: '/workspace/Personal/聊天上传/演示.pptx',
        },
      ]);
    }
    expect(state.calls).toHaveLength(1);
    expect(state.nas.get('聊天上传/演示.pptx')).toBe('published then edited');
  });

  it('limits concurrent same-file preparation to one import and the next request receives the final path', async () => {
    const state = fixture(['聊天上传/演示.pptx']);
    const results = await Promise.all(
      [1, 2].map(() => prepareWorkspaceCopies([file('same')], 'owner', 'tenant', state.deps)),
    );
    expect(results.flat().filter((result) => result.status === 'ready')).toEqual([
      ready('演示.pptx', '演示 (2).pptx'),
    ]);
    expect(state.calls).toHaveLength(2);
    expect(await prepareWorkspaceCopies([file('same')], 'owner', 'tenant', state.deps)).toEqual([
      ready('演示.pptx', '演示 (2).pptx'),
    ]);
  });

  it('returns a freshly checked concurrent winner path after losing the claim race', async () => {
    const state = fixture(['聊天上传/演示 (3).pptx']);
    state.deps.claim = async () => {
      state.copies.set('same', {
        path: '聊天上传/演示 (3).pptx',
        status: 'ready',
        claimId: 'winner',
      });
      return null;
    };
    expect(await prepareWorkspaceCopies([file('same')], 'owner', 'tenant', state.deps)).toEqual([
      ready('演示.pptx', '演示 (3).pptx'),
    ]);
    expect(state.calls).toHaveLength(0);
  });

  it('stops on cancellation without assuming a pending claim or transfer was rolled back', async () => {
    const state = fixture();
    const controller = new AbortController();
    const claim = state.deps.claim;
    state.deps.claim = async (scope) => {
      const result = await claim(scope);
      controller.abort();
      return result;
    };
    await expect(
      prepareWorkspaceCopies([file('cancelled')], 'owner', 'tenant', state.deps, controller.signal),
    ).rejects.toThrow();
    expect(state.calls).toHaveLength(0);
    expect(state.copies.get('cancelled')?.status).toBe('claimed');
  });

  it.each(['other-owner', 'other-tenant'])(
    'rejects %s without reading a mapping or transferring',
    async (denial) => {
      const state = fixture();
      expect(
        await prepareWorkspaceCopies(
          [file('foreign')],
          denial === 'other-owner' ? denial : 'owner',
          denial === 'other-tenant' ? denial : 'tenant',
          state.deps,
        ),
      ).toMatchObject([{ status: 'failed', code: 'attachment_access_denied' }]);
      expect(state.copies.size).toBe(0);
      expect(state.calls).toHaveLength(0);
    },
  );

  it.each(['string', 'tuple', 'structured', 'text'])(
    'accepts the native %s response shape',
    async (shape) => {
      const state = fixture();
      const callTool = async (name: string) => {
        const value =
          name === 'workspace_list'
            ? { ok: true, entries: [{ name: '演示.pptx', type: 'regular' }] }
            : { ok: true };
        const text = JSON.stringify(value);
        if (shape === 'string') return text;
        if (shape === 'tuple') return [text, undefined] as [string, undefined];
        if (shape === 'structured') return { structuredContent: value };
        return { content: [{ type: 'text', text }] };
      };
      expect(
        await prepareWorkspaceCopiesWithTools({
          files: [file('native')],
          userId: 'owner',
          tenantId: 'tenant',
          db: state.deps,
          callTool,
        }),
      ).toEqual([ready()]);
    },
  );

  it('keeps filenames flat and selects only the nearest attachment group on this branch', () => {
    expect(workspaceCopyPath('../private.pptx')).toBeNull();
    expect(workspaceCopyPath('deck.pptx', 3)).toBe('聊天上传/deck (3).pptx');
    const messages = [
      { isCreatedByUser: true, files: [{ file_id: 'old' }] },
      { isCreatedByUser: true, files: [{ file_id: 'new' }] },
      { isCreatedByUser: true },
    ];
    expect(
      selectWorkspaceInputFiles(
        messages,
        [file('old'), file('new'), file('sibling')],
        'owner',
        'tenant',
      ).map((entry) => entry.file_id),
    ).toEqual(['new']);
    expect(selectWorkspaceInputFiles(messages, [file('old')], 'owner', 'tenant')).toEqual([]);
  });
});
