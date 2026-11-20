import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Initial schema: subscribers, users, usage_records, bills, payments. */
export class InitialSchema1763510400000 implements MigrationInterface {
  name = 'InitialSchema1763510400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE user_role AS ENUM ('SUBSCRIBER', 'ADMIN')`);
    await q.query(`CREATE TYPE usage_type AS ENUM ('PHONE', 'INTERNET')`);
    await q.query(`CREATE TYPE bill_status AS ENUM ('UNPAID', 'PARTIAL', 'PAID')`);

    await q.query(`
      CREATE TABLE subscribers (
        subscriber_no VARCHAR(20) PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        plan          VARCHAR(50)  NOT NULL,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(50)  NOT NULL UNIQUE,
        password_hash VARCHAR(100) NOT NULL,
        role          user_role    NOT NULL,
        subscriber_no VARCHAR(20)  REFERENCES subscribers (subscriber_no),
        CONSTRAINT ck_users_subscriber_has_no CHECK (role = 'ADMIN' OR subscriber_no IS NOT NULL)
      )`);

    await q.query(`
      CREATE TABLE usage_records (
        id            SERIAL PRIMARY KEY,
        subscriber_no VARCHAR(20) NOT NULL REFERENCES subscribers (subscriber_no),
        year          INTEGER     NOT NULL,
        month         INTEGER     NOT NULL,
        usage_type    usage_type  NOT NULL,
        amount        INTEGER     NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_usage_month CHECK (month BETWEEN 1 AND 12),
        CONSTRAINT ck_usage_amount_positive CHECK (amount > 0)
      )`);
    await q.query(`CREATE INDEX ix_usage_period ON usage_records (subscriber_no, year, month)`);

    await q.query(`
      CREATE TABLE bills (
        id              SERIAL PRIMARY KEY,
        subscriber_no   VARCHAR(20)   NOT NULL REFERENCES subscribers (subscriber_no),
        year            INTEGER       NOT NULL,
        month           INTEGER       NOT NULL,
        phone_minutes   INTEGER       NOT NULL,
        internet_mb     INTEGER       NOT NULL,
        phone_charge    NUMERIC(10,2) NOT NULL,
        internet_charge NUMERIC(10,2) NOT NULL,
        total           NUMERIC(10,2) NOT NULL,
        paid_amount     NUMERIC(10,2) NOT NULL,
        status          bill_status   NOT NULL,
        calculated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT uq_bills_period UNIQUE (subscriber_no, year, month),
        CONSTRAINT ck_bills_month CHECK (month BETWEEN 1 AND 12),
        CONSTRAINT ck_bills_paid_nonnegative CHECK (paid_amount >= 0)
      )`);

    await q.query(`
      CREATE TABLE payments (
        id             SERIAL PRIMARY KEY,
        bill_id        INTEGER       NOT NULL REFERENCES bills (id),
        transaction_id VARCHAR(64)   NOT NULL UNIQUE,
        amount         NUMERIC(10,2) NOT NULL,
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT ck_payments_amount_positive CHECK (amount > 0)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of ['payments', 'bills', 'usage_records', 'users', 'subscribers']) {
      await q.query(`DROP TABLE ${table}`);
    }
    for (const type of ['bill_status', 'usage_type', 'user_role']) {
      await q.query(`DROP TYPE ${type}`);
    }
  }
}
