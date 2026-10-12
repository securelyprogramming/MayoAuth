import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import * as oidc from 'openid-client';
import { instance, Browser, csrf } from './helpers.js';

async function register(i) {
  const result = await i.api('clients', 'POST', {
    name: 'Integration app',
    redirectUris: ['http://localhost:3000/callback'],
  });
  assert.equal(result.status, 201, await result.clone().text());
  return result.json();
}
async function flow(i, client, { browser = new Browser(), password = i.password } = {}) {
  const verifier = oidc.randomPKCECodeVerifier(),
    state = oidc.randomState(),
    nonce = oidc.randomNonce();
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  let step = await browser.follow(`${i.origin}/auth?${params}`);
  if (step.html.includes('name="password"')) {
    const form = new URLSearchParams({ email: i.user.email, password, csrf: csrf(step.html) });
    step = await browser.follow(`${step.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: i.origin },
      body: form,
    });
  }
  if (step.html.includes('Approve access')) {
    step = await browser.follow(`${step.url}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: i.origin },
      body: new URLSearchParams({ csrf: csrf(step.html) }),
    });
  }
  return { ...step, verifier, state, nonce, browser };
}
test('administration endpoints require authentication and never expose password hashes or tokens', async () => {
  const i = await instance();
  try {
    for (const path of ['status', 'users', 'clients', 'connectors', 'events', 'events/export'])
      assert.equal((await i.api(path, 'GET', undefined, false)).status, 401, path);
    assert.equal((await i.api('users', 'POST', { email: 'x@example.test' }, false)).status, 401);
    const users = await (await i.api('users')).json();
    assert.equal(users.length, 1);
    assert.ok(!JSON.stringify(users).includes('password_hash'));
    assert.equal((await fetch(`${i.origin}/metrics`)).status, 401);
  } finally {
    await i.stop();
  }
});
test('OIDC authorization code + PKCE issues a verified ID token and rejects code reuse', async () => {
  const i = await instance();
  try {
    const client = await register(i),
      step = await flow(i, client);
    assert.equal(new URL(step.url).searchParams.has('code'), true, step.html || step.url);
    const config = await oidc.discovery(
      new URL(i.origin),
      client.client_id,
      { token_endpoint_auth_method: 'none' },
      undefined,
      { execute: [oidc.allowInsecureRequests] },
    );
    const tokens = await oidc.authorizationCodeGrant(config, new URL(step.url), {
      pkceCodeVerifier: step.verifier,
      expectedState: step.state,
      expectedNonce: step.nonce,
      idTokenExpected: true,
    });
    assert.equal(tokens.claims().sub, i.user.id);
    assert.equal(tokens.claims().iss, i.origin);
    assert.equal(tokens.claims().aud, client.client_id);
    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, i.user.id);
    assert.equal(userinfo.sub, i.user.id);
    assert.equal(userinfo.email, 'admin@example.test');
    assert.equal(userinfo.email_verified, false);
    await assert.rejects(() =>
      oidc.authorizationCodeGrant(config, new URL(step.url), {
        pkceCodeVerifier: step.verifier,
        expectedState: step.state,
        expectedNonce: step.nonce,
        idTokenExpected: true,
      }),
    );
  } finally {
    await i.stop();
  }
});
test('OIDC rejects unregistered redirects, missing PKCE, and wrong verifier', async () => {
  const i = await instance();
  try {
    const client = await register(i);
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://attacker.example.test/callback',
      response_type: 'code',
      scope: 'openid',
    });
    const response = await fetch(`${i.origin}/auth?${params}`, { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    params.set('redirect_uri', client.redirect_uris[0]);
    const missing = await fetch(`${i.origin}/auth?${params}`, { redirect: 'manual' });
    assert.ok(missing.status === 400 || missing.headers.get('location')?.includes('error='));
    const step = await flow(i, client);
    const exchange = await fetch(`${i.origin}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(step.url).searchParams.get('code'),
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_verifier: oidc.randomPKCECodeVerifier(),
      }),
    });
    assert.equal(exchange.status, 400);
    assert.equal((await exchange.json()).error, 'invalid_grant');
  } finally {
    await i.stop();
  }
});
test('login requires CSRF and local admin sessions reject cross-origin writes', async () => {
  const i = await instance();
  try {
    const bad = await fetch(`${i.origin}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example.test' },
      body: JSON.stringify({ email: i.user.email, password: i.password }),
    });
    assert.equal(bad.status, 403);
    const good = await fetch(`${i.origin}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: i.origin },
      body: JSON.stringify({ email: i.user.email, password: i.password }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join(';');
    assert.ok(good.headers.get('set-cookie').includes('HttpOnly'));
    const denied = await fetch(`${i.origin}/api/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email: 'u@example.test', name: 'User', password: i.password }),
    });
    assert.equal(denied.status, 403);
    const client = await register(i),
      browser = new Browser(),
      params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: 'code',
        scope: 'openid',
        code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()),
        code_challenge_method: 'S256',
      });
    const step = await browser.follow(`${i.origin}/auth?${params}`);
    const rejected = await browser.request(`${step.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: i.origin },
      body: new URLSearchParams({ email: i.user.email, password: i.password, csrf: 'forged' }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await i.stop();
  }
});
test('suspension revokes persisted grants and sessions; final administrator is protected', async () => {
  const i = await instance();
  try {
    assert.equal((await i.api(`users/${i.user.id}`, 'PATCH', { active: false })).status, 409);
    const user = await (
      await i.api('users', 'POST', {
        email: 'member@example.test',
        name: 'Member',
        password: i.password,
      })
    ).json();
    i.store.run(
      'INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',
      'samplehash',
      user.id,
      Math.floor(Date.now() / 1000) + 60,
    );
    i.store.run(
      'INSERT INTO oidc(model,id,payload,expires) VALUES(?,?,?,?)',
      'Session',
      'sample',
      JSON.stringify({ accountId: user.id }),
      Math.floor(Date.now() / 1000) + 60,
    );
    assert.equal((await i.api(`users/${user.id}`, 'PATCH', { active: false })).status, 200);
    assert.equal(i.store.get('SELECT count(*) AS n FROM sessions WHERE user_id=?', user.id).n, 0);
    assert.equal(i.store.get('SELECT count(*) AS n FROM oidc').n, 0);
  } finally {
    await i.stop();
  }
});
test('connector secrets are encrypted and duplicate-email mapping is never automatic', async () => {
  const i = await instance();
  try {
    const secret = 'test-connector-secret-not-a-real-credential';
    const response = await i.api('connectors', 'POST', {
      name: 'Test provider',
      issuer: 'https://identity.example.test',
      clientId: 'test-client',
      clientSecret: secret,
    });
    assert.equal(response.status, 201);
    const connector = await response.json();
    assert.ok(!JSON.stringify(connector).includes(secret));
    const row = i.store.get('SELECT secret FROM connectors WHERE id=?', connector.id);
    assert.notEqual(row.secret, secret);
    const listed = await (await i.api('connectors')).json();
    assert.ok(!JSON.stringify(listed).includes('secret'));
    assert.equal(i.store.get('SELECT count(*) AS n FROM external_accounts').n, 0);
    assert.equal(
      (await fetch(`${i.origin}/connectors/callback?state=forged&code=forged`)).status,
      403,
    );
  } finally {
    await i.stop();
  }
});
test('CLI talks to the running API and rejects insecure remote endpoints', async () => {
  const i = await instance();
  try {
    const run = (args, env = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['bin/mayoauth.js', ...args], {
          env: { ...process.env, ...env },
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    const result = await run(['doctor', '--data-dir', i.directory]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const bad = await run([
      'status',
      '--url',
      'http://remote.example.test',
      '--data-dir',
      i.directory,
    ]);
    assert.equal(bad.code, 1);
    assert.ok(bad.stderr.includes('HTTPS'));
  } finally {
    await i.stop();
  }
});
