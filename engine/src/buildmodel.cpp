#include "depscan/buildmodel.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <set>

#include "depscan/util.hpp"

namespace fs = std::filesystem;

namespace depscan {

namespace {

struct CmakeCommand {
  std::string name;               // 小写
  std::vector<std::string> args;  // 参数（引号已剥离）
  int line = 1;
};

// 极简 CMake 词法：忽略 # 注释，支持 "..." 引号与 $<...> 生成式表达式原样保留。
std::vector<CmakeCommand> tokenizeCmake(const std::string& text) {
  std::vector<CmakeCommand> out;
  size_t i = 0;
  const size_t n = text.size();
  int line = 1;
  while (i < n) {
    if (text[i] == '\n') { ++line; ++i; continue; }
    if (text[i] == '#') {
      while (i < n && text[i] != '\n') ++i;
      continue;
    }
    if (std::isspace(static_cast<unsigned char>(text[i]))) { ++i; continue; }
    if (!(std::isalpha(static_cast<unsigned char>(text[i])) || text[i] == '_')) { ++i; continue; }

    const int cmdLine = line;
    std::string cmd;
    while (i < n && (std::isalnum(static_cast<unsigned char>(text[i])) || text[i] == '_')) {
      cmd += text[i];
      ++i;
    }
    while (i < n && std::isspace(static_cast<unsigned char>(text[i]))) {
      if (text[i] == '\n') ++line;
      ++i;
    }
    if (i >= n || text[i] != '(') continue;
    ++i;

    CmakeCommand c;
    c.name = util::lower(cmd);
    c.line = cmdLine;

    std::string cur;
    int depth = 1;
    bool inQuote = false;
    bool sawToken = false;
    while (i < n && depth > 0) {
      const char ch = text[i];
      if (ch == '\n') { ++line; ++i; if (sawToken) { /* 保留空白 */ } continue; }
      if (ch == '#') {
        while (i < n && text[i] != '\n') ++i;
        continue;
      }
      if (inQuote) {
        if (ch == '\\' && i + 1 < n) { cur += text[i + 1]; i += 2; continue; }
        if (ch == '"') { inQuote = false; ++i; continue; }
        cur += ch;
        ++i;
        continue;
      }
      if (ch == '"') { inQuote = true; sawToken = true; ++i; continue; }
      if (ch == '(') { ++depth; cur += ch; ++i; sawToken = true; continue; }
      if (ch == ')') {
        --depth;
        if (depth == 0) { ++i; break; }
        cur += ch;
        ++i;
        continue;
      }
      if (std::isspace(static_cast<unsigned char>(ch))) {
        if (sawToken && !cur.empty()) { c.args.push_back(cur); cur.clear(); sawToken = false; }
        ++i;
        continue;
      }
      cur += ch;
      sawToken = true;
      ++i;
    }
    if (!cur.empty()) c.args.push_back(cur);
    out.push_back(std::move(c));
  }
  return out;
}

bool isGeneratorWord(const std::string& s) {
  static const std::set<std::string> kWords = {
      "PRIVATE", "PUBLIC", "INTERFACE", "REQUIRED", "QUIET", "STATIC", "SHARED",
      "MODULE", "OBJECT", "IMPORTED", "ALIAS", "EXCLUDE_FROM_ALL", "WIN32", "MACOSX_BUNDLE",
      "CONFIG", "COMPONENTS", "EXPORT", "GLOBAL", "UNKNOWN", "NO_SYSTEM_FROM_IMPORTED"};
  return kWords.count(s) > 0;
}

}  // namespace

BuildModel parseBuildModel(const std::string& root) {
  BuildModel model;
  std::error_code ec;
  const std::string rootNorm = util::normalizePath(root);

  std::vector<std::string> cmakeFiles;
  fs::recursive_directory_iterator it(util::toFsPath(rootNorm), fs::directory_options::skip_permission_denied, ec);
  if (ec) return model;
  const fs::recursive_directory_iterator end;
  for (; it != end; it.increment(ec)) {
    if (ec) { ec.clear(); continue; }
    const fs::directory_entry& entry = *it;
    std::error_code ec2;
    const std::string abs = util::normalizePath(util::fromFsPath(entry.path()));
    const std::string rel = util::relativeTo(rootNorm, abs);
    if (entry.is_directory(ec2)) {
      const std::string base = util::baseName(rel);
      if (base == "build" || base == "_deps" || base == ".git" || base == "out" ||
          base == "node_modules" || util::startsWith(base, "cmake-build-")) {
        it.disable_recursion_pending();
      }
      continue;
    }
    if (util::baseName(rel) == "CMakeLists.txt") cmakeFiles.push_back(rel);
  }
  std::sort(cmakeFiles.begin(), cmakeFiles.end());

  for (const std::string& rel : cmakeFiles) {
    const std::string text = util::readFile(util::joinPath(rootNorm, rel));
    if (text.empty()) continue;
    const std::vector<CmakeCommand> cmds = tokenizeCmake(text);
    const std::string dir = util::dirName(rel);
    for (const CmakeCommand& c : cmds) {
      if (c.args.empty()) continue;
      const std::string& first = c.args[0];
      if (util::contains(first, "${")) continue;  // 变量未展开，跳过

      if (c.name == "add_executable" || c.name == "add_library") {
        model.hasCMake = true;
        BuildTarget t;
        t.name = first;
        t.kind = (c.name == "add_executable") ? "executable" : "library";
        t.file = rel;
        t.line = c.line;
        for (size_t k = 1; k < c.args.size(); ++k) {
          if (isGeneratorWord(c.args[k])) continue;
          if (util::contains(c.args[k], "${")) continue;
          std::string src = c.args[k];
          if (!util::startsWith(src, "/")) {
            src = (dir.empty() || dir == ".") ? src : util::joinPath(dir, src);
          }
          src = util::normalizePath(src);
          t.sources.push_back(util::relativeTo(rootNorm, util::joinPath(rootNorm, src)));
        }
        model.targets.push_back(std::move(t));
      } else if (c.name == "target_link_libraries" || c.name == "link_libraries") {
        model.hasCMake = true;
        const std::string target = first;
        for (size_t k = 1; k < c.args.size(); ++k) {
          const std::string& lib = c.args[k];
          if (isGeneratorWord(lib)) continue;
          if (util::contains(lib, "$<")) continue;
          if (util::contains(lib, "${")) continue;
          if (lib == target) continue;
          for (BuildTarget& t : model.targets) {
            if (t.name == target) {
              if (std::find(t.links.begin(), t.links.end(), lib) == t.links.end()) {
                t.links.push_back(lib);
              }
            }
          }
        }
      } else if (c.name == "find_package") {
        for (BuildTarget& t : model.targets) {
          if (t.name == first) {
            t.packages.push_back(first);
          }
        }
      }
    }
  }
  return model;
}

}  // namespace depscan
