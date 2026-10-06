import hashlib
import json
from pathlib import Path

repo = Path('C:/cinagroup/cinatoken')
here = Path(__file__).parent
tls = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-g7-tls-origin-review-05f0d38f8b16432581a7cbb91ff3007d')
analysis_path = repo / 'docs/operators/deployment/releases/2026-10-06-pg73-docker-progress/native-agent/FINAL-v364-linux-artifact-analysis.json'
analysis = json.loads(analysis_path.read_text(encoding='utf-8'))
paths = [analysis_path, repo / 'scripts/diagnostics/v364-owned-linux/run-v364-owned-diagnostic.mjs',
         repo / 'scripts/diagnostics/v364-owned-linux/execute-owned-linux.py',
         repo / 'scripts/diagnostics/v364-owned-linux/holder-observer.mjs',
         repo / 'scripts/diagnostics/v364-owned-linux/gateway-observer.mjs',
         repo / 'packages/proxy/scripts/staging/chat-holder-private-v364.ts',
         repo / 'packages/proxy/scripts/staging/chat-holder-gateway-v364.ts',
         repo / 'node_modules/miniflare/dist/src/index.js',
         repo / 'packages/proxy/src/routes/catalog.ts',
         repo / 'packages/proxy/src/services/catalog-discovery.ts',
         repo / 'packages/proxy/src/services/public-model-endpoints.ts',
         repo / 'packages/core/src/model-endpoint-runtime.ts',
         repo / 'packages/core/src/db/postgres/model-routing.impl.ts',
         repo / 'packages/admin/lib/public-catalog-bff.ts',
         repo / 'packages/admin/lib/public-gateway.ts',
         repo / 'packages/web/src/cinatoken/public-server/public-response.tsx',
         repo / 'scripts/db/cutover/postgres-image-http-financial.native.test.mjs',
         tls / 'future-tls-smoke.mjs', tls / 'trusted-ingress.example.conf']
def digest(path):
    raw = path.read_bytes()
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

result = {
    'schema': 'cinatoken.v364.boundary-peer.readonly-review.v1',
    'reviewActualExit': 0,
    'runtimeExecuted': False,
    'repoWrites': 0,
    'ciRequests': 0,
    'productionRequests': 0,
    'sourceFiles': [digest(path) for path in paths],
    'priorArtifact': {
        'conclusion': analysis['conclusion'],
        'strictBaseline': analysis['strictBaseline'],
        'diagnostic': analysis['diagnostic'],
        'outerClosure': analysis['outerClosure'],
        'causeProven': False,
        'oldForcedFlagPreserved': True,
    },
    'matchedNewTopologyRecommendations': {
        'eightCases': 'Two dedicated Node HTTP calibration arms destroy/RST, then bare no-binding / frozen direct-holder / frozen Service Binding each destroy/RST. Run original two-file strict suite once before these diagnostics and retain its raw failure.',
        'bare': 'Single Worker, exact first SSE frame, asynchronous 300 KV release reads with 10ms sleep, highWaterMark0, same original cancel KV put then same waitUntil promise then await. Frozen holder lines65-92 are the pattern. A synchronous source would not match.',
        'direct': 'Import original frozen gateway and original observed holder; map only env.TEXT_HOLDER.fetch to holder.fetch using the same forwarded Request, owned KV environment and same execution context. Retain gateway Request constructor/body/signal/duplex (lines9-17) and Response(body) wrap (lines26-29). Synthetic diagnostic literals in this bundle remain isolated.',
        'baselineEligibility': 'All new topology variants are diagnostic-only and cannot upgrade the strict original Service Binding baseline. Keep original flags/dependencies/source unchanged; no passthrough variant needed in this matched matrix.',
        'observations': 'Incoming/forwarded/holder signal initial+abort, original KV get/put invoke+settle, same original waitUntil register+settle; no tee, alternate cancel write, source cancellation, extra waitUntil or changed returned promise. Exact original100 reads/10ms remains the strict window. Four-second tail and final pre-dispose accepted/release/cancel read are separate observations, never success overrides.',
        'disposePhases': 'Emit explicit dispose-start before invoking dispose and dispose-settled/failed afterwards; capture each Worker log with current host phase. Pre-dispose source callback inference requires positive cancel KV invocation; zero observer events does not establish callback absence outside captured coverage.',
    },
    'nodeTransport': {
        'existingCancel': 'main lines159-166 waits response.close, which is not the actual socket-close event. Retain its original result and additionally bound client socket close and server socket close; request body exact and requestCount1, response writableFinishedfalse are calibration observations.',
        'rst': 'resetAndDestroy is the dedicated Node TCP RST API. agent:false gives a dedicated connection; record invocation once, loopback peer address, socket closure and peer error codes. destroy alone is not RST. Server hadError/ECONNRESET must not be mistaken for a packet trace.',
    },
    'miniflareClosure': {
        'installedSpawn': 'node_modules/miniflare/dist/src/index.js:95844-95853 workerd spawn has no detached option and inherits the cleaned outer environment. Debug watchdog detached=true at95876-95900 is conditional on VSCode inspector/Node bootloader variables; do not inherit those.',
        'installedDispose': 'Runtime.dispose:95923-95937 destroys stdio then sends SIGKILL and returns processExitPromise. waitForExit:95726-95729 waits exit rather than close and discards code/signal. Miniflare.dispose:114075-114109 aborts its dispose controller/poisons proxies and awaits runtime disposal.',
        'meaning': 'dispose-settled proves a completed API cleanup, not graceful workerd termination. Logs can be lost after stdio destruction, and shutdown-only signals cannot be attributed to pre-dispose client cancellation. Preserve old cooperativeNativeFinallyVerified field without broadening its claim.',
    },
    'linuxOwnedProcessRecommendations': {
        'scope': 'Python Popen start_new_session creates the owned Node process group/session. Census records only pgrp=session=child.pid members, plus explicit unknown/read-race errors. This proves group coverage, not absence of hypothetical escaped processes.',
        'statParse': 'Parse /proc/PID/stat after the last closing parenthesis delimiter; residual fields: state[0],ppid[1],pgrp[2],session[3],starttime[19]. Record PID+starttime identity. No cmdline/env collection.',
        'directChildOwnership': 'Only Popen.poll/wait may reap the direct Node child. Never waitpid(-child.pid): after a Popen wait timeout the direct child could exit and its status could be consumed by the group reaper.',
        'descendantReaping': 'Use individual waitpid(pid,WNOHANG) only for an identity-matched adopted child whose current ppid==executorPID and pid!=directChildPID. Retain actual raw wait status and decoded exit/signal. Recheck/re-census on disappear/adoption races.',
        'signals': 'Before outer signaling record census and reap bounded adopted zombies first. A zombie-only group needs bounded adoption/reaping, not TERM/KILL. Live or unknown leftovers require necessary bounded cleanup and retain forced=true; signal attempted is not proof the signal killed a live process.',
        'success': 'Require directChildReaped, final empty owned-group census/groupGone and no census/reap errors. killpg(group,0) is an existence probe, not a live-versus-zombie census. Prior artifact forced flag and four waitStatus0 records remain unchanged.',
    },
    'G7PreparedTLSNineWireCases': {
        'executed': False,
        'common': 'Owned Linux only, fixed app.test:443, SNI app.test, explicit CA/rejectUnauthorized, TLSAuthorized asserted; no TLS bypass.',
        'loginPOST': [
            {'case': 'exact HTTPS Origin without client forwarding metadata', 'status': 410, 'setCookieCount': 0},
            {'case': 'spoofed XFPhttp+XFHost attacker+Forwarded overwritten', 'status': 410, 'setCookieCount': 0},
            {'case': 'ambiguous XFPhttp,https overwritten', 'status': 410, 'setCookieCount': 0},
            {'case': 'missing Origin', 'status': 403, 'setCookieCount': 0},
            {'case': 'cross Origin', 'status': 403, 'setCookieCount': 0},
            {'case': 'same Origin but explicit cross-site', 'status': 403, 'setCookieCount': 0},
            {'case': 'unknown Host with valid app.test SNI', 'status': 421, 'setCookieCount': 0},
        ],
        'registerGET': '302, HTTPS app.test Location to /api/auth/cinaauth/login, no-store.',
        'invalidCallbackGET': '302, HTTPS app.test fallback with auth_error=invalid_transaction, zero Set-Cookie.',
        'ingress': 'Future nginx-t required. Allowlist Host/SNI, fixed Host and XFH app.test/XFPhttps/XFPort443, clear Forwarded, overwrite XFF remote_addr. Preserve Origin/Cookie and Location/separate Set-Cookie fields. Raw Web/Admin ports must remain private.',
        'limits': 'These nine cases do not execute successful OIDC/PKCE, Secure business-session cookie persistence, multi-cookie logout or actual PostgreSQL sessions. Synthetic signed identity and real authorized identity are separate gates.',
    },
    'G7ActualPGCatalogContract': {
        'proxyContract': 'app.ts:458 mounts /catalog. catalog.ts:216-227 list is object=list,data,billing_currency,generated_at;231-251 detail matches exactslug/case-insensitivevendor or404;254-264 providers is sanitizedaggregate.',
        'nonemptyRequirements': 'catalog-discovery.ts:178-180 loads real listModelsWithActiveRoutes and verified public endpoint links. Active models/routes alone are insufficient;219-220 drops rows with no verified protocol.',
        'seed': 'Create actual models, active non-shared provider with nonempty credential and configured protocol endpoint, active model_routes and route_pool with compatible model_surfaces, verified unexpired model_endpoints with operation/capabilities, and model_endpoint_routes using actual computed route/provider subject fingerprint.',
        'validation': 'public-model-endpoints.ts:321-338 active route/pool and fingerprint validity/exact recomputation;363 valid endpoint snapshot;374-384 model/provider/legacy routing metadata/operation;420-421 provider callable and matching fingerprint. model-endpoint-runtime.ts:264 requires verified status;291-293 requires verifiedAt not future and expiresAt strictly future.',
        'reference': 'postgres-image-http-financial.native.test.mjs:182-200 seeds the real tables;210-215 loads actual repository route/provider and computes computeRouteDataPolicySubjectFingerprintFromRows before the link insert;230-232 asserts snapshot/operation. This existing image fixture is a pattern, not proof for new full text topology. 0002_seed.sql contains only system_config seeds and produces no nonempty catalog.',
        'adminBFF': 'public-catalog-bff.ts:440 GET/HEAD only;455-487 anonymous GET with AcceptJSON/credentialsomit/manual redirects/exactupstream200;488-503 schema/uniqueIDs/detailmatch;536-540 public cache/nosniff. Real Proxy -> Admin -> SSR must be observed, not substituted JSON.',
        'egress': 'public-gateway.ts:3/16-30 absent or invalid CINATOKEN_PUBLIC_API_ORIGIN defaults to production api.cinatoken.com;45-56 Node without Service Binding performs actual fetch. Owned Compose must explicitly validate the controlled proxy origin and use internal-only networking before any request.',
        'ssr': 'public-response.tsx:123-145 only same-request-origin exact public catalog paths, anonymous GET/credentialsomit/manualredirect/AcceptJSON. Verify nonempty list/detail/render across four locales, plus disabled/expired/wrong-fingerprint negative, with actual PG persistence.',
    },
    'primaryReferences': [
        'https://man7.org/linux/man-pages/man2/waitpid.2.html',
        'https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html',
        'https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html',
        'https://nodejs.org/download/release/latest-v22.x/docs/api/net.html#socketresetanddestroy',
        'https://nodejs.org/download/release/latest-v22.x/docs/api/http.html',
    ],
}
path = here / 'FINAL-v364-boundary-peer-review.json'
with path.open('x', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
print(json.dumps(digest(path)))
