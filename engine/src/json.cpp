#include "depscan/json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <stdexcept>

namespace depscan::json {

const Value* Value::find(const std::string& key) const {
  if (type != Type::Object) return nullptr;
  for (const auto& kv : objectValue) {
    if (kv.first == key) return &kv.second;
  }
  return nullptr;
}

std::string Value::getString(const std::string& key, const std::string& fallback) const {
  const Value* v = find(key);
  return (v && v->isString()) ? v->stringValue : fallback;
}

double Value::getNumber(const std::string& key, double fallback) const {
  const Value* v = find(key);
  return (v && v->isNumber()) ? v->numberValue : fallback;
}

bool Value::getBool(const std::string& key, bool fallback) const {
  const Value* v = find(key);
  return (v && v->isBool()) ? v->boolValue : fallback;
}

std::vector<std::string> Value::getStringArray(const std::string& key) const {
  std::vector<std::string> out;
  const Value* v = find(key);
  if (!v || !v->isArray()) return out;
  for (const Value& item : v->arrayValue) {
    if (item.isString()) out.push_back(item.stringValue);
  }
  return out;
}

const Value* Value::getArray(const std::string& key) const {
  const Value* v = find(key);
  return (v && v->isArray()) ? v : nullptr;
}

void Value::set(const std::string& key, Value v) {
  if (type != Type::Object) {
    type = Type::Object;
    objectValue.clear();
  }
  for (auto& kv : objectValue) {
    if (kv.first == key) { kv.second = std::move(v); return; }
  }
  objectValue.emplace_back(key, std::move(v));
}

Value Value::makeObject() {
  Value v;
  v.type = Type::Object;
  return v;
}

Value Value::makeArray(std::vector<Value> items) {
  Value v;
  v.type = Type::Array;
  v.arrayValue = std::move(items);
  return v;
}

Value Value::makeString(std::string s) {
  Value v;
  v.type = Type::String;
  v.stringValue = std::move(s);
  return v;
}

Value Value::makeNumber(double d) {
  Value v;
  v.type = Type::Number;
  v.numberValue = d;
  return v;
}

Value Value::makeBool(bool b) {
  Value v;
  v.type = Type::Bool;
  v.boolValue = b;
  return v;
}

Value Value::makeInt(long long i) {
  return makeNumber(static_cast<double>(i));
}

// ------------------------------ 解析 ------------------------------

namespace {

constexpr int kMaxDepth = 64;

struct Parser {
  const std::string& s;
  size_t i = 0;
  int depth = 0;

  explicit Parser(const std::string& text) : s(text) {}

  [[noreturn]] void fail(const std::string& msg) {
    std::ostringstream oss;
    oss << "JSON 解析错误 @" << i << ": " << msg;
    throw std::runtime_error(oss.str());
  }

  void skipWs() {
    while (i < s.size()) {
      char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++i; continue; }
      break;
    }
  }

  char peek() {
    if (i >= s.size()) fail("意外的结尾");
    return s[i];
  }

  void expect(char c) {
    if (i >= s.size() || s[i] != c) fail(std::string("期望 '") + c + "'");
    ++i;
  }

  void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  unsigned readHex4() {
    unsigned v = 0;
    for (int k = 0; k < 4; ++k) {
      if (i >= s.size()) fail("\\u 转义不完整");
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
      else fail("非法的十六进制数字");
    }
    return v;
  }

  std::string parseString() {
    expect('"');
    std::string out;
    while (true) {
      if (i >= s.size()) fail("字符串未闭合");
      char c = s[i++];
      if (c == '"') break;
      if (c == '\\') {
        if (i >= s.size()) fail("转义未完成");
        char e = s[i++];
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            unsigned cp = readHex4();
            if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
              i += 2;
              unsigned lo = readHex4();
              if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              }
            }
            appendUtf8(out, cp);
            break;
          }
          default: fail("未知的转义字符");
        }
        continue;
      }
      out.push_back(c);
    }
    return out;
  }

  Value parseValue() {
    if (++depth > kMaxDepth) fail("嵌套过深");
    skipWs();
    char c = peek();
    Value v;
    if (c == '{') {
      v.type = Value::Type::Object;
      ++i;
      skipWs();
      if (i < s.size() && s[i] == '}') { ++i; --depth; return v; }
      while (true) {
        skipWs();
        std::string key = parseString();
        skipWs();
        expect(':');
        v.objectValue.emplace_back(std::move(key), parseValue());
        skipWs();
        if (i < s.size() && s[i] == ',') { ++i; continue; }
        expect('}');
        break;
      }
    } else if (c == '[') {
      v.type = Value::Type::Array;
      ++i;
      skipWs();
      if (i < s.size() && s[i] == ']') { ++i; --depth; return v; }
      while (true) {
        v.arrayValue.push_back(parseValue());
        skipWs();
        if (i < s.size() && s[i] == ',') { ++i; continue; }
        expect(']');
        break;
      }
    } else if (c == '"') {
      v.type = Value::Type::String;
      v.stringValue = parseString();
    } else if (c == 't') {
      if (s.compare(i, 4, "true") != 0) fail("非法字面量");
      i += 4;
      v.type = Value::Type::Bool;
      v.boolValue = true;
    } else if (c == 'f') {
      if (s.compare(i, 5, "false") != 0) fail("非法字面量");
      i += 5;
      v.type = Value::Type::Bool;
      v.boolValue = false;
    } else if (c == 'n') {
      if (s.compare(i, 4, "null") != 0) fail("非法字面量");
      i += 4;
      v.type = Value::Type::Null;
    } else {
      size_t start = i;
      if (c == '-' || c == '+') ++i;
      while (i < s.size() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' ||
                              s[i] == 'E' || s[i] == '+' || s[i] == '-')) {
        ++i;
      }
      if (i == start) fail("非法的值");
      v.type = Value::Type::Number;
      v.numberValue = std::strtod(s.substr(start, i - start).c_str(), nullptr);
    }
    --depth;
    return v;
  }
};

void escapeTo(std::string& out, const std::string& s) {
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          // UTF-8 多字节序列直接直通，避免二次编码
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

void numberTo(std::string& out, double d) {
  if (!std::isfinite(d)) { out += "0"; return; }
  if (d == static_cast<double>(static_cast<long long>(d)) && std::fabs(d) < 1e15) {
    out += std::to_string(static_cast<long long>(d));
    return;
  }
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%.10g", d);
  out += buf;
}

void dumpTo(std::string& out, const Value& v, bool pretty, int indent) {
  switch (v.type) {
    case Value::Type::Null: out += "null"; break;
    case Value::Type::Bool: out += v.boolValue ? "true" : "false"; break;
    case Value::Type::Number: numberTo(out, v.numberValue); break;
    case Value::Type::String: escapeTo(out, v.stringValue); break;
    case Value::Type::Array: {
      if (v.arrayValue.empty()) { out += "[]"; break; }
      out.push_back('[');
      for (size_t k = 0; k < v.arrayValue.size(); ++k) {
        if (k) out.push_back(',');
        if (pretty) {
          out.push_back('\n');
          out.append(static_cast<size_t>(indent + 1) * 2, ' ');
        }
        dumpTo(out, v.arrayValue[k], pretty, indent + 1);
      }
      if (pretty) {
        out.push_back('\n');
        out.append(static_cast<size_t>(indent) * 2, ' ');
      }
      out.push_back(']');
      break;
    }
    case Value::Type::Object: {
      if (v.objectValue.empty()) { out += "{}"; break; }
      out.push_back('{');
      for (size_t k = 0; k < v.objectValue.size(); ++k) {
        if (k) out.push_back(',');
        if (pretty) {
          out.push_back('\n');
          out.append(static_cast<size_t>(indent + 1) * 2, ' ');
        }
        escapeTo(out, v.objectValue[k].first);
        out.push_back(':');
        if (pretty) out.push_back(' ');
        dumpTo(out, v.objectValue[k].second, pretty, indent + 1);
      }
      if (pretty) {
        out.push_back('\n');
        out.append(static_cast<size_t>(indent) * 2, ' ');
      }
      out.push_back('}');
      break;
    }
  }
}

}  // namespace

Value parse(const std::string& text) {
  Parser p(text);
  Value v = p.parseValue();
  p.skipWs();
  if (p.i != text.size()) p.fail("结尾存在多余内容");
  return v;
}

std::string dump(const Value& v, bool pretty) {
  std::string out;
  out.reserve(1024);
  dumpTo(out, v, pretty, 0);
  return out;
}

}  // namespace depscan::json
