/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { Dialog } from '@base-ui/react/dialog'

type Container = Dialog.Portal.Props['container']
const PortalContainer = createContext<Container>(undefined)
/** A host may keep portal content inside its isolated theme and utility scope. */
export function UiPortalContainer(props: {
	value: Container
	children: ReactNode
}) {
	return <PortalContainer.Provider {...props} />
}
export const useUiPortalContainer = () => useContext(PortalContainer)
