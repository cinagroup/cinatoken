import original from '__ORIGINAL__';
const emit = (event, fields = {}) => {
  try { console.log('V364_DIAG ' + JSON.stringify({ boundary: 'gateway', event, wallMs: Date.now(), ...fields })); } catch {}
};
function observe(signal, boundary) {
  emit('signal-initial', { signalBoundary: boundary, aborted: signal.aborted });
  signal.addEventListener('abort', () => emit('signal-abort', { signalBoundary: boundary, aborted: signal.aborted }), { once: true });
}
export default {
  fetch(request, env, ctx) {
    observe(request.signal, 'incoming');
    const binding = env.TEXT_HOLDER;
    const observedBinding = new Proxy(binding, {
      get(target, property) {
        if (property === 'fetch') return (...args) => {
          if (args[0] instanceof Request) observe(args[0].signal, 'forwarded-request-object');
          emit('binding-fetch');
          return Reflect.apply(target.fetch, target, args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // Forward the original Request, body, response, promise and context unchanged.
    return original.fetch(request, { ...env, TEXT_HOLDER: observedBinding }, ctx);
  },
};
