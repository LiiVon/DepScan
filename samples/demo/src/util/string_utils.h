#pragma once

#include <string>
#include <vector>

namespace demo {

std::string trim(const std::string& s);
std::vector<std::string> split(const std::string& s, char delimiter);
std::string join(const std::vector<std::string>& parts, const std::string& sep);

}  // namespace demo
