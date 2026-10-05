import { useEffect, useState } from 'react'

/** Re-evaluate expiry labels while the page remains open. */
export function useAccountClock(): number {
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30_000)
		return () => window.clearInterval(timer)
	}, [])
	return now
}
