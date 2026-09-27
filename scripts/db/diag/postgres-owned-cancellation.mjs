import { readFile,mkdir,mkdtemp } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build,version as esbuildVersion } from 'esbuild';
import { sourcePins,sha256,retireCompletedScopes,retireWriteFailures } from './postgres-transaction-retirement.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
export const queryPins=Object.freeze({esm:'67c45a5151032aa46b587abc15381fe4efd97c696e5c1b53082b8161309c4ee2',cjs:'75ae9c69a1aaf3be4d8d65e4742c36018b89594907b85769e560c2590716c109',cf:'67c45a5151032aa46b587abc15381fe4efd97c696e5c1b53082b8161309c4ee2'});
function replace(source,before,after){if(source.split(before).length!==2)throw new Error('Non-unique owned cancellation anchor');return source.replace(before,after);}

// These closures are embedded inside the pinned driver modules. They deliberately expose
// no PID/secret/host/SQL and never equate a cancellation result with the primary query.
export function createCancellationRecord(){
  let resultState='pending',closeState='pending',transportRawState='pending',primaryState='pending',rawState='pending',yes,no,closed,transportRawClosedResolve,primaryClosed,rawClosed;
  const result=new Promise((resolve,reject)=>{yes=resolve;no=reject;});
  const transportClosed=new Promise(resolve=>{closed=resolve;});
  const transportRawClosed=new Promise(resolve=>{transportRawClosedResolve=resolve;});
  const primaryCloseObserved=new Promise(resolve=>{primaryClosed=resolve;});
  const primaryRawClosed=new Promise(resolve=>{rawClosed=resolve;});
  void result.catch(()=>{});
  const handle=Object.freeze({result,transportClosed,transportRawClosed,primaryCloseObserved,primaryRawClosed,
    snapshot:()=>Object.freeze({result:resultState,transportClose:closeState,transportRawClose:transportRawState,primaryClose:primaryState,primaryRawClose:rawState})});
  function complete(status){if(resultState==='pending'){resultState=status;yes(Object.freeze({status}));}}
  function close(status='close_observed'){if(closeState==='pending'){closeState=status;closed(Object.freeze({status}));}}
  function transportRawClose(status){if(transportRawState==='pending'){transportRawState=status;transportRawClosedResolve(Object.freeze({status}));}}
  function primaryClose(status='close_observed'){if(primaryState==='pending'){primaryState=status;primaryClosed(Object.freeze({status}));}}
  function primaryRawClose(status){if(rawState==='pending'){rawState=status;rawClosed(Object.freeze({status}));}}
  function observeRawClose(promise){
    if(!promise||typeof promise.then!=='function')return primaryRawClose('not_observable');
    void Promise.resolve(promise).then(()=>primaryRawClose('raw_closed'),()=>primaryRawClose('raw_close_rejected'));
  }
  function observeTransportRawClose(promise){
    if(!promise||typeof promise.then!=='function')return transportRawClose('not_observable');
    void Promise.resolve(promise).then(()=>transportRawClose('raw_closed'),()=>transportRawClose('raw_close_rejected'));
  }
  return {handle,complete,close,observeTransportRawClose,primaryClose,observeRawClose,noTransportSocket(){close('not_started');transportRawClose('not_started');},skip(status){complete(status);close('not_started');transportRawClose('not_started');primaryClose('not_started');primaryRawClose('not_started');},fail(){
    if(resultState!=='pending')return;
    resultState='failed';const error=new Error('Owned cancellation transport failed');error.code='CANCEL_TRANSPORT_FAILED';no(error);
  }};
}

// Embedded in Postgres(), where queries, Errors and the record helper are in scope.
function ownCancellation(query){
  const record=createCancellationRecord();
  if(query.options.owned_cancel!==true){record.skip('unsupported');return record.handle;}
  if(query.ownedSettled){record.skip('already_settled');return record.handle;}
  if(query.ownedCancelTarget)return query.ownedCancelTarget(record);
  if(query.state){record.skip('not_exclusive');return record.handle;}
  query.cancelled=true;
  query.ownedCancelRemove ? query.ownedCancelRemove() : queries.remove(query);
  query.reject(Errors.generic('57014','canceling statement before dispatch'));
  record.skip('not_dispatched');return record.handle;
}

function unsupportedOwnedMode(q){
  if(q.options.owned_cancel!==true||!(q.cursorFn||q.streaming||q.onlyDescribe||q.forEachFn))return false;
  q.reject(Errors.generic('CANCELLATION_UNSUPPORTED_MODE','Owned cancellation requires a non-streaming statement'));
  return true;
}

// Embedded inside Connection(). This path is not an application cleanup receipt. Once a
// network cancellation is admitted, the primary physical session is never reused
// for later SQL. A pre-write local rejection instead sends Sync and may reuse it.
function ownCancellationTarget(q,record,targetSocket,endpoint){
  if(q!==query||q.ownedSettled||socket!==targetSocket||cancelRetiring){record.skip('already_settled');return record.handle;}
  if(sent.length||q.options.owned_cancel!==true){record.skip('not_exclusive');return record.handle;}
  // build()/toBuffer() may call user debug/serializer code synchronously. Until
  // the primary write is entered, a cancel must suppress that SQL locally;
  // sending a cancel packet first would race the very query it should stop.
  if(dispatching.has(q)){
    q.ownedPreDispatchCancelled=true;
    q.cancelled=true;
    q.reject(Errors.generic('57014','canceling statement before dispatch'));
    record.skip('not_dispatched');return record.handle;
  }
  if(host.length!==1||port.length!==1){record.skip('not_exclusive');return record.handle;}
  const target=socket,identity=Object.freeze({pid:backend.pid,secret:backend.secret});
  if(!Number.isInteger(identity.pid)||!Number.isInteger(identity.secret)){record.skip('identity_unavailable');return record.handle;}
  cancelRetiring=true;
  primaryCancelRecord=record;
  // The native Workers Socket.closed promise is stronger than the postgres.js
  // polyfill's close event; a rejected/absent promise is never a release receipt.
  record.observeRawClose(target.raw?.closed);
  if(connection.queue&&queues.full&&connection.queue!==queues.full){connection.queue.remove(connection);queues.full.push(connection);connection.queue=queues.full;idleTimer.cancel();}
  const transport=Connection({...options,host:[endpoint.host],port:[endpoint.port],path:endpoint.path,socket:endpoint.socket,ssl:endpoint.ssl,max_lifetime:0,idle_timeout:0,fetch_types:false});
  transport.ownedCancelTransport(identity,record,()=>socket===target&&query===q&&!q.ownedSettled);
  return record.handle;
}

function ownedCancelTransport(identity,record,current){
  cancelRecord=record;cancelCurrent=current;
  cancelMessage=b().i32(16).i32(80877102).i32(identity.pid).i32(identity.secret).end(16);
  // Observe the complete setup path, including a synchronous/async socket factory failure.
  void connect().then(()=>{if(!socket)record.noTransportSocket();},()=>{record.fail();if(!socket)record.noTransportSocket();else try{socket.destroy();}catch{}});
}

export function ownedCancellationSources(original,variant){
  const pin=sourcePins[variant];
  if(!pin||sha256(original.index)!==pin.sha256||sha256(original.connection)!==pin.connection||sha256(original.query)!==queryPins[variant])throw new Error('Unsupported owned cancellation sources');
  let index=retireCompletedScopes(original.index,variant),connection=retireWriteFailures(original.connection,variant),query=original.query;
  query=replace(query,'    this.canceller = canceller','    this.canceller = canceller\n    this.ownedCanceller = canceller\n    this.ownedSettled = false');
  query=replace(query,'this.active = false, resolve(x)','this.active = false, this.ownedSettled = true, resolve(x)');
  query=replace(query,'this.reject = x => (this.active = false, reject(x))\n\n    this.active = false','this.reject = x => (this.active = false, this.ownedSettled = true, reject(x))\n\n    this.active = false');
  query=replace(query,'  cancel() {\n','  cancelOwned() {\n    if (!this.ownedCancellation) this.ownedCancellation = this.ownedCanceller(this, true)\n    return this.ownedCancellation\n  }\n\n  cancel() {\n    if (this.options.owned_cancel === true) return this.cancelOwned().result\n');
  // Cancelling a lazy query must not start it merely to attach a rejection observer.
  query=replace(query,'!this.executed && (this.executed = true) && await 1 && this.handler(this)','!this.executed && !this.cancelled && (this.executed = true) && await 1 && !this.cancelled && this.handler(this)');
  index=replace(index,'      types: typed,','      ownedCancellation: \'postgres-js-3.4.9-owned-cancel-v302\',\n      ownedRecoveryScanFence: \'postgres-js-3.4.9-owned-scan-v307\',\n      types: typed,');
  index=replace(index,'  function cancel(query) {',createCancellationRecord.toString()+'\n'+ownCancellation.toString()+'\n'+unsupportedOwnedMode.toString()+'\n  function cancel(query, owned = false) {\n    if (owned) return ownCancellation(query)');
  index=replace(index,'  function handler(query) {\n',
    "  function shutdownError() {\n    return Errors.generic('CONNECTION_ENDED', 'Connection ended before dispatch')\n  }\n\n  function rejectLocalQueue(queue) {\n    while (queue.length) queue.shift().reject(shutdownError())\n  }\n\n  function rejectPendingOnEnd() {\n    while (queries.length) queries.shift().reject(shutdownError())\n  }\n\n  function handler(query) {\n    if (query.cancelled || unsupportedOwnedMode(query)) return\n");
  index=replace(index,'  async function reserve() {\n','  async function reserve() {\n    if (ending) throw shutdownError()\n');
  index=replace(index,'    move(c, reserved)\n    c.reserved = () => queue.length\n      ? c.execute(queue.shift())\n      : move(c, reserved)\n    c.reserved.release = true',
    '    if (ending) { void c.end(true); throw shutdownError() }\n    move(c, reserved)\n    c.reserved = () => ending\n      ? rejectLocalQueue(queue)\n      : queue.length\n        ? c.execute(queue.shift())\n        : move(c, reserved)\n    c.reserved.release = true\n    c.reserved.shutdown = () => { rejectLocalQueue(queue); c.reserved = null }');
  index=replace(index,'    sql.release = () => {\n      c.reserved = null\n      onopen(c)\n    }',
    '    sql.release = () => {\n      if (ending) rejectLocalQueue(queue)\n      c.reserved = null\n      onopen(c)\n    }');
  index=replace(index,'    function handler(q) {\n      c.queue === full',
    '    function handler(q) {\n      if (ending) return q.reject(shutdownError())\n      c.queue === full');
  index=replace(index,'        ? queue.push(q)\n        : c.execute(q) || move(c, full)',
    '        ? queue.push(q)\n        : c.execute(q) || (!ending && move(c, full))');
  index=replace(index,'      function handler(q, internal = false) {\n',
    '      function handler(q, internal = false) {\n        if (ending) { q.catch(() => {}); return q.reject(shutdownError()) }\n');
  index=replace(index,'          ? queries.push(q)\n          : c.execute(q) || move(c, full)',
    '          ? queries.push(q)\n          : c.execute(q) || (!ending && move(c, full))');
  index=replace(index,'      c.reserved = () => queries.length\n        ? c.execute(queries.shift())\n        : move(c, reserved)',
    '      c.reserved = () => ending\n        ? rejectLocalQueue(queries)\n        : queries.length\n          ? c.execute(queries.shift())\n          : move(c, reserved)\n      c.reserved.shutdown = () => { rejectLocalQueue(queries); c.reserved = null }');
  index=replace(index,'      } catch (e) {\n        await (name',
    '      } catch (e) {\n        if (ending) throw e\n        await (name');
  index=replace(index,'      if (!name) {\n        prepare',
    '      if (!name) {\n        if (ending) throw shutdownError()\n        prepare');
  index=replace(index,'  async function listen(name, fn, onlisten) {\n',
    '  async function listen(name, fn, onlisten) {\n    if (ending) throw shutdownError()\n');
  index=replace(index,"if (ending)\n      return query.reject(Errors.connection('CONNECTION_ENDED', options, options))",
    "if (ending)\n      return query.reject(shutdownError())");
  index=replace(index,'    await 1\n    let timer\n    return ending = Promise.race([',
    '    let resolveEnding, rejectEnding\n    ending = new Promise((resolve, reject) => { resolveEnding = resolve; rejectEnding = reject })\n    rejectPendingOnEnd()\n    const connectionEnds = connections.map(c => {\n      try { return c.end(true) } catch (error) { return Promise.reject(error) }\n    })\n    let timer\n    void Promise.race([');
  index=replace(index,'Promise.all(connections.map(c => c.end()).concat(',
    'Promise.all(connectionEnds.concat(');
  index=replace(index,'    ]).then(() => clearTimeout(timer))\n  }\n\n  async function close()',
    '    ]).then(\n      value => { clearTimeout(timer); resolveEnding(value) },\n      error => { clearTimeout(timer); rejectEnding(error) }\n    )\n    return ending\n  }\n\n  async function close()');
  index=replace(index,'  function onopen(c) {\n','  function onopen(c) {\n    if (ending) return void c.end(true)\n');
  index=replace(index,'  function onclose(c, e) {\n    move(c, closed)',
    '  function onclose(c, e) {\n    move(c, ending ? ended : closed)');
  index=replace(index,'    queries.length && connect(c, queries.shift())',
    '    !ending && queries.length && connect(c, queries.shift())');
  index=replace(index,'    busy.length\n      ? go(busy.shift(), query)','    busy.length && query.options.owned_cancel !== true\n      ? go(busy.shift(), query)');
  index=replace(index,'  function go(c, query) {\n    return c.execute(query)\n      ? move(c, busy)\n      : move(c, full)\n  }',
    '  function go(c, query) {\n    const ready = c.execute(query)\n    if (ending) return\n    return ready ? move(c, busy) : move(c, full)\n  }');
  index=replace(index,'      function handler(q, internal = false) {\n','      function handler(q, internal = false) {\n        if (q.cancelled || unsupportedOwnedMode(q)) return\n        q.ownedCancelRemove = () => queries.remove(q)\n');
  index=replace(index,'    function handler(q) {\n      if (ending) return q.reject(shutdownError())\n      c.queue === full','    function handler(q) {\n      if (ending) return q.reject(shutdownError())\n      if (q.options.owned_cancel === true) return q.reject(Errors.generic(\'CANCELLATION_UNSUPPORTED_RESERVED\', \'Owned cancellation is not supported on reserve handles\'))\n      c.queue === full');
  connection=replace(connection,'    , writeFailure = null','    , writeFailure = null\n    , cancelRetiring = false\n    , cancelRecord = null\n    , primaryCancelRecord = null\n    , cancelCurrent = null\n    , cancelEndpoint = null\n    , poolShutdown = false\n    , dispatching = new Set()\n    , shutdownReceipts = new Set()\n    , shutdownRawCloseRequested = new WeakSet()\n    , shutdownCloseFailed = false');
  connection=replace(connection,'      initial = query\n      reconnect()','      initial = query\n      query.ownedCancelRemove = () => { if (initial === query) initial = null }\n      reconnect()');
  connection=replace(connection,'    cancel,\n    end,','    cancel,\n    ownedCancelTransport,\n    end,');
  connection=replace(connection,'  async function createSocket() {',
    ownCancellationTarget.toString()+'\n'+ownedCancelTransport.toString()+`
  function shutdownError() {
    return Errors.generic('CONNECTION_ENDED', 'Connection ended before dispatch')
  }

  function failShutdownReceipts() {
    shutdownCloseFailed = true
    for (const receipt of shutdownReceipts) receipt.fail()
  }

  function closeShutdownSocket(candidate) {
    if (!candidate) return
    if (candidate.raw) {
      const raw = candidate.raw
      for (const receipt of shutdownReceipts) receipt.observeRaw(raw)
      if (typeof raw.close !== 'function' || shutdownRawCloseRequested.has(raw)) return
      shutdownRawCloseRequested.add(raw)
      try { void Promise.resolve(raw.close()).catch(failShutdownReceipts) }
      catch { failShutdownReceipts() }
      return
    }
    // The CF wrapper has raw:null before its async connect; destroy() would throw.
    if ('raw' in candidate) return
    try { candidate.destroy() } catch { failShutdownReceipts() }
  }

  function shutdownCloseReceipt(candidate) {
    if (shutdownCloseFailed) return Promise.reject(Errors.generic('CONNECTION_CLOSE_UNCONFIRMED', 'Physical socket close unconfirmed'))
    if (!candidate || candidate.readyState === 'closed') return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      let observedRaw = null
      const closeError = () => Errors.generic('CONNECTION_CLOSE_UNCONFIRMED', 'Physical socket close unconfirmed')
      const onClose = () => finish()
      const finish = error => {
        if (settled) return
        settled = true
        candidate.removeListener('close', onClose)
        shutdownReceipts.delete(receipt)
        error ? reject(error) : resolve()
      }
      const fail = () => finish(closeError())
      const observeRaw = raw => {
        if (!poolShutdown || !raw || observedRaw === raw) return
        observedRaw = raw
        if (raw.closed && typeof raw.closed.then === 'function') {
          void Promise.resolve(raw.closed).then(() => finish(), fail)
        }
      }
      const receipt = { fail, observeRaw }
      shutdownReceipts.add(receipt)
      candidate.once('close', onClose)
      observeRaw(candidate.raw)
    })
  }

  async function createSocket() {`);
  connection=replace(connection,'  function execute(q) {\n','  function execute(q) {\n    if (poolShutdown) return q.reject(shutdownError())\n    if (cancelRetiring) return queryError(q, Errors.generic(\'CANCEL_TARGET_RETIRED\', \'Cancelled connection is retired\'))\n    if (q.options.owned_cancel === true && (q.cursorFn || q.streaming || q.onlyDescribe || q.forEachFn)) return queryError(q, Errors.generic(\'CANCELLATION_UNSUPPORTED_MODE\', \'Owned cancellation requires a non-streaming statement\'))\n    if (q.options.owned_cancel === true && query) return queryError(q, Errors.generic(\'CANCEL_EXCLUSIVITY_REQUIRED\', \'Owned cancellation requires an exclusive statement\'))\n');
  connection=replace(connection,'      build(q)\n','      dispatching.add(q)\n      if (q.options.owned_cancel === true) {\n        const target = socket, endpoint = cancelEndpoint\n        q.ownedCancelTarget = record => ownCancellationTarget(q, record, target, endpoint)\n      }\n      build(q)\n      if (poolShutdown) { dispatching.delete(q); return true }\n      if (q.ownedPreDispatchCancelled) { dispatching.delete(q); return write(Sync) }\n');
  connection=replace(connection,'      const writable = write(toBuffer(q))',
    '      const encoded = toBuffer(q)\n      dispatching.delete(q)\n      if (poolShutdown) return true\n      if (q.ownedPreDispatchCancelled) return write(Sync)\n      const writable = write(encoded)');
  connection=replace(connection,'    } catch (error) {\n      sent.length === 0 && write(Sync)',
    '    } catch (error) {\n      dispatching.delete(q)\n      if (poolShutdown) return true\n      if (q.ownedPreDispatchCancelled) return write(Sync)\n      sent.length === 0 && write(Sync)');
  connection=replace(connection,'        && writable\n        && sent.length < max_pipeline','        && q.options.owned_cancel !== true\n        && writable\n        && sent.length < max_pipeline');
  connection=replace(connection,'    !writeFailure && !query && !connection.reserved && onopen(connection)','    !cancelRetiring && !writeFailure && !query && !connection.reserved && onopen(connection)');
  connection=replace(connection,'      writeFailure = null\n','      writeFailure = null\n      cancelRetiring = false\n');
  connection=replace(connection,'    if (!socket) {\n      socket = await createSocket()','    if (!socket) {\n      cancelEndpoint = Object.freeze({ host: host[hostIndex], port: port[hostIndex], path: options.path, socket: options.socket, ssl })\n      socket = await createSocket()');
  connection=replace(connection,'    if (options.path)\n      return socket.connect(options.path)','    if (cancelEndpoint.path)\n      return socket.connect(cancelEndpoint.path)');
  connection=replace(connection,'    socket.connect(port[hostIndex], host[hostIndex])\n    socket.host = host[hostIndex]\n    socket.port = port[hostIndex]','    socket.connect(cancelEndpoint.port, cancelEndpoint.host)\n    socket.host = cancelEndpoint.host\n    socket.port = cancelEndpoint.port');
  connection=replace(connection,'  function connected() {\n    try {','  function connected() {\n    if (poolShutdown) { closeShutdownSocket(socket); return }\n    if (cancelRecord && !cancelCurrent()) {\n      cancelRecord.complete(\'target_finished\')\n      try { socket.destroy() } catch { cancelRecord.fail() }\n      return\n    }\n    try {');
  connection=replace(connection,'  async function connect() {\n    terminated = false','  async function connect() {\n    if (poolShutdown) return\n    terminated = false');
  connection=replace(connection,'    if (!socket)\n      return\n\n    connectTimer.start()',
    '    if (poolShutdown) { closeShutdownSocket(socket); return }\n    if (!socket)\n      return\n\n    connectTimer.start()');
  connection=replace(connection,'  function reconnect() {\n    setTimeout(connect,','  function reconnect() {\n    if (poolShutdown) return\n    setTimeout(connect,');
  connection=replace(connection,'  async function secure() {\n','  async function secure() {\n    if (poolShutdown) { closeShutdownSocket(socket); return }\n');
  connection=replace(connection,'      const canSSL = await new Promise(r => socket.once(\'data\', x => r(x[0] === 83))) // S',
    '      const canSSL = await new Promise(r => socket.once(\'data\', x => r(x[0] === 83))) // S\n      if (poolShutdown) { closeShutdownSocket(socket); return }');
  connection=replace(connection,'  function errored(err) {\n','  function errored(err) {\n    if (cancelRecord) cancelRecord.fail()\n');
  connection=replace(connection,'    if (!pending) return true\n    try {','    if (!pending) return true\n    if (cancelRecord && !cancelCurrent()) {\n      cancelRecord.complete(\'target_finished\')\n      try { socket.destroy() } catch {}\n      return false\n    }\n    try {');
  connection=replace(connection,'  function data(x) {\n','  function data(x) {\n    if (cancelRecord) { cancelRecord.fail(); try { socket.destroy() } catch {} return }\n');
  connection=replace(connection,'  function end() {\n    return ending || (',
    '  function end(poolEnd = false) {\n    if (poolEnd) {\n      poolShutdown = true\n      connectTimer.cancel()\n      if (initial) { initial.reject(shutdownError()); initial = null }\n      if (connection.reserved?.shutdown) connection.reserved.shutdown()\n      for (const pending of dispatching) {\n        if (query === pending) query = null\n        else sent.remove(pending)\n        pending.reject(shutdownError())\n      }\n      dispatching.clear()\n      if (ending && !query && sent.length === 0) terminate()\n    }\n    if (cancelRetiring && !socket) {\n      !connection.reserved && onend(connection)\n      terminate()\n      return Promise.resolve()\n    }\n    return ending || (');
  connection=replace(connection,"      socket.readyState === 'open' && socket.end(b().X().end())",
    "      if (poolShutdown && socket.readyState !== 'open') closeShutdownSocket(socket)\n      else socket.readyState === 'open' && socket.end(b().X().end())");
  connection=replace(connection,"? (terminate(), new Promise(r => socket && socket.readyState !== 'closed' ? socket.once('close', r) : r()))",
    '? (() => { const receipt = shutdownCloseReceipt(socket); terminate(); return receipt })()');
  connection=replace(connection,'    if (initial) {\n      if (target_session_attrs)',
    '    if (initial) {\n      if (poolShutdown) { initial.reject(shutdownError()); initial = null; terminate(); return }\n      if (target_session_attrs)');
  connection=replace(connection,'        return fetchArrayTypes()',
    '        void fetchArrayTypes().catch(error => { if (!poolShutdown) errored(error) })\n        return');
  connection=replace(connection,'    query.execute()\n  }\n\n  function ErrorResponse(x)',
    '    void query.catch(() => {})\n    query.execute()\n  }\n\n  function ErrorResponse(x)');
  connection=replace(connection,'    connection.reserved\n      ? !connection.reserved.release',
    '    if (poolShutdown) return terminate()\n\n    connection.reserved\n      ? !connection.reserved.release');
  connection=replace(connection,'    query.describeFirst && !query.onlyDescribe && (write(prepared(query)), query.describeFirst = false)','    if (poolShutdown && query.describeFirst) {\n      query.describeFirst = false\n      query.reject(shutdownError())\n      write(Sync)\n      return\n    }\n    if (cancelRetiring && query.describeFirst) {\n      query.reject(Errors.generic(\'57014\', \'cancelled before parameter execution\'))\n      write(Sync)\n      return\n    }\n    if (query.describeFirst && !query.onlyDescribe) {\n      const binding = query\n      dispatching.add(binding)\n      let encoded\n      try { encoded = prepared(binding) }\n      catch (error) {\n        dispatching.delete(binding)\n        if (poolShutdown) return\n        if (binding.ownedPreDispatchCancelled) {\n          binding.describeFirst = false\n          write(Sync)\n          return\n        }\n        throw error\n      }\n      dispatching.delete(binding)\n      if (poolShutdown || query !== binding) return\n      if (binding.ownedPreDispatchCancelled) {\n        binding.describeFirst = false\n        write(Sync)\n        return\n      }\n      write(encoded)\n      binding.describeFirst = false\n    }');
  connection=replace(connection,'  async function closed(hadError) {\n','  async function closed(hadError) {\n    const closingSocket = socket\n    if (cancelRecord) {\n      hadError ? cancelRecord.fail() : cancelRecord.complete(\'transport_closed\')\n      cancelRecord.close()\n      cancelRecord.observeTransportRawClose(closingSocket?.raw?.closed)\n    }\n    if (primaryCancelRecord) {\n      primaryCancelRecord.primaryClose()\n      primaryCancelRecord = null\n    }\n');
  connection=replace(connection,'    socket = null\n\n    if (initial)',
    '    socket = null\n\n    if (cancelRetiring && ending) terminate()\n    if (poolShutdown) {\n      if (initial) { initial.reject(shutdownError()); initial = null }\n      terminate()\n      return\n    }\n\n    if (initial)');
  if(variant==='cf'){
    connection=replace(connection,'    socket.connect(cancelEndpoint.port, cancelEndpoint.host)\n    socket.host = cancelEndpoint.host',
      '    const connectingSocket = socket\n    const connectAttempt = socket.connect(cancelEndpoint.port, cancelEndpoint.host)\n    if (connectAttempt && typeof connectAttempt.then === \'function\') {\n      void Promise.resolve(connectAttempt).then(\n        () => { if (poolShutdown) closeShutdownSocket(connectingSocket) },\n        () => { if (poolShutdown) closeShutdownSocket(connectingSocket) }\n      )\n    }\n    socket.host = cancelEndpoint.host');
    connection=replace(connection,'  async function closed(hadError) {\n','  async function closed(hadError) {\n    const retiringSocket = cancelRetiring ? socket : null\n    const retiringRaw = retiringSocket?.raw\n    const cancelRaw = cancelRecord ? socket?.raw : null\n    if (cancelRaw?.closed && typeof cancelRaw.closed.then === \'function\' && socket.readyState !== \'closed\' && typeof cancelRaw.close === \'function\') {\n      try { void Promise.resolve(cancelRaw.close()).catch(() => {}) } catch {}\n    }\n');
    connection=replace(connection,"    onclose(connection, Errors.connection('CONNECTION_CLOSED', options, socket))",
      "    if (cancelRetiring) {\n      // The CF postgres.js polyfill can emit close before raw.closed settles.\n      // Keep the old pool slot quarantined; only a fulfilled raw.closed may\n      // open a fresh logical connection. Rejection/absence retains the hold.\n      if (!retiringRaw?.closed || typeof retiringRaw.closed.then !== 'function') return\n      if (retiringSocket.readyState !== 'closed' && typeof retiringRaw.close === 'function') {\n        try { void Promise.resolve(retiringRaw.close()).catch(() => {}) } catch {}\n      }\n      void Promise.resolve(retiringRaw.closed).then(\n        () => {\n          // end()/terminate() may finish while raw.closed is still pending.\n          if (!terminated && connection.queue !== queues.ended)\n            onclose(connection, Errors.connection('CONNECTION_CLOSED', options, socket))\n        },\n        () => {}\n      )\n      return\n    }\n    onclose(connection, Errors.connection('CONNECTION_CLOSED', options, socket))");
  }
  connection=replace(connection,'    connectTimer.cancel()\n\n    if (initial) {','    connectTimer.cancel()\n\n    if (cancelRetiring) {\n      try { socket.destroy() } catch (_) { /* No physical close receipt; stays quarantined. */ }\n      return\n    }\n\n    if (initial) {');
  return {index,connection,query};
}

export async function buildOwnedCancellationCandidates(){
  const pkg=JSON.parse(await readFile(join(root,'node_modules/postgres/package.json'),'utf8'));
  if(pkg.version!=='3.4.9'||esbuildVersion!=='0.27.3')throw new Error('Unsupported cancellation build versions');
  const sources={};
  for(const [variant,pin] of Object.entries(sourcePins)){
    const directory=dirname(join(root,'node_modules/postgres',pin.entry));
    const original={};for(const kind of ['index','connection','query'])original[kind]=await readFile(join(directory,kind+'.js'),'utf8');
    sources[variant]=ownedCancellationSources(original,variant);
  }
  await mkdir(join(root,'.wrangler/staging'),{recursive:true});
  const directory=await mkdtemp(join(root,'.wrangler/staging/postgres-owned-cancel-v302-')),artifacts={};
  for(const [variant,pin] of Object.entries(sourcePins)){
    const entry=join(root,'node_modules/postgres',pin.entry),outfile=join(directory,'postgres-'+variant+(variant==='cjs'?'.cjs':'.mjs'));let transformed=0;
    const result=await build({absWorkingDir:root,entryPoints:[entry],outfile,bundle:true,metafile:true,platform:variant==='cf'?'neutral':'node',format:variant==='cjs'?'cjs':'esm',
      target:'es2022',external:['node:*','cloudflare:sockets'],logLevel:'silent',banner:{js:'// LOCAL DEFAULT-DISABLED EVALUATION: postgres.js 3.4.9 (Unlicense), v302 owned cancellation.'},
      plugins:[{name:'owned-cancellation',setup(builder){builder.onLoad({filter:/(?:index|connection|query)\.js$/},args=>{
        const kind=['index','connection','query'].find(name=>resolve(args.path)===resolve(dirname(entry),name+'.js'));
        if(!kind)return;transformed++;return {contents:sources[variant][kind],loader:'js'};
      });}}]});
    if(transformed!==3)throw new Error('Expected three pinned transforms');
    const inputs={};for(const name of Object.keys(result.metafile.inputs).sort())inputs[name]=sha256(await readFile(resolve(root,name)));
    artifacts[variant]={path:outfile,sha256:sha256(await readFile(outfile)),inputs};
  }
  return {directory,artifacts};
}
