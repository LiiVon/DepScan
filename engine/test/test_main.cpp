// 引擎自测：不依赖第三方测试框架，保证「下载即用」。
// 覆盖词法、预处理、五类依赖识别与子图查询等关键路径。
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "depscan/analyzer.hpp"
#include "depscan/checks.hpp"
#include "depscan/json.hpp"
#include "depscan/lexer.hpp"
#include "depscan/session.hpp"
#include "depscan/util.hpp"

namespace {

int g_failed = 0;
int g_passed = 0;

void check(bool cond, const std::string& name, const std::string& detail = {}) {
  if (cond) {
    ++g_passed;
    std::printf("  [PASS] %s\n", name.c_str());
  } else {
    ++g_failed;
    std::printf("  [FAIL] %s %s\n", name.c_str(), detail.c_str());
  }
}

bool hasSymbol(const depscan::FileAnalysis& fa, depscan::NodeKind kind, const std::string& name) {
  for (const auto& s : fa.symbols) {
    if (s.kind == kind && (s.name == name || s.qualifiedName == name)) return true;
  }
  return false;
}

bool hasRef(const depscan::FileAnalysis& fa, depscan::EdgeKind kind, const std::string& name) {
  for (const auto& r : fa.refs) {
    if (r.kind == kind && r.name == name) return true;
  }
  return false;
}

size_t countEdge(const depscan::Graph& g, depscan::EdgeKind kind) {
  size_t n = 0;
  for (const auto& e : g.edges) {
    if (e.kind == kind) ++n;
  }
  return n;
}

void testLexer() {
  std::printf("[词法] 注释 / 字符串 / 续行\n");
  const std::string src =
      "// 单行注释 #include <fake.h>\n"
      "/* 块注释\n   #include <fake2.h> */\n"
      "const char* s = \"#include <nope.h>\";\n"
      "int a = 1; \\\n"
      "int b = 2;\n";
  const depscan::LexedFile lf = depscan::lex(src);
  check(lf.includes.empty(), "注释与字符串里的 #include 不被识别", "found=" + std::to_string(lf.includes.size()));
  check(lf.lines >= 6, "行号统计正确");
  bool sawIdent = false;
  for (const auto& t : lf.tokens) {
    if (t.text == "b") sawIdent = true;
  }
  check(sawIdent, "反斜杠续行不会截断后续 token");
}

void testPreprocessor() {
  std::printf("[预处理] 宏展开的 include\n");
  const std::string src =
      "#define MY_HEADER \"real.h\"\n"
      "#include MY_HEADER\n"
      "#include <vector>\n"
      "#define VALUE 42\n";
  const depscan::LexedFile lf = depscan::lex(src);
  bool foundReal = false;
  bool foundVector = false;
  for (const auto& inc : lf.includes) {
    if (inc.first == "real.h") foundReal = true;
    if (inc.first == "vector") foundVector = true;
  }
  check(foundReal, "#include 宏展开为真实头文件名");
  check(foundVector, "尖括号 include 正常提取");
}

void testAnalyzer() {
  std::printf("[分析] 函数 / 类继承 / 调用 / 类型依赖\n");
  const std::string src = R"(
#include "base.h"
#define MAX_LEN 128
namespace app {
class Shape {
 public:
  virtual double area() const = 0;
 protected:
  std::string name_;
};
class Circle : public Shape {
 public:
  double area() const override { return compute(radius_); }
 private:
  double radius_;
  Helper helper_;
};
double compute(double x) { return x * 2.0; }
void run() {
  Circle c;
  compute(1.0);
  double v = MAX_LEN;
  (void)v;
}
}
)";
  depscan::AnalyzerOptions opts;
  opts.includeExternal = false;
  const depscan::FileAnalysis fa = depscan::analyzeFile("src/demo.cpp", src, opts);
  check(hasSymbol(fa, depscan::NodeKind::Class, "Circle"), "识别类定义 Circle");
  check(hasSymbol(fa, depscan::NodeKind::Class, "Shape"), "识别类定义 Shape");
  check(hasSymbol(fa, depscan::NodeKind::Function, "compute"), "识别函数定义 compute");
  check(hasSymbol(fa, depscan::NodeKind::Function, "app::run"), "识别命名空间内函数 run");
  check(hasSymbol(fa, depscan::NodeKind::Macro, "MAX_LEN"), "识别宏 MAX_LEN");
  check(hasRef(fa, depscan::EdgeKind::Inherits, "Shape"), "识别继承关系 Circle -> Shape");
  check(hasRef(fa, depscan::EdgeKind::Calls, "compute"), "识别函数调用 compute");
  check(hasRef(fa, depscan::EdgeKind::Uses, "Helper"), "识别成员类型依赖 Helper");
  check(hasRef(fa, depscan::EdgeKind::Refs, "MAX_LEN"), "识别宏符号引用");
  check(fa.includes.size() == 1 && fa.includes[0].first == "base.h", "include 目标正确");
  bool lineOk = false;
  for (const auto& s : fa.symbols) {
    if (s.name == "compute" && s.line > 1) lineOk = true;
  }
  check(lineOk, "符号行号有效");
}

void testSession() {
  std::printf("[图] include 解析 / 引用消解 / 子图\n");
  depscan::Session session;
  depscan::AnalyzerOptions opts;
  session.reset("D:/demo", opts);

  depscan::FileAnalysis a;
  a.file = "src/main.cpp";
  {
    depscan::SymbolDef d;
    d.kind = depscan::NodeKind::Function;
    d.name = "main";
    d.qualifiedName = "main";
    d.file = a.file;
    d.line = 10;
    d.id = depscan::makeNodeId(d.kind, d.qualifiedName);
    a.symbols.push_back(d);
  }
  a.includes.emplace_back("util.h", 1);
  {
    depscan::PendingRef r;
    r.fromId = depscan::makeNodeId(depscan::NodeKind::Function, "main");
    r.name = "helper";
    r.kind = depscan::EdgeKind::Calls;
    r.file = a.file;
    r.line = 12;
    a.refs.push_back(r);
  }
  session.putFile(std::move(a));

  depscan::FileAnalysis b;
  b.file = "src/util.h";
  session.putFile(std::move(b));

  depscan::FileAnalysis c;
  c.file = "src/util.cpp";
  {
    depscan::SymbolDef d;
    d.kind = depscan::NodeKind::Function;
    d.name = "helper";
    d.qualifiedName = "helper";
    d.file = c.file;
    d.line = 5;
    d.id = depscan::makeNodeId(d.kind, d.qualifiedName);
    c.symbols.push_back(d);
  }
  c.includes.emplace_back("util.h", 1);
  session.putFile(std::move(c));

  session.rebuild();
  const depscan::Graph& g = session.graph();
  check(countEdge(g, depscan::EdgeKind::Includes) == 2, "include 边数量正确",
        std::to_string(countEdge(g, depscan::EdgeKind::Includes)));
  check(countEdge(g, depscan::EdgeKind::Calls) == 1, "调用边被消解到 util.cpp 的 helper");

  bool truncated = false;
  const depscan::Graph sub = session.subgraph(depscan::makeNodeId(depscan::NodeKind::File, "src/main.cpp"),
                                              2, depscan::Direction::Downstream, 100, &truncated);
  std::string names;
  for (const auto& n : sub.nodes) names += n.id + " ";
  check(sub.nodes.size() >= 3, "2 层子图包含 main.cpp / util.h / helper", names);
  check(!truncated, "未触发截断");

  const std::vector<std::string> deps = session.dependentsOf("src/util.h");
  check(!deps.empty(), "能算出 util.h 的依赖者（增量索引用）");

  const std::string dot = session.graphToDot(sub);
  const std::string mermaid = session.graphToMermaid(sub);
  check(!dot.empty() && !mermaid.empty(), "DOT / Mermaid 导出可用");

  const std::string json = depscan::json::dump(session.graphToJson(sub), false);
  check(json.find("\"nodes\"") != std::string::npos, "图 JSON 序列化包含 nodes");
}

void testChecks() {
  std::printf("[检查] 公开面泄漏 / 目录循环\n");

  const auto fileNode = [](const std::string& rel) {
    depscan::Node n;
    n.id = "file:" + rel;
    n.kind = depscan::NodeKind::File;
    n.name = rel;
    n.file = rel;
    n.line = 1;
    return n;
  };
  const auto funcNode = [](const std::string& qname, const std::string& rel, int line) {
    depscan::Node n;
    n.id = "func:" + qname;
    n.kind = depscan::NodeKind::Function;
    n.name = qname;
    n.file = rel;
    n.line = line;
    n.bodyLines = 3;
    return n;
  };
  const auto incEdge = [](const std::string& from, const std::string& to, int line) {
    depscan::Edge e;
    e.kind = depscan::EdgeKind::Includes;
    e.from = "file:" + from;
    e.to = "file:" + to;
    e.file = from;
    e.line = line;
    return e;
  };
  const auto useEdge = [](const std::string& fromFile, const std::string& toNodeId, int line) {
    depscan::Edge e;
    e.kind = depscan::EdgeKind::Uses;
    e.from = "file:" + fromFile;
    e.to = toNodeId;
    e.file = fromFile;
    e.line = line;
    return e;
  };

  {
    // 公开头文件 include 了内部实现 → 一条泄漏
    depscan::Graph g;
    g.nodes = {fileNode("include/lib.h"), fileNode("src/internal.h")};
    g.edges = {incEdge("include/lib.h", "src/internal.h", 3)};
    int total = 0;
    const std::vector<depscan::Violation> vs = depscan::findViolations(g, 0, total);
    check(vs.size() == 1 && vs[0].kind == "public-api-leak",
          "公开头文件引用内部实现 → 一条泄漏", "got=" + std::to_string(vs.size()));
    check(!vs.empty() && vs[0].fromFile == "include/lib.h" && vs[0].fromLine == 3 &&
              vs[0].toFile == "src/internal.h",
          "泄漏带位置（能跳到那行）与被引用的文件");
  }
  {
    // 反向引用（实现用公开面）与公开面之间互引都不是问题
    depscan::Graph g;
    g.nodes = {fileNode("include/a.h"), fileNode("include/b.h"), fileNode("src/impl.cpp")};
    g.edges = {incEdge("src/impl.cpp", "include/a.h", 2), incEdge("include/a.h", "include/b.h", 4)};
    int total = 0;
    check(depscan::findViolations(g, 0, total).empty(),
          "实现引用公开面 / 公开面互引都不算泄漏（否则就是满屏误报）");
  }
  {
    // 公开头文件里「用」到了内部实现的类型（uses 边）也算泄漏
    depscan::Graph g;
    g.nodes = {fileNode("include/lib.h"), funcNode("app::Impl", "src/impl.cpp", 9)};
    g.edges = {useEdge("include/lib.h", "func:app::Impl", 5)};
    int total = 0;
    const std::vector<depscan::Violation> vs = depscan::findViolations(g, 0, total);
    check(vs.size() == 1 && vs[0].toFile == "src/impl.cpp",
          "公开头文件用到内部实现的类型，同样算泄漏", "got=" + std::to_string(vs.size()));
  }
  {
    // 两个目录互引 → 一条目录环（带上一条 .cpp 出发的边，验证代表边挑的是头文件那条）
    depscan::Graph g;
    g.nodes = {fileNode("src/core/registry.h"), fileNode("src/core/registry.cpp"),
               fileNode("src/ui/panel.h")};
    g.edges = {incEdge("src/core/registry.cpp", "src/ui/panel.h", 3),
               incEdge("src/ui/panel.h", "src/core/registry.h", 5),
               incEdge("src/core/registry.h", "src/ui/panel.h", 8)};
    int total = 0;
    const std::vector<depscan::Violation> vs = depscan::findViolations(g, 0, total);
    check(vs.size() == 1 && vs[0].kind == "directory-cycle",
          "两个目录互引 → 一条目录环", "got=" + std::to_string(vs.size()));
    check(!vs.empty() && vs[0].dirs.size() == 2 && vs[0].dirs[0] == "src/core" &&
              vs[0].dirs[1] == "src/ui" && vs[0].edgeCount == 3,
          "环里列出目录与边数（目录名排序，便于断言与展示）",
          "dirs=" + std::to_string(vs.empty() ? 0 : vs[0].dirs.size()) +
              " edges=" + std::to_string(vs.empty() ? -1 : vs[0].edgeCount));
    check(!vs.empty() && vs[0].fromFile == "src/core/registry.h" && vs[0].fromLine == 8,
          "环的代表边优先取「头文件那条 include」（它会把问题传染给每个包含者）",
          "got=" + (vs.empty() ? std::string("-") : vs[0].fromFile + ":" + std::to_string(vs[0].fromLine)));
  }
  {
    // 三个目录成环；同目录内部互引不算
    depscan::Graph g;
    g.nodes = {fileNode("a/x.h"), fileNode("b/y.h"), fileNode("c/z.h"),
               fileNode("src/p.h"), fileNode("src/q.h")};
    g.edges = {incEdge("a/x.h", "b/y.h", 1), incEdge("b/y.h", "c/z.h", 1),
               incEdge("c/z.h", "a/x.h", 1), incEdge("src/p.h", "src/q.h", 1),
               incEdge("src/q.h", "src/p.h", 1)};
    int total = 0;
    const std::vector<depscan::Violation> vs = depscan::findViolations(g, 0, total);
    check(vs.size() == 1 && vs[0].dirs.size() == 3,
          "三目录成环算一个环（强连通分量，不是只找互引对）", "got=" + std::to_string(vs.size()));
    check(!vs.empty() && vs[0].edgeCount == 3, "环里边数如实报出（3 条）");
    int capped = 0;
    check(depscan::findViolations(g, 1, capped).size() == 1 && capped == 1,
          "maxItems 截断但 total 仍是真实数量");
  }
  {
    // 链式依赖（不回头）不是环
    depscan::Graph g;
    g.nodes = {fileNode("a/x.h"), fileNode("b/y.h"), fileNode("c/z.h")};
    g.edges = {incEdge("a/x.h", "b/y.h", 1), incEdge("b/y.h", "c/z.h", 1)};
    int total = 0;
    check(depscan::findViolations(g, 0, total).empty(), "链式依赖（不回头）不是环");
  }
}

void testJsonAndUtil() {
  std::printf("[基础] JSON 往返 / glob / 路径\n");
  depscan::json::Value o = depscan::json::Value::makeObject();
  o.set("name", depscan::json::Value::makeString("中文 \"引号\"\n换行"));
  o.set("n", depscan::json::Value::makeInt(42));
  o.set("ok", depscan::json::Value::makeBool(true));
  const std::string text = depscan::json::dump(o, false);
  const depscan::json::Value back = depscan::json::parse(text);
  check(back.getString("name") == "中文 \"引号\"\n换行", "UTF-8 与转义往返一致");
  check(static_cast<int>(back.getNumber("n")) == 42, "数字往返一致");

  check(depscan::util::globMatch("**/*.{cpp,h}", "src/a/b.cpp"), "glob 花括号 + ** 匹配");
  check(!depscan::util::globMatch("src/*.cpp", "src/a/b.cpp"), "* 不跨越目录分隔符");
  check(depscan::util::relativeTo("D:/p", "D:/p/src/a.cpp") == "src/a.cpp", "相对路径计算");
  check(depscan::util::normalizePath("D:\\p\\src\\..\\a.cpp") == "D:/p/a.cpp", "路径归一化");
}

}  // namespace

int main() {
  std::printf("DepScaner core self-test\n");
  testLexer();
  testPreprocessor();
  testAnalyzer();
  testSession();
  testChecks();
  testJsonAndUtil();
  std::printf("\n通过 %d / 失败 %d\n", g_passed, g_failed);
  return g_failed == 0 ? 0 : 1;
}
