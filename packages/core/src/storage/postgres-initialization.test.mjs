import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { inspect } from 'node:util';
import { withUnpublishedPostgresClient, postgresInitializationCleanup } from './postgres-initialization.ts';
import { isTransientPostgresConnectionError } from './postgres-connection-error.ts';

for (const stage of ['session', 'repositories', 'worker_decoration']) {
  for (const failure of ['throw', 'reject']) for (const close of ['resolve', 'reject', 'throw']) {
    test(`unpublished PG ${stage}/${failure}/${close}`, async () => {
      const entered = Promise.withResolvers(), ack = Promise.withResolvers(); let ends = 0, initializations = 0, finished = false;
      const client = { end(options) {
        ends++; assert.deepEqual(options, { timeout: 1 }); entered.resolve();
        if (close === 'throw') throw Error('PRIVATE_CLOSE'); return ack.promise;
      } };
      const pending = withUnpublishedPostgresClient(client, stage, () => {
        initializations++; if (failure === 'throw') throw Error('PRIVATE_DSN'); return Promise.reject(Error('PRIVATE_SQL'));
      }).catch(error => { finished = true; return error; });
      await entered.promise;
      if (close !== 'throw') {
        await tick(); assert.equal(finished, false, 'initialization does not abandon client closure');
        if (close === 'resolve') ack.resolve(); else ack.reject(Error('PRIVATE_CLOSE'));
      }
      const error = await pending;
      assert.equal(error.name, 'PostgresInitializationError'); assert.equal(error.stage, stage);
      assert.equal(postgresInitializationCleanup(error), close === 'resolve' ? 'confirmed' : 'unconfirmed');
      assert.doesNotMatch(inspect(error) + JSON.stringify(error), /PRIVATE/);
      assert.equal(initializations, 1); assert.equal(ends, 1);
    });
  }
  test(`unpublished PG ${stage} success transfers ownership`, async () => {
    let ends = 0; const value = { ok: true };
    assert.equal(await withUnpublishedPostgresClient({ end: async () => { ends++; } }, stage, async () => value), value);
    assert.equal(ends, 0);
  });
}
test('arbitrary resolver errors and lookalike objects never confirm cleanup', () => {
  for (const value of [null, undefined, Error('unknown'), { name: 'PostgresInitializationError', cleanup: 'confirmed' }, 'confirmed']) {
    assert.equal(postgresInitializationCleanup(value), null);
  }
});

for (const code of ['CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'CONNECTION_ENDED', '23505', 'nested']) {
  test(`initialization keeps only the safe connection error category: ${code}`, async () => {
    const error = code === 'nested' ? { cause: { code: 'CONNECTION_ENDED', message: 'PRIVATE_HOST' } } : Object.assign(Error('PRIVATE_DSN'), { code });
    await assert.rejects(withUnpublishedPostgresClient({ end: async () => {} }, 'session', async () => { throw error; }), wrapped => {
      assert.equal(isTransientPostgresConnectionError(wrapped), code !== '23505');
      assert.doesNotMatch(inspect(wrapped) + JSON.stringify(wrapped), /PRIVATE/);
      assert.equal(postgresInitializationCleanup(wrapped), 'confirmed'); return true;
    });
  });
}
test('hostile error inspection cannot skip client close', async () => {
  let closed = false;
  await assert.rejects(withUnpublishedPostgresClient({ end: async () => { closed = true; } }, 'session', () => {
    throw { get code() { throw Error('PRIVATE_GETTER'); } };
  }), error => {
    assert.equal(closed, true); assert.equal(postgresInitializationCleanup(error), 'confirmed');
    assert.equal(isTransientPostgresConnectionError(error), false); return true;
  });
});
