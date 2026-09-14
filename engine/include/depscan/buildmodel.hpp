#pragma once

#include <string>
#include <vector>

namespace depscan {

// 构建系统元数据（当前支持 CMake；Makefile/Ninja/Bazel/qmake/Xcode 走 compile_commands 生成引导）
struct BuildTarget {
  std::string name;
  std::string kind;                       // executable / library
  std::vector<std::string> sources;       // 源文件（可能含未展开的 CMake 变量）
  std::vector<std::string> links;         // 链接的目标 / 库
  std::vector<std::string> packages;      // find_package 结果
  std::string file;                       // 定义所在 CMakeLists.txt（相对根）
  int line = 0;
};

struct BuildModel {
  std::vector<BuildTarget> targets;
  bool hasCMake = false;
};

// 扫描 root 下的 CMakeLists.txt（跳过 build/_deps 等），构建 target 与链接关系模型。
BuildModel parseBuildModel(const std::string& root);

}  // namespace depscan
