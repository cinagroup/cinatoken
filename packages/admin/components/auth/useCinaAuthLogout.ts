'use client';

import { useCallback, useRef, useState } from 'react';
import { requestCinaAuthLogout } from '@/lib/cinaauth/logout';
import { notifyCinaAuthSessionChanged } from '@/lib/cinaauth/session-events';

export function useCinaAuthLogout() {
	const pending = useRef(false);
	const [isLoggingOut, setIsLoggingOut] = useState(false);
	const [logoutFailed, setLogoutFailed] = useState(false);
	const logout = useCallback(async () => {
		if (pending.current) return false;
		pending.current = true;
		setIsLoggingOut(true);
		setLogoutFailed(false);
		const success = await requestCinaAuthLogout();
		pending.current = false;
		setIsLoggingOut(false);
		if (!success) {
			setLogoutFailed(true);
			return false;
		}
		notifyCinaAuthSessionChanged('logout');
		return true;
	}, []);
	return { logout, isLoggingOut, logoutFailed };
}
