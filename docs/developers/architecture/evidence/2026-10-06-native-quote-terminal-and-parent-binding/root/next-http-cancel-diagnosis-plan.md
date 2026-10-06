# 下一批 HTTP 取消诊断建议（尚未实现或运行）

来源：remaining_gate_inventory 对已封 dc7 executor 事件及锁定 Workerd 源码的只读审查和随后任务内建议。封存报告 FINAL-v364-request-signal-readonly-diagnosis.json 为 32661 B，SHA256 961fbddd0dfdc849c8630cc4d528b1a992e308b0f0daa0c4db4a58521062420e。此文是任务内方案，没有新执行或通过结论。

原四 direct HTTP 臂已启用 enable_request_signal，两 RST 原轮询事件真实 holder signal-abort=true，而真实流 cancel 仍 NULL/1。disable flag 负控制不能修复原失败。下一最小对照是在原锁定运行时、同一 bare RST 拓扑中额外比较“等待异步读取”与“有限数据等待写出”。保持原臂不动；新臂数据源独立、有界，断开时保留真实 ReadableStream.cancel 回调记录。若新臂可取消而原臂不能，只支持悬挂读取关联，不能确证 C++ 响应泵析构路径。

分别记录 request.signal abort、独立业务清理 hook 和真实流 cancel 回调。信号监听器不得调用 reader.cancel() 或写原 cancel:<nonce>；显式业务清理不能替代原流取消断言。若需内部路径确证，应另做同 Workerd tag 的诊断构建，记录 pumpToImpl 异常、协程销毁及 DrainingReader 析构；诊断构建不代表原二进制验收。

原8 tests、四 transport 臂、flag/date、100×10 ms、尾部4秒、全部断言及原失败保持。新臂 baselineEligible=false，只作额外诊断。原 baseline1/四臂 NULL/1继续使总体失败；只有原回调真实执行并满足原门槛，才改变原取消结论。当前没有源写入、额外 Workerd 运行、CI 调度或生产变更。
