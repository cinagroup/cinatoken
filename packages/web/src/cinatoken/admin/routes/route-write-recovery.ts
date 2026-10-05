/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** All entry points share persistent identity/domain generations; list GET never settles a write. */
export {
	AdminDomainWriteRecovery as RouteWriteRecovery,
	adminDomainWriteRecovery as routeWriteRecovery,
} from '../domain-write-recovery'
export type RouteWriteTarget =
	| { kind: 'routes' }
	| { kind: 'model'; id: string }
	| { kind: 'sticky'; poolId: string }
