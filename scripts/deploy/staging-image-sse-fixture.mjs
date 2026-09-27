import assert from 'node:assert/strict';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '@octafuse/core';
import { imageSuccessFixture } from './staging-image-success-fixture.mjs';

// Reuse the established tenant/key cleanup, with a separate SSE provider so legacy edits stay intact.
export async function imageSseFixture(runId,keyHash,expiresAt) {
  const fixture=await imageSuccessFixture(runId,keyHash,expiresAt), selected=fixture.cases['small-generations'];
  const rows=fixture.seed.map(s=>{
    const match=/^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES /.exec(s.sql);assert.ok(match);
    const names=match[2].split(',');assert.equal(names.length,s.params.length);
    return {table:match[1],row:Object.fromEntries(names.map((name,i)=>[name,s.params[i]]))};
  });
  const find=(table,id)=>{const item=rows.find(x=>x.table===table&&x.row.id===id);assert.ok(item);return item.row;};
  const original=find('providers',selected.provider);
  const provider={...original,id:runId+'-p-sse',name:runId+'-p-sse',
    endpoints:JSON.stringify({openai:{base:'https://c02-images-upstream.invalid/sse/v1'}})};
  // Insert before routes that refer to it. No real credential or paid supplier is configured.
  rows.unshift({table:'providers',row:provider});
  const route=find('model_routes',selected.route);route.provider_id=provider.id;
  const endpoint=find('model_endpoints',selected.endpoint);endpoint.provider_id=provider.id;
  const caps=JSON.parse(endpoint.image_capabilities);caps.supports_streaming=true;caps.pricing[0].cost_usd='0.1';
  endpoint.image_capabilities=JSON.stringify(caps);
  const mapping=rows.find(x=>x.table==='model_endpoint_routes'&&x.row.endpoint_id===selected.endpoint);assert.ok(mapping);
  mapping.row.subject_fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
  find('users',fixture.ids.user).budget_max=1;
  find('api_keys',fixture.ids.key).limit_micros=null;
  fixture.seed=rows.map(({table,row})=>({sql:`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,params:Object.values(row)}));
  fixture.ids.providers.push(provider.id);selected.provider=provider.id;
  fixture.cleanup.push({sql:'DELETE FROM providers WHERE id=? AND description=?',params:[provider.id,provider.description]});
  return fixture;
}
