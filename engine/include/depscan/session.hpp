#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

#include "depscan/analyzer.hpp"
#include "depscan/buildmodel.hpp"
#include "depscan/json.hpp"
#include "depscan/types.hpp"

namespace depscan {

struct ScanStats {
  std::string root;
  std::string engineVersion;
  int fileCount = 0;
  int symbolCount = 0;
  int edgeCount = 0;
  int unresolvedRefs = 0;
  int skippedFiles = 0;
  int exactNodes = 0;
  int approxNodes = 0;
  int exactIncludeEdges = 0;
  int approxIncludeEdges = 0;
  bool compileCommandsFound = false;
  std::string compileCommandsPath;
  int compileCommandEntries = 0;
  bool libclangAvailable = false;
  bool cacheReused = false;
  double elapsedMs = 0;
  std::vector<std::string> warnings;
  std::map<std::string, int> nodeKindCounts;
  std::map<std::string, int> edgeKindCounts;
};

// 图存储 + 子图查询 + 增量合并。全链单一真相来源。
class Session {
 public:
  Session();

  void reset(const std::string& root, const AnalyzerOptions& opts);
  const std::string& root() const { return root_; }
  void setOptions(const AnalyzerOptions& opts) { options_ = opts; }

  // 扫描器契约：批量期由单线程合并，随后调用 rebuild()
  std::map<std::string, FileAnalysis>& filesMutable() { return files_; }
  const std::map<std::string, FileAnalysis>& files() const { return files_; }
  void putFile(FileAnalysis fa);
  void eraseFile(const std::string& rel);

  void setBuildModel(BuildModel model) { build_ = std::move(model); }
  const BuildModel& buildModel() const { return build_; }

  void rebuild();  // 重建全量图（含 include 解析、引用消解、链接依赖）
  const Graph& graph() const { return graph_; }
  const ScanStats& stats() const { return stats_; }
  ScanStats& statsMutable() { return stats_; }

  // 以某节点为中心做 k 层 BFS 子图（服务端裁剪，避免把全图推给 Webview）
  Graph subgraph(const std::string& focusId, int depth, Direction dir, size_t maxNodes,
                 bool* truncated) const;

  // LOD 第 1 层：按目录聚合的全局架构视图
  Graph architecture(size_t maxNodes) const;

  // 受影响文件：某文件变化后需要重算哪些文件（用于增量索引）
  std::vector<std::string> dependentsOf(const std::string& rel) const;

  json::Value graphToJson(const Graph& g) const;
  json::Value statsToJson() const;
  std::string graphToDot(const Graph& g) const;
  std::string graphToMermaid(const Graph& g) const;

  // 磁盘缓存（V2 自定义文本格式，见 cache 段注释）
  // fingerprint：配置与编译数据库的摘要；不匹配则整体作废
  bool saveCache(const std::string& path, const std::string& fingerprint) const;
  bool loadCache(const std::string& path, const std::string& fingerprint);

 private:
  std::string resolveInclude(const std::string& fromRel, const std::string& target,
                             Precision& precision) const;
  const Node* findNode(const std::string& id) const;
  std::vector<std::string> lookup(const std::string& name, NodeKind kind) const;
  std::string ensureExternal(NodeKind kind, const std::string& name);
  void addEdge(const std::string& from, const std::string& to, EdgeKind kind, Precision p,
               const std::string& file, int line);
  Node& internNode(const std::string& id);

  std::string root_;
  AnalyzerOptions options_;
  std::map<std::string, FileAnalysis> files_;
  BuildModel build_;

  Graph graph_;
  std::map<std::string, size_t> nodeIndex_;
  std::map<std::string, std::vector<size_t>> outEdges_;
  std::map<std::string, std::vector<size_t>> inEdges_;
  std::map<std::string, std::set<std::string>> edgeKeys_;

  std::map<std::string, std::vector<std::string>> funcByName_;
  std::map<std::string, std::vector<std::string>> funcByQual_;
  std::map<std::string, std::vector<std::string>> classByName_;
  std::map<std::string, std::vector<std::string>> classByQual_;
  std::map<std::string, std::vector<std::string>> varByName_;
  std::map<std::string, std::vector<std::string>> macroByName_;
  std::map<std::string, std::vector<std::string>> fileByBase_;
  std::map<std::string, std::vector<std::string>> fileSymbols_;  // 文件 -> 其内部符号（结构包含）

  ScanStats stats_;
};

}  // namespace depscan
