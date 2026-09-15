# samples/libdemo —— 故意「没有 main」的示例库

存在的理由只有一个：**库项目怎么读**。

`samples/demo` 有 `main`，所以阅读路线从 `main` 起头；真实世界里大量项目是库，
压根没有入口函数 —— 那时「从哪读起」这个问题不能靠 `main` 回答。

这个样例故意做成最小的库形状：

```
include/libdemo/math.h    # 公开接口：add / mean（声明在 include/ 下 = 公开面）
src/math.cpp              # 它们的定义（mean → add → addImpl）
include/libdemo/text.h    # 公开接口：join
src/text.cpp              # join 与内部辅助 isBlank
src/internal.h            # 内部头：不在 include/ 下，**不该**被当成公开接口
CMakeLists.txt            # add_library，target_include_directories(PUBLIC include PRIVATE src)
```

用起来：

```bash
npm run route:dump -- --root samples/libdemo --entries                 # 看起点候选
npm run route:dump -- --root samples/libdemo --from func:libdemo::mean # 从候选起头
```

在 VS Code 里打开这个目录并索引，侧边栏「阅读路线」会直接列出候选（而不是报「找不到入口」）。
判定与排序规则见 [docs/07 §2.1](../../docs/07-阅读路线.md)。
