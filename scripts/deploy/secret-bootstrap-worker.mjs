/**
 * Inactive first-deploy shell used only so Wrangler can accept Worker secrets.
 * This Worker has no workers.dev or custom-domain route in its config.
 */
export default {
	async fetch() {
		return new Response("Service is not deployed", {
			status: 503,
			headers: {
				"cache-control": "no-store",
				"content-type": "text/plain; charset=utf-8",
			},
		});
	},
};
