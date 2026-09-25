const crypto = require('node:crypto');
const express = require('express');
const mime = require('mime');
const { logger } = require('@librechat/data-schemas');
const {
  FileContext,
  FileSources,
  PermissionBits,
  ResourceType,
} = require('librechat-data-provider');
const { resolveDownloadPath } = require('@librechat/api');
const configMiddleware = require('~/server/middleware/config/app');
const db = require('~/models');
const { fileAccess } = require('~/server/middleware/accessResources/fileAccess');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const {
  getSkillDbMethods,
  getSkillToolDeps,
  withDeploymentSkillIds,
} = require('~/server/services/Endpoints/agents/skillDeps');

const MAX_BYTES = 10 * 1024 * 1024;
const router = express.Router();

function serviceAuthorized(header) {
  const expected = process.env.GARDEN_WORKSPACE_MCP_SERVICE_SECRET;
  const value = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!expected || !value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function resolveServiceUser(req, res, next) {
  if (!serviceAuthorized(req.headers.authorization)) return res.sendStatus(401);
  const subject = req.headers['x-garden-workspace-subject'];
  if (typeof subject !== 'string' || !subject || subject.length > 256) return res.sendStatus(401);
  try {
    const matches = await db.findUsers({ openidId: subject }, null, { limit: 2 });
    const user = matches.length === 1 ? matches[0] : null;
    if (!user || user.openidId !== subject || !user._id) return res.sendStatus(403);
    req.user = { id: user._id.toString(), _id: user._id, role: user.role, tenantId: user.tenantId };
    return next();
  } catch {
    return res.sendStatus(503);
  }
}

async function boundedBytes(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BYTES) {
      stream.destroy?.();
      const error = new Error('FILE_TOO_LARGE');
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function binaryFailure(res, error) {
  logger.warn('[gardenWorkspace] File handoff failed', { status: error?.status ?? 503 });
  return res.sendStatus(error?.status ?? 503);
}

router.use(resolveServiceUser);
router.use(configMiddleware);

// Workspace MCP requests a chat attachment by opaque ID. The same native
// middleware used by the ordinary LibreChat download route checks ownership,
// tenant and shared Agent VIEW permission before any bytes leave LibreChat.
router.get('/attachments/:file_id', fileAccess, async (req, res) => {
  try {
    const file = req.fileAccess.file;
    if (file.source === FileSources.text || file.bytes > MAX_BYTES) return res.sendStatus(413);
    const strategy = getStrategyFunctions(file.source);
    if (!strategy.getDownloadStream) return res.sendStatus(415);
    const bytes = await boundedBytes(
      await strategy.getDownloadStream(req, resolveDownloadPath(file)),
    );
    res.type('application/octet-stream').set('Cache-Control', 'no-store').send(bytes);
  } catch (error) {
    return binaryFailure(res, error);
  }
});

async function accessibleSkill(req, name, skillId) {
  if (typeof skillId !== 'string' || !/^[0-9a-f]{24}$/.test(skillId)) return null;
  const ids = await findAccessibleResources({
    userId: req.user.id,
    role: req.user.role,
    resourceType: ResourceType.SKILL,
    requiredPermissions: PermissionBits.VIEW,
  });
  if (!withDeploymentSkillIds(ids).some((id) => id.toString() === skillId)) return null;
  const skill = await getSkillDbMethods().getSkillById(skillId);
  return skill?.name === name ? skill : null;
}

router.get('/skills/:name', async (req, res) => {
  try {
    const skill = await accessibleSkill(req, req.params.name, req.query.skill_id);
    if (!skill) return res.sendStatus(404);
    const files = await getSkillDbMethods().listSkillFiles(skill._id);
    return res.set('Cache-Control', 'no-store').json({
      id: skill._id.toString(),
      name: skill.name,
      version: skill.version,
      body: skill.body,
      files: files.map((file) => ({ path: file.relativePath, bytes: file.bytes })),
    });
  } catch (error) {
    return binaryFailure(res, error);
  }
});

router.get('/skills/:name/files/*relativePath', async (req, res) => {
  try {
    const skill = await accessibleSkill(req, req.params.name, req.query.skill_id);
    if (!skill || String(skill.version) !== req.query.version) return res.sendStatus(404);
    const relativePath = req.params.relativePath?.join('/');
    if (!relativePath) return res.sendStatus(400);
    const file = await getSkillDbMethods().getSkillFileByPath(skill._id, relativePath);
    if (!file || file.bytes > MAX_BYTES) return res.sendStatus(file ? 413 : 404);
    const strategy = getSkillToolDeps().getStrategyFunctions(file.source);
    if (!strategy.getDownloadStream) return res.sendStatus(415);
    const bytes = await boundedBytes(
      await strategy.getDownloadStream(req, resolveDownloadPath(file)),
    );
    return res.type('application/octet-stream').set('Cache-Control', 'no-store').send(bytes);
  } catch (error) {
    return binaryFailure(res, error);
  }
});

// A selected, already-authorized NAS result is pushed by Workspace MCP into
// the existing LibreChat local strategy and file model. Browser downloads use
// the normal /api/files/download route and its native fileAccess middleware.
router.post(
  '/outputs',
  express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }),
  async (req, res) => {
    const bytes = req.body;
    const filename = req.query.filename;
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      typeof filename !== 'string' ||
      !/^[^/\\\x00-\x1f]{1,255}$/.test(filename) ||
      filename === '.' ||
      filename === '..'
    )
      return res.sendStatus(400);
    const fileId = crypto.randomUUID();
    const strategy = getStrategyFunctions(FileSources.local);
    if (!strategy.saveBuffer) return res.sendStatus(503);
    let filepath;
    try {
      filepath = await strategy.saveBuffer({
        userId: req.user.id,
        buffer: bytes,
        fileName: `${fileId}__${filename}`,
        basePath: 'uploads',
      });
      const file = await db.createFile(
        {
          file_id: fileId,
          user: req.user.id,
          tenantId: req.user.tenantId,
          filename,
          filepath,
          source: FileSources.local,
          context: FileContext.run_artifact,
          type: mime.getType(filename) || 'application/octet-stream',
          bytes: bytes.length,
          usage: 1,
        },
        true,
      );
      return res
        .status(201)
        .set('Cache-Control', 'no-store')
        .json({
          file_id: file.file_id,
          filename: file.filename,
          download_path: `/api/files/download/${req.user.id}/${file.file_id}`,
        });
    } catch (error) {
      if (filepath && strategy.deleteFile) {
        await strategy.deleteFile(req, { filepath, user: req.user.id }).catch(() => undefined);
      }
      return binaryFailure(res, error);
    }
  },
);

module.exports = router;
