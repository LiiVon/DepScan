cmake_minimum_required(VERSION 3.16)
project(libdemo CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(MSVC)
  add_compile_options(/utf-8)
endif()

# 故意**没有** main：这是个库，阅读路线得从「导出接口」起头
add_library(libdemo STATIC
  src/math.cpp
  src/text.cpp
)

# PUBLIC include = 公开面；PRIVATE src = 内部实现（internal.h 就在那里）
target_include_directories(libdemo PUBLIC include PRIVATE src)
