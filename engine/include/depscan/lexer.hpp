// 轻量 C/C++ 词法与结构扫描（免配置、无外部依赖的 fallback 解析器）。
// 职责：剥离注释/字符串噪声，产出带位置信息的 token 流与预处理指令，
// 供 Analyzer 做 include / 调用 / 继承 / 类型 / 符号 五类结构级识别。
//
// 说明：本解析器只做「结构级」判断（近似精度 exact=false）。
// 需要精确语义（重载决议、模板实例化、宏展开后的真实包含）时，
// 应提供 compile_commands.json 并启用 libclang（见 clang_analyzer.cpp）。
#pragma once

#include <string>
#include <vector>

namespace depscan {

struct Token {
  std::string text;
  int line = 1;
  int column = 1;
  bool identifier = false;
  int parenDepth = 0;  // 该 token 之前的圆括号深度
  int braceDepth = 0;  // 该 token 之前的花括号深度
};

struct Directive {
  std::string name;  // include / define / ifdef ...
  std::string body;  // 指令剩余内容（续行已合并，首尾已 trim）
  int line = 1;
};

struct LexedFile {
  std::vector<Token> tokens;
  std::vector<Directive> directives;
  std::vector<std::pair<std::string, int>> includes;  // include 目标 + 行号
  std::vector<std::string> macroNames;                // 本文件 #define 的宏
  int lines = 1;
};

bool isCppKeyword(const std::string& s);
LexedFile lex(const std::string& source);

}  // namespace depscan
