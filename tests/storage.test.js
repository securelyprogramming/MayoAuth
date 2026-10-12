import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, adapterFor } from '../src/database.js';
import { instance } from './helpers.js';
const limits = { databaseMiB: 1, cacheKiB: 8192, auditRows: 3, auditDays: 30, transientRows: 2 };
test('database cap is enforced under real writes and preserves existing identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mayoauth-storage-')),
    store = new Store(dir, limits);
  try {
    store.createUser({ email: 'owner@example.test', name: 'Owner', admin: true });
    store.db.exec('CREATE TABLE capacity_test (data BLOB)');
    let full = false;
    for (let n = 0; n < 100; n++) {
      try {
        store.run('INSERT INTO capacity_test(data) VALUES(randomblob(65536))');
      } catch (err) {
        assert.match(err.message, /full/);
        full = true;
        break;
      }
    }
    assert.equal(full, true);
    assert.ok(store.stats().databaseBytes <= 1048576);
    assert.equal(store.stats().databaseLimitBytes, 1048576);
    assert.equal(store.get('SELECT count(*) AS n FROM users').n, 1);
    assert.equal(store.stats().journalMode, 'delete');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('audit retention and transient row ceilings stay bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mayoauth-storage-')),
    store = new Store(dir, limits);
  try {
    for (let n = 0; n < 10; n++) store.audit('test', 'test.event', String(n));
    assert.equal(store.stats().auditRows, 3);
    store.run('UPDATE audit SET at=?', '2000-01-01T00:00:00.000Z');
    store.cleanup();
    assert.equal(store.stats().auditRows, 0);
    const Adapter = adapterFor(store),
      adapter = new Adapter('Session');
    await adapter.upsert('one', { uid: 'a' }, 60);
    await adapter.upsert('two', { uid: 'b' }, 60);
    await assert.rejects(() => adapter.upsert('three', { uid: 'c' }, 60), /capacity/);
    store.run('UPDATE oidc SET expires=0 WHERE id=?', 'one');
    await adapter.upsert('three', { uid: 'c' }, 60);
    assert.equal(store.get('SELECT count(*) AS n FROM oidc').n, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('full database returns HTTP 507 and a rejected creation leaves no partial identity', async () => {
  const i = await instance({ limits: { ...limits, auditRows: 10000, transientRows: 10000 } });
  try {
    for (let n = 0; n < 2000; n++) {
      try {
        i.store.createUser({
          email: `filler-${n}@example.test`,
          name: 'x'.repeat(100),
          passwordHash: 'x'.repeat(200),
        });
      } catch (err) {
        assert.match(err.message, /full/);
        break;
      }
    }
    let rejected = false;
    for (let n = 0; n < 10; n++) {
      const email = `boundary-${n}@example.test`,
        response = await i.api('users', 'POST', {
          email,
          name: 'Y'.repeat(100),
          password: i.password,
        });
      if (response.status === 507) {
        rejected = true;
        assert.equal(i.store.get('SELECT id FROM users WHERE email=?', email), undefined);
        break;
      }
      assert.equal(response.status, 201, await response.text());
    }
    assert.equal(rejected, true);
    assert.ok(i.store.user(i.user.id));
  } finally {
    await i.stop();
  }
});
