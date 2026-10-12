#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialize, loadConfig, dataDirectory } from '../src/config.js';
import { Store, publicUser } from '../src/database.js';
import { hashPassword, validEmail } from '../src/security.js';
import { createApplication } from '../src/server.js';

const help = `MayoAuth 0.1.0-beta.1 — open-source identity

  mayoauth init --issuer http://localhost:8787 --admin-email you@example.com --password-stdin
  mayoauth serve [--host 127.0.0.1] [--port 8787] [--website-only]
  mayoauth status
  mayoauth users list
  mayoauth users add --email person@example.com --name "Person" --password-stdin [--admin]
  mayoauth users suspend --id USER_ID
  mayoauth users enable --id USER_ID
  mayoauth users password --id USER_ID --password-stdin
  mayoauth apps list
  mayoauth apps add --name "My app" --redirect-uri http://localhost:3000/callback
  mayoauth apps remove --id CLIENT_ID
  mayoauth connectors list
  mayoauth connectors add --name "Company IdP" --issuer https://idp.example.com --client-id ID --secret-stdin
  mayoauth connectors link --id CONNECTOR_ID --subject UPSTREAM_SUB --user-id USER_ID
  mayoauth connectors disable --id CONNECTOR_ID
  mayoauth logs [--export]
  mayoauth doctor

All commands accept --data-dir PATH. Remote operations accept --url URL;
read MAYOAUTH_TOKEN from the environment or the local private cli.json file.
Passwords and connector secrets are read from stdin, never command arguments.
The beta's built-in MFA, SAML, SCIM and managed Cloud are not implemented yet.
`;
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
    version: { type: 'boolean' },
    'data-dir': { type: 'string' },
    issuer: { type: 'string' },
    'admin-email': { type: 'string' },
    'password-stdin': { type: 'boolean' },
    'secret-stdin': { type: 'boolean' },
    host: { type: 'string' },
    port: { type: 'string' },
    url: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    admin: { type: 'boolean' },
    id: { type: 'string' },
    'redirect-uri': { type: 'string', multiple: true },
    'client-id': { type: 'string' },
    subject: { type: 'string' },
    'user-id': { type: 'string' },
    export: { type: 'boolean' },
    'website-only': { type: 'boolean' },
  },
});
const directory = resolve(args['data-dir'] || dataDirectory());
async function secret(flag) {
  if (!args[flag]) throw new Error(`Use --${flag} and pipe the secret on stdin.`);
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    if (value.length > 4096) throw new Error('Secret is too long.');
  }
  value = value.replace(/\r?\n$/, '');
  if (!value) throw new Error('No secret received on stdin.');
  return value;
}
function need(name) {
  if (!args[name]) throw new Error(`Missing --${name}.`);
  return args[name];
}
function print(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}
try {
  const [command, action] = positionals;
  if (args.version) process.stdout.write('0.1.0-beta.1\n');
  else if (args.help || !command) {
    process.stdout.write(help);
  } else if (command === 'init') {
    const email = validEmail(need('admin-email'));
    const passwordHash = await hashPassword(await secret('password-stdin'));
    const config = initialize(directory, args.issuer || 'http://localhost:8787');
    const store = new Store(directory, config.limits);
    try {
      const user = store.createUser({
        email,
        name: 'Instance administrator',
        passwordHash,
        admin: true,
      });
      store.audit('operator', 'instance.initialized', user.id);
      print({
        initialized: true,
        directory,
        issuer: config.issuer,
        admin: publicUser(user),
        credentials: 'Saved privately in cli.json. No token printed.',
      });
    } finally {
      store.close();
    }
  } else if (command === 'serve') {
    const websiteOnly = Boolean(args['website-only']);
    const config = websiteOnly
      ? {
          issuer: process.env.PUBLIC_URL || 'http://localhost:8787',
          trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS || 0),
        }
      : loadConfig(directory);
    const result = await createApplication({ directory, config, websiteOnly });
    const host = args.host || process.env.HOST || '127.0.0.1',
      port = Number(args.port || process.env.PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const server = result.app.listen(port, host, () =>
      process.stdout.write(
        `MayoAuth beta (${websiteOnly ? 'website + local demo' : 'Community issuer'}) listening at http://${host}:${port}\n`,
      ),
    );
    server.on('error', (err) => {
      result.close();
      console.error(err.message);
      process.exitCode = 1;
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      server.close(() => {
        result.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 8000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    const localPath = join(directory, 'cli.json');
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
    const url = args.url || process.env.MAYOAUTH_URL || local.url,
      auth = process.env.MAYOAUTH_TOKEN || local.token;
    if (!url) throw new Error('Run init, pass --url, or set MAYOAUTH_URL.');
    const base = new URL(url);
    if (
      base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    )
      throw new Error('Remote CLI connections require HTTPS.');
    async function api(path, method = 'GET', body) {
      if (!auth) throw new Error('Set MAYOAUTH_TOKEN or use a local initialized data directory.');
      const response = await fetch(new URL(path, base), {
        method,
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
      return data;
    }
    if (command === 'status') print(await api('/api/v1/status'));
    else if (command === 'doctor') {
      const discovery = await fetch(new URL('/.well-known/openid-configuration', base), {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (!discovery.ok)
        throw new Error('OIDC discovery is not available. Website-only mode has no issuer.');
      const metadata = await discovery.json(),
        status = await api('/api/v1/status');
      if (metadata.issuer !== status.issuer) throw new Error('Issuer mismatch.');
      print({
        ok: true,
        issuer: metadata.issuer,
        pkce: metadata.code_challenge_methods_supported,
        storage: status.storage,
        beta: true,
      });
    } else if (command === 'users') {
      if (action === 'list') print(await api('/api/v1/users'));
      else if (action === 'add')
        print(
          await api('/api/v1/users', 'POST', {
            email: need('email'),
            name: need('name'),
            password: await secret('password-stdin'),
            admin: !!args.admin,
          }),
        );
      else if (['suspend', 'enable'].includes(action))
        print(
          await api(`/api/v1/users/${encodeURIComponent(need('id'))}`, 'PATCH', {
            active: action === 'enable',
          }),
        );
      else if (action === 'password')
        print(
          await api(`/api/v1/users/${encodeURIComponent(need('id'))}/password`, 'POST', {
            password: await secret('password-stdin'),
          }),
        );
      else throw new Error('Unknown users command. See --help.');
    } else if (command === 'apps') {
      if (action === 'list') print(await api('/api/v1/clients'));
      else if (action === 'add')
        print(
          await api('/api/v1/clients', 'POST', {
            name: need('name'),
            redirectUris: need('redirect-uri'),
          }),
        );
      else if (action === 'remove')
        print(await api(`/api/v1/clients/${encodeURIComponent(need('id'))}`, 'DELETE'));
      else throw new Error('Unknown apps command.');
    } else if (command === 'connectors') {
      if (action === 'list') print(await api('/api/v1/connectors'));
      else if (action === 'add')
        print(
          await api('/api/v1/connectors', 'POST', {
            name: need('name'),
            issuer: need('issuer'),
            clientId: need('client-id'),
            clientSecret: await secret('secret-stdin'),
          }),
        );
      else if (action === 'link')
        print(
          await api(`/api/v1/connectors/${encodeURIComponent(need('id'))}/links`, 'POST', {
            subject: need('subject'),
            userId: need('user-id'),
          }),
        );
      else if (action === 'disable')
        print(
          await api(`/api/v1/connectors/${encodeURIComponent(need('id'))}`, 'PATCH', {
            active: false,
          }),
        );
      else throw new Error('Unknown connectors command.');
    } else if (command === 'logs')
      print(await api(`/api/v1/events${args.export ? '/export' : ''}`));
    else throw new Error('Unknown command. See mayoauth --help.');
  }
} catch (err) {
  console.error(`mayoauth: ${err.message}`);
  process.exitCode = 1;
}
