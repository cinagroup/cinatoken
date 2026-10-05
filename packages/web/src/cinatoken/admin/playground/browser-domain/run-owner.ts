/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export type OwnedRun = {
	controller: AbortController
	cleanups: Set<() => void>
	generation: number
}
/** Each UI event revokes the old generation before closing its transports. */
export class RunOwner {
	private generation = 0
	private active: OwnedRun | null = null
	start(): OwnedRun {
		this.cancel()
		const run = {
			controller: new AbortController(),
			cleanups: new Set<() => void>(),
			generation: this.generation,
		}
		this.active = run
		return run
	}
	owns(run: OwnedRun): boolean {
		return (
			this.active === run &&
			!run.controller.signal.aborted &&
			run.generation === this.generation
		)
	}
	finish(run: OwnedRun): void {
		if (this.active === run) this.active = null
		this.release(run)
	}
	cancel(): void {
		const old = this.active
		this.active = null
		this.generation++
		if (old) this.release(old)
	}
	private release(run: OwnedRun): void {
		run.controller.abort()
		for (const cleanup of run.cleanups) {
			try {
				cleanup()
			} catch {
				/* A broken transport must not skip the remaining resources. */
			}
		}
		run.cleanups.clear()
	}
}
