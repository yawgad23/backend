import { describe, expect, it } from 'vitest';
import { isTerminalDriverOfferDeclineError } from './driverRouters';

describe('stale Driver offer decline results', () => {
  it('acknowledges a lease already handed to another Driver as terminal', () => {
    expect(isTerminalDriverOfferDeclineError(new Error('This ride offer is no longer available to you.'))).toBe(true);
    expect(isTerminalDriverOfferDeclineError(new Error('This ride is no longer available to decline.'))).toBe(true);
  });

  it('keeps real server failures visible to the Driver', () => {
    expect(isTerminalDriverOfferDeclineError(new Error('Ride not found.'))).toBe(false);
    expect(isTerminalDriverOfferDeclineError(new Error('permission denied'))).toBe(false);
  });
});
