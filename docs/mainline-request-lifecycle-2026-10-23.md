# 肃清之后：主线请求生命周期修复

2026-10-23。按用户“提交并推送，然后回到 Stella Core 主线”执行。
肃清收尾 `1fa519b613ce82ad44af449b823f2b9cd7d7a411` 及其之前28个提交已推到
`codex/issue23-integrated-regression`；没有合并/改写master，没有发布版本。

## 当前最优先的本地工程结果

正常连续聊天的第65个用户请求会被 `checkpoint_agent_duplicate_or_capacity` 拒绝。
原因是64个容量上限检查了进程内“曾见run”集合，已结束的请求也永久计数；同时，异步
准备中的请求未进入维护互斥，结束准备后晚返回的结果仍可能签发grant。

修复将防重放身份与当前pending/live容量分开：保留原seen-run拒绝，最多64个并发准备/
活动grant；准备失败、明确handled、结束、关闭按本次controller身份释放槽位，结束的
grant移出共享Map并清理数据缓存/工具call。准备槽位属于相同共享registry scope，物化
维护必须等待它们结束；late completion不能复活grant。volatile SDK store键升v4，
没有改变磁盘checkpoint/journal格式、来源权限或原expected CAS。

正常取消仍合并Host取消和Core本次准备的取消信号。Host继续负责模型/tool loop/历史，
没有Host补丁、provider代理、输出缓冲或运行中撤权新门禁。

## 验证与证据层级

- 修复前的有效合成复现3/3失败：精确第65轮、pending维护互斥、结束后late grant。
  初次独立编译缺schemas资源的夹具错误保留原件，不计为业务根因；补齐后才得到上述结果。
- 修复后三项通过；完整checkpoint供给回归 **73/73通过**，0失败/skip/cancel。
  含旧run拒绝、跨注册、身份/权限、归档、下一用户请求新版本和正常取消。
  65轮压力检查未开启自动归档，不扩大为所有生命周期容量已解决。
- 原版OpenClaw2026.8.2、Node24.22.1、全新合成workspace/state及loopback假模型：
  新编译完整plugin入口经标注public observer wrapper完成同session三轮、9份wire，
  每轮归档一次、保留正常历史、下一请求当前B工具事实。它不是新安装包验收或真实模型质量。
  首次尝试遗漏完整plugin编译入口、0模型请求；已保留，不当作产品失败或通过。
- 本地全量TypeScript检查通过。测试未访问main、私人资料、真实API/凭据，未调用ps。
  自建测试Gateway/runner均已退出；开发main继续运行。

本机原件：`.artifacts/checkpoint-request-capacity-20261023/` 的baseline-a2、fixed-a1、
supply-regression-a2结果和日志；`.artifacts/suqing-batch18-20261023/host-launch-a2.json`、
`host-probe-a2/result.json`及完整provider wire。原命令、退出码和源码hash均记录，不提交产物。

## 首次推送 CI 的8项失败

[CI39960432060](https://github.com/tower1229/Stella-Core/actions/runs/39960432060)
prepare在check/check:schemas通过后，完整测试8项失败：

1. 六项delivery ledger失败：肃清正式契约已更新，而catalog静态hash/行定位未刷新。
   仅刷新24项对应pin/定位，原40工作项、49验收要求与版本匹配门禁不变。
   定向检查10/10通过，含契约篡改拒绝。
2. 一项旧capability Gateway fixture期待默认强代码身份capture成功，但该旧路径已明确
   拒绝。测试现在通过受信任构造端口注入明确synthetic binding，默认真实capture仍拒绝；
   Gateway/config不可传绑定，伪造参数负例保留，不冒充真实Host完整能力收据。
3. 一项shutdown fixture仍期待取消实例继续assertRun。现确认取消实例的准入被拒绝，
   仍可执行撤销清理，由活动实例核对持久化的retain/sibling状态。

初始化两文件9/9通过；测试锁显式使用Core标准库保守端口，不调用Darwin SDK可能涉及ps的
默认锁。生产默认路径未替换。CI结果仍需按修复后的远端run确认，不以本地通过冒充远端通过。
原首次CI失败证据位于`.artifacts/push-mainline-20261023/ci-initial-prepare`。

## 当前主线顺序与没有完成的事项

1. **持续使用**：64个已结束请求的误阻断已修复；归档 ingress 累计256个 frames 限制
   也已在 `945d7000` 修复。合成 Host API 夹具验证260次实际 Core/Git 归档及 journal 重放，
   256仍限制同时活动的不同请求；正常安装包 Host 接缝另行验收，不宣称任意长运行已证明。
2. **真实网页入场**：现有Chrome只读RPC操作受AppleEvent-1712阻塞，profile未知。
   用户在同一网页Debug/manual RPC调用`stella.identity {}`即可提供元数据；不要用CLI主体、
   显示名或设备ID代替，不重放真实聊天。
3. **精确授权后接通本人真实使用**：取得可信ID后，单独确认main的
   `webchatOwnerProfileId=<ID>`与processing grant追加`openclaw-profile:<ID>`，保留原用途/
   受众/逐对象策略及Telegram主体；显式来源新revision/checkpoint CAS。未知旧历史不接管。
   真实模型/资料外发、凭据使用与费用另定，辅助策略判断和Host标题请求均计入范围。
4. **行为与完整主线**：#31 的当前安装包 Skill 全文、角色/顺序及指令预算证据按
   [窄项验收说明](SKILL-CONTEXT-ACCEPTANCE.md)收敛；真实模型行为质量仍未验收。按#24及前置收敛
   correction/learning/OngoingWork 的 checkpoint 迁移。一个 writing work 的本地纠正 writer
   已按[最小分支契约](CHECKPOINT-CORRECTION-WRITER.md)通过合成 Git/CAS、重启/重放/故障恢复
   验证；正常 Host 的 Personal Views 消费入口仍待接线，其他 learning/outcome writer 未迁移。
   不能把原话归档或内部 writer 通过冒充 #24 的真实 Agent 接续。
   已确认代表场景仍是按需社交判断和写作共思，不为六类能力凑新必过用例。

main仍使用批17包`7d7b660b…`/源码`b07d91bb`和原c595来源，本批没有部署新代码或改真实
profile/grant/config。完整full_memory和更多#35–39出口仍未关闭；运行中撤权/输出拦截
保持D-058已取消范围。详见[肃清完整收尾表](suqing-closeout-2026-10-23.md)与D-059。
