import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor } = await import('../lib/services/network.js');
const { login, actorBySession, setCredentials, changePassword, hashPassword, verifyPassword } = await import('../lib/services/auth.js');

let member;

before(async () => {
  await boot({ databaseUrl: '', file: null, ethereum: false });
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  member = await createActor(admin, { name: 'Shop', role: 'retailer', username: 'Shop.One', password: 'Shop@1234' });
});

test('passwords are stored as salted scrypt hashes', () => {
  const a = hashPassword('Secret@123');
  const b = hashPassword('Secret@123');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$/);
  assert.ok(verifyPassword('Secret@123', a));
  assert.ok(!verifyPassword('secret@123', a));
});

test('sign in with username (case-insensitive) and password returns a working session', async () => {
  const row = await ctx.store.get('actors', member.actor.id);
  assert.equal(row.username, 'shop.one');
  assert.ok(!JSON.stringify(row).includes('Shop@1234'));
  const r = await login('SHOP.ONE', 'Shop@1234');
  assert.match(r.token, /^gts_/);
  assert.equal((await actorBySession(r.token)).id, member.actor.id);
});

test('wrong password, unknown user and forged tokens are rejected', async () => {
  await assert.rejects(login('shop.one', 'nope'), /Wrong username or password/);
  await assert.rejects(login('ghost', 'whatever'), /Wrong username or password/);
  const { token } = await login('shop.one', 'Shop@1234');
  assert.equal(await actorBySession(`${token.slice(0, -2)}xx`), null);
});

test('changing the password ends old sessions', async () => {
  const { token } = await login('shop.one', 'Shop@1234');
  const actor = await ctx.store.get('actors', member.actor.id);
  await changePassword(actor, 'Shop@1234', 'NewShop@5678');
  assert.equal(await actorBySession(token), null);
  assert.ok((await login('shop.one', 'NewShop@5678')).token);
});

test('admin reset generates a new password; usernames stay unique', async () => {
  const r = await setCredentials(member.actor.id, {});
  assert.ok(r.password.length >= 8);
  assert.ok((await login('shop.one', r.password)).token);
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  await assert.rejects(createActor(admin, { name: 'Copy', role: 'retailer', username: 'shop.one' }), /taken/);
});
