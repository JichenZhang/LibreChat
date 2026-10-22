import mongoose from 'mongoose';
import { Readable, Writable } from 'node:stream';
import { fileSchema } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { WorkspaceAttachmentDependencies } from './workspaceAttachment';
import {
  publishWorkspaceAttachment,
  streamWorkspaceAttachment,
  WorkspaceHandoffError,
} from './workspaceAttachment';

describe('Workspace attachment stream bound', () => {
  it('copies incident-sized bytes and rejects an unknown-length stream beyond 64 MiB', async () => {
    const incidentBytes = Buffer.alloc(13_393_065, 0x5a);
    const chunks: Buffer[] = [];
    await streamWorkspaceAttachment(
      Readable.from([incidentBytes]),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      }),
      64 << 20,
    );
    expect(Buffer.concat(chunks)).toEqual(incidentBytes);

    await expect(
      streamWorkspaceAttachment(
        Readable.from([Buffer.from('short')]),
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
        64 << 20,
        6,
      ),
    ).rejects.toThrow('WORKSPACE_FILE_SIZE_MISMATCH');

    let delivered = 0;
    const oneMiB = Buffer.alloc(1 << 20, 0x42);
    const unboundedSource = Readable.from(
      (async function* () {
        for (let index = 0; index < 65; index++) yield oneMiB;
      })(),
    );
    await expect(
      streamWorkspaceAttachment(
        unboundedSource,
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            delivered += chunk.length;
            done();
          },
        }),
        64 << 20,
      ),
    ).rejects.toThrow('WORKSPACE_FILE_TOO_LARGE');
    expect(delivered).toBeLessThanOrEqual(64 << 20);
  });
});

describe('Workspace attachment contract with native file indexes', () => {
  let mongo: MongoMemoryServer;
  let File: mongoose.Model<IMongoFile>;
  const userId = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    File = mongoose.model<IMongoFile>('File', fileSchema);
    await File.init();
  }, 120_000);

  beforeEach(async () => {
    await File.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (File) mongoose.deleteModel('File');
    if (mongo) await mongo.stop();
  });

  const oldFile = (fileId: string) => ({
    file_id: fileId,
    user: userId,
    tenantId: 'tenant-a',
    filename: 'previous.docx',
    filepath: `/uploads/${userId}/${fileId}.docx`,
    source: FileSources.local,
    context: FileContext.run_artifact,
    type: 'application/octet-stream',
    bytes: 8,
    usage: 1,
  });

  const dependencies = (stored: Map<string, Buffer>, deleted: string[]) => ({
    saveBuffer: jest.fn(async ({ buffer, fileName }: { buffer: Buffer; fileName: string }) => {
      const filepath = `/uploads/${userId}/${fileName}`;
      stored.set(filepath, buffer);
      return filepath;
    }),
    createFile: jest.fn(
      async (data: Parameters<WorkspaceAttachmentDependencies['createFile']>[0]) =>
        File.findOneAndUpdate({ file_id: data.file_id }, data, { new: true, upsert: true }).lean(),
    ),
    deleteFile: jest.fn(async ({ filepath }: { filepath: string }) => {
      deleted.push(filepath);
      stored.delete(filepath);
    }),
    getRetentionExpiry: jest.fn(async () => ({})),
    getMimeType: jest.fn(() => 'application/octet-stream'),
  });

  it('reproduces the old collision and delivers repeated native attachments alongside the old link', async () => {
    await File.create(oldFile('legacy-ok'));
    await expect(File.create(oldFile('legacy-duplicate'))).rejects.toMatchObject({ code: 11000 });

    const stored = new Map<string, Buffer>();
    const deps = dependencies(stored, []);
    const expiredAt = new Date('2030-01-01T00:00:00.000Z');
    deps.getRetentionExpiry.mockResolvedValue({ expiredAt });
    const input = { filename: 'report.docx', userId, tenantId: 'tenant-a', maxBytes: 10_000 };
    const firstBytes = Buffer.from('first attachment');
    const secondBytes = Buffer.from('second attachment');
    const first = await publishWorkspaceAttachment({ ...input, bytes: firstBytes }, deps);
    const second = await publishWorkspaceAttachment({ ...input, bytes: secondBytes }, deps);

    expect(first.file_id).not.toBe(second.file_id);
    const records = await File.find({ file_id: { $in: [first.file_id, second.file_id] } }).lean();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.context).toBe(FileContext.message_attachment);
      expect(record.user.toString()).toBe(userId);
      expect(record.tenantId).toBe('tenant-a');
      expect(record.expiredAt).toEqual(expiredAt);
      expect(record.expiresAt).toBeUndefined();
    }
    expect(
      stored.get(records.find((record) => record.file_id === first.file_id)!.filepath),
    ).toEqual(firstBytes);
    expect(
      stored.get(records.find((record) => record.file_id === second.file_id)!.filepath),
    ).toEqual(secondBytes);
    const legacy = await File.findOne({ file_id: 'legacy-ok' }).lean();
    expect(legacy?.context).toBe(FileContext.run_artifact);
    expect(legacy?.filepath).toBe(oldFile('legacy-ok').filepath);
    expect(await File.countDocuments()).toBe(3);
  });

  it('deletes only the new copy after registration failure', async () => {
    const stored = new Map<string, Buffer>();
    const deleted: string[] = [];
    const deps = dependencies(stored, deleted);
    const original = new Error('private database detail');
    deps.createFile.mockRejectedValueOnce(original);

    await expect(
      publishWorkspaceAttachment(
        { bytes: Buffer.from('new'), filename: 'report.docx', userId, maxBytes: 10_000 },
        deps,
      ),
    ).rejects.toMatchObject({
      status: 503,
      stage: 'registration',
      cleanup: 'succeeded',
      cause: original,
    });
    expect(deleted).toHaveLength(1);
    expect(stored.size).toBe(0);
  });

  it('preserves the registration failure and reports cleanup failure without leaking either detail', async () => {
    const deps = dependencies(new Map(), []);
    const original = new Error('private database detail');
    deps.createFile.mockRejectedValueOnce(original);
    deps.deleteFile.mockRejectedValueOnce(new Error('private storage detail'));

    let failure: WorkspaceHandoffError | undefined;
    try {
      await publishWorkspaceAttachment(
        { bytes: Buffer.from('new'), filename: 'report.docx', userId, maxBytes: 10_000 },
        deps,
      );
    } catch (error) {
      if (error instanceof WorkspaceHandoffError) failure = error;
    }
    expect(failure).toMatchObject({
      status: 503,
      stage: 'registration',
      cleanup: 'failed',
      cause: original,
    });
    expect(failure?.message).not.toContain('private');
  });
});
