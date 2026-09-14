#pragma once

#include <string>

#include "demo/config.h"

namespace demo {

// 日志：底层工具，被几乎所有模块调用
void logLine(Level level, const std::string& message);
void setVerbose(bool verbose);
std::string levelName(Level level);

}  // namespace demo
