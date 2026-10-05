/** workerd uses expectedLength when streaming an exact-length request body. */
export type WorkerdLengthAwareSource = {
	expectedLength: number;
	start(controller: ReadableStreamDefaultController<Uint8Array>): void;
	pull(controller: ReadableStreamDefaultController<Uint8Array>): void | Promise<void>;
	cancel(): void | Promise<void>;
};
