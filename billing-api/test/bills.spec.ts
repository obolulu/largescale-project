import { SUB1, SUB2, UNKNOWN_SUB, useTestApp } from './helpers';

const ctx = useTestApp();
const CALC = '/api/v1/bills/calculate';
const QUERY = '/api/v1/bills';
const DETAILED = '/api/v1/bills/detailed';

// ---------- Calculate Bill ----------

describe('Calculate Bill', () => {
  it("matches the guide's worked example (§4.3: 1,350 minutes + 35 GB -> $80)", async () => {
    const body = await ctx.makeBill(SUB1, 2026, 10, { minutes: 1_350, mb: 35_000 });
    expect(body.action).toBe('CREATED');
    expect(body.phone_charge).toBe(10);
    expect(body.internet_charge).toBe(70);
    expect(body.bill.total).toBe(80);
    expect(body.bill.status).toBe('UNPAID');
    expect(body.bill.due_date).toBe('2026-11-15'); // §6.1
  });

  it('with no usage charges the internet base price (§3.1)', async () => {
    expect((await ctx.makeBill(SUB1, 2026, 10)).bill.total).toBe(50);
  });

  it('uses usage added through the API', async () => {
    const headers = await ctx.login('admin');
    for (const usage_type of ['PHONE', 'INTERNET']) {
      await ctx.http().post('/api/v1/usage').set(headers).send({ subscriber_no: SUB1, month: 10, year: 2026, usage_type });
    }
    const r = await ctx.http().post(CALC).set(headers).send({ subscriber_no: SUB1, month: 10, year: 2026 });
    expect([r.body.phone_minutes, r.body.internet_mb]).toEqual([10, 1]);
  });

  it('recalculating updates the total and keeps payments', async () => {
    await ctx.makeBill(SUB1, 2026, 10); // $50
    await ctx
      .http()
      .post('/api/v1/payments')
      .set(await ctx.login('sub1'))
      .send({ month: 10, year: 2026, amount: 50, transaction_id: 't-1' });
    await ctx.addUsageRows(SUB1, 2026, 10, { minutes: 1_500 }); // +$10 phone
    const r = await ctx
      .http()
      .post(CALC)
      .set(await ctx.login('admin'))
      .send({ subscriber_no: SUB1, month: 10, year: 2026 });
    const bill = r.body.bill;
    expect(r.body.action).toBe('UPDATED');
    expect([bill.total, bill.paid_amount, bill.remaining_balance]).toEqual([60, 50, 10]);
    expect(bill.status).toBe('PARTIAL');
  });

  it('as a subscriber is 403', async () => {
    const r = await ctx.http().post(CALC).set(await ctx.login('sub1')).send({ subscriber_no: SUB1, month: 10, year: 2026 });
    expect(r.status).toBe(403);
  });

  it('without a token is 401', async () => {
    expect((await ctx.http().post(CALC).send({ subscriber_no: SUB1, month: 10, year: 2026 })).status).toBe(401);
  });

  it('for an unknown subscriber is 404', async () => {
    const r = await ctx
      .http()
      .post(CALC)
      .set(await ctx.login('admin'))
      .send({ subscriber_no: UNKNOWN_SUB, month: 10, year: 2026 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('SUBSCRIBER_NOT_FOUND');
  });

  it('with an invalid year is 422', async () => {
    const r = await ctx.http().post(CALC).set(await ctx.login('admin')).send({ subscriber_no: SUB1, month: 10, year: 1999 });
    expect(r.status).toBe(422);
    expect(r.body.error.details).toEqual([{ field: 'year', message: 'Input should be greater than or equal to 2000' }]);
  });
});

// ---------- Query Bill (no auth) ----------

describe('Query Bill', () => {
  it('works without auth', async () => {
    await ctx.makeBill(SUB1, 2026, 10, { minutes: 1_350, mb: 35_000 });
    const r = await ctx.http().get(QUERY).query({ subscriber_no: SUB1, month: 10, year: 2026 });
    expect(r.status).toBe(200);
    expect([r.body.total, r.body.paid_amount, r.body.remaining_balance]).toEqual([80, 0, 80]);
    expect(r.body.status).toBe('UNPAID');
    expect(r.body.currency).toBe('USD');
  });

  it('for a bill that was not calculated is 404', async () => {
    const r = await ctx.http().get(QUERY).query({ subscriber_no: SUB1, month: 10, year: 2026 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('BILL_NOT_FOUND');
    expect(r.body.error.message).toBe(
      'No calculated bill for subscriber 5551001 in 2026-10. Run Calculate Bill first.',
    );
  });

  it('with a missing parameter is 422', async () => {
    const r = await ctx.http().get(QUERY).query({ subscriber_no: SUB1, month: 10 });
    expect(r.status).toBe(422);
    expect(r.body.error.details[0]).toEqual({ field: 'year', message: 'Field required' });
  });
});

// ---------- Query Bill Detailed (auth + paging) ----------

describe('Query Bill Detailed', () => {
  it('shows the breakdown for the own account', async () => {
    await ctx.makeBill(SUB1, 2026, 10, { minutes: 1_350, mb: 35_000 });
    const r = await ctx.http().get(DETAILED).query({ month: 10, year: 2026 }).set(await ctx.login('sub1'));
    expect(r.status).toBe(200);
    const body = r.body;
    expect(body.usage).toEqual({ phone_minutes: 1_350, internet_mb: 35_000, internet_gb: 35.0 });
    const { phone, internet } = body.charges;
    expect([phone.extra_minutes, phone.blocks_charged, phone.charge]).toEqual([350, 1, 10]);
    expect([internet.extra_mb, internet.blocks_charged, internet.charge]).toEqual([15_000, 2, 70]);
    expect(body.charges.taxes_and_fees).toBe(0);
    expect(body.total).toBe(80);
  });

  it('pages the usage items', async () => {
    for (let day = 1; day <= 5; day++) {
      await ctx.addUsageRows(SUB1, 2026, 10, { minutes: 100, mb: 1_000, day }); // 5 phone + 5 internet rows
    }
    await ctx.makeBill(SUB1, 2026, 10);
    const headers = await ctx.login('sub1');

    const first = (await ctx.http().get(DETAILED).query({ month: 10, year: 2026, page_size: 4 }).set(headers)).body;
    const page = first.usage_items;
    expect([page.page, page.page_size, page.total_items, page.total_pages]).toEqual([1, 4, 10, 3]);
    expect(page.items).toHaveLength(4);

    const last = (await ctx.http().get(DETAILED).query({ month: 10, year: 2026, page: 3, page_size: 4 }).set(headers))
      .body.usage_items;
    expect(last.items).toHaveLength(2);
    const ids = [...page.items, ...last.items].map((i: { id: number }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a page past the end is empty', async () => {
    await ctx.makeBill(SUB1, 2026, 10, { minutes: 100 });
    const r = await ctx.http().get(DETAILED).query({ month: 10, year: 2026, page: 9 }).set(await ctx.login('sub1'));
    expect(r.status).toBe(200);
    expect(r.body.usage_items.items).toEqual([]);
  });

  it('an invalid page size is 422', async () => {
    const r = await ctx.http().get(DETAILED).query({ month: 10, year: 2026, page_size: 500 }).set(await ctx.login('sub1'));
    expect(r.status).toBe(422);
  });

  it('without a token is 401', async () => {
    await ctx.makeBill(SUB1, 2026, 10);
    expect((await ctx.http().get(DETAILED).query({ month: 10, year: 2026, subscriber_no: SUB1 })).status).toBe(401);
  });

  it("for another subscriber is 403 (a number typed into a prompt must not unlock someone else's data)", async () => {
    await ctx.makeBill(SUB2, 2026, 10);
    const r = await ctx
      .http()
      .get(DETAILED)
      .query({ month: 10, year: 2026, subscriber_no: SUB2 })
      .set(await ctx.login('sub1'));
    expect(r.status).toBe(403);
  });

  it('as an admin requires subscriber_no', async () => {
    await ctx.makeBill(SUB2, 2026, 10);
    const headers = await ctx.login('admin');
    expect((await ctx.http().get(DETAILED).query({ month: 10, year: 2026 }).set(headers)).status).toBe(422);
    const r = await ctx.http().get(DETAILED).query({ month: 10, year: 2026, subscriber_no: SUB2 }).set(headers);
    expect(r.status).toBe(200);
  });

  it('for a bill that was not calculated is 404', async () => {
    const r = await ctx.http().get(DETAILED).query({ month: 10, year: 2026 }).set(await ctx.login('sub1'));
    expect(r.status).toBe(404);
  });
});

it('an unknown route is 404 with the error body', async () => {
  const r = await ctx.http().get('/api/v1/nope');
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not Found' } });
});

it('health check', async () => {
  const r = await ctx.http().get('/api/v1/health');
  expect(r.body).toEqual({ status: 'ok', version: 'v1' });
});

it('a trailing slash reaches the same route; a wrong method is 404', async () => {
  expect((await ctx.http().get('/api/v1/health/')).status).toBe(200);
  const r = await ctx.http().put('/api/v1/health');
  expect(r.status).toBe(404);
  expect(r.body.error.code).toBe('NOT_FOUND');
});
