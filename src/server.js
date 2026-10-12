import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import Provider from 'oidc-provider';
import * as oidc from 'openid-client';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, adapterFor, publicUser } from './database.js';
import {
  token,
  digest,
  equal,
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  escapeHtml as h,
  validEmail,
  validUrl,
} from './security.js';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max = 100) =>
  typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : (() => {
        throw fail('A required field is missing or too long.');
      })();
const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .filter((s) => s.includes('='))
      .map((s) => {
        const i = s.indexOf('=');
        return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
      }),
  );

export async function createApplication({ directory, config, websiteOnly = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxyHops || false);
  const secure = new URL(config.issuer).protocol === 'https:';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': secure ? [] : null,
        },
      },
      strictTransportSecurity: secure ? { maxAge: 31536000 } : false,
    }),
  );
  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/interaction/') ||
      req.path.startsWith('/connectors/')
    )
      res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      version: '0.1.0-beta.1',
      mode: websiteOnly ? 'website' : 'community',
    }),
  );
  app.get('/api/meta', (_req, res) =>
    res.json({
      beta: true,
      mode: websiteOnly ? 'website' : 'community',
      cloudAvailable: false,
      demoLimit: 20,
      issuer: websiteOnly ? null : config.issuer,
    }),
  );
  // Public deployment serves the marketing site and browser-only demo. The real
  // issuer must be explicitly enabled on an operator-controlled instance.
  if (websiteOnly) {
    mountWeb(app);
    app.use('/api', (_req, res) =>
      res
        .status(404)
        .json({
          error:
            'This public beta is the demo. Run the Community server for real identity management.',
        }),
    );
    return { app, close: () => {} };
  }
  const store = new Store(directory, config.limits);
  const Adapter = adapterFor(store);
  const provider = new Provider(config.issuer, {
    adapter: Adapter,
    clients: [],
    jwks: config.jwks,
    cookies: {
      keys: config.cookieKeys,
      long: { secure, sameSite: 'lax' },
      short: { secure, sameSite: 'lax' },
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      rpInitiatedLogout: { enabled: false },
    },
    responseTypes: ['code'],
    scopes: ['openid', 'email', 'profile'],
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'] },
    pkce: { required: () => true },
    ttl: {
      AccessToken: 600,
      IdToken: 600,
      AuthorizationCode: 60,
      Interaction: 600,
      Session: 3600,
      Grant: 86400,
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => {
      const user = store.user(id);
      if (!user?.active) return undefined;
      return {
        accountId: user.id,
        claims: async () => ({
          sub: user.id,
          email: user.email,
          email_verified: false,
          name: user.name,
        }),
      };
    },
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      ctx.body = page(
        'Unable to sign in',
        `<p>${h(out.error_description || out.error)}</p><a href="/">Return to MayoAuth</a>`,
      );
    },
  });
  provider.proxy = Boolean(config.trustedProxyHops);
  let loginSuccess = 0,
    loginFailure = 0;
  provider.on('server_error', () =>
    console.error('OIDC server error; inspect local storage capacity and configuration.'),
  );
  const authLimiter = rateLimit({
    windowMs: 60000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Wait one minute.' },
  });
  const apiLimiter = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const interactionLimiter = rateLimit({
    windowMs: 60000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  app.use('/interaction', interactionLimiter);
  app.use('/connectors', authLimiter);
  app.use('/api', express.json({ limit: '16kb', strict: true }));
  const sessionName = secure ? '__Host-mayo_admin' : 'mayo_admin';
  const bridgeName = secure ? '__Host-mayo_bridge' : 'mayo_bridge';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 3600000 };
  function requireOrigin(req) {
    if (req.get('origin') !== config.issuer) throw fail('Request origin rejected.', 403);
  }
  function authorize(req, res, next) {
    try {
      const bearer = req.get('authorization');
      if (bearer?.startsWith('Bearer ') && equal(digest(bearer.slice(7)), config.adminTokenHash)) {
        req.actor = 'operator';
        return next();
      }
      const cookie = cookies(req)[sessionName];
      const session =
        cookie &&
        store.get(
          'SELECT user_id FROM sessions WHERE hash=? AND expires>?',
          digest(cookie),
          Math.floor(Date.now() / 1000),
        );
      const user = session && store.user(session.user_id);
      if (!user?.active || !user.admin) throw fail('Administrator authentication required.', 401);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) requireOrigin(req);
      req.actor = user.id;
      next();
    } catch (err) {
      next(err);
    }
  }
  app.post('/api/session', authLimiter, async (req, res) => {
    requireOrigin(req);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = store.get('SELECT * FROM users WHERE email=?', email);
    const valid = await verifyPassword(req.body.password, user?.password_hash);
    if (!valid || !user?.active || !user.admin) {
      loginFailure++;
      store.audit('anonymous', 'admin.login', email, 'denied');
      throw fail('Email or password is incorrect.', 401);
    }
    store.cleanup();
    if (store.get('SELECT count(*) AS n FROM sessions').n >= 1000)
      throw fail('Session capacity reached.', 503);
    const value = token();
    store.transaction(() => {
      store.audit(user.id, 'admin.login', user.id);
      store.run(
        'INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)',
        digest(value),
        user.id,
        Math.floor(Date.now() / 1000) + 3600,
      );
    });
    res.cookie(sessionName, value, cookieOptions).json({ user: publicUser(user) });
  });
  app.delete('/api/session', authorize, (req, res) => {
    const cookie = cookies(req)[sessionName];
    if (cookie) store.run('DELETE FROM sessions WHERE hash=?', digest(cookie));
    res.clearCookie(sessionName, cookieOptions).json({ ok: true });
  });
  app.use('/api/v1', apiLimiter, authorize);
  app.get('/api/v1/status', (_req, res) =>
    res.json({
      version: '0.1.0-beta.1',
      edition: 'Community',
      issuer: config.issuer,
      users: store.get('SELECT count(*) AS n FROM users').n,
      clients: store.get('SELECT count(*) AS n FROM clients').n,
      connectors: store.get('SELECT count(*) AS n FROM connectors').n,
      userLimit: null,
      storage: store.stats(),
    }),
  );
  app.get('/api/v1/users', (_req, res) =>
    res.json(store.all('SELECT * FROM users ORDER BY created_at DESC').map(publicUser)),
  );
  app.post('/api/v1/users', async (req, res) => {
    const email = validEmail(req.body.email),
      name = text(req.body.name),
      passwordHash = await hashPassword(req.body.password);
    const user = store.transaction(() => {
      const value = store.createUser({ email, name, passwordHash, admin: req.body.admin === true });
      store.audit(req.actor, 'user.created', value.id);
      return value;
    });
    res.status(201).json(publicUser(user));
  });
  app.patch('/api/v1/users/:id', async (req, res) => {
    const user = store.user(req.params.id);
    if (!user) throw fail('User not found.', 404);
    if (typeof req.body.active !== 'boolean') throw fail('Specify active as true or false.');
    if (
      user.admin &&
      !req.body.active &&
      store.get('SELECT count(*) AS n FROM users WHERE admin=1 AND active=1').n <= 1
    )
      throw fail('Keep at least one active administrator.', 409);
    store.transaction(() => {
      store.run('UPDATE users SET active=? WHERE id=?', Number(req.body.active), user.id);
      if (!req.body.active) store.revokeUser(user.id);
      store.audit(req.actor, req.body.active ? 'user.enabled' : 'user.suspended', user.id);
    });
    res.json(publicUser(store.user(user.id)));
  });
  app.post('/api/v1/users/:id/password', async (req, res) => {
    if (!store.user(req.params.id)) throw fail('User not found.', 404);
    const hash = await hashPassword(req.body.password);
    store.transaction(() => {
      store.run('UPDATE users SET password_hash=? WHERE id=?', hash, req.params.id);
      store.revokeUser(req.params.id);
      store.audit(req.actor, 'user.password_changed', req.params.id);
    });
    res.json({ ok: true });
  });
  app.get('/api/v1/clients', (_req, res) =>
    res.json(store.all('SELECT payload FROM clients').map((r) => JSON.parse(r.payload))),
  );
  app.post('/api/v1/clients', async (req, res) => {
    const name = text(req.body.name),
      uris = req.body.redirectUris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5)
      throw fail('Supply one to five exact redirect URIs.');
    for (const uri of uris) {
      if (typeof uri !== 'string' || uri.length > 2048) throw fail('Invalid redirect URI.');
      validUrl(uri);
    }
    const id = `app_${randomUUID().replaceAll('-', '')}`;
    const payload = {
      client_id: id,
      client_name: name,
      redirect_uris: [...new Set(uris)],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'RS256',
    };
    store.transaction(() => {
      store.run('INSERT INTO clients(id,payload) VALUES(?,?)', id, JSON.stringify(payload));
      store.audit(req.actor, 'client.created', id);
    });
    try {
      await provider.Client.find(id);
    } catch (err) {
      store.run('DELETE FROM clients WHERE id=?', id);
      throw fail('Client metadata rejected.');
    }
    res.status(201).json(payload);
  });
  app.delete('/api/v1/clients/:id', (req, res) => {
    if (!store.get('SELECT id FROM clients WHERE id=?', req.params.id))
      throw fail('Application not found.', 404);
    store.transaction(() => {
      store.run('DELETE FROM clients WHERE id=?', req.params.id);
      store.run("DELETE FROM oidc WHERE json_extract(payload,'$.clientId')=?", req.params.id);
      store.audit(req.actor, 'client.deleted', req.params.id);
    });
    res.json({ ok: true });
  });
  app.get('/api/v1/connectors', (_req, res) =>
    res.json(
      store
        .all('SELECT id,name,issuer,client_id,active FROM connectors')
        .map((c) => ({ ...c, active: Boolean(c.active) })),
    ),
  );
  app.post('/api/v1/connectors', (req, res) => {
    const name = text(req.body.name),
      issuer = validUrl(text(req.body.issuer, 2048), { loopback: !secure }).href.replace(/\/$/, ''),
      clientId = text(req.body.clientId, 255),
      secret = text(req.body.clientSecret, 4096);
    const id = `oidc_${randomUUID().replaceAll('-', '')}`;
    store.transaction(() => {
      store.run(
        'INSERT INTO connectors(id,name,issuer,client_id,secret) VALUES(?,?,?,?,?)',
        id,
        name,
        issuer,
        clientId,
        encrypt(secret, config.encryptionKey),
      );
      store.audit(req.actor, 'connector.created', id);
    });
    res
      .status(201)
      .json({
        id,
        name,
        issuer,
        client_id: clientId,
        active: true,
        callback: `${config.issuer}/connectors/callback`,
      });
  });
  app.patch('/api/v1/connectors/:id', (req, res) => {
    if (typeof req.body.active !== 'boolean') throw fail('Specify active as true or false.');
    store.transaction(() => {
      if (
        !store.run(
          'UPDATE connectors SET active=? WHERE id=?',
          Number(req.body.active),
          req.params.id,
        ).changes
      )
        throw fail('Connector not found.', 404);
      store.audit(req.actor, 'connector.updated', req.params.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/v1/connectors/:id/links', (req, res) => {
    if (
      !store.get('SELECT id FROM connectors WHERE id=?', req.params.id) ||
      !store.user(text(req.body.userId, 100))
    )
      throw fail('Connector or user not found.', 404);
    const subject = text(req.body.subject, 255);
    store.transaction(() => {
      store.run(
        'INSERT INTO external_accounts(connector_id,subject,user_id) VALUES(?,?,?)',
        req.params.id,
        subject,
        req.body.userId,
      );
      store.audit(req.actor, 'connector.account_linked', req.body.userId);
    });
    res.status(201).json({ ok: true });
  });
  app.get('/api/v1/events', (_req, res) =>
    res.json(store.all('SELECT * FROM audit ORDER BY seq DESC LIMIT 200')),
  );
  app.get('/api/v1/events/export', (_req, res) =>
    res
      .set('Content-Disposition', 'attachment; filename="mayoauth-audit.json"')
      .json(store.all('SELECT * FROM audit ORDER BY seq DESC LIMIT 10000')),
  );
  app.get('/metrics', authorize, (_req, res) =>
    res
      .type('text/plain')
      .send(
        `# TYPE mayoauth_login_success_total counter\nmayoauth_login_success_total ${loginSuccess}\n# TYPE mayoauth_login_failure_total counter\nmayoauth_login_failure_total ${loginFailure}\n# TYPE mayoauth_database_bytes gauge\nmayoauth_database_bytes ${store.stats().databaseBytes}\n# TYPE mayoauth_database_limit_bytes gauge\nmayoauth_database_limit_bytes ${store.stats().databaseLimitBytes}\n`,
      ),
  );

  const csrfFor = (uid) =>
    createHmac('sha256', config.cookieKeys[0]).update(uid).digest('base64url');
  const formBody = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 });
  app.get('/interaction/:uid', async (req, res) => {
    const details = await provider.interactionDetails(req, res),
      client = await provider.Client.find(details.params.client_id),
      uid = details.uid;
    const hidden = `<input type="hidden" name="csrf" value="${h(csrfFor(uid))}">`;
    if (details.prompt.name === 'login') {
      const connectors = store.all('SELECT id,name FROM connectors WHERE active=1');
      res.send(
        page(
          'Sign in',
          `<p>Continue to <strong>${h(client.clientName || client.clientId)}</strong></p><form method="post" action="/interaction/${h(uid)}/login">${hidden}<label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button class="button primary">Sign in →</button></form>${connectors.map((c) => `<a class="button secondary" href="/interaction/${h(uid)}/connector/${h(c.id)}">Continue with ${h(c.name)}</a>`).join('')}`,
        ),
      );
    } else if (details.prompt.name === 'consent') {
      res.send(
        page(
          'Approve access',
          `<p><strong>${h(client.clientName || client.clientId)}</strong> requests: ${h(details.params.scope)}.</p><form method="post" action="/interaction/${h(uid)}/consent">${hidden}<button class="button primary">Allow access</button></form><form method="post" action="/interaction/${h(uid)}/cancel">${hidden}<button class="button secondary">Cancel</button></form>`,
        ),
      );
    } else throw fail('This sign-in step is not supported.', 400);
  });
  app.post('/interaction/:uid/:action', authLimiter, formBody, async (req, res, next) => {
    if (!['login', 'consent', 'cancel'].includes(req.params.action)) return next();
    requireOrigin(req);
    const details = await provider.interactionDetails(req, res);
    if (!equal(req.body.csrf, csrfFor(details.uid)))
      throw fail('Form expired. Restart sign-in.', 403);
    if (req.params.action === 'cancel')
      return provider.interactionFinished(
        req,
        res,
        { error: 'access_denied', error_description: 'User declined consent.' },
        { mergeWithLastSubmission: false },
      );
    if (req.params.action === 'login') {
      if (details.prompt.name !== 'login') throw fail('Unexpected interaction.', 409);
      const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const user = store.get('SELECT * FROM users WHERE email=?', email);
      const valid = await verifyPassword(req.body.password, user?.password_hash);
      if (!valid || !user?.active) {
        loginFailure++;
        store.audit('anonymous', 'identity.login', details.params.client_id, 'denied');
        return res
          .status(401)
          .send(
            page(
              'Sign-in failed',
              `<p>Email or password is incorrect.</p><a href="/interaction/${h(details.uid)}">Try again</a>`,
            ),
          );
      }
      loginSuccess++;
      store.audit(user.id, 'identity.login', details.params.client_id);
      return provider.interactionFinished(
        req,
        res,
        { login: { accountId: user.id } },
        { mergeWithLastSubmission: false },
      );
    }
    if (details.prompt.name !== 'consent' || !store.user(details.session.accountId)?.active)
      throw fail('Consent session expired.', 401);
    let grant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
    if (!grant)
      grant = new provider.Grant({
        accountId: details.session.accountId,
        clientId: details.params.client_id,
      });
    const missing = details.prompt.details;
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
    const grantId = await grant.save();
    store.audit(details.session.accountId, 'identity.consent', details.params.client_id);
    return provider.interactionFinished(
      req,
      res,
      { consent: details.grantId ? {} : { grantId } },
      { mergeWithLastSubmission: true },
    );
  });
  async function discovery(connector) {
    const insecure = !secure && new URL(connector.issuer).protocol === 'http:';
    return oidc.discovery(
      new URL(connector.issuer),
      connector.client_id,
      decrypt(connector.secret, config.encryptionKey),
      undefined,
      { timeout: 5, execute: insecure ? [oidc.allowInsecureRequests] : undefined },
    );
  }
  app.get('/interaction/:uid/connector/:id', async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name !== 'login') throw fail('Unexpected interaction.', 409);
    const connector = store.get('SELECT * FROM connectors WHERE id=? AND active=1', req.params.id);
    if (!connector) throw fail('Connector unavailable.', 404);
    const upstream = await discovery(connector),
      verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    await new Adapter('Bridge').upsert(
      digest(state),
      { connector: connector.id, uid: details.uid, verifier, nonce },
      300,
    );
    res.cookie(bridgeName, digest(state), { ...cookieOptions, sameSite: 'lax', maxAge: 300000 });
    const url = oidc.buildAuthorizationUrl(upstream, {
      redirect_uri: `${config.issuer}/connectors/callback`,
      scope: 'openid',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    res.redirect(url.href);
  });
  app.get('/connectors/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state || !equal(cookies(req)[bridgeName], digest(state)))
      throw fail('Connector state rejected.', 403);
    const adapter = new Adapter('Bridge'),
      bridge = await adapter.find(digest(state));
    await adapter.destroy(digest(state));
    res.clearCookie(bridgeName, { ...cookieOptions, sameSite: 'lax' });
    if (!bridge) throw fail('Connector sign-in expired.', 403);
    const connector = store.get(
      'SELECT * FROM connectors WHERE id=? AND active=1',
      bridge.connector,
    );
    if (!connector) throw fail('Connector disabled.', 403);
    const upstream = await discovery(connector);
    const tokens = await oidc.authorizationCodeGrant(
      upstream,
      new URL(req.originalUrl, config.issuer),
      {
        pkceCodeVerifier: bridge.verifier,
        expectedState: state,
        expectedNonce: bridge.nonce,
        idTokenExpected: true,
      },
    );
    const subject = tokens.claims()?.sub;
    const link =
      subject &&
      store.get(
        'SELECT user_id FROM external_accounts WHERE connector_id=? AND subject=?',
        connector.id,
        subject,
      );
    const user = link && store.user(link.user_id);
    // Never auto-link by email. An operator must bind the provider's immutable subject.
    if (!user?.active) {
      store.audit('anonymous', 'connector.login', connector.id, 'denied');
      throw fail('This external account has not been linked by your administrator.', 403);
    }
    const ticket = token();
    await new Adapter('BridgeResult').upsert(
      digest(ticket),
      { uid: bridge.uid, userId: user.id, connectorId: connector.id },
      30,
    );
    res.cookie(bridgeName, digest(ticket), { ...cookieOptions, sameSite: 'lax', maxAge: 30000 });
    // oidc-provider scopes its interaction cookie to /interaction/:uid. Return
    // there before finishing; the stable upstream callback cannot read it.
    res.redirect(
      `/interaction/${encodeURIComponent(bridge.uid)}/federated?ticket=${encodeURIComponent(ticket)}`,
    );
  });
  app.get('/interaction/:uid/federated', async (req, res) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (!ticket || !equal(cookies(req)[bridgeName], digest(ticket)))
      throw fail('Connector continuation rejected.', 403);
    const adapter = new Adapter('BridgeResult'),
      result = await adapter.find(digest(ticket));
    await adapter.destroy(digest(ticket));
    res.clearCookie(bridgeName, { ...cookieOptions, sameSite: 'lax' });
    const details = await provider.interactionDetails(req, res);
    if (
      !result ||
      result.uid !== details.uid ||
      details.prompt.name !== 'login' ||
      !store.user(result.userId)?.active ||
      !store.get('SELECT id FROM connectors WHERE id=? AND active=1', result.connectorId)
    )
      throw fail('Connector continuation expired.', 403);
    loginSuccess++;
    store.audit(result.userId, 'connector.login', result.connectorId);
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId: result.userId } },
      { mergeWithLastSubmission: false },
    );
  });
  mountWeb(app);
  app.use(provider.callback());
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const full =
      err.code === 'ERR_SQLITE_ERROR' &&
      (err.errcode === 13 || /database or disk is full/i.test(err.message));
    const conflict = /UNIQUE constraint failed/.test(err.message || '');
    const status = full ? 507 : conflict ? 409 : err.status || 500;
    res
      .status(status)
      .json({
        error: full
          ? 'Storage limit reached. Free space or raise the configured database cap.'
          : conflict
            ? 'That record already exists.'
            : status < 500
              ? err.message
              : 'The request could not be completed.',
      });
  });
  const timer = setInterval(() => {
    try {
      store.cleanup();
    } catch {
      console.error('Database maintenance failed. Check storage capacity.');
    }
  }, 60000);
  timer.unref();
  return {
    app,
    provider,
    store,
    close: () => {
      clearInterval(timer);
      store.close();
    },
  };
}

function mountWeb(app) {
  app.get('/demo', (_req, res) => res.sendFile(`${web}demo.html`));
  app.get('/workspace', (_req, res) => res.sendFile(`${web}workspace.html`));
  app.get('/login', (_req, res) => res.sendFile(`${web}login.html`));
  app.get('/docs', (_req, res) => res.sendFile(`${web}docs.html`));
  app.use(express.static(web, { extensions: ['html'], maxAge: 0 }));
}
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · MayoAuth</title><link rel="icon" href="/mark.svg"><link rel="stylesheet" href="/style.css"></head><body><div class="beta-bar"><span class="beta-tag">BETA</span> Early software. Test with non-sensitive accounts.</div><main class="auth-card"><a class="brand" href="/"><img src="/mark.svg" alt="" width="32" height="32">Mayo<span>Auth</span></a><h1>${h(title)}</h1>${body}</main></body></html>`;
}
