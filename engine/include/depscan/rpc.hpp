// JSON-RPC over stdio：插件 ⇄ 引擎的唯一通信通道。
// 协议：请求/响应均为「一行一个 JSON 对象」，UTF-8 编码，LF 分隔（Windows 下已切二进制模式）。
//   请求  {"id":1,"method":"scan","params":{...}}
//   响应  {"id":1,"ok":true,"result":{...}} / {"id":1,"ok":false,"error":{"message":"..."}}
//   通知  {"method":"progress","params":{"done":1,"total":10,"file":"a.cpp"}}
#pragma once

#include <string>

namespace depscan {

// 交互式服务（插件通过 stdio 驱动），阻塞至 shutdown / EOF。返回进程退出码。
int runStdioServer();

// 一次性扫描并输出 JSON（CLI / 自测用）。
int runOnce(const std::string& root, bool pretty, int jobs = 0, bool trace = false,
            bool violationsOnly = false);

}  // namespace depscan
