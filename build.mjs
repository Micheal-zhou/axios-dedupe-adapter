/**
 * 极简构建脚本：用 Node 原生 API 把 src/index.js 同时产出 ESM 和 CJS 两种格式。
 * 零依赖。CJS 版本把 export function / export const 转成 module.exports 赋值。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, 'src', 'index.js')
const outDir = path.join(__dirname, 'dist')

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

const source = fs.readFileSync(src, 'utf-8')

// ESM：直接复制
fs.writeFileSync(path.join(outDir, 'index.mjs'), source, 'utf-8')

// CJS：把 export 语句改写
const cjs = source
  .replace(/^export function /gm, 'function ')
  .replace(/^export const /gm, 'const ')
  .replace(/^export class /gm, 'class ')

// 收集所有导出的函数/常量/类名
const exportNames = []
source.replace(/^export (?:function|const|class)\s+(\w+)/gm, (_, name) => {
  exportNames.push(name)
  return _
})

const cjsFinal =
  cjs + '\n\nmodule.exports = { ' + exportNames.join(', ') + ' }\n'

fs.writeFileSync(path.join(outDir, 'index.cjs'), cjsFinal, 'utf-8')

// 同时写一份 ESM 版本的 d.ts 占位（让 TS 项目也能 import）
const dts =
  `export declare function generateRequestKey(config: Record<string, any>): string;\n` +
  `export declare function clearCache(): void;\n` +
  `export declare function createDedupeAdapter(axios: any): (config: any) => Promise<any>;\n`

fs.writeFileSync(path.join(outDir, 'index.d.ts'), dts, 'utf-8')

console.log('[build] dist/index.mjs, dist/index.cjs, dist/index.d.ts written')
