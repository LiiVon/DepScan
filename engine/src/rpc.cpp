#include "depscan/rpc.hpp"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "depscan/analyzer.hpp"
#include "depscan/checks.hpp"
#include "depscan/json.hpp"
#include "depscan/route.hpp"
#include "depscan/scanner.hpp"
#include "depscan/session.hpp"
#include "depscan/util.hpp"

namespace depscan {

namespace {

std::mutex g_outMutex;
std::mutex g_sessionMutex;
std::atomic<bool> g_cancel{false};
std::atomic<bool> g_scanning{false};
std::atomic<bool> g_shutdown{false};

void writeValue(const json::Value& v) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  const std::string s = json::dump(v, false);
  std::fwrite(s.data(), 1, s.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void writeResult(long long id, json::Value result) {
  json::Value o = json::Value::makeObject();
  o.set("id", json::Value::makeInt(id));
  o.set("ok", json::Value::makeBool(true));
  o.set("result", std::move(result));
  writeValue(o);
}

void writeError(long long id, const std::string& message) {
  json::Value o = json::Value::makeObject();
  o.set("id", json::Value::makeInt(id));
  o.set("ok", json::Value::makeBool(false));
  json::Value err = json::Value::makeObject();
  err.set("message", json::Value::makeString(message));
  o.set("error", std::move(err));
  writeValue(o);
}

void writeProgress(int done, int total, const std::string& file) {
  json::Value o = json::Value::makeObject();
  o.set("method", json::Value::makeString("progress"));
  json::Value p = json::Value::makeObject();
  p.set("done", json::Value::makeInt(done));
  p.set("total", json::Value::makeInt(total));
  p.set("file", json::Value::makeString(file));
  o.set("params", std::move(p));
  writeValue(o);
}

void applyConfig(const json::Value& config, ScanRequest& req) {
  if (!config.isObject()) return;
  req.options.includes = config.getBool("includes", req.options.includes);
  req.options.calls = config.getBool("calls", req.options.calls);
  req.options.types = config.getBool("types", req.options.types);
  req.options.symbols = config.getBool("symbols", req.options.symbols);
  req.options.links = config.getBool("links", req.options.links);
  req.options.includeExternal = config.getBool("includeExternal", req.options.includeExternal);

  for (const std::string& p : config.getStringArray("includePaths")) req.options.includePaths.push_back(p);
  for (const std::string& p : config.getStringArray("systemIncludePaths")) {
    req.options.systemIncludePaths.push_back(p);
  }
  for (const std::string& d : config.getStringArray("defines")) req.options.defines.push_back(d);

  const double limit = config.getNumber("fileSizeLimitBytes", 0);
  if (limit > 0) req.options.fileSizeLimitBytes = static_cast<size_t>(limit);

  const double maxFiles = config.getNumber("maxFiles", 0);
  if (maxFiles > 0) req.maxFiles = static_cast<size_t>(maxFiles);

  req.threads = static_cast<int>(config.getNumber("threads", req.threads));
  const std::vector<std::string> inc = config.getStringArray("includeGlobs");
  if (!inc.empty()) req.includeGlobs = inc;
  const std::vector<std::string> exc = config.getStringArray("excludeGlobs");
  if (!exc.empty()) req.excludeGlobs = exc;
  req.cachePath = config.getString("cachePath", req.cachePath);
  req.useCache = config.getBool("useCache", req.useCache);
  req.forceFull = config.getBool("forceFull", req.forceFull);
  req.compileCommandsPath = config.getString("compileCommandsPath", req.compileCommandsPath);
}

// 在 focus 文件/行处定位「最内层」的符号节点（用于编辑器右键「查看依赖图」）
std::string focusNodeForLocation(const Session& session, const std::string& relFile, int line) {
  const Graph& g = session.graph();
  std::string best;
  int bestLine = -1;
  for (const Node& n : g.nodes) {
    if (n.kind == NodeKind::File || n.kind == NodeKind::Target) continue;
    if (n.file != relFile) continue;
    if (n.line <= line && n.line >= bestLine) {
      bestLine = n.line;
      best = n.id;
    }
  }
  if (!best.empty()) return best;
  for (const Node& n : g.nodes) {
    if (n.kind == NodeKind::File && n.file == relFile) return n.id;
  }
  return {};
}

json::Value buildSubgraphResult(const Session& session, const Graph& g, bool truncated) {
  json::Value out = json::Value::makeObject();
  out.set("graph", session.graphToJson(g));
  out.set("truncated", json::Value::makeBool(truncated));
  out.set("nodeCount", json::Value::makeInt(static_cast<long long>(g.nodes.size())));
  out.set("edgeCount", json::Value::makeInt(static_cast<long long>(g.edges.size())));
  return out;
}

json::Value handleScan(Session& session, const json::Value& params) {
  ScanRequest req;
  req.root = params.getString("root");
  req.options.fileSizeLimitBytes = 4ull * 1024 * 1024;
  req.excludeGlobs = params.getStringArray("excludeGlobs");
  applyConfig(params.find("config") ? *params.find("config") : json::Value{}, req);
  if (req.root.empty()) req.root = session.root();

  g_cancel.store(false);
  g_scanning.store(true);

  // 扫描在独立线程中进行，主线程继续读 stdin，从而支持 cancel / ping
  bool ok = false;
  std::string error;
  std::thread worker([&]() {
    // ⚠ 这里必须整体包住。这是**子线程**，任何逸出的异常都不会被
    //   主线程的 try/catch 接住，而是直接 std::terminate → abort()，
    //   对外表现为进程异常退出（Windows 上退出码 0xC0000409）。
    //   大项目上只要文件发现 / 图重建任一环节抛一次，整个索引就失败。
    try {
      Scanner scanner(session);
      std::lock_guard<std::mutex> lock(g_sessionMutex);
      ok = scanner.run(req, [](int done, int total, const std::string& file) {
        if (g_cancel.load()) return false;
        writeProgress(done, total, file);
        return true;
      }, error);
    } catch (const std::exception& e) {
      ok = false;
      error = std::string("扫描过程中抛出异常：") + e.what();
    } catch (...) {
      ok = false;
      error = "扫描过程中抛出未知异常";
    }
    g_scanning.store(false);
  });
  worker.join();

  if (!ok) throw std::runtime_error(error.empty() ? "扫描失败" : error);
  return session.statsToJson();
}

}  // namespace

int runStdioServer() {
  Session session;
  std::string line;
  while (!g_shutdown.load()) {
    if (!std::getline(std::cin, line)) break;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;

    json::Value request;
    try {
      request = json::parse(line);
    } catch (const std::exception& e) {
      writeError(-1, std::string("请求不是合法 JSON: ") + e.what());
      continue;
    }
    if (!request.isObject()) {
      writeError(-1, "请求必须是 JSON 对象");
      continue;
    }

    const long long id = static_cast<long long>(request.getNumber("id", -1));
    const std::string method = request.getString("method");
    const json::Value* paramsPtr = request.find("params");
    const json::Value emptyParams = json::Value::makeObject();
    const json::Value& params = paramsPtr ? *paramsPtr : emptyParams;

    try {
      if (method == "ping") {
        json::Value r = json::Value::makeObject();
        r.set("pong", json::Value::makeBool(true));
        r.set("version", json::Value::makeString("0.1.0"));
        r.set("protocol", json::Value::makeInt(1));
        r.set("scanning", json::Value::makeBool(g_scanning.load()));
        writeResult(id, std::move(r));
      } else if (method == "scan") {
        if (g_scanning.load()) throw std::runtime_error("已有索引任务在执行");
        json::Value r = handleScan(session, params);
        writeResult(id, std::move(r));
      } else if (method == "cancel") {
        g_cancel.store(true);
        json::Value r = json::Value::makeObject();
        r.set("cancelled", json::Value::makeBool(true));
        writeResult(id, std::move(r));
      } else if (method == "stats") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        writeResult(id, session.statsToJson());
      } else if (method == "subgraph" || method == "fileDeps") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        std::string focus = params.getString("focus");
        if (method == "fileDeps") {
          const std::string file = util::normalizePath(params.getString("file"));
          focus = makeNodeId(NodeKind::File, util::relativeTo(session.root(), util::joinPath(session.root(), file)));
        }
        Direction dir = Direction::Both;
        parseDirection(params.getString("direction", "both"), dir);
        const int depth = static_cast<int>(params.getNumber("depth", 2));
        const size_t maxNodes = static_cast<size_t>(params.getNumber("maxNodes", 800));
        bool truncated = false;
        const Graph g = session.subgraph(focus, depth, dir, maxNodes, &truncated);
        if (g.nodes.empty()) throw std::runtime_error("找不到焦点节点：" + focus);
        writeResult(id, buildSubgraphResult(session, g, truncated));
      } else if (method == "symbolGraph") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const std::string file = util::normalizePath(params.getString("file"));
        const std::string rel = util::relativeTo(session.root(), util::joinPath(session.root(), file));
        const int line = static_cast<int>(params.getNumber("line", 1));
        const std::string focus = focusNodeForLocation(session, rel, line);
        if (focus.empty()) throw std::runtime_error("该位置没有可用符号：" + rel + ":" + std::to_string(line));
        Direction dir = Direction::Both;
        parseDirection(params.getString("direction", "both"), dir);
        const int depth = static_cast<int>(params.getNumber("depth", 2));
        const size_t maxNodes = static_cast<size_t>(params.getNumber("maxNodes", 800));
        bool truncated = false;
        const Graph g = session.subgraph(focus, depth, dir, maxNodes, &truncated);
        json::Value r = buildSubgraphResult(session, g, truncated);
        r.set("focus", json::Value::makeString(focus));
        writeResult(id, std::move(r));
      } else if (method == "expand") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        Direction dir = Direction::Both;
        parseDirection(params.getString("direction", "both"), dir);
        const int depth = static_cast<int>(params.getNumber("depth", 1));
        const size_t maxNodes = static_cast<size_t>(params.getNumber("maxNodes", 800));
        bool truncated = false;
        const Graph g = session.subgraph(params.getString("focus"), depth, dir, maxNodes, &truncated);
        writeResult(id, buildSubgraphResult(session, g, truncated));
      } else if (method == "architecture") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const size_t maxNodes = static_cast<size_t>(params.getNumber("maxNodes", 200));
        const Graph g = session.architecture(maxNodes);
        writeResult(id, buildSubgraphResult(session, g, false));
      } else if (method == "updateFile") {
        ScanRequest req;
        req.root = session.root();
        req.options.fileSizeLimitBytes = 4ull * 1024 * 1024;
        applyConfig(params.find("config") ? *params.find("config") : json::Value{}, req);
        std::string error;
        bool ok = false;
        {
          std::lock_guard<std::mutex> lock(g_sessionMutex);
          Scanner scanner(session);
          ok = scanner.runSingle(req, util::normalizePath(params.getString("file")), error);
        }
        json::Value r = json::Value::makeObject();
        r.set("updated", json::Value::makeBool(ok));
        r.set("file", json::Value::makeString(params.getString("file")));
        r.set("stats", session.statsToJson());
        writeResult(id, std::move(r));
      } else if (method == "removeFile") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        session.eraseFile(util::normalizePath(params.getString("file")));
        session.rebuild();
        writeResult(id, session.statsToJson());
      } else if (method == "nodeAt") {
        // 光标位置 → 符号节点。供「从光标处开始读」用：
        // 大项目的 main 常常在平台相关文件里，真正想读的那条线往往从别处起头。
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const std::string file = util::normalizePath(params.getString("file"));
        const std::string rel = util::relativeTo(session.root(), util::joinPath(session.root(), file));
        const int line = static_cast<int>(params.getNumber("line", 1));
        const std::string hit = functionAtLocation(session.graph(), rel, line);
        if (hit.empty()) {
          throw std::runtime_error("该位置没有可用符号：" + rel + ":" + std::to_string(line));
        }
        json::Value node = json::Value::makeObject();
        for (const Node& n : session.graph().nodes) {
          if (n.id != hit) continue;
          node.set("id", json::Value::makeString(n.id));
          node.set("name", json::Value::makeString(n.name));
          node.set("kind", json::Value::makeString(toString(n.kind)));
          node.set("file", json::Value::makeString(n.file));
          node.set("line", json::Value::makeInt(n.line));
          node.set("column", json::Value::makeInt(n.column));
          node.set("external", json::Value::makeBool(n.external));
          node.set("declaration", json::Value::makeBool(n.declaration));
          node.set("detail", json::Value::makeString(n.detail));
          break;
        }
        writeResult(id, std::move(node));
      } else if (method == "violations") {
        // 架构边界检查：公开头文件引用内部实现、目录之间成环。
        // 只报**可证明**的东西（都来自图上的边），不按目录名猜层次 —— 猜的那种会满屏误报。
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const int maxItems = static_cast<int>(params.getNumber("maxItems", 500));
        int total = 0;
        const std::vector<Violation> vs = findViolations(session.graph(), maxItems, total);
        std::vector<json::Value> items;
        items.reserve(vs.size());
        for (const Violation& v : vs) {
          json::Value o = json::Value::makeObject();
          o.set("kind", json::Value::makeString(v.kind));
          o.set("fromFile", json::Value::makeString(v.fromFile));
          o.set("fromLine", json::Value::makeInt(v.fromLine));
          o.set("toFile", json::Value::makeString(v.toFile));
          o.set("edgeCount", json::Value::makeInt(v.edgeCount));
          if (!v.dirs.empty()) {
            std::vector<json::Value> dirs;
            dirs.reserve(v.dirs.size());
            for (const std::string& d : v.dirs) dirs.push_back(json::Value::makeString(d));
            o.set("dirs", json::Value::makeArray(std::move(dirs)));
          }
          items.push_back(std::move(o));
        }
        json::Value out = json::Value::makeObject();
        out.set("violations", json::Value::makeArray(std::move(items)));
        out.set("total", json::Value::makeInt(total));
        writeResult(id, std::move(out));
      } else if (method == "entries") {
        // 起点候选：没有 main 的库项目该从哪读起（有 main 时它永远排第一个）。
        // 引擎**不猜**起点 —— 挑错了整条阅读顺序都是错的，所以这里只给候选，由用户点一个。
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const size_t limit = static_cast<size_t>(params.getNumber("limit", 50));
        size_t total = 0;
        const std::vector<EntryCandidate> cands = findEntryCandidates(session.graph(), limit, total);
        std::vector<json::Value> items;
        items.reserve(cands.size());
        for (const EntryCandidate& c : cands) {
          const Node& n = session.graph().nodes[c.nodeIndex];
          json::Value o = json::Value::makeObject();
          o.set("id", json::Value::makeString(n.id));
          o.set("name", json::Value::makeString(n.name));
          o.set("kind", json::Value::makeString(toString(n.kind)));
          o.set("file", json::Value::makeString(n.file));
          o.set("line", json::Value::makeInt(n.line));
          o.set("column", json::Value::makeInt(n.column));
          o.set("detail", json::Value::makeString(n.detail));
          o.set("mainLike", json::Value::makeBool(c.mainLike));
          o.set("publicApi", json::Value::makeBool(c.publicApi));
          o.set("apiHeader", json::Value::makeString(n.apiHeader));
          o.set("apiLine", json::Value::makeInt(n.apiLine));
          o.set("callers", json::Value::makeInt(c.callers));
          o.set("callees", json::Value::makeInt(c.callees));
          items.push_back(std::move(o));
        }
        json::Value out = json::Value::makeObject();
        out.set("candidates", json::Value::makeArray(std::move(items)));
        out.set("total", json::Value::makeInt(static_cast<int>(total)));
        out.set("hasMain", json::Value::makeBool(!findEntryPoint(session.graph()).empty()));
        writeResult(id, std::move(out));
      } else if (method == "route") {
        // 阅读路线：从入口（默认 main）出发的有序阅读清单。
        // 与 subgraph 的区别是「有序」—— 遍历在引擎里做，前端只负责渲染，
        // 这样大项目下步骤数与负载都由 maxSteps 控住。
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        RouteOptions opt;
        opt.from = params.getString("from");
        opt.depthFirst = params.getString("strategy", "bfs") == "dfs";
        const int maxSteps = static_cast<int>(params.getNumber("maxSteps", 200));
        if (maxSteps > 0) opt.maxSteps = maxSteps;
        const int maxDepth = static_cast<int>(params.getNumber("maxDepth", 6));
        if (maxDepth >= 0) opt.maxDepth = maxDepth;
        opt.projectOnly = params.getBool("projectOnly", true);
        opt.groupByFile = params.getBool("groupByFile", false);
        // 降噪：折叠「短且只调一处」的琐碎步骤（get / size / 纯转发）
        opt.skipTrivial = params.getBool("skipTrivial", false);
        const int trivialBodyLines = static_cast<int>(params.getNumber("trivialBodyLines", 3));
        if (trivialBodyLines > 0) opt.trivialBodyLines = trivialBodyLines;
        // 人工纠偏：{"<父节点 id>|<简单名>": "<改用的节点 id>"}
        if (const json::Value* ov = params.find("overrides"); ov && ov->isObject()) {
          for (const auto& kv : ov->objectValue) {
            if (kv.second.isString() && !kv.second.stringValue.empty()) {
              opt.overrides[kv.first] = kv.second.stringValue;
            }
          }
        }
        const std::vector<std::string> kinds = params.getStringArray("kinds");
        if (!kinds.empty()) {
          std::vector<EdgeKind> parsed;
          for (const std::string& k : kinds) {
            EdgeKind ek = EdgeKind::Calls;
            if (parseEdgeKind(k, ek)) parsed.push_back(ek);
          }
          if (!parsed.empty()) opt.kinds = parsed;
        }
        const RouteResult route = computeRoute(session.graph(), opt);
        if (!route.error.empty()) throw std::runtime_error(route.error);
        json::Value out = routeToJson(session.graph(), route);
        out.set("from", json::Value::makeString(opt.from.empty() ? findEntryPoint(session.graph()) : opt.from));
        writeResult(id, std::move(out));
      } else if (method == "exportData") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const std::string format = params.getString("format", "json");
        Direction dir = Direction::Both;
        parseDirection(params.getString("direction", "both"), dir);
        const int depth = static_cast<int>(params.getNumber("depth", 3));
        const size_t maxNodes = static_cast<size_t>(params.getNumber("maxNodes", 2000));
        const std::string focus = params.getString("focus");
        bool truncated = false;
        Graph g;
        if (focus.empty()) {
          g = session.architecture(maxNodes);
        } else {
          g = session.subgraph(focus, depth, dir, maxNodes, &truncated);
        }
        json::Value r = json::Value::makeObject();
        r.set("format", json::Value::makeString(format));
        if (format == "dot") {
          r.set("content", json::Value::makeString(session.graphToDot(g)));
        } else if (format == "mermaid") {
          r.set("content", json::Value::makeString(session.graphToMermaid(g)));
        } else {
          json::Value payload = json::Value::makeObject();
          payload.set("generator", json::Value::makeString("DepScan"));
          payload.set("version", json::Value::makeString("0.1.0"));
          payload.set("root", json::Value::makeString(session.root()));
          payload.set("stats", session.statsToJson());
          payload.set("graph", session.graphToJson(g));
          r.set("content", json::Value::makeString(json::dump(payload, true)));
        }
        writeResult(id, std::move(r));
      } else if (method == "dependents") {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        const std::vector<std::string> deps =
            session.dependentsOf(util::normalizePath(params.getString("file")));
        json::Value arr = json::Value::makeArray({});
        for (const std::string& d : deps) arr.arrayValue.push_back(json::Value::makeString(d));
        json::Value r = json::Value::makeObject();
        r.set("dependents", std::move(arr));
        writeResult(id, std::move(r));
      } else if (method == "shutdown") {
        g_cancel.store(true);
        json::Value r = json::Value::makeObject();
        r.set("bye", json::Value::makeBool(true));
        writeResult(id, std::move(r));
        g_shutdown.store(true);
        break;
      } else {
        writeError(id, "未知方法: " + method);
      }
    } catch (const std::exception& e) {
      writeError(id, e.what());
    }
  }
  return 0;
}

int runOnce(const std::string& root, bool pretty, int jobs, bool trace, bool violationsOnly) {
  Session session;
  ScanRequest req;
  req.root = root;
  req.options.fileSizeLimitBytes = 4ull * 1024 * 1024;
  req.useCache = false;
  if (jobs > 0) req.threads = jobs;

  Scanner scanner(session);
  std::string error;
  bool ok = false;
  try {
    ok = scanner.run(req, [trace](int done, int total, const std::string& file) {
      // --trace：每个文件都打一行，崩溃时 stderr 的最后一行就是元凶文件
      if (trace || done % 50 == 0 || done == total) {
        std::fprintf(stderr, "[DepScan] %d/%d %s\n", done, total, file.c_str());
        std::fflush(stderr);
      }
      return true;
    }, error);
  } catch (const std::exception& e) {
    ok = false;
    error = std::string("扫描过程中抛出异常：") + e.what();
  } catch (...) {
    ok = false;
    error = "扫描过程中抛出未知异常";
  }
  if (!ok) {
    std::fprintf(stderr, "[DepScan] 扫描失败: %s\n", error.c_str());
    return 1;
  }
  json::Value payload = json::Value::makeObject();
  if (violationsOnly) {
    // --violations：只给架构边界违规。有违规时退出码为 1 —— 这样它能直接写进 CI 流水线。
    int total = 0;
    const std::vector<Violation> vs = findViolations(session.graph(), 0, total);
    std::vector<json::Value> items;
    items.reserve(vs.size());
    for (const Violation& v : vs) {
      json::Value o = json::Value::makeObject();
      o.set("kind", json::Value::makeString(v.kind));
      o.set("fromFile", json::Value::makeString(v.fromFile));
      o.set("fromLine", json::Value::makeInt(v.fromLine));
      o.set("toFile", json::Value::makeString(v.toFile));
      o.set("edgeCount", json::Value::makeInt(v.edgeCount));
      json::Value dirs = json::Value::makeArray({});
      for (const std::string& d : v.dirs) dirs.arrayValue.push_back(json::Value::makeString(d));
      o.set("dirs", std::move(dirs));
      items.push_back(std::move(o));
    }
    payload.set("violations", json::Value::makeArray(std::move(items)));
    payload.set("total", json::Value::makeInt(total));
    const std::string text = json::dump(payload, pretty);
    std::fwrite(text.data(), 1, text.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
    return total > 0 ? 1 : 0;
  }
  payload.set("stats", session.statsToJson());
  payload.set("graph", session.graphToJson(session.graph()));
  const std::string text = json::dump(payload, pretty);
  std::fwrite(text.data(), 1, text.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
  return 0;
}

}  // namespace depscan
