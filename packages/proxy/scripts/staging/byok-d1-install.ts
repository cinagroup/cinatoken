import type { D1Database } from '@cloudflare/workers-types';
import { timingSafeEqual } from 'node:crypto';
import { parseByokD1InstallGrant, parseByokD1InstallReceipt } from './byok-d1-install-contract';
import { captureByokD1CleanupBaseline } from './byok-d1-cleanup';
import { BYOK_D1_FENCE_KEY, BYOK_D1_FENCE_TRIGGERS, byokD1FenceInstallPlan, assertByokD1FenceInstalled } from './byok-d1-write-fence';
import { guardByokD1 } from './byok-d1-guard';

const response = (status: number, code: string) => Response.json({code,retry_safe:false}, {status,headers:{'Cache-Control':'no-store'}});
function check(v: unknown): asserts v { if (!v) throw new Error('byok_install_unconfirmed'); }
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))), b=>b.toString(16).padStart(2,'0')).join('');
const boundedSchema = `SELECT type,name,tbl_name,
  CASE WHEN length(CAST(sql AS BLOB)) <= 16384 THEN sql END AS sql,
  length(CAST(sql AS BLOB)) AS sql_bytes FROM main.sqlite_master
  ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513`;
async function readSchema(db: D1Database) {
  const r=await db.prepare(boundedSchema).all<Record<string,unknown>>();check(r.success&&r.results.length>0&&r.results.length<=512);
  const rows=r.results.map(v=>{
    check(typeof v.type==='string'&&v.type.length<=16&&typeof v.name==='string'&&v.name.length<=128
      &&typeof v.tbl_name==='string'&&v.tbl_name.length<=128);
    check(v.sql_bytes===null&&v.sql===null||typeof v.sql_bytes==='number'&&v.sql_bytes<=16384&&typeof v.sql==='string');
    return {type:v.type,name:v.name,tbl_name:v.tbl_name,sql:v.sql};
  });
  const raw=JSON.stringify(rows);check(new TextEncoder().encode(raw).length<=262144);return {rows,raw};
}

/** Called ONLY after the gateway's native Access + empty-command verification.
 * Registers its own lifetime before hashing or D1 access. Grant comes from
 * frozen deployment vars, never from the request. Native batch installs the
 * fixed fence once; failures never drop/repair/reset/retry it. */
export function installByokD1Fence(request: Request, nativeDb: D1Database, rawGrant: string,
  ctx: Pick<ExecutionContext,'waitUntil'>): Promise<Response> {
  let registered=false;
  const task=Promise.resolve().then(async()=>{
    if(!registered)return response(503,'host_rejected');
    try {
      const grant=parseByokD1InstallGrant(rawGrant),authorization=request.headers.get('Authorization')??'';
      if(!/^Bearer [a-f0-9]{64}$/.test(authorization))return response(403,'forbidden');
      const provided=await sha(authorization.slice(7));
      if(!timingSafeEqual(Uint8Array.from(provided.match(/../g)!,s=>parseInt(s,16)),Uint8Array.from(grant.tokenHash.match(/../g)!,s=>parseInt(s,16))))
        return response(403,'forbidden');
      if(request.signal.aborted)return response(409,'cancelled_before_install');
      const guard=guardByokD1(nativeDb),db=guard.db;
      try {
        const clock=await db.prepare("SELECT unixepoch('now') AS now").all<{now:number}>();
        check(clock.results.length===1);const now=clock.results[0]!.now;
        if(!Number.isSafeInteger(now)||now<grant.issuedAt||now>=grant.expiresAt)return response(409,'grant_not_live');
        await captureByokD1CleanupBaseline(db,grant.schemaSha256);
        const before=await readSchema(db);check(await sha(before.raw)===grant.schemaSha256);
        // Independently derive the only acceptable post-schema before changing
        // anything. A bad post pin must not install an unexpected schema.
        const expected=[...before.rows,...BYOK_D1_FENCE_TRIGGERS.map(t=>({type:'trigger',name:t.name,tbl_name:t.table,sql:t.sql}))]
          .sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
        const expectedRaw=JSON.stringify(expected);
        check(expected.length<=512&&new TextEncoder().encode(expectedRaw).length<=262144);
        check(await sha(expectedRaw)===grant.fencedSchemaSha256);
        const plan=byokD1FenceInstallPlan(before.raw),first=plan[0]!;
        check(plan.length===17&&first.sql.startsWith('SELECT CASE WHEN '));
        first.sql=first.sql.replace('SELECT CASE WHEN ',"SELECT CASE WHEN unixepoch('now') >= ? AND unixepoch('now') < ? AND ");
        first.params.unshift(grant.issuedAt,grant.expiresAt);
        if(request.signal.aborted)return response(409,'cancelled_before_install');
        // The live grant, exact pre-schema, five empty owned tables and absence
        // of old controls/fence are checked IN the same native transaction.
        await db.batch(plan.map(q=>db.prepare(q.sql).bind(...q.params)));
        // Once dispatched, drain and verify even after client disconnect.
        const after=await readSchema(db);check(await sha(after.raw)===grant.fencedSchemaSha256);
        const marker=await db.prepare('SELECT key,value,description FROM system_config WHERE key = ? AND length(CAST(value AS BLOB)) <= 128 AND length(CAST(description AS BLOB)) <= 128')
          .bind(BYOK_D1_FENCE_KEY).all<{key:string;value:string;description:string}>();
        assertByokD1FenceInstalled(after.rows,marker.results);
        const receipt=parseByokD1InstallReceipt({code:'fence_installed',runId:grant.runId,schemaSha256:grant.schemaSha256,
          fencedSchemaSha256:grant.fencedSchemaSha256,triggerCount:15,installStatements:17,closed:true,counters:guard.snapshot()},grant);
        return Response.json(receipt,{headers:{'Cache-Control':'no-store'}});
      }finally{guard.seal();}
    }catch{return response(503,'install_unconfirmed');}
  });
  try{ctx.waitUntil(task.then(()=>{}));registered=true;}catch{/* no native I/O */}
  return task;
}
