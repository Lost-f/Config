// ============================================================
// Smart 内核(mihomo-smart)覆写脚本 —— 适配 flyclash
// 提取自 Mihomo Party 的 Smart-Core-Override 模板并修复:
//   1. 去掉无法在覆写环境运行的 import/export 及 TS 语法
//   2. overrideLogger.* 改为 console.log / console.warn
//   3. 修复 expected-status 字段判断的键名错误
// 用法:flyclash → 覆写 → 新建 JavaScript 覆写 → 导入本文件 → 对订阅启用
// 注意:生成的 type: smart 策略组只有 Smart 内核(mihomo-smart)认识,
//       普通 mihomo 内核会报 unsupported proxy group type 导致启动失败!
// ============================================================

// ===== Smart 内核参数(按需修改)=====
const USE_LIGHTGBM = false            // 是否启用 LightGBM 智能选点
const COLLECT_DATA = false            // 是否采集数据
const STRATEGY = 'sticky-sessions'    // 'sticky-sessions' 或 'round-robin'
const COLLECTOR_SIZE = 100            // 采集样本数

const SMART_NAME = '🚀 Proxies'
const CONVERTIBLE_TYPES = ['select', 'url-test', 'fallback', 'load-balance']

function makeSmartGroup(proxies) {
  return {
    name: SMART_NAME,
    type: 'smart',
    strategy: STRATEGY,
    uselightgbm: USE_LIGHTGBM,
    collectdata: COLLECT_DATA,
    'policy-priority': '',
    proxies: proxies
  }
}

function main(config) {
  if (!config) return config
  if (!config['proxy-groups']) config['proxy-groups'] = []
  if (!config.rules) config.rules = []

  const groups = config['proxy-groups']
  if (!groups.length) {
    console.warn('[Smart Override] 配置中没有策略组,跳过覆写')
    return config
  }

  if (!groups.some(g => g.name === SMART_NAME)) {
    if (groups.some(g => g.type === 'url-test')) {
      // 已有自动测速组:把 select/url-test/fallback/load-balance 原地转成 smart
      for (const group of groups) {
        if (CONVERTIBLE_TYPES.indexOf(group.type) !== -1) {
          group.type = 'smart'
          group.strategy = STRATEGY
          group.uselightgbm = USE_LIGHTGBM
          group.collectdata = COLLECT_DATA
          group['policy-priority'] = ''
          delete group.url
          delete group.interval
          delete group.tolerance
          delete group.lazy
          if (group['expected-status']) delete group['expected-status']
        }
      }
      groups.unshift(makeSmartGroup(groups.map(g => g.name)))
    } else {
      // 没有自动测速组:新建 smart 组,聚合所有未被组引用的底层节点
      const seen = new Set(groups.map(g => g.name))
      seen.add(SMART_NAME)
      const proxies = []
      for (const g of groups) {
        for (const p of g.proxies || []) {
          if (!seen.has(p)) {
            seen.add(p)
            proxies.push(p)
          }
        }
      }
      groups.unshift(makeSmartGroup(proxies.length ? proxies : ['DIRECT']))
    }
  } else {
    // 订阅里本来就有同名组:直接转成 smart
    const g = groups.find(x => x.name === SMART_NAME)
    g.type = 'smart'
    g.strategy = STRATEGY
    g.uselightgbm = USE_LIGHTGBM
    g.collectdata = COLLECT_DATA
    g['policy-priority'] = ''
    delete g.url
    delete g.interval
    delete g.tolerance
    delete g.lazy
    if (g['expected-status']) delete g['expected-status']
  }

  // 未命中规则的流量走 smart 组(仅在没有 MATCH 规则时追加)
  if (!config.rules.some(r => typeof r === 'string' && r.split(',')[0] === 'MATCH')) {
    config.rules.push('MATCH,' + SMART_NAME)
  }

  // Smart 内核全局参数
  if (!config.profile) config.profile = {}
  config.profile['smart-collector-size'] = COLLECTOR_SIZE
  config.profile['smart-collect-data'] = COLLECT_DATA

  console.log('[Smart Override] 覆写完成')
  return config
}
