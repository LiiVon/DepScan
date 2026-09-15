#pragma once

#include <filesystem>
#include <string>
#include <vector>
#include <cstdint>

namespace depscan::util {

// ── 路径字符串 ↔ std::filesystem::path：**只走 UTF-8** ──
// 引擎内部所有路径字符串都是 UTF-8（跨进程协议也是 UTF-8），而 Windows 上
// std::filesystem::path 存的是宽字符、MSVC 默认按**进程 ANSI 代码页**（中文机器 = 936/GBK）
// 与窄字符串互转。于是名字里只要有一个 GBK 表示不了的字符（emoji / 日文 / 部分中文组合），
// 轻则 fs::exists 与 ifstream 静默失败，重则直接抛
// "No mapping for the Unicode character exists in the target multi-byte code page"。
// 所以**所有**碰文件系统的地方都要过这两个函数，不要直接写 fs::path(str) / path.string()。
// 另有第二道保险：resources/utf8-app.manifest 把进程的 ANSI 代码页设成 UTF-8。
std::filesystem::path toFsPath(const std::string& utf8Path);
std::string fromFsPath(const std::filesystem::path& p);

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
