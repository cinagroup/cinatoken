import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root=process.argv[2];
const repo='C:/cinagroup/cinatoken';
const bundle='C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node';
const startedAt=new Date().toISOString();
const hash=b=>createHash('sha256').update(b).digest('hex');
const inputs=[
join(repo,'package.json'),
join(repo,'packages/web/package.json'),
join(repo,'package-lock.json'),
join(bundle,'node_modules/playwright/package.json'),
join(bundle,'node_modules/playwright-core/package.json'),
join(bundle,'node_modules/playwright/index.mjs'),
join(bundle,'node_modules/playwright-core/browsers.json'),
join(bundle,'node_modules/playwright-core/types/types.d.ts')
].map(path=>{const b=readFileSync(path);return {path,bytes:b.length,sha256:hash(b)};});
const pkg=name=>JSON.parse(readFileSync(join(bundle,'node_modules',name,'package.json'),'utf8'));
const p=pkg('playwright'),core=pkg('playwright-core');
const browserExecutables=[
'C:/Program Files/Google/Chrome/Application/chrome.exe',
'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].map(path=>({path,exists:existsSync(path),bytes:existsSync(path)?statSync(path).size:null,launched:false}));
const report={
schema:'playwright-fallback-readonly-FINAL-v1',
startedAt,endedAt:new Date().toISOString(),
inputs,
runtime:{
source:'load_workspace_dependencies read-only tool supplied bundle26.930.11008',
node:join(bundle,'bin/node.exe'),nodeExists:existsSync(join(bundle,'bin/node.exe')),
playwright:{version:p.version,path:join(bundle,'node_modules/playwright'),esmEntry:join(bundle,'node_modules/playwright/index.mjs'),importSpecifier:'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'},
core:{version:core.version,path:join(bundle,'node_modules/playwright-core')},
repositoryPlaywrightPackagesInstalled:['playwright','playwright-core','@playwright/test'].map(name=>({name,exists:existsSync(join(repo,'node_modules',name,'package.json'))})),
lockMeaning:'Next has @playwright/test ^1.51.1 only as optional peer; not an installed root/web browser test dependency.',
entryObservation:'playwright/index.mjs exports from playwright-core and default import; checked source bytes only, no module import or browser runtime execution.',
typesObservation:[
 {line:11032,contract:'Browser.newContext(options?: BrowserContextOptions)'},
 {line:16981,contract:'BrowserType.launch(options?: LaunchOptions)'},
 {line:17007,contract:'launchPersistentContext(userDataDir:string,...) present but do not use any personal browser directory'},
 {line:17592,contract:'LaunchOptions executablePath?:string'},
 {line:11216,contract:'ignoreHTTPSErrors?:boolean'},
 {line:11420,contract:'storageState exists but this fallback must omit it'}
]},
browserExecutables,
browserCache:{path:'C:/Users/cina/AppData/Local/ms-playwright',existencePreviouslyObserved:true,directoryListing:'Access denied',contentsNotRead:true,retryOrEscalation:false,download:false,defaultBundledChromiumExecutableUnknown:true},
existingRepositoryScriptSearch:{scope:['scripts','packages/web/scripts'],extensions:['.mjs','.js','.ts','.cjs'],term:'playwright|chromium|puppeteer',matchesReturned:0,excluded:['evidence','releases'],meaning:'Only searched scope; does not prove absence of historical untracked Temp QA scripts. No old evidence directories read.'},
proposedLaunch:{runHere:false,
command:'& \'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe\' \'<new independent Temp>/browser-session.mjs\'',
nodeSourceExample:"import { chromium } from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';\nconst browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false });\nconst context = await browser.newContext({ acceptDownloads: false, ignoreHTTPSErrors: false });\nconst page = await context.newPage();\n// Root controls the authorized actual login next; keep context alive for password/MFA input.\n// Close the owned context/browser when the authorized acceptance session is complete.\n",
sessionIsolation:'launch creates its own ephemeral browser profile and newContext is a new isolated context; do not load persistent personal profile or storageState. Use a fresh independent private Temp task directory for the script and any explicitly allowed screenshots; never archive login state/private profile.',
rootSteering:'Root selected headless:false visible browser. Password/MFA are user input; no credential read by this agent.',
logging:'No HAR, trace, storageState export, cookies/password/header/body capture, page.textContent dumps, token/query-bearing URLs, or personal-profile/CDP connection.',
cleanup:'Root owns normal context.close()/browser.close(); keep live session open only while user input and authorized acceptance are pending.'},
negativeObservation:{path:'prior-directory-read-tool-observation.json',toolChunk:'7b5b06',toolReportedExit:0,nonterminatingReaderError:'Get-ChildItem ms-playwright Access to path is denied',meaning:'The combined shell process reported0 while a specific directory read failed. This is not a complete successful cache inventory or executable admission.'},
scope:{inputFiles:8,browserLaunches:0,browserOperations:0,networkRequests:0,profileCookieOrPasswordReads:0,repoWrites:0,dependencyInstalls:0,newCI:0,oldFrozenRootsWritten:0},
conclusion:'Use existing bundled Playwright1.62.1 and explicit installed Chrome executablePath, fresh browser/newContext; no dependency installation or browser-cache enumeration is needed. Launch/API/browser compatibility remains untested by this read-only task.',
STOPWRITEAfterSeal:true
};
writeFileSync(join(root,'FINAL-playwright-fallback-readonly.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,report:'FINAL-playwright-fallback-readonly.json',inputFiles:8,moduleVersion:p.version,browserExecutables,browserLaunches:0,networkRequests:0}));

