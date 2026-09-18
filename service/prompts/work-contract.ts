/**
 * The static work contract: what every operation accepts, how an approved release is delivered, and
 * the principles a turn works under. None of it changes between turns, so the `contract` operation
 * serves it on request instead of `context` repeating it in every response.
 */
export const workContract = {
  operations: {
    'understanding.upsert': `\
{id?, revision?(更新必需), kind:fact|assumption|unknown|capability|constraint, title, statement, relevance, \
verification, status:active|invalidated|retired, evidenceIds:[], reviewAt:ISO时间}；只保存影响决策的认识，\
事实与推翻需证据；沿用旧 ID 保留版本。verification 写明如何复查，过期认识需要更新后才能成为行动依据。`,
    'decision.choose': `\
{objectiveVersion:strategy.objective.version, options:[{title,kind:act|investigate|build_capability|observe|stop\
,benefit,cost,uncertainty}], selected:从0开始的索引, rationale, nextStep, expectedOutcome, evaluation, stopWhen,\
 expectations:[{id,kind:outcome|guardrail,claim,scope,source:{kind:file,path}|{kind:watch,watchId}\
|{kind:execution,command},verification,disconfirm,notBefore?:ISO时间,deadline:ISO时间,\
rule?:{pointer:JSON-Pointer,operator:gte|lte|equals,expected:标量},measurement?:{metric,goalRelation,limitation,\
comparison:absolute|delta,baseline:{evidenceId}|{unavailable:具体原因},freshness:{pointer:原数据ISO时间字段,\
maxAgeSeconds:1..2592000},checks:[{label,pointer,operator:gte|lte|equals,expected:标量}]}}], \
understandingRefs:[{id,revision}], memoryRefs?:[{kind:understanding|decision|learning,id,revision,\
use:apply|adapt|avoid|not_applicable,reason}], evidenceIds:[], watchIds:[], reviewAt:ISO时间, maxRuns:1..32, \
itemId?}；expectations 需要 1..8 项，至少一项 outcome；stop 可为空。事先约定观察的实际文件（可以尚未创建）\
或现有 watch，以及适用对象/版本、验证办法、反证和观察期限。notBefore 默认选择时刻；需要等样本成熟时明确设置。\
测试/构建使用 execution 来源并先 execution.prepare，rule 核对 /exitCode equals 0；watch 证据保存完整 HTTP JSON \
响应，rule.pointer 从原始响应字段开始，例如 /checkStatus，不会包装成 /value；其他可核对数值用 rule，\
定性结果省略 rule 并说明验证办法；不能虚构量化收益。观测业务或运行指标时一起设计 measurement：metric \
写清单位与分母/统计口径，goalRelation 说明与目标的关系，limitation 记录代理指标局限；checks 需要 1..8 \
项与本项目相关的数据质量条件（如足够样本、完整采集、同一人群或版本），用字段规则而非主观声明。baseline \
引用选择前同一来源的最新真实证据；没有基线写 unavailable 并先补齐能力。absolute 核对原值，delta \
核对原值减基线（非相对百分比）；delta 没有合格基线不能得到确定结果，原基线不得事后补写。freshness \
从原始数据时间算起，采集时间不能冒充数据时间。将不能牺牲的目标条件列为 guardrail。原始预期不可修改，\
变更口径需复盘后建立新行动并说明差异。每频道一个选择，不重复占用 feature；参考经验保存版本与适用理由。itemId \
只能是分派给本频道或无人负责的事项，选择行动即接手；别的频道负责的事项不要改动。`,
    'decision.review': `\
{id,revision,outcome:improved|not_improved|inconclusive|abandoned,conclusion,evidenceIds:[],nextDirection,\
assessment:{results:[{expectationId,verdict:met|not_met|unknown,reason,evidenceIds:[]}],\
conditions:matched|changed|unknown,conditionReason,diagnosis:expected|pending|measurement|execution|assumption|e\
nvironment|uncertain,explanation,adjustment:continue|observe|measurement|method|assumption|stop,\
understandingRefs?:[{id,revision}]}}；新行动必须逐项核对全部 expectations。引用约定来源、观察窗口内的新证据，\
包含最新观察，旧基线和 agent 陈述不能证明效果。rule 由系统核对实际 JSON 字段；缺字段/类型不符为 unknown。\
条件不可比、数据未到或采集故障用 inconclusive；全部预期和 guardrail 有证据支持才可 improved。原因不明可以明确 \
uncertain，观测到变化不等于因果已证明。诊断记录应区分执行、假设、环境与观测问题；adjustment=assumption 时先用 \
understanding.upsert 保存新认识/修订，再引用准确版本。旧行动无 evaluationVersion 时仍按旧格式复盘，\
不伪造事前预期。`,
    'observation.read': `\
{decisionId}；只读核对原始计划、基线、最新窗口内观测与数据质量，返回 \
observations（ready/waiting/needs_repair/unplanned）、系统 verdict、原值/基线/比较值及具体 issues；context.\
strategy.decisions 同时包含此状态。仅为规则核对，不代表独立复核或业务因果证明。缺数据先调查、建立观测能力或等待；\
检查通过才按实际结果复盘。`,
    'memory.search': `\
{query?:关键词（空格分隔时都需匹配）,kind?:understanding|decision|learning,limit?:1..30,offset?}；\
搜索本项目全部历史认识、行动复盘及经验，不受 context 最近记录数量限制。只读，无需 requestId。`,
    'memory.recall': `\
{query?:拟解决的问题或候选行动,itemId?,limit?:1..12}；按项目内文字相关性和同一 feature 召回历史认识、复盘及经验，\
包含失败与失效记录。省略 query 时按当前方向召回；context.strategy.relatedMemory 自动提供最多 6 条。\
排序不是可信度，先 memory.read 核对全文和条件，再用 decision.choose.memoryRefs 记录适用性。只读，无需 requestId。`,
    'memory.read': `\
{kind:understanding|decision|learning,id,beforeRevision?}；读取完整记录及分页版本历史。只读，无需 requestId。`,
    'feature.complete': `\
{id,revision,status?:verified|resolved(默认resolved),summary,nextStep,evidenceIds:[],review?:decision.review的完整输入}；\
明确修复完成后优先一次调用此入口，无需另建实验或先请求复核。已有本频道当前行动时必须附上同一事项的review，\
保留原预期逐项核对；没有当前行动时省略review。框架原子保存复盘与事项完成意图，共用一次独立复核，通过后自动\
应用，无需再开一轮关卡。失败、未知、新证据、源码变化或人工修改不能自动签收。回执pendingVerification不是完成；\
读取context.finalizations核对结果。此操作不批准发布，也不证明业务收益。`,
    'feature.upsert': `\
{id?, revision?(更新必需), title, summary, kind:feature|issue|opportunity|hypothesis, \
status:open|investigating|verified|resolved|blocked, evidenceIds:[], nextStep}；同一 feature 沿用 ID，\
引用真实证据。只推进 ownerChannelId 为本频道或为空的事项；别的频道负责的事项不要改动，可以在正文提出建议。\
写入无人负责的事项即接手（ownerChannelId 记为本频道），resolved 后自动交回无人负责，blocked 保留负责频道。`,
    'evidence.native': `\
{before?,limit?:1..20}；只读列出本频道当前绑定 App 任务的原生工具条目ID，其他频道/任务不可见。没有绑定的 App \
任务时返回 409。`,
    'evidence.link': `\
{itemId?,summary,nativeItemIds:[1..20]}；读取原生记录并保存有界快照，跨频道/任务404；沿用写操作request-id。\
内联图片最多384KiB，外部引用不下载，不代表执行或验收通过。`,
    'evidence.record': `\
{itemId?, summary, source, observedAt, data?}；记录为 agent 陈述，不能伪装为系统观测。`,
    'evidence.capture': `\
{itemId?, summary, path}；读取项目内实际文件，保存内容与 SHA256，可用于测试日志或分析数据。`,
    'evidence.read': `\
{id}；读取本项目某条证据的完整内容。context 与写操作回执只给来源、摘要、SHA256 和 bytes，不回放内容，\
需要原文时用这个操作。只读，无需 requestId。`,
    'execution.prepare': `\
{command:实际原生命令的完整字符串}；测试/构建前调用，框架封存当前源版本。随后在同一原生轮次、\
项目根目录执行完全相同命令。Morrow 直接从原生事件保存命令、输出、退出码、任务/轮次和执行前后源版本；execution.\
read 读取。不要用自行生成的 JSON 或 package.json 证明执行成功。没有当前 App 任务与轮次时返回 409。`,
    'execution.read': `\
{id}；读取准备记录及自动采集的原生执行证据。未收到开始事件、输出不完整、版本变化或没有退出码时不能证明成功。`,
    'verification.request': `\
{itemId?,decisionId?,evidenceIds:[]}，或发布级 {kind:"release",itemIds:[1..30],evidenceIds:[]}；\
准备完实际证据后发起有界独立只读复核。不传执行者的通过结论。事先保存的预期是验收条件；有关联预期时，补充 \
feature 进度说明不会使复核失效。已覆盖的证据子集复用同次复核，新原始观测仍须核对；修正后提交新版本/新证据。读取 \
verification.read 或 context 中的结果，把反例交回本任务修正。新行动 improved 与 feature \
完成会自动触发此步骤（按事项自身的当前源版本复核），尚未通过时返回 pendingVerification，不能当成已完成。\
kind:"release" 是发布前的一次候选版本复核：itemIds 是本次要发布的事项，\
每个至少已有一次复核通过（可以是当时的源版本，否则返回 409 并列出从未通过的事项）；走 App 任务的频道 \
evidenceIds 必须包含至少一项绑定当前源版本的 execution 证据（先 execution.prepare，再在同一原生轮次跑完整检查），否则返回 \
400；CLI 频道没有 App 任务，改为至少一项实际文件或 HTTP 采集证据（evidence.capture / 观测），复核者在隔离检出里亲自重跑检查，不能用 agent 自述或伪造 execution 替代，否则返回 400。\
复核者会核对这些检查确实属于当前源码（App）或亲自重跑（CLI），并逐个事项检查其复核后的改动有没有推翻原结论。\
发布级复核绑定请求时的源版本；同一源版本与同一事项集合不会重复付费，已有结论（含 failed/unknown）直接复用，\
未知结果用 verification.retry 有界重试，反例先修正源码。源码再变更后只需重做发布级复核，不必逐项重核。`,
    'verification.read': `\
{id}；读取独立复核结论、问题、源版本是否仍有效和原生记录。queued/running 时可以做独立工作，或 wait \
等待（不紧密轮询）；已提交的 decision.review/feature 完成请求会在通过后自动落库，不需要再花一轮重提；从 context.\
finalizations 查看 applied/stale/rejected。旧 requestId 仍只重放原回执，请读取当前状态。stale \
时先合并新版本再提交；failed/unknown 时先解决反例或缺少的证据。`,
    'verification.retry': `\
{id}；环境恢复后重试尚未判断的复核，原记录不可覆盖，相同材料每天最多两次，仍计入频道预算。failed 必须先修正反例。\
重试会接续仍有效的原完成请求，并带上有界的前次工具观察；仍须本轮独立检查，不能继承旧结论。`,
    'learning.upsert': `\
{id?, revision?, itemId?, kind:outcome|hypothesis|experiment, title, rationale, expectedResult, evaluation, \
conclusion, status:active|supported|refuted|inconclusive|stopped, evidenceIds:[]}；目标成效、\
竞争解释与尝试都可记录，结论更新引用新证据。`,
    'watch.create': `\
{itemId?, title, kind?:http|file, url?(http), path?(file), pointer, condition:changed|gte|lte|equals, expected?,\
 intervalSeconds:30..86400, deadline:ISO时间, releaseId?, continuous?:boolean}；省略kind兼容HTTP。\
file仅接受项目内普通文件，拒绝符号链接；不存在时安静等待；JSON保存原数据及pointer取值，非JSON仅支持空pointer，\
同一错误只审计一次。默认持续监测；changed首次仅建基线；file注册时缺失则首次出现唤醒，注册时存在则首次只建基线。\
file带pointer按选定值比较，空pointer按全文摘要比较，证据digest始终为原字节摘要。deadline为复查期限；\
continuous:false为一次性，取消或暂停停止轮询。关联releaseId时上线后采样。不支持command观测。`,
    'watch.cancel': `\
{id}；停止已不再有价值的观测。`,
    wait: `\
{watchIds:[], releaseIds:[], deadline:ISO时间, reason}；任一条件满足或截止后唤醒，保持自动工作开关；\
有独立工作可做时不要等待。`,
    'release.propose': `\
{itemIds:[], title, changes, rationale, expectedBenefit, checks:[{name,result:passed|not_verified,evidenceIds:[]\
}], risks, rollback, observationPlan, artifactPath, target:{kind:"http",url,statusUrl,label} 或 \
{kind:"local-script",label,script,args?:[],timeoutSeconds:30..3600,statusScript?}}；准备好的文件复制封存，\
变更内容不可修改。至少一项通过的检查须引用实际采集证据。发布门禁有两半：每个 itemIds \
里的事项至少有一次独立复核通过（可以是改动当时的源版本，记入 verificationIds），并且存在一次当前源版本、\
覆盖本次全部 itemIds 的发布级复核通过（verification.request kind:"release"，记入 releaseVerificationId）；\
缺少时返回 409。源码在发布级复核后再变更，只需重做发布级复核。人批准后由发布接口发送封存产物或执行封存脚本。\
kind 省略时按 http 处理。local-script 的 script/statusScript 是项目内的相对路径，\
必须是已经提交在项目里的普通文件（≤256 KiB）；args 最多 16 项、每项 ≤1000 字符，作为参数数组传给脚本，不经过 \
shell；label ≤100 字。脚本内容在提议时被复制封存并计入 reviewHash，之后修改项目里的原文件不会改变将要执行的内容。\
你不能提供或修改脚本摘要，也不能自己执行发布。`,
  },
  releaseAdapter: `\
http 目标：发布端接收 POST {releaseId,reviewHash,artifact:{name,sha256,base64}}，Idempotency-Key 为 releaseId；\
仅在响应 {releaseId,artifactSha256,status:"published",url?} 匹配时认定已上线。statusUrl 的 GET \
返回同一回执用于重启/超时后核对。local-script 目标：人批准后，Morrow 在项目根目录以固定最小环境执行封存脚本，\
只有 PATH、HOME、NO_COLOR=1、TMPDIR（可选，仅当服务自身有该变量时透传）、MORROW_RELEASE_ID、\
MORROW_ARTIFACT_PATH（封存产物副本）、MORROW_ARTIFACT_SHA256、MORROW_REVIEW_HASH、MORROW_PROJECT_PATH、\
MORROW_RECEIPT_PATH、MORROW_RUNTIME_CACHE，不含服务凭据和其余环境变量；退出码 0 且最后一行 stdout 是 {releaseId,\
artifactSha256,status:"published"|"failed",...} 才认定结果，非零退出、非 JSON 或超时保持 unknown，\
由回执文件（MORROW_RECEIPT_PATH）或 statusScript 事后核对，不会自动重跑。输出合计保留最后 1 MiB 作为 log。\
先在已有授权内准备真实接收端或已提交的脚本与产物，不能编造地址、脚本路径或摘要；\
缺部署能力时继续准备工作并明确缺口。`,
  principles: `\
主动选择服务目标的工作，必要时先建立反馈。证据、解释和预期收益分开；效果未知时保留未知。\
人只在发布前批准已准备好的明确版本，AI 没有批准接口。所有频道共享此处记录；失败尝试应更新判断，避免机械重复。\
先读 strategy 的认识、选择与复查信号，具体工作方法由你判断；工程与运营只是可能方向。评估直接改进、获取信息、\
建设能力、观察或停止的价值。明确修复用 feature.complete 一次提交证据与完成意图；探索或效果实验才用\
decision.choose 记录依据、验证与止损条件；已有reviewReasons时保留复盘要求，完成时可随feature.complete提交。\
复盘保留原预期，结果未知时可以继续观察。需要历史经验时使用 memory.search/read；失效认识只能作为历史教训。\
不要通过增加事项、文档或技能数量证明进展。`,
};
