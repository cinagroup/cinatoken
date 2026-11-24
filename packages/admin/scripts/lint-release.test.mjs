import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateReleaseLint, lintFingerprint } from './lint-release.mjs';

const root = '/project/admin';
const error = { severity: 2, ruleId: 'react-hooks/refs', line: 5, column: 2, endLine: 5, endColumn: 9, message: 'Existing error at /project/admin/legacy.tsx' };
const baseline = { files: [{ path: 'legacy.tsx', sha256: 'original', fingerprints: [lintFingerprint(error, root)] }] };
const results = (message = error, file = root + '/legacy.tsx') => [{ filePath: file, messages: [message] }];

test('unchanged known error is retained, with identical fingerprints across checkout paths', () => {
	const actual = evaluateReleaseLint(results(), baseline, root, () => 'original');
	assert.equal(actual.knownErrors, 1);
	assert.deepEqual(actual.unexpected, []);
	assert.equal(lintFingerprint({ ...error, message: 'Existing error at /runner/admin/legacy.tsx' }, '/runner/admin'), lintFingerprint(error, root));
});
test('a new diagnostic in an unchanged legacy file blocks release', () => {
	assert.equal(evaluateReleaseLint(results({ ...error, message: 'New error' }), baseline, root, () => 'original').unexpected.length, 1);
});
test('duplicate diagnostics cannot exceed the recorded original count', () => {
	const duplicated = [{ filePath: root + '/legacy.tsx', messages: [error, error] }];
	const actual = evaluateReleaseLint(duplicated, baseline, root, () => 'original');
	assert.equal(actual.knownErrors, 1);
	assert.equal(actual.unexpected.length, 1);
});
test('a changed legacy file must resolve its remaining errors', () => {
	assert.equal(evaluateReleaseLint(results(), baseline, root, () => 'changed').unexpected.length, 1);
	assert.deepEqual(evaluateReleaseLint([{ filePath: root + '/legacy.tsx', messages: [] }], baseline, root, () => 'changed').unexpected, []);
});
test('an unlisted file and a parser failure cannot use legacy exceptions', () => {
	assert.equal(evaluateReleaseLint(results(error, root + '/new.tsx'), baseline, root, () => 'original').unexpected.length, 1);
	assert.equal(evaluateReleaseLint(results({ ...error, ruleId: null, fatal: true }), baseline, root, () => 'original').unexpected.length, 1);
});
