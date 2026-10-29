# axios-dedupe-adapter

> Axios 适配器：并发请求合并（in-flight dedupe）+ 可选 TTL 结果缓存。零运行时依赖。

## 特性

- **零运行时依赖** — 仅依赖 axios（peer），npm 装下来 0KB 额外体积
- **三种行为模式**：
  - 默认（`isMerge` 未设置）：完全透明，和原生 axios 行为一致
  - 仅合并（`isMerge: true, cacheTime: 0`）：并发同请求共享一个 Promise，完成立即释放
  - 合并 + 缓存（`isMerge: true, cacheTime: N`）：请求完成后结果保留 N 秒
- **边界安全**：
  - AbortController 的 `signal` 请求**不会被合并**（取消语义不会错乱）
  - `FormData` / `Blob` / `ArrayBuffer` / 循环引用对象**不会被错误合并**
  - JSON 字符串与对象在拦截器阶段 / adapter 阶段算出的 key 保持一致

## 安装

```bash
npm install axios-dedupe-adapter
# 或
pnpm add axios-dedupe-adapter
# 或
yarn add axios-dedupe-adapter
```

## 使用

```js
import axios from 'axios'
import { createDedupeAdapter } from 'axios-dedupe-adapter'

const instance = axios.create({ baseURL: '/api' })

// 挂载适配器
instance.defaults.adapter = createDedupeAdapter(instance)

// ============ 每个请求单独控制行为 ============

// 普通请求（默认不合并，零副作用）
instance.get('/users')

// 并发同请求合并：只发一次 HTTP，两个调用方共享同一个 Promise
instance.get('/shared', { isMerge: true })
instance.get('/shared', { isMerge: true }) // ← 不发新请求

// 合并 + 缓存 10 秒：10 秒内后续请求直接返回缓存结果
instance.get('/config', { isMerge: true, cacheTime: 10 })
```

### 运行时清除缓存

```js
import { clearCache } from 'axios-dedupe-adapter'

// 所有进行中请求和结果缓存（含定时器）全部释放
clearCache()
// 场景：用户登出、主题切换、退出某租户
```

### 挂到实例上方便调用

```js
import { createDedupeAdapter, clearCache, generateRequestKey } from 'axios-dedupe-adapter'

instance.defaults.adapter = createDedupeAdapter(instance)
instance.clearCache = clearCache
instance.generateRequestKey = generateRequestKey
```

## 设计说明

### 并发合并 vs 结果缓存

两者独立但可组合：

| `isMerge` | `cacheTime` | 行为 |
|---|---|---|
| 未设置 / `false` | 忽略 | 每次发新请求（默认，零副作用） |
| `true` | `0` | 只合并 in-flight 请求，完成立即释放 |
| `true` | `> 0` | 合并 + 请求完成后缓存 N 秒 |

### 为什么 signal 请求不合并

```js
const ctrl = new AbortController()
instance.get('/resource', { signal: ctrl.signal, isMerge: true })
```

如果这个请求被合并，它会共享**第一个**请求的 Promise 和 signal。当你 `ctrl.abort()` 时，实际上会把**所有在途的共享请求**一起取消 —— 这违反了使用者对 AbortController 的直觉（一个 controller 只控制自己的请求）。因此实现里显式跳过带 `signal` 的请求。

### 为什么 FormData 不自动合并

`JSON.stringify(new FormData()) === '{}'`，这意味着两个不同内容的表单（比如上传文件 A 和文件 B）会算出同一个 key。实现里手动把 FormData 展开成 `name=value&name=value` 的形式，遇到非 string 值（File / Blob）直接降级为唯一 key，保证安全。

### 拦截器 / adapter 两阶段 key 对齐

axios 请求生命周期中，`config.data` 可能在拦截器阶段是对象、在 adapter 阶段被 `transformRequest` 序列化成 JSON 字符串。如果 key 只 `JSON.stringify(value)`，这两个阶段会算出不同 key，导致缓存永远命不中。`normalizePart()` 对字符串形式的 JSON 做了 `parse → stringify` 归一化，保证两个阶段结果一致。

## API

### `generateRequestKey(config)` → `string`

从 axios config 生成唯一 key。同 `(url, method, params, data)` 的请求得到相同 key。可用于自定义逻辑（比如自己写 abort controller 的缓存 key）。

### `createDedupeAdapter(axios)` → `Function`

创建适配器函数，赋值给 `axios.defaults.adapter`。

### `clearCache()` → `void`

清空全部缓存条目（含 in-flight + 结果缓存 + 定时器）。**不会取消正在进行中的底层 HTTP 请求**，只是释放本地 Map。

## 注意事项

- `isMerge` 默认关闭，不影响现有请求行为
- `signal` 请求不会被合并
- `FormData` 含非 string 值、二进制、循环引用对象会退化为唯一 key（不会被错误合并，但**也不会享受到合并/缓存的好处**）
- `clearCache()` 不取消正在进行的 HTTP 请求，只清空本地缓存

## License

MIT
