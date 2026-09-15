#pragma once

#include <string>

#include "core/base.h"

namespace demo {
// 前置声明：为了在「循环包含」下也能编译，Engine 只用 Registry 的不完整类型。
// 这同时也表达了真实意图 —— Engine 需要 Registry，但不必在头文件层面依赖它的定义。
class Registry;
}  // namespace demo

// ⚠ 注意：这里故意与 core/registry.h 形成循环包含，
//   用于验证 DepScaner 对「循环依赖」的识别。
//   为了让循环包含在编译期也成立，成员用指针 + 上面的前置声明 ——
//   这样「engine.h 先被包含」与「registry.h 先被包含」两种顺序都能编译通过。
#include "core/registry.h"

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
  Registry* registry_ = nullptr;  // 指针：只需前置声明，循环包含也能编译
  std::string lastInput_;
};

}  // namespace demo
