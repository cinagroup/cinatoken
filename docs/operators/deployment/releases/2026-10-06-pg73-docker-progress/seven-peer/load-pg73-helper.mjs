import { listPg73Migrations } from 'file:///C:/cinagroup/cinatoken/scripts/db/cutover/pg73-native-fixture.mjs';
const files = await listPg73Migrations();
console.log(JSON.stringify({mode:'filesystem-only module-load and historical corpus validation',count:files.length,last:files.at(-1),postgresStarted:false,postgresConnections:0}));
