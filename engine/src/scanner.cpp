#include "depscan/scanner.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

#include "depscan/buildmodel.hpp"
#include "depscan/json.hpp"
#include "depscan/util.hpp"

namespace fs = std::filesystem;

namespace depscan {

namespace {

std::vector<std::string> splitCommandLine(const std::string& cmd) {
  std::vector<std::string> out;
  std::string cur;
  bool inQuote = false;
  char quoteChar = '"';
  for (size_t i = 0; i < cmd.size(); ++i) {
    const char c = cmd[i];
    if (inQuote) {
      if (c == '\\' && i + 1 < cmd.size()) { cur += cmd[++i]; continue; }
      if (c == quoteChar) { inQuote = false; continue; }
      cur += c;
      continue;
    }
    if (c == '"' || c == '\'') { inQuote = true; quoteChar = c; continue; }
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      if (!cur.empty()) { out.push_back(cur); cur.clear(); }
      continue;
    }
    cur += c;
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

bool isIncludeFlag(const std::string& a) {
  return a == "-I" || a == "/I" || a == "-isystem" || a == "--include-directory" ||
         a.rfind("-I", 0) == 0 || a.rfind("/I", 0) == 0 || a.rfind("-isystem", 0) == 0;
}

bool isDefineFlag(const std::string& a) {
  return a == "-D" || a == "/D" || a.rfind("-D", 0) == 0 || a.rfind("/D", 0) == 0;
}

bool isSystemIncludeFlag(const std::string& a) {
  return a == "-isystem" || a.rfind("-isystem", 0) == 0;
}

void extractArgs(const std::vector<std::string>& args, std::vector<std::string>& inc,
                 std::vector<std::string>& sys, std::vector<std::string>& defs) {
  for (size_t i = 0; i < args.size(); ++i) {
    const std::string& a = args[i];
    if (!isIncludeFlag(a)) {
      if (isDefineFlag(a)) {
        std::string d = a.substr(2);
        if (d.empty() && i + 1 < args.size()) d = args[++i];
        if (!d.empty()) defs.push_back(d);
      }
      continue;
    }
    std::string path;
    if (a == "-I" || a == "/I" || a == "-isystem" || a == "--include-directory") {
      if (i + 1 < args.size()) path = args[++i];
    } else if (a.rfind("-isystem", 0) == 0) {
      path = a.substr(8);
    } else {
      path = a.substr(2);
    }
    if (path.empty()) continue;
    if (isSystemIncludeFlag(a)) sys.push_back(path);
    else inc.push_back(path);
  }
}

long long fileStampMs(const std::string& abs, long long* sizeOut) {
  std::error_code ec;
  const auto t = fs::last_write_time(util::toFsPath(abs), ec);
  if (ec) {
    if (sizeOut) *sizeOut = -1;
    return 0;
  }
  if (sizeOut) {
    std::error_code ec2;
    const auto s = fs::file_size(util::toFsPath(abs), ec2);
    *sizeOut = ec2 ? -1 : static_cast<long long>(s);
  }
  return std::chrono::duration_cast<std::chrono::milliseconds>(t.time_since_epoch()).count();
}

std::string findCompileCommands(const std::string& root) {
  const char* kCandidates[] = {"compile_commands.json", "build/compile_commands.json",
                              "out/compile_commands.json", "cmake-build-debug/compile_commands.json",
                              "cmake-build-release/compile_commands.json", "build/Release/compile_commands.json",
                              "build/Debug/compile_commands.json"};
  for (const char* c : kCandidates) {
    const std::string p = util::joinPath(root, c);
    if (util::fileExists(p)) return util::normalizePath(p);
  }
  // 广度受限的递归搜索（跳过 .git / node_modules）
  std::error_code ec;
  fs::recursive_directory_iterator it(util::toFsPath(root), fs::directory_options::skip_permission_denied, ec);
  if (ec) return {};
  const fs::recursive_directory_iterator end;
  for (; it != end; it.increment(ec)) {
    if (ec) { ec.clear(); continue; }
    const fs::directory_entry& entry = *it;
    std::error_code ec2;
    const std::string rel = util::relativeTo(root, util::normalizePath(util::fromFsPath(entry.path())));
    const int depth = static_cast<int>(std::count(rel.begin(), rel.end(), '/'));
    if (entry.is_directory(ec2)) {
      const std::string base = util::baseName(rel);
      if (depth >= 4 || base == ".git" || base == "node_modules" || base == "_deps") {
        it.disable_recursion_pending();
      }
      continue;
    }
    if (util::baseName(rel) == "compile_commands.json") {
      return util::normalizePath(util::fromFsPath(entry.path()));
    }
  }
  return {};
}

}  // namespace

CompileDatabase discoverCompileDatabase(const std::string& root, const std::string& explicitPath) {
  CompileDatabase db;
  std::string path = explicitPath.empty() ? findCompileCommands(root) : util::normalizePath(explicitPath);
  if (path.empty() || !util::fileExists(path)) return db;

  const std::string text = util::readFile(path);
  if (text.empty()) return db;
  json::Value root_;
  try {
    root_ = json::parse(text);
  } catch (const std::exception&) {
    return db;
  }
  if (!root_.isArray()) return db;

  db.found = true;
  db.path = path;
  std::vector<std::string> unionInc;
  std::vector<std::string> unionSys;
  std::vector<std::string> unionDef;

  for (const json::Value& entry : root_.arrayValue) {
    if (!entry.isObject()) continue;
    const std::string dir = entry.getString("directory");
    const std::string file = entry.getString("file");
    if (file.empty()) continue;

    std::vector<std::string> args;
    if (const json::Value* a = entry.find("arguments"); a && a->isArray()) {
      for (const json::Value& v : a->arrayValue) {
        if (v.isString()) args.push_back(v.stringValue);
      }
    } else {
      const std::string cmd = entry.getString("command");
      if (!cmd.empty()) args = splitCommandLine(cmd);
    }

    std::vector<std::string> inc;
    std::vector<std::string> sys;
    std::vector<std::string> defs;
    extractArgs(args, inc, sys, defs);

    std::string abs = file;
    if (!(abs.size() > 1 && abs[1] == ':')) {
      if (!abs.empty() && (abs[0] == '/' || abs[0] == '\\')) {
        // 绝对路径（POSIX）
      } else {
        abs = util::joinPath(dir, file);
      }
    }
    abs = util::normalizePath(abs);

    // 把绝对 include 路径转换到相对 root（若在其内），便于与文件集合对应
    auto toRelative = [&](const std::string& p) {
      std::string q = util::normalizePath(p);
      return util::relativeTo(root, q);
    };
    std::vector<std::string> incRel;
    for (const std::string& p : inc) incRel.push_back(toRelative(p));
    std::vector<std::string> sysRel;
    for (const std::string& p : sys) sysRel.push_back(toRelative(p));

    for (const std::string& p : incRel) {
      if (std::find(unionInc.begin(), unionInc.end(), p) == unionInc.end()) unionInc.push_back(p);
    }
    for (const std::string& p : sysRel) {
      if (std::find(unionSys.begin(), unionSys.end(), p) == unionSys.end()) unionSys.push_back(p);
    }
    for (const std::string& d : defs) {
      if (std::find(unionDef.begin(), unionDef.end(), d) == unionDef.end()) unionDef.push_back(d);
    }

    db.fileIndex[abs] = static_cast<int>(db.includePathsByEntry.size());
    db.includePathsByEntry.push_back(std::move(incRel));
  }

  db.entries = static_cast<int>(db.fileIndex.size());
  db.includePaths = std::move(unionInc);
  db.systemIncludePaths = std::move(unionSys);
  db.defines = std::move(unionDef);
  return db;
}

// ---------------------------- 扫描 ----------------------------

namespace {

// 缓存指纹：编译数据库（路径 + 条目数 + mtime）+ 编译参数 + 文件大小上限。
// 任何一项变化都说明旧的「文件级分析结果」不再可信（尤其是 fromCompileCommand
// 与 include 列表），必须整体重解析。
std::string configFingerprint(const std::string& root, const CompileDatabase& db,
                              const AnalyzerOptions& opts) {
  std::ostringstream oss;
  oss << root << '\x1f' << db.path << '\x1f' << db.entries << '\x1f'
      << (db.path.empty() ? 0 : fileStampMs(db.path, nullptr)) << '\x1f' << opts.fileSizeLimitBytes
      << '\x1f';
  for (const std::string& p : opts.includePaths) oss << p << ',';
  oss << '\x1f';
  for (const std::string& p : opts.systemIncludePaths) oss << p << ',';
  oss << '\x1f';
  for (const std::string& d : opts.defines) oss << d << ',';
  return std::to_string(util::hashString(oss.str()));
}

}  // namespace

// 阶段日志：崩溃（0xC0000409 这类 fastfail 是抓不住的，SEH/VEH 都会被绕过）时，
// stderr 的最后一行就是它死在哪一步 —— 这是事后唯一能拿到的线索，所以无条件输出。
// 每次扫描只有几行，代价可忽略。
static void stage(const std::string& what) {
  std::fprintf(stderr, "[DepScan] 阶段: %s\n", what.c_str());
  std::fflush(stderr);
}

bool Scanner::run(const ScanRequest& req, const ProgressFn& onProgress, std::string& error) {
  const std::string root = util::normalizePath(req.root);
  if (!util::isDirectory(root)) {
    error = "项目根目录不存在或不是目录: " + root;
    return false;
  }
  stage("1/5 发现文件: " + root);

  AnalyzerOptions opts = req.options;
  const CompileDatabase db = discoverCompileDatabase(root, req.compileCommandsPath);

  AnalyzerOptions baseOpts = opts;
  if (db.found) {
    for (const std::string& p : db.includePaths) baseOpts.includePaths.push_back(p);
    for (const std::string& p : db.systemIncludePaths) baseOpts.systemIncludePaths.push_back(p);
  }

  session_.reset(root, baseOpts);
  session_.statsMutable().compileCommandsFound = db.found;
  session_.statsMutable().compileCommandsPath = db.path;
  session_.statsMutable().compileCommandEntries = db.entries;
#ifdef DEPS_HAVE_LIBCLANG
  session_.statsMutable().libclangAvailable = true;
#endif
  if (!db.found) {
    session_.statsMutable().warnings.push_back(
        "未找到 compile_commands.json：include 精确解析不可用，已降级为内置解析（近似精度）。"
        "建议执行 cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON 后重试。");
  }

  // --- 文件发现 ---
  std::vector<std::string> includeGlobs = req.includeGlobs;
  if (includeGlobs.empty()) includeGlobs = {"**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,inl,ipp}"};
  // 未显式给出排除规则时使用安全默认值，避免把构建产物/依赖目录当成项目源码。
  // 插件侧总会带上 depscan.files.exclude，这里主要保护 CLI 与 --once 路径
  // （否则 CMake 生成的 CompilerIdCXX.cpp 之类会被当成项目文件索引进来）。
  std::vector<std::string> excludeGlobs = req.excludeGlobs;
  if (excludeGlobs.empty()) {
    excludeGlobs = {"**/node_modules/**", "**/.git/**",       "**/build/**",
                    "**/out/**",          "**/CMakeFiles/**", "**/cmake-build-*/**",
                    "**/build-*/**",      "**/.cache/**",     "**/_deps/**"};
  }
  const std::vector<std::string> filesAbs =
      util::listFilesRecursive(root, includeGlobs, excludeGlobs, req.maxFiles);
  stage("1/5 完成: " + std::to_string(filesAbs.size()) + " 个文件待索引（上限 " +
        std::to_string(req.maxFiles) + "）");

  const size_t total = filesAbs.size();
  std::vector<std::string> rels;
  rels.reserve(total);
  for (const std::string& abs : filesAbs) rels.push_back(util::relativeTo(root, abs));

  // --- 缓存载入（指纹不匹配则整体作废）---
  stage("2/5 载入缓存");
  const std::string fingerprint = configFingerprint(root, db, baseOpts);
  bool cacheLoaded = false;
  if (req.useCache && !req.forceFull && !req.cachePath.empty()) {
    cacheLoaded = session_.loadCache(req.cachePath, fingerprint);
  }

  std::map<std::string, FileAnalysis>& store = session_.filesMutable();

  // --- 判定需要重新分析的文件 ---
  std::vector<size_t> todo;
  std::vector<long long> stamps(total, 0);
  std::vector<long long> sizes(total, 0);
  int reused = 0;
  for (size_t i = 0; i < total; ++i) {
    stamps[i] = fileStampMs(filesAbs[i], &sizes[i]);
    auto it = store.find(rels[i]);
    if (cacheLoaded && it != store.end() && it->second.mtimeMs == stamps[i] &&
        it->second.size == sizes[i]) {
      ++reused;
      continue;
    }
    todo.push_back(i);
  }

  // 清理已删除/被排除的旧条目
  {
    std::set<std::string> alive(rels.begin(), rels.end());
    for (auto it = store.begin(); it != store.end();) {
      if (!alive.count(it->first)) it = store.erase(it);
      else ++it;
    }
  }

  // --- 并行分析 ---
  std::vector<FileAnalysis> results(todo.size());
  std::atomic<size_t> nextIdx{0};
  std::atomic<int> doneCount{0};
  std::atomic<bool> cancelled{false};
  std::atomic<int> skipped{0};
  // 解析失败（抛异常）的文件数。跟「被跳过」（太大/被排除）区分开，
  // 因为这是真正的 bug，必须让用户看到。
  std::atomic<int> failed{0};
  std::mutex warnMutex;
  std::vector<std::string> failureWarnings;

  const auto recordFailure = [&](const std::string& rel, const std::string& why) {
    failed.fetch_add(1);
    std::lock_guard<std::mutex> lock(warnMutex);
    // 只保留前若干条：一个病态项目可能让成百上千个文件都失败，
    // 刷屏反而掩盖了真正的原因。
    if (failureWarnings.size() < 20) {
      failureWarnings.push_back("文件解析失败，已跳过：" + rel + "\n  原因：" + why);
    }
  };

  int threads = req.threads;
  if (threads <= 0) {
    const unsigned hw = std::thread::hardware_concurrency();
    threads = static_cast<int>(hw == 0 ? 4u : std::max(2u, hw));
  }
  threads = std::max(1, std::min<int>(threads, 64));

  // 单个文件的完整处理流程（含进度上报）。
  // 注意：调用方把它包在 try/catch 里（见下面的 worker）—— 不仅是 analyzeFile，
  // onProgress（会写 stdout）和 results[idx] 的移动赋值也可能抛异常，
  // 而这里已经是工作线程，任何逸出都会 std::terminate。
  auto runOneFile = [&](size_t idx) {
      const size_t fi = todo[idx];
      const std::string& abs = filesAbs[fi];
      const std::string& rel = rels[fi];

      FileAnalysis fa;
      fa.file = rel;
      const long long size = sizes[fi] < 0 ? util::fileSize(abs) : sizes[fi];
      fa.mtimeMs = stamps[fi];
      fa.size = size;

      if (size >= 0 && static_cast<size_t>(size) <= req.options.fileSizeLimitBytes) {
        // ⚠ 关键：这里是工作线程。任何从 analyzeFile / readFile 逸出的异常
        //   都不会被 rpc.cpp 的 try/catch 接住（那是主线程），而是直接
        //   触发 std::terminate —— 表现就是“引擎进程异常退出”，
        //   一个大公司项目里只要有一个文件契死，整个索引就全部失败。
        try {
          const std::string src = util::readFile(abs);
          AnalyzerOptions fileOpts = baseOpts;
          auto dbIt = db.fileIndex.find(util::normalizePath(abs));
          const bool inDb = dbIt != db.fileIndex.end();
          if (inDb) {
            const std::vector<std::string>& extra = db.includePathsByEntry[dbIt->second];
            fileOpts.includePaths.insert(fileOpts.includePaths.end(), extra.begin(), extra.end());
          }
          fa = analyzeFile(rel, src, fileOpts);
          fa.fromCompileCommand = fa.fromCompileCommand || inDb;
        } catch (const std::exception& e) {
          recordFailure(rel, e.what());
        } catch (...) {
          recordFailure(rel, "未知异常");
        }
        fa.mtimeMs = stamps[fi];
        fa.size = size;
        // 注意：fa 可能被上面的异常路径留在初始状态，file 仍为 rel ——
        // 这样它至少会作为一个「无符号的空文件」出现在图里，而不是凭空消失。
        fa.file = rel;
      } else {
        skipped.fetch_add(1);
      }

      results[idx] = std::move(fa);
      const int d = doneCount.fetch_add(1) + 1;
      if (onProgress && (d == static_cast<int>(todo.size()) || d % 8 == 0)) {
        if (!onProgress(d, static_cast<int>(todo.size()), rel)) cancelled.store(true);
      }
  };

  auto worker = [&]() {
    while (true) {
      const size_t idx = nextIdx.fetch_add(1);
      if (idx >= todo.size()) break;
      if (cancelled.load()) break;
      try {
        runOneFile(idx);
      } catch (const std::exception& e) {
        recordFailure(idx < todo.size() ? rels[todo[idx]] : std::string("<未知文件>"), e.what());
      } catch (...) {
        recordFailure(idx < todo.size() ? rels[todo[idx]] : std::string("<未知文件>"), "未知异常");
      }
    }
  };

  stage("3/5 并行解析（线程数 " + std::to_string(threads) + "，待解析 " +
        std::to_string(todo.size()) + "，复用 " + std::to_string(reused) + "）");

  std::vector<std::thread> pool;
  pool.reserve(static_cast<size_t>(threads));
  for (int i = 0; i < threads; ++i) pool.emplace_back(worker);
  for (std::thread& th : pool) th.join();

  if (cancelled.load()) {
    error = "已取消";
    return false;
  }
  stage("3/5 完成，失败 " + std::to_string(failed.load()) + " 个");

  // --- 单线程合并 ---
  stage("4/5 合并结果");
  for (FileAnalysis& fa : results) {
    if (fa.file.empty()) continue;
    session_.putFile(std::move(fa));
  }
  session_.statsMutable().skippedFiles = skipped.load();
  session_.statsMutable().cacheReused = cacheLoaded && reused > 0;

  // 把解析失败的文件上报给 UI。以前这里什么都没有 —— 要么静默漏掉，要么整个进程挂掉。
  for (const std::string& w : failureWarnings) session_.statsMutable().warnings.push_back(w);
  if (failed.load() > 0) {
    session_.statsMutable().warnings.push_back(
        "共 " + std::to_string(failed.load()) + " 个文件解析失败（已跳过，其余文件不受影响）。");
  }

  // --- 构建模型 + 重建图 ---
  stage("5/5 解析 CMake + 重建图");
  if (req.options.links) {
    try {
      session_.setBuildModel(parseBuildModel(root));
    } catch (const std::exception& e) {
      session_.statsMutable().warnings.push_back(std::string("CMake 构建模型解析失败，已跳过 links 依赖：") + e.what());
    }
  }
  session_.rebuild();

  // --- 写缓存 ---
  if (req.useCache && !req.cachePath.empty()) {
    session_.saveCache(req.cachePath, fingerprint);
  }

  (void)reused;
  return true;
}

bool Scanner::runSingle(const ScanRequest& req, const std::string& relPath, std::string& error) {
  const std::string root = util::normalizePath(req.root);
  const std::string abs = util::normalizePath(util::joinPath(root, relPath));
  if (!util::fileExists(abs)) {
    session_.eraseFile(relPath);
    session_.rebuild();
    return true;
  }

  long long size = 0;
  const long long stamp = fileStampMs(abs, &size);
  AnalyzerOptions opts = req.options;
  const CompileDatabase db = discoverCompileDatabase(root, req.compileCommandsPath);
  if (db.found) {
    for (const std::string& p : db.includePaths) opts.includePaths.push_back(p);
    for (const std::string& p : db.systemIncludePaths) opts.systemIncludePaths.push_back(p);
  }
  session_.reset(root, opts);
  session_.statsMutable().compileCommandsFound = db.found;
  session_.statsMutable().compileCommandsPath = db.path;

  FileAnalysis fa;
  const std::string src = util::readFile(abs);
  try {
    if (size >= 0 && static_cast<size_t>(size) <= req.options.fileSizeLimitBytes) {
      fa = analyzeFile(relPath, src, opts);
    }
  } catch (const std::exception& e) {
    session_.statsMutable().warnings.push_back(
        std::string("文件解析失败，已跳过：") + relPath + "\n  原因：" + e.what());
  } catch (...) {
    session_.statsMutable().warnings.push_back(std::string("文件解析失败，已跳过：") + relPath + "\n  原因：未知异常");
  }
  fa.file = relPath;
  fa.mtimeMs = stamp;
  fa.size = size;

  session_.putFile(std::move(fa));
  if (req.options.links) {
    try {
      session_.setBuildModel(parseBuildModel(root));
    } catch (const std::exception& e) {
      session_.statsMutable().warnings.push_back(std::string("CMake 构建模型解析失败，已跳过 links 依赖：") + e.what());
    }
  }
  session_.rebuild();

  if (req.useCache && !req.cachePath.empty()) {
    session_.saveCache(req.cachePath, configFingerprint(root, db, opts));
  }
  error.clear();
  return true;
}

}  // namespace depscan
