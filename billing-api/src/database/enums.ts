export enum Role {
  SUBSCRIBER = 'SUBSCRIBER',
  ADMIN = 'ADMIN',
}

export enum UsageType {
  PHONE = 'PHONE', // amount is minutes
  INTERNET = 'INTERNET', // amount is MB
}

export enum BillStatus {
  UNPAID = 'UNPAID',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
}

export const ROLES = Object.values(Role);
export const USAGE_TYPES = Object.values(UsageType);
export const BILL_STATUSES = Object.values(BillStatus);
