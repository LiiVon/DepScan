// 发布 vsix 到 VS Code Marketplace / Open VSX。
//
// 为什么不直接 `npx @vscode/vsce publish`：
//   vsce publish 只会执行 vscode:prepublish（= build:prod），**不会**跑 scripts/package.mjs，
//   于是 engines/<platform>-<arch>/ 里的引擎二进制不会被刷新，
//   发出去的包可能带着旧引擎（或干脆没引擎）。所以这里强制「先打包、再发布」。
//
// 用法：
//   node scripts/publish.mjs                          # 发布已打好的通用包
//   node scripts/publish.mjs --target win32-x64       # 发布平台专用包
//   node scripts/publish.mjs --dry-run                # 只做检查，不真的上传
//   node scripts/publish.mjs --openvsx                # 发 Open VSX（需要 OVSX_PAT）
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const target = value('--target');
const dryRun = has('--dry-run');
const useOpenVsx = has('--openvsx');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const { name, version, publisher, displayName, engines } = pkg;

/**
 * 找出这次要发布的 vsix 文件名。
 *
 * vsce 的实际命名约定（2.x/3.x 实测）：
 *   - 通用包：      <name>-<version>.vsix
 *   - 平台专用包：  <name>-<target>-<version>.vsix
 *   - 多目标：      <name>-<t1>-<t2>-<version>.vsix
 * 旧版 vsce 用过 <name>-<version>@<target>.vsix，一并兼容。
 */
function resolveVsixName() {
  const candidates = target
    ? [`${name}-${target}-${version}.vsix`, `${name}-${version}@${target}.vsix`]
    : [`${name}-${version}.vsix`];
  for (const c of candidates) {
    if (existsSync(resolve(root, c))) return c;
  }
  return candidates[0];
}

const vsixName = resolveVsixName();
const vsixPath = resolve(root, vsixName);

const problems = [];
const notes = [];

console.log(`[publish] ${displayName ?? name} v${version}  publisher=${publisher}`);
if (target) console.log(`[publish] 目标平台: ${target}`);
console.log(`[publish] 待发布文件: ${vsixName}`);

// 1) 包必须已经打好
if (!existsSync(vsixPath)) {
  problems.push(
    `未找到 ${vsixName}。请先执行 ${target ? `npm run package:${target}` : 'npm run package'}。\n` +
      '      （直接跑 vsce publish 会跳过 scripts/package.mjs，引擎二进制不会被刷新，所以这一步不能省）'
  );
} else {
  // 打印体积与生成时间：手边可能有多个 vsix（通用包 / 平台包），
  // 靠 mtime 才能确认自己发出去的不是上一次的旧产物。
  const st = statSync(vsixPath);
  const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
  console.log(
    `[publish] 体积 ${(st.size / 1024).toFixed(1)} KB，生成于 ${new Date(st.mtimeMs).toLocaleString()}（${ageMin} 分钟前）`
  );
  const others = readdirSync(root)
    .filter((f) => f.endsWith('.vsix') && f !== vsixName)
    .map((f) => ({ f, m: statSync(resolve(root, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (others.length > 0) {
    console.log('[publish] 目录里还有其它 vsix（不会被发布，注意别手动传错）：');
    for (const o of others) console.log(`  · ${o.f}  ${new Date(o.m).toLocaleString()}`);
  }
}

// 2) publisher 应与仓库归属对得上（对不上不是致命错误，但通常是填错了）
const repoOwner = /github\.com[/:]([^/]+)\//.exec(pkg.repository?.url ?? '')?.[1];
if (repoOwner && repoOwner.toLowerCase() !== String(publisher).toLowerCase()) {
  notes.push(
    `publisher="${publisher}" 与仓库归属 "${repoOwner}" 不一致。\n` +
      `      并不违法，但请确认 Marketplace 上创建的 Publisher ID 就是 "${publisher}"（大小写敏感）。`
  );
}

// 3) 引擎二进制必须覆盖要发布的平台
const enginesDir = resolve(root, 'engines');
const bundled = existsSync(enginesDir)
  ? readdirSync(enginesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  : [];
if (bundled.length === 0) {
  problems.push('engines/ 里没有任何平台引擎，用户装上会直接报「引擎缺失」。先跑 npm run build:core。');
} else {
  console.log(`[publish] 已内置引擎平台: ${bundled.join(', ')}`);
  if (target && !bundled.includes(target)) {
    problems.push(`目标平台 ${target} 没有对应的 engines/${target}/ 目录。`);
  }
  if (!target && bundled.length === 1) {
    notes.push(
      `这个 vsix 只含 ${bundled[0]} 引擎，却会被分发给**所有平台**的搜索者。\n` +
        '      更稳妥的做法：npm run publish:win32-x64（平台专用包，Marketplace 只发给对应平台）。'
    );
  }
}

// 4) VS Code 最低版本
if (!engines?.vscode) notes.push('package.json 缺少 engines.vscode，Marketplace 会警告。');

for (const n of notes) console.log(`[publish] 提示: ${n}`);
if (problems.length > 0) {
  console.error('\n[publish] 检查未通过：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

if (dryRun) {
  console.log('\n[publish] --dry-run：检查全部通过，未执行上传。');
  if (useOpenVsx) console.log('[publish] 真发 Open VSX：设置 OVSX_PAT 后执行 npm run publish:openvsx');
  else console.log('[publish] 真发 Marketplace：去掉 --dry-run 即可（首次会要求 vsce login）');
  process.exit(0);
}

const flags = ['publish', '--packagePath', vsixPath];
// 不传 --target：官方文档的做法是 `vsce package --target X` 之后
// `vsce publish --packagePath <那个 vsix>`，平台信息在 vsixmanifest 里，
// 再传一次 --target 反而可能冲突。

const command = useOpenVsx ? 'ovsx' : '@vscode/vsce';
const args = useOpenVsx ? ['publish', vsixPath] : flags;

console.log(`\n[publish] 执行: npx --yes ${command} ${args.join(' ')}\n`);
if (useOpenVsx && !process.env.OVSX_PAT) {
  console.error('[publish] 未设置 OVSX_PAT。请先到 https://open-vsx.org 生成访问令牌，');
  console.error('          然后 set OVSX_PAT=xxx（PowerShell: $env:OVSX_PAT="xxx"）再执行。');
  process.exit(1);
}

const result =
  process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `npx --yes ${command} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`],
        { cwd: root, stdio: 'inherit' }
      )
    : spawnSync('npx', ['--yes', command, ...args], { cwd: root, stdio: 'inherit' });

if (result.error) {
  console.error(`[publish] 调用失败: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('\n[publish] 上传失败。按错误信息对照 docs/06-发布与版本管理.md 的「常见报错」排查：');
  console.error('  · 401 / 403  → PAT 过期，或 Organization 没选 "All accessible organizations"');
  console.error('  · 409 / already exists → 版本号重复，先 npm version patch');
  console.error('  · publisher mismatch → package.json 的 publisher 与 Marketplace 上的 ID 不一致');
  process.exit(result.status ?? 1);
}

console.log(`\n[publish] 完成。`);
if (!useOpenVsx) {
  console.log(`[publish] 管理页: https://marketplace.visualstudio.com/manage/publishers/${publisher}`);
}
