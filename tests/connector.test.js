import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import Provider from 'oidc-provider';
import * as oidc from 'openid-client';
import { instance, freePort, Browser, csrf } from './helpers.js';

test('upstream OIDC verifies a real code flow and honors explicit subject mapping', async () => {
  const i = await instance(),
    port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  const secret = 'fixture-only-connector-secret-2026';
  const upstream = new Provider(origin, {
    clients: [
      {
        client_id: 'fixture-upstream',
        client_secret: secret,
        redirect_uris: [`${i.origin}/connectors/callback`],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    ],
    jwks: i.config.jwks,
    cookies: {
      keys: i.config.cookieKeys,
      names: { session: 'up_session', interaction: 'up_interaction', resume: 'up_resume' },
    },
    features: { devInteractions: { enabled: false }, rpInitiatedLogout: { enabled: false } },
    responseTypes: ['code'],
    scopes: ['openid'],
    pkce: { required: () => true },
    interactions: { url: (_ctx, interaction) => `/fixture/${interaction.uid}` },
    findAccount: async () => ({
      accountId: 'immutable-upstream-sub',
      claims: async () => ({ sub: 'immutable-upstream-sub' }),
    }),
  });
  const app = express();
  app.get('/fixture/:uid', async (req, res) => {
    const details = await upstream.interactionDetails(req, res);
    if (details.prompt.name === 'login')
      return upstream.interactionFinished(
        req,
        res,
        { login: { accountId: 'immutable-upstream-sub' } },
        { mergeWithLastSubmission: false },
      );
    const grant = new upstream.Grant({
      accountId: 'immutable-upstream-sub',
      clientId: 'fixture-upstream',
    });
    grant.addOIDCScope('openid');
    return upstream.interactionFinished(
      req,
      res,
      { consent: { grantId: await grant.save() } },
      { mergeWithLastSubmission: true },
    );
  });
  app.use(upstream.callback());
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const connector = await (
      await i.api('connectors', 'POST', {
        name: 'Fixture provider',
        issuer: origin,
        clientId: 'fixture-upstream',
        clientSecret: secret,
      })
    ).json();
    assert.equal(
      (
        await i.api(`connectors/${connector.id}/links`, 'POST', {
          subject: 'immutable-upstream-sub',
          userId: i.user.id,
        })
      ).status,
      201,
    );
    const client = await (
      await i.api('clients', 'POST', {
        name: 'Downstream app',
        redirectUris: ['http://localhost:3000/callback'],
      })
    ).json();
    const verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      scope: 'openid',
      response_type: 'code',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const browser = new Browser();
    let step = await browser.follow(`${i.origin}/auth?${params}`);
    const connectorPath = /href="([^\"]+\/connector\/[^\"]+)"/.exec(step.html)?.[1];
    assert.ok(connectorPath, step.html);
    step = await browser.follow(new URL(connectorPath, i.origin).href);
    assert.ok(step.html.includes('Approve access'), step.html || step.url);
    step = await browser.follow(`${step.url}/consent`, {
      method: 'POST',
      headers: { Origin: i.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: csrf(step.html) }),
    });
    assert.ok(new URL(step.url).searchParams.has('code'), step.html || step.url);
    const config = await oidc.discovery(
      new URL(i.origin),
      client.client_id,
      { token_endpoint_auth_method: 'none' },
      undefined,
      { execute: [oidc.allowInsecureRequests] },
    );
    const tokens = await oidc.authorizationCodeGrant(config, new URL(step.url), {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    assert.equal(tokens.claims().sub, i.user.id);
    assert.equal(
      i.store.get(
        "SELECT count(*) AS n FROM audit WHERE action='connector.login' AND outcome='success'",
      ).n,
      1,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await i.stop();
  }
});
