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
