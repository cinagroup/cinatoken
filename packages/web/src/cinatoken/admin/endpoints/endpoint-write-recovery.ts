/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** All entry points share persistent identity/domain generations; list GET never settles a write. */
export {
	AdminDomainWriteRecovery as EndpointWriteRecovery,
	adminDomainWriteRecovery as endpointWriteRecovery,
} from '../domain-write-recovery'
