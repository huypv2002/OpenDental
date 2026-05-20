import { config } from './config.js';

export function requireApiToken(req, res, next) {
  if (!config.apiToken) {
    res.status(500).json({
      ok: false,
      error: 'Bridge API token is not configured.'
    });
    return;
  }

  const header = req.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const token = bearer || queryToken;

  if (token !== config.apiToken) {
    res.status(401).json({
      ok: false,
      error: 'Unauthorized.'
    });
    return;
  }

  next();
}
