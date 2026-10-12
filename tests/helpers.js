import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { initialize } from '../src/config.js';
import { createApplication } from '../src/server.js';
import { hashPassword } from '../src/security.js';

export async function freePort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
export async function instance(overrides = {}) {
  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`,
    directory = mkdtempSync(join(tmpdir(), 'mayoauth-test-'));
  const config = initialize(directory, origin);
  Object.assign(config, overrides);
  const result = await createApplication({ directory, config });
  const server = result.app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const password = 'Test-only-long-password-2026!';
  const user = result.store.createUser({
    email: 'admin@example.test',
    name: 'Test administrator',
    passwordHash: await hashPassword(password),
    admin: true,
  });
  const auth = JSON.parse(readFileSync(join(directory, 'cli.json'), 'utf8')).token;
  const api = async (path, method = 'GET', body, authenticated = true) =>
    fetch(`${origin}/api/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return {
    ...result,
    server,
    origin,
    directory,
    config,
    password,
    user,
    auth,
    api,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      result.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export class Browser {
  constructor() {
    this.cookies = [];
  }
  async request(url, options = {}) {
    const uri = new URL(url),
      cookie = this.cookies
        .filter((c) => c.host === uri.hostname && uri.pathname.startsWith(c.path))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    const response = await fetch(uri, {
      ...options,
      redirect: 'manual',
      headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const raw of response.headers.getSetCookie()) {
      const pieces = raw.split(';').map((s) => s.trim()),
        first = pieces.shift(),
        i = first.indexOf('='),
        name = first.slice(0, i),
        value = first.slice(i + 1),
        path = pieces.find((x) => /^path=/i.test(x))?.slice(5) || '/';
      this.cookies = this.cookies.filter(
        (c) => !(c.name === name && c.path === path && c.host === uri.hostname),
      );
      if (!pieces.some((x) => /^max-age=0$/i.test(x)))
        this.cookies.push({ host: uri.hostname, name, value, path });
    }
    return response;
  }
  async follow(url, options = {}) {
    for (let step = 0; step < 15; step++) {
      const response = await this.request(url, options);
      if (![302, 303].includes(response.status))
        return { response, url, html: await response.text() };
      const next = new URL(response.headers.get('location'), url).href;
      if (next.startsWith('http://localhost:3000/callback'))
        return { response, url: next, html: '' };
      url = next;
      options = {};
    }
    throw new Error('Too many redirects.');
  }
}
export function csrf(html) {
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1];
}
