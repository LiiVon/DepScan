// DepScaner 引擎数据模型：节点 / 边 / 精度等级。
// 该模型是「引擎 ⇄ 插件 ⇄ Webview」全链唯一的真相来源，字段命名一经确定不得单边修改。
#pragma once

#include <string>
#include <vector>
#include <cstdint>

namespace depscan {

enum class NodeKind {
  File,      // 源文件 / 头文件
  Function,  // 函数 / 方法
  Class,     // class / struct / union
  Enum,      // 枚举
  Variable,  // 全局或静态变量
  Macro,     // 预处理宏
  Target,    // 构建目标（可执行文件 / 库）
  Unknown
};

enum class EdgeKind {
  Includes,  // A #include B
  Calls,     // A 调用 B
  Inherits,  // A 继承 B
  Uses,      // A 使用了类型 B（成员/参数/局部变量）
  Refs,      // A 引用了符号 B（变量 / 宏）
  Links      // 目标 A 链接了目标/库 B
};

enum class Precision {
  Exact,        // 基于 compile_commands + Clang 语义分析
  Approximate   // 基于内置轻量结构解析（无 compile_commands）
};

enum class Direction { Both, Upstream, Downstream };

const char* toString(NodeKind k);
const char* toString(EdgeKind k);
const char* toString(Precision p);
bool parseNodeKind(const std::string& s, NodeKind& out);
bool parseEdgeKind(const std::string& s, EdgeKind& out);
bool parseDirection(const std::string& s, Direction& out);

struct Node {
  std::string id;        // 全链唯一，见下方 makeXxxId
  NodeKind kind = NodeKind::Unknown;
  std::string name;      // 显示名（文件的相对路径 / 符号的限定名）
  std::string file;      // 定义所在文件（相对项目根，正斜杠）
  int line = 0;
  int column = 0;
  std::string module;    // 所属目录（相对根），用于分层与聚类
  std::string detail;    // 签名 / 基类 / 说明
  Precision precision = Precision::Approximate;
  bool external = false; // true = 项目外或未能解析到定义的符号
  bool declaration = false; // true = 仅有声明
  // 函数体跨的行数（含花括号所在行）；0 = 没有函数体（声明）或非函数。
  // 用来回答「这函数有多大」——目前只有阅读路线的降噪用它，
  // 但展示层（表格 / 详情）也可以直接显示它。
  int bodyLines = 0;
  int inDegree = 0;
  int outDegree = 0;
  // 「公开面」：声明（或定义）落在 include/ 这类公开目录里时，记下那处位置。
  // 空 = 不是公开接口。库项目没有 main，想读它就得从公开面起头 ——
  // 见 route.hpp 的 findEntryCandidates 与 docs/07 §2.1。
  std::string apiHeader;
  int apiLine = 0;
};

struct Edge {
  std::string from;
  std::string to;
  EdgeKind kind = EdgeKind::Refs;
  Precision precision = Precision::Approximate;
  std::string file;      // 依赖发生在哪个文件
  int line = 0;
};

struct Graph {
  std::vector<Node> nodes;
  std::vector<Edge> edges;
};

// —— id 约定（引擎生成，插件与 Webview 只消费）——
// file:<relPath> | func:<qname> | class:<qname> | enum:<qname>
// var:<qname>   | macro:<name> | target:<name> | ext:<kind>:<name>
std::string makeNodeId(NodeKind kind, const std::string& key);
std::string makeExternalId(NodeKind kind, const std::string& name);
std::string kindPrefix(NodeKind kind);

// 「公开面」的判定约定：include / inc / public / api 这些顶层目录下的文件算公开接口。
// 这也是安装规则最常见的写法（install(DIRECTORY include/ ...)）。
//
// 为什么用**目录**而不是别的信号：没有编译数据库时，「导出符号」这件事在语法层是看不到的
// （没有 __declspec(dllexport) 判断、也不知道 CMake 的 PUBLIC/PRIVATE）。
// 而「声明放在 include/ 下」是 C/C++ 项目里最接近「这就是我的公开 API」的约定。
// 头文件都在 src/ 里的项目就没有公开面 —— 那时只能靠调用图上的「根」来起头。
inline bool isPublicApiFile(const std::string& relFile) {
  static const char* kDirs[] = {"include/", "inc/", "public/", "api/"};
  for (const char* d : kDirs) {
    if (relFile.rfind(d, 0) == 0) return true;
  }
  return false;
}

// 单文件分析产物：既用于生成图，也用于聚合全局符号表。
struct SymbolDef {
  std::string id;
  NodeKind kind = NodeKind::Unknown;
  std::string name;         // 简单名
  std::string qualifiedName; // 限定名（Class::method）
  std::string file;
  int line = 0;
  int column = 0;
  std::string signature;
  bool declaration = false;
  /** 函数体行数；0 = 声明（无体） */
  int bodyLines = 0;
};

struct PendingRef {
  std::string fromId;       // 引用者
  std::string name;         // 被引用的名字（可能带 A::B 限定）
  EdgeKind kind = EdgeKind::Calls;
  std::string file;
  int line = 0;
};

struct FileAnalysis {
  std::string file;                       // 相对路径
  std::vector<SymbolDef> symbols;         // 本文件定义的符号
  std::vector<PendingRef> refs;           // 本文件产生的未解析引用
  std::vector<std::pair<std::string,int>> includes; // include 目标原文 + 行号
  bool fromCompileCommand = false;        // 是否用到了编译数据库提供的参数
  int lineCount = 0;
  long long mtimeMs = 0;                  // 缓存失效判定
  long long size = 0;
};

bool isSourceExtension(const std::string& ext);
bool isHeaderExtension(const std::string& ext);

}  // namespace depscan
