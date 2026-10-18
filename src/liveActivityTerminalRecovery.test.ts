import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('terminal Rider Live Activity recovery', () => {
  it('recovers an Activity token registered after a completed or cancelled ride', () => {
    const liveActivities = source('src/liveActivities.ts');
    const functions = source('src/functions.ts');

    expect(liveActivities).toContain('export function isTerminalLiveActivityStatus');
    expect(liveActivities).toContain('terminal_end_pending');
    expect(liveActivities).toContain('terminalEndPending');
    expect(functions).toContain('riderLiveActivityRegistrationRecovery');
    expect(functions).toContain("document: 'rider_live_activities/{activityId}'");
    expect(functions).toContain('retry: true');
  });

  it('periodically clears cards that were already stale before a retry trigger ran', () => {
    const liveActivities = source('src/liveActivities.ts');
    const functions = source('src/functions.ts');

    expect(liveActivities).toContain('recoverTerminalRideLiveActivities');
    expect(functions).toContain('riderLiveActivityTerminalRecovery');
    expect(functions).toContain("schedule: 'every 5 minutes'");
  });

  it('sends a retryable end for every persisted transition into a terminal ride status', () => {
    const liveActivities = source('src/liveActivities.ts');
    const functions = source('src/functions.ts');

    expect(liveActivities).toContain('export function isTerminalLiveActivityTransition');
    expect(functions).toContain('riderLiveActivityTerminalEnd');
    expect(functions).toContain("document: 'rides/{rideId}'");
    expect(functions).toContain('terminal Live Activity end delivery failed');
  });
});
