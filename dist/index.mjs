/**
 * axios-dedupe-adapter
 *
 * Axios 适配器：并发请求合并（in-flight dedupe）+ 可选 TTL 结果缓存。
 * 零运行时依赖。
 *
 * 使用方式：
 *   import { createDedupeAdapter } from 'axios-dedupe-adapter'
 *   instance.defaults.adapter = createDedupeAdapter(instance)
 *
 *   // 单个请求开启合并（默认关闭）
 *   instance.get('/api/list', { isMerge: true })
 *   // 合并 + 缓存 10 秒
 *   instance.get('/api/user/1', { isMerge: true, cacheTime: 10 })
 */

// 请求缓存容器：{ [key]: { promise, result, expireTime, isPending, timer } }
const pendingRequests = new Map()

// 无法可靠比对的负载（二进制、含非 string 值的 FormData、循环引用对象）
// 必须每次得到不同 key，否则 isMerge 会把 A 请求的结果错误复用给 B 请求。
let unmergeableSeq = 0
const unmergeableKey = () => `__unmergeable_${(unmergeableSeq += 1)}`

// File 继承自 Blob
const isBinary = value =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob

/**
 * 把 params / data 归一化成字符串片段。
 *
 * 关键约束：同一个请求在 axios 请求拦截器阶段（data 还是对象）与 adapter 阶段
 * （transformRequest 之后 data 已被序列化成字符串）必须算出同一个值，
 * 否则缓存键会在两个阶段之间漂移。
 *
 * @param {any} value config.params / config.data
 * @returns {string} 归一化后的片段，无法比对时返回唯一串
 */
function normalizePart(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        return JSON.stringify(JSON.parse(trimmed))
      } catch (_error) {
        return value
      }
    }
    return value
  }
  if (typeof value !== 'object') return String(value)
  if (isBinary(value)) return unmergeableKey()
  if (value instanceof FormData) {
    // JSON.stringify(FormData) 恒为 '{}'，会让同 URL 的不同表单共用一个键
    let failed = false
    const pairs = []
    value.forEach((item, name) => {
      if (typeof item !== 'string') {
        failed = true
        return
      }
      pairs.push(`${name}=${item}`)
    })
    if (failed) return unmergeableKey()
    return `form:${pairs.sort().join('&')}`
  }
  if (value instanceof URLSearchParams) return value.toString()
  try {
    return JSON.stringify(value)
  } catch (_error) {
    // 循环引用等无法序列化的对象
    return unmergeableKey()
  }
}

/**
 * 生成请求唯一标识。
 * 同 { url, method, params, data } 的请求得到相同 key，否则不同。
 *
 * @param {Object} config axios config 对象
 * @returns {string} 请求唯一标识
 */
export function generateRequestKey(config) {
  const url = config.url || ''
  const method = (config.method || 'get').toLowerCase()
  const params = normalizePart(config.params)
  const data = normalizePart(config.data)
  return [url, method, params, data].join('&')
}

/**
 * 清除全部缓存（进行中请求 + 定时器 + 结果缓存）。
 * 适用于用户登出、主题切换等场景。
 */
export function clearCache() {
  pendingRequests.forEach(cache => {
    if (cache.timer) clearTimeout(cache.timer)
  })
  pendingRequests.clear()
}

/**
 * 创建请求合并去重适配器。
 * 返回的函数可直接赋值给 axios 实例的 defaults.adapter。
 *
 * 行为由每个请求的 config 字段控制：
 *   - isMerge: boolean — 开启合并/缓存（默认 false）
 *   - cacheTime: number — 结果缓存秒数（默认 0，仅合并不缓存）
 *
 * 以下请求不会被合并：
 *   - isMerge !== true
 *   - config.signal 已存在（AbortController 场景：合并后取消语义会错乱）
 *
 * @param {import('axios').Axios} axios axios 实例（用于取 defaults.adapter）
 * @returns {Function} 可作为 axios adapter 的函数
 */
export function createDedupeAdapter(axios) {
  const customAdapter = async config => {
    const key = generateRequestKey(config)

    const isMerge = config.isMerge === true
    const cacheTime = (config.cacheTime || 0) * 1000

    // 未开启 isMerge 或携带独立 signal（如 isAbort 请求）的请求不参与合并。
    if (!isMerge || config.signal) {
      const defaultAdapter = axios.defaults.adapter
      return defaultAdapter(config)
    }

    // isMerge=true：启用缓存功能
    if (pendingRequests.has(key)) {
      const cache = pendingRequests.get(key)

      // 进行中：共享同一个 promise
      if (cache.isPending) return cache.promise

      // 已完成
      if (cacheTime > 0) {
        // 启用了结果缓存，检查是否过期
        const now = Date.now()
        if (now < cache.expireTime) return Promise.resolve(cache.result)
        // 已过期
        if (cache.timer) clearTimeout(cache.timer)
        pendingRequests.delete(key)
      } else {
        // cacheTime=0：仅合并模式，请求完成立即清除
        pendingRequests.delete(key)
      }
    }

    // 缓存不存在或已过期，发起新请求
    const defaultAdapter = axios.defaults.adapter
    const promise = defaultAdapter(config)

    pendingRequests.set(key, {
      promise,
      result: null,
      expireTime: 0,
      isPending: true,
      timer: null
    })

    promise
      .then(response => {
        const cache = pendingRequests.get(key)
        if (!cache) return

        if (cacheTime > 0) {
          cache.result = response
          cache.expireTime = Date.now() + cacheTime
          cache.isPending = false
          cache.timer = setTimeout(() => pendingRequests.delete(key), cacheTime)
        } else {
          pendingRequests.delete(key)
        }
      })
      .catch(() => {
        const cache = pendingRequests.get(key)
        if (cache && cache.timer) clearTimeout(cache.timer)
        pendingRequests.delete(key)
      })

    return promise
  }

  return customAdapter
}
