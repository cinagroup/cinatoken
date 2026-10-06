import{runClosed}from'./evidence-lib.mjs';
const[label,executable,...args]=process.argv.slice(2),result=await runClosed(label,executable,args);process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=Number.isInteger(result.actualExit)?result.actualExit:1;
