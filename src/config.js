import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { token, digest, validUrl } from './security.js';

export const dataDirectory = () => resolve(process.env.MAYOAUTH_DATA_DIR || '.mayoauth');
export function initialize(directory, issuer = 'http://localhost:8787') {
  validUrl(issuer);
  if (new URL(issuer).pathname !== '/' || new URL(issuer).search)
    throw new Error('The issuer must be an origin without a path or query.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'instance.json');
  if (existsSync(path))
    throw new Error('Instance already initialized. Existing keys and users were preserved.');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  const adminToken = token();
  const config = {
    issuer: new URL(issuer).origin,
    adminTokenHash: digest(adminToken),
    cookieKeys: [token(), token()],
    encryptionKey: randomBytes(32).toString('hex'),
    jwks: { keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: randomBytes(8).toString('hex') }] },
    limits: {
      databaseMiB: 256,
      cacheKiB: 8192,
      auditRows: 10000,
      auditDays: 30,
      transientRows: 10000,
    },
    trustedProxyHops: 0,
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(
    join(directory, 'cli.json'),
    `${JSON.stringify({ url: config.issuer, token: adminToken }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return config;
}
export function loadConfig(directory) {
  const path = join(directory, 'instance.json');
  if (!existsSync(path))
    throw new Error('Run mayoauth init first. No instance keys were created automatically.');
  chmodSync(path, 0o600);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  validUrl(config.issuer);
  return config;
}
