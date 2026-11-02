// Single Next.js route handler for the whole REST API:
//   /api/public/*  → lib/routes/public.js (no key)
//   /api/*         → lib/routes/api.js    (x-api-key)
import { ZodError } from 'zod';
import { ready } from '../../../lib/boot.js';
import { config } from '../../../lib/config.js';
import { publicRouter } from '../../../lib/routes/public.js';
import { apiRouter } from '../../../lib/routes/api.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cors(request) {
  const origin = request.headers.get('origin');
  const allowed = config.corsOrigins.includes('*') ? origin || '*' : config.corsOrigins.includes(origin) ? origin : null;
  return allowed
    ? { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'content-type, x-api-key, authorization', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', Vary: 'Origin' }
    : {};
}

async function handle(request, { params }) {
  const headers = { ...cors(request), 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const segments = params?.path || [];
  const isPublic = segments[0] === 'public';
  const url = new URL(request.url);
  const req = {
    method: request.method,
    path: `/${(isPublic ? segments.slice(1) : segments).join('/')}`,
    query: Object.fromEntries(url.searchParams),
    body: {},
    params: {},
    ip: (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'local',
    get: (name) => request.headers.get(name) || undefined,
  };
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      const text = await request.text();
      if (text.length > 2_000_000) return Response.json({ error: 'Request too large' }, { status: 413, headers });
      req.body = text ? JSON.parse(text) : {};
    }
    await ready();
    const res = await (isPublic ? publicRouter : apiRouter).dispatch(req);
    return Response.json(res.body, { status: res.status_, headers });
  } catch (err) {
    if (err instanceof SyntaxError) return Response.json({ error: 'Body must be valid JSON' }, { status: 400, headers });
    if (err instanceof ZodError) return Response.json({ error: 'Invalid request', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 400, headers });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return Response.json({ error: status >= 500 && config.env === 'production' ? 'Internal error' : err.message, details: err.details }, { status, headers });
  }
}

export { handle as GET, handle as POST, handle as PATCH, handle as OPTIONS };
