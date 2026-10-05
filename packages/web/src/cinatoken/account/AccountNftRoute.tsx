/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenApi } from '../api'
import { AccountNft } from './nft/AccountNft'

export function AccountNftRoute() {
	return <AccountNft api={cinatokenApi} />
}
