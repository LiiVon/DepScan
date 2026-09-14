#include "depscan/lexer.hpp"

#include <algorithm>
#include <cctype>
#include <map>

#include "depscan/util.hpp"

namespace depscan {

namespace {

inline bool isIdentStart(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' ||
         static_cast<unsigned char>(c) >= 0x80;  // 放宽以容纳 UTF-8 标识符
}

inline bool isIdentChar(char c) {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

inline bool isDigit(char c) { return c >= '0' && c <= '9'; }

bool isStringPrefix(const std::string& w) {
  static const char* kPrefixes[] = {"u8", "u", "U", "L", "R", "u8R", "uR", "UR", "LR"};
  for (const char* p : kPrefixes) {
    if (w == p) return true;
  }
  return false;
}

const char* kKeywords[] = {
    "alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char",
    "char16_t", "char32_t", "char8_t", "class", "co_await", "co_return", "co_yield", "concept",
    "const", "consteval", "constexpr", "constinit", "const_cast", "continue", "decltype",
    "default", "delete", "do", "double", "dynamic_cast", "else", "enum", "explicit", "export",
    "extern", "false", "final", "float", "for", "friend", "goto", "if", "inline", "int", "long",
    "mutable", "namespace", "new", "noexcept", "not", "nullptr", "operator", "or", "override",
    "private", "protected", "public", "register", "reinterpret_cast", "requires", "return",
    "short", "signed", "sizeof", "static", "static_assert", "static_cast", "struct", "switch",
    "template", "this", "thread_local", "throw", "true", "try", "typedef", "typeid", "typename",
    "union", "unsigned", "using", "virtual", "void", "volatile", "wchar_t", "while", "xor"};

}  // namespace

bool isCppKeyword(const std::string& s) {
  for (const char* k : kKeywords) {
    if (s == k) return true;
  }
  return false;
}

LexedFile lex(const std::string& src) {
  LexedFile out;
  const size_t n = src.size();
  size_t i = 0;
  int line = 1;
  int col = 1;
  int paren = 0;
  int brace = 0;
  bool atLineStart = true;
  std::map<std::string, std::string> macroValues;  // 宏名 -> 头文件名（用于 #include 宏展开）

  auto emit = [&](std::string text, bool isIdent, int tline, int tcol) {
    Token t;
    t.text = std::move(text);
    t.line = tline;
    t.column = tcol;
    t.identifier = isIdent;
    t.parenDepth = paren;
    t.braceDepth = brace;
    out.tokens.push_back(std::move(t));
  };

  while (i < n) {
    const char c = src[i];

    // 反斜杠续行
    if (c == '\\') {
      if (i + 1 < n && src[i + 1] == '\n') { i += 2; ++line; col = 1; continue; }
      if (i + 2 < n && src[i + 1] == '\r' && src[i + 2] == '\n') { i += 3; ++line; col = 1; continue; }
    }
    if (c == '\r') { ++i; continue; }
    if (c == '\n') { ++i; ++line; col = 1; atLineStart = true; continue; }
    if (c == ' ' || c == '\t' || c == '\f' || c == '\v') { ++i; ++col; continue; }

    // 注释
    if (c == '/' && i + 1 < n && src[i + 1] == '/') {
      while (i < n && src[i] != '\n') ++i;
      continue;
    }
    if (c == '/' && i + 1 < n && src[i + 1] == '*') {
      i += 2;
      col += 2;
      while (i < n) {
        if (src[i] == '*' && i + 1 < n && src[i + 1] == '/') { i += 2; col += 2; break; }
        if (src[i] == '\n') { ++line; col = 1; ++i; continue; }
        ++i;
        ++col;
      }
      continue;
    }

    // 预处理指令
    if (c == '#' && atLineStart) {
      const int dline = line;
      ++i;
      ++col;
      std::string name;
      while (i < n && isIdentChar(src[i])) { name += src[i]; ++i; ++col; }
      std::string body;
      while (i < n) {
        if (src[i] == '\n') break;
        if (src[i] == '\\' &&
            (i + 1 < n && (src[i + 1] == '\n' || src[i + 1] == '\r'))) {
          body += ' ';
          if (src[i + 1] == '\r' && i + 2 < n && src[i + 2] == '\n') i += 3;
          else i += 2;
          ++line;
          col = 1;
          continue;
        }
        if (src[i] == '\r') { ++i; continue; }
        body += src[i];
        ++i;
        ++col;
      }
      // 去掉行内注释
      const size_t slash = body.find("//");
      if (slash != std::string::npos) body = body.substr(0, slash);
      const size_t bslash = body.find("/*");
      if (bslash != std::string::npos) body = body.substr(0, bslash);
      body = util::trim(body);

      out.directives.push_back(Directive{name, body, dline});

      if (name == "include" && !body.empty()) {
        std::string target;
        const char first = body[0];
        if (first == '"' || first == '<') {
          const char close = first == '"' ? '"' : '>';
          const size_t e = body.find(close, 1);
          if (e != std::string::npos) target = body.substr(1, e - 1);
        } else {
          size_t q = 0;
          while (q < body.size() && isIdentChar(body[q])) { target += body[q]; ++q; }
        }
        // 宏展开： #define X "a.h"  /  #define X <a.h>  /  #define X Y
        for (int guard = 0; guard < 4; ++guard) {
          auto it = macroValues.find(target);
          if (it == macroValues.end()) break;
          target = it->second;
        }
        if (!target.empty()) out.includes.emplace_back(target, dline);
      } else if (name == "define" && !body.empty()) {
        std::string macro;
        size_t q = 0;
        while (q < body.size() && isIdentChar(body[q])) { macro += body[q]; ++q; }
        if (!macro.empty()) {
          out.macroNames.push_back(macro);
          std::string rest = util::trim(body.substr(q));
          if (!rest.empty() && rest[0] == '(' && body.size() > q && body[q] == '(') {
            // 函数宏：跳过参数列表
            int depth = 0;
            size_t r = 0;
            for (; r < rest.size(); ++r) {
              if (rest[r] == '(') ++depth;
              else if (rest[r] == ')') {
                if (--depth == 0) { ++r; break; }
              }
            }
            rest = util::trim(rest.substr(r));
          }
          // 记录唯一可解析为头文件名的宏值
          if (!rest.empty() && (rest[0] == '"' || rest[0] == '<')) {
            const char close = rest[0] == '"' ? '"' : '>';
            const size_t e = rest.find(close, 1);
            if (e != std::string::npos) macroValues[macro] = rest.substr(1, e - 1);
          } else if (!rest.empty()) {
            std::string alias;
            size_t r = 0;
            while (r < rest.size() && isIdentChar(rest[r])) { alias += rest[r]; ++r; }
            if (!alias.empty() && alias != macro) macroValues[macro] = alias;
          }
        }
      }
      continue;
    }

    // 标识符（含字符串前缀识别：u8 / u / U / L / R / u8R ...）
    if (isIdentStart(c)) {
      const int tline = line;
      const int tcol = col;
      std::string word;
      while (i < n && isIdentChar(src[i])) { word += src[i]; ++i; ++col; }

      if (i < n && src[i] == '"' && (isStringPrefix(word) || word.empty())) {
        const bool raw = !word.empty() && word.back() == 'R';
        ++i;
        ++col;  // 吃掉 "
        if (raw) {
          std::string delim;
          while (i < n && src[i] != '(' && delim.size() < 16) { delim += src[i]; ++i; ++col; }
          if (i < n && src[i] == '(') {
            ++i;
            ++col;
            const std::string terminator = ")" + delim + "\"";
            const size_t e = src.find(terminator, i);
            if (e == std::string::npos) {
              i = n;
            } else {
              for (size_t k = i; k < e + terminator.size(); ++k) {
                if (src[k] == '\n') { ++line; col = 1; }
                else ++col;
              }
              i = e + terminator.size();
            }
          }
        } else {
          while (i < n) {
            if (src[i] == '\\') { i += 2; col += 2; continue; }
            if (src[i] == '"') { ++i; ++col; break; }
            if (src[i] == '\n') { ++i; ++line; col = 1; continue; }
            ++i;
            ++col;
          }
        }
        emit("\"\"", false, tline, tcol);
        atLineStart = false;
        continue;
      }

      emit(word, true, tline, tcol);
      atLineStart = false;
      continue;
    }

    // 普通字符串（无前缀）
    if (c == '"') {
      const int tline = line;
      const int tcol = col;
      ++i;
      ++col;
      while (i < n) {
        if (src[i] == '\\') { i += 2; col += 2; continue; }
        if (src[i] == '"') { ++i; ++col; break; }
        if (src[i] == '\n') { ++i; ++line; col = 1; continue; }
        ++i;
        ++col;
      }
      emit("\"\"", false, tline, tcol);
      atLineStart = false;
      continue;
    }

    // 字符字面量
    if (c == '\'') {
      size_t j = i + 1;
      bool closed = false;
      if (j < n) {
        if (src[j] == '\\') j += 2;
        else ++j;
        if (j < n && src[j] == '\'') { closed = true; ++j; }
      }
      if (closed) {
        col += static_cast<int>(j - i);
        i = j;
        atLineStart = false;
        continue;
      }
    }

    // 数字字面量
    if (isDigit(c) || (c == '.' && i + 1 < n && isDigit(src[i + 1]))) {
      ++i;
      ++col;
      while (i < n) {
        const char d = src[i];
        if (isIdentChar(d) || d == '.' || d == '_') { ++i; ++col; continue; }
        if ((d == '+' || d == '-') && (src[i - 1] == 'e' || src[i - 1] == 'E' ||
                                       src[i - 1] == 'p' || src[i - 1] == 'P')) {
          ++i;
          ++col;
          continue;
        }
        break;
      }
      atLineStart = false;
      continue;
    }

    // 标点
    {
      const int tline = line;
      const int tcol = col;
      std::string p(1, c);
      if (c == ':' && i + 1 < n && src[i + 1] == ':') { p = "::"; i += 2; col += 2; }
      else { ++i; ++col; }
      if (p == ")") { if (paren > 0) --paren; }
      if (p == "}") { if (brace > 0) --brace; }
      emit(p, false, tline, tcol);
      if (p == "(") ++paren;
      if (p == "{") ++brace;
      atLineStart = false;
    }
  }

  out.lines = line;
  return out;
}

}  // namespace depscan
