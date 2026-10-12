import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(directory, limits) {
    this.limits = limits;
    this.db = new DatabaseSync(join(directory, 'identity.db'));
    chmodSync(join(directory, 'identity.db'), 0o600);
    const pages = Math.floor((limits.databaseMiB * 1024 * 1024) / 4096);
    if (
      !Number.isInteger(pages) ||
      pages < 64 ||
      !Number.isInteger(limits.cacheKiB) ||
      limits.cacheKiB < 512
    )
      throw new Error('Invalid database resource limits.');
    this.db.exec(`PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA max_page_count=${pages}; PRAGMA cache_size=-${limits.cacheKiB};
      PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;`);
    // DELETE journaling keeps a single-process beta predictable: no independently growing WAL.
    // A rollback journal still needs headroom on the host filesystem; see DATA-LIMITS.md.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        password_hash TEXT, active INTEGER NOT NULL DEFAULT 1,
        admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL,
        client_id TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS external_accounts (connector_id TEXT NOT NULL, subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(connector_id, subject));
      CREATE TABLE IF NOT EXISTS oidc (model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        expires INTEGER NOT NULL, PRIMARY KEY(model, id));
      CREATE INDEX IF NOT EXISTS oidc_expiry ON oidc(expires);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL);
    `);
    this.cleanup();
  }
  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }
  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }
  cleanup() {
    const now = Math.floor(Date.now() / 1000);
    this.run('DELETE FROM oidc WHERE expires < ?', now);
    this.run('DELETE FROM sessions WHERE expires < ?', now);
    this.run(
      'DELETE FROM audit WHERE at < ?',
      new Date(Date.now() - this.limits.auditDays * 86400000).toISOString(),
    );
    this.run(
      'DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT ?)',
      this.limits.auditRows,
    );
  }
  audit(actor, action, target, outcome = 'success') {
    this.transaction(() => {
      this.run(
        'INSERT INTO audit(at,actor,action,target,outcome) VALUES(?,?,?,?,?)',
        new Date().toISOString(),
        String(actor).slice(0, 254),
        action,
        String(target).slice(0, 254),
        outcome,
      );
      this.run(
        'DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT ?)',
        this.limits.auditRows,
      );
    });
  }
  user(id) {
    return this.get('SELECT * FROM users WHERE id=?', id);
  }
  createUser({ email, name, passwordHash = null, admin = false }) {
    const id = randomUUID();
    this.run(
      'INSERT INTO users(id,email,name,password_hash,admin,created_at) VALUES(?,?,?,?,?,?)',
      id,
      email,
      name.slice(0, 100),
      passwordHash,
      Number(admin),
      new Date().toISOString(),
    );
    return this.user(id);
  }
  revokeUser(id) {
    this.transaction(() => {
      this.run('DELETE FROM sessions WHERE user_id=?', id);
      const grants = this.all(
        "SELECT id FROM oidc WHERE model='Grant' AND json_extract(payload,'$.accountId')=?",
        id,
      );
      for (const grant of grants)
        this.run(
          "DELETE FROM oidc WHERE json_extract(payload,'$.grantId')=? OR (model='Grant' AND id=?)",
          grant.id,
          grant.id,
        );
      this.run("DELETE FROM oidc WHERE json_extract(payload,'$.accountId')=?", id);
    });
  }
  stats() {
    const pageSize = Number(this.get('PRAGMA page_size').page_size),
      pages = Number(this.get('PRAGMA page_count').page_count);
    return {
      engine: 'SQLite (single process)',
      databaseBytes: pages * pageSize,
      databaseLimitBytes: Number(this.get('PRAGMA max_page_count').max_page_count) * pageSize,
      cacheLimitKiB: this.limits.cacheKiB,
      auditRows: this.get('SELECT count(*) AS n FROM audit').n,
      auditRowLimit: this.limits.auditRows,
      auditRetentionDays: this.limits.auditDays,
      transientRowLimit: this.limits.transientRows,
      journalMode: this.get('PRAGMA journal_mode').journal_mode,
    };
  }
  close() {
    this.db.close();
  }
}

export const publicUser = ({ id, email, name, active, admin, created_at }) => ({
  id,
  email,
  name,
  active: Boolean(active),
  admin: Boolean(admin),
  created_at,
});

export function adapterFor(store) {
  return class Adapter {
    constructor(model) {
      this.model = model;
    }
    async upsert(id, payload, expiresIn) {
      const expires = Math.floor(Date.now() / 1000) + (expiresIn || 86400);
      store.cleanup();
      if (
        !store.get('SELECT id FROM oidc WHERE model=? AND id=?', this.model, id) &&
        store.get('SELECT count(*) AS n FROM oidc').n >= store.limits.transientRows
      ) {
        throw Object.assign(new Error('Session storage capacity reached.'), { status: 503 });
      }
      store.run(
        'INSERT INTO oidc(model,id,payload,expires) VALUES(?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires',
        this.model,
        id,
        JSON.stringify(payload),
        expires,
      );
    }
    async find(id) {
      if (this.model === 'Client') {
        const row = store.get('SELECT payload FROM clients WHERE id=?', id);
        return row ? JSON.parse(row.payload) : undefined;
      }
      const row = store.get(
        'SELECT payload FROM oidc WHERE model=? AND id=? AND expires>?',
        this.model,
        id,
        Math.floor(Date.now() / 1000),
      );
      return row ? JSON.parse(row.payload) : undefined;
    }
    async findByUid(uid) {
      return this.byField('uid', uid);
    }
    async findByUserCode(code) {
      return this.byField('userCode', code);
    }
    byField(field, value) {
      const row = store.get(
        `SELECT payload FROM oidc WHERE model=? AND json_extract(payload,'$.${field}')=? AND expires>?`,
        this.model,
        value,
        Math.floor(Date.now() / 1000),
      );
      return row ? JSON.parse(row.payload) : undefined;
    }
    async destroy(id) {
      store.run('DELETE FROM oidc WHERE model=? AND id=?', this.model, id);
    }
    async consume(id) {
      const changed = store.run(
        "UPDATE oidc SET payload=json_set(payload,'$.consumed',?) WHERE model=? AND id=? AND json_extract(payload,'$.consumed') IS NULL",
        Math.floor(Date.now() / 1000),
        this.model,
        id,
      );
      if (!changed.changes) throw new Error('Credential already consumed.');
    }
    async revokeByGrantId(id) {
      store.run("DELETE FROM oidc WHERE json_extract(payload,'$.grantId')=?", id);
    }
  };
}
