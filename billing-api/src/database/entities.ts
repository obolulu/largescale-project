/**
 * Database schema. Keep in sync with src/database/migrations/ (the migrations
 * are the source of truth; synchronize is off).
 */
import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

import { centsTransformer, type Cents } from '../common/money';
import { BillStatus, Role, UsageType } from './enums';

const money = { type: 'numeric', precision: 10, scale: 2, transformer: centsTransformer } as const;

@Entity({ name: 'subscribers' })
export class Subscriber {
  @PrimaryColumn({ name: 'subscriber_no', type: 'varchar', length: 20 })
  subscriberNo: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 50, default: 'STANDARD' })
  plan: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  username: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 100 })
  passwordHash: string;

  @Column({ type: 'enum', enum: Role, enumName: 'user_role' })
  role: Role;

  /** A subscriber login must point at a subscriber; an admin need not. */
  @Column({ name: 'subscriber_no', type: 'varchar', length: 20, nullable: true })
  subscriberNo: string | null;
}

/** One recorded usage event. Add Usage writes 10 min or 1 MB; the seed script writes batches. */
@Entity({ name: 'usage_records' })
export class UsageRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'subscriber_no', type: 'varchar', length: 20 })
  subscriberNo: string;

  @Column({ type: 'integer' })
  year: number;

  @Column({ type: 'integer' })
  month: number;

  @Column({ name: 'usage_type', type: 'enum', enum: UsageType, enumName: 'usage_type' })
  usageType: UsageType;

  @Column({ type: 'integer' })
  amount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

@Entity({ name: 'bills' })
export class Bill {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'subscriber_no', type: 'varchar', length: 20 })
  subscriberNo: string;

  @Column({ type: 'integer' })
  year: number;

  @Column({ type: 'integer' })
  month: number;

  @Column({ name: 'phone_minutes', type: 'integer' })
  phoneMinutes: number;

  @Column({ name: 'internet_mb', type: 'integer' })
  internetMb: number;

  @Column({ name: 'phone_charge', ...money })
  phoneCharge: Cents;

  @Column({ name: 'internet_charge', ...money })
  internetCharge: Cents;

  @Column({ name: 'total', ...money })
  total: Cents;

  @Column({ name: 'paid_amount', ...money })
  paidAmount: Cents;

  @Column({ type: 'enum', enum: BillStatus, enumName: 'bill_status' })
  status: BillStatus;

  @Column({ name: 'calculated_at', type: 'timestamptz', default: () => 'now()' })
  calculatedAt: Date;
}

@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'bill_id', type: 'integer' })
  billId: number;

  /** UNIQUE gives idempotency: a retried payment with the same ID is rejected (guide §5.3). */
  @Column({ name: 'transaction_id', type: 'varchar', length: 64, unique: true })
  transactionId: string;

  @Column({ name: 'amount', ...money })
  amount: Cents;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export const ENTITIES = [Subscriber, User, UsageRecord, Bill, Payment];
