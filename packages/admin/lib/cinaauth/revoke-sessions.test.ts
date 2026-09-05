import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashSessionToken } from '@/lib/auth';
import { revokeCinaAuthBrowserSessions } from './revoke-sessions';

describe('unified browser session revocation', () => {
	it('revokes every distinct token in both stores and never sends plaintext to the repository', async () => {
		const admin: string[] = [];
		const portal: string[] = [];
		await revokeCinaAuthBrowserSessions(['first', 'second', 'first'], {
			adminAccess: { deleteSession: async hash => { admin.push(hash); } },
			portalAccess: { deleteSession: async hash => { portal.push(hash); } },
		});
		const hashes = await Promise.all(['first', 'second'].map(hashSessionToken));
		assert.deepEqual(admin, hashes);
		assert.deepEqual(portal, hashes);
	});
	it('reports any storage failure only after all revocation attempts have settled', async () => {
		let portalFinished = false;
		await assert.rejects(revokeCinaAuthBrowserSessions(['token'], {
			adminAccess: { deleteSession: async () => { throw new Error('admin storage unavailable'); } },
			portalAccess: { deleteSession: async () => {
				await new Promise(resolve => setTimeout(resolve, 10));
				portalFinished = true;
			} },
		}), /admin storage unavailable/u);
		assert.equal(portalFinished, true);
	});
});
