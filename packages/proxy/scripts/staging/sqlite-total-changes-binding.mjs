import assert from 'node:assert/strict';

/** Test-only adapter. Measure the real SQLite operation (including triggers), never invent a count.
 * The fixture executes SQL synchronously before returning its promise. Capture the delta before
 * awaiting its acknowledgement, so concurrent promise continuations cannot contaminate the count.
 * rows_written is intentionally left alone: this harness does not model D1 index-write billing.
 */
export function sqliteTotalChangesBinding(db, transform = result => result) {
  const originals = new WeakMap();
  const total = () => Number(db.sqlite.prepare('SELECT total_changes() AS n').get().n);
  function wrap(native, sql) {
    const statement = {
      bind: (...values) => wrap(native.bind(...values), sql),
      async run() {
        const before = total(), pending = native.run(), changes = total() - before;
        const result = await pending;
        return transform({...result, meta: {...result.meta, changes}}, sql);
      },
      first: native.first.bind(native), all: native.all.bind(native), raw: native.raw.bind(native),
    };
    originals.set(statement, native);
    return statement;
  }
  return {
    prepare: sql => wrap(db.binding.prepare(sql), sql),
    batch(statements) {
      return db.binding.batch(statements.map(s => {
        const native = originals.get(s); assert.ok(native, 'Foreign total-changes statement'); return native;
      }));
    },
    exec: db.binding.exec.bind(db.binding), dump: db.binding.dump.bind(db.binding),
    withSession: db.binding.withSession.bind(db.binding),
  };
}
