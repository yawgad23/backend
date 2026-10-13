import { describe, expect, it } from 'vitest';
import {
  isHttpsRequest,
  isProductionRuntime,
  isSensitiveApiPath,
  securityHeaders,
} from './httpSecurity';

describe('HTTP transport security', () => {
  it('recognizes HTTPS from a trusted reverse-proxy protocol header', () => {
    expect(isHttpsRequest('https', 'http')).toBe(true);
    expect(isHttpsRequest('https, http', 'http')).toBe(true);
    expect(isHttpsRequest('', 'https')).toBe(true);
    expect(isHttpsRequest('http', 'http')).toBe(false);
  });

  it('requires secure transport for Cloud Run and production runtimes', () => {
    expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionRuntime({ K_SERVICE: 'api' })).toBe(true);
    expect(isProductionRuntime({ FUNCTION_TARGET: 'api' })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'test' })).toBe(false);
  });

  it('sets browser hardening headers and HSTS only over HTTPS', () => {
    const insecureHeaders = securityHeaders(false);
    const secureHeaders = securityHeaders(true);
    expect(insecureHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(insecureHeaders['X-Frame-Options']).toBe('DENY');
    expect(insecureHeaders['Strict-Transport-Security']).toBeUndefined();
    expect(secureHeaders['Strict-Transport-Security']).toContain('max-age=31536000');
  });

  it('marks authenticated and financial routes as non-cacheable', () => {
    expect(isSensitiveApiPath({ path: '/api/wallet/card-checkout' })).toBe(true);
    expect(isSensitiveApiPath({ path: '/api/admin/rides/live' })).toBe(true);
    expect(isSensitiveApiPath({ path: '/api/rides/ride-1/status' })).toBe(true);
    expect(isSensitiveApiPath({ path: '/api/health' })).toBe(false);
  });
});
