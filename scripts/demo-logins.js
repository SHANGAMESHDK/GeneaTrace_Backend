// Applies the demo usernames/passwords (lib/demo.js) to an existing database, and the admin
// login when ADMIN_PASSWORD is set. Safe to run repeatedly.
// Usage (from backend/): npm run demo-logins
import { boot } from '../lib/boot.js';
import { ctx } from '../lib/context.js';
import { config } from '../lib/config.js';
import { DEMO_ACCOUNTS } from '../lib/demo.js';
import { setCredentials } from '../lib/services/auth.js';

await boot({ worker: false, ethereum: false });
for (const acc of DEMO_ACCOUNTS) {
  if (!(await ctx.store.get('actors', acc.id))) {
    console.log(`  - ${acc.id} not in this database (run the seed first)`);
    continue;
  }
  await setCredentials(acc.id, { username: acc.username, password: acc.password });
  console.log(`  • ${acc.name.padEnd(34)} ${acc.username}`);
}
console.log(config.adminPassword ? '  • admin login set from ADMIN_PASSWORD' : '  - ADMIN_PASSWORD not set: admin signs in with the API key only');
await ctx.store.close?.();
process.exit(0);
