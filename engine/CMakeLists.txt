cmake_minimum_required(VERSION 3.16)
project(depscan-core LANGUAGES CXX VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 让引擎自身的构建也产出 compile_commands.json：
# 一来便于用 DepScan 分析 DepScan 自己（dogfooding），
# 二来让 include/链接依赖走精确解析路径（精度：部分精确）。
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# 引擎默认不依赖任何第三方库：内置轻量结构解析器（近似精度）。
# 若本机存在 LLVM/Clang，可通过 -DDEPS_USE_LIBCLANG=ON 启用 libclang 精确语义解析。
option(DEPS_USE_LIBCLANG "Use libclang for exact semantic analysis" OFF)
option(DEPS_BUILD_TESTS "Build engine self tests" ON)

file(GLOB DEPS_CORE_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp")
list(FILTER DEPS_CORE_SOURCES EXCLUDE REGEX "clang_analyzer\\.cpp$")
list(FILTER DEPS_CORE_SOURCES EXCLUDE REGEX "main\\.cpp$")

add_library(depscan_lib STATIC ${DEPS_CORE_SOURCES})
target_include_directories(depscan_lib PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
set_target_properties(depscan_lib PROPERTIES POSITION_INDEPENDENT_CODE ON)

find_package(Threads REQUIRED)
target_link_libraries(depscan_lib PUBLIC Threads::Threads)

if(DEPS_USE_LIBCLANG)
  find_package(Clang QUIET)
  if(Clang_FOUND)
    message(STATUS "DepScan: libclang found -> exact semantic analysis enabled")
    target_sources(depscan_lib PRIVATE src/clang_analyzer.cpp)
    target_compile_definitions(depscan_lib PUBLIC DEPS_HAVE_LIBCLANG=1)
    target_link_libraries(depscan_lib PUBLIC clang-cpp libclang)
    target_include_directories(depscan_lib PUBLIC ${Clang_INCLUDE_DIRS})
  else()
    message(WARNING "DepScan: DEPS_USE_LIBCLANG=ON but Clang was not found; falling back to the built-in parser")
  endif()
endif()

add_executable(depscan-core src/main.cpp)
target_link_libraries(depscan-core PRIVATE depscan_lib)

if(MSVC)
  target_compile_options(depscan_lib PUBLIC /utf-8 /W3 /EHsc)
  target_compile_options(depscan-core PRIVATE /utf-8)

  # UTF-8 活动代码页清单：没有它，项目里只要有一个文件名不是合法 GBK 字节序列，
  # 扫描就会抛 "No mapping for the Unicode character exists in the target multi-byte
  # code page"（真实项目上必现，自造的 ASCII 样例永远踩不到）。
  # 详见 resources/utf8-app.manifest 的注释；代码侧另有 util::toFsPath 兜底。
  target_link_options(depscan-core PRIVATE
    "/MANIFEST:EMBED"
    "/MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/resources/utf8-app.manifest")
else()
  target_compile_options(depscan_lib PUBLIC -Wall -Wextra)
endif()

# 产物统一放到 <build>/bin/<Config>/，与插件端 locator 约定一致
foreach(target depscan-core)
  set_target_properties(${target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin/Debug"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin/Release"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin/RelWithDebInfo"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin/MinSizeRel")
endforeach()

if(DEPS_BUILD_TESTS)
  enable_testing()
  add_executable(depscan-core-test test/test_main.cpp)
  target_link_libraries(depscan-core-test PRIVATE depscan_lib)
  set_target_properties(depscan-core-test PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin/Debug"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin/Release")
  add_test(NAME depscan-core-test COMMAND depscan-core-test)
endif()
