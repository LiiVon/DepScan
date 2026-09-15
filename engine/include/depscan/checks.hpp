// 架构边界检查（violations）：把「可证明的坏味道」找出来，而不是靠目录名瞎猜。
//
// 这里只有两条检查，共同点是不需要启发式：
//   1. public-api-leak —— 公开头文件引用了非公开的实现（装了库的人没有那个文件）
//   2. directory-cycle —— 目录之间互相依赖成环（分层就无从谈起）
//
// 为什么不做「按目录名猜层次」（core/base 是底层、app/ui 是上层）：
// 那是**约定**而不是**事实** —— 换个项目命名习惯就会满屏误报，而误报会让人
// 直接关掉整个检查。宁可贵一点但可证明：环由强连通分量算出来，泄漏由
// 「公开面 vs 非公开面」的边算出来，两条都能自己核对。
#pragma once

#include <string>
#include <vector>

#include "depscan/types.hpp"

namespace depscan {

struct Violation {
  // "public-api-leak" | "directory-cycle"
  std::string kind;
  // 能跳到源码的位置（诊断靠它定位）
  std::string fromFile;
  int fromLine = 0;
  // 泄漏：被引用的那个非公开文件；目录循环：空
  std::string toFile;
  // 目录循环：环里的目录（已排序）；泄漏：空
  std::vector<std::string> dirs;
  // 目录循环：环内参与依赖边数
  int edgeCount = 0;
};

// 扫描图，返回违规清单。
// `maxItems <= 0` = 不截断；`total` 返回未截断的真实数量。
//
// 判定规则（两条都只认「项目内、且解析到了具体文件」的边）：
//   public-api-leak ：includes / uses 边，起点文件在公开目录（include/ 等），
//                     终点文件不在公开目录。解析不到的边（外部符号、未解析）跳过 ——
//                     漏报是安全的，误报才让人关掉检查。
//   directory-cycle ：把目录间的 includes 依赖看成有向图，报出强连通分量（≥2 个目录）。
//                     **同目录内部互相 include 不算** —— 头文件互相引用在 C++ 里很正常。
std::vector<Violation> findViolations(const Graph& g, int maxItems, int& total);

}  // namespace depscan
