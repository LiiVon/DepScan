#include "depscan/checks.hpp"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "depscan/util.hpp"

namespace depscan {
namespace {

// ── 目录间依赖图：把跨目录的 includes 边收拢成「目录 → 目录」的有向图 ──

struct DirGraph {
  std::vector<std::string> names;                         // 目录名（索引即顶点号）
  std::unordered_map<std::string, int> index;             // 目录名 → 顶点号
  std::vector<std::vector<int>> out;                      // 邻接表
  // 每条「目录对依赖」的详情：代表边（用来定位诊断）+ 边数
  std::unordered_map<long long, std::pair<std::string, int>> arcFirst;  // key = a*N+b
  std::unordered_map<long long, int> arcCount;

  int intern(const std::string& dir) {
    const auto it = index.find(dir);
    if (it != index.end()) return it->second;
    const int id = static_cast<int>(names.size());
    names.push_back(dir);
    out.emplace_back();
    index.emplace(dir, id);
    return id;
  }
};

long long arcKey(int a, int b, int width) { return static_cast<long long>(a) * width + b; }

// 代表边优先选「从头文件出发」的那条：头文件引到别的层，会把问题传染给每个包含它的人，
// 比一个 .cpp 里引一下更需要先看。
bool looksLikeHeader(const std::string& rel) {
  static const char* kExt[] = {".h", ".hpp", ".hh", ".hxx", ".inl"};
  for (const char* e : kExt) {
    const size_t n = std::char_traits<char>::length(e);
    if (rel.size() > n && rel.compare(rel.size() - n, n, e) == 0) return true;
  }
  return false;
}

// 只收「项目内、两端都解析到了具体文件」的边：解析不到的边最多漏报，不会误报
DirGraph buildDirGraph(const Graph& g) {
  DirGraph dg;
  std::unordered_map<std::string, size_t> nodeIndex;
  nodeIndex.reserve(g.nodes.size() * 2);
  for (size_t i = 0; i < g.nodes.size(); ++i) nodeIndex.emplace(g.nodes[i].id, i);

  const int width = static_cast<int>(g.nodes.size()) + 1;
  for (const Edge& e : g.edges) {
    if (e.kind != EdgeKind::Includes) continue;
    const auto ia = nodeIndex.find(e.from);
    const auto ib = nodeIndex.find(e.to);
    if (ia == nodeIndex.end() || ib == nodeIndex.end()) continue;
    const Node& a = g.nodes[ia->second];
    const Node& b = g.nodes[ib->second];
    if (a.kind != NodeKind::File || b.kind != NodeKind::File) continue;
    if (a.external || b.external || a.file.empty() || b.file.empty()) continue;
    std::string dirA = util::dirName(a.file);
    std::string dirB = util::dirName(b.file);
    if (dirA.empty()) dirA = ".";
    if (dirB.empty()) dirB = ".";
    // 同一目录内部互相 include 不算问题：头文件相互引用在 C++ 里太常见了
    if (dirA == dirB) continue;

    const int va = dg.intern(dirA);
    const int vb = dg.intern(dirB);
    // 邻接表去重：同一对目录可能有很多条边，但图里只该有一条弧
    if (std::find(dg.out[va].begin(), dg.out[va].end(), vb) == dg.out[va].end()) {
      dg.out[va].push_back(vb);
    }
    const long long key = arcKey(va, vb, width);
    auto& rep = dg.arcFirst[key];
    // 代表边优先留「从头文件出发」的那条：头文件引到别的层会把问题传染给每个包含者
    if (rep.first.empty() || (looksLikeHeader(a.file) && !looksLikeHeader(rep.first))) {
      rep = std::make_pair(a.file, e.line);
    }
    dg.arcCount[key] += 1;
  }
  return dg;
}

// ── Tarjan 强连通分量：环 = 分量里有 ≥2 个目录 ──

class Tarjan {
 public:
  explicit Tarjan(const std::vector<std::vector<int>>& out) : out_(out) {}

  std::vector<int> run() {
    const int n = static_cast<int>(out_.size());
    index_.assign(n, -1);
    low_.assign(n, 0);
    onStack_.assign(n, 0);
    comp_.assign(n, -1);
    for (int v = 0; v < n; ++v) {
      if (index_[v] < 0) visit(v);
    }
    return comp_;
  }

  int componentCount() const { return compCount_; }

 private:
  void visit(int v) {
    index_[v] = low_[v] = counter_++;
    stack_.push_back(v);
    onStack_[v] = 1;
    for (const int w : out_[v]) {
      if (index_[w] < 0) {
        visit(w);
        low_[v] = std::min(low_[v], low_[w]);
      } else if (onStack_[w]) {
        low_[v] = std::min(low_[v], index_[w]);
      }
    }
    if (low_[v] != index_[v]) return;
    for (;;) {
      const int w = stack_.back();
      stack_.pop_back();
      onStack_[w] = 0;
      comp_[w] = compCount_;
      if (w == v) break;
    }
    ++compCount_;
  }

  const std::vector<std::vector<int>>& out_;
  std::vector<int> index_;
  std::vector<int> low_;
  std::vector<int> onStack_;
  std::vector<int> comp_;
  std::vector<int> stack_;
  int counter_ = 0;
  int compCount_ = 0;
};

}  // namespace

std::vector<Violation> findViolations(const Graph& g, int maxItems, int& total) {
  std::unordered_map<std::string, size_t> nodeIndex;
  nodeIndex.reserve(g.nodes.size() * 2);
  for (size_t i = 0; i < g.nodes.size(); ++i) nodeIndex.emplace(g.nodes[i].id, i);

  std::vector<Violation> found;

  // ── 1. 公开头文件引用了内部实现 ──
  // 「同一个公开头文件里用了同一个私有类型好几处」只报一次（按 file:line 取最靠前的）
  std::unordered_set<std::string> leakSeen;
  for (const Edge& e : g.edges) {
    if (e.kind != EdgeKind::Includes && e.kind != EdgeKind::Uses) continue;
    const auto ia = nodeIndex.find(e.from);
    const auto ib = nodeIndex.find(e.to);
    if (ia == nodeIndex.end() || ib == nodeIndex.end()) continue;
    const Node& a = g.nodes[ia->second];
    const Node& b = g.nodes[ib->second];
    if (a.kind != NodeKind::File) continue;   // 这两类边都从「文件」出发
    if (a.external || b.external) continue;
    if (b.file.empty() || a.file == b.file) continue;
    if (!isPublicApiFile(a.file)) continue;   // 起点不是公开面：内部实现自己组合自己，正常
    if (isPublicApiFile(b.file)) continue;    // 终点也是公开面：公开头文件之间互引，正常

    const std::string key = a.file + "\n" + b.file;
    if (!leakSeen.insert(key).second) continue;
    Violation v;
    v.kind = "public-api-leak";
    v.fromFile = a.file;
    v.fromLine = e.line;
    v.toFile = b.file;
    found.push_back(std::move(v));
  }

  // ── 2. 目录之间互相依赖成环 ──
  DirGraph dg = buildDirGraph(g);
  if (!dg.names.empty()) {
    const int width = static_cast<int>(g.nodes.size()) + 1;
    std::vector<int> comp = Tarjan(dg.out).run();
    const int compCount = *std::max_element(comp.begin(), comp.end()) + 1;
    std::vector<std::vector<int>> members(compCount);
    for (size_t v = 0; v < comp.size(); ++v) members[comp[v]].push_back(static_cast<int>(v));

    for (const std::vector<int>& group : members) {
      if (group.size() < 2) continue;   // 单目录自环不算（跨目录才谈得上分层）
      std::unordered_set<int> inGroup(group.begin(), group.end());
      Violation v;
      v.kind = "directory-cycle";
      v.fromFile.clear();
      v.fromLine = 0;
      for (const int a : group) v.dirs.push_back(dg.names[a]);
      std::sort(v.dirs.begin(), v.dirs.end());
      // 代表边：分量内部最靠前的那条 include（诊断要能跳到源码）
      for (const int a : group) {
        for (const int b : dg.out[a]) {
          if (!inGroup.count(b)) continue;
          const long long key = arcKey(a, b, width);
          const auto it = dg.arcFirst.find(key);
          if (it == dg.arcFirst.end()) continue;
          v.edgeCount += dg.arcCount[key];
          // 弧的代表边已经优先选过头文件那条了，这里只按 file:line 取最靠前的
          //（完全确定，否则没法写断言）
          if (v.fromFile.empty() ||
              std::make_pair(it->second.first, it->second.second) <
                  std::make_pair(v.fromFile, v.fromLine)) {
            v.fromFile = it->second.first;
            v.fromLine = it->second.second;
          }
        }
      }
      if (v.fromFile.empty()) continue;   // 理论上不会：有环就一定有环内的边
      found.push_back(std::move(v));
    }
  }

  // 顺序固定：先文件级（泄漏），再目录级（环），同类按 file:line
  std::sort(found.begin(), found.end(), [](const Violation& a, const Violation& b) {
    if (a.kind != b.kind) return a.kind < b.kind;
    if (a.fromFile != b.fromFile) return a.fromFile < b.fromFile;
    if (a.fromLine != b.fromLine) return a.fromLine < b.fromLine;
    return a.toFile < b.toFile;
  });

  total = static_cast<int>(found.size());
  if (maxItems > 0 && static_cast<int>(found.size()) > maxItems) {
    found.resize(static_cast<size_t>(maxItems));
  }
  return found;
}

}  // namespace depscan
