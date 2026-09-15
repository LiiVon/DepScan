#pragma once

namespace libdemo {

// 公开接口：两数相加。
// 定义在 src/math.cpp —— 声明在 include/ 下，所以它属于「公开面」。
int add(int a, int b);

// 公开接口：求平均值（内部会用到 add）
double mean(const int* values, int count);

}  // namespace libdemo
