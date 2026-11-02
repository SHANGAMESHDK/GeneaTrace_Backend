import { HttpError } from '../util.js';

/** In-memory fixed-window limiter per client IP (single node). */
export function rateLimit({ windowMs, limit }) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) hits.set(key, { start: now, count: 1 });
    else if (++h.count > limit) return next(new HttpError(429, 'Too many requests, slow down'));
    if (hits.size > 10_000) hits.clear();
    next();
  };
}
