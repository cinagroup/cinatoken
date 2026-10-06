function queuedSourceLogs(caseId) {
  return events.filter(row => row.caseId === caseId && row.kind === 'workerd-log' && row.message.startsWith('V364_QWRITE ')).map(row => ({ ...row, parsed: JSON.parse(row.message.slice('V364_QWRITE '.length)) }));
}
function queuedSendBacklog(f, client) {
  const at = performance.now();
  try {
    const tuple = client.socketTuple();
    assert.equal(tuple.remoteAddress, '127.0.0.1');
    assert.equal(tuple.localAddress, '127.0.0.1');
    assert.equal(tuple.remotePort, Number(f.directURL.port));
    assert.equal(tuple.socketPaused, true);
    const censusBefore = processCensus();
    assert.equal(censusBefore.complete, true);
    const workers = censusBefore.members.filter(row => !['Z', 'X'].includes(row.state) && /^workerd(?:-|$)/u.test(row.comm));
    assert.equal(workers.length, 1, 'Pressure requires one exact owned live Workerd PID');
    const owner = workers[0];
    const beforeStat = parseStat(readFileSync(`/proc/${owner.pid}/stat`, 'utf8'));
    assert.equal(beforeStat.startTimeTicks, owner.startTimeTicks);
    assert.equal(beforeStat.pgrp, censusBefore.pgrp);
    assert.equal(beforeStat.session, censusBefore.session);
    const endpoint = port => '0100007F:' + port.toString(16).toUpperCase().padStart(4, '0');
    const table = readFileSync(`/proc/${owner.pid}/net/tcp`, 'utf8');
    const matches = table.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/u)).filter(fields => fields[1] === endpoint(tuple.remotePort) && fields[2] === endpoint(tuple.localPort) && fields[3] === '01');
    assert.equal(matches.length, 1, 'Pressure requires the exact established server TCP tuple');
    const row = matches[0];
    assert.match(row[4], /^[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}$/u);
    assert.match(row[9], /^[1-9][0-9]*$/u);
    const fds = readdirSync(`/proc/${owner.pid}/fd`).filter(fd => /^[0-9]+$/u.test(fd));
    const socketFDs = fds.filter(fd => {
      try { return readlinkSync(`/proc/${owner.pid}/fd/${fd}`) === `socket:[${row[9]}]`; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    assert.equal(socketFDs.length, 1, 'Server tuple inode must belong to the owned Workerd FD');
    const afterStat = parseStat(readFileSync(`/proc/${owner.pid}/stat`, 'utf8'));
    assert.equal(afterStat.startTimeTicks, beforeStat.startTimeTicks);
    assert.equal(afterStat.pgrp, beforeStat.pgrp);
    assert.equal(afterStat.session, beforeStat.session);
    return { at, known: true, pid: owner.pid, startTimeTicks: owner.startTimeTicks, pgrp: owner.pgrp, session: owner.session, inode: row[9], fd: socketFDs[0], tuple, state: row[3], queueRaw: row[4], txBytes: parseInt(row[4].split(':')[0], 16), rxBytes: parseInt(row[4].split(':')[1], 16), rawTCPRow: row.join(' '), cppPendingWriteProven: false };
  } catch (error) {
    return { at, known: false, error: errorSafe(error), cppPendingWriteProven: false };
  }
}
async function admitQueuedBacklog(caseId, f, client, attemptNonce) {
  await bounded(f.observations.put('queued-trigger:' + attemptNonce, 'yes'), 2000, 'queued diagnostic trigger');
  const samples = [];
  for (let n = 0; n < 100; n++) {
    const sample = queuedSendBacklog(f, client);
    samples.push(sample);
    event(caseId, 'queued-send-backlog-sample', sample);
    const previous = samples.at(-2);
    const enqueued = queuedSourceLogs(caseId).find(row => row.parsed.event === 'queued-enqueue-end' && row.parsed.payloadBytes === 8 * 1024 * 1024 && row.parsed.chunkCount === 128 && row.parsed.chunkBytes === 64 * 1024 && row.parsed.streamClosedBySource === false);
    if (enqueued && previous?.known && sample.known && previous.txBytes > 0 && sample.txBytes > 0 && sample.pid === previous.pid && sample.startTimeTicks === previous.startTimeTicks && sample.inode === previous.inode) return { admitted: true, samples, enqueued, cppPendingWriteProven: false };
    await delay(10);
  }
  return { admitted: false, samples, pressureStatus: 'unknown', cppPendingWriteProven: false };
}
