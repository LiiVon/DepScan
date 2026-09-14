// 极简 JSON 解析 / 序列化。
// 之所以自带而不引入第三方：引擎要保证「下载即用」，零外部依赖；
// 同时需要严格控制输出字节（UTF-8 直通 + LF 行分隔），便于 stdio JSON-RPC。
#pragma once

#include <string>
#include <vector>
#include <utility>

namespace depscan::json {

struct Value {
  enum class Type { Null, Bool, Number, String, Array, Object };

  Type type = Type::Null;
  bool boolValue = false;
  double numberValue = 0.0;
  std::string stringValue;
  std::vector<Value> arrayValue;
  std::vector<std::pair<std::string, Value>> objectValue;

  bool isNull() const { return type == Type::Null; }
  bool isObject() const { return type == Type::Object; }
  bool isArray() const { return type == Type::Array; }
  bool isString() const { return type == Type::String; }
  bool isNumber() const { return type == Type::Number; }
  bool isBool() const { return type == Type::Bool; }

  const Value* find(const std::string& key) const;
  std::string getString(const std::string& key, const std::string& fallback = {}) const;
  double getNumber(const std::string& key, double fallback = 0) const;
  bool getBool(const std::string& key, bool fallback = false) const;
  std::vector<std::string> getStringArray(const std::string& key) const;
  const Value* getArray(const std::string& key) const;
  void set(const std::string& key, Value v);

  static Value makeObject();
  static Value makeArray(std::vector<Value> items);
  static Value makeString(std::string s);
  static Value makeNumber(double d);
  static Value makeBool(bool b);
  static Value makeInt(long long v);
};

// 解析失败抛 std::runtime_error（含偏移量信息）。
Value parse(const std::string& text);
std::string dump(const Value& v, bool pretty = false);

}  // namespace depscan::json
