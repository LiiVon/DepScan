#pragma once

#include <string>

namespace libdemo {

// 公开接口：把两段文本用分隔符连起来。
// 它调用了 src/internal.h 里的内部辅助 —— 演示「公开面也可以是调用图上的根」。
std::string join(const std::string& a, const std::string& b, char sep);

}  // namespace libdemo
