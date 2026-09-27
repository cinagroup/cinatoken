// No imports, bindings, secrets, storage, HTTP listener or external requests.
console.log('CINATOKEN_RUNTIME_MODULE_ENTERED');
export default {
	async test() {
		console.log('CINATOKEN_RUNTIME_TEST_ENTERED');
		if (await new Response('runtime-ready').text() !== 'runtime-ready') throw new Error('Response smoke failed');
		const controller = new AbortController();
		const request = new Request('https://synthetic.invalid/', { signal: controller.signal });
		controller.abort();
		if (!request.signal.aborted) throw new Error('Request signal smoke failed');
		console.log('CINATOKEN_RUNTIME_TEST_PASSED');
	},
};
