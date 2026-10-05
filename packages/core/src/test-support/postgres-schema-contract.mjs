import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq, getTableColumns, is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';

// Test-only baseline selection; application imports never consult this variable.
const baseline = process.env.GATEWAY_PG_SCHEMA_BASELINE_DIR;
const schema = await import(baseline
  ? pathToFileURL(resolve(baseline, 'schema.pg.ts')).href
  : new URL('../storage/drizzle/schema.pg.ts', import.meta.url).href);
const budget = await import(baseline
  ? pathToFileURL(resolve(baseline, 'user-budget.mjs')).href
  : new URL('../db/postgres/user-budget-reservations.impl.ts', import.meta.url).href);

export const createBudgetRepository = budget.createPostgresUserBudgetReservationsRepository;
export const gatewayTables = Object.entries(schema).filter(([, value]) => is(value, PgTable));
export const database = drizzle.mock({ schema: schema.pgCoreSchema });
export const identifier = value => '"' + value.replaceAll('"', '""') + '"';

export function tableQueries(table) {
  const config = getTableConfig(table);
  const [property, column] = Object.entries(getTableColumns(table))[0];
  const values = column.dataType === 'number'
    ? { inserted: 1, gateway: 2, updated: 3, shadow: 4 }
    : { inserted: 'inserted', gateway: 'gateway', updated: 'updated', shadow: 'shadow' };
  return {
    config, property, column, values,
    select: database.select({ value: column }).from(table).toSQL(),
    insert: database.insert(table).values({ [property]: values.inserted }).returning({ value: column }).toSQL(),
    update: database.update(table).set({ [property]: values.updated }).where(eq(column, values.gateway)).returning({ value: column }).toSQL(),
    delete: database.delete(table).where(eq(column, values.updated)).returning({ value: column }).toSQL(),
    embedded: database.select({ count: sql`count(*)` }).from(table).toSQL(),
  };
}
