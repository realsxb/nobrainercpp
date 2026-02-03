vscode拯救计划！帮助新手顺利使用vscode!

vscode自动化配置插件开发

大多数新手如果想使用vscode开发cpp是十分困难的，因为不会配置麻烦的task.json和launch.json。本开发目的就是安装插件实现自动化配置。

考虑多种情况





三套工具链

| 组件           | GNU工具链 | Clang/LLVM工具链 | MSVC工具链  |
| -------------- | --------- | ---------------- | ----------- |
| **编译器**     | gcc/g++   | clang/clang++    | cl.exe      |
| **链接器**     | ld (bfd)  | lld              | link.exe    |
| **C库**        | glibc     | libc             | MSVCRT      |
| **C++库**      | libstdc++ | libc++           | MSVC STL    |
| **调试器**     | gdb       | lldb             | vsdbg       |
| **汇编器**     | as        | llvm-as          | ml64        |
| **资源编译器** | windres   | llvm-rc          | rc.exe      |
| **构建系统**   | make      | ninja            | MSBuild     |
| **包管理器**   | apt/yum   | vcpkg/conan      | vcpkg/nuget |
| **目标平台**   | 跨平台    | 跨平台           | Windows     |

但是理论上来说，一个纯净的windows机器，是不包含任何编译器的。所以除了最基础的之外，我们要搜索机器里所有可能的编译器位置。当然这不是盲目搜索，有些可以通过很方便的命令找出来。



目前，为了方便我们按照123的优先级对编译器分类，gnc,lang,msvc。三种9个。



其中编译cpp的编译器至少一个。如果只有c编译器，也可以，但是调试cpp语言时要阻止并警告。

debug的调试器至少一个。目前我们先不考虑各个编译器和调试器之间的差异和混杂问题，我们要先保证最基础的编译和调试功能。

最后找完之后要在右下方提示使用的编译器和调试器。

完整的优先，先到先得，从gcc开始找，提供一个工具链一个工具链找，目前只考虑windows上的扩展搜索功能。

为了快我们可以三个

这样，我设计了一个简单的算法，用来高效找出系统中可用的工具链和其路径。首先是gnu，clang，msvc三个工具链分别对应三个异步函数，这三个异步函数会返回编译器名称和路径的键值对，一共三个还有一个工具链名称。当这三个函数中任意一个完成时会触发同一个回调，这个回调会把数据写进一个三维数组里，当这个三维数组中横向都有值时，触发最快回调，这个回调会返回可用的编译器调试器路径供（存到全局变量里）第一次调试使用。等这三个查找函数都执行完的适合则会触发最优回调，算出最优选择（这里为了简化算法，返回三个成套的，不成套就从左开始，一组一组叠加直到成套），写到全局变量里供下次调试使用。你可用先把函数框架给我（主要是回调部分的写法），还有返回参数全局变量的设计等。目前只考虑这些。我们先不考虑三个编译器都不存在的情况。

launcher.cpp

```cpp
#include <windows.h>
#include <iostream>
#include <string>

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: launcher.exe <path_to_target_exe>" << std::endl;
        return 1;
    }

    std::string targetPath = argv[1];
    
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    // 关键魔法在这里：
    // CREATE_NEW_CONSOLE: 弹出一个独立的黑色 cmd 窗口，完美支持 scanf/cin
    // CREATE_SUSPENDED: 暂停进程，等待调试器 Attach。否则程序太快跑完，断点断不下来。
    BOOL success = CreateProcessA(
        targetPath.c_str(), // 目标程序
        NULL,               // 命令行参数
        NULL,               // 进程安全属性
        NULL,               // 线程安全属性
        FALSE,              // 不继承句柄
        CREATE_NEW_CONSOLE | CREATE_SUSPENDED, // <--- 重点
        NULL,               // 环境变量
        NULL,               // 工作目录（可以根据需要改为 target 所在目录）
        &si,
        &pi
    );

    if (!success) {
        std::cerr << "CreateProcess failed (" << GetLastError() << ")" << std::endl;
        return 1;
    }

    // 输出特定格式的 PID，方便插件正则提取
    // 例如: @@PID:12345@@
    std::cout << "@@PID:" << pi.dwProcessId << "@@" << std::endl;
    
    // 强制刷新缓冲区，确保 Node.js 端能立刻收到
    std::cout.flush();

    // 此时目标进程处于挂起状态。
    // 当 VS Code 的 lldb-dap Attach 上去后，lldb 会负责 Resume 进程，
    // 或者用户点击 VS Code 调试栏的 "继续" 按钮。
    
    // 为了防止 Wrapper 退出导致 handles 丢失（虽然通常没事），
    // 我们可以简单地不做任何事，或者直接退出。
    // 建议直接退出，因为 Attach 后调试器接管了生命周期。
    
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return 0;
}
```

