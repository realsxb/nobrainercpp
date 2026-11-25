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
