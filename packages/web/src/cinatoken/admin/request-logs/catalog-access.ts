/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
type CatalogDomain = 'models' | 'providers' | 'routes'
class RequestLogCatalogAccess {
	private readonly denied = new Set<string>()
	key(principal: string, domain: CatalogDomain): string {
		return JSON.stringify([principal, domain])
	}
	canRead(principal: string, domain: CatalogDomain): boolean {
		return !this.denied.has(this.key(principal, domain))
	}
	block(principal: string, domain: CatalogDomain): void {
		this.denied.add(this.key(principal, domain))
		while (this.denied.size > 96) {
			const oldest = this.denied.values().next().value
			if (oldest) this.denied.delete(oldest)
		}
	}
	settle(principal: string): void {
		for (const domain of ['models', 'providers', 'routes'] as const)
			this.denied.delete(this.key(principal, domain))
	}
}
const stores = new WeakMap<object, RequestLogCatalogAccess>()
export function requestLogCatalogAccess(api: object): RequestLogCatalogAccess {
	let store = stores.get(api)
	if (!store) {
		store = new RequestLogCatalogAccess()
		stores.set(api, store)
	}
	return store
}
