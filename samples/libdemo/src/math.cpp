#include "libdemo/math.h"

namespace libdemo {
namespace {

// 匿名命名空间的私有实现：连名字都不该出现在公开面上
int addImpl(int a, int b) { return a + b; }

}  // namespace

int add(int a, int b) {
  // 一行转发：正好也演示降噪会把这类函数折叠掉（它只有 1 行、只调一处）
  return addImpl(a, b);
}

double mean(const int* values, int count) {
  if (count <= 0 || values == nullptr) return 0.0;
  int total = 0;
  for (int i = 0; i < count; ++i) total = add(total, values[i]);
  return static_cast<double>(total) / count;
}

}  // namespace libdemo
