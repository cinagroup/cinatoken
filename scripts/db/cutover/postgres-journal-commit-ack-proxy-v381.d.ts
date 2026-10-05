/** Type boundary for the shared JS-only physical COMMIT-ACK fault fixture. */
declare module '*postgres-journal-commit-ack-proxy-v381.mjs' {
	export type JournalCommitAckDropProxyV381 = {
		readonly host: string;
		readonly port: number;
		readonly facts: {
			connections: number;
			commitCommands: number;
			commitProtocol: string | null;
			backendCommitCompletes: number;
			droppedCommitAcks: number;
			forwardedBackendFrames: number;
		};
		waitForDrop(): Promise<void>;
		close(): Promise<void>;
	};
	export function startJournalCommitAckDropProxyV381(options: {
		upstreamPort: number;
		upstreamHost?: string;
	}): Promise<JournalCommitAckDropProxyV381>;
}
