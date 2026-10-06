import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const prior=path.dirname(fileURLToPath(import.meta.url));const binding=JSON.parse(fs.readFileSync(path.join(prior,'binding.json')));
const next=path.join(path.dirname(prior),'cinatoken-v364-queued-linux-run-'+crypto.randomUUID().replaceAll('-',''));fs.mkdirSync(next);
binding.previousUnsuccessfulObservationRoot=prior.replaceAll('\\','/');binding.observationRoot=next.replaceAll('\\','/');binding.networkRetryReason='First local GH watch closed1 before any CI observation: sandbox EACCES. Original closed receipt/raw preserved; same authorised run, no workflow rerun.';
const file=path.join(next,'binding.json');fs.writeFileSync(file,JSON.stringify(binding,null,2)+'\n',{flag:'wx'});console.log(file.replaceAll('\\','/'));
