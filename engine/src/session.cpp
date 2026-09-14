#include "depscan/session.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <deque>
#include <set>
#include <sstream>

#include "depscan/util.hpp"

namespace depscan {

namespace {

constexpr const char* kEngineVersion = "0.1.0";

std::string simpleName(const std::string& qualified) {
  const size_t pos = qualified.rfind("::");
  return pos == std::string::npos ? qualified : qualified.substr(pos + 2);
}

std::string normalizeRefName(const std::string& name) {
  if (name.empty()) return name;
  if (name[0] == '~') return simpleName(name.substr(1));
  return name;
}

// 缓存字段转义（V1 文本格式：反斜杠 / 制表符 / 换行）
std::string esc(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '\t': out += "\\t"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      default: out.push_back(c);
    }
  }
  return out;
}

std::string unesc(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '\\' && i + 1 < s.size()) {
      const char n = s[++i];
      if (n == 't') out.push_back('\t');
      else if (n == 'n') out.push_back('\n');
      else if (n == 'r') out.push_back('\r');
      else if (n == '\\') out.push_back('\\');
      else out.push_back(n);
    } else {
      out.push_back(s[i]);
    }
  }
  return out;
}

std::vector<std::string> splitTab(const std::string& line) {
  std::vector<std::string> parts;
  std::string cur;
  for (char c : line) {
    if (c == '\t') { parts.push_back(cur); cur.clear(); }
    else cur.push_back(c);
  }
  parts.push_back(cur);
  return parts;
}

}  // namespace

Session::Session() { stats_.engineVersion = kEngineVersion; }

void Session::reset(const std::string& root, const AnalyzerOptions& opts) {
  root_ = util::normalizePath(root);
  options_ = opts;
  stats_.root = root_;
  stats_.engineVersion = kEngineVersion;
#ifdef DEPS_HAVE_LIBCLANG
  stats_.libclangAvailable = true;
#endif
}

void Session::putFile(FileAnalysis fa) {
  if (fa.file.empty()) return;
  files_[fa.file] = std::move(fa);
}

void Session::eraseFile(const std::string& rel) { files_.erase(rel); }

// ---------------------------- 图构建 ----------------------------

Node& Session::internNode(const std::string& id) {
  auto it = nodeIndex_.find(id);
  if (it != nodeIndex_.end()) return graph_.nodes[it->second];
  nodeIndex_[id] = graph_.nodes.size();
  Node n;
  n.id = id;
  graph_.nodes.push_back(std::move(n));
  return graph_.nodes.back();
}

const Node* Session::findNode(const std::string& id) const {
  auto it = nodeIndex_.find(id);
  return it == nodeIndex_.end() ? nullptr : &graph_.nodes[it->second];
}

void Session::addEdge(const std::string& from, const std::string& to, EdgeKind kind, Precision p,
                      const std::string& file, int line) {
  if (from.empty() || to.empty() || from == to) return;
  if (!findNode(from) || !findNode(to)) return;
  const std::string key = from + "\x01" + to + "\x01" + toString(kind);
  if (!edgeKeys_[from].insert(key).second) return;
  Edge e;
  e.from = from;
  e.to = to;
  e.kind = kind;
  e.precision = p;
  e.file = file;
  e.line = line;
  graph_.edges.push_back(std::move(e));
}

std::string Session::ensureExternal(NodeKind kind, const std::string& name) {
  if (!options_.includeExternal || name.empty()) return {};
  const std::string id = makeExternalId(kind, name);
  Node& n = internNode(id);
  n.kind = kind;
  n.name = name;
  n.module = "<external>";
  n.detail = "未在项目内解析到定义的符号（标准库 / 第三方库 / 外部依赖）";
  n.precision = Precision::Approximate;
  n.external = true;
  return id;
}

std::vector<std::string> Session::lookup(const std::string& name, NodeKind kind) const {
  const std::string key = normalizeRefName(name);
  if (key.empty()) return {};
  const auto pick = [&](const std::map<std::string, std::vector<std::string>>& simple,
                        const std::map<std::string, std::vector<std::string>>* qualified) {
    if (qualified) {
      auto q = qualified->find(key);
      if (q != qualified->end() && !q->second.empty()) return q->second;
    }
    auto s = simple.find(simpleName(key));
    if (s != simple.end()) return s->second;
    return std::vector<std::string>{};
  };
  switch (kind) {
    case NodeKind::Function: return pick(funcByName_, &funcByQual_);
    case NodeKind::Class:
    case NodeKind::Enum: return pick(classByName_, &classByQual_);
    case NodeKind::Variable: return pick(varByName_, nullptr);
    case NodeKind::Macro: return pick(macroByName_, nullptr);
    default: return {};
  }
}

std::string Session::resolveInclude(const std::string& fromRel, const std::string& target,
                                    Precision& precision) const {
  precision = Precision::Approximate;
  const std::string t = util::normalizePath(target);
  if (t.empty()) return {};

  // 1) 相对被包含文件所在目录（"a.h" 的语义）
  const std::string dir = util::dirName(fromRel);
  const std::string cand = util::normalizePath(dir.empty() ? t : util::joinPath(dir, t));
  if (files_.count(cand)) {
    precision = Precision::Exact;
    return cand;
  }
  // 2) -I / -isystem 搜索路径
  for (const std::vector<std::string>* paths : {&options_.includePaths, &options_.systemIncludePaths}) {
    for (const std::string& p : *paths) {
      const std::string abs = util::normalizePath(util::joinPath(util::joinPath(root_, p), t));
      const std::string rel = util::relativeTo(root_, abs);
      if (files_.count(rel)) {
        precision = Precision::Exact;
        return rel;
      }
    }
  }
  // 3) 按文件名后缀唯一匹配（近似）
  auto it = fileByBase_.find(util::lower(util::baseName(t)));
  if (it != fileByBase_.end()) {
    for (const std::string& r : it->second) {
      if (r == t || util::endsWith(r, "/" + t)) return r;
    }
    if (it->second.size() == 1) return it->second[0];
  }
  return {};
}

void Session::rebuild() {
  const auto t0 = std::chrono::steady_clock::now();

  // 递增统计量需要复位（compileCommands* 由 scanner 负责，不在此清空）
  stats_.exactIncludeEdges = 0;
  stats_.approxIncludeEdges = 0;
  stats_.edgeCount = 0;
  stats_.symbolCount = 0;

  graph_ = Graph();
  nodeIndex_.clear();
  outEdges_.clear();
  inEdges_.clear();
  edgeKeys_.clear();
  funcByName_.clear();
  funcByQual_.clear();
  classByName_.clear();
  classByQual_.clear();
  varByName_.clear();
  macroByName_.clear();
  fileByBase_.clear();
  fileSymbols_.clear();

  // --- 1. 文件节点 + 文件索引 ---
  for (const auto& kv : files_) {
    const std::string& rel = kv.first;
    Node& n = internNode(makeNodeId(NodeKind::File, rel));
    n.kind = NodeKind::File;
    n.name = rel;
    n.file = rel;
    n.line = 1;
    const std::string d = util::dirName(rel);
    n.module = (d.empty() || d == ".") ? std::string(".") : d;
    n.detail = isHeaderExtension(util::extensionOf(rel)) ? "头文件" : "源文件";
    n.precision = kv.second.fromCompileCommand ? Precision::Exact : Precision::Approximate;

    const std::string base = util::lower(util::baseName(rel));
    fileByBase_[base].push_back(rel);
  }

  // --- 2. 符号节点 + 符号索引 ---
  for (const auto& kv : files_) {
    const FileAnalysis& fa = kv.second;
    for (const SymbolDef& d : fa.symbols) {
      if (d.kind == NodeKind::Enum) {
        // 枚举复用 class 索引，便于类型依赖解析
      }
      Node& n = internNode(d.id);
      const bool first = n.kind == NodeKind::Unknown;
      if (first) {
        n.kind = d.kind;
        n.name = d.name;
        n.file = d.file;
        n.line = d.line;
        n.column = d.column;
        n.module = util::dirName(d.file);
        if (n.module.empty()) n.module = ".";
        n.declaration = d.declaration;
      } else {
        // 只有「所有出现都是声明」时才算声明；只要有一处是定义就标为定义
        n.declaration = n.declaration && d.declaration;
        if (n.declaration && !d.declaration) {
          n.file = d.file;
          n.line = d.line;
          n.column = d.column;
        }
      }
      if (!d.signature.empty() && n.detail.empty()) n.detail = d.signature;
      n.precision = fa.fromCompileCommand ? Precision::Exact : Precision::Approximate;
      fileSymbols_[d.file].push_back(d.id);

      switch (d.kind) {
        case NodeKind::Function:
          funcByName_[d.name].push_back(d.id);
          funcByQual_[d.qualifiedName].push_back(d.id);
          break;
        case NodeKind::Class:
        case NodeKind::Enum:
          classByName_[d.name].push_back(d.id);
          classByQual_[d.qualifiedName].push_back(d.id);
          break;
        case NodeKind::Variable: varByName_[d.name].push_back(d.id); break;
        case NodeKind::Macro: macroByName_[d.name].push_back(d.id); break;
        default: break;
      }
    }
  }

  // --- 3. include 边 ---
  if (options_.includes) {
    for (const auto& kv : files_) {
      const FileAnalysis& fa = kv.second;
      const std::string fromId = makeNodeId(NodeKind::File, fa.file);
      for (const auto& inc : fa.includes) {
        Precision p = Precision::Approximate;
        const std::string target = resolveInclude(fa.file, inc.first, p);
        if (target.empty()) {
          const std::string ext = ensureExternal(NodeKind::File, inc.first);
          if (!ext.empty()) addEdge(fromId, ext, EdgeKind::Includes, Precision::Approximate, fa.file, inc.second);
          continue;
        }
        addEdge(fromId, makeNodeId(NodeKind::File, target), EdgeKind::Includes, p, fa.file, inc.second);
        if (p == Precision::Exact) ++stats_.exactIncludeEdges;
        else ++stats_.approxIncludeEdges;
      }
    }
  }

  // --- 4. 引用消解（调用 / 继承 / 类型 / 符号） ---
  int unresolved = 0;
  for (const auto& kv : files_) {
    const FileAnalysis& fa = kv.second;
    if (!findNode(makeNodeId(NodeKind::File, kv.first))) continue;
    for (const PendingRef& ref : fa.refs) {
      if (ref.kind == EdgeKind::Calls && !options_.calls) continue;
      if ((ref.kind == EdgeKind::Inherits || ref.kind == EdgeKind::Uses) && !options_.types) continue;
      if (ref.kind == EdgeKind::Refs && !options_.symbols) continue;

      std::vector<std::string> hits = lookup(ref.name, ref.kind == EdgeKind::Calls ? NodeKind::Function
                                                                                  : (ref.kind == EdgeKind::Refs ? NodeKind::Macro
                                                                                                               : NodeKind::Class));
      if (hits.empty() && ref.kind == EdgeKind::Refs) hits = lookup(ref.name, NodeKind::Variable);
      if (hits.empty() && ref.kind == EdgeKind::Calls) hits = lookup(ref.name, NodeKind::Class);
      if (hits.empty() && ref.kind == EdgeKind::Uses) hits = lookup(ref.name, NodeKind::Variable);

      EdgeKind outKind = ref.kind;
      if (hits.empty() && ref.kind == EdgeKind::Calls) {
        // 调用目标其实是类型 -> 归为类型依赖
        outKind = EdgeKind::Uses;
      }
      if (hits.empty() && ref.kind == EdgeKind::Uses) {
        const std::vector<std::string> f = lookup(ref.name, NodeKind::Function);
        if (!f.empty()) {
          outKind = EdgeKind::Refs;
          hits = f;
        }
      }

      if (hits.empty()) {
        ++unresolved;
        const NodeKind target = ref.kind == EdgeKind::Inherits   ? NodeKind::Class
                                : ref.kind == EdgeKind::Calls    ? NodeKind::Function
                                : ref.kind == EdgeKind::Refs     ? NodeKind::Macro
                                                                 : NodeKind::Class;
        const std::string ext = ensureExternal(target, ref.name);
        if (!ext.empty()) addEdge(ref.fromId, ext, ref.kind, Precision::Approximate, ref.file, ref.line);
        continue;
      }

      if (hits.size() > 3) {
        const std::string ext = ensureExternal(NodeKind::Function, ref.name);
        if (!ext.empty()) addEdge(ref.fromId, ext, outKind, Precision::Approximate, ref.file, ref.line);
        continue;
      }
      // 同名多命中（重载）：同文件优先
      std::vector<std::string> ordered = hits;
      std::stable_sort(ordered.begin(), ordered.end(), [&](const std::string& a, const std::string& b) {
        const Node* na = findNode(a);
        const Node* nb = findNode(b);
        const bool sa = na && na->file == ref.file;
        const bool sb = nb && nb->file == ref.file;
        return sa > sb;
      });
      for (const std::string& id : ordered) {
        const Node* n = findNode(id);
        addEdge(ref.fromId, id, outKind, n ? n->precision : Precision::Approximate, ref.file, ref.line);
      }
    }
  }
  stats_.unresolvedRefs = unresolved;

  // --- 5. 链接 / 构建依赖 ---
  if (options_.links) {
    std::set<std::string> targetNames;
    for (const BuildTarget& t : build_.targets) targetNames.insert(t.name);
    for (const BuildTarget& t : build_.targets) {
      const std::string tid = makeNodeId(NodeKind::Target, t.name);
      Node& n = internNode(tid);
      n.kind = NodeKind::Target;
      n.name = t.name;
      n.file = t.file;
      n.line = t.line;
      n.module = util::dirName(t.file);
      if (n.module.empty()) n.module = ".";
      std::string detail = t.kind == "executable" ? "可执行目标" : "库目标";
      if (!t.sources.empty()) {
        detail += " · " + std::to_string(t.sources.size()) + " 个源文件";
      }
      n.detail = detail;
      n.precision = Precision::Exact;  // 来自构建元数据

      // target -> 源文件
      for (const std::string& s : t.sources) {
        auto it = fileByBase_.find(util::lower(util::baseName(s)));
        if (it == fileByBase_.end()) continue;
        for (const std::string& rel : it->second) {
          if (rel == s || util::endsWith(rel, "/" + s)) {
            addEdge(tid, makeNodeId(NodeKind::File, rel), EdgeKind::Links, Precision::Exact, t.file,
                    t.line);
          }
        }
      }
      // target -> 被链接的库 / 目标
      for (const std::string& lib : t.links) {
        if (targetNames.count(lib)) {
          addEdge(tid, makeNodeId(NodeKind::Target, lib), EdgeKind::Links, Precision::Exact, t.file,
                  t.line);
        } else {
          const std::string ext = ensureExternal(NodeKind::Target, lib);
          if (!ext.empty()) addEdge(tid, ext, EdgeKind::Links, Precision::Exact, t.file, t.line);
          else {
            // 即使未开启外部节点，也让被链接的库可见（链接关系是构建事实）
            const std::string id = internNode(makeExternalId(NodeKind::Target, lib)).id;
            Node& ln = graph_.nodes[nodeIndex_[id]];
            ln.kind = NodeKind::Target;
            ln.name = lib;
            ln.module = "<external>";
            ln.detail = "外部库 / 系统库（由构建脚本链接）";
            ln.precision = Precision::Exact;
            ln.external = true;
            addEdge(tid, id, EdgeKind::Links, Precision::Exact, t.file, t.line);
          }
        }
      }
    }
  }

  // --- 6. 邻接表与度数 ---
  for (const Edge& e : graph_.edges) {
    auto fit = nodeIndex_.find(e.from);
    auto tit = nodeIndex_.find(e.to);
    if (fit == nodeIndex_.end() || tit == nodeIndex_.end()) continue;
    outEdges_[e.from].push_back(nodeIndex_[e.to]);
    inEdges_[e.to].push_back(nodeIndex_[e.from]);
  }
  for (Node& n : graph_.nodes) {
    auto o = outEdges_.find(n.id);
    auto i = inEdges_.find(n.id);
    n.outDegree = o == outEdges_.end() ? 0 : static_cast<int>(o->second.size());
    n.inDegree = i == inEdges_.end() ? 0 : static_cast<int>(i->second.size());
  }

  // --- 7. 统计 ---
  stats_.fileCount = static_cast<int>(files_.size());
  stats_.symbolCount = 0;
  stats_.nodeKindCounts.clear();
  stats_.edgeKindCounts.clear();
  stats_.exactNodes = 0;
  stats_.approxNodes = 0;
  for (const Node& n : graph_.nodes) {
    if (n.kind != NodeKind::File && n.kind != NodeKind::Target) ++stats_.symbolCount;
    stats_.nodeKindCounts[toString(n.kind)] += 1;
    if (n.precision == Precision::Exact) ++stats_.exactNodes;
    else ++stats_.approxNodes;
  }
  for (const Edge& e : graph_.edges) {
    stats_.edgeKindCounts[toString(e.kind)] += 1;
  }
  stats_.edgeCount = static_cast<int>(graph_.edges.size());

  const auto t1 = std::chrono::steady_clock::now();
  stats_.elapsedMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
}

// ---------------------------- 子图查询 ----------------------------

Graph Session::subgraph(const std::string& focusId, int depth, Direction dir, size_t maxNodes,
                        bool* truncated) const {
  Graph out;
  if (truncated) *truncated = false;
  auto start = nodeIndex_.find(focusId);
  if (start == nodeIndex_.end()) {
    // 允许传入 "file:<rel>" 之外的宽松写法
    auto alt = nodeIndex_.find(makeNodeId(NodeKind::File, focusId));
    if (alt == nodeIndex_.end()) return out;
    start = alt;
  }

  std::set<std::string> visited;
  std::deque<std::pair<std::string, int>> queue;
  const std::string rootId = graph_.nodes[start->second].id;
  visited.insert(rootId);
  queue.emplace_back(rootId, 0);

  while (!queue.empty()) {
    const auto [id, d] = queue.front();
    queue.pop_front();
    if (truncated && visited.size() >= maxNodes) { *truncated = true; break; }
    if (d >= depth) continue;

    // 结构包含关系：文件 ⇄ 其内部符号（保证"点文件能看到自己的函数"）
    const auto curIt = nodeIndex_.find(id);
    if (curIt == nodeIndex_.end()) continue;
    const Node& cur = graph_.nodes[curIt->second];
    if (cur.kind == NodeKind::File) {
      const std::string key = cur.file.empty() ? cur.name : cur.file;
      const auto symIt = fileSymbols_.find(key);
      if (symIt != fileSymbols_.end()) {
        for (const std::string& sid : symIt->second) {
          if (visited.insert(sid).second) queue.emplace_back(sid, d + 1);
        }
      }
    } else if (!cur.file.empty() && (dir == Direction::Both || dir == Direction::Upstream)) {
      const std::string fid = makeNodeId(NodeKind::File, cur.file);
      if (nodeIndex_.count(fid) && visited.insert(fid).second) queue.emplace_back(fid, d + 1);
    }

    const auto expand = [&](const std::map<std::string, std::vector<size_t>>& table) {
      auto it = table.find(id);
      if (it == table.end()) return;
      for (size_t idx : it->second) {
        const Node& nb = graph_.nodes[idx];
        if (visited.insert(nb.id).second) queue.emplace_back(nb.id, d + 1);
      }
    };
    if (dir == Direction::Both || dir == Direction::Downstream) expand(outEdges_);
    if (dir == Direction::Both || dir == Direction::Upstream) expand(inEdges_);
  }

  std::map<std::string, bool> keep;
  for (const std::string& id : visited) keep[id] = true;
  // 邻接表按 index 存放，需要把 index 映射回 id
  for (const Node& n : graph_.nodes) {
    if (keep.count(n.id)) out.nodes.push_back(n);
  }
  for (const Edge& e : graph_.edges) {
    if (keep.count(e.from) && keep.count(e.to)) out.edges.push_back(e);
  }
  return out;
}

Graph Session::architecture(size_t maxNodes) const {
  Graph out;
  std::map<std::string, int> dirFileCount;
  std::map<std::pair<std::string, std::string>, int> dirEdges;

  for (const Node& n : graph_.nodes) {
    if (n.kind != NodeKind::File) continue;
    dirFileCount[n.module] += 1;
  }
  for (const Edge& e : graph_.edges) {
    if (e.kind != EdgeKind::Includes) continue;
    const auto fit = nodeIndex_.find(e.from);
    const auto tit = nodeIndex_.find(e.to);
    if (fit == nodeIndex_.end() || tit == nodeIndex_.end()) continue;
    const std::string a = graph_.nodes[fit->second].module;
    const std::string b = graph_.nodes[tit->second].module;
    if (a == b) continue;
    dirEdges[{a, b}] += 1;
  }

  // 按文件数取前 maxNodes 个目录
  std::vector<std::pair<std::string, int>> dirs(dirFileCount.begin(), dirFileCount.end());
  std::sort(dirs.begin(), dirs.end(), [](const auto& a, const auto& b) {
    return a.second != b.second ? a.second > b.second : a.first < b.first;
  });
  if (dirs.size() > maxNodes) dirs.resize(maxNodes);
  std::set<std::string> kept;
  for (const auto& d : dirs) {
    kept.insert(d.first);
    Node n;
    n.id = "dir:" + d.first;
    n.kind = NodeKind::File;
    n.name = d.first;
    n.module = d.first;
    n.detail = std::to_string(d.second) + " 个文件";
    n.precision = Precision::Approximate;
    out.nodes.push_back(n);
  }
  for (const auto& kv : dirEdges) {
    if (!kept.count(kv.first.first) || !kept.count(kv.first.second)) continue;
    if (kv.first.first == kv.first.second) continue;
    Edge e;
    e.from = "dir:" + kv.first.first;
    e.to = "dir:" + kv.first.second;
    e.kind = EdgeKind::Includes;
    e.precision = Precision::Approximate;
    out.edges.push_back(e);
  }
  return out;
}

std::vector<std::string> Session::dependentsOf(const std::string& rel) const {
  std::vector<std::string> out;
  const std::string id = makeNodeId(NodeKind::File, rel);
  auto it = inEdges_.find(id);
  if (it == inEdges_.end()) return out;
  for (size_t idx : it->second) {
    const Node& n = graph_.nodes[idx];
    if (n.kind == NodeKind::File) out.push_back(n.file.empty() ? n.name : n.file);
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

// ---------------------------- 序列化 ----------------------------

json::Value Session::graphToJson(const Graph& g) const {
  json::Value root = json::Value::makeObject();
  json::Value nodes = json::Value::makeArray({});
  for (const Node& n : g.nodes) {
    json::Value o = json::Value::makeObject();
    o.set("id", json::Value::makeString(n.id));
    o.set("kind", json::Value::makeString(toString(n.kind)));
    o.set("name", json::Value::makeString(n.name));
    o.set("file", json::Value::makeString(n.file));
    o.set("line", json::Value::makeInt(n.line));
    o.set("column", json::Value::makeInt(n.column));
    o.set("module", json::Value::makeString(n.module));
    o.set("detail", json::Value::makeString(n.detail));
    o.set("precision", json::Value::makeString(toString(n.precision)));
    o.set("external", json::Value::makeBool(n.external));
    o.set("declaration", json::Value::makeBool(n.declaration));
    o.set("inDegree", json::Value::makeInt(n.inDegree));
    o.set("outDegree", json::Value::makeInt(n.outDegree));
    nodes.arrayValue.push_back(std::move(o));
  }
  json::Value edges = json::Value::makeArray({});
  for (const Edge& e : g.edges) {
    json::Value o = json::Value::makeObject();
    o.set("from", json::Value::makeString(e.from));
    o.set("to", json::Value::makeString(e.to));
    o.set("kind", json::Value::makeString(toString(e.kind)));
    o.set("precision", json::Value::makeString(toString(e.precision)));
    o.set("file", json::Value::makeString(e.file));
    o.set("line", json::Value::makeInt(e.line));
    edges.arrayValue.push_back(std::move(o));
  }
  root.set("nodes", std::move(nodes));
  root.set("edges", std::move(edges));
  return root;
}

json::Value Session::statsToJson() const {
  json::Value o = json::Value::makeObject();
  o.set("root", json::Value::makeString(stats_.root));
  o.set("engineVersion", json::Value::makeString(stats_.engineVersion));
  o.set("fileCount", json::Value::makeInt(stats_.fileCount));
  o.set("symbolCount", json::Value::makeInt(stats_.symbolCount));
  o.set("edgeCount", json::Value::makeInt(stats_.edgeCount));
  o.set("unresolvedRefs", json::Value::makeInt(stats_.unresolvedRefs));
  o.set("skippedFiles", json::Value::makeInt(stats_.skippedFiles));
  o.set("exactNodes", json::Value::makeInt(stats_.exactNodes));
  o.set("approxNodes", json::Value::makeInt(stats_.approxNodes));
  o.set("exactIncludeEdges", json::Value::makeInt(stats_.exactIncludeEdges));
  o.set("approxIncludeEdges", json::Value::makeInt(stats_.approxIncludeEdges));
  o.set("compileCommandsFound", json::Value::makeBool(stats_.compileCommandsFound));
  o.set("compileCommandsPath", json::Value::makeString(stats_.compileCommandsPath));
  o.set("compileCommandEntries", json::Value::makeInt(stats_.compileCommandEntries));
  o.set("libclangAvailable", json::Value::makeBool(stats_.libclangAvailable));
  o.set("elapsedMs", json::Value::makeNumber(stats_.elapsedMs));
  o.set("precision", json::Value::makeString(stats_.libclangAvailable ? "exact" : "approx"));
  json::Value nk = json::Value::makeObject();
  for (const auto& kv : stats_.nodeKindCounts) nk.set(kv.first, json::Value::makeInt(kv.second));
  json::Value ek = json::Value::makeObject();
  for (const auto& kv : stats_.edgeKindCounts) ek.set(kv.first, json::Value::makeInt(kv.second));
  o.set("nodeKindCounts", std::move(nk));
  o.set("edgeKindCounts", std::move(ek));
  json::Value warns = json::Value::makeArray({});
  for (const std::string& w : stats_.warnings) warns.arrayValue.push_back(json::Value::makeString(w));
  o.set("warnings", std::move(warns));
  return o;
}

std::string Session::graphToDot(const Graph& g) const {
  std::ostringstream oss;
  oss << "digraph DepScan {\n";
  oss << "  rankdir=LR;\n  node [shape=box, fontname=\"Segoe UI\"];\n";
  for (const Node& n : g.nodes) {
    oss << "  \"" << n.id << "\" [label=\"" << n.name << "\"";
    if (n.external) oss << ", style=dashed";
    oss << "];\n";
  }
  for (const Edge& e : g.edges) {
    oss << "  \"" << e.from << "\" -> \"" << e.to << "\" [label=\"" << toString(e.kind) << "\"";
    if (e.precision == Precision::Approximate) oss << ", style=dotted";
    oss << "];\n";
  }
  oss << "}\n";
  return oss.str();
}

std::string Session::graphToMermaid(const Graph& g) const {
  std::ostringstream oss;
  oss << "graph LR\n";
  auto safe = [](const std::string& s) {
    std::string out;
    for (char c : s) {
      switch (c) {
        case '"': case '(': case ')': case '<': case '>': case '[': case ']':
        case '#': case '{': case '}': case '|': case ';': case '\\':
          out.push_back('_');
          break;
        default:
          out.push_back(c);
      }
    }
    return out;
  };
  std::map<std::string, std::string> alias;
  int k = 0;
  for (const Node& n : g.nodes) {
    const std::string a = "n" + std::to_string(k++);
    alias[n.id] = a;
    oss << "  " << a << "[\"" << safe(n.name) << "\"]\n";
  }
  for (const Edge& e : g.edges) {
    oss << "  " << alias[e.from] << " -->|" << toString(e.kind) << "| " << alias[e.to] << "\n";
  }
  return oss.str();
}

// ---------------------------- 磁盘缓存 ----------------------------
// V1 文本格式（每行一条记录，字段以制表符分隔，字段内转义 \\ \t \n）：
//   V<TAB>1<TAB><root>
//   F<TAB>rel<TAB>mtimeMs<TAB>size<TAB>lineCount<TAB>fromCompileCommand
//   S<TAB>kind<TAB>line<TAB>col<TAB>name<TAB>qualified<TAB>decl<TAB>signature
//   R<TAB>kind<TAB>line<TAB>name
//   I<TAB>line<TAB>target
// 目的：二次启动只重算 mtime/size 变化的文件。

bool Session::saveCache(const std::string& path) const {
  std::string out;
  out.reserve(1 << 20);
  out += "V\t1\t";
  out += esc(root_);
  out += "\n";
  for (const auto& kv : files_) {
    const FileAnalysis& fa = kv.second;
    out += "F\t" + esc(fa.file) + "\t" + std::to_string(fa.mtimeMs) + "\t" +
           std::to_string(fa.size) + "\t" + std::to_string(fa.lineCount) + "\t" +
           (fa.fromCompileCommand ? "1" : "0") + "\n";
    for (const SymbolDef& d : fa.symbols) {
      out += "S\t" + std::string(toString(d.kind)) + "\t" + std::to_string(d.line) + "\t" +
             std::to_string(d.column) + "\t" + esc(d.name) + "\t" + esc(d.qualifiedName) + "\t" +
             (d.declaration ? "1" : "0") + "\t" + esc(d.signature) + "\n";
    }
    for (const PendingRef& r : fa.refs) {
      out += "R\t" + std::string(toString(r.kind)) + "\t" + std::to_string(r.line) + "\t" +
             esc(r.fromId) + "\t" + esc(r.name) + "\n";
    }
    for (const auto& inc : fa.includes) {
      out += "I\t" + std::to_string(inc.second) + "\t" + esc(inc.first) + "\n";
    }
  }
  return util::writeFile(path, out);
}

bool Session::loadCache(const std::string& path) {
  const std::string text = util::readFile(path);
  if (text.empty()) return false;
  files_.clear();
  FileAnalysis* cur = nullptr;
  size_t pos = 0;
  bool headerOk = false;
  while (pos <= text.size()) {
    const size_t eol = text.find('\n', pos);
    const std::string line = (eol == std::string::npos) ? text.substr(pos) : text.substr(pos, eol - pos);
    pos = (eol == std::string::npos) ? text.size() + 1 : eol + 1;
    if (line.empty()) continue;
    const std::vector<std::string> f = splitTab(line);
    if (f.empty()) continue;
    if (f[0] == "V") {
      if (f.size() < 3 || unesc(f[2]) != root_) return false;  // 缓存属于别的项目
      headerOk = true;
      continue;
    }
    if (!headerOk) return false;
    if (f[0] == "F" && f.size() >= 6) {
      FileAnalysis fa;
      fa.file = unesc(f[1]);
      fa.mtimeMs = std::strtoll(f[2].c_str(), nullptr, 10);
      fa.size = std::strtoll(f[3].c_str(), nullptr, 10);
      fa.lineCount = std::atoi(f[4].c_str());
      fa.fromCompileCommand = f[5] == "1";
      auto res = files_.insert({fa.file, std::move(fa)});
      cur = &res.first->second;
    } else if (f[0] == "S" && f.size() >= 8 && cur) {
      SymbolDef d;
      NodeKind k = NodeKind::Unknown;
      if (!parseNodeKind(f[1], k)) continue;
      d.kind = k;
      d.line = std::atoi(f[2].c_str());
      d.column = std::atoi(f[3].c_str());
      d.name = unesc(f[4]);
      d.qualifiedName = unesc(f[5]);
      d.declaration = f[6] == "1";
      d.signature = unesc(f[7]);
      d.file = cur->file;
      d.id = makeNodeId(d.kind, d.qualifiedName);
      cur->symbols.push_back(std::move(d));
    } else if (f[0] == "R" && f.size() >= 5 && cur) {
      PendingRef r;
      EdgeKind k = EdgeKind::Refs;
      if (!parseEdgeKind(f[1], k)) continue;
      r.kind = k;
      r.line = std::atoi(f[2].c_str());
      r.fromId = unesc(f[3]);
      r.name = unesc(f[4]);
      r.file = cur->file;
      cur->refs.push_back(std::move(r));
    } else if (f[0] == "I" && f.size() >= 3 && cur) {
      cur->includes.emplace_back(unesc(f[2]), std::atoi(f[1].c_str()));
    }
  }
  return !files_.empty();
}

}  // namespace depscan
