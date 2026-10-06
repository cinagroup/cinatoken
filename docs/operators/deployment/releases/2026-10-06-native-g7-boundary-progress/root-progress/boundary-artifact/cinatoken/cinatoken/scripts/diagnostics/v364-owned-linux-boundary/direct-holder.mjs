// Owned diagnostic only. Both observers and both original modules remain frozen.
// Only the Service Binding transport is replaced with a local JS function call.
import gateway from '__GATEWAY_OBSERVER__';
import holder from '__HOLDER_OBSERVER__';
export default {
  fetch(request, env, ctx) {
    const localHolder = {
      fetch(holderRequest) {
        if (!(holderRequest instanceof Request)) throw new TypeError('Expected the exact gateway-created Request');
        return holder.fetch(holderRequest, env, ctx);
      },
    };
    // Frozen gateway constructs its private URL/stream/signal Request and rewraps
    // the returned Response body itself; this wrapper does not replace either.
    return gateway.fetch(request, { ...env, TEXT_HOLDER: localHolder }, ctx);
  },
};
