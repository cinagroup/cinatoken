import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),file='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md',sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(file);assert.equal(sha(bytes),'66c14315b0e71aa74ec642a681f049c43f2915b2b7d413aace278310e47a604c');let s=bytes.toString('utf8');
const replace=(a,b)=>{assert.equal(s.split(a).length,2,a);s=s.replace(a,b);};
replace('真实浏览器登录已实际推进至CinaAuth，但授权端点302回调invalid_target（hasCode=false/hasState=true），尚未登录、切工作区或写密钥。','真实浏览器登录已实际推进至CinaAuth，但授权端点302回调invalid_target（hasCode=false/hasState=true）。线上只读已确认client/resource存在且未禁用、缺少exact关联；单条关联修复已准备并通过9项SQLite事务验证，自动审批拒绝具体生产权限变更，待用户明确批准（5.87）。尚未登录、切工作区或写密钥。');
replace('真实浏览器authorize→callback invalid_target，待核对公开resource/audience接线后继续已有专用工作区、密钥和隔离写验收。','真实浏览器authorize→callback invalid_target，线上只读确认启用client/resource缺exact关联，单条修复待明确批准（5.87）；随后继续已有专用工作区、密钥和隔离写验收。');
replace('真实resource存在/禁用/link元数据尚未读，线上live根因未证。','当时真实resource存在/禁用/link元数据尚未读，线上live根因未证；后续只读结果及审批边界见5.87。');
const section=`### 5.87 真实 CinaAuth 资源关联诊断与待批准修复（2026-10-06）

用户指定使用已有专用测试工作区。实际登录在authorize阶段返回invalid_target，尚未出现登录表单；未选择身份或工作区，未创建/撤销测试密钥。既有客户端cinatoken-admin及资源https://cinatoken.com的公开配置已经两侧核一致，Hyperdrive缓存disabled=true。08:53:52.632–08:54:11.771的受控线上只读子进程actual0、signal null、stdout1734B/SHA256 ea27981a2ae2299d48441f4ff16e5934fe105e231bbc7ba84d1056c4f3fbaa51、stderr0；单次门禁请求08:54:08.279返回200及五布尔：clientExists=true/clientDisabled=false/resourceExists=true/resourceDisabled=false/linkExists=false。确认缺少该exact pair关联；这与invalid_target资源授权检查相符，修复后实际登录仍须复验，不能由静态本机源码推定已部署版本或提前完成G2。

该次诊断创建独立随机名临时Worker，仅绑定现有Hyperdrive与内存生成的32字节门禁secret_text；没有生产Route/现有Worker变更、没有数据库DML/DDL，也未修改Hyperdrive设置。BEGIN READ ONLY内3条SET LOCAL超时设置及固定参数化SELECT，门禁先于数据库访问，返回仅五布尔。首次4个无数据库health请求transport失败，第5个预期404才执行唯一metadata GET；DELETE200/success及随后settings404实际确认临时Worker已删除。其cloud endpoint属于workers.dev公开网络，应用门禁提供访问控制，不称loopback私有或legacy preview。门禁/连接串/凭据值均未落入证据。初版prepare真实1因postgres/package.json未导出，发生于打包/远程之前；修正版prepare0及两syntax0完整保留。独立审查曾把JSON展示转义误判为SQL分隔符错误，实际源码byte仅一个92、Babel AST separator codepoint=[10]；误告和纯读更正0原样保存，没有重复线上查询。

最小修复候选仅INSERT oauthClientResource的固定pair，事务先FOR UPDATE锁已存在client/resource、检查未禁用，再以既有reserved ID协议ON CONFLICT DO NOTHING；后读完整五布尔并要求资源/客户端仍存在、启用且linkExists=true，否则回滚。它不新增资源、不更新客户端/资源metadata或禁用策略、不关联其他client。同函数隔离SQLite真实事务9/9、skip0，覆盖幂等、禁用/缺行拒绝与reserved-ID冲突回滚；这不是PostgreSQL锁或生产写入验收。原初始化漏resource/link的代码修复候选另以同7夹具red3→green7验证；CinaAuth本机worktree存在原用户改动，未改该仓库/提交/部署，生产version tag缺失仍不推定源码一致。Root最终worker5441B/SHA256 07103d4c4a646e5a0ad97b220c7c36db882e0be3e9b2266f9c1e2269e5594944、bundle82428B/SHA256 20ea7d7a16b19c9c65fd84fa28d2de24a4ab9a6be4d1d924e92707d2f9d80577，两语法检查0；在事务内额外检查after两exists，原候选字节保持。

执行此单条生产OAuth授权关联修复的require_escalated请求被自动审批拒绝：理由是会持久改变认证授权边界，而用户此前未明确批准具体生产权限变更。CreateProcess未创建child，actualChildExit=null，没有修复Worker或生产数据库写入；不能把拒绝写成执行exit1或回滚成功。已就该固定pair向用户请求明确批准，未绕过或间接执行。待批准后按已审方案执行一次、核前后状态与临时Worker删除，再恢复实际浏览器登录、已有专用工作区切换、测试密钥创建/撤销及第二身份跨工作区拒绝；凭据/验证码若需人工输入仍在浏览器内完成。V4仅重开首页后关闭（真实tool0），没有修复后登录尝试。

新归档[静态授权边界索引](./evidence/2026-10-06-native-all-green-and-http-cancellation-boundary/auth-boundary-static-index.json)完整142来源文件＋20准备材料，逐byte/SHA/set核验；[实际诊断与审批边界索引](./evidence/2026-10-06-native-all-green-and-http-cancellation-boundary/auth-runtime-index.json)单列真实线上只读、浏览器日志、修复预备与拒绝记录。原757 native106步骤/109TAP全成功、严格HTTP取消仍失败、102主任务/54矩阵/211实际checkbox以及G0–G8/E00–E08全部原状态保持。独立Web生产c13/2a0继续100%，此次未重新部署前端或认证Worker。

`;
replace('## 6. 更新记录',section+'## 6. 更新记录');
s+='2026-10-06：5.86/5.87记录757原native106步骤/109测试全通过、原strict和手动HTTP诊断仍失败；真实CinaAuth登录invalid_target，线上只读确认启用client/resource缺exact授权关联，临时诊断Worker已删除/404复核。单条关联修复9项SQLite通过但生产写入被自动审批拒绝，待具体批准，真实登录/专用工作区/密钥及完整G7/G8不提前完成。\n\n';
const baseline=fs.readFileSync(path.join(root,'checklist-before-5.86.md'),'utf8');const rules={tasks:/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,matrix:/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,gates:/^验收门槛 G[0-8]：.*$/gm,phases:/^\| P[0-8] .*$/gm,acceptance:/^\| E0[0-8] \|.*$/gm,checkboxLines:/^.*\[[ x]\].*$/gm};const scope={};for(const [key,re]of Object.entries(rules)){const a=baseline.match(re)||[],b=s.match(re)||[];assert.deepEqual(b,a,key);scope[key]=b.length;}
fs.writeFileSync(file,s);const after=fs.readFileSync(file);assert.equal(after.toString('utf8'),s);
const report={at:new Date().toISOString(),beforeBytes:bytes.length,beforeSha256:sha(bytes),afterBytes:after.length,afterSha256:sha(after),scope,scopeArraysExact:true,checkboxStateChanged:false,productionRepairExecuted:false,approvalPending:true};fs.writeFileSync(path.join(root,'checklist-live-registration-update.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
