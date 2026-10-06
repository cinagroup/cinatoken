// Owned native calibration: original holder/observer and original ctx.waitUntil only.
import assert from "node:assert/strict";
import holder from "__HOLDER_OBSERVER__";

const log = (event, fields = {}) =>
	console.log(
		"V364_DIAG " +
			JSON.stringify({
				boundary: "native-reader-calibration",
				event,
				wallMs: Date.now(),
				...fields,
			})
	);

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (
			url.pathname !== "/fixture/native-reader-cancel" ||
			request.method !== "POST"
		)
			return new Response(null, { status: 404 });
		const attemptNonce = url.searchParams.get("attemptNonce");
		assert.match(
			attemptNonce ?? "",
			/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
		);
		const response = await holder.fetch(
			new Request(
				"https://holder.service.invalid/complete-text-attempt",
				request
			),
			env,
			ctx
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Content-Type"), "text/event-stream");
		assert.ok(response.body);
		const reader = response.body.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		assert.equal(new TextDecoder().decode(first.value), ": holder-ready\n\n");
		let pendingSettled = false;
		const pending = reader.read().then((part) => {
			pendingSettled = true;
			log("pending-read-settled", { done: part.done });
			return part;
		});
		// Let the same original asynchronous pull become pending. No lifetime task is added.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const pendingReadSettledBeforeCancel = pendingSettled;
		assert.equal(pendingReadSettledBeforeCancel, false);
		log("reader-cancel-invoke", { pendingReadSettledBeforeCancel });
		await reader.cancel("owned native reader calibration");
		log("reader-cancel-fulfilled");
		const after = await pending;
		assert.equal(after.done, true);
		reader.releaseLock();
		const values = {};
		for (const category of ["cancel", "release", "accepted"])
			values[category] = await env.OBSERVATIONS.get(
				`${category}:${attemptNonce}`
			);
		assert.equal(values.cancel, "observed");
		assert.equal(values.release, null);
		assert.equal(values.accepted, "one");
		return new Response(
			JSON.stringify({
				nativeReaderCancel: true,
				firstFrame: ": holder-ready\n\n",
				pendingReadSettledBeforeCancel,
				pendingReadAfterCancelDone: after.done,
				...values,
			}),
			{
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				},
			}
		);
	},
};
