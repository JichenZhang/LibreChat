import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { Readable, Writable } from 'node:stream';
import type { TFile } from 'librechat-data-provider';

/** Preserve HTTP backpressure while enforcing the Workspace binary contract. */
export async function streamWorkspaceAttachment(
  source: Readable,
  destination: Writable,
  maxBytes: number,
  expectedBytes?: number,
): Promise<void> {
  let total = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(total <= maxBytes ? null : new Error('WORKSPACE_FILE_TOO_LARGE'), chunk);
    },
    flush(callback) {
      callback(
        expectedBytes == null || total === expectedBytes
          ? null
          : new Error('WORKSPACE_FILE_SIZE_MISMATCH'),
      );
    },
  });
  await pipeline(source, limit, destination);
}

type AttachmentRecord = Pick<
  TFile,
  'file_id' | 'user' | 'tenantId' | 'filename' | 'filepath' | 'type' | 'bytes' | 'usage'
> & {
  source: FileSources.local;
  context: FileContext.message_attachment;
  expiredAt?: Date | null;
};

type HandoffStage = 'validation' | 'retention' | 'storage' | 'registration';
type CleanupResult = 'not_needed' | 'succeeded' | 'failed';

export class WorkspaceHandoffError extends Error {
  readonly status: 400 | 503;
  readonly stage: HandoffStage;
  readonly cleanup: CleanupResult;
  readonly cause: unknown;

  constructor(stage: HandoffStage, cause?: unknown, cleanup: CleanupResult = 'not_needed') {
    super('Workspace attachment handoff failed');
    this.status = stage === 'validation' ? 400 : 503;
    this.stage = stage;
    this.cleanup = cleanup;
    this.cause = cause;
  }
}

export type WorkspaceAttachmentDependencies = {
  saveBuffer?: (input: {
    userId: string;
    buffer: Buffer;
    fileName: string;
    basePath: 'uploads';
  }) => Promise<string>;
  createFile: (
    file: AttachmentRecord,
    disableTTL: true,
  ) => Promise<Pick<TFile, 'file_id' | 'filename'> | null>;
  deleteFile?: (file: { filepath: string; user: string }) => Promise<void>;
  getRetentionExpiry: () => Promise<{ expiredAt?: Date | null }>;
  getMimeType: (filename: string) => string | null;
};

export async function publishWorkspaceAttachment(
  input: {
    bytes: unknown;
    filename: unknown;
    userId: string;
    tenantId?: string;
    maxBytes: number;
  },
  dependencies: WorkspaceAttachmentDependencies,
): Promise<Pick<TFile, 'file_id' | 'filename'>> {
  const { bytes, filename, userId, tenantId, maxBytes } = input;
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    typeof filename !== 'string' ||
    // eslint-disable-next-line no-control-regex
    !/^[^/\\\x00-\x1f]{1,255}$/.test(filename) ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new WorkspaceHandoffError('validation');
  }
  if (!dependencies.saveBuffer) {
    throw new WorkspaceHandoffError('storage');
  }

  let retention: { expiredAt?: Date | null };
  try {
    retention = await dependencies.getRetentionExpiry();
  } catch (error) {
    throw new WorkspaceHandoffError('retention', error);
  }

  const fileId = randomUUID();
  let filepath: string;
  try {
    filepath = await dependencies.saveBuffer({
      userId,
      buffer: bytes,
      fileName: `${fileId}__${filename}`,
      basePath: 'uploads',
    });
  } catch (error) {
    throw new WorkspaceHandoffError('storage', error);
  }

  try {
    const file = await dependencies.createFile(
      {
        file_id: fileId,
        user: userId,
        tenantId,
        filename,
        filepath,
        source: FileSources.local,
        context: FileContext.message_attachment,
        type: dependencies.getMimeType(filename) || 'application/octet-stream',
        bytes: bytes.length,
        usage: 1,
        ...retention,
      },
      true,
    );
    if (!file) {
      throw new Error('File registration returned no record');
    }
    return { file_id: file.file_id, filename: file.filename };
  } catch (error) {
    let cleanup: CleanupResult = 'failed';
    if (dependencies.deleteFile) {
      try {
        await dependencies.deleteFile({ filepath, user: userId });
        cleanup = 'succeeded';
      } catch {
        // Preserve the registration error as the cause; report cleanup separately.
      }
    }
    throw new WorkspaceHandoffError('registration', error, cleanup);
  }
}
