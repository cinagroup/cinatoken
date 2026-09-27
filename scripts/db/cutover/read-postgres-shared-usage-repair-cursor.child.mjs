// Local native-fixture helper. Credentials arrive through stdin, never argv.
import postgres from 'postgres';
import { readPostgresSharedUsageRepairDurableCursor } from './build-postgres-shared-usage-repair-durable-cursor.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { port, password } = JSON.parse(input);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535
  || typeof password !== 'string' || !/^[a-f0-9]{48}$/.test(password)) {
  throw new Error('Invalid owned loopback cursor fixture connection');
}
const sql = postgres({ host: '127.0.0.1', port, database: 'postgres',
  username: 'cinatoken_gateway_migrator', password, ssl: false,
  max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
  idle_timeout: 0, max_lifetime: 0, backoff: 0, onnotice() {} });
try {
  const cursor = await readPostgresSharedUsageRepairDurableCursor(sql);
  process.stdout.write(JSON.stringify({ pid: process.pid, cursor }) + '\n');
} finally {
  await sql.end({ timeout: 1 });
}
