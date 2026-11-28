import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {getProviderCatalog} from '../provider-catalog';
import {loadModelCatalog,loadProviderCatalog,requireCurrentCatalog} from './catalog-loader';

const snapshot=(name:string)=>JSON.parse(readFileSync(new URL(`../../../docs-site/src/data/catalog/${name}.json`,import.meta.url),'utf8'));

test('reviewed website feeds pass the real Admin loader and provider import projection without private mappings',async(t)=>{
 const models=snapshot('models'),providers=snapshot('providers');
 assert.equal(models.count,206);assert.equal(providers.count,69);
 assert.ok(!JSON.stringify(providers).includes('managed_environment_key'));
 const requests:string[]=[];
 t.mock.method(globalThis,'fetch',async(url:URL)=>{
  requests.push(url.href);
  return Response.json(url.pathname.endsWith('/providers')?providers:models,{headers:{etag:'"reviewed-snapshot"'}});
 });
 const env={CATALOG_BASE_URL:'https://cinatoken.com/reference'};
 const modelRows=requireCurrentCatalog(await loadModelCatalog(env)),providerRows=requireCurrentCatalog(await loadProviderCatalog(env));
 assert.equal(modelRows.length,206);assert.equal(providerRows.length,69);
 assert.deepEqual(modelRows,models.items);assert.deepEqual(providerRows,providers.items);
 const projected=getProviderCatalog(providerRows).listStaticProviderImportCatalogForAdmin();
 assert.equal(projected.length,69);assert.ok(projected.every(row=>row.id&&row.endpoints));
 const trusted=JSON.parse(readFileSync(new URL('../provider-import-presets.json',import.meta.url),'utf8'));
 const expected=getProviderCatalog(trusted).listStaticProviderImportCatalogForAdmin();
 assert.deepEqual(projected.map(row=>({id:row.id,protocols:row.protocols,endpoints:row.endpoints})),expected.map(row=>({id:row.id,protocols:row.protocols,endpoints:row.endpoints})));
 assert.deepEqual(requests,['https://cinatoken.com/reference/api/catalog/models','https://cinatoken.com/reference/api/catalog/providers']);
});
