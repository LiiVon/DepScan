#include "libdemo/text.h"

#include "internal.h"

namespace libdemo {

bool isBlank(char c) { return c == ' ' || c == '\t' || c == '\n'; }

std::string join(const std::string& a, const std::string& b, char sep) {
  if (isBlank(sep)) sep = ',';
  if (a.empty()) return b;
  if (b.empty()) return a;
  return a + sep + b;
}

}  // namespace libdemo
