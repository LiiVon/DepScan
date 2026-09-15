# DepScaner — see the dependency graph of any C/C++ project

**One scan, five kinds of dependencies — includes, calls, inheritance, types, symbols, links — explored through a linked graph / tree / table, inside VS Code.**

<!--
  TODO(screenshot): hero image — 建议截「左侧边栏 + 依赖图 + 右侧表格」同屏，
  文件名：media/screenshots/hero.png   （窗口宽度 ≥ 1400px，深色主题）
  拿到图后把下面这行的注释去掉：
  ![DepScaner overview](media/screenshots/hero.png)
-->

---

## Why

In a large C++ codebase the entry point isn't `main()` — it's a web of dependencies. DepScaner answers these questions in one click:

- Who includes this header, and what does it pull in? *(module boundaries)*
- If I change this function, which callers break? *(blast radius)*
- What does this class hierarchy look like? *(architecture skeleton)*
- Where is this macro or global variable used? *(cross references)*
- Which build target links which library? *(build & link model)*

---

## Requirements

**None.** The analysis engine is a native executable bundled inside the extension — you do **not** need a compiler, Clang, Python or Node.js to use it.

Prebuilt engines ship for **Windows x64**, **Linux x64** and **macOS** (Intel and Apple Silicon). On any other platform, build the engine yourself and point `depscaner.engine.path` at it.

## Install

- **VS Code Marketplace** — search for `DepScaner`, or run `code --install-extension liivon.depscaner`
- **From a VSIX file** — Extensions view → `⋯` → **Install from VSIX…**

---

## Quick start

1. **Open** a folder that contains C/C++ sources. DepScaner indexes it in the background — progress shows in the status bar and in the **Index Status** sidebar view.
2. **Pick a starting point** — right-click any `.cpp` / `.h` file → **Show Dependency Graph**, or put the cursor inside a function and run `DepScaner: Show Dependency Graph for Symbol`.
3. **Read the graph** — click a node to jump to its source, double-click it to expand one more level.
4. **Or follow a route** — see **Reading route** below to get a *numbered reading order* instead of a graph.

<!--
  TODO(screenshot): 依赖图特写（含工具栏 + 图例 + 选中节点详情）
  文件名：media/screenshots/graph.png
  ![Dependency graph](media/screenshots/graph.png)
-->

---

## Reading route

> A dependency graph answers *“what is related to what”*. When you open a 200-file project you usually want a different question answered: **what do I read first, and what next?** That is what the reading route does.

Sidebar → **DepScaner → Reading Route** (or *Actions → Reading route*):

```
Start: main (auto-detected, src/main.cpp)
The route is a reading suggestion, not an exact call stack: call edges are resolved by name, so treat ⚠ steps with care.
2 trivial step(s) folded (pure forwarders / tiny functions) — click the toolbar toggle to see them all.
1 step(s) have same-named definitions — expand "Candidates" to check them.

#1 main                     src/main.cpp:6
  #2 Application::start     src/app/application.cpp:9
    #3 config                include/demo/config.h:24
    #4 Engine::run           src/core/engine.cpp:27
      #6 trim                src/util/string_utils.cpp:7
      #7 Registry::add       src/core/registry.cpp:8
      #8 Engine::describe    src/core/engine.cpp:23
        #10 join             src/util/string_utils.cpp:30
        #11 split            src/util/string_utils.cpp:15
      #9 ⚠ Base::describe    src/core/base.h:25
    #5 Panel::render         src/ui/panel.cpp:13
✓ Route is complete
```

The step numbers above are intentionally not contiguous: the **noise filter is on by default**. One-line getters and pure forwarders (`setVerbose`, `Registry::size`) do not get a step of their own — but they are never hidden silently: the view reports how many were folded, and the tooltip of the step that called them lists their names. Click `$(filter)` in the title bar to see every step.

On a big project, `$(layers)` switches to the **layer view**: layer 1 is the start, each layer shows a one-line summary (steps / files), and a layer with more than 15 steps is shown one page at a time ("N more not listed"). That turns a 300-row wall into a skeleton you can drill into — steps inside a layer still stay in reading order.

For a **library project** (no `main`), the view lists **entry candidates** instead of failing: public API first (declared under `include/`), then call-graph roots — each row states its evidence (callers / callees, where the public declaration is). DepScaner deliberately never picks a start for you: a wrong start makes the whole reading order wrong. See [docs/07](docs/07-阅读路线.md) for the ranking rules.

The route starts at `main` (`wmain` / `WinMain` / `wWinMain` / `DllMain` are tried too) and walks call edges **in source order**, so step numbers are the order you should read in.

| Control | What it does |
| --- | --- |
| Click a step | Jump to its source |
| Title bar `$(arrow-both)` | Breadth first (outline first) ↔ depth first (follow one chain) |
| Title bar `$(file-code)` | File level ↔ function level (file level keeps only the first entry per file) |
| Title bar `$(filter)` | **Noise filter**: fold / unfold pure forwarders and tiny functions (folded by default) |
| Title bar `$(layers)` | **Layer view**: summary per hop (layer 1 is the start); long layers are paged |
| Title bar `$(list-ordered)` | Regenerate |
| Title bar `$(graph)` | Open the **swimlane diagram** — one lane per file, orange arrows for file switches |
| Title bar `$(target)` | Start from **the function under the cursor** — for library projects, or when `main` is not where you want to start |
| Title bar `$(home)` | Back to `main` (appears only once you changed the start) |
| Expand a ⚠ step → **Candidates** | Same-named definitions this call could have meant — pick another one, or click the current one to undo |

**Why the ⚠ marks are not decoration.** Without a compile database, call edges are resolved *by name*. A wrong edge in a graph is one extra line; a wrong edge in a route means **everything after it is the wrong reading order**. So whenever the name is defined more than once in the project, DepScaner says so and lets you pick — instead of silently guessing and pretending to be sure. Enabling a compile database is still the real fix (see below).

> Steps are *session state*: a custom start and manual corrections reset when VS Code restarts.
> To inspect a route without the UI: `npm run route:dump -- --dfs --files` —
> add `--svg out.svg` or `--html` to render the swimlane diagram instead of a text tree.

---

## Getting exact results (recommended)

Out of the box DepScaner uses a built-in structural parser: instant, zero-config, and **approximate** — it resolves references by name. Give it a real compile database and include / link resolution becomes **exact**.

```bash
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build
```

> ### ⚠️ CMake's Visual Studio generator never writes this file
>
> `CMAKE_EXPORT_COMPILE_COMMANDS` only works with the **Makefile** and **Ninja** generators. If your `build/` folder contains `CMakeCache.txt` and `*.vcxproj` but no `compile_commands.json`, this is why — re-configuring it will not help, because it is a generator limitation, not a missing flag.
>
> Switch to Ninja:
>
> ```bat
> :: Windows + MSVC — enter the VS environment first
> "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
> cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
> cmake --build build
> ```

DepScaner looks for `compile_commands.json` at the project root, then in `build/`, `out/`, `cmake-build-*`, `build/Release`, `build/Debug`, and finally anywhere within 4 levels of the root. You can also point straight at it with `depscaner.compile.commandsPath`.

**Not sure what it found?** Run **`DepScaner: Why is it Approx?`** — it reports whether a compile database was found and where it looked, whether the on-disk cache was discarded and why, and the concrete next step for your situation.

### Precision levels

| Level | When | What it means |
| --- | --- | --- |
| **Exact** | Engine built against libclang | All five dependency kinds are semantic |
| **Partly exact** | A `compile_commands.json` was found | Includes and links are exact; calls / inheritance / types stay structural |
| **Approximate** | Neither | Everything is structural |

Precision is also marked **per edge** — solid lines are exact, dashed lines are approximate. The status bar and the **Index Status** view show the overall level.

---

## The interface

### Sidebar

| View | Contents |
| --- | --- |
| **Actions** | Every frequent command as a single click — open route, read from cursor, open graph, reindex, export, switch language. No command palette needed. Shows the current precision level next to *Rebuild Index*. |
| **Reading Route** | Ordered reading list from `main`, with same-named candidate steps marked for review |
| **Dependencies** | Upstream / downstream tree for the current file, expandable level by level |
| **Index Status** | Progress, file / symbol / edge counts, precision, and warnings |

<!--
  TODO(screenshot): 侧边栏三个视图（操作 / 依赖 / 索引状态）展开状态
  文件名：media/screenshots/sidebar.png
  ![Sidebar views](media/screenshots/sidebar.png)
-->

### Graph · Tree · Table

Three views of the same subgraph, **selection-synced**: select a node in any one of them and the others highlight it.

- **Graph** — drag nodes · wheel to zoom · drag the canvas to pan · single-click to open the source · double-click to expand one more level
- **Toolbar** — direction (both / upstream / downstream), depth *k*, cluster by directory, show external symbols, export PNG / SVG, and the interface language switch
- **Tree** — hierarchical view rooted at the current focus
- **Table** — node, kind, in/out degree, file:line, precision; searchable by name and path

Export the current subgraph as **PNG**, **SVG** (vector), **JSON**, **DOT** or **Mermaid**.

---

## Commands

| Command | Description |
| --- | --- |
| `DepScaner: Reading Route (from main)` | Ordered reading list from the program entry point |
| `DepScaner: Reading Route: Read from Here (cursor)` | Start the route at the function under the cursor |
| `DepScaner: Reading Route: Start Back at main` | Undo a custom start |
| `DepScaner: Reading Route: Toggle File Level` | File level ↔ function level |
| `DepScaner: Reading Route: Swimlane Diagram` | Control flow across files, as a diagram |
| `DepScaner: Reading Route: Switch Traversal Strategy` | Breadth first ↔ depth first |
| `DepScaner: Show Dependency Graph` | Graph focused on the current file |
| `DepScaner: Show Dependency Graph for Symbol` | Graph focused on the symbol under the cursor |
| `DepScaner: Architecture View` | Whole-project view, aggregated by directory |
| `DepScaner: Rebuild Index (Full)` | Ignore the cache and rescan everything |
| `DepScaner: Cancel Indexing` | Abort a running scan |
| `DepScaner: Clear Index Cache` | Delete the on-disk cache |
| `DepScaner: Show Index Status` | Counts, precision, engine path, cache path |
| `DepScaner: Why is it Approx?` | Precision diagnosis with next steps |
| `DepScaner: Export Dependency Data (JSON)` | Export the focused subgraph (JSON / DOT / Mermaid) |
| `DepScaner: How to generate compile_commands.json?` | Setup guide for every build system |
| `DepScaner: Switch UI Language` | `auto` / Chinese / English |

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `depscaner.deps.includes` / `calls` / `types` / `symbols` / `links` | `true` | Enable each dependency kind |
| `depscaner.files.include` / `depscaner.files.exclude` | C/C++ globs | Which files participate in indexing |
| `depscaner.compile.commandsPath` | `""` | Explicit compile database (auto-discovered when empty) |
| `depscaner.compile.includePaths` / `defines` / `systemIncludePaths` | `[]` | Extra `-I` / `-D` / `-isystem` when you have no compile database |
| `depscaner.graph.defaultDepth` | `2` | Default expansion depth *k* |
| `depscaner.graph.direction` | `both` | `both` / `upstream` / `downstream` |
| `depscaner.graph.maxNodes` | `800` | Rendering cap per graph; clustering kicks in beyond this |
| `depscaner.graph.clusterByDirectory` | `false` | Cluster by directory when the panel opens |
| `depscaner.index.onStartup` | `true` | Index in the background when a workspace opens |
| `depscaner.index.autoRebuildOnSave` | `true` | Incremental rebuild on save |
| `depscaner.index.parallelism` | `0` | Parser threads; `0` = CPU cores |
| `depscaner.index.maxFiles` | — | Cap the number of files scanned in one run |
| `depscaner.index.fileSizeLimitKB` | — | Files larger than this are listed but not deeply parsed |
| `depscaner.cache.enabled` | `true` | On-disk cache for instant subsequent starts |
| `depscaner.cache.directory` | `""` | Cache location (defaults to `.vscode/depscaner-cache`) |
| `depscaner.ui.language` | `auto` | `auto` / `zh` / `en` |
| `depscaner.log.level` | `info` | Set to `debug` to see engine stderr — do this before reporting a crash |
| `depscaner.engine.path` | `""` | Use your own engine build instead of the bundled one |

---

## Troubleshooting

**It still says "Approximate" even though I built the project.**
Almost always the Visual Studio generator issue described [above](#getting-exact-results-recommended). Run `DepScaner: Why is it Approx?` — it will tell you whether the file exists, where DepScaner looked, and what to change.

**Indexing fails or the engine exits.**
Set `depscaner.log.level` to `debug`, reproduce, then open the **DepScaner** output channel. Since 0.1.1 the last lines of engine stderr are printed right next to the exit notice, so the reason is visible by default. If a single file is the culprit it is now **skipped with a warning** instead of failing the whole scan — check the **Index Status** view for `文件解析失败 / parse failed` entries.

**"Engine missing".**
The bundled binary does not match your platform, or `depscaner.engine.path` is invalid. `DepScaner: Show Index Status` prints the resolved engine path and where it came from.

**Indexing a huge repository is slow.**
Extend `depscaner.files.exclude` (build outputs, third-party, generated code), or raise `depscaner.index.parallelism`. For reference, 6,000 files / 1.07 M lines takes ~1.4 s wall clock on a modern desktop.

---

## Limitations

- Without a compile database, `calls` / `inherits` / `uses` are resolved **by name**: overloads and templates may be mis-resolved, and more than 3 candidates collapse into a single unresolved node.
- `links` parses CMake only (`add_executable` / `add_library` / `target_link_libraries`). Other build systems: supply a compile database for includes and calls; link edges need a later version.
- C/C++ only: `.c .cc .cpp .cxx .h .hh .hpp .hxx .inl .ipp`.
- The on-disk cache is a text format; on very large repositories (>100 k files) it can reach tens of MB.

---

## Documentation

Detailed, example-driven documentation is currently written in Chinese:

| | |
| --- | --- |
| [01 · Quick start](docs/01-快速开始.md) | Install, prepare `compile_commands.json`, first index |
| [02 · Interface guide](docs/02-界面与操作指南.md) | Three synced views, export, indexing and caching |
| [03 · Reading a project with DepScaner](docs/03-如何用%20DepScaner%20学习项目.md) | Copy-paste reading recipes: from the reading route to include / inheritance / reference graphs |
| [04 · Parsing and precision](docs/04-解析与精度说明.md) | Exact vs approximate, the boundary of each dependency kind, FAQ |
| [05 · Performance and settings](docs/05-性能与配置参考.md) | Every setting, tuning for million-line repos |
| [07 · Reading route](docs/07-阅读路线.md) | Why an ordered list instead of a fourth graph, candidates, acceptance criteria |

---

## Building from source

Requires Node.js ≥ 18, CMake ≥ 3.16 and a C++20 compiler (MSVC 2019+ / GCC 10+ / Clang 12+).

```bash
npm install
npm run build:core     # C++ engine -> engine/build/bin/<Config>/depscaner-core
npm run build          # typecheck + bundle extension + bundle webview + self-checks
npm test               # engine self-tests + JSON-RPC smoke + webview checks
npm run package        # produce a .vsix
```

Press `F5` to start an Extension Development Host with `samples/demo` as the workspace. Releases are built for all platforms by GitHub Actions — see [docs/06-发布与版本管理.md](docs/06-发布与版本管理.md).

### How it is put together

```
VS Code extension (TypeScript / Node)
  commands · sidebar · status bar · settings · incremental scheduling · disk cache
  Webview (Canvas force-directed graph / tree / table / export)
        ↕  stdio JSON-RPC (line-delimited JSON, UTF-8)
C++ engine (separate process, zero external dependencies)
  discovery → parallel structural parsing → symbol table → graph → subgraph pruning
```

- **Why a separate process** — the extension host is a single-threaded Node process; parsing millions of lines inside it would freeze the editor. A child process also means an engine crash cannot take the editor down.
- **Why stdio JSON-RPC** — identical on every platform, no local ports, no ABI binding (N-API would mean a six-platform build matrix for nothing).
- **Pruning on the engine side** — the whole graph is never sent to the webview; the engine runs a k-hop BFS and returns only the subgraph. This is what keeps large projects responsive.

---

## License

MIT
