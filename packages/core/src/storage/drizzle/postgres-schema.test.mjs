import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, alias } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { database, gatewayTables, identifier, tableQueries } from '../../test-support/postgres-schema-contract.mjs';

test('inventory includes every exported PostgreSQL table, not only pgCoreSchema entries', () => {
  assert.equal(gatewayTables.length, 46);
  const names = gatewayTables.map(([, table]) => getTableConfig(table).name);
  assert.equal(new Set(names).size, 46);
  for (const name of ['workspace_budgets', 'provider_attempt_availability', 'route_pool_sticky_bindings']) {
    assert.ok(names.includes(name));
  }
});

for (const [name, table] of gatewayTables) {
  test(`${name}: CRUD and foreign keys explicitly identify the gateway schema`, () => {
    const queries = tableQueries(table);
    assert.equal(queries.config.schema, 'cinatoken_gateway');
    const qualified = '"cinatoken_gateway".' + identifier(queries.config.name);
    for (const kind of ['select', 'insert', 'update', 'delete', 'embedded']) {
      assert.ok(queries[kind].sql.includes(qualified), `${kind} must qualify the table`);
      assert.doesNotMatch(queries[kind].sql, /\bSET\s+search_path\b/i);
    }
    assert.deepEqual(queries.update.params, ['updated', 'gateway']);
    assert.deepEqual(queries.delete.params, ['updated']);
    for (const key of queries.config.foreignKeys) {
      assert.equal(getTableConfig(key.reference().foreignTable).schema, 'cinatoken_gateway');
    }
    const other = alias(table, 'other');
    const joined = database.select({ value: queries.column }).from(table)
      .innerJoin(other, eq(queries.column, other[queries.property])).toSQL();
    assert.ok(joined.sql.includes(` from ${qualified} inner join ${qualified} "other" on `),
      'both physical table positions are qualified; column references may be qualified too');
  });
}
