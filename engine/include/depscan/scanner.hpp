#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "depscan/analyzer.hpp"
#include "depscan/session.hpp"

namespace depscan {

struct ScanRequest {
  std::string root;
  std::string compileCommandsPath;         // 空 = 自动发现
  AnalyzerOptions options;
  std::vector<std::string> includeGlobs;
  std::vector<std::string> excludeGlobs;
  size_t maxFiles = 20000;
  std::string cachePath;                   // 空 = 不落盘
  bool useCache = true;
  bool forceFull = false;
  int threads = 0;                         // 0 = 自动
};

struct CompileDatabase {
  bool found = false;
  std::string path;
  int entries = 0;
  std::vector<std::string> includePaths;   // 全库并集（相对 root 或绝对）
  std::vector<std::string> systemIncludePaths;
  std::vector<std::string> defines;
  std::map<std::string, int> fileIndex;    // 绝对路径 -> 条目下标
  std::vector<std::vector<std::string>> includePathsByEntry;
};

// 自动发现并解析 compile_commands.json（用于include 精确解析与宏定义还原）
CompileDatabase discoverCompileDatabase(const std::string& root, const std::string& explicitPath);

// 进度回调：返回 false 表示请求取消
using ProgressFn = std::function<bool(int done, int total, const std::string& file)>;

class Scanner {
 public:
  explicit Scanner(Session& session) : session_(session) {}

  // 全量（或基于缓存的增量）扫描。返回 false 表示被取消或出错。
  bool run(const ScanRequest& req, const ProgressFn& onProgress, std::string& error);

  // 单文件重分析（保存事件触发的增量入口）
  bool runSingle(const ScanRequest& req, const std::string& relPath, std::string& error);

 private:
  Session& session_;
};

}  // namespace depscan
