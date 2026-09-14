#include "ui/panel.h"

#include "core/registry.h"
#include "util/logger.h"
#include "util/string_utils.h"

namespace demo {

Panel::Panel(std::string title) : title_(std::move(title)) {
  logLine(Level::Info, "Panel " + title_);
}

void Panel::render(int itemCount) {
  const std::string line = title_ + ": " + std::to_string(itemCount);
  logLine(Level::Trace, trim(line));
}

}  // namespace demo
