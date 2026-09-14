// 阅读路线（Reading Route）：从入口函数出发，按调用关系给出一份**有序**的阅读清单。
//
// 和 subgraph 的本质区别：
//   subgraph 回答「和谁有关」—— 无序集合，可用于任意焦点
//   route    回答「先读什么、再读什么」—— 有序序列，必须从入口出发
// 两者不能互相替代：力导向图渲染的是关系，而这里的核心信息是「顺序」。
#pragma once

#include <string>
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
};

struct RouteStep {
  int order = 0;           // 1-based 步号，也就是「阅读顺序」
  int parent = 0;          // 上一步的 order；0 表示这是起点
  int depth = 0;           // 距离起点的跳数
  size_t nodeIndex = 0;    // 指向 Graph::nodes 的下标
  bool newFile = false;    // 这一步是首次进入该文件
  bool ambiguous = false;  // 有多个同名候选 —— 近似精度下按名字消解，可能是错边
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

RouteResult computeRoute(const Graph& g, const RouteOptions& opt);

json::Value routeToJson(const Graph& g, const RouteResult& r);

}  // namespace depscan
