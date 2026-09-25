export type DriverEarningsPeriod = 'today' | 'week' | 'month';

type DatedRecord = Record<string, unknown>;

function parsedDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const converted = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(converted.getTime()) ? null : converted;
  }

  const valueString = String(value || '').trim();
  if (!valueString) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(valueString)
    ? new Date(`${valueString}T00:00:00.000Z`)
    : new Date(valueString);
  return Number.isNaN(date.getTime()) ? null : date;
}

function periodBounds(period: DriverEarningsPeriod, referenceDate: Date) {
  const reference = new Date(referenceDate);
  const end = new Date(Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate() + 1,
  ));
  const days = period === 'today' ? 1 : period === 'week' ? 7 : 30;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end };
}

function recordDate(record: DatedRecord, fields: string[]) {
  for (const field of fields) {
    const date = parsedDate(record[field]);
    if (date) return date;
  }
  return null;
}

export function isRecordInEarningsPeriod(
  record: DatedRecord,
  period: DriverEarningsPeriod,
  referenceDate = new Date(),
  dateFields = ['completed_at', 'trip_date', 'created_date'],
) {
  const date = recordDate(record, dateFields);
  if (!date) return false;
  const { start, end } = periodBounds(period, referenceDate);
  return date >= start && date < end;
}

export function completedRidesForPeriod(
  rides: DatedRecord[],
  period: DriverEarningsPeriod,
  referenceDate = new Date(),
) {
  return rides.filter((ride) => (
    String(ride.status || '').toLowerCase() === 'completed'
    && isRecordInEarningsPeriod(ride, period, referenceDate)
  ));
}

export function paidFeesForPeriod(
  fees: DatedRecord[],
  period: DriverEarningsPeriod,
  referenceDate = new Date(),
) {
  return fees.filter((fee) => (
    ['paid', 'completed'].includes(String(fee.status || '').toLowerCase())
    && isRecordInEarningsPeriod(fee, period, referenceDate, ['date', 'paid_at', 'submitted_at', 'created_date'])
  ));
}

export function numericRideFare(ride: DatedRecord) {
  const value = Number(ride.final_fare ?? ride.fare ?? ride.fare_estimate ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function numericTip(ride: DatedRecord) {
  const value = Number(ride.tip_amount || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function earningsTrend(rides: DatedRecord[], maxDays = 14) {
  const byDate = new Map<string, number>();
  for (const ride of rides) {
    const completedAt = recordDate(ride, ['completed_at', 'trip_date', 'created_date']);
    if (!completedAt) continue;
    const date = completedAt.toISOString().slice(0, 10);
    byDate.set(date, (byDate.get(date) || 0) + numericRideFare(ride) + numericTip(ride));
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-maxDays)
    .map(([date, amount]) => ({ date, amount }));
}
