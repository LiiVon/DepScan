#include "depscan/route.hpp"

#include <algorithm>
#include <deque>
#include <set>
#include <unordered_map>
#include <unordered_set>

namespace depscan {
namespace {

// 常见的程序入口。限定名（demo::main）取最后一段再比。
const char* kEntryNames[] = {"main",   "wmain",  "WinMain",
                             "wWinMain", "DllMain", "mainCRTStartup", "wmainCRTStartup"};

bool matchesEntry(const std::string& name) {
  const size_t p = name.rfind("::");
  const std::string tail = p == std::string::npos ? name : name.substr(p + 2);
  for (const char* e : kEntryNames) {
    if (tail == e) return true;
  }
  return false;
}

struct Child {
  size_t nodeIndex = 0;
  int line = 0;  // 调用点行号
};

// 候选列表上限：同名定义在真实项目里可能几十个（init / size / run 这种名字），
// 全塞进 JSON 既没用又拖慢。超出后总数仍然如实报出（candidateTotal）。
constexpr size_t kMaxCandidates = 20;

struct Frame {
  size_t node = 0;
  int parentOrder = 0;
  int depth = 0;
};

}  // namespace

std::string findEntryPoint(const Graph& g) {
  std::string fallback;
  for (const Node& n : g.nodes) {
    if (n.kind != NodeKind::Function) continue;
    if (!matchesEntry(n.name)) continue;
    // 优先项目内的真实定义（声明、外部符号都不是好的起点）
    if (!n.external && !n.declaration) return n.id;
    if (fallback.empty()) fallback = n.id;
  }
  return fallback;
}

// 光标位置 → 该处所属的函数。读代码时的直觉是「我在这个函数里」，
// 所以从光标取起点时优先给函数，而不是最近的任意符号。
std::string functionAtLocation(const Graph& g, const std::string& relFile, int line) {
  std::string fn;
  int fnLine = -1;
  std::string other;
  int otherLine = -1;
  std::string fileNode;
  for (const Node& n : g.nodes) {
    if (n.file != relFile) continue;
    if (n.line > line) continue;
    if (n.kind == NodeKind::File) {
      if (fileNode.empty()) fileNode = n.id;
      continue;
    }
    if (n.kind == NodeKind::Target) continue;
    if (n.kind == NodeKind::Function) {
      if (n.line >= fnLine) {
        fnLine = n.line;
        fn = n.id;
      }
      continue;
    }
    if (n.line >= otherLine) {
      otherLine = n.line;
      other = n.id;
    }
  }
  if (!fn.empty()) return fn;
  if (!other.empty()) return other;
  return fileNode;
}

RouteResult computeRoute(const Graph& g, const RouteOptions& opt) {
  RouteResult r;

  const std::string startId = opt.from.empty() ? findEntryPoint(g) : opt.from;
  if (startId.empty()) {
    r.error = "找不到入口函数（main / WinMain / DllMain），请显式指定起点。";
    return r;
  }

  std::unordered_map<std::string, size_t> index;
  index.reserve(g.nodes.size() * 2);
  for (size_t i = 0; i < g.nodes.size(); ++i) index.emplace(g.nodes[i].id, i);

  const auto startIt = index.find(startId);
  if (startIt == index.end()) {
    r.error = "找不到起点节点：" + startId;
    return r;
  }

  std::set<EdgeKind> allowed(opt.kinds.begin(), opt.kinds.end());
  if (allowed.empty()) allowed.insert(EdgeKind::Calls);

  std::unordered_map<std::string, std::vector<Child>> children;
  for (const Edge& e : g.edges) {
    if (!allowed.count(e.kind)) continue;
    const auto to = index.find(e.to);
    if (to == index.end()) continue;
    children[e.from].push_back({to->second, e.line});
  }
  // 按调用点行号排序：让阅读顺序**跟随源码本身的书写顺序**，而不是随机的图顺序。
  // 行号相同时按名字，保证结果完全确定（测试才能打靶断言）。
  for (auto& kv : children) {
    std::sort(kv.second.begin(), kv.second.end(), [&](const Child& a, const Child& b) {
      if (a.line != b.line) return a.line < b.line;
      return g.nodes[a.nodeIndex].name < g.nodes[b.nodeIndex].name;
    });
  }

  // 同名**定义**索引。
  // 没有 compile_commands 时调用边是按名字消解的，所以在「项目里还有别的同名定义」时
  // 就可能挑错了那一个。把这些同名定义列出来交给用户核对 / 切换，而不是替他挑一个然后假装确定。
  //
  // 只收定义、不收声明：`class Engine { void run(); };` 的声明不是「读代码要去的另一处」，
  // 收进来会让每个成员函数都变成「有候选」，把信号淹掉。
  std::unordered_map<std::string, std::vector<size_t>> defsByName;
  for (size_t i = 0; i < g.nodes.size(); ++i) {
    const Node& n = g.nodes[i];
    if (n.kind != NodeKind::Function) continue;
    if (n.external || n.declaration) continue;
    defsByName[n.name].push_back(i);
  }
  for (auto& kv : defsByName) {
    std::sort(kv.second.begin(), kv.second.end(), [&](size_t a, size_t b) {
      const Node& x = g.nodes[a];
      const Node& y = g.nodes[b];
      if (x.file != y.file) return x.file < y.file;
      if (x.line != y.line) return x.line < y.line;
      return x.id < y.id;
    });
  }

  // 人工纠偏：把某个调用点上「按名字消解」的结果换成用户选的那个同名定义。
  // 选中的节点即使原本不是该父节点的子节点（图里解析到了别处）也照走 —— 这正是纠偏的意义；
  // 行号沿用原调用点，所以排序与遍历策略的行为完全不变，只有「走到哪个节点」变了。
  const auto applyOverrides = [&](size_t parentNode, const std::vector<Child>& in) -> std::vector<Child> {
    if (opt.overrides.empty()) return in;
    const std::string& pid = g.nodes[parentNode].id;
    std::unordered_map<std::string, std::string> picked;  // 简单名 → 选中的节点 id
    for (const Child& c : in) {
      const auto it = opt.overrides.find(pid + "|" + g.nodes[c.nodeIndex].name);
      if (it != opt.overrides.end() && !it->second.empty()) {
        picked[g.nodes[c.nodeIndex].name] = it->second;
      }
    }
    if (picked.empty()) return in;

    std::vector<Child> out;
    out.reserve(in.size());
    std::unordered_set<std::string> settled;
    for (const Child& c : in) {
      const std::string& name = g.nodes[c.nodeIndex].name;
      const auto p = picked.find(name);
      if (p == picked.end()) {
        out.push_back(c);
        continue;
      }
      if (!settled.insert(name).second) continue;  // 同名只保留一份
      const auto chosen = index.find(p->second);
      if (chosen == index.end()) {
        out.push_back(c);  // 选了个图里不存在的 id：忽略这次纠偏
        continue;
      }
      out.push_back({chosen->second, c.line});
    }
    return out;
  };

  const int maxSteps = std::max(1, std::min(opt.maxSteps, 100000));
  const int maxDepth = std::max(0, std::min(opt.maxDepth, 64));

  std::unordered_set<size_t> visited;
  std::set<std::string> seenFiles;
  std::vector<int> orderByNodeIndex;  // 仅用于调试/回查，可为空

  const auto childrenOf = [&](size_t nodeIndex) -> const std::vector<Child>* {
    const auto it = children.find(g.nodes[nodeIndex].id);
    return it == children.end() ? nullptr : &it->second;
  };

  // 出队（或出栈）一个节点时的统一处理：登记一步，并把子节点压回去
  const auto emit = [&](const Frame& f, std::vector<Frame>& pending, bool reverse) -> int {
    if (visited.count(f.node)) return 0;
    visited.insert(f.node);

    RouteStep s;
    s.order = static_cast<int>(r.steps.size()) + 1;
    s.parent = f.parentOrder;
    s.depth = f.depth;
    s.nodeIndex = f.node;
    const std::string& file = g.nodes[f.node].file;
    if (seenFiles.insert(file).second) s.newFile = true;
    r.steps.push_back(s);
    r.maxReachedDepth = std::max(r.maxReachedDepth, f.depth);

    if (f.depth >= maxDepth) return 0;
    const std::vector<Child>* kids = childrenOf(f.node);
    if (!kids) return 0;

    std::vector<Child> source;
    source.reserve(kids->size());
    for (const Child& c : *kids) {
      if (opt.projectOnly && g.nodes[c.nodeIndex].external) continue;
      source.push_back(c);
    }
    const std::vector<Child> usable = applyOverrides(f.node, source);
    for (size_t i = 0; i < usable.size(); ++i) {
      const Child& c = reverse ? usable[usable.size() - 1 - i] : usable[i];
      pending.push_back({c.nodeIndex, s.order, f.depth + 1});
    }
    return static_cast<int>(usable.size());
  };

  const size_t startNode = startIt->second;
  if (opt.depthFirst) {
    std::vector<Frame> stack;
    stack.push_back({startNode, 0, 0});
    while (!stack.empty() && static_cast<int>(r.steps.size()) < maxSteps) {
      const Frame f = stack.back();
      stack.pop_back();
      // 倒着压栈，保证第一个子节点最先被处理（真正的先序遍历）
      emit(f, stack, /*reverse=*/true);
    }
  } else {
    std::deque<Frame> queue;
    queue.push_back({startNode, 0, 0});
    while (!queue.empty() && static_cast<int>(r.steps.size()) < maxSteps) {
      const Frame f = queue.front();
      queue.pop_front();
      std::vector<Frame> pending;
      emit(f, pending, /*reverse=*/false);
      for (const Frame& p : pending) queue.push_back(p);
    }
  }

  // 未展开的前沿：被访问节点的子节点里，还没进过清单的那些
  {
    std::unordered_set<size_t> counted;
    std::set<std::string> frontierFiles;
    for (const RouteStep& s : r.steps) {
      const std::vector<Child>* kids = childrenOf(s.nodeIndex);
      if (!kids) continue;
      for (const Child& c : *kids) {
        if (visited.count(c.nodeIndex)) continue;
        if (opt.projectOnly && g.nodes[c.nodeIndex].external) continue;
        if (!counted.insert(c.nodeIndex).second) continue;
        frontierFiles.insert(g.nodes[c.nodeIndex].file);
      }
    }
    r.frontierNodes = static_cast<int>(counted.size());
    r.frontierFiles = static_cast<int>(frontierFiles.size());
    r.truncated = r.frontierNodes > 0;
  }

  // 候选：这一步的名字在项目里还有别的定义 → 按名字消解可能选错了那一个。
  // 判定依据是「图里别处还有同名定义」，而不是「同一个父节点下有两个同名子节点」——
  // 后者在真实项目里几乎不会发生，会出错的恰恰是前者。
  for (RouteStep& s : r.steps) {
    const Node& n = g.nodes[s.nodeIndex];
    s.bodyLines = n.bodyLines;
    if (n.kind != NodeKind::Function) continue;
    const auto it = defsByName.find(n.name);
    if (it == defsByName.end()) continue;
    for (size_t i : it->second) {
      if (i == s.nodeIndex) continue;
      ++s.candidateTotal;
      if (s.candidates.size() < kMaxCandidates) s.candidates.push_back(i);
    }
    s.ambiguous = s.candidateTotal > 0;
  }

  // ---------- 降噪：折叠「琐碎」步骤 ----------
  // 一个 3 行的 getter 或纯转发函数出现在阅读清单里，对读者只是噪音 ——
  // 你要读的是它调用的那个，不是它本身。
  //
  // 判定（两个条件都满足才算）：
  //   1. 有函数体，且行数 <= trivialBodyLines（默认 3）—— **只认定义**：
  //      声明没有体（bodyLines == 0），判断不了，一律保留；
  //   2. 这个函数自己只调了 <= 1 处（getter / 纯转发就是这个形状）。
  //      调用处数直接数图上的出边，是它的真实行为，与它在路线里的位置无关。
  //
  // 折叠方式沿用文件级折叠那套：把子步骤接到「最近的、还被保留的祖先」上，
  // 并把它自己的名字记到那个祖先的 skipped 里 —— 折叠 ≠ 假装它不存在。
  if (opt.skipTrivial && !r.steps.empty()) {
    const auto callKids = [&](size_t nodeIndex) -> size_t {
      const auto it = children.find(g.nodes[nodeIndex].id);
      return it == children.end() ? 0 : it->second.size();
    };
    const auto trivial = [&](const RouteStep& s) {
      if (s.parent == 0) return false;  // 起点永远保留
      const Node& n = g.nodes[s.nodeIndex];
      if (n.bodyLines <= 0 || n.bodyLines > opt.trivialBodyLines) return false;
      return callKids(s.nodeIndex) <= 1;
    };

    std::vector<int> stepByOrder(r.steps.size() + 1, -1);
    for (size_t i = 0; i < r.steps.size(); ++i) stepByOrder[r.steps[i].order] = static_cast<int>(i);
    const auto nearestKept = [&](int parentOrder) {
      int p = parentOrder;
      while (p != 0) {
        const int idx = stepByOrder[p];
        if (idx >= 0 && !trivial(r.steps[idx])) break;
        p = idx >= 0 ? r.steps[idx].parent : 0;
      }
      return p;
    };

    // 被折叠的步骤 → 挂到最近的保留祖先上
    std::unordered_map<int, std::vector<std::string>> skippedByAnchor;
    bool anySkipped = false;
    for (const RouteStep& s : r.steps) {
      if (!trivial(s)) continue;
      anySkipped = true;
      const int anchor = nearestKept(s.parent);
      skippedByAnchor[anchor].push_back(g.nodes[s.nodeIndex].name);
    }

    if (anySkipped) {
      std::vector<RouteStep> kept;
      std::unordered_map<int, int> newOrderByOld;
      for (const RouteStep& s : r.steps) {
        if (trivial(s)) continue;
        const int p = nearestKept(s.parent);
        RouteStep t = s;
        t.parent = p == 0 ? 0 : newOrderByOld[p];
        t.order = static_cast<int>(kept.size()) + 1;
        const auto sk = skippedByAnchor.find(s.order);  // 按**旧** order 取自己的那份
        if (sk != skippedByAnchor.end()) {
          t.skipped = sk->second;
          r.skippedCount += static_cast<int>(sk->second.size());
        }
        newOrderByOld[s.order] = t.order;
        kept.push_back(t);
      }
      r.steps = std::move(kept);
    }
  }

  // 函数级 → 文件级：只保留每个文件首次进入的那一步，
  // 并把它的 parent 接到「最近的、还被保留的祖先」上，避免出现悬空父节点。
  // 放在降噪之后：否则一个 1 行的 getter 可能让某个文件「因为被经过」而留在文件级清单里。
  if (opt.groupByFile && !r.steps.empty()) {
    std::vector<RouteStep> kept;
    std::vector<int> stepByOrder(r.steps.size() + 1, -1);
    for (size_t i = 0; i < r.steps.size(); ++i) stepByOrder[r.steps[i].order] = static_cast<int>(i);

    std::unordered_map<int, int> newOrderByOld;  // 旧 order -> 新 order
    for (const RouteStep& s : r.steps) {
      if (!s.newFile) continue;
      int p = s.parent;
      while (p != 0) {
        const int idx = stepByOrder[p];
        if (idx >= 0 && r.steps[idx].newFile) break;
        p = idx >= 0 ? r.steps[idx].parent : 0;
      }
      RouteStep t = s;
      t.parent = p == 0 ? 0 : newOrderByOld[p];
      t.order = static_cast<int>(kept.size()) + 1;
      newOrderByOld[s.order] = t.order;
      kept.push_back(t);
    }
    r.steps = std::move(kept);
  }

  return r;
}

json::Value routeToJson(const Graph& g, const RouteResult& r) {
  json::Value out = json::Value::makeObject();
  out.set("truncated", json::Value::makeBool(r.truncated));
  out.set("frontierNodes", json::Value::makeInt(r.frontierNodes));
  out.set("frontierFiles", json::Value::makeInt(r.frontierFiles));
  out.set("maxReachedDepth", json::Value::makeInt(r.maxReachedDepth));
  out.set("skippedCount", json::Value::makeInt(r.skippedCount));

  json::Value steps = json::Value::makeArray({});
  for (const RouteStep& s : r.steps) {
    const Node& n = g.nodes[s.nodeIndex];
    json::Value o = json::Value::makeObject();
    o.set("order", json::Value::makeInt(s.order));
    o.set("parent", json::Value::makeInt(s.parent));
    o.set("depth", json::Value::makeInt(s.depth));
    o.set("newFile", json::Value::makeBool(s.newFile));
    o.set("ambiguous", json::Value::makeBool(s.ambiguous));
    o.set("id", json::Value::makeString(n.id));
    o.set("kind", json::Value::makeString(toString(n.kind)));
    o.set("name", json::Value::makeString(n.name));
    o.set("file", json::Value::makeString(n.file));
    o.set("line", json::Value::makeInt(n.line));
    o.set("column", json::Value::makeInt(n.column));
    o.set("module", json::Value::makeString(n.module));
    o.set("detail", json::Value::makeString(n.detail));
    o.set("external", json::Value::makeBool(n.external));
    o.set("precision", json::Value::makeString(toString(n.precision)));
    o.set("bodyLines", json::Value::makeInt(s.bodyLines));
    o.set("candidateTotal", json::Value::makeInt(s.candidateTotal));
    if (!s.skipped.empty()) {
      json::Value sk = json::Value::makeArray({});
      for (const std::string& name : s.skipped) sk.arrayValue.push_back(json::Value::makeString(name));
      o.set("skipped", std::move(sk));
    }
    if (!s.candidates.empty()) {
      json::Value cands = json::Value::makeArray({});
      for (size_t ci : s.candidates) {
        const Node& c = g.nodes[ci];
        json::Value co = json::Value::makeObject();
        co.set("id", json::Value::makeString(c.id));
        co.set("name", json::Value::makeString(c.name));
        co.set("file", json::Value::makeString(c.file));
        co.set("line", json::Value::makeInt(c.line));
        co.set("column", json::Value::makeInt(c.column));
        co.set("declaration", json::Value::makeBool(c.declaration));
        co.set("detail", json::Value::makeString(c.detail));
        cands.arrayValue.push_back(std::move(co));
      }
      o.set("candidates", std::move(cands));
    }
    steps.arrayValue.push_back(std::move(o));
  }
  out.set("steps", std::move(steps));
  return out;
}

}  // namespace depscan
