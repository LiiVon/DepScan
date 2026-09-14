#pragma once

#include <string>
#include <utility>
#include <vector>

namespace demo {

// 基础层：只应被上层依赖，不应反向依赖 ui/app
class Item {
 public:
  Item() = default;
  explicit Item(std::string name) : name_(std::move(name)) {}

  const std::string& name() const { return name_; }

 private:
  std::string name_;
};

class Base {
 public:
  virtual ~Base() = default;
  virtual void reset() = 0;
  virtual std::string describe() const = 0;
};

}  // namespace demo
