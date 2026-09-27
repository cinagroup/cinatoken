import assert from 'node:assert/strict';
import test from 'node:test';
import { insertRequestUsageAndChargeTx } from './critical-write-paths.ts';

test('shared critical writer rejects economic outbox on D1 and MySQL before touching either client',
  async () => {
    for (const driver of ['d1', 'mysql']) {
      let touched = 0;
      const client = new Proxy({ driver }, {
        get(target, property) {
          if (property === 'driver') return driver;
          touched += 1;
          throw new Error(`Unexpected ${driver} client access: ${String(property)}`);
        },
      });
      await assert.rejects(insertRequestUsageAndChargeTx(client, {
        economicOutbox: { buyerChargeBasis: 'actual',
          buyerUsageCertainty: 'actual', attempts: [] },
      }), /Shared-key economic outbox requires PostgreSQL/u);
      assert.equal(touched, 0, `${driver} must not be accessed before rejection`);
    }
  });
