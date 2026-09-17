/**
 * FlyClash 版 Smart 内核覆写管理（从 Clash Party smart_core 分支移植）
 * ---------------------------------------------------------------------------
 * 移植时按 FlyClash 的实际实现改掉了这些地方：
 *
 *  1. 不再走 Clash Party 的 ./override 模块（addOverrideItem / getOverrideItem /
 *     getOverride / removeOverrideItem）。FlyClash 的覆写在 Rust 侧
 *     （src-tauri/src/overrides.rs + SQLite overrides 表），前端只有 window.electronAPI 上的
 *     getOverrides / addOverride / updateOverride / deleteOverride /
 *     getOverrideFileContent / updateOverrideFileContent。
 *
 *  2. 条目字段沿用 FlyClash 的形状：{ id, name, type: 'local' | 'remote',
 *     ext: 'js' | 'yaml', file?, url?, enabled, global }。
 *     local 类型的正文放在 file 字段里，Rust 侧取出后加密入库。
 *
 *  3. 不再依赖 getAppConfig 里的 enableSmartCore / enableSmartOverride /
 *     smartCoreUseLightGBM / smartCoreCollectData / smartCoreStrategy / smartCollectorSize
 *     （FlyClash 没有这些设置项），改成函数入参 + DEFAULT_SMART_OVERRIDE_OPTIONS。
 *
 *  4. 是否安装由「当前内核是不是 mihomo-smart」决定，通过 coreGetCurrentConfig() 读取。
 *
 *  5. 脚本正文针对 boa_engine 重写（纯 ES5 子集、去掉全部 console 输出、幂等），
 *     参数块由 generateSmartOverrideScript() 注入，不再是整段模板字符串里塞 ${...}。
 *
 * 建议放置：src/services/smart-override.ts
 * 建议调用：应用启动读取设置后、以及 coreSwitchCore() 成功之后调用 manageSmartOverride()。
 */

export const SMART_OVERRIDE_ID = 'smart-core-override'
export const SMART_OVERRIDE_NAME = 'Smart Core Override'

export interface SmartOverrideOptions {
  /** false 时直接移除覆写（相当于原来的 enableSmartOverride 开关） */
  enabled?: boolean
  /** 工作模式：'auto' | 'convert' | 'create'，见脚本内注释 */
  mode?: 'auto' | 'convert' | 'create'
  useLightGBM?: boolean
  collectData?: boolean
  policyPriority?: string
  overwritePolicyPriority?: boolean
  /** vernesong 内核不识别该字段，留空即不输出 */
  strategy?: string
  collectorSize?: number
  newGroupName?: string
  useProviders?: boolean
  repointRules?: boolean
  renameConvertedGroups?: boolean
  groupSuffix?: string
}

export const DEFAULT_SMART_OVERRIDE_OPTIONS: Required<SmartOverrideOptions> = {
  enabled: true,
  mode: 'auto',
  useLightGBM: false,
  collectData: false,
  policyPriority: '',
  overwritePolicyPriority: false,
  strategy: '',
  collectorSize: 100,
  newGroupName: 'Smart Group',
  useProviders: true,
  repointRules: true,
  renameConvertedGroups: false,
  groupSuffix: ' (Smart Group)',
}

/** FlyClash 覆写条目的最小形状（对应 src/components/Overrides.tsx 里的 OverrideItem） */
interface OverrideItem {
  id: string
  name: string
  type: 'local' | 'remote'
  ext: 'js' | 'yaml'
  url?: string
  enabled?: boolean
  global?: boolean
}

interface ActionResult {
  success?: boolean
  error?: string
}

/** 只声明本模块用到的 electronAPI 子集，避免耦合 src/types/electron.d.ts 的导出方式 */
interface FlyClashOverrideApi {
  getOverrides: () => Promise<OverrideItem[]>
  addOverride: (item: Partial<OverrideItem> & { file?: string; url?: string }) => Promise<unknown>
  updateOverride: (id: string, updates: Partial<OverrideItem>) => Promise<unknown>
  deleteOverride: (id: string) => Promise<unknown>
  getOverrideFileContent: (id: string) => Promise<string>
  updateOverrideFileContent: (id: string, content: string) => Promise<unknown>
  coreGetCurrentConfig: () => Promise<{ success?: boolean; config?: { coreType?: string } }>
}

const PARAMS_BEGIN = '// <<<PARAMS-BEGIN>>>'
const PARAMS_END = '// <<<PARAMS-END>>>'

/**
 * 覆写脚本模板：内容与独立分发的 flyclash-smart-override.js 完全一致，
 * 只有 // <<<PARAMS-BEGIN>>> 与 // <<<PARAMS-END>>> 之间的参数块会被替换。
 */
const SCRIPT_TEMPLATE = String.raw`
/***
 * FlyClash Smart 内核覆写脚本（Override Script）
 * ---------------------------------------------------------------------------
 * 适用客户端：FlyClash（GtxFury/FlyClash，Tauri + Next.js）
 * 适用内核：  Smart 分支内核（vernesong/mihomo，FlyClash 内核管理里显示为「Smart 分支内核」）
 *
 * 相对 Clash Party / Clash Verge Rev 版本的差异（均已按 FlyClash 源码逐条核对）：
 *
 *  1) FlyClash 用 boa_engine（纯 Rust JS 引擎）执行覆写脚本，入口固定为 main(config)，
 *     脚本正文会被拼进一段包装代码里执行，且包装里只注入了空实现的 console。
 *     → 本脚本去掉了全部 console 调用（写了不会有任何输出），并且只用 ES5/ES2015 子集：
 *       不用可选链 ?.、空值合并 ??、Map/Set、String.replaceAll、Object.fromEntries、
 *       Array.prototype.includes 等新语法/新 API。
 *
 *  2) FlyClash 同一时间只允许一个「已启用」的全局覆写（全局项互斥，启用新的会自动关掉旧的）；
 *     覆写执行在运行时设置合并之前，且 proxies / proxy-groups / rules 三个数组以覆写结果为准，
 *     不会被设置项覆盖，所以这里的改动是最终生效的。
 *
 *  3) Smart 组选项以 vernesong/mihomo 的 SmartOption 为准：policy-priority / uselightgbm /
 *     collectdata，加上 profile.smart-collector-size。
 *     strategy（例如 sticky-sessions）是 Clash Party 自研内核的字段，vernesong 内核不识别 ——
 *     mihomo 的 group 解码器对未知字段不报错、直接忽略，所以填了不会崩，只是没作用，默认不输出。
 *
 *  4) mihomo 要求每个组至少有 proxies 或 use，两者都空会直接报 'use or proxies missing' 并拒绝启动。
 *     所以新建组时如果既没有顶层 proxies 也没有 proxy-providers，脚本会跳过建组，
 *     也不会去改写规则（否则规则会指向一个不存在的组）。
 *
 *  5) 脚本会被反复执行（每次重载/切配置都会跑），因此逻辑写成幂等的：
 *     已经是 smart 的组不会二次转换，已存在的 smart 组不会重复创建，改名也不会叠加后缀。
 *
 * 用法：FlyClash → 配置 → 右上角代码图标（脚本覆写）→ 添加 → 粘贴本文件内容 → 保存 → 打开开关
 * 提醒：只有在「当前内核 = Smart 分支内核」时才打开。切回普通 mihomo 内核后 type: smart 无法识别，
 *       内核会启动失败，请同时关掉这个覆写。
 */

// <<<PARAMS-BEGIN>>>
// 总开关（FlyClash 里脚本自身的开关已能控制；这里再留一层，方便脚本在线更新时保留状态）
var ENABLED = true

// 工作模式：
//   'auto'    默认。订阅里已有 url-test / load-balance 组 → 就地改成 smart；
//             没有这类组 → 新建一个 smart 组并把规则目标指过去
//   'convert' 只做类型转换，不新建组、不改写规则
//   'create'  只新建 / 刷新 smart 组，并改写规则目标
var MODE = 'auto'

// Smart 组选项（对应 vernesong/mihomo 的 SmartOption）
var USE_LIGHTGBM = false          // uselightgbm：用 LightGBM 模型给节点打分
var COLLECT_DATA = false          // collectdata：收集节点质量数据（会写本地数据）
var POLICY_PRIORITY = ''          // policy-priority：'pattern:factor;pattern2:factor2'，留空 = 不干预
var OVERWRITE_POLICY_PRIORITY = false  // 是否覆盖订阅里已有的 policy-priority

// vernesong 内核不识别 strategy，留空 = 不输出；Clash Party 等自研内核可填 'sticky-sessions'
var STRATEGY = ''

// profile.smart-collector-size
var COLLECTOR_SIZE = 100

// 新建组时的组名
var NEW_GROUP_NAME = 'Smart Group'

// 订阅只有 proxy-providers、没有顶层 proxies 时，把 provider 名挂到新建组的 use 上
var USE_PROVIDERS = true

// 新建组后是否把规则目标改写到该组（订阅原有的分流结构会被统一到这一个组）
var REPOINT_RULES = true

// 转换已有组时是否给组名加后缀（开启后会连带改写 rules / sub-rules / 其他组 proxies 里的引用）
var RENAME_CONVERTED_GROUPS = false
var GROUP_SUFFIX = ' (Smart Group)'
// <<<PARAMS-END>>>

/* ============================== 常量 ============================== */

// 需要被转换的组类型（mihomo 里的延迟选路类组）
var CONVERTIBLE_TYPES = ['url-test', 'urltest', 'load-balance', 'loadbalance']

// 规则末尾的参数，不是策略组名，不能被改写
var RULE_PARAMS = ['no-resolve', 'force-remote-dns', 'prefer-ipv6']

// 内置目标，不是策略组名，不能被改写
var BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']

// 只有 url-test / load-balance 才有的字段，转成 smart 后删掉（其实 mihomo 对未知字段是忽略的，
// 这里删掉只是让生成的配置干净一点；注意 strategy 也是 load-balance 的字段，必须清掉，
// 否则会和参数 STRATEGY 混在一起分不清是用户要的还是订阅带过来的）
var URL_TEST_ONLY_KEYS = ['url', 'interval', 'tolerance', 'lazy', 'expected-status', 'expected_status', 'strategy']

/* ============================== 工具函数 ============================== */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isArray(value) {
  return Array.isArray(value)
}

function contains(list, value) {
  return list.indexOf(value) !== -1
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function groupType(group) {
  if (!isObject(group) || typeof group.type !== 'string') return ''
  return group.type.toLowerCase()
}

function isConvertibleType(type) {
  return contains(CONVERTIBLE_TYPES, type)
}

/* ============================== 配置改写 ============================== */

// 写入 smart 组选项
function applySmartOptions(group) {
  if (OVERWRITE_POLICY_PRIORITY || !group['policy-priority']) {
    group['policy-priority'] = POLICY_PRIORITY
  }
  group.uselightgbm = USE_LIGHTGBM
  group.collectdata = COLLECT_DATA
  if (STRATEGY) {
    group.strategy = STRATEGY
  }
}

function stripUrlTestOnlyKeys(group) {
  for (var i = 0; i < URL_TEST_ONLY_KEYS.length; i++) {
    delete group[URL_TEST_ONLY_KEYS[i]]
  }
}

// profile.smart-collector-size（vernesong 内核的 Profile 字段，默认 100）
function setCollectorSize(config) {
  if (!isObject(config.profile)) {
    config.profile = {}
  }
  config.profile['smart-collector-size'] = COLLECTOR_SIZE
}

// 顶层 proxies 的节点名（去重，过滤脏数据）
function collectProxyNames(config) {
  var names = []
  if (!isArray(config.proxies)) return names
  for (var i = 0; i < config.proxies.length; i++) {
    var proxy = config.proxies[i]
    if (!isObject(proxy) || typeof proxy.name !== 'string') continue
    var name = trim(proxy.name)
    if (!name || contains(names, name)) continue
    names.push(name)
  }
  return names
}

function collectProviderNames(config) {
  if (!isObject(config['proxy-providers'])) return []
  return Object.keys(config['proxy-providers'])
}

/* ------------------------------ 规则改写 ------------------------------ */

// 定位规则里的「策略组名」位置：
//   MATCH,组名                 → 下标 1
//   TYPE,匹配内容,组名[,参数]   → 从下标 2 起第一个非参数项
function findTargetIndex(parts) {
  if (parts.length === 2 && parts[0] === 'MATCH') return 1
  if (parts.length < 3) return -1
  for (var i = 2; i < parts.length; i++) {
    if (!contains(RULE_PARAMS, parts[i])) return i
  }
  return -1
}

function rewriteStringRule(rule, resolve) {
  // 嵌套逻辑规则（AND,((...)),目标）里逗号语义复杂，跳过不改
  if (rule.indexOf('((') !== -1 || rule.indexOf('))') !== -1) return rule
  var raw = rule.split(',')
  var parts = []
  for (var i = 0; i < raw.length; i++) parts.push(trim(raw[i]))
  if (parts.length < 2) return rule
  var index = findTargetIndex(parts)
  if (index === -1) return rule
  var next = resolve(parts[index])
  if (next === null) return rule
  parts[index] = next
  return parts.join(',')
}

// resolve(name) 返回新名字，返回 null 表示这条不动
function rewriteRules(rules, resolve) {
  if (!isArray(rules)) return rules
  var output = []
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i]
    if (typeof rule === 'string') {
      output.push(rewriteStringRule(rule, resolve))
      continue
    }
    if (isObject(rule)) {
      if (typeof rule.target === 'string') {
        var target = resolve(rule.target)
        if (target !== null) rule.target = target
      }
      if (typeof rule.proxy === 'string') {
        var proxy = resolve(rule.proxy)
        if (proxy !== null) rule.proxy = proxy
      }
      output.push(rule)
      continue
    }
    output.push(rule)
  }
  return output
}

// rules 和 sub-rules 都要改写（sub-rules 是 mihomo 的子规则表，目标同样是策略组）
function rewriteRuleContainers(config, resolve) {
  config.rules = rewriteRules(config.rules, resolve)
  if (isObject(config['sub-rules'])) {
    var keys = Object.keys(config['sub-rules'])
    for (var k = 0; k < keys.length; k++) {
      config['sub-rules'][keys[k]] = rewriteRules(config['sub-rules'][keys[k]], resolve)
    }
  }
}

// 组名被改写后，其他组的 proxies / rules / sub-rules 里的引用要同步
function rewriteGroupReferences(config, resolve) {
  if (isArray(config['proxy-groups'])) {
    for (var i = 0; i < config['proxy-groups'].length; i++) {
      var group = config['proxy-groups'][i]
      if (!isObject(group) || !isArray(group.proxies)) continue
      for (var j = 0; j < group.proxies.length; j++) {
        if (typeof group.proxies[j] !== 'string') continue
        var next = resolve(group.proxies[j])
        if (next !== null) group.proxies[j] = next
      }
    }
  }
  rewriteRuleContainers(config, resolve)
}

/* ============================== 入口 ============================== */

function main(config) {
  try {
    if (!ENABLED) return config
    if (!isObject(config)) return config

    setCollectorSize(config)

    if (!isArray(config['proxy-groups'])) {
      config['proxy-groups'] = []
    }
    var groups = config['proxy-groups']

    var oldNames = []
    var newNames = []
    var converted = 0
    var i

    // ① 就地转换已有的 url-test / load-balance
    if (MODE !== 'create') {
      for (i = 0; i < groups.length; i++) {
        var group = groups[i]
        if (!isConvertibleType(groupType(group))) continue
        group.type = 'smart'
        // 先清掉 url-test / load-balance 的专属字段，再写 smart 选项，
        // 这样 STRATEGY 参数不会被清理动作误删
        stripUrlTestOnlyKeys(group)
        applySmartOptions(group)
        converted++
        if (
          RENAME_CONVERTED_GROUPS &&
          typeof group.name === 'string' &&
          group.name !== '' &&
          group.name.indexOf(GROUP_SUFFIX) === -1
        ) {
          oldNames.push(group.name)
          newNames.push(group.name + GROUP_SUFFIX)
          group.name = group.name + GROUP_SUFFIX
        }
      }
    }

    // ② 已存在的 smart 组：刷新选项（幂等，重复执行不会叠加）
    var smartGroupExists = false
    for (i = 0; i < groups.length; i++) {
      if (groupType(groups[i]) === 'smart') {
        applySmartOptions(groups[i])
        smartGroupExists = true
        break
      }
    }

    // ③ 需要时新建 smart 组
    //    auto：没有可转换的组才建；create：没有 smart 组才建
    var created = false
    if (!smartGroupExists && (MODE === 'create' || (MODE === 'auto' && converted === 0))) {
      var proxyNames = collectProxyNames(config)
      var providerNames = USE_PROVIDERS ? collectProviderNames(config) : []
      // mihomo 要求组至少有 proxies 或 use，两者都空就不要建（否则内核直接启动失败）
      if (proxyNames.length > 0 || providerNames.length > 0) {
        var smartGroup = {
          name: NEW_GROUP_NAME,
          type: 'smart',
          'policy-priority': POLICY_PRIORITY,
          uselightgbm: USE_LIGHTGBM,
          collectdata: COLLECT_DATA
        }
        if (STRATEGY) smartGroup.strategy = STRATEGY
        if (proxyNames.length > 0) smartGroup.proxies = proxyNames
        if (providerNames.length > 0) smartGroup.use = providerNames
        groups.unshift(smartGroup)
        created = true
      }
    }

    // ④ 组名后缀引起的引用改写
    if (oldNames.length > 0) {
      rewriteGroupReferences(config, makeRenameResolver(oldNames, newNames))
    }

    // ⑤ 只有「本次确实新建了组」才改写规则目标，
    //    避免每次重载都重新洗一遍订阅原有的分流结构
    if (created && REPOINT_RULES) {
      rewriteRuleContainers(config, makeRepointResolver())
    }

    return config
  } catch (error) {
    // 出错就原样返回：宁可 Smart 不生效，也不能写坏配置让内核起不来
    return config
  }
}

function makeRenameResolver(oldNames, newNames) {
  return function (name) {
    var index = oldNames.indexOf(name)
    return index === -1 ? null : newNames[index]
  }
}

// 把非内置、非参数的规则目标统一指向新建的 smart 组
function makeRepointResolver() {
  return function (name) {
    if (contains(BUILTIN_TARGETS, name)) return null
    if (contains(RULE_PARAMS, name)) return null
    return NEW_GROUP_NAME
  }
}

`

function buildParamsBlock(options: Required<SmartOverrideOptions>): string {
  return [
    `var ENABLED = ${JSON.stringify(options.enabled)}`,
    `var MODE = ${JSON.stringify(options.mode)}`,
    `var USE_LIGHTGBM = ${JSON.stringify(options.useLightGBM)}`,
    `var COLLECT_DATA = ${JSON.stringify(options.collectData)}`,
    `var POLICY_PRIORITY = ${JSON.stringify(options.policyPriority)}`,
    `var OVERWRITE_POLICY_PRIORITY = ${JSON.stringify(options.overwritePolicyPriority)}`,
    `var STRATEGY = ${JSON.stringify(options.strategy)}`,
    `var COLLECTOR_SIZE = ${JSON.stringify(options.collectorSize)}`,
    `var NEW_GROUP_NAME = ${JSON.stringify(options.newGroupName)}`,
    `var USE_PROVIDERS = ${JSON.stringify(options.useProviders)}`,
    `var REPOINT_RULES = ${JSON.stringify(options.repointRules)}`,
    `var RENAME_CONVERTED_GROUPS = ${JSON.stringify(options.renameConvertedGroups)}`,
    `var GROUP_SUFFIX = ${JSON.stringify(options.groupSuffix)}`,
  ].join('\n')
}

/** 生成最终覆写脚本（默认参数下与 flyclash-smart-override.js 的参数等价） */
export function generateSmartOverrideScript(options: SmartOverrideOptions = {}): string {
  const merged: Required<SmartOverrideOptions> = { ...DEFAULT_SMART_OVERRIDE_OPTIONS, ...options }
  const start = SCRIPT_TEMPLATE.indexOf(PARAMS_BEGIN)
  const end = SCRIPT_TEMPLATE.indexOf(PARAMS_END)
  if (start === -1 || end === -1) {
    throw new Error('覆写模板缺少参数块标记，无法注入参数')
  }
  const head = SCRIPT_TEMPLATE.slice(0, start + PARAMS_BEGIN.length)
  const tail = SCRIPT_TEMPLATE.slice(end)
  return `${head}\n${buildParamsBlock(merged)}\n${tail}`
}

function getApi(): FlyClashOverrideApi {
  const api =
    typeof window !== 'undefined'
      ? (window as unknown as { electronAPI?: FlyClashOverrideApi }).electronAPI
      : undefined
  if (!api) {
    throw new Error('覆写 API 不可用：当前不在 FlyClash 前端环境')
  }
  return api
}

async function ensureOk(result: unknown, message: string): Promise<void> {
  if (result && typeof result === 'object' && (result as ActionResult).success === false) {
    throw new Error(`${message}: ${(result as ActionResult).error ?? '未知错误'}`)
  }
}

/** 覆写是否已存在 */
export async function isSmartOverrideInstalled(): Promise<boolean> {
  try {
    const items = await getApi().getOverrides()
    return items.some((item) => item.id === SMART_OVERRIDE_ID)
  } catch (error) {
    console.error('检查 Smart 覆写状态失败:', error)
    return false
  }
}

/**
 * 创建或更新 Smart 覆写。
 * 已存在时：内容有变化才写盘（避免刷新时间戳触发无意义的重载），并校正 enabled / global / ext。
 */
export async function createSmartOverride(options: SmartOverrideOptions = {}): Promise<void> {
  const api = getApi()
  const script = generateSmartOverrideScript(options)
  const items = await api.getOverrides()
  const existing = items.find((item) => item.id === SMART_OVERRIDE_ID)

  if (existing) {
    const current = await api.getOverrideFileContent(SMART_OVERRIDE_ID)
    if (current !== script) {
      await ensureOk(
        await api.updateOverrideFileContent(SMART_OVERRIDE_ID, script),
        '更新 Smart 覆写内容失败',
      )
    }
    if (existing.enabled !== true || existing.global !== true || existing.ext !== 'js') {
      // global: true 的项在 Rust 侧是互斥的：启用它会自动关掉其他已启用的全局覆写
      await ensureOk(
        await api.updateOverride(SMART_OVERRIDE_ID, { enabled: true, global: true, ext: 'js' }),
        '启用 Smart 覆写失败',
      )
    }
    return
  }

  await ensureOk(
    await api.addOverride({
      id: SMART_OVERRIDE_ID,
      name: SMART_OVERRIDE_NAME,
      type: 'local',
      ext: 'js',
      global: true,
      enabled: true,
      file: script,
    }),
    '创建 Smart 覆写失败',
  )
}

/** 移除 Smart 覆写 */
export async function removeSmartOverride(): Promise<void> {
  const api = getApi()
  const items = await api.getOverrides()
  if (!items.some((item) => item.id === SMART_OVERRIDE_ID)) return
  await ensureOk(await api.deleteOverride(SMART_OVERRIDE_ID), '删除 Smart 覆写失败')
}

/**
 * 按当前内核决定装 / 卸：
 *   内核是 mihomo-smart → 安装并启用；
 *   其他内核（含普通 mihomo）→ 移除。
 * 普通 mihomo 内核不认识 type: smart，留着会让内核启动失败，所以必须跟着内核走。
 */
export async function manageSmartOverride(options: SmartOverrideOptions = {}): Promise<void> {
  const api = getApi()
  const merged: Required<SmartOverrideOptions> = { ...DEFAULT_SMART_OVERRIDE_OPTIONS, ...options }
  const core = await api.coreGetCurrentConfig()
  const coreType = core && core.success !== false ? core.config?.coreType : undefined
  if (merged.enabled && coreType === 'mihomo-smart') {
    await createSmartOverride(merged)
  } else {
    await removeSmartOverride()
  }
}
