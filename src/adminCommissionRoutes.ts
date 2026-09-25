import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';
import {
  commissionLedgerDate,
  commissionLedgerStatus,
  filterCommissionLedger,
  summarizeCommissionLedger,
} from './commissionLedger';

function queryDate(value: unknown): string | undefined {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function queryStatus(value: unknown): 'paid' | 'processing' | 'failed' | undefined {
  const status = String(value || '').trim().toLowerCase();
  return ['paid', 'processing', 'failed'].includes(status)
    ? status as 'paid' | 'processing' | 'failed'
    : undefined;
}

function cleanCommission(record: Record<string, any>) {
  return {
    id: record.id,
    date: commissionLedgerDate(record),
    submittedAt: record.submitted_at || record.created_date || null,
    updatedAt: record.updated_date || null,
    driverId: record.driver_id || null,
    driverName: record.driver_name || 'Driver',
    serviceType: record.service_type || 'car',
    amount: Number(record.amount || 0),
    status: commissionLedgerStatus(record.status),
    rawStatus: String(record.status || 'unknown'),
    chargeMethod: record.charge_method || 'hubtel_auto',
    hubtelReference: record.hubtel_reference || null,
    hubtelTransactionId: record.hubtel_transaction_id || null,
    hubtelStatus: record.hubtel_status || null,
    adminOverride: record.admin_override === true,
  };
}

/**
 * Trusted, read-only ledger for the web admin. It deliberately reads through
 * Firebase Admin rather than direct browser Firestore, so fee records stay
 * private and only verified Firebase administrators can see them.
 */
export function registerAdminCommissionRoutes(app: Express) {
  app.get('/api/admin/driver-fees', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    const dateFrom = queryDate(request.query.dateFrom);
    const dateTo = queryDate(request.query.dateTo);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      response.status(400).json({ error: 'The start date must be before the end date.' });
      return;
    }

    try {
      const allRecords = await adminFirestore.list(
        ADMIN_COLLECTIONS.DAILY_COMMISSION,
        {},
        'created_date',
        'desc',
        500,
      );
      const status = queryStatus(request.query.status);
      const records = filterCommissionLedger(allRecords, { dateFrom, dateTo, status });
      const today = new Date().toISOString().slice(0, 10);
      response.json({
        generatedAt: new Date().toISOString(),
        requestedBy: adminEmail,
        filters: { dateFrom: dateFrom || null, dateTo: dateTo || null, status: status || null },
        summary: summarizeCommissionLedger(records, today),
        records: records.map(cleanCommission),
      });
    } catch (error) {
      console.error('[Admin driver fees] Failed to read commission ledger:', error);
      response.status(503).json({ error: 'Driver fee records are temporarily unavailable. Please refresh.' });
    }
  });
}
