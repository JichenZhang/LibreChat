import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readHelpKnowledge } from './workspace';
import type { HelpChatMethods } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import type { HelpDependencies } from './attachments';
import {
  captureHelpContext,
  createHelpTransport,
  helpConversationId,
  submitApprovedHelpExport,
  resolveGardenHelpConfig,
} from './runtime';

type HelpRequest = Request & { user?: IUser; config?: AppConfig };
const wrap =
  (handler: (req: HelpRequest, res: Response) => Promise<Response | undefined>): RequestHandler =>
  (req, res, next) => {
    void handler(req as HelpRequest, res).catch(next);
  };

/** Mounted behind native JWT and resolved app config; no second login/session implementation. */
export function createGardenHelpRouter(db: HelpChatMethods, deps?: HelpDependencies): Router {
  const router = Router();
  router.use((request, res, next) => {
    const req = request as HelpRequest;
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id || !req.user?.openidId) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      return;
    }
    if (!req.config?.gardenHelp) {
      res.status(404).json({ error: { code: 'NOT_AVAILABLE' } });
      return;
    }
    const config = resolveGardenHelpConfig(req.config.gardenHelp)!;
    if (
      req.method !== 'GET' &&
      req.get('Origin') !== new URL(config.siteURL).origin &&
      req.get('Sec-Fetch-Site') !== 'same-origin'
    ) {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return;
    }
    next();
  });
  router.get(
    '/session',
    wrap(async (req, res) => {
      try {
        const cfg = resolveGardenHelpConfig(req.config!.gardenHelp)!;
        const spec = req.config!.modelSpecs?.list?.find((item) => item.name === cfg.preset);
        if (!spec) return res.status(503).json({ error: { code: 'PRESET_UNAVAILABLE' } });
        const id = helpConversationId(req.user!.id);
        await db.ensureHelpChat(req.user!.id, id, {
          ...spec.preset,
          spec: cfg.preset,
          endpointType: 'custom',
        });
        const chat = await db.readHelpChat(req.user!.id, id);
        return res.json({
          conversationId: id,
          subject: req.user!.openidId,
          context: chat?.gardenHelpContext ?? null,
          siteURL: cfg.siteURL,
          parentOrigins: cfg.parentOrigins,
        });
      } catch {
        return res.status(503).json({ error: { code: 'UNAVAILABLE' } });
      }
    }),
  );
  router.post(
    '/document',
    wrap(async (req, res) => {
      const input = z
        .object({ id: z.string().max(128) })
        .strict()
        .safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: { code: 'INVALID_SOURCE' } });
      try {
        const cfg = resolveGardenHelpConfig(req.config!.gardenHelp)!;
        const document = await readHelpKnowledge(
          cfg.workspaceURL,
          req.user!.openidId!,
          deps?.workspaceSecret,
          input.data.id,
        );
        const now = new Date().toISOString();
        const context = {
          captured_at: now,
          label: document.url,
          evidence: [
            {
              kind: 'original_text' as const,
              text: document.content,
              source: {
                kind: 'help_document' as const,
                id: input.data.id,
                revision: `${document.version}:${createHash('sha256').update(document.content).digest('hex')}`,
                retrieved_at: now,
                range: `Entire published chapter: ${document.url}; version ${document.version}`,
              },
            },
          ],
        };
        if (!(await db.replaceHelpContext(req.user!.id, helpConversationId(req.user!.id), context)))
          return res.sendStatus(404);
        return res.json({ context });
      } catch {
        return res.status(409).json({ error: { code: 'SOURCE_UNAVAILABLE' } });
      }
    }),
  );
  router.post(
    '/context',
    wrap(async (req, res) => {
      const input = z
        .object({
          source: z
            .object({
              conversationId: z.string().uuid(),
              messageIds: z.array(z.string().max(256)).min(1).max(16),
              attachments: z
                .array(
                  z
                    .object({
                      messageId: z.string().max(256),
                      fileId: z.string().max(256),
                      content: z.boolean(),
                    })
                    .strict(),
                )
                .max(16)
                .optional(),
            })
            .strict()
            .nullable(),
        })
        .strict()
        .safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: { code: 'INVALID_SOURCE' } });
      try {
        const context = input.data.source
          ? await captureHelpContext(
              db,
              req.user!.id,
              input.data.source,
              req as ServerRequest,
              deps,
            )
          : null;
        if (!(await db.replaceHelpContext(req.user!.id, helpConversationId(req.user!.id), context)))
          return res.sendStatus(404);
        return res.json({ context });
      } catch {
        return res.status(409).json({ error: { code: 'SOURCE_UNAVAILABLE' } });
      }
    }),
  );
  router.post(
    '/submissions/:id/retry',
    wrap(async (req, res) => {
      try {
        const id = String(req.params.id);
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return res.sendStatus(400);
        const chat = await db.readHelpChat(req.user!.id, helpConversationId(req.user!.id));
        const approved = chat?.gardenHelpExports?.find((item) => item.submission_id === id);
        const result = approved
          ? await submitApprovedHelpExport(req, db, approved, deps)
          : await (
              await createHelpTransport(
                resolveGardenHelpConfig(req.config!.gardenHelp)!,
                req.user!.openidId!,
              )
            )('help_submission_status', { submission_id: id });
        return res.json(result);
      } catch {
        return res.status(503).json({ error: { code: 'RESULT_UNKNOWN', retryable: true } });
      }
    }),
  );
  return router;
}
