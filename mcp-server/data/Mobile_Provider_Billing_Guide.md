# Mobile Provider Billing Guide

**Document ID:** MOB-BILLING-2026-01  
**Version:** 1.0  
**Effective date:** November 1, 2026  
**Status:** Fictitious teaching document for SE 4458

> This document explains general billing policies. It does not contain live subscriber usage, bill totals, or payment records. The Billing REST API and its database are the authoritative sources for those values.

## 1. Scope and terminology

**Subscriber number** identifies a mobile account. **Billing period** is a calendar month and year. **Phone usage** is measured in minutes. **Internet usage** is measured in MB and converted to GB for pricing. **Paid status** indicates whether the bill has been fully settled in the billing database.

## 2. Phone call pricing

### 2.1 Included minutes

The first **1,000 minutes** of phone calls in a billing month are free.

### 2.2 Additional minutes

Each **additional 1,000-minute block** costs **$10**. A partially used additional block is charged as a full block. For example, 1,001 minutes costs $10 in phone charges; 2,001 minutes costs $20.

### 2.3 Usage recording

The Add Usage API records **10 minutes** of phone usage for each phone-usage event. The billing engine totals recorded usage for the selected subscriber and billing period.

## 3. Internet pricing

### 3.1 Included internet allowance

Internet access costs **$50 per month** for up to **20 GB**, including months with zero usage.

### 3.2 Additional internet blocks

Each additional **10 GB block** costs **$10**. A partially used additional block is charged as a full block. For example, 20 GB costs $50; 21 GB costs $60; 30 GB costs $60; 35 GB costs $70.

### 3.3 Units and usage events

For this fictitious system, **1 GB = 1,000 MB**. Each internet Add Usage API event records **1 MB**. The billing engine aggregates usage for the selected month and year.

## 4. Bill calculation

### 4.1 Billing period

Bills are calculated by calendar month. A bill includes phone charges and internet charges based on recorded usage for the period.

### 4.2 Calculation formula

Phone charge = `$10 × ceil(max(0, minutes − 1000) / 1000)`.

Internet charge = `$50 + $10 × ceil(max(0, internet_GB − 20) / 10)`.

Total bill = phone charge + internet charge. For this midterm, there are **no taxes, activation fees, discounts, or other service charges**.

### 4.3 Worked example

A subscriber uses **1,350 phone minutes** and **35 GB** of internet in a month. Phone: $10 for one extra 1,000-minute block. Internet: $50 base + $20 for two additional 10 GB blocks. **Total = $80**.

### 4.4 Bill generation

The Calculate Bill API calculates and stores the bill for the specified subscriber, month, and year. The Query Bill API returns the stored bill total and paid status; the Query Bill Detailed API returns the charge breakdown. An AI assistant should not present a calculated estimate as a confirmed stored bill.

## 5. Payments and outstanding balances

### 5.1 Full and partial payments

Subscribers may make full or partial payments. A partial payment reduces the outstanding balance but does **not** mark the bill fully paid.

### 5.2 Payment confirmation

Before the AI assistant submits a payment, it must identify the subscriber, billing period, and amount and request explicit confirmation. It must not infer consent from a request for payment information.

### 5.3 Payment result

The assistant should report success only after the Pay Bill API confirms the transaction. Retries should use idempotency protection to avoid duplicate payment records.

## 6. Late payments and restrictions

### 6.1 Due date

A monthly bill is due **15 calendar days after the end of its billing month**. For example, an October 2026 bill is due November 15, 2026.

### 6.2 Late payment reminder

An unpaid bill may trigger a reminder after its due date. The reminder itself does not add a fee.

### 6.3 Service restriction

Service **may** be restricted when a bill remains unpaid for **30 days after the due date**, subject to customer support review. This is a policy description, not a live service-status check.

## 7. Billing disputes

### 7.1 Dispute window

Subscribers may submit a billing dispute within **15 calendar days of the bill issue date**.

### 7.2 Information required

A dispute should include the subscriber number, billing period, disputed amount, and explanation. The AI assistant may explain this process but does not have a Dispute API in the required midterm endpoints.

### 7.3 Review outcome

Dispute decisions are made by customer support. The assistant must not promise a refund or adjustment without a supporting system record.

## 8. Frequently asked questions

### 8.1 What is the cost of extra internet?

Each additional 10 GB block beyond 20 GB costs $10. Partially used blocks are rounded up. See Section 3.2.

### 8.2 Why is my bill higher this month?

Use Query Bill Detailed to retrieve actual usage and charge breakdown, then use Sections 2–4 to explain the applicable rules. Do not invent usage amounts.

### 8.3 Can I pay only part of my bill?

Yes. The unpaid remainder stays outstanding, and the bill is not fully paid until the balance reaches zero. See Section 5.1.

### 8.4 How can I dispute a charge?

Submit the billing period, disputed amount, and explanation within 15 days of bill issuance. See Section 7.

## 9. Guidance for AI/MCP implementation

The MCP tool `search_billing_documentation(query)` should return relevant passages with **section ID, heading, document ID, and text**. Example:

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "matches": [
    {
      "section": "3.2",
      "heading": "Additional internet blocks",
      "text": "Each additional 10 GB block costs $10. A partially used additional block is charged as a full block."
    }
  ]
}
```

The AI agent should use MCP for policy and pricing explanations, the Billing REST API for live usage, bill totals, and payments, and both for explanations of a particular subscriber's charges. REST API calls must go through the required API Gateway. The MCP documentation index is not a replacement for the billing database.
