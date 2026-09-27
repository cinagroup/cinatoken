import assert from 'node:assert/strict';
import test from 'node:test';
// Import also runs the same three v296 regressions against the explicit candidate.
import { peer, deferred, tick } from './postgres-recovery-operation-owner.wire.test.mjs';

if (!process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER) throw new Error('This suite requires an explicit isolated candidate');
const settings = { timeout: 5000 };

test('active transaction still rolls back callback failure and can reuse its connection', settings, async t => {
  const p = await peer(t), failure = new Error('expected callback failure');
  await assert.rejects(p.raw.begin(async tx => { await tx.unsafe('select before_error'); throw failure; }), error => error === failure);
  await p.raw.begin(tx => tx.unsafe('select after_error'));
  assert.deepEqual(p.trace, ['begin','select before_error','rollback','begin','select after_error','commit'].map(query => ({ connectionId: 1, query })));
});

for (const outcome of ['return', 'throw', 'late-query', 'savepoint', 'prepare']) {
  test(`closed transaction ${outcome} cannot touch a reconnected transaction`, settings, async t => {
    const p = await peer(t), oldEntered = deferred(), oldGate = deferred(), oldEnded = deferred();
    const old = p.raw.begin(async tx => {
      try {
        await tx.unsafe('select old');
        if (outcome === 'prepare') tx.prepare('old_prepared');
        oldEntered.resolve(); await oldGate.promise;
        if (outcome === 'throw') throw new Error('old callback failure');
        if (outcome === 'late-query') await tx.unsafe('select forbidden_old');
        if (outcome === 'savepoint') await tx.savepoint(sp => sp.unsafe('select forbidden_savepoint'));
        return 'old result';
      } finally { oldEnded.resolve(); }
    });
    const oldRejected = assert.rejects(old, { code: 'CONNECTION_CLOSED' });
    await oldEntered.promise; p.disconnect(); await oldRejected;

    const newEntered = deferred(), newGate = deferred();
    const newer = p.raw.begin(async tx => {
      await tx.unsafe('select newer'); newEntered.resolve(); await newGate.promise;
      await tx.unsafe('select new_barrier'); return 'new result';
    });
    t.after(() => { oldGate.resolve(); newGate.resolve(); });
    await newEntered.promise;
    oldGate.resolve(); await oldEnded.promise; await tick(); await tick();
    newGate.resolve(); assert.equal(await newer, 'new result');
    await tick(); await tick();
    assert.deepEqual(p.trace, [
      { connectionId: 1, query: 'begin' }, { connectionId: 1, query: 'select old' },
      { connectionId: 2, query: 'begin' }, { connectionId: 2, query: 'select newer' },
      { connectionId: 2, query: 'select new_barrier' }, { connectionId: 2, query: 'commit' },
    ]);
    // A root operation remains admitted; the patch has not shut down the shared pool.
    await p.raw.unsafe('select root_survives');
  });
}

test('close rejects driver-local transaction queue as well as in-flight statements', settings, async t => {
  const p = await peer(t, { holdReady: true, maxPipeline: 1 }), queued = deferred(), finished = deferred();
  const transaction = p.raw.begin(async tx => {
    // max_pipeline=1 admits two statements (active + sent), then queues the third
    // in begin's own Queue, which connection.js cannot see or reject on close.
    const queries = ['select active', 'select sent', 'select queued'].map(q => tx.unsafe(q).execute());
    const observed = Promise.allSettled(queries); queued.resolve();
    const outcomes = await observed; finished.resolve(outcomes);
  });
  const rejection = assert.rejects(transaction, { code: 'CONNECTION_CLOSED' });
  await queued.promise; await p.seen('select sent');
  assert.deepEqual(p.queries.map(q => q.trim()), ['begin','select active','select sent']);
  p.disconnect(); await rejection;
  const outcomes = await finished.promise;
  assert.deepEqual(outcomes.map(x => x.status), ['rejected','rejected','rejected']);
  for (const result of outcomes) assert.equal(result.reason.code, 'CONNECTION_CLOSED');
  assert.ok(!p.queries.includes('select queued'));
  await tick(); await tick();
});

test('nested active savepoint commits normally and the enclosing scope commits once', settings, async t => {
  const p = await peer(t);
  await p.raw.begin(async tx => { await tx.savepoint(sp => sp.unsafe('select nested')); });
  assert.equal(p.queries.filter(q => q.trim() === 'commit').length, 1);
  assert.ok(p.queries.some(q => q.startsWith('savepoint')));
  assert.ok(p.queries.includes('select nested'));
});

test('close inside a paused savepoint prevents its later ROLLBACK TO and outer rollback on reuse', settings, async t => {
  const p = await peer(t), entered = deferred(), release = deferred(), ended = deferred();
  const old = p.raw.begin(tx => tx.savepoint(async sp => {
    await sp.unsafe('select nested_old'); entered.resolve(); await release.promise;
    ended.resolve(); throw new Error('old nested callback failure');
  }));
  const rejected = assert.rejects(old, { code: 'CONNECTION_CLOSED' });
  await entered.promise; p.disconnect(); await rejected;
  await p.raw.begin(async tx => {
    await tx.unsafe('select live_new'); release.resolve(); await ended.promise;
    await tick(); await tick(); await tx.unsafe('select live_barrier');
  });
  await tick(); await tick();
  assert.deepEqual(p.trace.filter(row => row.connectionId === 2).map(row => row.query),
    ['begin','select live_new','select live_barrier','commit']);
});
