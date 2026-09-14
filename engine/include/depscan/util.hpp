#pragma once

#include <string>
#include <vector>
#include <cstdint>

namespace depscan::util {

std::string readFile(const std::string& path);
bool writeFile(const std::string& path, const std::string& data);
bool fileExists(const std::string& path);
bool isDirectory(const std::string& path);
int64_t fileSize(const std::string& path);

std::string joinPath(const std::string& a, const std::string& b);
std::string normalizePath(std::string p);          // 统一为正斜杠并折叠 . / ..
std::string dirName(const std::string& p);
std::string baseName(const std::string& p);
std::string extensionOf(const std::string& p);     // 含点，小写
std::string relativeTo(const std::string& root, const std::string& path);

std::string lower(std::string s);
std::string trim(const std::string& s);
std::vector<std::string> split(const std::string& s, char delim);
bool startsWith(const std::string& s, const std::string& prefix);
bool endsWith(const std::string& s, const std::string& suffix);
bool contains(const std::string& s, const std::string& sub);

// glob：支持 ** * ? 与 {a,b} 花括号展开；'**' 可跨越路径分隔符，'*' 不跨越。
bool globMatch(const std::string& pattern, const std::string& path);
bool globMatchAny(const std::vector<std::string>& patterns, const std::string& path);

// 目录递归遍历（不跟随符号链接），返回绝对路径列表。
std::vector<std::string> listFilesRecursive(const std::string& root,
                                            const std::vector<std::string>& includeGlobs,
                                            const std::vector<std::string>& excludeGlobs,
                                            size_t maxFiles);

uint64_t hashString(const std::string& s);

}  // namespace depscan::util
