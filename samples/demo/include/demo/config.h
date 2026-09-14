#pragma once

// 公共配置：被大量文件包含，是 include 图的"枢纽"节点
#define DEMO_VERSION "0.1.0"
#define DEMO_MAX_ITEMS 256

namespace demo {

enum class Level { Trace, Info, Warning, Error };

struct Config {
  int maxItems = DEMO_MAX_ITEMS;
  bool verbose = false;
};

inline Config& config() {
  static Config instance;
  return instance;
}

}  // namespace demo
