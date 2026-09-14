#include "util/logger.h"

#include "demo/config.h"

namespace demo {

void logLine(Level level, const std::string& message) {
  if (!config().verbose && level == Level::Trace) return;
  // 简化实现：真实项目这里会写入控制台/文件
  (void)levelName(level);
  (void)message;
}

void setVerbose(bool verbose) { config().verbose = verbose; }

std::string levelName(Level level) {
  switch (level) {
    case Level::Trace: return "TRACE";
    case Level::Info: return "INFO";
    case Level::Warning: return "WARN";
    case Level::Error: return "ERROR";
  }
  return "?";
}

}  // namespace demo
