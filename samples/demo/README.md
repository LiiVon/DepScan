# samples/demo —— 故意"有病"的示例项目

15 个文件，用来演示 DepScaner 能发现什么。**它不是一个好项目，是反面教材。**

## 里面埋了什么

| 症状 | 位置 | DepScaner 会怎么显示 |
| --- | --- | --- |
| 循环包含 | `src/core/engine.h` ↔ `src/core/registry.h` | 依赖图里出现环（红色节点） |
| 分层违规 | `src/core/registry.h` 反向 `#include "ui/panel.h"` | 架构边界检查会自动报出目录循环（`src/core ↔ src/ui`），见 docs/08 |
| 深层依赖链 | `main.cpp → app/application.cpp → core/engine.cpp → util/*` | 从 main 出发的阅读路径 |
| 构建目标 | `CMakeLists.txt` | `links` 边（demo_app → demo_core / demo_ui） |

循环包含是**故意保留**的，但它是**合法 C++**：两边都用前置声明 + 指针，
所以「engine.h 先被包含」和「registry.h 先被包含」两种顺序都能编译通过。
（早先的版本用了一个按值的 `Registry registry_;` 成员，那种写法在某种包含顺序下
会报 `C3646: 未知重写说明符` —— 那才是真正要避免的写法。）

## 编译

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

## 生成 compile_commands.json（想让 DepScaner 显示"部分精确"就要做）

⚠ **CMake 的 Visual Studio 生成器永远不产出 `compile_commands.json`**
（`CMAKE_EXPORT_COMPILE_COMMANDS` 只对 Makefile / Ninja 生成器生效）。
本项目 `CMakeLists.txt` 里已经写了 `set(CMAKE_EXPORT_COMPILE_COMMANDS ON)`，
但只要你用的是 Visual Studio 生成器，`build/` 里就不会有它。

用 Ninja 生成器：

```bat
:: Windows + MSVC：先进入 VS 环境
"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
cmake -S . -B build-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build-ninja
```

```bash
# Linux / macOS
cmake -S . -B build-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build-ninja
```

之后回到 VS Code 点侧边栏「重建索引」，精度会从 **近似** 变成 **部分精确**
（include 边全部精确：`exactIncludeEdges = 25 / approxIncludeEdges = 0`）。

> `build-ninja/` 已在 `.gitignore` 里，不会污染仓库。
