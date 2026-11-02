// Minimal path router behind the Next.js catch-all route handler (app/api/[[...path]]/route.js).
// Handlers keep the familiar (req, res, next) shape; nothing here depends on a server framework.

function compile(pattern) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  })}/?$`);
  return { re, keys };
}

export function Router() {
  const middleware = [];
  const routes = [];
  const add = (method) => (pattern, ...handlers) => routes.push({ method, ...compile(pattern), handlers });
  return {
    use: (fn) => middleware.push(fn),
    get: add('GET'),
    post: add('POST'),
    patch: add('PATCH'),
    /** Runs middleware then the first matching route. Resolves with { status, body }. */
    async dispatch(req) {
      const route = routes.find((r) => r.method === req.method && r.re.test(req.path));
      const res = new Reply();
      const chain = [...middleware];
      if (route) {
        const m = route.re.exec(req.path);
        req.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        chain.push(...route.handlers);
      } else {
        chain.push((_req, r) => r.status(404).json({ error: `No route for ${req.method} /api${req.path}` }));
      }
      await run(chain, req, res);
      return res;
    },
  };
}

// Each step either sends a reply, calls next() to continue, or calls next(err) / throws.
async function run(chain, req, res) {
  for (const fn of chain) {
    let nextCalled = false;
    let error = null;
    let signal;
    const called = new Promise((resolve) => (signal = resolve));
    const next = (err) => {
      nextCalled = true;
      if (err) error = err;
      signal();
    };
    let ret;
    try {
      ret = fn(req, res, next);
    } catch (e) {
      error = e;
    }
    if (!error) await Promise.race([called, Promise.resolve(ret).catch((e) => (error = e))]);
    if (error) throw error;
    if (res.sent || !nextCalled) return;
  }
}

class Reply {
  status_ = 200;
  body = null;
  sent = false;
  status(code) {
    this.status_ = code;
    return this;
  }
  json(body) {
    this.body = body;
    this.sent = true;
    return this;
  }
}
