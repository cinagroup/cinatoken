/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenApi } from '../api'
import { AccountEarnings } from './earnings/AccountEarnings'

export function AccountEarningsRoute() {
	return <AccountEarnings api={cinatokenApi} />
}
