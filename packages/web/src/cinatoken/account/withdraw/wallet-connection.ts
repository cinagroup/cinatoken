import { CinaTokenApiError } from '../../api'
import type { WalletApi, WalletRequestOptions } from '../../wallet-api'
import {
	isWalletChallengeContext,
	walletAddressSchema,
} from '../../wallet-contracts'

export type EvmProvider = {
	request(input: {
		method: string
		params?: readonly unknown[]
	}): Promise<unknown>
	on?: (
		event: 'accountsChanged' | 'chainChanged',
		listener: (value: unknown) => void
	) => void
	removeListener?: (
		event: 'accountsChanged' | 'chainChanged',
		listener: (value: unknown) => void
	) => void
}
export type WalletPhase = 'connecting' | 'challenge' | 'signing' | 'verifying'
export class WalletConnectionError extends Error {
	constructor(
		readonly reason:
			| 'noProvider'
			| 'rejected'
			| 'wrongChain'
			| 'changed'
			| 'expired'
			| 'providerFailed'
	) {
		super(reason)
		this.name = 'WalletConnectionError'
	}
}
export function browserEvmProvider(): EvmProvider | null {
	const value: unknown = Reflect.get(globalThis, 'ethereum')
	if (
		typeof value !== 'object' ||
		value === null ||
		!('request' in value) ||
		typeof value.request !== 'function'
	)
		return null
	return value as EvmProvider
}
function chain(value: unknown): number | null {
	if (typeof value !== 'string' || !/^0x[0-9a-f]+$/iu.test(value)) return null
	const result = Number.parseInt(value.slice(2), 16)
	return Number.isSafeInteger(result) && result > 0 ? result : null
}
/** The challenge and signature are async locals only; no Query/Mutation variables or storage. */
export class WalletConnection {
	private generation = 0
	private controller: AbortController | null = null
	cancel() {
		this.generation += 1
		this.controller?.abort()
		this.controller = null
	}
	async connect(
		api: WalletApi,
		options: WalletRequestOptions,
		provider: EvmProvider | null,
		phase: (value: WalletPhase) => void
	): Promise<void> {
		this.cancel()
		if (!provider) throw new WalletConnectionError('noProvider')
		const generation = this.generation
		const controller = new AbortController()
		this.controller = controller
		const current = () => {
			if (generation !== this.generation || controller.signal.aborted)
				throw new WalletConnectionError('changed')
		}
		async function request(
			input: Parameters<EvmProvider['request']>[0]
		): Promise<unknown> {
			current()
			let abort = () => {}
			const cancelled = new Promise<never>((_resolve, reject) => {
				abort = () => reject(new WalletConnectionError('changed'))
				controller.signal.addEventListener('abort', abort, { once: true })
			})
			try {
				return await Promise.race([provider!.request(input), cancelled])
			} finally {
				controller.signal.removeEventListener('abort', abort)
			}
		}
		let detach = () => {}
		try {
			phase('connecting')
			const accounts = await request({ method: 'eth_requestAccounts' })
			current()
			if (
				!Array.isArray(accounts) ||
				!walletAddressSchema.safeParse(accounts[0]).success
			)
				throw new WalletConnectionError('providerFailed')
			const address = accounts[0] as string
			const initialChain = chain(await request({ method: 'eth_chainId' }))
			current()
			if (!initialChain) throw new WalletConnectionError('wrongChain')
			const changed = () => this.cancel()
			provider.on?.('accountsChanged', changed)
			provider.on?.('chainChanged', changed)
			detach = () => {
				provider.removeListener?.('accountsChanged', changed)
				provider.removeListener?.('chainChanged', changed)
			}
			phase('challenge')
			const challenge = await api.createWalletChallenge(
				{ walletAddress: address },
				{ ...options, signal: controller.signal }
			)
			current()
			if (challenge.chainId !== initialChain)
				throw new WalletConnectionError('wrongChain')
			const origin = options.expectedOrigin ?? globalThis.location?.origin
			if (
				!origin ||
				!isWalletChallengeContext(
					challenge,
					options.expectedUserId,
					origin,
					address
				)
			)
				throw new WalletConnectionError('expired')
			phase('signing')
			const signature = await request({
				method: 'personal_sign',
				params: [challenge.message, address],
			})
			current()
			if (typeof signature !== 'string')
				throw new WalletConnectionError('providerFailed')
			const latestAccounts = await request({ method: 'eth_accounts' })
			current()
			const latestChain = chain(await request({ method: 'eth_chainId' }))
			current()
			if (
				!Array.isArray(latestAccounts) ||
				typeof latestAccounts[0] !== 'string' ||
				latestAccounts[0].toLowerCase() !== address.toLowerCase() ||
				latestChain !== initialChain
			)
				throw new WalletConnectionError('changed')
			if (Date.parse(challenge.expiresAt) <= Date.now())
				throw new WalletConnectionError('expired')
			phase('verifying')
			const verified = await api.verifyWallet(
				{ challengeToken: challenge.challengeToken, signature },
				{ ...options, signal: controller.signal }
			)
			current()
			if (verified.walletAddress.toLowerCase() !== address.toLowerCase())
				throw new WalletConnectionError('providerFailed')
		} catch (error) {
			if (error instanceof WalletConnectionError) throw error
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 4001
			)
				throw new WalletConnectionError('rejected')
			// API errors have safe messages from the public transport. Provider messages may echo payloads.
			if (error instanceof CinaTokenApiError) throw error
			throw new WalletConnectionError('providerFailed')
		} finally {
			detach()
			if (this.controller === controller) this.controller = null
		}
	}
}
