import{command}from'./capture.mjs';
const[label,exe,...args]=process.argv.slice(2),r=await command(label,exe,args);
console.log(JSON.stringify(r.receipt));console.log(r.stdout.toString());
if(r.receipt.actualExit!==0)console.error(r.stderr.toString());
process.exitCode=r.receipt.actualExit??1;
