# Public SSR early controls browser runner

状态：只准备，未启动浏览器、未访问 origin、未执行生产或业务操作。node --check 只证明 JavaScript 语法。

调用恰好两个参数：origin 与尚不存在的 Temp 子目录。输出目录父级必须已存在。runner 不覆盖旧收据；失败也按原样保存。

    node C:/Users/cina/AppData/Local/Temp/cinatoken-public-early-controls-browser-ea4cfe25cf774b9fb7d91829a7aa5e19/run-public-early-controls.mjs http://127.0.0.1:64896 C:/Users/cina/AppData/Local/Temp/cinatoken-public-early-controls-browser-ea4cfe25cf774b9fb7d91829a7aa5e19/local-run-001

同一脚本可将 origin 改成 https://cinatoken.com，前提是新实现的 exact 候选已部署且根代理实际确认生产 tag/version。只有 origin 参数变化；必须使用新的输出目录。

只允许 owned loopback HTTP 或固定 CinaToken HTTPS origin。浏览器始终新匿名 context，阻断私有/外源 URL、非 GET 和其他 API；仅精确 /api/user/me GET 可额外放行，并强制读取到 401 + success:false/message:Unauthorized，才归类预期。不会读取个人浏览器配置、认证会话或存储快照，也不会点击登录或发业务写。

需要如下产品契约：

- head 的 nonce inline script 安装 window.cinatokenPublicPreferences，提供 syncControls 和 dispose；root 后脚本同步 SSR 控件。
- 两个公开 header select 使用 data-cinatoken-public-preference=theme|locale。
- 实际 PublicShell hydration commit 后 useEffect 写 html data-cinatoken-public-hydration=ready。

13 个独立 fresh context：

1. entry 主 bundle hold：真实选择 dark，Cookie/class 立即生效，释放后帧观察无回滚、h1/useId 原节点保持；再测 light/system 与媒体变化。
2. 非 entry 动态 chunk hold：初始 dark Cookie，真实选择 light，释放后保持，再移动 390×844 硬重载。
3. entry hold：真实 en→zh，保留原 query bytes/hash，canonical 按既有规则无 query/hash；实际 main-frame document request start 只一次。
4. dynamic hold：ja→ko，同上；继续 hydration 后另一真实语言选择也恰一次 document request start。
5. document.cookie setter 注入 SecurityError：真实主题输入成功写入内存偏好，Cookie 保持未写；释放/后续 hydration 后不回滚，第二个真实选择继续可操作。
6–9. en/zh/ja/ko 正常 SSR + 实际控件，包含两个 390px context、native keyboard、system media；对应译文、可访问名字、canonical 和跨语言主题保留。
10–13. 真 javaScriptEnabled:false 的四语 SSR 正文和 native select 可见，包含两个移动端；不伪称 JS disabled 下偏好 handler 可运作。

main hold 使用 goto(waitUntil:commit)，因 defer 未完成会阻止 DOMContentLoaded。dynamic hold 放行从实际 preflight HTML 得到的 entry，至少一个真实非 entry script request 进入 gate 才算测试前提成立。早期动作明确要求真实 shell hydration 还没有 ready，选择生效后资源仍 pending，才释放。

main/dynamic 都只延迟 route.continue，HTML、静态资源和匿名 401 都来自实际 HTTP origin。脚本不模拟 SSR HTML、不改生产响应、不直接调用偏好 helper、不使用 React 私有属性或 force click。初始化诊断脚本仅读取 DOM、监视 CSP/pageshow，和指定 case 的 cookie setter 失败 seam。

每个实际 HTML 响应都保存原字节及 CSP 头，检查所有脚本 nonce 与 script-src self，禁止 script unsafe-inline/unsafe-eval 和内联 onchange/oninput。浏览器 bypassCSP=false，所有未分类 policy violation/page error/asset/HTTP/request/console error 均失败。只按精确已验 401 请求解释相应网络 console。

每次 script/CSS 响应保存实际 bytes/SHA；同 URL 的资产内容在整个执行过程中必须一致。这里只保证观察到的 HTTP 内容一致，不能替代根代理针对 frozen manifest 的原字节与 build contract 验证。来源绑定、source/input inventory before/after 和 artifact 校验由根代理独立完成。

每个 case 有 90 秒 deadline；启动下一 case 前必须在 12 分钟总预算内留足 95 秒。控制台逐 case 输出小摘要；case JSON、公开 document HTML、截图、最终 report.json 全部使用 wx 不覆盖。所有 gate 都在 finally 释放并等 route 任务结束，所有 context/browser 的关闭结果明确记录。

report 的 intendedExitCode 是计划返回值；真实命令 process close/exit 要由根代理自己的闭合执行器收据证明。13 case 未完整尝试或任一 case/fatal/cleanup 失败，整体 code=1。失败不改写为通过。

BFCache 不计入通过：本机 Playwright Chromium 默认实参明确包括 --disable-back-forward-cache（已只读核安装 lib/coreBundle.js:34645）。runner 保持该默认模式，记录实际 pageshow.persisted，但不把 reload 或普通 history navigation 冒充 BFCache restore。需要将来在另一个明确开启 BFCache 的 owned browser 模式做独立 persisted=true 验收。

本脚本只有公开 SSR 偏好/语言控制范围，不证明真实身份/工作区/密钥、原生数据库、完整 theme/layout/a11y、SSE source.cancel、账务结算、G7/G8 或迁移整体完成。
