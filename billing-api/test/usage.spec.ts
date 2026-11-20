import { UsageRecord } from '../src/database/entities';
import { UsageType } from '../src/database/enums';
import { SUB1, UNKNOWN_SUB, useTestApp } from './helpers';

const ctx = useTestApp();
const URL = '/api/v1/usage';

const body = (overrides: Record<string, unknown> = {}) => ({
  subscriber_no: SUB1,
  month: 10,
  year: 2026,
  usage_type: 'PHONE',
  ...overrides,
});

it('adding phone usage records 10 minutes', async () => {
  const r = await ctx.http().post(URL).set(await ctx.login('admin')).send(body({ usage_type: 'PHONE' }));
  expect(r.status).toBe(201);
  expect(r.body.status).toBe('SUCCESS');
  expect([r.body.amount_added, r.body.unit]).toEqual([10, 'MINUTES']);
  const record = await ctx.ds.manager.findOneByOrFail(UsageRecord, { id: r.body.usage_id });
  expect(record.amount).toBe(10);
});

it('adding internet usage records 1 MB', async () => {
  const r = await ctx.http().post(URL).set(await ctx.login('admin')).send(body({ usage_type: 'INTERNET' }));
  expect(r.status).toBe(201);
  expect([r.body.amount_added, r.body.unit]).toEqual([1, 'MB']);
});

it('repeated Add Usage accumulates', async () => {
  const headers = await ctx.login('admin');
  for (let i = 0; i < 3; i++) await ctx.http().post(URL).set(headers).send(body());
  const total = await ctx.ds.manager.sum(UsageRecord, 'amount', { usageType: UsageType.PHONE });
  expect(total).toBe(30);
});

it('Add Usage without a token is 401', async () => {
  expect((await ctx.http().post(URL).send(body())).status).toBe(401);
});

it('Add Usage without a token is 401 even when the body is invalid', async () => {
  expect((await ctx.http().post(URL).send(body({ month: 13 }))).status).toBe(401);
});

it('Add Usage as a subscriber is 403', async () => {
  const r = await ctx.http().post(URL).set(await ctx.login('sub1')).send(body());
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('FORBIDDEN');
});

it('Add Usage for an unknown subscriber is 404', async () => {
  const r = await ctx.http().post(URL).set(await ctx.login('admin')).send(body({ subscriber_no: UNKNOWN_SUB }));
  expect(r.status).toBe(404);
  expect(r.body.error.code).toBe('SUBSCRIBER_NOT_FOUND');
});

it('Add Usage with an invalid month is 422', async () => {
  const r = await ctx.http().post(URL).set(await ctx.login('admin')).send(body({ month: 13 }));
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('VALIDATION_ERROR');
  expect(r.body.error.details[0]).toEqual({ field: 'month', message: 'Input should be less than or equal to 12' });
});

it('Add Usage with an unknown type is 422', async () => {
  const r = await ctx.http().post(URL).set(await ctx.login('admin')).send(body({ usage_type: 'SMS' }));
  expect(r.status).toBe(422);
  expect(r.body.error.details).toEqual([{ field: 'usage_type', message: "Input should be 'PHONE' or 'INTERNET'" }]);
});

it('malformed JSON is 422', async () => {
  const r = await ctx
    .http()
    .post(URL)
    .set(await ctx.login('admin'))
    .set('Content-Type', 'application/json')
    .send('{"month": 10,');
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('VALIDATION_ERROR');
});
