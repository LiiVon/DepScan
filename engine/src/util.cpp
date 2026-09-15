#include "depscan/util.hpp"

#include "depscan/types.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <system_error>

#ifdef _WIN32
#include <windows.h>  // MultiByteToWideChar / WideCharToMultiByte（见 toFsPath 的说明）
#endif

namespace fs = std::filesystem;

namespace depscan {

const char* toString(NodeKind k) {
  switch (k) {
    case NodeKind::File: return "file";
    case NodeKind::Function: return "function";
    case NodeKind::Class: return "class";
    case NodeKind::Enum: return "enum";
    case NodeKind::Variable: return "variable";
    case NodeKind::Macro: return "macro";
    case NodeKind::Target: return "target";
    default: return "unknown";
  }
}

const char* toString(EdgeKind k) {
  switch (k) {
    case EdgeKind::Includes: return "includes";
    case EdgeKind::Calls: return "calls";
    case EdgeKind::Inherits: return "inherits";
    case EdgeKind::Uses: return "uses";
    case EdgeKind::Refs: return "refs";
    case EdgeKind::Links: return "links";
    default: return "refs";
  }
}

const char* toString(Precision p) {
  return p == Precision::Exact ? "exact" : "approx";
}

bool parseNodeKind(const std::string& s, NodeKind& out) {
  static const struct { const char* n; NodeKind k; } table[] = {
      {"file", NodeKind::File},     {"function", NodeKind::Function},
      {"class", NodeKind::Class},   {"enum", NodeKind::Enum},
      {"variable", NodeKind::Variable}, {"macro", NodeKind::Macro},
      {"target", NodeKind::Target},
  };
  for (const auto& e : table) {
    if (s == e.n) { out = e.k; return true; }
  }
  return false;
}

bool parseEdgeKind(const std::string& s, EdgeKind& out) {
  static const struct { const char* n; EdgeKind k; } table[] = {
      {"includes", EdgeKind::Includes}, {"calls", EdgeKind::Calls},
      {"inherits", EdgeKind::Inherits}, {"uses", EdgeKind::Uses},
      {"refs", EdgeKind::Refs},         {"links", EdgeKind::Links},
  };
  for (const auto& e : table) {
    if (s == e.n) { out = e.k; return true; }
  }
  return false;
}

bool parseDirection(const std::string& s, Direction& out) {
  if (s == "both") { out = Direction::Both; return true; }
  if (s == "upstream") { out = Direction::Upstream; return true; }
  if (s == "downstream") { out = Direction::Downstream; return true; }
  return false;
}

std::string kindPrefix(NodeKind kind) {
  switch (kind) {
    case NodeKind::File: return "file";
    case NodeKind::Function: return "func";
    case NodeKind::Class: return "class";
    case NodeKind::Enum: return "enum";
    case NodeKind::Variable: return "var";
    case NodeKind::Macro: return "macro";
    case NodeKind::Target: return "target";
    default: return "unknown";
  }
}

std::string makeNodeId(NodeKind kind, const std::string& key) {
  return kindPrefix(kind) + ":" + key;
}

std::string makeExternalId(NodeKind kind, const std::string& name) {
  return "ext:" + std::string(toString(kind)) + ":" + name;
}

bool isSourceExtension(const std::string& ext) {
  return ext == ".c" || ext == ".cc" || ext == ".cpp" || ext == ".cxx" ||
         ext == ".c++" || ext == ".inl" || ext == ".ipp" || ext == ".tcc";
}

bool isHeaderExtension(const std::string& ext) {
  return ext == ".h" || ext == ".hh" || ext == ".hpp" || ext == ".hxx" ||
         ext == ".h++" || ext == ".inc";
}

}  // namespace depscan

namespace depscan::util {

namespace {

#ifdef _WIN32
// UTF-8 ↔ UTF-16：**明确指定 CP_UTF8**，绝不依赖进程 ANSI 代码页。
std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  const int len = static_cast<int>(s.size());
  const int n = ::MultiByteToWideChar(CP_UTF8, 0, s.data(), len, nullptr, 0);
  if (n <= 0) return {};
  std::wstring w(static_cast<size_t>(n), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, s.data(), len, w.data(), n);
  return w;
}

std::string wideToUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  const int len = static_cast<int>(w.size());
  const int n = ::WideCharToMultiByte(CP_UTF8, 0, w.data(), len, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string s(static_cast<size_t>(n), '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, w.data(), len, s.data(), n, nullptr, nullptr);
  return s;
}
#endif

}  // namespace

fs::path toFsPath(const std::string& utf8Path) {
#ifdef _WIN32
  return fs::path(utf8ToWide(utf8Path));
#else
  return fs::path(utf8Path);  // POSIX 上 path 就是字节串，本来就是 UTF-8
#endif
}

std::string fromFsPath(const fs::path& p) {
#ifdef _WIN32
  return wideToUtf8(p.native());
#else
  return p.native();
#endif
}

std::string readFile(const std::string& path) {
  // 用 path 重载打开（Windows 上走宽字符 API），窄字符串重载是按 ANSI 打开的
  std::ifstream in(toFsPath(path), std::ios::binary);
  if (!in) return {};
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

bool writeFile(const std::string& path, const std::string& data) {
  std::ofstream out(toFsPath(path), std::ios::binary | std::ios::trunc);
  if (!out) return false;
  out.write(data.data(), static_cast<std::streamsize>(data.size()));
  return static_cast<bool>(out);
}

bool fileExists(const std::string& path) {
  std::error_code ec;
  return fs::exists(toFsPath(path), ec);
}

bool isDirectory(const std::string& path) {
  std::error_code ec;
  return fs::is_directory(toFsPath(path), ec);
}

int64_t fileSize(const std::string& path) {
  std::error_code ec;
  auto s = fs::file_size(toFsPath(path), ec);
  return ec ? -1 : static_cast<int64_t>(s);
}

std::string joinPath(const std::string& a, const std::string& b) {
  if (a.empty()) return b;
  if (b.empty()) return a;
  char last = a.back();
  if (last == '/' || last == '\\') return a + b;
  return a + "/" + b;
}

std::string normalizePath(std::string p) {
  for (char& c : p) {
    if (c == '\\') c = '/';
  }
  const bool absolute = !p.empty() && p[0] == '/';
  std::vector<std::string> segs;
  std::string cur;
  for (char c : p) {
    if (c == '/') {
      if (!cur.empty()) { segs.push_back(cur); cur.clear(); }
    } else {
      cur.push_back(c);
    }
  }
  if (!cur.empty()) segs.push_back(cur);

  std::vector<std::string> out;
  for (const std::string& s : segs) {
    if (s == ".") continue;
    if (s == "..") {
      if (!out.empty() && out.back() != "..") out.pop_back();
      else out.push_back("..");
      continue;
    }
    out.push_back(s);
  }
  std::string r;
  for (size_t i = 0; i < out.size(); ++i) {
    if (i) r += '/';
    r += out[i];
  }
  if (absolute) r.insert(r.begin(), '/');
  return r;
}

std::string dirName(const std::string& p) {
  size_t pos = p.find_last_of('/');
  if (pos == std::string::npos) return {};
  if (pos == 0) return "/";
  return p.substr(0, pos);
}

std::string baseName(const std::string& p) {
  size_t pos = p.find_last_of('/');
  return pos == std::string::npos ? p : p.substr(pos + 1);
}

std::string extensionOf(const std::string& p) {
  std::string b = baseName(p);
  size_t pos = b.find_last_of('.');
  if (pos == std::string::npos) return {};
  return lower(b.substr(pos));
}

std::string relativeTo(const std::string& root, const std::string& path) {
  std::string r = normalizePath(root);
  std::string p = normalizePath(path);
  if (r.empty()) return p;
  if (r.back() != '/') r += '/';
  if (lower(p).rfind(lower(r), 0) == 0) return p.substr(r.size());
  return p;
}

std::string lower(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::string trim(const std::string& s) {
  size_t b = 0;
  size_t e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n')) ++b;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n')) --e;
  return s.substr(b, e - b);
}

std::vector<std::string> split(const std::string& s, char delim) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : s) {
    if (c == delim) { out.push_back(cur); cur.clear(); }
    else cur.push_back(c);
  }
  out.push_back(cur);
  return out;
}

bool startsWith(const std::string& s, const std::string& prefix) {
  return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

bool endsWith(const std::string& s, const std::string& suffix) {
  return s.size() >= suffix.size() &&
         s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool contains(const std::string& s, const std::string& sub) {
  return s.find(sub) != std::string::npos;
}

// ---------------- glob ----------------

namespace {

void expandBraces(const std::string& pattern, std::vector<std::string>& out, int depth) {
  if (depth > 8) { out.push_back(pattern); return; }
  size_t open = pattern.find('{');
  if (open == std::string::npos) { out.push_back(pattern); return; }
  int level = 0;
  size_t close = std::string::npos;
  std::vector<size_t> commas;
  for (size_t i = open; i < pattern.size(); ++i) {
    if (pattern[i] == '{') ++level;
    else if (pattern[i] == '}') {
      if (--level == 0) { close = i; break; }
    } else if (pattern[i] == ',' && level == 1) {
      commas.push_back(i);
    }
  }
  if (close == std::string::npos) { out.push_back(pattern); return; }
  const std::string prefix = pattern.substr(0, open);
  const std::string suffix = pattern.substr(close + 1);
  std::vector<size_t> bounds{open};
  bounds.insert(bounds.end(), commas.begin(), commas.end());
  bounds.push_back(close);
  for (size_t i = 0; i + 1 < bounds.size(); ++i) {
    std::string part = pattern.substr(bounds[i] + 1, bounds[i + 1] - bounds[i] - 1);
    expandBraces(prefix + part + suffix, out, depth + 1);
  }
}

char slash(char c) { return c == '\\' ? '/' : c; }

bool matchHere(const char* p, const char* pe, const char* s, const char* se) {
  while (p < pe) {
    if (*p == '*') {
      const bool doubleStar = (p + 1 < pe && *(p + 1) == '*');
      if (doubleStar) {
        const char* np = p + 2;
        while (np < pe && *np == '*') ++np;
        if (np < pe && (*np == '/' || *np == '\\')) {
          // "**/" 可匹配零个或多个目录层级
          if (matchHere(np + 1, pe, s, se)) return true;
          for (const char* t = s; t < se; ++t) {
            if (*t == '/' || *t == '\\') {
              if (matchHere(np + 1, pe, t + 1, se)) return true;
            }
          }
          return false;
        }
        for (const char* t = s;; ++t) {
          if (matchHere(np, pe, t, se)) return true;
          if (t >= se) break;
        }
        return false;
      }
      const char* np = p + 1;
      for (const char* t = s;; ++t) {
        if (matchHere(np, pe, t, se)) return true;
        if (t >= se) break;
        if (*t == '/' || *t == '\\') break;
      }
      return false;
    }
    if (s >= se) return false;
    if (*p == '?') { ++p; ++s; continue; }
    if (slash(*p) != slash(*s)) return false;
    ++p;
    ++s;
  }
  return s == se;
}

bool matchOne(const std::string& pattern, const std::string& path) {
  return matchHere(pattern.data(), pattern.data() + pattern.size(),
                   path.data(), path.data() + path.size());
}

}  // namespace

bool globMatch(const std::string& pattern, const std::string& path) {
  std::vector<std::string> expanded;
  expandBraces(pattern, expanded, 0);
  const std::string p = normalizePath(path);
  for (const std::string& e : expanded) {
    if (matchOne(e, p)) return true;
  }
  return false;
}

bool globMatchAny(const std::vector<std::string>& patterns, const std::string& path) {
  for (const std::string& p : patterns) {
    if (globMatch(p, path)) return true;
  }
  return false;
}

namespace {

bool dirIsExcluded(const std::vector<std::string>& excludeGlobs, const std::string& relDir) {
  for (const std::string& g : excludeGlobs) {
    // 只利用 "xxx/**" 形式的模式做目录剪枝，避免误伤
    if (endsWith(g, "/**")) {
      const std::string head = g.substr(0, g.size() - 3);
      if (globMatch(head, relDir)) return true;
    } else if (globMatch(g, relDir)) {
      return true;
    }
  }
  return false;
}

}  // namespace

std::vector<std::string> listFilesRecursive(const std::string& root,
                                            const std::vector<std::string>& includeGlobs,
                                            const std::vector<std::string>& excludeGlobs,
                                            size_t maxFiles) {
  std::vector<std::string> files;
  const std::string rootNorm = normalizePath(root);
  std::error_code ec;
  fs::recursive_directory_iterator it(toFsPath(rootNorm), fs::directory_options::skip_permission_denied, ec);
  if (ec) return files;
  const fs::recursive_directory_iterator end;
  for (; it != end; it.increment(ec)) {
    if (ec) { ec.clear(); continue; }
    const fs::directory_entry& entry = *it;
    std::error_code ec2;
    const std::string abs = normalizePath(fromFsPath(entry.path()));
    const std::string rel = relativeTo(rootNorm, abs);
    if (entry.is_directory(ec2)) {
      const std::string name = baseName(rel);
      if (name == ".git" || (dirIsExcluded(excludeGlobs, rel))) {
        it.disable_recursion_pending();
      }
      continue;
    }
    if (!entry.is_regular_file(ec2)) continue;
    if (!globMatchAny(includeGlobs, rel)) continue;
    if (globMatchAny(excludeGlobs, rel)) continue;
    files.push_back(abs);
    if (files.size() >= maxFiles) break;
  }
  std::sort(files.begin(), files.end());
  return files;
}

uint64_t hashString(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) {
    h ^= static_cast<uint64_t>(c);
    h *= 1099511628211ull;
  }
  return h;
}

}  // namespace depscan::util
