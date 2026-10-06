import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const file='C:/Users/cina/AppData/Local/Temp/cinatoken-native-frozen94-109-prepare-1a3b08f2b97c427989de588e9e4cd450/FINAL-native-frozen94-109-preparation.json',bytes=readFileSync(file),report=JSON.parse(bytes);
process.stdout.write(JSON.stringify({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),keys:Object.keys(report),report}));