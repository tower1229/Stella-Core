# 复用安装的身份绑定：离线小包

基线 `96cbe4d31f0e8868d96ecc4afc91e2f734813a08`。本片只新增
`scripts/lib/reused-consumer-identity.mjs` 和确定性测试；唯一当前状态仍在
[PROJECT-STATE.yaml](../PROJECT-STATE.yaml)。旧10.8离线profile、8.2门槛、consumer锁验证器及历史receipt不改。

`verifyReusedConsumerIdentity(input, expected)`只读调用者明确指定的固定源码、
tgz文件、consumer安装树和现有OpenClaw10.8 SDK。它只运行既有的本地Git身份读取；
不导入产品/SDK/依赖代码，不执行CLI、安装、网络、Gateway或模型。

## 三种摘要不能混用

| 字段 | 实际来源及含义 |
| --- | --- |
| `sourceLockSha256` | 固定、干净源码提交中的package-lock文件；用于核对普通运行依赖版本，不是consumer安装锁。 |
| `installationManifestSha256` | 对本次实际路径、包文件树、依赖闭包、SDK元数据/入口和固定源码/产物身份的JSON观察摘要。它是独立的新格式，不放进旧consumerLock字段。 |
| `consumerLock` | 此模式只支持缺少consumer/package-lock.json的复用安装，值为null。发现真实、复制、空或断链symlink锁都拒绝本模式，不覆盖或忽略它。 |

`expected`必须来自另行固定的源码、打包文件清单和依赖复制证据，不能从待验证报告自身取得。
必需字段为`coreRevision`、`sourceManifestSha256`、`sourceLockSha256`、
`artifactSha256`、`coreManifestSha256`、`hostPackageSha256`、`sdkEntrySha256`
及按包名索引的`dependencyManifests`。摘要均为严格字符串。

`input`给出规范绝对路径`sourceRoot/consumerRoot/hostRoot/artifactPath`。
源码必须干净且提交/全跟踪文件摘要匹配；源码锁、构建元数据、Core产物版本和显式SDK版本必须一致。
Core实际解析入口必须为consumer下的`dist/src/plugin.js`；Core及复制依赖树不能含symlink。
唯一SDK例外是显式提供的现有Host安装，公开plugin-entry的实际解析必须落在该根内。
普通运行依赖沿每条声明边核对实际解析、固定锁版本及整个复制文件树，拒绝新增/缺失/额外清单、
嵌套shadow副本和工作树回退；重复或循环依赖不会跳过边检查。

输出`identityConsistency=validated_reused_installation`只表示这些观察与独立预期一致。
`cliVerified/hostExecutionAccepted/profileAccepted/formalConsumerAccepted/fullMemoryAccepted/realModelAccepted`
始终false；没有缺CLI事实的成功出口，没有把本摘要接入旧profile。

## 明确的验证边界

- 本函数指纹绑定tgz字节和调用者独立固定的解包树摘要，不自行解包或证明两者对应；
  后续打包/解包证据必须建立这一联系。合成测试的tgz仅为不执行的占位字节，不冒充真实包验收。
- SDK只读取显式安装的package.json及公开plugin-entry解析文件，不证明整个SDK传递模块树、
  registry原包真实性、真实加载或模型消费。需要这些事实时由后续捕获包独立提供。
- 这是有限的文件观察快照，末尾重新检查源码；不承诺活跃安装的原子快照或运行中防篡改。
- 实际require解析审计不冒充完整ESM模块消费审计。未来Host仍须直接加载固定新产物，
  保留真实factory/hook/execute/退休来源、receipt精确回读及下一请求freshness。
- 现有focused consumer已清理，没有可沿用的安装锁；旧包证据也不覆盖96cbe4d3新增观察代码。
  本片不新建持久consumer、凭据、grant或运行环境，不处理旧EPERM现场或SDK drain。

## 作者验证

最终作者定向结果162/162（新增56＋原版本/profile106），0失败/取消/跳过；两组包含父组计数，不与历史或独审相加。typecheck、最终测试编译和脚本语法均exit0。作者冻结阶段待独审；现已完成下述独审，按授权仅保存本切片。测试只用临时合成文件、
本地无remote Git和会抛错的假产品/SDK模块，检查身份/版本/锁/解析拒绝及旧gate保留。

本片只读确认现有SDK元数据和公开入口为10.8；没有实际consumer安装/导入或Host消费。SDK package.json摘要为 `9be09f47e73b05da1736aaeab337b4c0cfe35921bcc5b7a185a44b9fe70d2acc`，公开入口摘要为 `ec4f82c9bc0e35cfe2c2d164f4f55ff86e623324cc928fc14bc8c70e508322ed`。

原始验证摘要（不是原日志副本）：

| 原件 | SHA-256 |
| --- | --- |
| typecheck.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| final-compile.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| final-targeted.tap | `7aaafc6e87878ce1d1c62b154fdd212039cbb466306958757bca574a3d08d585` |
| SDK-METADATA.json | `4b55624598f5db74387b16fd397681d3601753a620d31a8af8804b0af590a75f` |

首轮159/159也保留；最终增加循环依赖边的3个Node结果后重编译并验证162/162。未运行观测178项、全量、Host或模型，未安装依赖。候选后续独审结论见下文，capture与runner仍另包。

## 独审及保存范围

[独审摘要](evidence/2026-10-29-reused-consumer-identity/independent-review.json)确认四文件离线契约可保存：独立162/162（12父组、150叶子），含新模块56与既有106；14个额外检查单列通过，不与162或作者结果相加。独审原摘要SHA-256为 `63d44c0f0ad2747f3ba4cce5482880468e809654a67f0ca6bfaf3cf05e62d481`，本仓库归档是另有自身hash的非敏感派生摘要，不冒充原件字节。

独审复核了现行固定锁的8包普通依赖图，图内无optional/peer边，OpenClaw peer单独显式绑定；不据此宣称通用optional/peer闭包。实际tgz解包关联、当前真实consumer/Host、完整SDK及ESM消费、CLI和正式gate仍未验。作者首轮159及最终162的历史不变，旧验证器未放宽。本次仅更新归档/状态，模块及测试保持独审冻结hash，不重跑验证；实际提交与远端SHA以Git核实为准。
