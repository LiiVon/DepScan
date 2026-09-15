#include "depscan/analyzer.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <set>

#include "depscan/lexer.hpp"
#include "depscan/util.hpp"

namespace depscan {

namespace {

using Tokens = std::vector<Token>;

int matchParen(const Tokens& t, size_t openIdx) {
  if (openIdx >= t.size()) return -1;
  const int d = t[openIdx].parenDepth;
  for (size_t k = openIdx + 1; k < t.size(); ++k) {
    if (t[k].text == ")" && t[k].parenDepth == d) return static_cast<int>(k);
  }
  return -1;
}

int matchBrace(const Tokens& t, size_t openIdx) {
  if (openIdx >= t.size()) return -1;
  const int d = t[openIdx].braceDepth;
  for (size_t k = openIdx + 1; k < t.size(); ++k) {
    if (t[k].text == "}" && t[k].braceDepth == d) return static_cast<int>(k);
  }
  return -1;
}

bool isQualifierWord(const std::string& s) {
  static const char* kWords[] = {
      "const", "volatile", "static", "inline", "constexpr", "consteval", "constinit",
      "extern", "virtual", "explicit", "friend", "mutable", "register", "thread_local",
      "typename", "unsigned", "signed", "short", "long", "struct", "union", "enum", "auto"};
  for (const char* w : kWords) {
    if (s == w) return true;
  }
  return false;
}

// 语句关键字：它们只能出现在表达式/语句里，**不可能**是函数的返回类型。
// 用途见下方「反例排除」——`return app.start(args);` 里的 `return` 是 identifier，
// 会被「语句起点到名字之间有 identifier 就算有返回类型」这条启发式误判。
bool isStatementKeyword(const std::string& s) {
  static const char* kWords[] = {"return", "if",     "else",     "while",    "for",
                                 "switch", "case",   "default",  "do",       "goto",
                                 "break",  "continue", "throw",  "new",      "delete",
                                 "co_return", "co_await", "co_yield"};
  for (const char* w : kWords) {
    if (s == w) return true;
  }
  return false;
}

bool hasStatementKeyword(const Tokens& t, size_t from, size_t to) {
  for (size_t i = from; i < to && i < t.size(); ++i) {
    if (isStatementKeyword(t[i].text)) return true;
  }
  return false;
}

bool isBuiltinType(const std::string& s) {
  static const char* kTypes[] = {"void", "bool", "char", "char8_t", "char16_t", "char32_t",
                                 "wchar_t", "short", "int", "long", "float", "double",
                                 "unsigned", "signed", "size_t", "ssize_t", "auto"};
  for (const char* w : kTypes) {
    if (s == w) return true;
  }
  return false;
}

std::string renderRange(const Tokens& t, size_t a, size_t b) {
  std::string out;
  for (size_t k = a; k <= b && k < t.size(); ++k) {
    const std::string& s = t[k].text;
    if (!out.empty() && !s.empty()) {
      const char last = out.back();
      const bool leftWord = isalnum(static_cast<unsigned char>(last)) || last == '_' ||
                            last == '>' || last == ')' || last == ']';
      const bool rightWord = isalnum(static_cast<unsigned char>(s[0])) || s[0] == '_';
      if (leftWord && rightWord) out += ' ';
    }
    out += s;
  }
  return out;
}

// `<`/`>` 模板实参的粗略配对（只用于从名字链中剔除模板参数）
bool looksLikeDeclarationStart(const Tokens& t, size_t k) {
  if (k == 0) return true;
  const std::string& p = t[k - 1].text;
  return p == ";" || p == "{" || p == "}" || p == ":";
}

std::string lastComponent(const std::vector<std::string>& chain) {
  // 取名字链中最后一个标识符（跳过模板实参）
  for (size_t i = chain.size(); i-- > 0;) {
    if (!chain[i].empty()) return chain[i];
  }
  return {};
}

// 从 include 链/类型链里取「主类型名」： std::vector<Foo> -> Foo, ns::Bar -> Bar
std::string principalTypeName(const std::string& raw) {
  std::string s = raw;
  // 去掉模板参数（取 <> 内最后一个标识符；无 <> 则取 :: 后最后一段）
  const size_t lt = s.find('<');
  if (lt != std::string::npos) {
    const size_t gt = s.rfind('>');
    std::string inner = (gt != std::string::npos && gt > lt) ? s.substr(lt + 1, gt - lt - 1) : s.substr(lt + 1);
    // 递归处理嵌套模板
    if (inner.find('<') != std::string::npos) return principalTypeName(inner);
    return util::trim(inner.empty() ? s.substr(0, lt) : inner);
  }
  const size_t pos = s.rfind("::");
  if (pos != std::string::npos) s = s.substr(pos + 2);
  return util::trim(s);
}

struct ClassRange {
  size_t open = 0;
  size_t close = 0;
  std::string name;
};

struct NamespaceRange {
  size_t open = 0;
  size_t close = 0;
  std::string name;
};

std::string enclosingScope(const std::vector<NamespaceRange>& namespaces,
                           const std::vector<ClassRange>& classes, size_t idx) {
  // 按扫描顺序（外层在前）依次拼接命名空间与类，得到正确的限定前缀
  std::string scope;
  for (const NamespaceRange& ns : namespaces) {
    if (idx > ns.open && idx < ns.close) scope += ns.name + "::";
  }
  for (const ClassRange& c : classes) {
    if (idx > c.open && idx < c.close) scope += c.name + "::";
  }
  return scope;
}

const ClassRange* innermostClass(const std::vector<ClassRange>& classes, size_t idx) {
  const ClassRange* best = nullptr;
  for (const ClassRange& c : classes) {
    if (idx > c.open && idx < c.close) {
      if (!best || c.open > best->open) best = &c;
    }
  }
  return best;
}

// 解析 `(` 左侧的声明名（含 operator / 析构 / 限定名）
struct DeclName {
  std::string name;         // 简单名
  std::string qualified;    // 带作用域限定
  bool ok = false;
};

DeclName parseDeclaratorName(const Tokens& t, int parenIdx) {
  DeclName r;
  if (parenIdx <= 0) return r;
  int j = parenIdx - 1;
  if (j < 0) return r;

  // 运算符重载：operator+ / operator[] / operator new / operator()
  if (t[j].text == "operator" || (j >= 1 && t[j - 1].text == "operator")) {
    const int opIdx = (t[j].text == "operator") ? j : j - 1;
    std::string op;
    for (int k = opIdx + 1; k < parenIdx; ++k) {
      if (t[k].text == "(") break;
      op += t[k].text;
    }
    if (op.empty()) return r;  // operator() 由调用方特判
    r.name = "operator" + op;
    r.qualified = r.name;
    r.ok = true;
    return r;
  }

  if (!t[j].identifier) return r;
  std::string name = t[j].text;
  if (isCppKeyword(name)) return r;

  // 收集限定链 A::B::C（注意：词法器把 "::" 作为单个 token）
  std::string chain = name;
  int k = j - 1;
  while (k >= 1) {
    if (t[k].text != "::") break;
    if (t[k - 1].text == "~") {
      chain = "~" + chain;
      k -= 2;
      continue;
    }
    if (!t[k - 1].identifier) break;
    chain = t[k - 1].text + "::" + chain;
    k -= 2;
  }
  if (k >= 0 && t[k].text == "~") chain = "~" + chain;
  r.name = name;
  r.qualified = chain;
  r.ok = true;
  return r;
}

}  // namespace

FileAnalysis analyzeFile(const std::string& relPath, const std::string& source,
                         const AnalyzerOptions& opts) {
  FileAnalysis fa;
  fa.file = relPath;

  const LexedFile lexed = lex(source);
  fa.lineCount = lexed.lines;
  const Tokens& t = lexed.tokens;
  const size_t n = t.size();

  const std::string fileId = makeNodeId(NodeKind::File, relPath);

  // ---------- 被动收集：include / 宏 ----------
  if (opts.includes) {
    std::set<std::string> seen;
    for (const auto& inc : lexed.includes) {
      const std::string key = inc.first + "@" + std::to_string(inc.second);
      if (seen.insert(key).second) fa.includes.push_back(inc);
    }
  }
  if (opts.symbols) {
    for (const std::string& m : lexed.macroNames) {
      SymbolDef d;
      d.kind = NodeKind::Macro;
      d.name = m;
      d.qualifiedName = m;
      d.file = relPath;
      d.line = 1;
      d.id = makeNodeId(NodeKind::Macro, m);
      fa.symbols.push_back(d);
    }
  }

  // ---------- 类 / 结构 / 枚举 / 命名空间 ----------
  std::vector<ClassRange> classes;
  std::vector<NamespaceRange> namespaces;

  for (size_t k = 0; k + 1 < n; ++k) {
    if (!t[k].identifier) continue;
    const std::string& word = t[k].text;

    if (word == "namespace" && t[k + 1].identifier) {
      // 只处理 namespace X { 形式
      size_t brace = k + 2;
      while (brace < n && t[brace].text != "{" && t[brace].text != ";" && brace < k + 6) ++brace;
      if (brace < n && t[brace].text == "{") {
        const int close = matchBrace(t, brace);
        if (close > 0) {
          NamespaceRange ns;
          ns.open = brace;
          ns.close = static_cast<size_t>(close);
          ns.name = t[k + 1].text;
          namespaces.push_back(ns);
        }
      }
      continue;
    }

    if (word != "class" && word != "struct" && word != "union" && word != "enum") continue;

    const bool isEnum = word == "enum";
    size_t j = k + 1;
    // enum class / enum struct
    if (isEnum && j < n && (t[j].text == "class" || t[j].text == "struct")) ++j;
    if (j >= n) continue;
    // 跳过导出宏等（EXPORT_API Foo）
    while (j < n && t[j].identifier && t[j].text != word &&
           (t[j].text == "__attribute__" || t[j].text == "alignas")) {
      ++j;
    }
    if (j >= n || !t[j].identifier || isCppKeyword(t[j].text)) continue;
    const std::string name = t[j].text;

    // 基类子句：从 name 之后扫到 '{'（兼容 final / 属性宏等修饰）
    std::vector<std::string> bases;
    size_t b = j + 1;
    bool sawColon = false;
    while (b < n && t[b].text != "{" && t[b].text != ";") {
      if (t[b].text == ":" && !sawColon) {
        sawColon = true;
        ++b;
        break;
      }
      ++b;
    }
    if (sawColon) {
      while (b < n && t[b].text != "{" && t[b].text != ";") {
        std::string cur;
        int angle = 0;
        while (b < n) {
          const std::string& tk = t[b].text;
          if (tk == "{" || tk == ";") break;
          if (tk == "," && angle == 0) { ++b; break; }
          if (tk == "<") ++angle;
          else if (tk == ">") { if (angle > 0) --angle; }
          else if (tk == "(") {
            const int cp = matchParen(t, b);
            if (cp > 0) { b = static_cast<size_t>(cp) + 1; continue; }
          }
          if (t[b].identifier && !isQualifierWord(tk)) cur += tk + "|";
          ++b;
        }
        // cur 形如 "ns|::|Base|"，取主类型名
        std::vector<std::string> chain;
        std::string acc;
        for (char ch : cur) {
          if (ch == '|') {
            if (!acc.empty()) { chain.push_back(acc); acc.clear(); }
          } else {
            acc.push_back(ch);
          }
        }
        if (!acc.empty()) chain.push_back(acc);
        if (!chain.empty()) {
          const std::string baseName = principalTypeName(lastComponent(chain));
          if (!baseName.empty() && baseName != name) bases.push_back(baseName);
        }
      }
    }
    if (b >= n || t[b].text != "{") continue;
    const int close = matchBrace(t, b);
    if (close <= 0) continue;

    if (isEnum) {
      if (opts.types || opts.symbols) {
        SymbolDef d;
        d.kind = NodeKind::Enum;
        d.name = name;
        d.qualifiedName = enclosingScope(namespaces, classes, k) + name;
        d.file = relPath;
        d.line = t[k].line;
        d.column = t[k].column;
        d.id = makeNodeId(NodeKind::Enum, d.qualifiedName);
        d.signature = "enum " + name;
        fa.symbols.push_back(d);
      }
      continue;
    }

    ClassRange cr;
    cr.open = b;
    cr.close = static_cast<size_t>(close);
    cr.name = name;

    if (opts.types || opts.symbols) {
      SymbolDef d;
      d.kind = NodeKind::Class;
      d.name = name;
      d.qualifiedName = enclosingScope(namespaces, classes, k) + name;
      d.file = relPath;
      d.line = t[k].line;
      d.column = t[k].column;
      d.id = makeNodeId(NodeKind::Class, d.qualifiedName);
      d.signature = std::string(word) + " " + name + " @ " + relPath;
      fa.symbols.push_back(d);
    }
    if (opts.types) {
      for (const std::string& base : bases) {
        PendingRef ref;
        ref.fromId = makeNodeId(NodeKind::Class, enclosingScope(namespaces, classes, k) + name);
        ref.name = base;
        ref.kind = EdgeKind::Inherits;
        ref.file = relPath;
        ref.line = t[k].line;
        fa.refs.push_back(ref);
      }
    }
    classes.push_back(cr);
    k = b;  // 继续扫描类体内部（成员函数等），但跳过基类子句
  }

  // ---------- 函数定义 / 声明 ----------
  struct BodyRange {
    size_t open = 0;
    size_t close = 0;
    std::string ownerId;
  };
  std::vector<BodyRange> bodies;

  std::set<std::string> declaredIds;

  for (size_t k = 0; k < n; ++k) {
    if (t[k].text != "(") continue;
    const int close = matchParen(t, k);
    if (close <= 0) continue;

    int closeIdx = close;
    DeclName dn = parseDeclaratorName(t, static_cast<int>(k));
    if (!dn.ok) {
      // operator() 形式：`operator` 后第一个 ( ) 只是名字的一部分，真正的参数表在其后
      if (k > 0 && t[k - 1].identifier && t[k - 1].text == "operator" &&
          static_cast<size_t>(close + 1) < n && t[close + 1].text == "(") {
        const int c2 = matchParen(t, static_cast<size_t>(close + 1));
        if (c2 > 0) {
          dn.ok = true;
          dn.name = "operator()";
          dn.qualified = "operator()";
          closeIdx = c2;
        }
      }
      if (!dn.ok) continue;
    }
    const int close2 = closeIdx;

    // 向前扫描确定是定义还是声明
    bool isDefinition = false;
    bool valid = false;
    const size_t scanFrom = static_cast<size_t>(close2) + 1;
    for (size_t s = scanFrom; s < n && s < scanFrom + 80; ++s) {
      const std::string& tk = t[s].text;
      if (tk == ")") { valid = false; break; }
      if (tk == "{") { isDefinition = true; valid = true; break; }
      if (tk == ";" || tk == "=") { isDefinition = false; valid = true; break; }
      if (tk == ":" || tk == "->" || tk == "<" || tk == ">" || tk == "," || tk == "*" ||
          tk == "&" || tk == "&&" || tk == "::" || tk == "[" || tk == "]") {
        continue;
      }
      if (t[s].identifier) continue;
      valid = false;
      break;
    }
    if (!valid) continue;

    // 声明必须位于语句起始处，且左侧存在返回类型（或构造函数语境）
    size_t start = k;
    if (k > 0) {
      size_t p = k - 1;
      if (t[p].text == "operator") p = (p > 0) ? p - 1 : 0;
      while (p > 0 && t[p].text != ";" && t[p].text != "{" && t[p].text != "}" &&
             t[p].text != ":" && t[p].braceDepth == t[k].braceDepth) {
        --p;
      }
      start = (t[p].text == ";" || t[p].text == "{" || t[p].text == "}" || t[p].text == ":") ? p + 1 : p;
    }

    bool hasTypePart = false;
    bool hasExpressionMarker = false;
    if (start < k) {
      for (size_t s = start; s < k; ++s) {
        const std::string& tk = t[s].text;
        if (tk == "(" || tk == ")" || tk == "[" || tk == "]") { hasExpressionMarker = true; break; }
        if (tk == "=" && t[s].braceDepth == t[k].braceDepth) { hasExpressionMarker = true; break; }
        if (t[s].identifier) hasTypePart = true;
      }
    }

    // —— 反例排除：挡住「看起来像声明、其实是调用/表达式」的情况 ——
    // 实测踩出来的两个例子：
    //   `return app.start(args);`      → 被登记成函数声明 start（return/app 都是 identifier）
    //   `registry_->add(lastInput_);`  → 被登记成函数声明 add
    // 危害不只是多几个假节点：假节点是**无限定名**（或只带外层命名空间），
    // 会污染 funcByQual_ / funcByName_，让真正的 demo::Application::start
    // 再也匹配不上 —— 成员调用几乎全部失效，调用图和阅读路线都断链。
    //
    // 注意：这个循环里 `k` 是 **`(`** 的下标，函数名在 k-1，名字**前面**那个 token 在 k-2。
    // 1) 名字前是 `.` / `->`：成员访问（app.start / ptr->run），不是定义
    if (k >= 2 && (t[k - 2].text == "." || t[k - 2].text == "->")) continue;
    // 2) 语句起点到名字之间出现语句关键字（return / if / while / ...）：
    //    这些词不可能是返回类型，出现即说明这是语句而不是声明
    if (hasStatementKeyword(t, start, k + 1)) continue;
    // 构造函数： ClassName(...) 或 ClassName::ClassName(...)
    bool looksLikeCtor = false;
    {
      std::string simple = dn.name;
      if (!simple.empty() && simple[0] == '~') simple = simple.substr(1);
      const ClassRange* cls = innermostClass(classes, k);
      if (cls && simple == cls->name) looksLikeCtor = true;
      if (!looksLikeCtor && dn.qualified.find("::") != std::string::npos) {
        const std::string q = dn.qualified;
        const size_t pos = q.rfind("::");
        if (q.substr(pos + 2) == q.substr(0, q.find("::"))) looksLikeCtor = true;
      }
    }
    if (hasExpressionMarker) continue;
    if (!hasTypePart && !looksLikeCtor) continue;

    const std::string scope = enclosingScope(namespaces, classes, k);
    // 类内定义的成员：enclosingScope 已经把所属类算进去了；
    // 类外定义（A::B）的限定名已在 declarator 里，无需再叠加
    const std::string qualified = scope + dn.qualified;

    SymbolDef d;
    d.kind = NodeKind::Function;
    d.name = dn.name;
    d.qualifiedName = qualified;
    d.file = relPath;
    d.line = t[k].line;
    d.column = t[k].column;
    d.declaration = !isDefinition;
    d.signature = renderRange(t, start, static_cast<size_t>(close2));
    if (d.signature.size() > 400) d.signature.resize(400);
    d.id = makeNodeId(NodeKind::Function, qualified);

    // 函数体范围：既用来把调用边归到所属函数，也给出「这个函数有多大」。
    // 阅读路线的降噪靠它（纯转发 / 小函数不值得在清单里占一行）。
    // 必须放在 push 之前：bodyLines 属于这次解析出来的符号本身。
    if (isDefinition) {
      size_t braceIdx = scanFrom;
      // 定位 '{'
      while (braceIdx < n && t[braceIdx].text != "{") ++braceIdx;
      if (braceIdx < n) {
        const int bclose = matchBrace(t, braceIdx);
        if (bclose > 0) {
          d.bodyLines = t[bclose].line - t[braceIdx].line + 1;
          BodyRange br;
          br.open = braceIdx;
          br.close = static_cast<size_t>(bclose);
          br.ownerId = d.id;
          bodies.push_back(br);
        }
      }
    }

    // 同名只保留第一个定义（近似：不做重载签名区分）
    if (declaredIds.insert(qualified).second) {
      fa.symbols.push_back(d);
    } else if (!d.declaration) {
      for (SymbolDef& s : fa.symbols) {
        if (s.id != d.id) continue;
        s.declaration = false;
        s.signature = d.signature;
        // 体量以「有体的那一次」为准：先看到声明、后看到定义时也要拿到行数
        if (d.bodyLines > 0) s.bodyLines = d.bodyLines;
        break;
      }
    }

    k = static_cast<size_t>(close2);
  }

  // ---------- 全局 / 静态变量 ----------
  if (opts.symbols) {
    size_t stmtStart = 0;
    for (size_t k = 0; k < n; ++k) {
      if (t[k].braceDepth != 0) continue;
      const std::string& tk = t[k].text;
      if (tk == ";") {
        if (k > stmtStart) {
          bool ok = true;
          bool hasParen = false;
          bool hasBrace = false;
          for (size_t s = stmtStart; s < k; ++s) {
            const std::string& x = t[s].text;
            if (x == "(") hasParen = true;
            if (x == "{" || x == "}") hasBrace = true;
            if (s == stmtStart &&
                (x == "using" || x == "typedef" || x == "template" || x == "namespace" ||
                 x == "extern" || x == "class" || x == "struct" || x == "enum" || x == "union" ||
                 x == "return" || x == "friend")) {
              ok = false;
            }
          }
          if (ok && !hasParen && !hasBrace && (k - stmtStart) <= 24) {
            // 取最后一个标识符作为变量名
            size_t eq = k;
            for (size_t s = stmtStart; s < k; ++s) {
              if (t[s].text == "=" || t[s].text == "[") { eq = s; break; }
            }
            size_t nameIdx = std::string::npos;
            for (size_t s = eq; s-- > stmtStart;) {
              if (t[s].identifier && !isQualifierWord(t[s].text)) { nameIdx = s; break; }
            }
            if (nameIdx != std::string::npos && nameIdx > stmtStart) {
              const std::string name = t[nameIdx].text;
              SymbolDef d;
              d.kind = NodeKind::Variable;
              d.name = name;
              d.qualifiedName = enclosingScope(namespaces, classes, nameIdx) + name;
              d.file = relPath;
              d.line = t[nameIdx].line;
              d.column = t[nameIdx].column;
              d.signature = renderRange(t, stmtStart, k);
              if (d.signature.size() > 300) d.signature.resize(300);
              d.id = makeNodeId(NodeKind::Variable, d.qualifiedName);
              fa.symbols.push_back(d);
            }
          }
        }
        stmtStart = k + 1;
      } else if (tk == "{" || tk == "}") {
        stmtStart = k + 1;
      }
    }
  }

  // ---------- 类成员的类型依赖（Uses） ----------
  if (opts.types) {
    for (const ClassRange& c : classes) {
      const int bodyDepth = t[c.open].braceDepth + 1;
      const std::string ownerId =
          makeNodeId(NodeKind::Class, enclosingScope(namespaces, classes, c.open) + c.name);
      size_t stmtStart = c.open + 1;
      for (size_t k = c.open + 1; k < c.close; ++k) {
        if (t[k].braceDepth != bodyDepth) continue;
        const std::string& tk = t[k].text;
        if (tk == ";") {
          if (k > stmtStart) {
            bool hasParen = false;
            for (size_t s = stmtStart; s < k; ++s) {
              if (t[s].text == "(") { hasParen = true; break; }
            }
            const std::string head = t[stmtStart].text;
            const bool skip = hasParen || head == "using" || head == "typedef" || head == "friend" ||
                              head == "static_assert" || head == "template" || head == "return";
            if (!skip) {
              // 收集类型 token 链
              std::string typeExpr;
              int angle = 0;
              size_t lastIdent = std::string::npos;
              for (size_t s = stmtStart; s < k; ++s) {
                const std::string& x = t[s].text;
                if (x == "=") break;
                if (x == "<") ++angle;
                if (x == ">") { if (angle > 0) --angle; }
                if (t[s].identifier && !isQualifierWord(x)) lastIdent = s;
              }
              if (lastIdent != std::string::npos && lastIdent > stmtStart) {
                for (size_t s = stmtStart; s < lastIdent; ++s) {
                  const std::string& x = t[s].text;
                  if (t[s].identifier) typeExpr += x;
                  else if (x == "::" || x == "<" || x == ">" || x == ",") typeExpr += x;
                }
                std::string typeName = principalTypeName(typeExpr);
                if (!typeName.empty() && typeName != c.name && !isBuiltinType(typeName)) {
                  PendingRef ref;
                  ref.fromId = ownerId;
                  ref.name = typeName;
                  ref.kind = EdgeKind::Uses;
                  ref.file = relPath;
                  ref.line = t[lastIdent].line;
                  fa.refs.push_back(ref);
                }
              }
            }
          }
          stmtStart = k + 1;
        } else if (tk == "{" || tk == "}") {
          stmtStart = k + 1;
        } else if (tk == ":" && k > 0 &&
                   (t[k - 1].text == "public" || t[k - 1].text == "private" ||
                    t[k - 1].text == "protected")) {
          stmtStart = k + 1;
        }
      }
    }
  }

  // ---------- 函数体内的调用 ----------
  if (opts.calls) {
    // 用于快速判断 token 是否位于参数表中（排除声明）
    for (const BodyRange& body : bodies) {
      const int bodyDepth = t[body.open].braceDepth + 1;
      for (size_t k = body.open + 1; k < body.close; ++k) {
        if (!t[k].identifier) continue;
        if (isCppKeyword(t[k].text)) continue;
        if (t[k].braceDepth < bodyDepth) continue;
        if (k + 1 >= n || t[k + 1].text != "(") continue;

        // 名字链：A::B::C（"::" 是单个 token）
        std::string chain = t[k].text;
        size_t back = k;
        while (back >= 2 && t[back - 1].text == "::") {
          if (!t[back - 2].identifier) break;
          chain = t[back - 2].text + "::" + chain;
          back -= 2;
        }
        if (chain.rfind("std::", 0) == 0) continue;
        if (chain.rfind("std", 0) == 0 && chain.size() > 3 && chain[3] == ':') continue;

        // 排除紧跟返回类型的声明式调用：以语句起始 + 大写开头 视为构造/声明
        if (looksLikeDeclarationStart(t, back) && !chain.empty() &&
            isupper(static_cast<unsigned char>(chain[0]))) {
          continue;
        }

        PendingRef ref;
        ref.fromId = body.ownerId;
        ref.name = chain;
        ref.kind = EdgeKind::Calls;
        ref.file = relPath;
        ref.line = t[k].line;
        fa.refs.push_back(ref);
      }
    }
  }

  // ---------- 宏 / 常量符号引用 ----------
  if (opts.symbols) {
    std::set<std::string> emitted;
    for (size_t k = 0; k < n; ++k) {
      if (!t[k].identifier) continue;
      const std::string& s = t[k].text;
      if (s.size() < 2) continue;
      bool allCaps = true;
      bool hasAlpha = false;
      for (char c : s) {
        if (c >= 'a' && c <= 'z') { allCaps = false; break; }
        if (c >= 'A' && c <= 'Z') hasAlpha = true;
      }
      if (!allCaps || !hasAlpha) continue;
      if (isCppKeyword(s)) continue;
      // #define 本身不在 token 流中（它属于指令），因此无需排除定义处
      if (!emitted.insert(s).second) continue;
      PendingRef ref;
      ref.fromId = fileId;
      ref.name = s;
      ref.kind = EdgeKind::Refs;
      ref.file = relPath;
      ref.line = t[k].line;
      fa.refs.push_back(ref);
    }
  }

  return fa;
}

}  // namespace depscan
