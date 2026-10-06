// Review-only, isolated PG18.6 proof of selected shared-key log event coverage.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const economic = 'cinatoken_economic_outbox';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `selected-event-v351-${label}` } });
}

async function activate(sql, body, setting) {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL cinatoken.${setting} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}

async function insertObject(sql, table, row) {
  const columns = Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES (
    ${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
}

async function insertLog(sql, id, providerKeyId) {
  await sql.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,provider_key_id,
      charged_cost,budget_charged_micros,input_tokens,output_tokens,
      cache_read_tokens,cache_write_tokens)
    VALUES ($1,'selected-buyer','selected-api-key','selected-workspace',$2,
      0.010000,10000,10,5,0,0)`, [id, providerKeyId]);
}

function event(id) {
  return { event_id: id, request_log_id: id,
    event_type: 'shared_key_usage_settled', event_version: 1,
    buyer_user_id: 'selected-buyer', buyer_api_key_id: 'selected-api-key',
    workspace_id: 'selected-workspace', buyer_charge_basis: 'actual',
    buyer_usage_certainty: 'actual', buyer_charged_cost: '0.010000',
    buyer_budget_charged_micros: 10000, buyer_input_tokens: 10,
    buyer_output_tokens: 5, buyer_cache_read_tokens: 0,
    buyer_cache_write_tokens: 0, attempt_count: 1,
    event_certainty: 'confirmed' };
}

function outcome(id, claim) {
  return { event_id: id, request_log_id: id, attempt_id: claim.attempt_id,
    attempt_index: claim.attempt_index, shared_key_id: claim.shared_key_id,
    transition_id: claim.transition_id, quote_version_id: claim.quote_version_id,
    usage_certainty: 'actual', input_tokens: 10, output_tokens: 5,
    cache_read_tokens: 0, cache_write_tokens: 0,
    provider_cost_certainty: 'actual', provider_cost_micros: 2000,
    evidence_kind: 'provider_usage', evidence_sha256: 'a'.repeat(64),
    observed_at: new Date().toISOString() };
}

async function expectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    assert.equal(error?.code, code, String(error));
    if (constraint) assert.equal(error?.constraint_name, constraint, String(error));
    return true;
  });
}

test('selected shared-key logs require a same-commit typed economic event',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-selected-event-v351-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; formal PG73 and v339 quote/attempt/outbox proposals plus review-only v351 gate',
      limitations: [
        'The fixture uses a trusted migrator to write the successful typed event; a real buyer LOGIN and Worker/Hyperdrive path are not exercised.',
        'The gate can inspect only the final provider_key_id. Earlier shared-key attempts with a non-shared final key continue to rely on the v339 quote-attempt enrollment gate and pre-send claim protocol.',
        'The selected id must occur in an immutable event attempt, but this gate does not prove it is the last attempted route; route outcome semantics remain application-owned.',
        'Production cutover, formal migration, historical rows, D1/MySQL, Linux CI and payout/consumer behavior are not exercised.'
      ] };
    const stage = (name, detail = {}) =>
      report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const claimPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN
          PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN
          PASSWORD '${claimPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster,'cinatoken_gateway_migrator',
        migratorPassword,'migrator');
      const runtime = client(cluster,'cinatoken_gateway_runtime',
        runtimePassword,'runtime');
      const claimant = client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',
        claimPassword,'claimant');
      clients.push(migrator,runtime,claimant);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(names.length,73);
      const formalCorpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name,migrations),'utf8');
        formalCorpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`,[name]);
        });
      }
      report.sourceSha256.formalMigrations = hash(formalCorpus.join('\n'));
      stage('formal-pg73-installed');

      const quoteSql = await readFile(new URL('shared-key-quote-versions.sql',proposals),'utf8');
      const dispatchSql = await readFile(new URL('shared-key-dispatch-quote-attempts.sql',proposals),'utf8');
      const outboxSql = await readFile(new URL('shared-key-economic-outbox.sql',proposals),'utf8');
      const gateSql = await readFile(new URL('shared-key-selected-event-gate-v351.sql',proposals),'utf8');
      report.sourceSha256.quoteProposal = hash(quoteSql);
      report.sourceSha256.dispatchProposal = hash(dispatchSql);
      report.sourceSha256.outboxProposal = hash(outboxSql);
      report.sourceSha256.gateProposal = hash(gateSql);
      report.sourceSha256.fixture = hash(await readFile(new URL(import.meta.url)));
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(quoteSql).simple();
      });
      await activate(migrator,dispatchSql,'shared_quote_attempt_activation');
      await activate(migrator,outboxSql,'shared_key_economic_outbox_activation');
      stage('v339-quote-attempt-and-economic-outbox-installed');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('selected-seller','selected-seller@example.invalid'),
          ('selected-buyer','selected-buyer@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('selected-workspace','personal','selected-buyer','Default','default',
            true,'personal:selected-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('selected-api-key','synthetic-api-key','selected-buyer',
            'selected-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('selected-key','selected-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');
        INSERT INTO ${gateway}.user_earnings(user_id) VALUES ('selected-seller');`).simple();
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,{
        version_id:'selected-q1', shared_key_id:'selected-key',
        seller_user_id:'selected-seller', input_price_per_million:'1.250000',
        output_price_per_million:'2.500000', cache_read_price_per_million:'0.100000',
        cache_write_price_per_million:'0.200000', commission_rate:'0.100000',
        currency:'USD', price_unit:'per_million_tokens',
        billing_mode:'shared_seller_key', entitlement_version:'synthetic-entitlement-v1',
      });
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('selected-t1','selected-key',NULL,'activate','selected-q1',
          'selected-seller')`);
      const claim = async id => (await claimant.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,1,
          'selected-key','synthetic-target')`,[randomUUID(),id]))[0];
      stage('synthetic-buyer-seller-and-immutable-quote-ready');

      await insertLog(migrator,'pre-gate-legacy','sharedkey:selected-key');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${economic}.shared_key_economic_events WHERE request_log_id='pre-gate-legacy'`))[0].n,0);
      stage('pre-gate-v339-allows-unquoted-selected-shared-log-without-event');

      await assert.rejects(migrator.begin(tx => tx.unsafe(gateSql).simple()),
        /Selected shared-key event gate activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regprocedure(
        '${economic}.require_selected_shared_key_event_v351()') IS NULL AS absent`))[0]
        .absent,true);
      stage('v351-default-off-activation-is-atomic');

      await migrator.unsafe(`GRANT SELECT ON ${economic}.shared_key_economic_events
        TO cinatoken_gateway_runtime`);
      await assert.rejects(activate(migrator,gateSql,
        'shared_key_selected_event_gate_activation'),
      /Selected shared-key event gate activation or dependency differs/u);
      await migrator.unsafe(`REVOKE SELECT ON ${economic}.shared_key_economic_events
        FROM cinatoken_gateway_runtime`);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`ALTER TABLE ${gateway}.api_key_request_logs DISABLE TRIGGER
          api_key_request_logs_require_shared_key_economic_event`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_selected_event_gate_activation = 'reviewed-v1'");
        await tx.unsafe(gateSql).simple();
      }), /Selected shared-key event gate activation or dependency differs/u);
      assert.equal((await migrator.unsafe(`SELECT tgenabled FROM pg_catalog.pg_trigger
        WHERE tgrelid='${gateway}.api_key_request_logs'::pg_catalog.regclass
          AND tgname='api_key_request_logs_require_shared_key_economic_event'`))[0]
        .tgenabled,'O');
      stage('acl-and-v339-trigger-drift-refuse-install-without-persistent-change');

      await activate(migrator,gateSql,'shared_key_selected_event_gate_activation');
      const [catalog] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM pg_catalog.pg_trigger
          WHERE tgrelid='${gateway}.api_key_request_logs'::pg_catalog.regclass
            AND tgname IN ('api_key_request_logs_selected_event_v351',
              'api_key_request_logs_provider_key_immutable_v351')
            AND tgenabled='O') AS triggers,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${economic}.require_selected_shared_key_event_v351()','EXECUTE') AS can_call_gate,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${economic}.shared_key_economic_events','INSERT') AS can_insert_event`);
      assert.deepEqual(catalog,{triggers:2,can_call_gate:false,can_insert_event:false});
      stage('v351-gate-installed-without-runtime-economic-grants',{catalog});

      await expectCode(migrator.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=budget_spent+0.01
          WHERE id='selected-buyer'`);
        await insertLog(tx,'legacy-after-gate','sharedkey:selected-key');
        await tx.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,
            gross_amount,platform_fee,net_amount)
          VALUES ('legacy-after-gate-pay','legacy-after-gate','selected-key',
            'selected-seller',0.010000,0.001000,0.009000)`);
      }),'23514','shared_key_selected_event_required_v351');
      const [rolledBack] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${gateway}.api_key_request_logs
          WHERE id='legacy-after-gate') AS logs,
        (SELECT count(*)::int FROM ${gateway}.shared_key_earnings
          WHERE id='legacy-after-gate-pay') AS earnings,
        (SELECT budget_spent::text FROM ${gateway}.users
          WHERE id='selected-buyer') AS spent`);
      assert.deepEqual(rolledBack,{logs:0,earnings:0,spent:'0.000000'});
      stage('legacy-unquoted-selected-shared-log-rolls-back-log-budget-and-payout');

      await insertLog(migrator,'ordinary-log','provider-key:ordinary');
      await migrator.unsafe(`UPDATE ${gateway}.api_key_request_logs
        SET status='success' WHERE id='ordinary-log'`);
      await expectCode(migrator.unsafe(`UPDATE ${gateway}.api_key_request_logs
        SET provider_key_id='sharedkey:selected-key' WHERE id='ordinary-log'`),
      '23514','shared_key_provider_key_immutable_v351');
      assert.equal((await migrator.unsafe(`SELECT provider_key_id FROM
        ${gateway}.api_key_request_logs WHERE id='ordinary-log'`))[0]
        .provider_key_id,'provider-key:ordinary');
      stage('ordinary-provider-log-works-and-provider-key-cannot-be-retrofitted');

      await claim('quoted-missing-event');
      await expectCode(migrator.begin(async tx => {
        await insertLog(tx,'quoted-missing-event','provider-key:ordinary');
      }),'23514','shared_key_economic_event_required');
      stage('v339-quote-attempt-coverage-remains-active-for-nonshared-final-key');

      const goodClaim = await claim('quoted-selected-success');
      await migrator.begin(async tx => {
        await insertLog(tx,'quoted-selected-success','sharedkey:selected-key');
        await insertObject(tx,`${economic}.shared_key_economic_events`,
          event('quoted-selected-success'));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('quoted-selected-success',goodClaim));
      });
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${economic}.shared_key_economic_events
        WHERE request_log_id='quoted-selected-success'`))[0].n,1);
      stage('quoted-selected-log-and-typed-event-commit-together');

      const wrongClaim = await claim('selected-mismatch');
      await expectCode(migrator.begin(async tx => {
        await insertLog(tx,'selected-mismatch','sharedkey:wrong-key');
        await insertObject(tx,`${economic}.shared_key_economic_events`,
          event('selected-mismatch'));
        await insertObject(tx,`${economic}.shared_key_economic_event_attempts`,
          outcome('selected-mismatch',wrongClaim));
      }),'23514','shared_key_selected_attempt_mismatch_v351');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${gateway}.api_key_request_logs WHERE id='selected-mismatch'`))[0].n,0);
      stage('selected-key-must-occur-in-typed-attempt-facts');

      await expectCode(migrator.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,
          gross_amount,platform_fee,net_amount)
        VALUES ('selected-double-pay','quoted-selected-success','selected-key',
          'selected-seller',0.010000,0.001000,0.009000)`),
      '23514','shared_key_economic_legacy_double_pay');
      assert.equal((await migrator.unsafe(`SELECT balance_micros::text AS n FROM
        ${gateway}.user_earnings WHERE user_id='selected-seller'`))[0].n,'0');
      stage('v339-legacy-double-pay-guard-remains-active');

      await migrator.unsafe(`GRANT USAGE ON SCHEMA ${gateway}
        TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${gateway}.api_keys
        TO cinatoken_gateway_runtime;
        GRANT INSERT ON ${gateway}.api_key_request_logs
        TO cinatoken_gateway_runtime;`).simple();
      await expectCode(insertLog(runtime,'runtime-bypass','sharedkey:selected-key'),
      '23514','shared_key_selected_event_required_v351');
      await expectCode(runtime.unsafe(`ALTER TABLE ${gateway}.api_key_request_logs
        DISABLE TRIGGER api_key_request_logs_selected_event_v351`),'42501');
      await expectCode(runtime.unsafe(`INSERT INTO ${economic}.shared_key_economic_events
        (event_id,request_log_id) VALUES ('runtime-bypass','runtime-bypass')`),'42501');
      await migrator.unsafe(`REVOKE INSERT ON ${gateway}.api_key_request_logs
        FROM cinatoken_gateway_runtime;
        REVOKE SELECT ON ${gateway}.api_keys
        FROM cinatoken_gateway_runtime;`).simple();
      stage('direct-runtime-sql-cannot-bypass-gate-or-write-private-event');

      report.status='PASS';
    } catch (error) {
      failure=error;
      report.status='FAIL';
      report.failure={code:error?.code??null,
        constraint:error?.constraint_name??null,
        message:String(error?.stack??error).slice(0,4000)};
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({timeout:1})));
      try { await cluster.cleanup(); report.cleanup='PASS'; }
      catch (error) { report.cleanup='FAIL';
        report.cleanupError=String(error?.stack??error).slice(0,1500);
        failure ??= error; }
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      process.stdout.write(`selected-event-v351-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
