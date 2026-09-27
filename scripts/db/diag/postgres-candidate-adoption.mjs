import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildRetirementCandidates, sha256 } from './postgres-transaction-retirement.mjs';
import { buildOwnedCancellationCandidates } from './postgres-owned-cancellation.mjs';

// Frozen v307 outputs from the completed controlled-scan wire matrix. A changed
// transformation is a different candidate and must not inherit this opt-in.
const ownedScanV307Sha256 = Object.freeze({
  esm: 'e2e2385dd7543d557d64312be9ef1045cec57a094cfc1aeec882d4c356c25521',
  cjs: '5d08e70c604566c2d2ed9c84000008c8d13a15a9b04df268c9b3ef218154098b',
  cf: '5704f05aeb495cf78a97ae7d140d3a980007130736e0c8bc6b77ed90ec47d72d',
});

// Evaluation only. No install hook, environment toggle, runtime switch or default adoption.
// Build the same pinned candidates used by the wire suite; do not maintain a second patch.
export async function postgresCandidateAdoption({ enabled = false, target, candidateRevision = 'v300' } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Candidate enabled must be boolean');
  if (!enabled) return { plugins: [], candidate: null };
  if (!['node', 'workers'].includes(target)) throw new Error('Explicit candidate target required');
  if (!['v300', 'v307'].includes(candidateRevision)) throw new Error('Unsupported candidate revision');
  const candidate = candidateRevision === 'v307'
    ? await buildOwnedCancellationCandidates()
    : await buildRetirementCandidates({ lifecycle: 'completed', writeFailure: 'retire' });
  if (candidateRevision === 'v307' && Object.entries(ownedScanV307Sha256).some(
    ([variant, expected]) => candidate.artifacts[variant]?.sha256 !== expected))
    throw new Error('Controlled recovery scan candidate changed');
  const require = createRequire(import.meta.url);
  const loaded = new Set();
  const plugin = {
    name: candidateRevision === 'v300' ? 'evaluation-postgres-candidate' : 'evaluation-postgres-candidate-v307',
    setup(builder) {
      if (!builder.initialOptions.metafile) throw new Error('Candidate adoption requires metafile audit');
      builder.onStart(() => { loaded.clear(); });
      // The external Drizzle adapter imports its own postgres factory. Bundle that
      // adapter too, so this known transitive constructor cannot bypass selection.
      builder.onResolve({ filter: /^drizzle-orm\/postgres-js(?:\/.*)?$/ }, args => {
        if (args.path !== 'drizzle-orm/postgres-js') throw new Error('Unsupported postgres adapter subpath');
        return { path: args.kind === 'require-call' ? require.resolve(args.path) : fileURLToPath(import.meta.resolve(args.path)) };
      });
      builder.onResolve({ filter: /^postgres(?:\/.*)?$/ }, args => {
        if (args.path !== 'postgres') throw new Error('Unsupported postgres candidate subpath');
        const variant = target === 'workers' ? 'cf' : args.kind === 'require-call' ? 'cjs' : 'esm';
        // Stable virtual names keep repeated app builds byte-identical across temp directories.
        return { path: variant, namespace: 'postgres-evaluation' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'postgres-evaluation' }, async args => {
        const artifact = candidate.artifacts[args.path];
        if (!artifact) throw new Error('Unknown candidate variant');
        const contents = await readFile(artifact.path, 'utf8');
        const actualSha256 = sha256(contents);
        if (actualSha256 !== artifact.sha256) throw new Error('Candidate artifact changed');
        if (candidateRevision === 'v307' && actualSha256 !== ownedScanV307Sha256[args.path])
          throw new Error('Frozen controlled recovery scan artifact changed');
        if (candidateRevision === 'v307' &&
          (!contents.includes('postgres-js-3.4.9-owned-cancel-v302') ||
            !contents.includes('postgres-js-3.4.9-owned-scan-v307')))
          throw new Error('Candidate lacks controlled recovery scan fence');
        loaded.add(args.path);
        return { contents, loader: 'js' };
      });
      builder.onEnd(result => {
        if (result.errors.length) return;
        try { auditCandidateBundle(result.metafile, { target, loaded: [...loaded] }); }
        catch (error) { return { errors: [{ text: error.message }] }; }
      });
    },
  };
  return { plugins: [plugin], candidate };
}

export function auditCandidateBundle(metafile, { target, loaded }) {
  if (!metafile || !['node', 'workers'].includes(target)) throw new Error('Missing candidate metadata/target');
  const inputs = Object.keys(metafile.inputs);
  const selected = inputs.filter(name => name.startsWith('postgres-evaluation:'))
    .map(name => name.slice('postgres-evaluation:'.length)).sort();
  const expected = [...loaded].sort();
  if (!expected.length || JSON.stringify(selected) !== JSON.stringify(expected))
    throw new Error('Candidate was bypassed or not loaded');
  if (expected.some(variant => !(target === 'workers' ? ['cf'] : ['esm', 'cjs']).includes(variant)))
    throw new Error('Wrong candidate runtime branch');
  if (inputs.some(name => /(?:^|\/)node_modules\/postgres\//.test(name.replaceAll('\\', '/'))))
    throw new Error('Unpatched postgres package remains in bundle');
  for (const entry of [...Object.values(metafile.inputs), ...Object.values(metafile.outputs)]) {
    if (entry.imports.some(item => item.external && /^(?:postgres(?:\/|$)|drizzle-orm\/postgres-js(?:\/|$))/.test(item.path)))
      throw new Error('External postgres bypass remains');
  }
  const emitted = selected.every(variant => Object.values(metafile.outputs).some(output =>
    (output.inputs?.['postgres-evaluation:' + variant]?.bytesInOutput ?? 0) > 0));
  if (!emitted) throw new Error('Candidate was eliminated from output');
  return { target, variants: selected };
}

// Wrangler aliases are physical files, not esbuild plugins. Audit both resolution and bytes.
export function auditWranglerCandidate(metafile, { artifact, workingDirectory }) {
  const names = Object.keys(metafile.inputs);
  const selected = names.filter(name => resolve(workingDirectory, name) === resolve(artifact.path));
  if (selected.length !== 1) throw new Error('Wrangler did not consume the selected candidate');
  if (names.some(name => /(?:^|\/)node_modules\/postgres\//.test(name.replaceAll('\\', '/'))))
    throw new Error('Wrangler also bundled the installed postgres driver');
  if (!Object.values(metafile.outputs).some(output => (output.inputs?.[selected[0]]?.bytesInOutput ?? 0) > 0))
    throw new Error('Wrangler eliminated the candidate');
  for (const entry of [...Object.values(metafile.inputs), ...Object.values(metafile.outputs)]) {
    if (entry.imports.some(item => item.external && /^postgres(?:\/|$)/.test(item.path)))
      throw new Error('Wrangler left an external postgres bypass');
  }
  return { variant: 'cf', input: selected[0] };
}
