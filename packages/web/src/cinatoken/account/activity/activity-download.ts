type DownloadEnvironment = {
	create: (blob: Blob) => string
	revoke: (url: string) => void
	click: (url: string, filename: string) => void
	later: (callback: () => void) => () => void
}

const browserEnvironment: DownloadEnvironment = {
	create: (blob) => URL.createObjectURL(blob),
	revoke: (url) => URL.revokeObjectURL(url),
	click: (url, filename) => {
		const anchor = document.createElement('a')
		anchor.href = url
		anchor.download = filename
		anchor.hidden = true
		document.body.append(anchor)
		try {
			anchor.click()
		} finally {
			anchor.remove()
		}
	},
	later: (callback) => {
		const timer = setTimeout(callback, 1_000)
		return () => clearTimeout(timer)
	},
}

/** The owning account scope revokes URLs on completion, permission loss and unmount. */
export function createActivityDownloadScope(
	environment: DownloadEnvironment = browserEnvironment
) {
	const pending = new Map<string, (() => void) | null>()
	const release = (url: string) => {
		if (!pending.has(url)) return
		pending.get(url)?.()
		pending.delete(url)
		environment.revoke(url)
	}
	return {
		download(blob: Blob, filename: string): void {
			const url = environment.create(blob)
			pending.set(url, null)
			try {
				environment.click(url, filename)
				pending.set(
					url,
					environment.later(() => release(url))
				)
			} catch (error) {
				release(url)
				throw error
			}
		},
		clear(): void {
			for (const url of [...pending.keys()]) release(url)
		},
	}
}
