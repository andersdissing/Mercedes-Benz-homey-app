'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const MercedesOAuth = require('../lib/oauth');

/**
 * The re-login that failed whenever it was needed (12 Aug 2026 diagnostics
 * report).
 *
 * When the identity provider still holds a live SSO session, the authorize
 * endpoint skips its login form and redirects straight to the app callback:
 * `rismycar://login-callback?code=...`. The HTTP stack cannot follow that
 * scheme, so the login threw ERR_FR_REDIRECTION_FAILURE and discarded the
 * code Mercedes had just issued. A live SSO session is exactly the state a
 * re-login runs in - a login had already succeeded in the same process - so
 * the escalation that exists to clear a persistent WebSocket 429 died every
 * time, and the app stayed disconnected for five hours until a Homey restart.
 *
 * These tests run the real axios + cookie-jar + follow-redirects stack
 * against a local HTTP server, because the contract being exercised (what a
 * redirect to a custom scheme does to that stack, and where its Location
 * header is still reachable) belongs to those libraries, not to this app.
 */

/** A stand-in for id.mercedes-benz.com. Records every request it serves. */
function fakeIdp({ authorizeResponse }) {
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: url.pathname, cookie: req.headers.cookie || '', body });

      if (url.pathname === '/as/authorization.oauth2') {
        authorizeResponse(url, res);
        return;
      }

      if (url.pathname === '/as/token.oauth2') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/ciam/auth/login') {
        // The login form, where the redirect chain settles when there is no
        // SSO session to short-circuit on.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>login form</html>');
        return;
      }

      // Any credential step reached in a short-circuited login is a failure
      // of the thing under test; answer in a way the flow cannot mistake for
      // success.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function makeOAuth(origin) {
  const homey = { app: { log() {}, error() {} } };
  const oauth = new MercedesOAuth(homey, 'Europe');
  // Aim the client at the local server. The CIAM.DEVICE cookie is scoped to
  // .mercedes-benz.com and simply never matches 127.0.0.1, which also proves
  // a login endpoint that cannot carry it does not break the flow.
  oauth.endpoints = { ...oauth.endpoints, login: origin };
  return oauth;
}

test('a live SSO session short-circuits login to the token exchange', async () => {
  const idp = await fakeIdp({
    authorizeResponse: (url, res) => {
      res.writeHead(302, { Location: 'rismycar://login-callback?code=sso-issued-code' });
      res.end();
    },
  });

  try {
    const oauth = makeOAuth(idp.origin);
    const token = await oauth.login('user@example.com', 'secret');

    assert.equal(token.access_token, 'fresh-access-token');
    assert.equal(oauth.token.access_token, 'fresh-access-token');
    assert.ok(token.expires_at > Math.floor(Date.now() / 1000), 'expires_at must be stamped');

    // The code Mercedes issued is the one exchanged, with the PKCE verifier.
    const exchange = idp.requests.find((r) => r.path === '/as/token.oauth2');
    assert.ok(exchange, 'token exchange must happen');
    const exchanged = new URLSearchParams(exchange.body);
    assert.equal(exchanged.get('code'), 'sso-issued-code');
    assert.equal(exchanged.get('grant_type'), 'authorization_code');
    assert.ok(exchanged.get('code_verifier'), 'PKCE verifier must be sent');

    // No credential step ran: the form was never served, so there was
    // nothing to submit to.
    const credentialSteps = idp.requests.filter((r) => r.path.startsWith('/ciam/'));
    assert.deepEqual(credentialSteps, []);
  } finally {
    await idp.close();
  }
});

test('login drops the previous session\'s cookies before authorizing', async () => {
  const idp = await fakeIdp({
    authorizeResponse: (url, res) => {
      res.writeHead(302, { Location: 'rismycar://login-callback?code=sso-issued-code' });
      res.end();
    },
  });

  try {
    const oauth = makeOAuth(idp.origin);
    oauth.jar.setCookieSync('PF=stale-session; Path=/', idp.origin);

    await oauth.login('user@example.com', 'secret');

    const authorize = idp.requests.find((r) => r.path === '/as/authorization.oauth2');
    assert.ok(authorize, 'authorize request must happen');
    assert.ok(
      !authorize.cookie.includes('PF=stale-session'),
      `previous session cookie must not be sent, got: "${authorize.cookie}"`,
    );
  } finally {
    await idp.close();
  }
});

test('the login-form flow still yields the resume parameter', async () => {
  const idp = await fakeIdp({
    authorizeResponse: (url, res) => {
      res.writeHead(302, { Location: '/ciam/auth/login?resume=%2Fas%2FEabc%2Fresume%2Fas%2Fauthorization.ping' });
      res.end();
    },
  });

  try {
    const oauth = makeOAuth(idp.origin);
    const authorization = await oauth._getAuthorizationResume();
    assert.equal(authorization.resume, '/as/Eabc/resume/as/authorization.ping');
    assert.equal(authorization.code, undefined);
  } finally {
    await idp.close();
  }
});
