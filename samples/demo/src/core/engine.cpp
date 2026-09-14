#include "core/engine.h"

#include "util/logger.h"
#include "util/string_utils.h"

namespace demo {

Engine::Engine() { logLine(Level::Info, "Engine created"); }

Engine::~Engine() { logLine(Level::Info, "Engine destroyed"); }

void Engine::reset() {
  registry_.items();  // 触发一次访问
  lastInput_.clear();
}

std::string Engine::describe() const {
  return join(split(lastInput_, ' '), "+");
}

int Engine::run(const std::string& input) {
  lastInput_ = trim(input);
  registry_.add(lastInput_);
  logLine(Level::Trace, describe());
  return static_cast<int>(registry_.size());
}

int Engine::itemCount() const { return static_cast<int>(registry_.size()); }

}  // namespace demo
