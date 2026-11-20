import { Payment } from '../src/database/entities';
import { Headers, SUB1, SUB2, useTestApp } from './helpers';

const ctx = useTestApp();
const URL = '/api/v1/payments';

function pay(headers: Headers, amount: unknown, transaction_id: string, extra: Record<string, unknown> = {}) {
  return ctx.http().post(URL).set(headers).send({ month: 10, year: 2026, amount, transaction_id, ...extra });
}

const queryBill = async () =>
  (await ctx.http().get('/api/v1/bills').query({ subscriber_no: SUB1, month: 10, year: 2026 })).body;

it('a partial payment leaves the bill PARTIAL (§5.1)', async () => {
  await ctx.makeBill(SUB1, 2026, 10, { minutes: 1_350, mb: 35_000 }); // $80
  const r = await pay(await ctx.login('sub1'), 30, 'tx-1');
  expect(r.status).toBe(201);
  expect(r.body.payment_status).toBe('SUCCESS');
  expect([r.body.amount, r.body.paid_amount, r.body.remaining_balance]).toEqual([30, 30, 50]);
  expect(r.body.bill_status).toBe('PARTIAL');
});

it('payments add up to PAID', async () => {
  await ctx.makeBill(SUB1, 2026, 10); // $50
  const headers = await ctx.login('sub1');
  await pay(headers, 20.5, 'tx-1');
  const body = (await pay(headers, '29.50', 'tx-2')).body; // amounts may also be strings
  expect([body.paid_amount, body.remaining_balance, body.bill_status]).toEqual([50, 0, 'PAID']);
  expect((await queryBill()).status).toBe('PAID');
});

it('a duplicate transaction ID is 409 and records nothing', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const headers = await ctx.login('sub1');
  expect((await pay(headers, 10, 'tx-dup')).status).toBe(201);
  const r = await pay(headers, 10, 'tx-dup');
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('DUPLICATE_TRANSACTION');
  expect(await ctx.ds.manager.count(Payment)).toBe(1);
  expect((await queryBill()).paid_amount).toBe(10);
});

it('an overpayment is 422', async () => {
  await ctx.makeBill(SUB1, 2026, 10); // $50
  const r = await pay(await ctx.login('sub1'), 50.01, 'tx-1');
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  expect(r.body.error.message).toBe('Payment of 50.01 exceeds the remaining balance of 50.00.');
  expect(r.body.error.details).toEqual({ remaining_balance: 50 });
});

it('paying a paid bill is 409', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const headers = await ctx.login('sub1');
  await pay(headers, 50, 'tx-1');
  const r = await pay(headers, 1, 'tx-2');
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('BILL_ALREADY_PAID');
});

it('zero and negative amounts are 422', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const headers = await ctx.login('sub1');
  const zero = await pay(headers, 0, 'tx-0');
  expect(zero.status).toBe(422);
  expect(zero.body.error.details).toEqual([{ field: 'amount', message: 'Input should be greater than 0' }]);
  expect((await pay(headers, -5, 'tx-neg')).status).toBe(422);
});

it('an amount with more than two decimals is 422', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const r = await pay(await ctx.login('sub1'), 10.005, 'tx-1');
  expect(r.status).toBe(422);
  expect(r.body.error.details[0].message).toBe('Decimal input should have no more than 2 decimal places');
});

it('an invalid transaction ID is 422', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const r = await pay(await ctx.login('sub1'), 10, 'bad id with spaces');
  expect(r.status).toBe(422);
  expect(r.body.error.details[0].field).toBe('transaction_id');
});

it('Pay Bill without a token is 401', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const r = await ctx
    .http()
    .post(URL)
    .send({ subscriber_no: SUB1, month: 10, year: 2026, amount: 10, transaction_id: 't' });
  expect(r.status).toBe(401);
});

it("paying another subscriber's bill is 403", async () => {
  await ctx.makeBill(SUB2, 2026, 10);
  const r = await pay(await ctx.login('sub1'), 10, 'tx-1', { subscriber_no: SUB2 });
  expect(r.status).toBe(403);
});

it('paying a bill that does not exist is 404', async () => {
  const r = await pay(await ctx.login('sub1'), 10, 'tx-1', { month: 1 });
  expect(r.status).toBe(404);
  expect(r.body.error.code).toBe('BILL_NOT_FOUND');
});

it('an admin can pay for a named subscriber', async () => {
  await ctx.makeBill(SUB2, 2026, 10);
  const headers = await ctx.login('admin');
  expect((await pay(headers, 10, 'tx-1')).status).toBe(422); // no subscriber_no
  const r = await pay(headers, 10, 'tx-2', { subscriber_no: SUB2 });
  expect(r.status).toBe(201);
  expect(r.body.bill.subscriber_no).toBe(SUB2);
});

it('concurrent payments with the same transaction ID record one payment', async () => {
  await ctx.makeBill(SUB1, 2026, 10);
  const headers = await ctx.login('sub1');
  const results = await Promise.all([pay(headers, 10, 'tx-race'), pay(headers, 10, 'tx-race')]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await ctx.ds.manager.count(Payment)).toBe(1);
});
