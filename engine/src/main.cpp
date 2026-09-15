// DepScan 分析引擎入口。
//
// 两种运行模式：
//   1) stdio 服务模式（默认）：VS Code 插件以子进程方式启动，逐行 JSON-RPC 通信。
//   2) 一次性模式（--once --root <dir>）：输出全量图 JSON，便于 CLI 调试与自测。
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

#include "depscan/rpc.hpp"
#include "depscan/util.hpp"

namespace {

void printUsage() {
  std::printf(
      "DepScan core (依赖分析引擎)\n"
      "\n"
      "用法：\n"
      "  depscan-core                      启动 stdio JSON-RPC 服务（供 VS Code 插件使用）\n"
      "  depscan-core --once --root <dir>  扫描一次并输出 JSON\n"
      "  depscan-core --version            输出版本\n"
      "  depscan-core --help               显示帮助\n"
      "\n"
      "选项：\n"
      "  --root <dir>    项目根目录（默认当前目录）\n"
      "  --pretty        JSON 输出带缩进（仅 --once）\n"
      "  --jobs <n>      解析线程数（仅 --once）—— 排障用，设为 1 可排除并发问题\n"
      "  --trace         每个文件都打一行到 stderr（仅 --once）—— 崩溃时最后一行就是元凶文件\n"
      "  --violations    只输出架构边界违规（仅 --once）—— 公开头文件引用内部实现 / 目录成环，\n"
      "                  可以直接进 CI：有违规时退出码为 1\n");
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  // stdio 二进制模式：避免 CRLF 转换破坏行分隔的 JSON 协议
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  SetConsoleOutputCP(CP_UTF8);
#endif

  bool once = false;
  bool pretty = false;
  bool trace = false;
  bool violationsOnly = false;
  int jobs = 0;
  std::string root;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--once" || arg == "--scan") {
      once = true;
    } else if (arg == "--pretty") {
      pretty = true;
    } else if (arg == "--trace") {
      trace = true;
    } else if (arg == "--violations") {
      violationsOnly = true;
      once = true;   // 检查也是一次性扫描，不用再写一遍 --once
    } else if (arg == "--jobs" && i + 1 < argc) {
      jobs = std::atoi(argv[++i]);
    } else if (arg == "--root" && i + 1 < argc) {
      root = argv[++i];
    } else if (arg == "--version" || arg == "-v") {
      std::printf("depscan-core 0.1.0\n");
      return 0;
    } else if (arg == "--help" || arg == "-h") {
      printUsage();
      return 0;
    } else if (!arg.empty() && arg[0] != '-') {
      root = arg;
    }
  }

  if (root.empty()) {
    root = ".";
  }
  root = depscan::util::normalizePath(root);

  // 顶层兜底：主线程里任何逸出的异常都不应该变成「进程异常退出」
  // （子线程里的兜底在 rpc.cpp / scanner.cpp 各有一处）。
  try {
    if (once) {
      return depscan::runOnce(root, pretty, jobs, trace, violationsOnly);
    }
    return depscan::runStdioServer();
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[DepScan] 致命错误: %s\n", e.what());
    std::fflush(stderr);
    return 2;
  } catch (...) {
    std::fprintf(stderr, "[DepScan] 致命错误: 未知异常\n");
    std::fflush(stderr);
    return 2;
  }
}
