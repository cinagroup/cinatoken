import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SOURCE_PINS_V400 = Object.freeze({
  routing: '4d4d9fcfc71d32fc9c814cd4dfe008ba8ebc2e8c1561298331dd9231d2ce9763',
  sticky: 'f4a34bad4aee4343b3bce308abd4946c866d577727dd245a157049d7bdb1297d',
  auth: '4fb71cebf2814283a01733d4f8219524f6f6f8c4ec89f3ac0f9e3ecb6e7ab805',
  response: 'a8ae8c1e7cecc05922b907558da34ce3ffe271a8aad79c2490a5631cf0901590',
  grant: 'c9eb17e019dc1bbeeb7d4269cb1c2ce6b8861fab37e2bfed8ac3a8a97ce2d4f7',
});
const root = new URL('../../../', import.meta.url);
const owner = 'cinatoken_gateway_migrator';
const sha = text => createHash('sha256').update(text).digest('hex');
const md5 = text => createHash('md5').update(text.replaceAll('\r\n', '\n')).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = (rows, key) => [...rows].sort((a, b) => compare(key(a), key(b)));
const aclOrder = rows => order(rows, x => `${x.grantee}\0${x.privilege}\0${x.grantor}\0${x.grantable}`);
export const BASELINE_RAW_SHA256_V400 = '24ca20e8883d11688a1469d1b1f40fc0a915c16081084362c14e9fde3fe28f38';
export const BASELINE_CANONICAL_SHA256_V400 = '3b2518407d868758acde6ec6dc9f22bf58b3545399fe8ddcb7f815494444e0d6';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])]));
  return value;
}
export const catalogDigestV400 = catalog => sha(JSON.stringify(canonical(catalog)));
export function assertSelectedBaselineV400(baseline) {
  if (catalogDigestV400(baseline) !== BASELINE_CANONICAL_SHA256_V400) throw new Error('v400 selected baseline catalog differs');
}

/** Shared read-only capture. Passwords, relation data and Provider values are absent. */
export const CATALOG_QUERY_V400 = `SELECT jsonb_build_object(
 'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'language',l.lanname,
  'kind',p.prokind,'returns_set',p.proretset,'parallel',p.proparallel,'strict',p.proisstrict,'leakproof',p.proleakproof,
  'security_definer',p.prosecdef,'volatility',p.provolatile,'return_type',p.prorettype::regtype::text,
  'arguments',pg_get_function_arguments(p.oid),'result_definition',pg_get_function_result(p.oid),
  'config',to_jsonb(p.proconfig),'body_md5',md5(replace(p.prosrc,E'\\r\\n',E'\\n')),
  'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
   ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C")
   FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)) ORDER BY p.oid::regprocedure::text COLLATE "C")
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname LIKE 'cinatoken_%' OR p.proowner=(SELECT oid FROM pg_roles WHERE rolname='cinatoken_gateway_migrator')),'[]'::jsonb),
 'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'name',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
   ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C")
   FROM aclexplode(COALESCE(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::"char",c.relowner))) a),
  'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
   'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,
   'acl',COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
    'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable)
    ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END) COLLATE "C",x.privilege_type COLLATE "C") FROM aclexplode(a.attacl) x),'[]'::jsonb)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
  'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'deferrable',x.condeferrable,
   'initially_deferred',x.condeferred,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname COLLATE "C")
   FROM pg_constraint x WHERE x.conrelid=c.oid),'[]'::jsonb),
  'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',x.rulename,'enabled',x.ev_enabled,'definition',pg_get_ruledef(x.oid)) ORDER BY x.rulename COLLATE "C")
   FROM pg_rewrite x WHERE x.ev_class=c.oid),'[]'::jsonb)) ORDER BY c.oid::regclass::text COLLATE "C")
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname LIKE 'cinatoken_%' OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname='cinatoken_gateway_migrator')) AND c.relkind IN('r','p','v','m','f','S')),'[]'::jsonb),
 'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,
  'function',t.tgfoid::regprocedure::text,'enabled',t.tgenabled,'type',t.tgtype,'qual',t.tgqual::text,'columns',t.tgattr::text,
  'arguments',encode(t.tgargs,'hex'),'argument_count',t.tgnargs,'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred,
  'old_table',t.tgoldtable,'new_table',t.tgnewtable,'constraint',t.tgconstraint<>0,'constraint_table',CASE WHEN t.tgconstrrelid=0 THEN NULL ELSE t.tgconstrrelid::regclass::text END,
  'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text COLLATE "C",t.tgname COLLATE "C")
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'cinatoken_%' AND NOT t.tgisinternal),'[]'::jsonb),
 'schemas',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),
  'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
   ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C")
   FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a)) ORDER BY n.nspname COLLATE "C") FROM pg_namespace n WHERE n.nspname LIKE 'cinatoken_%'),'[]'::jsonb),
 'principals',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',r.rolname,'login',r.rolcanlogin,'inherit',r.rolinherit,
  'super',r.rolsuper,'create_role',r.rolcreaterole,'create_database',r.rolcreatedb,'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,
  'connection_limit',r.rolconnlimit,'config',to_jsonb(r.rolconfig),
  'database_create',has_database_privilege(r.oid,current_database(),'CREATE'),'public_create',has_schema_privilege(r.oid,'public','CREATE'),
  'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),
   'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
   ORDER BY pg_get_userbyid(m.roleid) COLLATE "C",pg_get_userbyid(m.member) COLLATE "C") FROM pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid),'[]'::jsonb))
  ORDER BY r.rolname COLLATE "C") FROM pg_roles r WHERE r.rolname LIKE 'cinatoken_%'),'[]'::jsonb),
 'defaults',COALESCE((SELECT jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'schema',CASE WHEN d.defaclnamespace=0 THEN NULL ELSE n.nspname END,
  'type',d.defaclobjtype,'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
   ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C") FROM aclexplode(d.defaclacl) a))
  ORDER BY pg_get_userbyid(d.defaclrole) COLLATE "C",COALESCE(n.nspname,'') COLLATE "C",d.defaclobjtype)
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='cinatoken_gateway_migrator')),'[]'::jsonb)
) AS catalog`;

export async function captureCatalogV400(sql) {
  return await sql.begin(async tx => {
    await tx.unsafe('SET LOCAL search_path TO pg_catalog,pg_temp');
    const rows = await tx.unsafe(CATALOG_QUERY_V400);
    if (rows.length !== 1 || !rows[0].catalog) throw new Error('v400 catalog capture differs');
    return rows[0].catalog;
  });
}

export function extractFrozenActionsV400(sources) {
  for (const [name, pin] of Object.entries(SOURCE_PINS_V400)) {
    if (typeof sources[name] !== 'string' || sha(sources[name]) !== pin) throw new Error(`v400 frozen source differs: ${name}`);
  }
  const routingStart = sources.routing.indexOf('CREATE TABLE cinatoken_gateway.routing_policy_epoch_v396(');
  const routingEnd = sources.routing.indexOf('DO $postflight$', routingStart);
  const stickyStart = sources.sticky.indexOf('CREATE FUNCTION cinatoken_gateway.complete_text_sticky_action_v398(');
  if (routingStart < 0 || routingEnd < routingStart || stickyStart < 0) throw new Error('v400 action boundaries differ');
  const routing = sources.routing.slice(routingStart, routingEnd);
  const sticky = sources.sticky.slice(stickyStart);
  if (/\$preflight\$|DROP\s+TRIGGER|DISABLE\s+TRIGGER|session_replication_role/iu.test(routing + sticky)) throw new Error('v400 action authority differs');
  const grantStart = sources.grant.indexOf('CREATE FUNCTION cinatoken_gateway.grant_complete_flat_text_attempt_v362(');
  const grantEnd = sources.grant.indexOf('$grant$;', grantStart) + '$grant$;'.length;
  if (grantStart < 0 || grantEnd <= grantStart) throw new Error('v400 grant repair boundaries differ');
  const originalGrant = sources.grant.slice(grantStart, grantEnd);
  const originalBody = originalGrant.match(/AS \$grant\$([\s\S]*?)\$grant\$;/u)?.[1];
  if (!originalBody || md5(originalBody) !== '0339e4f95fff26784032d2d73ec09a7a' || originalBody.split('ordinary record;').length !== 2) throw new Error('v400 original grant body differs');
  const grantRepair = originalGrant.replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ')
    .replace('ordinary record;', 'ordinary cinatoken_gateway.user_budget_reservations%ROWTYPE;');
  const repairedBody = grantRepair.match(/AS \$grant\$([\s\S]*?)\$grant\$;/u)[1];
  if (md5(repairedBody) !== 'd12fadd87e87c9a74c9060b9ba9f4c6b') throw new Error('v400 repaired grant body differs');
  return { routing, sticky, grantRepair, originalGrant, digest: sha(routing + sticky), grantRepairDigest: sha(grantRepair) };
}

export async function loadSourcesV400() {
  const paths = {
    routing: 'packages/core/migrations-proposals/postgres/complete-text-routing-projection-v396.sql',
    sticky: 'packages/core/migrations-proposals/postgres/complete-text-sticky-routing-v398.sql',
    auth: 'packages/core/migrations-proposals/postgres/personal-key-auth-period-v395.sql',
    response: 'packages/core/migrations-proposals/postgres/complete-text-response-no-fetch-coinstall-v397.sql',
    grant: 'packages/core/migrations-proposals/postgres/complete-text-attempt-grant-v362.sql',
  };
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(new URL(path, root), 'utf8')])));
}

// The serializer and baseline/final contract projection are completed from the
// owned, cleaned-up v400 baseline capture. No historical preflight is executed
// with a condition removed; the generated successor owns both catalog gates.
export function normalizeBaselineV400(raw) {
  if (raw.relations) return structuredClone(raw);
  if (raw.sequences.length !== 0) throw new Error('v400 selected baseline has unexpected sequences');
  return {
    functions: order(raw.functions.map(f => ({ signature: f.signature, owner: f.owner, language: f.language,
      kind: f.prokind, returns_set: f.proretset, parallel: f.proparallel, strict: f.proisstrict,
      leakproof: f.proleakproof, security_definer: f.prosecdef, volatility: f.provolatile,
      return_type: f.result_type, config: f.proconfig, body_md5: f.body_md5, acl: aclOrder(f.acl) })), f => f.signature),
    relations: order(raw.tables.map(t => ({name: t.name, owner: t.owner, kind: t.relkind, persistence: t.relpersistence,
      rls: t.relrowsecurity, force_rls: t.relforcerowsecurity, acl: aclOrder(t.acl),
      columns: t.columns.map(c => ({position: c.position, name: c.name, type: c.type, not_null: c.notNull,
        identity: c.identity, generated: c.generated, default: c.default, collation: c.collation,
        acl: aclOrder(t.column_acl.filter(a => a.column === c.name).map(({column, ...a}) => a))})),
      constraints: order(t.constraints.map(c => ({name: c.name, type: c.type, deferrable: c.deferrable,
        initially_deferred: c.deferred, validated: c.validated, definition: c.definition})), c => c.name), rules: t.rules})), t => t.name),
    triggers: order(raw.triggers.map(t => ({table: t.table_name, name: t.tgname, function: t.function_name,
      enabled: t.tgenabled, type: t.tgtype, qual: t.tgqual, columns: t.tgattr, arguments: t.args_hex,
      argument_count: t.tgnargs, deferrable: t.tgdeferrable, initially_deferred: t.tginitdeferred,
      old_table: t.tgoldtable, new_table: t.tgnewtable, constraint: t.has_constraint,
      constraint_table: null, definition: t.definition})), t => `${t.table}\0${t.name}`),
    schemas: order(raw.schemas.map(s => ({name: s.name, owner: s.owner, acl: aclOrder(s.acl)})), s => s.name),
    principals: order(raw.principals.map(r => ({name: r.name, login: r.rolcanlogin, inherit: r.rolinherit,
      super: r.rolsuper, create_role: r.rolcreaterole, create_database: r.rolcreatedb, replication: r.rolreplication,
      bypass_rls: r.rolbypassrls, connection_limit: r.rolconnlimit, config: r.config,
      database_create: r.database_create, public_create: r.public_create, memberships: r.memberships})), r => r.name),
    defaults: order(raw.default_acl.map(d => ({owner: d.owner, schema: d.schema, type: d.object_type, acl: aclOrder(d.acl)})), d => `${d.owner}\0${d.schema ?? ''}\0${d.type}`),
  };
}

const grant = (grantee, privilege) => ({grantee, grantor: owner, privilege, grantable: false});
const gateway = 'cinatoken_gateway.';
const projector = 'cinatoken_gateway_complete_text_routing_projector';
const stickyRole = 'cinatoken_gateway_complete_text_sticky_router';
const verifier = 'cinatoken_gateway_route_source_verifier';
const plainConfig = ['search_path=pg_catalog, pg_temp'];
const timedConfig = [...plainConfig, 'lock_timeout=2s', 'statement_timeout=15s'];
const NEW_FUNCTIONS = [
 ['lock_complete_text_routing_sources_v396()', 'void', 'a111bd64f0fc84926c837e586422aae3', verifier, true],
 ['invalidate_routing_policy_v396()', 'trigger', 'a2170b848d9a01dd13780368bc1328e8'],
 ['attest_complete_text_routing_v396(bigint,jsonb)', 'jsonb', '65d0a385d33cc42a60ae65531e641651', verifier],
 ['require_current_routing_projection_v396(uuid,bigint,integer,boolean)', 'void', 'b1ef7b753d40818b1a63b2987452cacd'],
 ['require_current_routing_projection_v396(uuid,bigint,integer)', 'void', '18f50fe2dce9abaa79dc8aef665d14fb'],
 ['fence_complete_text_routing_v396()', 'trigger', 'b5c5659f9445b7a7b8a8bb559c67e5b2'],
 ['reject_routing_projection_mutation_v396()', 'trigger', '5d407242f182754b1c41c93c7be6e699'],
 ['project_complete_text_routing_v396(text,uuid)', 'jsonb', '8cb4e60585afa68885da14e324d78cd8', projector, true],
];

// PostgreSQL's ASCII ChooseRelationName truncation for the four literal tables.
function constraintName(table, column, label) {
  let a = table.length, b = column?.length ?? 0;
  const overhead = label.length + (column ? 2 : 1);
  while (a + b + overhead > 63) { if (a > b) a--; else b--; }
  return `${table.slice(0, a)}${column ? `_${column.slice(0, b)}` : ''}_${label}`;
}
function newRelation(name, specs, extras, selectVerifier = false) {
  const columns = specs.map(([column, type, nullable = false], i) => ({position: i + 1, name: column,
    type, not_null: !nullable, identity: '', generated: '', default: null,
    collation: type === 'text' ? '"default"' : null, acl: []}));
  const constraints = columns.filter(c => c.not_null).map(c => ({name: constraintName(name, c.name, 'not_null'),
    type: 'n', deferrable: false, initially_deferred: false, validated: true, definition: `NOT NULL ${c.name}`}));
  for (const [column, label, type, definition] of extras) constraints.push({name: constraintName(name, column, label),
    type, deferrable: false, initially_deferred: false, validated: true, definition});
  return {name: gateway + name, owner, kind: 'r', persistence: 'p', rls: false, force_rls: false,
    acl: aclOrder(['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'].map(p => grant(owner, p))
      .concat(selectVerifier ? [grant(verifier, 'SELECT')] : [])), columns,
    constraints: order(constraints, c => c.name), rules: []};
}
function newTrigger(table, name, fn, type, events, row = false) {
  return {table: gateway + table, name, function: gateway + fn + '()', enabled: 'O', type,
    qual: null, columns: '', arguments: '', argument_count: 0, deferrable: false,
    initially_deferred: false, old_table: null, new_table: null, constraint: false, constraint_table: null,
    definition: `CREATE TRIGGER ${name} BEFORE ${events} ON ${gateway}${table} FOR EACH ${row ? 'ROW' : 'STATEMENT'} EXECUTE FUNCTION ${gateway}${fn}()`};
}

export function projectFinalCatalogV400(baseline, sources) {
  assertSelectedBaselineV400(baseline);
  const actions = extractFrozenActionsV400(sources);
  const argumentDefinitions = new Map([...(`${actions.routing}\n${actions.sticky}`).matchAll(/CREATE FUNCTION (cinatoken_gateway\.\w+)\(([\s\S]*?)\)\s*RETURNS (\w+)\s+LANGUAGE/gu)].map(m => {
    const argumentsText = m[2].trim().split(',').map(a => a.trim().replace(/\s+/gu, ' ')).join(', ');
    const types = m[2].trim() ? m[2].trim().split(',').map(a => a.trim().split(/\s+/u)[1]).join(',') : '';
    return [`${m[1]}(${types})`, {arguments: argumentsText, result_definition: m[3]}];
  }));
  if (argumentDefinitions.size !== 9) throw new Error('v400 action argument boundaries differ');
  const bodyPins = [...actions.routing.matchAll(/CREATE FUNCTION [\s\S]*?AS \$(\w+)\$([\s\S]*?)\$\1\$;/gu)].map(m => md5(m[2]));
  if (bodyPins.length !== 8 || NEW_FUNCTIONS.some(f => !bodyPins.includes(f[2]))) throw new Error('v400 routing action body contract differs');
  const out = structuredClone(baseline);
  const inheritedGrant = out.functions.find(f => f.signature === gateway + 'grant_complete_flat_text_attempt_v362(uuid,jsonb)');
  if (inheritedGrant?.body_md5 !== '0339e4f95fff26784032d2d73ec09a7a') throw new Error('v400 baseline grant body differs');
  inheritedGrant.body_md5 = 'd12fadd87e87c9a74c9060b9ba9f4c6b';
  for (const [signature, return_type, body_md5, grantee, timed] of NEW_FUNCTIONS) out.functions.push({signature: gateway + signature,
    owner, language: 'plpgsql', kind: 'f', returns_set: false, parallel: 'u', strict: false, leakproof: false,
    security_definer: true, volatility: 'v', return_type, config: timed ? timedConfig : plainConfig,
    body_md5, ...argumentDefinitions.get(gateway + signature),
    acl: aclOrder([grant(owner, 'EXECUTE'), ...(grantee ? [grant(grantee, 'EXECUTE')] : [])])});
  const stickyBody = actions.sticky.match(/AS \$sticky\$([\s\S]*?)\$sticky\$;/u)?.[1];
  if (!stickyBody) throw new Error('v400 sticky body differs');
  out.functions.push({signature: gateway + 'complete_text_sticky_action_v398(uuid,text,text,bigint,integer,text,text,boolean,text,text,text,text,text)',
    owner, language: 'plpgsql', kind: 'f', returns_set: false, parallel: 'u', strict: false, leakproof: false,
    security_definer: true, volatility: 'v', return_type: 'jsonb', config: timedConfig, body_md5: md5(stickyBody),
    ...argumentDefinitions.get(gateway + 'complete_text_sticky_action_v398(uuid,text,text,bigint,integer,text,text,boolean,text,text,text,text,text)'),
    acl: aclOrder([grant(owner, 'EXECUTE'), grant(stickyRole, 'EXECUTE')])});
  out.relations.push(
    newRelation('routing_policy_epoch_v396', [['singleton','boolean'],['epoch','bigint']], [
      [null,'pkey','p','PRIMARY KEY (singleton)'], ['singleton','check','c','CHECK (singleton)'],
      ['epoch','check','c',"CHECK (((epoch >= 1) AND (epoch <= '9223372036854775806'::bigint)))"]], true),
    newRelation('complete_text_routing_facts_v396', [['model_id','text'],['routing_epoch','bigint'],['expires_at','timestamp with time zone'],['facts','jsonb']],
      [[null,'pkey','p','PRIMARY KEY (model_id)']]),
    newRelation('complete_text_routing_projections_v396', [['quote_id','uuid'],['request_id','text'],['routing_epoch','bigint'],['final_body_sha256','text'],['expires_at','timestamp with time zone'],['projection','jsonb']], [
      [null,'pkey','p','PRIMARY KEY (quote_id)'], ['request_id','key','u','UNIQUE (request_id)'],
      ['quote_id','fkey','f','FOREIGN KEY (quote_id) REFERENCES cinatoken_gateway.complete_text_quotes_v360(quote_id)'],
      ['final_body_sha256','check','c',"CHECK ((final_body_sha256 ~ '^[0-9a-f]{64}$'::text))"]]),
    newRelation('complete_text_routing_members_v396', [['quote_id','uuid'],['candidate_index','integer'],['model_id','text'],['route_target_id','text'],['provider_id','text'],['endpoint_id','text'],['route_pool_id','text',true],['source_generation','bigint'],['attested_source_sha256','text'],['beneficial_cache_read_pricing','boolean'],['default_endpoint_eligible','boolean']], [
      [null,'pkey','p','PRIMARY KEY (quote_id, route_target_id)'],
      ['quote_id','fkey','f','FOREIGN KEY (quote_id) REFERENCES cinatoken_gateway.complete_text_routing_projections_v396(quote_id)'],
      ['candidate_index','check','c','CHECK (((candidate_index >= 0) AND (candidate_index <= 7)))'],
      ['attested_source_sha256','check','c',"CHECK ((attested_source_sha256 ~ '^[0-9a-f]{64}$'::text))"]])
  );
  for (const table of ['models','model_surfaces','system_config']) {
    const relation = out.relations.find(r => r.name === gateway + table);
    if (!relation) throw new Error(`v400 baseline missing ${table}`);
    relation.acl = aclOrder([...relation.acl, grant(verifier, 'SELECT')]);
  }
  const schema = out.schemas.find(s => s.name === 'cinatoken_gateway');
  schema.acl = aclOrder([...schema.acl, grant(projector, 'USAGE'), grant(stickyRole, 'USAGE')]);
  for (const table of ['models','model_surfaces','system_config','model_routes','providers','route_pools','model_endpoints','model_endpoint_routes']) {
    out.triggers.push(newTrigger(table, `routing_policy_v396_${table}`, 'invalidate_routing_policy_v396', 62, 'INSERT OR DELETE OR UPDATE OR TRUNCATE'));
  }
  for (const [table, suffix] of [['complete_text_attempt_grants_v362','grant'],['complete_text_send_custody_v365','custody'],['complete_text_send_starts_v365','start']]) {
    out.triggers.push(newTrigger(table, `complete_text_routing_v396_${suffix}`, 'fence_complete_text_routing_v396', 7, 'INSERT', true));
  }
  for (const [table, name] of [['complete_text_routing_projections_v396','complete_text_routing_projection_immutable_v396'],['complete_text_routing_members_v396','complete_text_routing_members_immutable_v396']]) {
    out.triggers.push(newTrigger(table, name, 'reject_routing_projection_mutation_v396', 58, 'DELETE OR UPDATE OR TRUNCATE'));
  }
  out.functions = order(out.functions, f => f.signature);
  out.relations = order(out.relations, r => r.name);
  out.triggers = order(out.triggers, t => `${t.table}\0${t.name}`);
  return out;
}

export function assertFinalCatalogV400(actual, baseline, sources) {
  const expected = projectFinalCatalogV400(baseline, sources);
  for (const key of Object.keys(expected)) {
    if (catalogDigestV400(actual[key]) !== catalogDigestV400(expected[key])) throw new Error(`v400 final catalog differs: ${key}`);
  }
  if (Object.keys(actual).length !== Object.keys(expected).length) throw new Error('v400 final catalog categories differ');
  return {functions: actual.functions.length, relations: actual.relations.length, triggers: actual.triggers.length,
    schemas: actual.schemas.length, principals: actual.principals.length, defaults: actual.defaults.length, digest: catalogDigestV400(actual)};
}

function gateV400(expected, phase) {
  const serialized = JSON.stringify(expected);
  if (serialized.includes('$catalog_v400$')) throw new Error('v400 catalog delimiter differs');
  return `DO $${phase}$\nDECLARE expected jsonb:=$catalog_v400$${serialized}$catalog_v400$::jsonb; actual jsonb; category text; difference jsonb;\nBEGIN\n` +
    ` IF CURRENT_USER<>'${owner}' OR SESSION_USER<>CURRENT_USER\n` +
    `  OR current_setting('session_replication_role')<>'origin'\n` +
    `  OR current_setting('cinatoken.complete_text_auth_routing_recovery_coinstall_v400_activation',true) IS DISTINCT FROM 'reviewed-v1'\n` +
    `  OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73\n` +
    `  OR (SELECT md5(string_agg(version,E'\\n' ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations) IS DISTINCT FROM 'ca1ea96a1b4bcd0675642f30dcf48042'\n` +
    ` THEN RAISE EXCEPTION 'v400 ${phase} activation or PG73 differs' USING ERRCODE='P0001'; END IF;\n` +
    ` IF EXISTS(SELECT 1 FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole\n` +
    `  WHERE r.rolname LIKE 'cinatoken_%' OR (s.setrole=0 AND s.setdatabase IN(0,(SELECT oid FROM pg_database WHERE datname=current_database()))))\n` +
    `  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'cinatoken_%' AND r.rolname<>'${owner}'\n` +
    `    AND has_parameter_privilege(r.oid,'session_replication_role','SET'))\n` +
    ` THEN RAISE EXCEPTION 'v400 ${phase} role settings or replication parameter authority differs' USING ERRCODE='P0001'; END IF;\n` +
    ` IF EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace\n` +
    `  WHERE n.nspname LIKE 'cinatoken_%' OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname='${owner}'))\n` +
    ` THEN RAISE EXCEPTION 'v400 ${phase} relation policy inventory differs' USING ERRCODE='P0001'; END IF;\n` +
    ` ${CATALOG_QUERY_V400.replace('SELECT jsonb_build_object(', 'SELECT jsonb_build_object(').replace(') AS catalog', ') INTO actual')};\n` +
    ` FOR category IN SELECT jsonb_object_keys(expected) LOOP\n` +
    `  IF actual->category IS DISTINCT FROM expected->category THEN\n` +
    `   SELECT item INTO difference FROM (SELECT value item FROM jsonb_array_elements(actual->category) EXCEPT SELECT value FROM jsonb_array_elements(expected->category)) d LIMIT 1;\n` +
    `   RAISE EXCEPTION 'v400 ${phase} catalog differs: %',category USING ERRCODE='P0001',DETAIL=left(coalesce(difference::text,'missing expected object'),8000);\n` +
    `  END IF;\n END LOOP;\n` + effectiveAuthorityGateV400(phase) + `END;\n$${phase}$;\n`;
}

function effectiveAuthorityGateV400(phase) {
  const allowed = phase === 'preflight' ? 'false' :
    `(r.rolname='${projector}' AND p.oid='${gateway}project_complete_text_routing_v396(text,uuid)'::regprocedure) OR\n` +
    `(r.rolname='${stickyRole}' AND p.oid='${gateway}complete_text_sticky_action_v398(uuid,text,text,bigint,integer,text,text,boolean,text,text,text,text,text)'::regprocedure)`;
  return ` IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN('${projector}','${stickyRole}') AND\n` +
    `  (has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND has_schema_privilege(r.oid,n.oid,'CREATE'))))\n` +
    ` OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace\n` +
    `  WHERE r.rolname IN('${projector}','${stickyRole}') AND n.nspname NOT IN('pg_catalog','information_schema') AND\n` +
    `   CASE WHEN c.relkind IN('r','p','v','m','f') THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE')\n` +
    `    WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)\n` +
    ` OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace\n` +
    `  WHERE r.rolname IN('${projector}','${stickyRole}') AND n.nspname NOT IN('pg_catalog','information_schema')\n` +
    `   AND has_function_privilege(r.oid,p.oid,'EXECUTE') AND NOT(${allowed}))\n` +
    ` THEN RAISE EXCEPTION 'v400 ${phase} new LOGIN authority differs' USING ERRCODE='P0001'; END IF;\n` +
    ` IF EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace\n` +
    `  WHERE r.rolname LIKE 'cinatoken_%' AND r.rolname<>'${owner}' AND n.nspname NOT LIKE 'cinatoken_%'\n` +
    `   AND n.nspname NOT IN('pg_catalog','information_schema') AND has_function_privilege(r.oid,p.oid,'EXECUTE'))\n` +
    ` OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace\n` +
    `  WHERE r.rolname LIKE 'cinatoken_%' AND r.rolname<>'${owner}' AND n.nspname NOT LIKE 'cinatoken_%'\n` +
    `   AND n.nspname NOT IN('pg_catalog','information_schema') AND CASE WHEN c.relkind IN('r','p','v','m','f')\n` +
    `    THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE')\n` +
    `    WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)\n` +
    ` THEN RAISE EXCEPTION 'v400 ${phase} outside-schema authority differs' USING ERRCODE='P0001'; END IF;\n`;
}

export function renderInstallerV400(baseline, sources) {
  assertSelectedBaselineV400(baseline);
  const actions = extractFrozenActionsV400(sources);
  const final = projectFinalCatalogV400(baseline, sources);
  if (baseline.functions.length !== 133 || baseline.relations.length !== 89 || baseline.triggers.length !== 122 ||
      baseline.schemas.length !== 7 || baseline.principals.length !== 26 || baseline.defaults.length !== 3) throw new Error('v400 selected baseline inventory differs');
  const lockTables = baseline.relations.filter(t => ['r','p'].includes(t.kind)).map(t => t.name).join(',\n ');
  return `-- REVIEW ONLY. Successor installer for the reviewed 392/388/395/389/397 baseline.\n` +
    `-- Compile frozen v396/v398 action DDL under new complete catalog gates.\n` +
    `-- Baseline catalog source SHA256 ${BASELINE_RAW_SHA256_V400}.\n` +
    `-- Action DDL SHA256 ${actions.digest}; production migrations remain PG73.\n` +
    `-- Narrow inherited grant repair SHA256 ${actions.grantRepairDigest}; 132 other inherited function objects unchanged.\n` +
    `-- Install only inside one explicit transaction as the direct migrator LOGIN.\n` +
    `SET LOCAL lock_timeout='2s';\nSET LOCAL statement_timeout='15s';\nSET LOCAL search_path TO pg_catalog,pg_temp;\n` +
    `SELECT pg_catalog.pg_advisory_xact_lock(746923553);\nSELECT pg_catalog.pg_advisory_xact_lock(746923595);\nSELECT pg_catalog.pg_advisory_xact_lock(746923596);\nSELECT pg_catalog.pg_advisory_xact_lock(746923598);\n` +
    `LOCK TABLE ${lockTables} IN SHARE ROW EXCLUSIVE MODE NOWAIT;\n` + gateV400(baseline, 'preflight') +
    `-- BEGIN narrow v362 inherited grant typed-row declaration repair\n${actions.grantRepair}\n-- END narrow v362 inherited grant typed-row declaration repair\n` +
    `-- BEGIN unchanged frozen v396 action DDL\n${actions.routing}-- END unchanged frozen v396 action DDL\n` +
    `-- BEGIN unchanged frozen v398 action DDL\n${actions.sticky}\n-- END unchanged frozen v398 action DDL\n` + gateV400(final, 'postflight');
}

export async function buildInstallerV400() {
  const rawText = await readFile(new URL('scripts/db/cutover/fixtures/complete-text-auth-routing-recovery-coinstall-baseline-v400.json', root), 'utf8');
  if (sha(rawText) !== BASELINE_RAW_SHA256_V400) throw new Error('v400 baseline capture source differs');
  const baseline = normalizeBaselineV400(JSON.parse(rawText));
  const sources = await loadSourcesV400();
  const installer = renderInstallerV400(baseline, sources);
  const output = new URL('packages/core/migrations-proposals/postgres/complete-text-auth-routing-recovery-coinstall-v400.sql', root);
  await writeFile(output, installer, 'utf8');
  return {path: fileURLToPath(output), sha256: sha(installer), bytes: Buffer.byteLength(installer),
    baseline: {functions: 133, relations: 89, triggers: 122}, final: {functions: 142, relations: 93, triggers: 135}};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(JSON.stringify(await buildInstallerV400()));
