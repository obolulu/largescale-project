import * as jwt from 'jsonwebtoken';

import { getSettings } from '../src/config';
import { PASSWORD, SUB1, useTestApp } from './helpers';

const ctx = useTestApp();
const DETAILED = '/api/v1/bills/detailed?month=10&year=2026';

it('login returns a token with role and subscriber number', async () => {
  const r = await ctx.http().post('/api/v1/auth/login').send({ username: 'sub1', password: PASSWORD });
  expect(r.status).toBe(200);
  expect(r.body.token_type).toBe('bearer');
  expect(r.body.role).toBe('SUBSCRIBER');
  expect(r.body.subscriber_no).toBe(SUB1);
  expect(r.body.expires_in).toBe(3600);
  const s = getSettings();
  const claims = jwt.verify(r.body.access_token, s.jwtSecret, {
    algorithms: ['HS256'],
    audience: s.jwtAudience,
    issuer: s.jwtIssuer,
  }) as jwt.JwtPayload;
  expect(claims.subscriber_no).toBe(SUB1);
  expect(claims.sub).toBe('sub1');
  expect(claims.exp! - claims.iat!).toBe(3600);
});

it('login with a wrong password is 401', async () => {
  const r = await ctx.http().post('/api/v1/auth/login').send({ username: 'sub1', password: 'nope' });
  expect(r.status).toBe(401);
  expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
});

it('login with an unknown user is 401', async () => {
  const r = await ctx.http().post('/api/v1/auth/login').send({ username: 'ghost', password: PASSWORD });
  expect(r.status).toBe(401);
});

function token(overrides: Record<string, unknown> = {}, secret = getSettings().jwtSecret): string {
  const s = getSettings();
  const claims: Record<string, unknown> = {
    sub: 'sub1',
    role: 'SUBSCRIBER',
    subscriber_no: SUB1,
    iss: s.jwtIssuer,
    aud: s.jwtAudience,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

it('a missing token is 401 with the error body and WWW-Authenticate', async () => {
  const r = await ctx.http().get(DETAILED);
  expect(r.status).toBe(401);
  expect(r.headers['www-authenticate']).toBe('Bearer');
  expect(r.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' } });
});

it('an expired token is 401', async () => {
  const r = await ctx.http().get(DETAILED).set(bearer(token({ exp: Math.floor(Date.now() / 1000) - 60 })));
  expect(r.status).toBe(401);
  expect(r.body.error.message).toBe('Token has expired.');
});

it('a token signed with another secret is 401', async () => {
  const r = await ctx.http().get(DETAILED).set(bearer(token({}, 'attacker-secret-that-is-long-enough-for-hs256')));
  expect(r.status).toBe(401);
  expect(r.body.error.message).toBe('Token is invalid.');
});

it('a token with the wrong audience is 401', async () => {
  const r = await ctx.http().get(DETAILED).set(bearer(token({ aud: 'someone-else' })));
  expect(r.status).toBe(401);
});

it('a subscriber token without subscriber_no is 401', async () => {
  const r = await ctx.http().get(DETAILED).set(bearer(token({ subscriber_no: null })));
  expect(r.status).toBe(401);
});

it('a non-bearer Authorization scheme counts as no token', async () => {
  const r = await ctx.http().get(DETAILED).set({ Authorization: `Basic ${token()}` });
  expect(r.status).toBe(401);
  expect(r.body.error.message).toBe('Missing or invalid bearer token.');
});
