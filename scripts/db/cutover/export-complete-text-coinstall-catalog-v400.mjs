import { writeFile } from 'node:fs/promises';
import { captureCatalogV400 } from './build-complete-text-auth-routing-recovery-coinstall-v400.mjs';

/** Shared installer catalog query; metadata only, with no rows or credentials. */
export async function exportCompleteTextCoinstallCatalogV400(sql,fileName) {
 const result=await captureCatalogV400(sql);
 await writeFile(new URL('../../../.wrangler/staging/'+fileName,import.meta.url),JSON.stringify(result,null,2)+'\n');
 return result;
}
