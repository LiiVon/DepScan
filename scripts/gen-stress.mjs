// 生成压力测试用的合成 C++ 工程（用于验证百万行级扫描性能，不参与打包）
// 用法: node scripts/gen-stress.mjs <输出目录> [文件数] [每文件行数] [方法内填充行数]
//   填充行数用于在不膨胀符号表的前提下把 LOC 拉到百万级（只增加语句，不增加新符号）
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';

const outDir = resolve(process.argv[2] ?? 'stress-project');
const fileCount = Number(process.argv[3] ?? 2000);
const linesPerFile = Number(process.argv[4] ?? 100);
const fillerPerMethod = Number(process.argv[5] ?? 0);
const MODULES = 40;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, 'CMakeLists.txt'),
  ['cmake_minimum_required(VERSION 3.16)', 'project(stress CXX)', 'add_library(stress STATIC gen/common.cpp)'].join('\n')
);

// 公共头文件：被几乎所有文件包含
mkdirSync(join(outDir, 'gen'), { recursive: true });
writeFileSync(
  join(outDir, 'gen/common.h'),
  ['#pragma once', '#define STRESS_MAX 1024', 'namespace stress { int commonInit(int x); }'].join('\n')
);
writeFileSync(
  join(outDir, 'gen/common.cpp'),
  ['#include "gen/common.h"', 'namespace stress { int commonInit(int x) { return x + STRESS_MAX; } }'].join('\n')
);

let totalLines = 6;
const methodsPerFile = Math.max(2, Math.floor(linesPerFile / 12));

for (let i = 0; i < fileCount; i++) {
  const mod = i % MODULES;
  const dir = join(outDir, 'gen', `mod${String(mod).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });

  const name = `unit${String(i).padStart(6, '0')}`;
  const nextA = (i + 1) % fileCount;
  const nextB = (i + 7) % fileCount;
  const modA = nextA % MODULES;
  const modB = nextB % MODULES;

  const header = [
    '#pragma once',
    '#include "gen/common.h"',
    '#include <string>',
    `#include "gen/mod${String(modA).padStart(3, '0')}/unit${String(nextA).padStart(6, '0')}.h"`,
    `#include "gen/mod${String(modB).padStart(3, '0')}/unit${String(nextB).padStart(6, '0')}.h"`,
    'namespace stress {',
    `class Widget${i} : public Base${i % 50} {`,
    ' public:',
    `  Widget${i}();`,
    ...Array.from({ length: methodsPerFile }, (_, k) => `  int action${k}(int value) const;`),
    ' private:',
    '  int state_;',
    '  std::string name_;',
    '};',
    '}  // namespace stress'
  ];
  const impl = [
    `#include "gen/mod${String(mod).padStart(3, '0')}/${name}.h"`,
    'namespace stress {',
    `Widget${i}::Widget${i}() : state_(0), name_("w${i}") {}`,
    ...Array.from({ length: methodsPerFile }, (_, k) => {
      const body = [
        `int Widget${i}::action${k}(int value) const {`,
        '  int acc = value;',
        ...Array.from({ length: fillerPerMethod }, (_, f) => `  acc += ${(f * 7 + k + i) % 97};`),
        `  return commonInit(acc + ${k}) + state_;`,
        '}'
      ];
      return body.join('\n');
    }),
    '}  // namespace stress'
  ];

  writeFileSync(join(dir, `${name}.h`), `${header.join('\n')}\n`);
  writeFileSync(join(dir, `${name}.cpp`), `${impl.join('\n')}\n`);
  totalLines += header.length + impl.join('\n').split('\n').length;

  if (totalLines % 3000 < header.length + impl.length) {
    writeFileSync(
      join(dir, `bases${i}.h`),
      ['#pragma once', `namespace stress { class Base${i % 50} { public: virtual ~Base${i % 50}() = default; }; }`].join('\n')
    );
  }
}

console.log(`[gen-stress] ${outDir}`);
console.log(`[gen-stress] 文件数 ≈ ${fileCount * 2}，总行数 ≈ ${totalLines}`);
