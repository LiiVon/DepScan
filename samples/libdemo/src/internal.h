#pragma once

namespace libdemo {

// 内部辅助：声明在 src/ 下（不是 include/），所以**不算公开面**。
// 它只是个被调用的工具函数，不该被推荐成「从哪读起」。
bool isBlank(char c);

}  // namespace libdemo
