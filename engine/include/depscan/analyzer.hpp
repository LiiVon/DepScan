#pragma once

#include <string>
#include <vector>

#include "depscan/types.hpp"

namespace depscan {

// 分析开关与解析上下文（与 package.json 中 depscaner.deps.* 一一对应）
struct AnalyzerOptions {
  bool includes = true;
  bool calls = true;
  bool types = true;
  bool symbols = true;
  bool links = true;
  bool includeExternal = false;         // 是否把未解析的调用/继承目标也建成节点
  std::vector<std::string> includePaths;
  std::vector<std::string> systemIncludePaths;
  std::vector<std::string> defines;
  size_t fileSizeLimitBytes = 4ull * 1024 * 1024;
};

// 单文件结构级分析（近似精度）。返回本文件的符号定义与未解析引用。
FileAnalysis analyzeFile(const std::string& relPath, const std::string& source,
                         const AnalyzerOptions& opts);

}  // namespace depscan
