# Unified account and admin console: production runbook

This runbook is the audited deployment boundary for the CinaToken unified Web console. The UI is based on selected layout and theme patterns from `cinatoken-go/web/default`; the CinaToken backend, CinaAuth identity boundary, authorization checks, and Cloudflare topology remain authoritative.

## Production topology

| Resource | Responsibility | Public exposure |
| --- | --- | --- |
| Admin Worker | Public home, ordinary-user account center, administrator console, CinaAuth callback, Queue producer | `https://cinatoken.com` |
| Proxy Worker | AI gateway and usage accounting | `https://api.cinatoken.com` |
| Chain Worker | Queue consumer and the only runtime holding the minter key | no route and no `workers.dev` |
| D1 | Identity mapping, sessions, encrypted shared keys, integer portal ledger, signed-transaction outbox | bindings only |
| Queue + DLQ | At-least-once chain jobs and exhausted retries | bindings only |

The ordinary user and administrator use one `cinatoken_session` cookie. A normal session gets account capabilities only. `admin.console` is added only after a live CinaAuth administrator-role check. `/dashboard`, `/admin/*`, and legacy `/gateway/*` redirect an authenticated non-admin user to `/account`.

## Security and accounting invariants

- Cookie-authenticated mutations require an exact same-origin `Origin` and reject cross-site fetch metadata. Admin bearer API clients remain supported.
- Shared provider keys use AES-GCM envelopes with row-bound additional authenticated data. `SHARED_KEY_ENCRYPTION_SECRET` must be the same on Admin and Proxy and must be backed up before rotation.
- Wallet binding uses a signed EIP-4361 challenge bound to user, origin, chain, nonce, issue time, and expiry. Direct unsigned wallet binding is disabled.
- D1 uses integer micro-units as the canonical portal balance. Earning insert and credit are one idempotent database operation; withdrawal creation and balance lock are atomic.
- The Chain Worker signs a transaction, stores the raw signed transaction and deterministic hash in D1, then broadcasts. Queue retries rebroadcast that exact transaction. Queue concurrency and batch size remain `1` to preserve EOA nonce ordering.
- No signing key exists in the Admin or Proxy Worker. Logs contain job IDs and transaction hashes, never secrets or raw signed transactions.

## Required resource variables

Store these as Cloudflare Build variables or in a gitignored instance env file:

```text
PROXY_WORKER_NAME=cinatoken-proxy
ADMIN_WORKER_NAME=cinatoken-admin
CHAIN_WORKER_NAME=cinatoken-chain-worker
CHAIN_JOB_QUEUE_NAME=cinatoken-chain-jobs
CHAIN_JOB_DLQ_NAME=cinatoken-chain-jobs-dlq
D1_DATABASE_NAME=cinatoken
D1_DATABASE_ID=<uuid>
D1_MIGRATIONS_WORKER_NAME=cinatoken-d1-migrations
CINACHAIN_CHAIN_ID=84532
# Only set these while creating new Wrangler-managed Custom Domains:
# PROXY_CUSTOM_DOMAIN=api.cinatoken.com
# ADMIN_CUSTOM_DOMAIN=cinatoken.com
```

The current production hostnames are already bound through Cloudflare Dashboard/existing
proxied DNS, so leave both custom-domain variables unset during routine deploys. Setting
them instructs Wrangler to create or replace Custom Domain DNS records and will fail closed
when an externally managed record already exists.

Use chain ID `84532` only for Base Sepolia. A mainnet launch requires reviewed mainnet contracts, an explicit mainnet chain ID, funded signer operations, monitoring, and a separate staging rehearsal. Never silently reuse testnet contract addresses on mainnet.

## Required Worker secrets

| Worker | Secrets |
| --- | --- |
| Proxy | `SHARED_KEY_ENCRYPTION_SECRET` |
| Admin | `CINATOKEN_OIDC_CLIENT_SECRET`, `CINATOKEN_OIDC_BRIDGE_SECRET`, `CINATOKEN_OIDC_TRANSACTION_SECRET`, `SHARED_KEY_ENCRYPTION_SECRET` |
| Chain | `CINACHAIN_RPC_URL`, `CINACHAIN_MINTER_PRIVATE_KEY`, `CINABADGE_CONTRACT_ADDRESS`, `CINACREDIT_CONTRACT_ADDRESS` |

Use `wrangler secret put` or a secret manager integration. Do not place these values in `cloudflare-worker/*.env`, command-line arguments, GitHub Actions logs, or tracked files. The deployment CLI checks secret names before it deploys; it never reads their values.

## Migration preflight

Before provisioning the Queue consumer, prove that both configured contracts contain bytecode,
use the intended chain, and are owned by the Chain Worker signer. The private key is read only
from the process environment and is never accepted as a command-line argument:

```bash
npm run preflight:chain -- \
  --env-file <public-chain-env> \
  --deployment <deployment-json> \
  --require-private-key
```

1. Export or snapshot D1 using the existing operations procedure.
2. Confirm no user already has more than one active withdrawal before migration `0029` adds its partial unique index:

   ```sql
   SELECT user_id, COUNT(*) AS active_count
   FROM withdrawals
   WHERE status IN ('requested', 'processing', 'submitted')
   GROUP BY user_id
   HAVING COUNT(*) > 1;
   ```

3. Resolve every returned row through an audited refund or settlement decision. Do not delete financial rows to make the index pass.
4. Run `npm run test:d1-portal-ledger`; it applies the complete migration chain to SQLite and validates earning idempotency, integer balance locking, duplicate-active rejection, settlement, and immutable ledger entries.

## Staged release

Use a separate staging prefix, D1, Queue, DLQ, signer, and contracts first.

```powershell
npm run bootstrap:cloudflare -- --instance staging --prefix cinatoken-staging --skip-secret
# Provision the listed Worker secrets without persisting them locally.
npm run deploy:cloudflare -- staging --migrate
```

For an existing production instance:

```powershell
npm run deploy:cloudflare -- production --migrate
```

The command ensures both Queues exist, verifies required secret names, applies migrations, then deploys Proxy, Chain, and Admin. Proxy goes first to minimize the mixed-version accounting window after migration `0029`; Admin remains last so its Queue producer is never deployed before the consumer and outbox schema exist.

For a Worker that does not exist yet, first-time bootstrap deploys an inactive shell with no `workers.dev` or custom-domain route. The shell returns 503 if invoked internally and exists only so Wrangler can accept secrets through standard input. All required Worker secrets are provisioned before D1 migrations; the normal deploy then replaces the shell.

## Acceptance gates

- `npm run test:unit`, all workspace typechecks, Admin production build, and Worker dry-run builds pass.
- Ordinary CinaAuth user: `/account` works; `/dashboard` and `/admin/*` redirect to `/account`; no admin API succeeds.
- Administrator: the same account center works and the operator-console switch opens `/admin/*` after live role verification.
- Cross-origin cookie POST is rejected; same-origin POST succeeds; admin bearer API behavior remains compatible.
- Wallet challenge rejects wrong origin, wrong user, expiry, tampering, and replay.
- Duplicate earning request does not double-credit. Two concurrent active withdrawals cannot be created.
- Queue retry uses one stored transaction hash. A reverted receipt refunds once; a confirmed receipt settles once.
- Desktop and mobile layouts, keyboard focus, all four locales, light/dark/system modes, and the visible New API attribution pass rendered review.

## Rollback and incident response

- Worker code can roll back through Cloudflare deployment history. Database migrations `0029` and `0030` are additive and are not rolled back destructively.
- Before code rollback, pause Queue delivery. A pre-migration Worker must not process rows created by the new state machine.
- Preserve `portal_ledger_entries`, withdrawals, earnings, and `chain_job_transactions` for reconciliation. Never purge the Queue or DLQ during an unresolved financial incident.
- If the signer may be compromised, pause delivery, revoke the contract minter role, rotate the signer, then audit every outbox hash before resuming.
- If `SHARED_KEY_ENCRYPTION_SECRET` is lost, encrypted shared keys are unrecoverable; disable the affected pool and have sellers re-enroll keys.

The public attribution and `NOTICE.frontend` are release requirements, not optional branding elements.
