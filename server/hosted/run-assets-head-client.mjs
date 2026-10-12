/** Compare A's atomic ledger heads with both independently persisted consumer
 * cursors on every data lease continuation, including the initial admission. */
import { accountError } from '../account/client.mjs';

const fail = () => { throw accountError(503, 'asset-run-head-pending'); };

export function createRunAssetHeadClient({ client, humanConsumer, runConsumer } = {}) {
  if (typeof client?.openLease !== 'function' || !humanConsumer || !runConsumer) fail();
  return Object.freeze({
    openLease(input) {
      const channel = client.openLease(input);
      return {
        async check() {
          const result = await channel.check();
          if (result?.allowed !== true || humanConsumer.ready !== true || runConsumer.ready !== true ||
              !Number.isSafeInteger(result.accessHead) || !Number.isSafeInteger(result.runAssetHead) ||
              result.accessHead !== humanConsumer.cursor || result.runAssetHead !== runConsumer.cursor) fail();
          return result;
        },
        closeLease: receipt => channel.closeLease(receipt),
        get leaseId() { return channel.leaseId; },
        get lost() { return channel.lost; },
        close: () => channel.close(),
      };
    },
  });
}
