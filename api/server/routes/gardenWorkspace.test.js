const express = require('express');
const request = require('supertest');
const { Readable } = require('node:stream');
const { FileSources, ResourceType, PermissionBits } = require('librechat-data-provider');

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  findAccessibleResources: jest.fn(),
  resolveDownloadPath: (file) => file.filepath,
}));
jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = { paths: { uploads: '/app/uploads' } };
  next();
});
jest.mock('~/server/services/PermissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('~/models', () => ({
  findUsers: jest.fn(), getFiles: jest.fn(), getAgents: jest.fn(), createFile: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/skillDeps', () => ({
  getSkillDbMethods: jest.fn(),
  getSkillToolDeps: jest.fn(),
  withDeploymentSkillIds: (ids) => ids,
}));

const db = require('~/models');
const { findAccessibleResources } = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getSkillDbMethods, getSkillToolDeps } = require('~/server/services/Endpoints/agents/skillDeps');
const router = require('./gardenWorkspace');

const secret = 'a'.repeat(43);
const auth = (subject = 'employee-a') => ({
  Authorization: `Bearer ${secret}`,
  'X-Garden-Workspace-Subject': subject,
});
const userA = { _id: { toString: () => 'u1' }, openidId: 'employee-a', role: 'USER', tenantId: 'tenant-1' };
const userB = { _id: { toString: () => 'u2' }, openidId: 'employee-b', role: 'USER', tenantId: 'tenant-1' };

describe('Garden native Workspace file adapter', () => {
  let app;
  let binary;
  let saveBuffer;
  beforeEach(() => {
    process.env.GARDEN_WORKSPACE_MCP_SERVICE_SECRET = secret;
    app = express();
    app.use('/api/garden/workspace', router);
    binary = Buffer.from(Array.from({ length: 150_000 }, (_, index) => index & 255));
    saveBuffer = jest.fn().mockResolvedValue('/uploads/u1/stored-report.zip');
    db.findUsers.mockImplementation(async ({ openidId }) => [openidId === 'employee-a' ? userA : userB]);
    db.getFiles.mockResolvedValue([{
      file_id: 'file-1', user: 'u1', tenantId: 'tenant-1', filename: 'report.docx',
      filepath: '/uploads/u1/report.docx', source: FileSources.local, bytes: binary.length,
    }]);
    db.getAgents.mockResolvedValue([]);
    db.createFile.mockImplementation(async (file) => file);
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: async () => Readable.from(binary), saveBuffer, deleteFile: jest.fn(),
    });
    const skill = { _id: { toString: () => '0123456789abcdef01234567' }, name: 'docx', version: 3, body: 'Use scripts/build.py' };
    getSkillDbMethods.mockReturnValue({
      getSkillByName: jest.fn(async (_name, ids) => ids.includes('0123456789abcdef01234567') ? skill : null),
      listSkillFiles: jest.fn(async () => [{ relativePath: 'scripts/build.py', bytes: binary.length }]),
      getSkillFileByPath: jest.fn(async (_id, name) => name === 'scripts/build.py'
        ? { relativePath: name, bytes: binary.length, source: FileSources.local, filepath: '/uploads/u1/build.py' }
        : null),
    });
    getSkillToolDeps.mockReturnValue({ getStrategyFunctions });
    findAccessibleResources.mockImplementation(async ({ userId }) => userId === 'u1'
      ? ['0123456789abcdef01234567'] : []);
  });
  afterEach(() => { delete process.env.GARDEN_WORKSPACE_MCP_SERVICE_SECRET; });

  it('streams a raw 150 KB owned attachment and denies another user and missing service auth', async () => {
    const ok = await request(app).get('/api/garden/workspace/attachments/file-1').set(auth()).expect(200);
    expect(Buffer.compare(ok.body, binary)).toBe(0);
    await request(app).get('/api/garden/workspace/attachments/file-1').set(auth('employee-b')).expect(403);
    await request(app).get('/api/garden/workspace/attachments/file-1').expect(401);
  });

  it('returns native Skill relative assets only within current user access', async () => {
    const manifest = await request(app).get('/api/garden/workspace/skills/docx').set(auth()).expect(200);
    expect(manifest.body.files).toEqual([{ path: 'scripts/build.py', bytes: binary.length }]);
    expect(findAccessibleResources).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', resourceType: ResourceType.SKILL, requiredPermissions: PermissionBits.VIEW,
    }));
    const file = await request(app).get('/api/garden/workspace/skills/docx/files/scripts/build.py?version=3').set(auth()).expect(200);
    expect(Buffer.compare(file.body, binary)).toBe(0);
    await request(app).get('/api/garden/workspace/skills/docx').set(auth('employee-b')).expect(404);
    await request(app).get('/api/garden/workspace/skills/docx/files/scripts/build.py?version=2').set(auth()).expect(404);
  });

  it('records a chosen binary result through native local storage and download path', async () => {
    const result = await request(app)
      .post('/api/garden/workspace/outputs?filename=report.zip')
      .set(auth())
      .set('Content-Type', 'application/octet-stream')
      .send(binary)
      .expect(201);
    expect(saveBuffer).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', basePath: 'uploads', buffer: binary,
    }));
    expect(db.createFile).toHaveBeenCalledWith(expect.objectContaining({
      user: 'u1', source: FileSources.local, filename: 'report.zip', bytes: binary.length,
    }), true);
    expect(result.body.download_path).toBe(`/api/files/download/u1/${result.body.file_id}`);
    await request(app).post('/api/garden/workspace/outputs?filename=..%2Fforeign').set(auth())
      .set('Content-Type', 'application/octet-stream').send(binary).expect(400);
  });
});
