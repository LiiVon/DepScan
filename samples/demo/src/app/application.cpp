#include "app/application.h"

#include "util/logger.h"

namespace demo {

Application::Application() : panel_("DepScan Demo") {}

int Application::start(const std::string& args) {
  logLine(Level::Info, "Application start");
  const int count = engine_.run(args);
  panel_.render(count);
  return count;
}

}  // namespace demo
