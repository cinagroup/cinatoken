/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Guardrails use the same durable identity/domain generations across both UI entries. */
export {
	AdminDomainWriteRecovery as AdminGuardrailWriteRecovery,
	adminDomainWriteRecovery as adminGuardrailWriteRecovery,
} from '../domain-write-recovery'
