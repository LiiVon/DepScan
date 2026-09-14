// 阅读路线（Reading Route）：从入口函数出发，按调用关系给出一份**有序**的阅读清单。
//
// 和 subgraph 的本质区别：
//   subgraph 回答「和谁有关」—— 无序集合，可用于任意焦点
//   route    回答「先读什么、再读什么」—— 有序序列，必须从入口出发
// 两者不能互相替代：力导向图渲染的是关系，而这里的核心信息是「顺序」。
#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "depscan/json.hpp"
#include "depscan/types.hpp"

namespace depscan {

struct RouteOptions {
  // 起点节点 id；留空则自动寻找入口（main / wmain / WinMain / wWinMain / DllMain）
  std::string from;
  // false = 广度优先（先看骨架，适合第一次读一个大项目）
  // true  = 深度优先（先追一条调用链到深处，适合查一条具体流程）
  bool depthFirst = false;
  int maxSteps = 200;
  int maxDepth = 6;
  // 不进入项目外 / 未解析符号（否则走三步就全是 printf）
  bool projectOnly = true;
  // 每个文件只保留「首次进入」的那一步（函数级 → 文件级两个粒度）
  bool groupByFile = false;
  // 参与遍历的边类型，默认只跟调用关系
  std::vector<EdgeKind> kinds = {EdgeKind::Calls};
  // 人工纠偏：把某个调用点上「按名字消解」的结果换成同名候选中的另一个。
  //   key   = "<父节点 id>|<简单名>"   —— 用节点 id 而不是步号：
  //           步号会随纠偏本身变化（换了候选 → 后面的 order 全变），节点 id 不会。
  //   value = 选中的那个子节点 id（可为图里任意同名定义，不限于原来的那条边）
  std::unordered_map<std::string, std::string> overrides;
};

struct RouteStep {
  int order = 0;           // 1-based 步号，也就是「阅读顺序」
  int parent = 0;          // 上一步的 order；0 表示这是起点
  int depth = 0;           // 距离起点的跳数
  size_t nodeIndex = 0;    // 指向 Graph::nodes 的下标
  bool newFile = false;    // 这一步是首次进入该文件
  // 同一个简单名在项目里还有别的定义 —— 无 compile_commands 时调用边是按名字消解的，
  // 所以这一步可能是错边。candidates 就是「别的那些同名定义」，交给用户自己选。
  bool ambiguous = false;
  std::vector<size_t> candidates;  // 不含自己，按（文件, 行号）排序，已截断
  int candidateTotal = 0;          // 未截断的同名定义总数（不含自己）
};

struct RouteResult {
  std::vector<RouteStep> steps;
  bool truncated = false;  // 因为 maxSteps / maxDepth 被截断
  int frontierNodes = 0;   // 还没展开的节点数
  int frontierFiles = 0;   // 还没展开的节点涉及多少个文件
  int maxReachedDepth = 0;
  std::string error;       // 非空 = 失败
};

// 自动寻找程序入口；找不到返回空串
std::string findEntryPoint(const Graph& g);

// 光标位置（相对路径 + 行号）→ 该处「所属函数」的节点 id。
// 取同文件里行号 <= 给定行的最后一个函数节点；找不到函数时依次退回
// 「最近的其它符号」→「该文件节点」。都找不到返回空串。
// 读代码时的直觉是「我在这个函数里」，所以起点从光标取时优先给函数。
std::string functionAtLocation(const Graph& g, const std::string& relFile, int line);

RouteResult computeRoute(const Graph& g, const RouteOptions& opt);

json::Value routeToJson(const Graph& g, const RouteResult& r);

}  // namespace depscan
