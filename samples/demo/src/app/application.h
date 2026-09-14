#pragma once

#include <string>

#include "core/engine.h"
#include "ui/panel.h"

namespace demo {

// 应用层：编排 core 与 ui
class Application {
 public:
  Application();

  int start(const std::string& args);

 private:
  Engine engine_;
  Panel panel_;
};

}  // namespace demo
