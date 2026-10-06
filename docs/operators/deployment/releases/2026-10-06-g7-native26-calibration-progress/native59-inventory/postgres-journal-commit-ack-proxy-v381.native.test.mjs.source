import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startNativePostgres } from './postgres-native-cluster.mjs';
import { startJournalCommitAckDropProxyV381 } from './postgres-journal-commit-ack-proxy-v381.mjs';

test('v381 wire proxy drops a real COMMIT response after the backend commits',
  { timeout: 120_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    let proxy;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      await cluster.admin.unsafe(`CREATE TABLE public.v381_commit_marker (
        intent_id uuid PRIMARY KEY)`);
      proxy = await startJournalCommitAckDropProxyV381({
        upstreamHost: '127.0.0.1', upstreamPort: cluster.port,
      });
      const writer = cluster.client('v381-proxied-writer', {
        throughPort: proxy.port, prepare: false,
      });
      const intentId = randomUUID();
      const writerError = writer.begin(async tx => {
        await tx.unsafe(`INSERT INTO public.v381_commit_marker(intent_id)
          VALUES($1::uuid)`, [intentId]);
      }).then(() => null, error => error);

      await proxy.waitForDrop();
      assert.ok(await writerError instanceof Error,
        'the client must lose its actual COMMIT completion');
      assert.equal(proxy.facts.connections, 1);
      assert.equal(proxy.facts.commitCommands, 1);
      assert.ok(['extended', 'simple'].includes(proxy.facts.commitProtocol));
      assert.equal(proxy.facts.backendCommitCompletes, 1);
      assert.equal(proxy.facts.droppedCommitAcks, 1);

      // This connection never traverses the proxy. It observes the durable
      // result after the writer lost its PostgreSQL CommandComplete(COMMIT).
      const reader = cluster.client('v381-independent-reader');
      const [visible] = await reader.unsafe(`SELECT count(*)::int AS n
        FROM public.v381_commit_marker WHERE intent_id=$1::uuid`, [intentId]);
      assert.equal(visible.n, 1);
    } finally {
      try { await proxy?.close(); } finally { await cluster.cleanup(); }
    }
  });
