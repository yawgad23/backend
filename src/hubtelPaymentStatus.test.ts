import { describe, expect, it } from 'vitest';
import {
  hubtelPaymentState,
  isHubtelChargeInitiated,
  isHubtelStatusResponseAccepted,
  readHubtelPaymentDetails,
} from './hubtelPaymentStatus';

describe('Hubtel payment response compatibility', () => {
  it('accepts an older Direct Receive pending response', () => {
    const response = {
      ResponseCode: '0001',
      Data: { TransactionId: 'tx-legacy', ClientReference: 'ref-legacy', Status: 'Pending' },
    };

    expect(isHubtelChargeInitiated(response)).toBe(true);
    expect(hubtelPaymentState(response)).toBe('processing');
  });

  it('accepts a current Direct Receive pending response', () => {
    const response = {
      ResponseCode: '00',
      Data: { TransactionId: 'tx-current', ClientReference: 'ref-current', Status: 'Pending' },
    };

    expect(isHubtelChargeInitiated(response)).toBe(true);
    expect(isHubtelStatusResponseAccepted(response)).toBe(true);
    expect(readHubtelPaymentDetails(response)).toMatchObject({
      transactionId: 'tx-current',
      clientReference: 'ref-current',
    });
  });

  it('settles a current completed response without relying on legacy wording', () => {
    expect(hubtelPaymentState({ responseCode: '00', data: { status: 'Completed' } })).toBe('paid');
    expect(hubtelPaymentState({ ResponseCode: '0000', Data: { Status: 'Paid' } })).toBe('paid');
  });

  it('never accepts an explicit terminal provider failure', () => {
    const response = { ResponseCode: '00', Data: { Status: 'Failed', Message: 'Transaction failed' } };

    expect(hubtelPaymentState(response)).toBe('failed');
    expect(isHubtelChargeInitiated(response)).toBe(false);
  });
});
