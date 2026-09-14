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

    std::vector<const Child*> usable;
    usable.reserve(kids->size());
    for (const Child& c : *kids) {
      if (opt.projectOnly && g.nodes[c.nodeIndex].external) continue;
      usable.push_back(&c);
    }
    for (size_t i = 0; i < usable.size(); ++i) {
      const Child& c = reverse ? *usable[usable.size() - 1 - i] : *usable[i];
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

  // 同名兄弟 = 按名字消解出来的多个候选，可能走错边。标出来让用户自己判断。
  {
    std::unordered_map<int, std::vector<int>> byParent;  // parent -> step 下标
    for (size_t i = 0; i < r.steps.size(); ++i) byParent[r.steps[i].parent].push_back(static_cast<int>(i));
    for (const auto& kv : byParent) {
      std::unordered_map<std::string, std::vector<int>> byName;
      for (int i : kv.second) byName[g.nodes[r.steps[i].nodeIndex].name].push_back(i);
      for (const auto& n : byName) {
        if (n.second.size() < 2) continue;
        for (int i : n.second) r.steps[i].ambiguous = true;
      }
    }
  }

  // 函数级 → 文件级：只保留每个文件首次进入的那一步，
  // 并把它的 parent 接到「最近的、还被保留的祖先」上，避免出现悬空父节点。
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
    steps.arrayValue.push_back(std::move(o));
  }
  out.set("steps", std::move(steps));
  return out;
}

}  // namespace depscan
