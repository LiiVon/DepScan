#include "core/registry.h"

#include "ui/panel.h"
#include "util/logger.h"

namespace demo {

void Registry::add(const std::string& name) {
  items_.emplace_back(name);
  if (lastPanel_ != nullptr) {
    lastPanel_->render(static_cast<int>(items_.size()));
  }
  logLine(Level::Trace, "registry add");
}

size_t Registry::size() const { return items_.size(); }

}  // namespace demo
