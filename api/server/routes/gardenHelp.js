const { Router } = require('express');
const { createGardenHelpRouter } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const db = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const router = Router();
router.use(
  requireJwtAuth,
  configMiddleware,
  createGardenHelpRouter(db, {
    getStrategyFunctions,
    workspaceSecret: process.env.GARDEN_WORKSPACE_MCP_SERVICE_SECRET,
  }),
);
module.exports = router;
