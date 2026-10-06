import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-legacy-parent-client-binding-repair-c3e097398c054113961be652993e62b0';
const repo = 'C:/cinagroup/cinatoken';
const target = `${repo}/scripts/db/cutover/postgres-legacy-parent-activation.native.test.mjs`;
const helper = `${repo}/scripts/db/cutover/pg73-native-fixture.mjs`;
const beganAt = new Date().toISOString();
const require = createRequire(`${repo}/package.json`);
const acorn = require('acorn');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: hash(b) }; };
const write = (relative, bytes) => fs.writeFileSync(`${root}/${relative}`, bytes, { flag: 'wx' });
const beforeBytes = fs.readFileSync(target);
const helperBytes = fs.readFileSync(helper);
write('source-before-v2.mjs', beforeBytes);
write('pg73-native-fixture-source-v2.mjs', helperBytes);
assert.deepEqual(fs.readFileSync(`${root}/source-before.mjs`), beforeBytes);
assert.deepEqual(fs.readFileSync(`${root}/pg73-native-fixture-source.mjs`), helperBytes);
const before = beforeBytes.toString('utf8');
assert.deepEqual(Buffer.from(before), beforeBytes);
const oldArgument = '{ cluster, migrator, migratorUrl }';
const newArgument = '{ cluster, migrator: sql, migratorUrl }';
assert.equal(before.split(oldArgument).length - 1, 3);
assert.equal(before.split(newArgument).length - 1, 0);
const parse = source => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
const walk = (node, fn, ancestors = []) => {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') { fn(node, ancestors); ancestors = [...ancestors, node]; }
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => walk(child, fn, ancestors)); else if (value && typeof value === 'object') walk(value, fn, ancestors);
};
const grantCalls = ast => {
  const records = [];
  walk(ast, (node, ancestors) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'grantPg73RuntimeFixture') return;
    assert.equal(node.arguments.length, 1);
    const object = node.arguments[0];
    assert.equal(object.type, 'ObjectExpression');
    const property = object.properties.find(p => p.key?.name === 'migrator');
    assert(property);
    const block = [...ancestors].reverse().find(parent => parent.type === 'BlockStatement' && parent.body.some(stmt => stmt.type === 'VariableDeclaration' && stmt.declarations.some(d => d.id.type === 'Identifier' && d.id.name === 'sql')));
    assert(block, 'Each grant must have the existing sql in lexical scope');
    const sql = block.body.flatMap(stmt => stmt.type === 'VariableDeclaration' ? stmt.declarations : []).find(d => d.id.name === 'sql');
    assert.equal(sql.init.type, 'CallExpression');
    assert.equal(sql.init.callee.name, 'client');
    assert.equal(sql.init.arguments[1].value, 'cinatoken_gateway_migrator');
    records.push({ node, property, line: node.loc?.start.line ?? null, sql });
  });
  return records;
};
const beforeAST = parse(before);
const beforeCalls = grantCalls(beforeAST);
assert.deepEqual(beforeCalls.map(c => c.line), [100, 149, 391]);
for (const call of beforeCalls) {
  assert.equal(call.property.shorthand, true);
  assert.equal(call.property.value.name, 'migrator');
}
const after = before.replaceAll(oldArgument, newArgument);
const afterBytes = Buffer.from(after);
const afterAST = parse(after);
const afterCalls = grantCalls(afterAST);
assert.equal(afterCalls.length, 3);
for (const call of afterCalls) {
  assert.equal(call.property.shorthand, false);
  assert.equal(call.property.value.type, 'Identifier');
  assert.equal(call.property.value.name, 'sql');
}
const clean = value => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'loc'].includes(key)).map(([key, entry]) => [key, clean(entry)]));
};
const beforeCanonical = clean(beforeAST);
const afterCanonical = clean(afterAST);
for (const call of grantCalls(afterCanonical)) {
  call.property.value = { type: 'Identifier', name: 'migrator' };
  call.property.shorthand = true;
}
assert.deepEqual(afterCanonical, beforeCanonical, 'Entire AST may change only the three owned property bindings');
const assertions = ast => {
  const rows = [];
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'assert') rows.push(clean(node));
  });
  return rows;
};
assert.deepEqual(assertions(afterAST), assertions(beforeAST));
assert.deepEqual(Buffer.from(after.replaceAll(newArgument, oldArgument)), beforeBytes);
const beforeLines = before.split('\n');
const afterLines = after.split('\n');
assert.equal(beforeLines.length, afterLines.length);
const changed = beforeLines.map((line, index) => line !== afterLines[index] ? { line: index + 1, before: line.replace(/\r$/, ''), after: afterLines[index].replace(/\r$/, '') } : null).filter(Boolean);
assert.deepEqual(changed.map(row => row.line), [100, 149, 391]);
for (const row of changed) assert(!/[\t ]+$/.test(row.after));
assert.equal(afterBytes.length - beforeBytes.length, 15);
write('exact-minimal-diff.json', `${JSON.stringify({ changed, reverseFullBytesExact: true, entireASTExceptBindingsExact: true, assertionsCount: assertions(beforeAST).length, allAssertionsASTExact: true, addedBytes: 15, changedLineWhitespaceCheckActualExit: 0, gitInvoked: false }, null, 2)}\n`);
fs.writeFileSync(target, afterBytes);
assert.deepEqual(fs.readFileSync(target), afterBytes);
assert.deepEqual(fs.readFileSync(helper), helperBytes);
write('source-after.mjs', afterBytes);
const nodeBeganAt = new Date().toISOString();
const check = spawnSync(process.execPath, ['--check', target], { cwd: repo, windowsHide: true, timeout: 15000, encoding: null, maxBuffer: 1048576 });
write('node-check.stdout.log', check.stdout ?? Buffer.alloc(0));
write('node-check.stderr.log', check.stderr ?? Buffer.alloc(0));
const nodeReceipt = { schema: 'cinatoken-legacy-parent-node-syntax-command-closed-v1', closed: true, beganAt: nodeBeganAt, endedAt: new Date().toISOString(), program: process.execPath, args: ['--check', target], actualExit: check.status, signal: check.signal, spawnError: check.error ? { name: check.error.name, code: check.error.code ?? null } : null, stdout: descriptor(`${root}/node-check.stdout.log`), stderr: descriptor(`${root}/node-check.stderr.log`), evaluatesModule: false, postgresOrAppExecution: false, gatePassDerived: false };
write('node-check.result.json', `${JSON.stringify(nodeReceipt, null, 2)}\n`);
assert.equal(check.status, 0);
assert.equal(check.signal, null);
assert.equal(check.error, undefined);
const proof = {
  schema: 'cinatoken-legacy-parent-migrator-binding-minimal-source-repair-v1', beganAt, endedAt: new Date().toISOString(), actualSourcePreparationExit: 0,
  sourceTaskContext: 'Root-provided d537 push: actual step110 ReferenceError before SQL assertion; no Git was executed to resolve currentHEAD here',
  ownedRepositoryFiles: [target],
  before: descriptor(`${root}/source-before-v2.mjs`), after: descriptor(`${root}/source-after.mjs`), currentTarget: descriptor(target),
  unchangedHelper: descriptor(helper), helperCopy: descriptor(`${root}/pg73-native-fixture-source-v2.mjs`),
  bindings: afterCalls.map(call => ({ line: call.line, property: 'migrator', previousValue: 'migrator shorthand (undeclared)', currentValue: 'sql', sqlDeclarationLine: call.sql.loc.start.line, existingRoleLiteral: 'cinatoken_gateway_migrator' })),
  safeguards: { reverseEntireSourceBytesExact: true, entireASTExceptThreeBindingsExact: true, allAssertionsASTExact: true, originalAssertionsCount: assertions(beforeAST).length, originalSQLRolesClientsLocksDelaysAndCleanupByteExact: true, newClientCreated: false, helperChanged: false, changedLineWhitespaceCheckActualExit: 0 },
  nodeCheck: nodeReceipt, minimalDiff: descriptor(`${root}/exact-minimal-diff.json`),
  executionBoundary: { gitExecution: false, postgresExecution: false, appExecution: false, nativeRuntimeExecution: false, ciInvocation: false, productionRequest: false, mdChange: false, originalSealedRootsChanged: false },
  originalObservedNativeStep110ActualExit: 1, originalReferenceErrorPreserved: true,
  realPostgresRepairValidated: false, fullGoalComplete: false, strictV364Passed: false, gatePassDerived: false,
};
write('source-repair-proof.json', `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ actualSourcePreparationExit: 0, threeBindingLines: changed.map(r => r.line), assertionCount: assertions(beforeAST).length, before: proof.before, after: proof.after, nodeCheckActualExit: check.status, diffCheckActualExit: 0, postgresExecution: false }));
