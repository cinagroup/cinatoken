import original from '__ORIGINAL__';
const emit = (event, fields = {}) => {
  try { console.log('V364_DIAG ' + JSON.stringify({ boundary: 'holder', event, wallMs: Date.now(), ...fields })); } catch {}
};
export default {
  fetch(request, env, ctx) {
    emit('signal-initial', { aborted: request.signal.aborted });
    request.signal.addEventListener('abort', () => emit('signal-abort', { aborted: request.signal.aborted }), { once: true });
    let operation = 0;
    let releaseReads = 0;
    const observedKV = new Proxy(env.OBSERVATIONS, {
      get(target, property) {
        if (property === 'put' || property === 'get') return (...args) => {
          const category = String(args[0]).split(':', 1)[0];
          const id = ++operation;
          const sample = category !== 'release' || property === 'put' || [1, 100, 200, 300].includes(++releaseReads);
          if (sample) emit('kv-invoke', { operation: id, method: property, category, releaseReads });
          // No new KV write, no changed key/value/options, and no replacement promise.
          let task;
          try { task = Reflect.apply(target[property], target, args); }
          catch (error) { emit('kv-throw', { operation: id, method: property, category, errorName: error?.name }); throw error; }
          if (sample) task.then(
            () => emit('kv-fulfilled', { operation: id, method: property, category, releaseReads }),
            error => emit('kv-rejected', { operation: id, method: property, category, errorName: error?.name }),
          );
          return task;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const observedContext = new Proxy(ctx, {
      get(target, property) {
        if (property === 'waitUntil') return task => {
          emit('waitUntil-register');
          // Register the SAME original promise exactly once. Observers add no lifetime task.
          const value = Reflect.apply(target.waitUntil, target, [task]);
          task.then(() => emit('waitUntil-fulfilled'), error => emit('waitUntil-rejected', { errorName: error?.name }));
          return value;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return original.fetch(request, { ...env, OBSERVATIONS: observedKV }, observedContext);
  },
};
