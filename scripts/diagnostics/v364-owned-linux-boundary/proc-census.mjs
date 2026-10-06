import { readdirSync, readFileSync } from 'node:fs';
export function parseStat(text) {
  const end = text.lastIndexOf(') ');
  if (end < 0) throw new Error('Invalid /proc stat');
  const open = text.indexOf(' (');
  const pid = Number(text.slice(0, open));
  const f = text.slice(end + 2).trim().split(/\s+/u);
  if (!Number.isSafeInteger(pid) || f.length < 20) throw new Error('Incomplete /proc stat');
  return { pid, comm: text.slice(open + 2, end), state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), session: Number(f[3]), startTimeTicks: f[19] };
}
export function processCensus() {
  const self = parseStat(readFileSync('/proc/self/stat', 'utf8'));
  const members = [];
  const unknown = [];
  for (const name of readdirSync('/proc').filter(v => /^\d+$/u.test(v))) {
    try {
      const item = parseStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (item.pgrp === self.pgrp && item.session === self.session) members.push(item);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown.push({ pid: Number(name), code: error.code ?? error.name });
    }
  }
  return { authority: 'observational /proc only; Python owns wait/reap', pgrp: self.pgrp, session: self.session,
    members: members.sort((a, b) => a.pid - b.pid), live: members.filter(v => !['Z', 'X'].includes(v.state)).length,
    zombies: members.filter(v => v.state === 'Z').length, unknown, complete: unknown.length === 0 };
}
