# DepScan

> 面向大型 C/C++ 项目的依赖关系分析与可视化 VS Code 插件。
> 五类依赖一次扫清：**include / 调用 / 继承 / 类型 / 符号引用 / 链接**，并在 Webview 里用「图 · 树 · 表格」三视图联动浏览。

---

## 它解决什么问题

大型 C++ 项目的真正入口不是 `main()`，而是**一张依赖网**。想读懂一个新项目，你需要回答：

- 这个文件被谁 include？它又拉进来哪些头文件？（**模块边界**）
- 改这个函数会影响哪些调用方？（**变更影响面**）
- 这个类的继承层次长什么样？（**架构骨架**）
- 这个宏 / 全局变量在哪里被用到？（**交叉引用**）
- 哪个 target 链接了哪个库？（**构建与链接关系**）

DepScan 把这些问题变成一次点击。

---

## 三步开始

1. **安装**：安装 vsix（插件已内置各平台分析引擎，开发机无需安装编译器 / Clang）
2. **打开**：用 VS Code 打开一个 C/C++ 项目 → 插件自动在后台建立索引（状态栏可看进度）
3. **看图**：在任意 `.cpp/.h` 上右键 → **查看依赖图**（或 `Ctrl+Shift+P` → `DepScan: 查看依赖图`）

想要**精确**结果？在项目里生成 `compile_commands.json`：

```bash
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

没有它也能用 —— 插件会自动降级为内置结构解析，并在界面上**明确标注精度等级**（近似 / 精确），不会让你误判结果。

> 详细步骤见 [docs/01-快速开始.md](docs/01-快速开始.md)

---

## 五类依赖

| 依赖类型 | 边 | 语义 | 精度 |
| --- | --- | --- | --- |
| 文件 / 头文件包含 | `includes` | `#include` 关系，区分本地 / 系统引用，支持宏展开后的真实包含 | 精确\* / 近似 |
| 函数调用图 | `calls` | 谁调用谁，含成员函数、命名空间限定名 | 近似 |
| 类继承 / 类型依赖 | `inherits` / `uses` | 单/多/虚继承；成员与模板参数的类型依赖 | 近似 |
| 符号交叉引用 | `refs` | 宏、全局变量的定义与使用位置 | 近似 |
| 链接 / 构建依赖 | `links` | CMake target ↔ 源文件 ↔ 被链接的库 | 精确 |

\* 提供 `compile_commands.json` 时，include 搜索路径来自真实编译参数，解析结果标记为**精确**。

---

## 界面

- **侧边栏「操作」**：常用功能一次点击 —— 看图 / 重建索引 / 导出 / **切换界面语言** / 打开文档（不用再翻命令面板）
- **依赖图**：Canvas 力导向图。拖动节点、滚轮缩放、拖拽平移；单击节点跳转源码、双击展开下一层。
- **层级树**：以当前焦点为根，按依赖方向逐层展开。
- **表格**：节点 / 类型 / 出依赖 / 入依赖 / 文件位置 / 精度，可按名称与路径搜索。
- 三视图**选中联动**：在任一视图点选，其余视图同步高亮与导航。
- **方向开关**：双向 / 被谁依赖 / 依赖了谁。
- **LOD 三层下钻**：目录（全局架构）→ 文件 → 函数；超大图自动聚类，避免卡顿。
- **导出**：PNG / SVG（矢量）/ JSON / DOT / Mermaid。

> 操作细节见 [docs/02-界面与操作指南.md](docs/02-界面与操作指南.md)

---

## 架构

```
VS Code 插件层（TypeScript / Node）
  命令 · 侧边栏 · 状态栏 · 配置 · 增量调度 · 磁盘缓存
  Webview（Canvas 力导向图 / 树 / 表格 / 导出）
        ↕  stdio JSON-RPC（逐行 JSON，UTF-8）
C++ 分析引擎（独立进程，零外部依赖）
  文件发现 → 并行结构解析 → 符号表 → 图构建 → 子图裁剪
  include 解析（compile_commands）× 调用/继承/类型/符号 × CMake 链接模型
```

- **为什么是独立进程**：扩展宿主是单线程 Node 进程，把百万行级解析放在里面会卡死编辑器；独立进程天然规避阻塞，崩溃也不影响编辑器。
- **为什么用 stdio JSON-RPC**：跨平台零差异，不需要本地端口、不需要 ABI 绑定（N-API 会带来 6 平台矩阵的构建噩梦）。
- **服务端裁剪**：图不是整张推给前端，而是引擎做 k 层 BFS 后只回传子图 —— 这是大项目不卡的关键。

```
DepScan/
├── src/            TypeScript 插件（命令 / 服务 / 视图 / i18n）
├── webview/        前端源码（力导向图 / 树 / 表格 / 导出）
├── engine/         C++ 分析引擎（CMake，独立可执行文件）
├── scripts/        构建 / 打包 / 自测脚本
├── samples/demo/   示例项目（含循环依赖与分层违规，用于验收）
└── docs/           教学文档（中文）
```

---

## 构建（开发者）

前置：Node.js ≥ 18、CMake ≥ 3.16、C++20 编译器（MSVC 2019+ / GCC 10+ / Clang 12+）。

```bash
npm install
npm run build:core     # 编译 C++ 引擎 -> engine/build/bin/<Config>/depscan-core
npm run build          # 类型检查 + 打包扩展 + 打包 Webview + Webview 自检
npm test               # 引擎单测 + JSON-RPC 协议冒烟 + Webview 自检
```

调试：在 VS Code 中按 `F5`（会以 `samples/demo` 作为工作区启动扩展开发宿主）。

不开编辑器也能验证前端渲染（用真实引擎数据生成一个可直接在浏览器打开的页面）：

```bash
npm run preview:layout                              # 默认扫描 samples/demo，焦点 src/core/engine.cpp
npm run preview:layout -- samples/demo src/util/logger.h 3
# 产物：engine/build/layout-preview.html
```

打包发布：

```bash
npm run package        # 收集本机引擎到 engines/<platform>-<arch>/，再调用 vsce 打包
```

### 三平台引擎分发

vsix 内按 `engines/<platform>-<arch>/depscan-core[.exe]` 分发，插件运行时按当前平台自动选择：

```
engines/
├── win32-x64/depscan-core.exe
├── linux-x64/depscan-core
├── darwin-x64/depscan-core
└── darwin-arm64/depscan-core
```

每个平台在对应机器（或交叉编译环境）执行 `npm run build:core` 后复制到上述目录，再统一 `vsce package`。
代价说明：三平台二进制会让 vsix 体积增加约 6–12 MB；换来的是**用户侧零工具链依赖**。

用户也可用 `depscan.engine.path` 指定自编译引擎覆盖内置版本。

---

## 配置速查

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `depscan.deps.*` | true | 五类依赖各自开关 |
| `depscan.index.onStartup` | true | 打开工作区后自动后台索引 |
| `depscan.index.autoRebuildOnSave` | true | 保存后增量重建受影响子图 |
| `depscan.index.parallelism` | 0 | 解析线程数，0 = CPU 核心数 |
| `depscan.files.include` / `exclude` | C/C++ glob | 参与索引的文件范围 |
| `depscan.compile.commandsPath` | "" | 指定 compile_commands.json（留空自动发现） |
| `depscan.graph.defaultDepth` | 2 | 依赖图默认层级 k |
| `depscan.graph.direction` | both | 双向 / 被谁依赖 / 依赖了谁 |
| `depscan.graph.maxNodes` | 800 | 单图渲染上限 |
| `depscan.cache.enabled` | true | 磁盘缓存（二次启动秒开） |
| `depscan.ui.language` | auto | 插件界面语言 `auto` / `zh` / `en`（侧边栏「操作 → 界面语言」也能切） |

完整字典见 [docs/05-性能与配置参考.md](docs/05-性能与配置参考.md)

---

## 文档

1. [快速开始](docs/01-快速开始.md) —— 安装、准备 compile_commands、首次索引
2. [界面与操作指南](docs/02-界面与操作指南.md) —— 三视图联动、导出、索引与缓存
3. [如何用 DepScan 学习项目](docs/03-如何用%20DepScan%20学习项目.md) —— 四个可复制的阅读套路
4. [解析与精度说明](docs/04-解析与精度说明.md) —— 精确 vs 近似、五类依赖的边界与 FAQ
5. [性能与配置参考](docs/05-性能与配置参考.md) —— 全部配置项、百万行级调优
6. [更新日志](docs/CHANGELOG.md)

---

## 已知限制

- 无 `compile_commands.json` 时，调用图 / 继承 / 类型依赖为**结构级近似**：重载决议、模板实例化、宏展开的函数式调用无法完全还原，可能漏报或误报。
- 内置解析器按**名字**消解引用：同名符号（尤其是重载）会优先同文件、其次全部候选（>3 个候选则聚合为「未解析」节点），不保证 100% 正确。
- 链接依赖目前解析 **CMake**（`add_executable` / `add_library` / `target_link_libraries`）；Makefile / Bazel / qmake 请通过 `compile_commands.json` 提供编译信息，链接关系需等待后续版本。
- 磁盘缓存为 v0.1 的文本格式，超大项目（>10 万文件）缓存文件可能达到数十 MB。
- 只支持 C/C++（`.c/.cc/.cpp/.cxx/.h/.hpp/.hh/.hxx/.inl/.ipp`）。

## 许可证

MIT
