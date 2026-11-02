import { ready } from '../lib/boot.js';
import { ctx } from '../lib/context.js';
import { config } from '../lib/config.js';

export const dynamic = 'force-dynamic';

// Status page for the API node. The user-facing app lives in ../frontend.
export default async function Home() {
  let status;
  try {
    await ready();
    status = { ok: true, store: ctx.store.kind, height: ctx.ledger.tip?.id };
  } catch (e) {
    status = { ok: false, error: e.message };
  }
  return (
    <main style={{ maxWidth: 640, margin: '64px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 24 }}>GeneaTrace API node</h1>
      <p>{status.ok ? `Running · store: ${status.store} · chain height #${status.height}` : `Not ready: ${status.error}`}</p>
      <p>Node ID: <code>{config.nodeId}</code></p>
      <ul>
        <li><a href="/api/public/health">/api/public/health</a></li>
        <li><a href="/api/public/node">/api/public/node</a></li>
      </ul>
      <p>The web app runs separately from the <code>frontend</code> folder (<code>npm run dev</code> there, port 5173).</p>
    </main>
  );
}
