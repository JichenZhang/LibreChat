import { randomUUID } from 'node:crypto';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';

type Copy = NonNullable<NonNullable<TFile['metadata']>['workspaceCopy']>;
type ScopedFile = Pick<
  TFile,
  'file_id' | 'user' | 'tenantId' | 'filename' | 'context' | 'source' | 'metadata'
> & { bytes?: number };
type Scope = { fileId: string; userId: string; tenantId?: string | null };
type ClaimedScope = Scope & { path: string; claimId: string };

export type WorkspaceCopyDeps = {
  getFile: (scope: Scope) => Promise<{ metadata?: { workspaceCopy?: Copy } } | null>;
  claim: (scope: ClaimedScope) => Promise<unknown | null>;
  advance: (scope: ClaimedScope & { nextPath: string }) => Promise<unknown | null>;
  complete: (scope: ClaimedScope) => Promise<unknown | null>;
  release: (scope: ClaimedScope) => Promise<boolean>;
  importAttachment: (
    fileId: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; code?: string }>;
  exists: (path: string, signal?: AbortSignal) => Promise<boolean>;
};

export type WorkspaceCopyResult =
  | { execute: true }
  | {
      execute: false;
      command_not_run: true;
      prepared_paths: string[];
      error?: string;
      related_path?: string;
    };

export const WORKSPACE_BINARY_MAX_BYTES: number = 64 * 1024 * 1024;

type RawToolResponse = {
  isError?: boolean;
  structuredContent?: {
    ok?: boolean;
    error?: { code?: string };
    entries?: Array<{ name: string; type: string }>;
    next_cursor?: string;
  };
  content?: Array<{ type?: string; text?: string }>;
};
type ToolResponse = RawToolResponse | [string, unknown];

function toolPayload(response: ToolResponse): NonNullable<RawToolResponse['structuredContent']> {
  if (Array.isArray(response))
    return JSON.parse(response[0]) as NonNullable<RawToolResponse['structuredContent']>;
  const raw = response as RawToolResponse;
  if (raw.structuredContent) return raw.structuredContent;
  const text = raw.content?.find((part) => part.type === 'text')?.text;
  if (!text) throw new Error('Workspace tool returned no result');
  return JSON.parse(text) as NonNullable<RawToolResponse['structuredContent']>;
}

export function workspaceCopyGateResult(
  result: Exclude<WorkspaceCopyResult, { execute: true }>,
): [string, undefined] {
  const payload = {
    ok: !result.error,
    command_not_run: true,
    prepared_paths: result.prepared_paths,
    ...(result.error ? { error: { code: result.error } } : {}),
    ...(result.related_path ? { related_path: result.related_path } : {}),
    ...(result.error === 'workspace_import_too_large'
      ? {
          guidance:
            'The original chat upload remains saved. Workspace work copies are limited to 64 MiB. Copy this file to your own NAS Personal directory with Explorer or Finder, then give the Agent its exact relative path. Do not upload the same file again.',
        }
      : {}),
    ...(result.error === 'workspace_copy_moved_or_deleted'
      ? {
          guidance:
            'The linked Workspace copy was moved or deleted. Ask for its new exact Personal path; do not overwrite the old path or ask for the original upload again.',
        }
      : {}),
  };
  return [JSON.stringify(payload), undefined];
}

export async function prepareWorkspaceCopiesWithTools(input: {
  files: readonly ScopedFile[];
  userId: string;
  tenantId?: string;
  db: Omit<WorkspaceCopyDeps, 'importAttachment' | 'exists'>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResponse>;
  signal?: AbortSignal;
}): Promise<WorkspaceCopyResult> {
  const { files, userId, tenantId, db, callTool, signal } = input;
  return prepareWorkspaceCopies(
    files,
    userId,
    tenantId,
    {
      ...db,
      importAttachment: async (fileId, path, transferSignal) => {
        const result = toolPayload(
          await callTool(
            'workspace_import_attachment',
            { attachment_id: fileId, scope: 'personal', path },
            transferSignal,
          ),
        );
        return { ok: result.ok === true, code: result.error?.code?.toLowerCase() };
      },
      exists: async (path, checkSignal) => {
        const slash = path.lastIndexOf('/');
        if (slash < 1) throw new Error('Invalid stored Workspace path');
        const directoryPath = path.slice(0, slash);
        const name = path.slice(slash + 1);
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = toolPayload(
            await callTool(
              'workspace_list',
              { scope: 'personal', path: directoryPath, limit: 500, ...(cursor ? { cursor } : {}) },
              checkSignal,
            ),
          );
          if (result.ok !== true || !Array.isArray(result.entries))
            throw new Error('Workspace copy verification unavailable');
          if (result.entries.some((entry) => entry.name === name && entry.type === 'regular'))
            return true;
          if (!result.next_cursor) return false;
          cursor = result.next_cursor;
        }
        throw new Error('Workspace copy verification exceeded directory bound');
      },
    },
    signal,
  );
}

const directory = '聊天上传';
const virtualPrefix = '/workspace/Personal/';
const safeFailure = (code: string, paths: string[], relatedPath?: string): WorkspaceCopyResult => ({
  execute: false,
  command_not_run: true,
  prepared_paths: paths,
  error: code,
  ...(relatedPath ? { related_path: virtualPrefix + relatedPath } : {}),
});

export function workspaceCopyPath(filename: string, ordinal = 1): string | null {
  // Filename is data from a native File row. Keep it one NAS component.
  if (
    typeof filename !== 'string' ||
    filename === '.' ||
    filename === '..' ||
    // eslint-disable-next-line no-control-regex
    !/^[^/\\\x00-\x1f:<>"|?*]{1,255}$/.test(filename) ||
    /[. ]$/.test(filename)
  ) {
    return null;
  }
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  const name = ordinal === 1 ? filename : `${stem} (${ordinal})${extension}`;
  return Buffer.byteLength(name, 'utf8') <= 255 ? `${directory}/${name}` : null;
}

export function isWorkspaceCopyPath(filename: string, path: string): boolean {
  for (let ordinal = 1; ordinal <= 101; ordinal++) {
    if (workspaceCopyPath(filename, ordinal) === path) return true;
  }
  return false;
}

export function trustedWorkspaceFiles(
  files: readonly ScopedFile[],
  userId: string,
  tenantId?: string,
): ScopedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (
      !file ||
      file.context !== FileContext.message_attachment ||
      file.source === FileSources.text ||
      String(file.user) !== userId ||
      String(file.tenantId ?? '') !== String(tenantId ?? '') ||
      typeof file.file_id !== 'string' ||
      !file.file_id ||
      seen.has(file.file_id) ||
      workspaceCopyPath(file.filename) == null
    ) {
      return false;
    }
    seen.add(file.file_id);
    return true;
  });
}

/** Select only the most recent attachment-bearing user turn on this branch. */
export function selectWorkspaceInputFiles(
  messages: readonly {
    isCreatedByUser?: boolean;
    files?: Array<{ file_id?: string } | null> | null;
  }[],
  authorizedFiles: readonly ScopedFile[],
  userId: string,
  tenantId?: string,
): ScopedFile[] {
  const byId = new Map(authorizedFiles.map((file) => [file.file_id, file]));
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.isCreatedByUser !== true ||
      !Array.isArray(message.files) ||
      message.files.length === 0
    )
      continue;
    const group = trustedWorkspaceFiles(
      message.files
        .map((reference) => byId.get(reference?.file_id ?? ''))
        .filter((file): file is ScopedFile => file != null),
      userId,
      tenantId,
    );
    // A newer attached turn cannot revive an older group when its own files
    // are no longer authorized or allowed for historical replay.
    return group;
  }
  return [];
}

export async function prepareWorkspaceCopies(
  files: readonly ScopedFile[],
  userId: string,
  tenantId: string | undefined,
  deps: WorkspaceCopyDeps,
  signal?: AbortSignal,
): Promise<WorkspaceCopyResult> {
  const paths: string[] = [];
  let created = false;
  const trusted = trustedWorkspaceFiles(files, userId, tenantId);
  if (trusted.length !== files.length) return safeFailure('attachment_access_denied', paths);
  try {
    for (const file of trusted) {
      signal?.throwIfAborted();
      const scope: Scope = { fileId: file.file_id, userId, tenantId };
      let stored = await deps.getFile(scope);
      if (!stored) return safeFailure('attachment_access_denied', paths);
      let copy = stored.metadata?.workspaceCopy;
      if (copy?.status === 'ready') {
        if (!isWorkspaceCopyPath(file.filename, copy.path))
          return safeFailure('workspace_copy_preparation_uncertain', paths);
        if (!(await deps.exists(copy.path, signal)))
          return safeFailure('workspace_copy_moved_or_deleted', paths, copy.path);
        paths.push(virtualPrefix + copy.path);
        continue;
      }
      if (copy) return safeFailure('workspace_copy_preparation_uncertain', paths, copy.path);
      if (typeof file.bytes === 'number' && file.bytes > WORKSPACE_BINARY_MAX_BYTES) {
        return safeFailure('workspace_import_too_large', paths);
      }

      const claimId = randomUUID();
      let path = workspaceCopyPath(file.filename);
      if (!path) return safeFailure('invalid_attachment_filename', paths);
      const claimed = await deps.claim({ ...scope, path, claimId });
      if (!claimed) {
        stored = await deps.getFile(scope);
        copy = stored?.metadata?.workspaceCopy;
        if (copy?.status === 'ready') {
          if (!isWorkspaceCopyPath(file.filename, copy.path))
            return safeFailure('workspace_copy_preparation_uncertain', paths);
          if (!(await deps.exists(copy.path, signal)))
            return safeFailure('workspace_copy_moved_or_deleted', paths, copy.path);
          paths.push(virtualPrefix + copy.path);
          continue;
        }
        return safeFailure('workspace_copy_preparation_uncertain', paths, copy?.path);
      }

      if (signal?.aborted) {
        await deps.release({ ...scope, path, claimId });
        signal.throwIfAborted();
      }

      for (let ordinal = 1; ordinal <= 100; ordinal++) {
        if (signal?.aborted) {
          await deps.release({ ...scope, path, claimId });
          signal.throwIfAborted();
        }
        let imported: { ok: boolean; code?: string };
        try {
          imported = await deps.importAttachment(file.file_id, path, signal);
        } catch {
          // The importer may have published the file before the connection failed.
          return safeFailure('workspace_copy_preparation_uncertain', paths, path);
        }
        if (imported.ok) {
          const completed = await deps.complete({ ...scope, path, claimId });
          if (!completed) return safeFailure('workspace_copy_preparation_uncertain', paths, path);
          paths.push(virtualPrefix + path);
          created = true;
          break;
        }
        if (imported.code === 'conflict') {
          if (ordinal === 100) {
            const released = await deps.release({ ...scope, path, claimId });
            return released
              ? safeFailure('workspace_name_exhausted', paths)
              : safeFailure('workspace_copy_preparation_uncertain', paths, path);
          }
          const nextPath = workspaceCopyPath(file.filename, ordinal + 1);
          if (!nextPath) {
            const released = await deps.release({ ...scope, path, claimId });
            return released
              ? safeFailure('workspace_name_exhausted', paths)
              : safeFailure('workspace_copy_preparation_uncertain', paths, path);
          }
          if (!(await deps.advance({ ...scope, path, nextPath, claimId }))) {
            return safeFailure('workspace_copy_preparation_uncertain', paths, path);
          }
          path = nextPath;
          continue;
        }
        if (['forbidden', 'not_found', 'too_large', 'invalid_path'].includes(imported.code ?? '')) {
          if (!(await deps.release({ ...scope, path, claimId }))) {
            return safeFailure('workspace_copy_preparation_uncertain', paths, path);
          }
          return safeFailure(`workspace_import_${imported.code}`, paths);
        }
        return safeFailure('workspace_copy_preparation_uncertain', paths, path);
      }
      if (!paths.includes(virtualPrefix + path))
        return safeFailure('workspace_name_exhausted', paths);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return safeFailure('workspace_copy_preparation_uncertain', paths);
  }
  if (created) return { execute: false, command_not_run: true, prepared_paths: paths };
  return { execute: true };
}
