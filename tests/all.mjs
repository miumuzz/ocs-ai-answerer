/**
 * 一把跑完所有测试。
 * 不用 `node --test`：它默认一个文件一个子进程，在受限环境里会 spawn EPERM。
 * 这里在同一进程里依次 import，node:test 会自动收集并执行。
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

for (const file of files) {
  await import(pathToFileURL(join(here, file)).href);
}
