import type { Express, Request, Response } from 'express';
import { ADMIN_COLLECTIONS, adminFirestore } from './firebaseAdmin';
import { requireAdministrator } from './adminAuthorization';
import { financialRideRecord, summarizeRideFinancials } from './rideFinancialReporting';

function queryDate(value: unknown): string | undefined {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function reportDate(record: { completedAt: string | null; cancelledAt: string | null; updatedAt: string | null }): string {
  return String(record.completedAt || record.cancelledAt || record.updatedAt || '').slice(0, 10);
}

/**
 * Provides a protected, accounting-oriented view of completed and cancelled
 * rides. It does not claim that a cash fare has been collected; it reports the
 * server-authoritative ride charge and separately exposes its waiting component.
 */
export function registerAdminFinancialRoutes(app: Express) {
  app.get('/api/admin/financials/reconciliation/latest', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    try {
      const audits = await adminFirestore.list(
        ADMIN_COLLECTIONS.FINANCIAL_RECONCILIATION_AUDITS,
        {},
        'runDate',
        'desc',
        1,
      );
      response.json({
        generatedAt: new Date().toISOString(),
        schedule: {
          frequency: 'daily',
          localTime: '02:15',
          timeZone: 'Africa/Accra',
        },
        audit: audits[0] || null,
      });
    } catch (error) {
      console.error('[Admin financials] Failed to read daily reconciliation audit:', error);
      response.status(503).json({ error: 'Daily reconciliation status is temporarily unavailable. Please refresh.' });
    }
  });

  app.get('/api/admin/financials/rides', async (request: Request, response: Response) => {
    const adminEmail = await requireAdministrator(request, response);
    if (!adminEmail) return;

    const dateFrom = queryDate(request.query.dateFrom);
    const dateTo = queryDate(request.query.dateTo);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      response.status(400).json({ error: 'The start date must be before the end date.' });
      return;
    }

    try {
      // Do not order by `updated_date`: legacy terminal rides without that
      // field are excluded by Firestore ordering and must remain auditable.
      const rides = await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, {}, null, 'desc', 1_000);
      const records = rides
        .map(financialRideRecord)
        .filter((record): record is NonNullable<typeof record> => record !== null)
        .filter((record) => {
          const date = reportDate(record);
          return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
        });
      response.json({
        generatedAt: new Date().toISOString(),
        requestedBy: adminEmail,
        filters: { dateFrom: dateFrom || null, dateTo: dateTo || null },
        accountingBasis: {
          fareAmount: 'Persisted completed final fare; current rides are server-authoritative, while legacy stored values are preserved for reconciliation. It includes waiting fee and excludes any separately stored tip.',
          legacyQuoteEstimate: 'A historical quote/estimate with no persisted final fare. It is shown separately and excluded from completed ride charges until a final amount is available.',
          waitingFee: 'Component of fareAmount and totalRideCharge; do not add it a second time.',
          totalRideCharge: 'Completed fare amount plus tip, where a server-confirmed tip exists.',
          cancellationPenalty: 'Separate cancellation fee only. Current pre-start cancellation policy records zero.',
          collectionStatus: 'Ride charges are not proof of payment collection. Reconcile payment-provider records separately.',
        },
        summary: summarizeRideFinancials(records),
        records,
      });
    } catch (error) {
      console.error('[Admin financials] Failed to read ride financial ledger:', error);
      response.status(503).json({ error: 'Ride financial records are temporarily unavailable. Please refresh.' });
    }
  });
}
