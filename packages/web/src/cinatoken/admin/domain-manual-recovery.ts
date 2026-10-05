/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { AdminDomainRequestOptions } from './domain-transport'
import { AdminDomainWriteError } from './domain-write-recovery'

/** Observations cannot identify a lost acknowledgement and never replay a write. */
export async function reviewAdminDomainUnknown(input: {
	options: AdminDomainRequestOptions
	verify: (options: AdminDomainRequestOptions) => Promise<string>
	observe: (options: AdminDomainRequestOptions) => Promise<unknown>
	reviewedExternal: boolean
	acceptsUnknown: boolean
}): Promise<void> {
	if (!input.reviewedExternal || !input.acceptsUnknown)
		throw new AdminDomainWriteError('unknown')
	await input.verify(input.options)
	input.options.signal?.throwIfAborted()
	await input.observe(input.options)
	input.options.signal?.throwIfAborted()
	await input.verify(input.options)
	input.options.signal?.throwIfAborted()
}
