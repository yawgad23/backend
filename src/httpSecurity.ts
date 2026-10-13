import type { Request } from 'express';

/**
 * HTTPS and browser-response protections shared by the Cloud Functions and
 * local Express entry point. API sessions use Firebase bearer tokens rather
 * than cookies, so every state-changing request remains independently
 * authenticated and protected from cross-site cookie replay.
 */
export function isHttpsRequest(forwardedProtocol: unknown, requestProtocol: string): boolean {
  const forwarded = String(forwardedProtocol || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https' || String(requestProtocol || '').toLowerCase() === 'https';
}

export function isProductionRuntime(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === 'production'
    || Boolean(environment.K_SERVICE)
    || Boolean(environment.FUNCTION_TARGET);
}

export function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };

  if (secure) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

export function isSensitiveApiPath(request: Pick<Request, 'path'>): boolean {
  return request.path.startsWith('/api/admin/')
    || request.path.startsWith('/api/wallet/')
    || request.path.startsWith('/api/account/')
    || request.path.startsWith('/api/driver/')
    || request.path.startsWith('/api/auth/')
    || request.path.startsWith('/api/rides/');
}
