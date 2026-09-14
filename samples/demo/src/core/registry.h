#pragma once

#include <string>
#include <vector>

#include "core/base.h"

// 分层违规示例：底层 core 反向依赖上层 ui
#include "ui/panel.h"

// 循环包含的另一半（见 core/engine.h 里的说明）
#include "core/engine.h"

namespace demo {

class Registry {
 public:
  void add(const std::string& name);
  size_t size() const;
  const std::vector<Item>& items() const { return items_; }

 private:
  std::vector<Item> items_;
  Panel* lastPanel_ = nullptr;  // 违规：底层持有上层类型
};

}  // namespace demo
