cmake_minimum_required(VERSION 3.16)
project(demo CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# 示例源码里的注释是 UTF-8。MSVC 默认按本地代码页（简体中文环境是 936）解析，
# 会给每个文件刷一条 C4819 并可能截断中文字符串，显式指定 /utf-8 后三平台一致。
if(MSVC)
  add_compile_options(/utf-8)
endif()

add_library(demo_core STATIC
  src/core/engine.cpp
  src/core/registry.cpp
  src/util/logger.cpp
  src/util/string_utils.cpp
)

add_library(demo_ui STATIC
  src/ui/panel.cpp
)

add_executable(demo_app
  src/main.cpp
  src/app/application.cpp
)

target_link_libraries(demo_app PRIVATE demo_core demo_ui)
target_link_libraries(demo_ui PRIVATE demo_core)
target_include_directories(demo_core PUBLIC include src)
