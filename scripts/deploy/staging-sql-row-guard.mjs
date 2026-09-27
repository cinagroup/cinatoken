import assert from 'node:assert/strict';
// Preserve every observed field and its parameter order, but avoid a left-deep AND tree.
// D1 limits expression depth to 100; a flat 76-column exact-row predicate can exceed it.
const balanced=parts=>parts.length===1?parts[0]:`(${balanced(parts.slice(0,Math.floor(parts.length/2)))} AND ${balanced(parts.slice(Math.floor(parts.length/2)))})`;
export function exactStagingRowGuard(table,row){
  assert.match(table,/^[a-z][a-z0-9_]*$/);const names=Object.keys(row);
  assert.ok(names.length>0&&names.length<=100&&names.every(n=>/^[a-z][a-z0-9_]*$/.test(n)));
  return {sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${balanced(names.map(n=>n+' IS ?'))}) THEN 1 ELSE json('staging_exact_row_changed') END AS cleanup_guard`,params:names.map(n=>row[n])};
}
