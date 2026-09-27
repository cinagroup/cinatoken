import { createObservedPrivateCompleteTextHolderV384, type ObservedPrivateTextHolderPortsV384 } from './private-complete-text-observed-holder-v384';
import { observeCompleteTextResponseV392, type AppendResponseObservationV392 } from './complete-text-response-observation-v392';

export type ResponseObservedPrivateTextHolderPortsV392 = ObservedPrivateTextHolderPortsV384 &
	Readonly<{ appendResponseObservation: AppendResponseObservationV392 }>;

/** Uses the committed physical start identity; renewal never grants another POST. */
export function createResponseObservedPrivateCompleteTextHolderV392(ports: ResponseObservedPrivateTextHolderPortsV392) {
	if (typeof ports.appendResponseObservation !== 'function') throw new TypeError('Response observation port required');
	let identity: Readonly<{ grantId: string; holderRunId: string; sendStartId: string; expectedEpoch: 1 }> | undefined;
	const holder = createObservedPrivateCompleteTextHolderV384({ ...ports,
		async recordSendStart(grantId, holderRunId, expectedEpoch, uploadSha256) {
			const result = await ports.recordSendStart(grantId, holderRunId, expectedEpoch, uploadSha256);
			const row = result as Record<string, unknown>;
			if (row?.status === 'start_recorded' && row.commitAcknowledged === true && expectedEpoch === 1
				&& row.grantId === grantId && row.holderRunId === holderRunId && row.leaseEpoch === 1
				&& row.uploadSha256 === uploadSha256 && typeof row.sendStartId === 'string') {
				identity = Object.freeze({ grantId, holderRunId, sendStartId: row.sendStartId, expectedEpoch: 1 });
			}
			return result;
		},
	});
	return Object.freeze({ async run(request: unknown, signal: AbortSignal): Promise<Response> {
		const response = await holder.run(request, signal);
		try {
			if (!identity) throw new TypeError('Committed response observation identity missing');
			return observeCompleteTextResponseV392(response, identity, ports.appendResponseObservation).response;
		} catch (error) {
			await response.body?.cancel().catch(() => {});
			throw error;
		}
	} });
}
