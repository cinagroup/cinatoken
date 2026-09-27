import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISPATCH_PRODUCER_ROLE, FACT_PRODUCER_ROLE,
  PRODUCER_LOGIN_ACTIVATION, provisionPostgresProducerLogins,
} from './provision-postgres-producer-logins';

test('producer login identities and activation are explicit', () => {
  assert.equal(DISPATCH_PRODUCER_ROLE, 'cinatoken_gateway_dispatch_producer');
  assert.equal(FACT_PRODUCER_ROLE, 'cinatoken_gateway_fact_producer');
  assert.equal(PRODUCER_LOGIN_ACTIVATION, 'reviewed-direct-login-v1');
});

test('producer login provisioning never falls back to ambient DATABASE_URL', async () => {
  await assert.rejects(
    provisionPostgresProducerLogins({
      DATABASE_URL: 'postgres://ambient:secret@127.0.0.1:1/wrong',
    }),
    /Explicit reviewed-direct-login-v1/,
  );
  await assert.rejects(
    provisionPostgresProducerLogins({
      CINATOKEN_GATEWAY_PRODUCER_ACTIVATION: PRODUCER_LOGIN_ACTIVATION,
      DATABASE_URL: 'postgres://ambient:secret@127.0.0.1:1/wrong',
    }),
    /PRODUCER_ADMIN_URL is required; DATABASE_URL is not used/,
  );
});

test('producer login provisioning rejects shared, short and invalid passwords before connecting', async () => {
  const common = {
    CINATOKEN_GATEWAY_PRODUCER_ACTIVATION: PRODUCER_LOGIN_ACTIVATION,
    CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL: 'postgres://admin:secret@127.0.0.1:1/postgres',
  };
  await assert.rejects(provisionPostgresProducerLogins({
    ...common,
    CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD: 'short',
    CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD: 'a'.repeat(24),
  }), /at least 24 characters/);
  await assert.rejects(provisionPostgresProducerLogins({
    ...common,
    CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD: 'a'.repeat(24),
    CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD: 'a'.repeat(24),
  }), /passwords must differ/);
  await assert.rejects(provisionPostgresProducerLogins({
    ...common,
    CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD: 'a'.repeat(24),
    CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD: 'b'.repeat(24),
    CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS: 'yes',
  }), /must be true or false/);
  await assert.rejects(provisionPostgresProducerLogins({
    ...common,
    CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL: 'postgres://admin:secret@database.example.invalid/postgres',
    CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD: 'a'.repeat(24),
    CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD: 'b'.repeat(24),
  }), /loopback PostgreSQL only/);
});
