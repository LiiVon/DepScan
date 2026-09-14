#pragma once

#include <string>

namespace demo {

// 上层 UI：可以依赖 core，但 core 不应依赖它
class Panel {
 public:
  explicit Panel(std::string title);
  void render(int itemCount);
  const std::string& title() const { return title_; }

 private:
  std::string title_;
};

}  // namespace demo
