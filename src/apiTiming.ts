export type ApiTimingRecord = {
  event: 'api_timing';
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  slow: boolean;
};

/**
 * Cloud logs are operational telemetry, not a copy of app traffic. Strip query
 * strings and opaque identifier-like path segments before a route is emitted.
 */
export function apiTimingRoute(originalUrl: string): string {
  const pathname = String(originalUrl || '').split(/[?#]/, 1)[0] || '/';
  return pathname.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:id');
}

export function apiTimingRecord(
  method: string,
  originalUrl: string,
  statusCode: number,
  durationMs: number,
): ApiTimingRecord {
  const duration = Math.max(0, Math.round(Number(durationMs) || 0));
  return {
    event: 'api_timing',
    method: String(method || 'GET').toUpperCase(),
    route: apiTimingRoute(originalUrl),
    status: Math.max(0, Math.trunc(Number(statusCode) || 0)),
    duration_ms: duration,
    slow: duration >= 1_000,
  };
}
