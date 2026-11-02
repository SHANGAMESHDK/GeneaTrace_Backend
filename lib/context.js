// Process-wide handles, set once at boot (index.js / seed.js).
// Kept on globalThis so Next.js dev reloads share one store and one ledger lock.
export const ctx = (globalThis.__geneatraceCtx ||= { store: null, ledger: null, ethereum: null });
