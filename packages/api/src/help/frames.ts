import type { TCustomConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { resolveGardenHelpConfig } from './runtime';

/** Only the Help shell opts into the explicitly configured Garden host origins. */
export function applyGardenHelpFrameHeaders(
  req: Request,
  res: Response,
  value: TCustomConfig['gardenHelp'],
): void {
  if (
    !value ||
    !(
      req.path === '/garden-help' ||
      (/^\/c\/[a-f0-9-]+$/.test(req.path) && req.query.gardenHelp === '1')
    )
  )
    return;
  const config = resolveGardenHelpConfig(value);
  if (!config) return;
  const origins = config.parentOrigins.map((origin) => new URL(origin).origin);
  const ancestors = `frame-ancestors 'self' ${Array.from(new Set(origins)).join(' ')}`;
  const prior = res.getHeader('Content-Security-Policy');
  const policy =
    typeof prior === 'string'
      ? prior
          .split(';')
          .filter((part) => !part.trim().startsWith('frame-ancestors '))
          .join(';')
          .trim()
      : '';
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `${policy}${policy ? '; ' : ''}${ancestors}`);
}
