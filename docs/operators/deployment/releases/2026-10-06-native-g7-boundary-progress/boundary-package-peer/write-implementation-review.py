import hashlib
import json
from pathlib import Path
import sys

repo = Path('C:/cinagroup/cinatoken')
package = repo / 'scripts/diagnostics/v364-owned-linux-boundary'
here = Path(__file__).parent
def digest(path):
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
manifest_path = package / 'sealed-package.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
sealed_checks = []
for item in manifest['files']:
    actual = digest(package / item['path'])
    sealed_checks.append({'relativePath': item['path'], **actual,
                          'exact': item['bytes'] == actual['bytes'] and item['sha256'] == actual['sha256']})
item = manifest['workflow']
actual = digest(repo / item['path'])
sealed_checks.append({'relativePath': item['path'], **actual,
                      'exact': item['bytes'] == actual['bytes'] and item['sha256'] == actual['sha256']})
inputs = json.loads((package / 'source-inputs.json').read_text(encoding='utf-8'))
result = {
    'schema': 'cinatoken.v364.boundary-implementation.independent-readonly-review.v1',
    'reviewActualExit': 0 if all(row['exact'] for row in sealed_checks) else 1,
    'runtimeExecuted': False,
    'runtimeAcceptanceProven': False,
    'repoWrites': 0,
    'ciRequests': 0,
    'productionRequests': 0,
    'manifest': digest(manifest_path),
    'sealedChecks': sealed_checks,
    'sourceInputReviewMetadata': {key: inputs[key] for key in ('reviewBaseHEAD', 'preparedAtHead', 'executionSHAIsSeparate')},
    'conclusion': 'NO_REMAINING_SPECIFIC_IMPLEMENTATION_BLOCKER_AFTER_READONLY_REPAIR_REVIEW',
    'reviewed': [
        'bare-async-source.mjs preserves frozen SSE first frame, HWM0, async300 KV release poll/10ms, cancel KV put then same ctx.waitUntil and await. Envelope validation is deliberately simpler and the arm remains a diagnostic variant.',
        'direct-holder.mjs imports frozen observers whose esbuild plugin resolves __ORIGINAL__ to the correct frozen gateway/holder. Its TEXT_HOLDER.fetch is only a local function mapping with the exact gateway-created Request, owned env and ctx; original Response(body) rewrap remains.',
        'createFixture registers Miniflare before readiness or binding awaits. Bare/direct have exactly OBSERVATIONS binding; binding arm has original gateway TEXT_HOLDER and holder OBSERVATIONS. Locked flags/dependencies unchanged.',
        'Explicit Node HTTP destroy/RST calibration checks exact received request body, single request, incomplete response, and client plus peer socket/response closure. RST API invocation has its own event and a dedicated agent:false connection.',
        'Each explicit cancel requires the response and socket to remain open beforehand. socketClosed is bounded even outside the response.closed conditional; an already closed response cannot be attributed as a new RST.',
        'Safe event/census wrappers record observationFailures without throwing past fixture disposal. Observation failure prevents actualExit0. Disposal API fulfillment remains separate from census completeness and from graceful workerd termination.',
        'Calibration cleanup error is retained with actualExit1 and the result is still pushed. Each fixture performs final pre-dispose KV reads as usedForPassfalse and explicit dispose-start/dispose-settled phases; active fixtures are retried in outer finally.',
        'Python owns direct child through Popen.poll/wait only. Adopted Z descendants are individually revalidated by PID,starttime,group,session,ppid and individually waited; no waitpid(-group) can consume the direct child status.',
        'Known adopted zombie disappearance/no wait status and WNOHANG0 now append cleanup_errors. No synthetic successful exit status is assigned, and unknown closure cannot satisfy outerUnforcedGroupClose.',
        'Zombie-only owned groups undergo bounded adoption/reaping rather than signals; live/unknown remnants permit necessary TERM/KILL and actual successful signal send retains leftoverGroupKilledtrue. killpg0 alone never establishes a live process.',
        'Missing, invalid JSON and wrong Node report shape are caught into fatal/rawNone; schema, exact eight IDs, caseIdstring, closedbool and baselineEligiblefalse are checked before closure evaluation. actualProcessExit uses real child.returncode and runnerOutcomeCode keeps timeout124/interrupt130 independently.',
        '360 second child wait plus initial zombie drain1s and waits10+10 and final drain5 means nominal cleanup ceiling26s, with census/preflight overhead. Diagnostic step7min is larger than nominal386s plus bounded git preflight10s; job10min. A scheduler or /proc syscall delay is not covered by a precise25second claim.',
        'Workflow is manual-only, contentsread, checkout persistcredentialsfalse, npmci with existing lock, separate concurrency cancelinprogressfalse; original strict failure naturally fails the step with no continueonerror. Artifact name binds SHA/run/attempt, alwaysupload and include-hidden-filestrue includes the exact sealed .github workflow file.',
        'reviewBaseHEAD6658 is historical preparation metadata; actual checkoutSHA is read at execution, checked against every pinned Git blob, bound through executor-start and compared against GITHUB_SHA by Python. No equality with historical review base is imposed.',
        'Original two-file baseline runs once first and its actual/raw TAP remains authoritative. All eight new comparisons remain baselineEligiblefalse, 100poll/10ms original window is immutable, 4s tail and pre-dispose snapshot cannot upgrade a failure; old artifact exit1/leftoverGroupKilledtrue is pinned and preserved.',
    ],
    'repairedFindings': [
        {'finding': 'response closed branch skipped socket wait and RST invocation attribution', 'status': 'FIX_VERIFIED_BY_SOURCE_READ'},
        {'finding': 'census/event throw could bypass Miniflare dispose in finally', 'status': 'FIX_VERIFIED_BY_SOURCE_READ'},
        {'finding': 'lost adopted descendant wait status did not reject success', 'status': 'FIX_VERIFIED_BY_SOURCE_READ'},
        {'finding': 'calibration cleanup failure dropped its negative result', 'status': 'FIX_VERIFIED_BY_SOURCE_READ'},
        {'finding': 'wrong shape valid Node JSON could prevent executor closed receipt', 'status': 'FIX_VERIFIED_BY_SOURCE_READ'},
        {'finding': 'hidden .github workflow excluded from artifact by default', 'status': 'FIX_VERIFIED_BY_SOURCE_READ'},
    ],
    'limits': [
        'This is a source/seal review, not execution of prepare-only or Linux workerd, a CI run, a causal trace, a dependency/runtime fix, or production validation.',
        'processCensus scopes one owned process group/session. It is observational, does not reap and does not prove the absence of processes that hypothetically escaped that group.',
        'The locked Miniflare Runtime.dispose destroys stdio then sends SIGKILL and awaits exit, not full close/stdio flush. API disposal and unforced outer group cleanup do not prove graceful runtime shutdown or complete late logs.',
        'A malformed activeMiniflare boolean equals zero in Python; strict integer validation would be optional additional report-shape defense. Current immutable Node producer emits the numeric Map size, so no concrete execution blocker is asserted from this.',
    ],
    'primaryReferences': [
        'https://github.com/actions/upload-artifact/blob/v4/README.md#uploading-hidden-files',
        'https://man7.org/linux/man-pages/man2/waitpid.2.html',
        'https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html',
        'https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html',
        'https://nodejs.org/download/release/latest-v22.x/docs/api/net.html#socketresetanddestroy',
    ],
}
if not all(row['exact'] for row in sealed_checks):
    result['conclusion'] = 'SOURCE_REVIEW_COMPLETE_BUT_CURRENT_MANIFEST_BYTE_MISMATCH_REQUIRES_RESEAL'
path = here / 'FINAL-new-boundary-implementation-readonly-review.json'
with path.open('x', encoding='utf-8', newline='\n') as file:
    file.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'actualExit': result['reviewActualExit'], 'checks': len(sealed_checks), 'report': digest(path)}))
sys.exit(result['reviewActualExit'])
