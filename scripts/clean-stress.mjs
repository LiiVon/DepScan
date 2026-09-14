// 清理压力测试生成的合成工程（可随时用 npm run stress:gen / stress:gen:1m 重新生成）
import { existsSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['stress', 'stress1m', 'engine/build/probe', 'engine/build/stress.json', 'engine/build/demo-graph.json', 'engine/build/demo-err.txt']) {
  const p = resolve(root, rel);
  if (!existsSync(p)) continue;
  rmSync(p, { recursive: true, force: true });
  console.log(`[clean-stress] 已删除 ${rel}`);
}
