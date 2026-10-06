const fs=require('node:fs'), assert=require('node:assert/strict'), path=require('node:path');
const temp='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-docker-topology-v77GHM';
function edit(file,fn){const before=fs.readFileSync(file,'utf8'), eol=before.includes('\r\n')?'\r\n':'\n'; const expected=fs.readFileSync(path.join(temp,'before',file.replaceAll('/','__'))); assert.deepEqual(fs.readFileSync(file),expected); fs.writeFileSync(file,fn(before,eol));}
function exact(source,anchor,replacement){assert.equal(source.split(anchor).length,2,'one exact anchor'); return source.replace(anchor,replacement);}
const gateway='docker/examples/gateway.compose.yml',web='docker/examples/web-frontend.compose.yml',doc='docs/operators/deployment/docker.md';
const entry=fs.readFileSync('docker/web/entrypoint.sh','utf8'), flags=[...entry.matchAll(/^: "\$\{(CINATOKEN_WEB_(?:ACCOUNT|ADMIN_[A-Z_]+)_ENABLED):=false\}"/gm)].map(m=>m[1]); assert.equal(flags.length,28); assert.equal(new Set(flags).size,28); assert.equal(flags.filter(f=>f.includes('_ADMIN_')).length,27);
edit(gateway,(source,eol)=>{const anchor='      PORT: "8789"'+eol; return exact(source,anchor,anchor+'      # Node public catalog/chat use this service origin; Cloudflare bindings are separate.'+eol+'      CINATOKEN_PUBLIC_API_ORIGIN: ${CINATOKEN_PUBLIC_API_ORIGIN:-http://gateway-proxy:8787}'+eol)});
edit(web,(source,eol)=>{const anchor='      CINATOKEN_WEB_PUBLIC_ENABLED: ${CINATOKEN_WEB_PUBLIC_ENABLED:-false}'+eol+'      CINATOKEN_WEB_SSR_UPSTREAM:'; const added='      # Private shells are selected by the entry; the SSR sidecar only serves public routes.'+eol+flags.map(name=>'      '+name+': ${'+name+':-false}').join(eol)+eol; return exact(source,anchor,'      CINATOKEN_WEB_PUBLIC_ENABLED: ${CINATOKEN_WEB_PUBLIC_ENABLED:-false}'+eol+added+'      CINATOKEN_WEB_SSR_UPSTREAM:')});
edit(doc,(source,eol)=>{
const portRow='|`PORT`|否|默认 Dockerfile 内为 `8789`|'+eol; source=exact(source,portRow,portRow+'|`CINATOKEN_PUBLIC_API_ORIGIN`|否|Admin 服务端访问 Proxy 的 HTTP(S) origin（公开目录和聊天 BFF）。`gateway.compose.yml` 默认 `http://gateway-proxy:8787`；可在 env 文件中配置自己的服务 origin。它不是浏览器连接地址，也不代替 `CINATOKEN_WEB_PROXY_ORIGINS`。|'+eol);
const section=[
'### 4.3 独立 Web 入口与公开 SSR','',
'[`docker/examples/web-frontend.compose.yml`](../../../docker/examples/web-frontend.compose.yml) 与 `gateway.compose.yml` 合并使用。`GATEWAY_WEB_IMAGE` 和 `GATEWAY_WEB_SSR_IMAGE` 须由同一个已验证的 `WEB_RELEASE_PATH` 构建并固定版本或 digest；入口向 SSR 传递 manifest 摘要，错配会返回 503。发布包须包含保留窗口内的旧资源；Web 和 SSR 镜像的相同来源不能替代回滚与旧标签页资源验收。','',
'Admin 的 `CINATOKEN_PUBLIC_API_ORIGIN` 默认指向本组合内的 `http://gateway-proxy:8787`，因此公开 SSR 经 Admin BFF 读取当前 Proxy；若 Proxy 部署在自己的其他服务 origin，可在 env 文件中覆盖为有效的 HTTP(S) origin。此默认只由 Compose 注入，应用本身的 Cloudflare 绑定及默认 origin 不变。','',
'Web 入口接收 `CINATOKEN_WEB_PUBLIC_ENABLED`、`CINATOKEN_WEB_ACCOUNT_ENABLED` 及组合文件列出的全部 27 个 `CINATOKEN_WEB_ADMIN_*_ENABLED` 路由开关，默认均为 `false`。只按已验收的路由逐项启用；账户和管理开关仅注入 Nginx 入口，公开 SSR 不读取它们。启用公开页面时还须配置 SSR 的 `CINATOKEN_WEB_PUBLIC_ORIGIN` 为实际 HTTPS 公共 origin；`CINATOKEN_WEB_PROXY_ORIGINS` 控制浏览器 CSP 中允许的 Proxy 连接 origin，与服务端的 `CINATOKEN_PUBLIC_API_ORIGIN` 分别配置。','',
'以下命令仅说明组合方式，须先完成数据库迁移、加密密钥、CinaAuth 与 TLS 部署配置，并准备两个经过验证的 Web 镜像：','',
'```bash',
'# 在自己的 env 文件中设置 GATEWAY_WEB_IMAGE、GATEWAY_WEB_SSR_IMAGE 和所需 origin。',
'# 各 Web 路由开关未设置时保持 false。',
'docker compose --env-file docker/deploy/.env.local '+String.fromCharCode(92),
'  -f docker/examples/gateway.compose.yml '+String.fromCharCode(92),
'  -f docker/examples/web-frontend.compose.yml up -d',
'```','',
'对外入口须由可信 TLS 反代规范化公共 Host 与 HTTP/HTTPS 协议，并将原始 Web、SSR 和 Admin 端口限制在可信网络。配置透传不代表同源 Cookie/Origin、真实认证写操作、SSE/WebSocket、灰度或回滚已经通过；这些仍须在实际 Docker 拓扑逐项验证。',''];
const heading='## 5. 数据库迁移（Postgres 与 MySQL）'+eol; return exact(source,heading,section.join(eol)+eol+heading)});
fs.writeFileSync(path.join(temp,'authorized-edit-summary.json'),JSON.stringify({files:[gateway,web,doc],privateFlags:flags,allDefaultsFalse:true,publicApiComposeDefault:'http://gateway-proxy:8787',productDefaultsChanged:false,privateFlagsAddedToSsr:false,noDeployment:true},null,2)+'\n',{flag:'wx'}); console.log(JSON.stringify({editedFiles:3,privateFlags:28,adminFlags:27}));