import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { WorkspaceCopyDeps } from './workspaceCopy';
import {
  prepareWorkspaceCopies,
  workspaceCopyGateResult,
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
  it('returns the real flat path before running a command and reuses edits later', async () => {
    const state = fixture(['聊天上传/演示.pptx']);
    const input = [file('first')];
    const first = await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps);
    expect(first).toEqual({
      execute: false,
      command_not_run: true,
      prepared_paths: ['/workspace/Personal/聊天上传/演示 (2).pptx'],
    });
    expect(
      JSON.parse(workspaceCopyGateResult(first as Exclude<typeof first, { execute: true }>)[0]),
    ).toMatchObject({ command_not_run: true });
    state.nas.set('聊天上传/演示 (2).pptx', 'edited employee copy');
    expect(await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps)).toEqual({
      execute: true,
    });
    expect(state.nas.get('聊天上传/演示 (2).pptx')).toBe('edited employee copy');
    expect(state.calls).toEqual(['聊天上传/演示.pptx', '聊天上传/演示 (2).pptx']);
    expect(state.nas.get('聊天上传/演示.pptx')).toBe('employee file');
  });

  it('allocates a further suffix only for a distinct attachment', async () => {
    const state = fixture();
    await prepareWorkspaceCopies([file('first')], 'owner', 'tenant', state.deps);
    const second = await prepareWorkspaceCopies([file('second')], 'owner', 'tenant', state.deps);
    expect(second).toMatchObject({
      prepared_paths: ['/workspace/Personal/聊天上传/演示 (2).pptx'],
    });
  });

  it('blocks ambiguous claims, missing mapped files and foreign attachments', async () => {
    const state = fixture();
    state.copies.set('first', {
      path: '聊天上传/演示.pptx',
      status: 'claimed',
      claimId: 'other-request',
    });
    expect(
      await prepareWorkspaceCopies([file('first')], 'owner', 'tenant', state.deps),
    ).toMatchObject({ execute: false, error: 'workspace_copy_preparation_uncertain' });
    state.copies.set('first', {
      path: '聊天上传/演示.pptx',
      status: 'ready',
      claimId: 'other-request',
    });
    expect(
      await prepareWorkspaceCopies([file('first')], 'owner', 'tenant', state.deps),
    ).toMatchObject({ execute: false, error: 'workspace_copy_moved_or_deleted' });
    expect(
      await prepareWorkspaceCopies([file('foreign')], 'other', 'tenant', state.deps),
    ).toMatchObject({ execute: false, error: 'attachment_access_denied' });
    expect(state.calls).toEqual([]);
  });

  it('gates the command on partial preparation and preserves the first copy', async () => {
    const state = fixture();
    const importAttachment = state.deps.importAttachment;
    state.deps.importAttachment = async (fileId, path, signal) =>
      fileId === 'second'
        ? { ok: false, code: 'too_large' }
        : importAttachment(fileId, path, signal);
    const result = await prepareWorkspaceCopies(
      [file('first', 'first.pptx'), file('second', 'second.pptx')],
      'owner',
      'tenant',
      state.deps,
    );
    expect(result).toMatchObject({
      execute: false,
      command_not_run: true,
      prepared_paths: ['/workspace/Personal/聊天上传/first.pptx'],
      error: 'workspace_import_too_large',
    });
    expect(state.copies.get('first')?.status).toBe('ready');
    expect(state.copies.has('second')).toBe(false);
  });

  it('releases a claim cancelled before transfer without publishing a copy', async () => {
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
    expect(state.copies.size).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it('preserves a published copy after a lost response and blocks duplicate recovery imports', async () => {
    const state = fixture();
    state.deps.importAttachment = async (_fileId, path) => {
      state.calls.push(path);
      state.nas.set(path, 'published then edited');
      throw new Error('lost transfer response');
    };
    const input = [file('uncertain')];
    const first = await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps);
    const retry = await prepareWorkspaceCopies(input, 'owner', 'tenant', state.deps);
    expect(first).toMatchObject({ execute: false, error: 'workspace_copy_preparation_uncertain' });
    expect(retry).toMatchObject({ execute: false, error: 'workspace_copy_preparation_uncertain' });
    expect(state.calls).toEqual(['聊天上传/演示.pptx']);
    expect(state.nas.get('聊天上传/演示.pptx')).toBe('published then edited');
    expect(
      JSON.parse(workspaceCopyGateResult(retry as Exclude<typeof retry, { execute: true }>)[0]),
    ).toMatchObject({
      command_not_run: true,
      related_path: '/workspace/Personal/聊天上传/演示.pptx',
      guidance: expect.stringContaining('NAS Personal'),
    });
  });

  it('allows only one transfer during concurrent preparations of the same attachment', async () => {
    const state = fixture();
    const results = await Promise.all([
      prepareWorkspaceCopies([file('same')], 'owner', 'tenant', state.deps),
      prepareWorkspaceCopies([file('same')], 'owner', 'tenant', state.deps),
    ]);
    expect(state.calls).toEqual(['聊天上传/演示.pptx']);
    expect(results.every((result) => !result.execute)).toBe(true);
    expect(state.copies.get('same')?.status).toBe('ready');
    expect(await prepareWorkspaceCopies([file('same')], 'owner', 'tenant', state.deps)).toEqual({
      execute: true,
    });
  });

  it('keeps filenames as one safe component', () => {
    expect(workspaceCopyPath('../private.pptx')).toBeNull();
    expect(workspaceCopyPath('deck.pptx', 3)).toBe('聊天上传/deck (3).pptx');
  });

  it('keeps an oversized native upload saved and gives a NAS route without attempting import', async () => {
    const state = fixture();
    const large = { ...file('large'), bytes: WORKSPACE_BINARY_MAX_BYTES + 1 };
    const result = await prepareWorkspaceCopies([large], 'owner', 'tenant', state.deps);
    expect(result).toMatchObject({ execute: false, error: 'workspace_import_too_large' });
    expect(
      JSON.parse(workspaceCopyGateResult(result as Exclude<typeof result, { execute: true }>)[0]),
    ).toMatchObject({ command_not_run: true, guidance: expect.stringContaining('NAS Personal') });
    expect(state.calls).toEqual([]);
    expect(state.copies.size).toBe(0);
  });

  it('selects only the latest authorized branch attachment group', () => {
    const first = file('first');
    const newest = file('newest');
    const sibling = file('sibling');
    expect(
      selectWorkspaceInputFiles(
        [
          { isCreatedByUser: true, files: [{ file_id: first.file_id }] },
          { isCreatedByUser: true, files: [{ file_id: newest.file_id }] },
          { isCreatedByUser: true },
        ],
        [first, newest, sibling],
        'owner',
        'tenant',
      ).map((selected) => selected.file_id),
    ).toEqual(['newest']);
    expect(
      selectWorkspaceInputFiles(
        [
          { isCreatedByUser: true, files: [{ file_id: first.file_id }] },
          { isCreatedByUser: true, files: [{ file_id: 'not-authorized' }] },
        ],
        [first],
        'owner',
        'tenant',
      ),
    ).toEqual([]);
  });
});
