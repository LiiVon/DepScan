#pragma once

#include <string>

// 注意：这里故意与 core/registry.h 形成循环包含，用于验证 DepScan 对循环依赖的识别
#include "core/registry.h"

#include "core/base.h"

namespace demo {

class Engine : public Base {
 public:
  Engine();
  ~Engine() override;

  void reset() override;
  std::string describe() const override;

  int run(const std::string& input);
  int itemCount() const;

 private:
  Registry registry_;
  std::string lastInput_;
};

}  // namespace demo
