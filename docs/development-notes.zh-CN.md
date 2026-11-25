# NBCpp 开发笔记

NBCpp 1.5.0 帮助初学者在 Windows x64 的 VS Code 里调试当前打开的单个 C 或 C++ 文件。扩展宿主运行 TypeScript 编译出的 JavaScript，本机编译器负责生成可执行文件，调试适配器把 VS Code 的断点、单步和变量查看请求交给调试器。修改这三部分时，可以分别验证。

## 从源码运行

准备 Git、Node.js、pnpm 和桌面版 VS Code。在 PowerShell 中执行以下命令。

```powershell
git clone https://github.com/realsxb/nobrainercpp.git
cd nobrainercpp
pnpm install --frozen-lockfile
pnpm run compile
code .
```

在仓库窗口的「运行和调试」中选择 **Run Extension**，按 F5。它会打开扩展开发宿主，并从当前工作树加载 NBCpp。用**新打开的宿主窗口**打开一个练习文件夹并保存下面的 `main.cpp`。

```cpp
#include <iostream>

int main() {
    int n = 0;
    std::cin >> n;
    std::cout << n + 1 << '\n';
}
```

在输出语句上设置断点，点击右上角的 **Smart Run**，在集成终端输入 `41` 并回车。停在断点时可以查看 `n`，再按 F10，应看到终端输出 `42`。仓库窗口的 F5 启动扩展开发宿主，练习文件夹里的 F5 启动 C++ 调试会话。[扩展开发启动配置](../.vscode/launch.json)

## 启动一次调试时，扩展做了什么

1. **找到当前文件。** Smart Run 识别活动编辑器里的 C 或 C++ 文件，保存修改，找到文件所属的工作区文件夹。扩展把本次编译任务绑定到这份源码、所选语言和编译器路径，多根工作区里的同名文件可以分别调试。[扩展入口](../src/extension.ts)
2. **先找到可用组合，再为下一次择优。** GNU、Clang、MSVC 三组探测并发读取 PATH。以 C++ 为例，先返回的结果中已有 C++ 编译器和调试器，就可以启动本次构建。全部探测完成后，完整工具链按 GNU、Clang、MSVC 的顺序择优，缺项时按语言组合现有工具。系统里只有 C 编译器时，C++ 仍可选用内置 Clang++。MSVC 还需要已初始化的头文件和库环境。发现缓存中的程序已移走时，下一次运行会重新探测。[工具链选择代码](../src/toolchainFinder.ts)
3. **按工具生成任务。** 编译器以独立进程启动，文件名和参数分别传递。扩展生成构建任务、启动配置和 IntelliSense 配置，并识别用户改过的文件。配置生成器根据工具选择调试路径。有微软 C/C++ 扩展且能匹配 GDB 时使用 `cppdbg`，匹配 MSVC 时使用 `cppvsdbg`，其余支持的 Windows 配置可使用内置的 LLDB DAP。[配置生成器](../src/configuration.ts) · [工作区文件写入与迁移](../src/projectFiles.ts)
4. **把程序输入留在 VS Code 终端。** 使用内置 LLDB 时，构建成功后，扩展以进程任务启动约 40 KB 的终端启动器。启动器在集成终端中创建挂起的目标，通过会话独有的命名管道通知扩展 PID。LLDB 附加到这个 PID，配置好断点后再恢复目标线程，因此短程序能在首个用户断点停住，`scanf` 和 `std::cin` 也能读取输入。重新启动时，新适配器获取新 PID。关闭会话时，Windows Job Object 帮助释放这次调试所创建的进程。[VS Code 端实现](../src/terminalDebugger.ts) · [原生启动器源码](../native/terminal-launcher.c)

早期版本先用 `launcher.exe` 创建独立控制台，并将挂起进程的 PID 写到标准输出。1.4.1 的路径改为通过 PowerShell 编译 C# 启动代码，并轮询临时 PID 文件。1.5.0 使用上面的集成终端进程任务和命名管道。保留这段历史也解释了为何随包使用自己的启动器：内置 LLDB 21.1.8 的 Windows 版本尚未实现原生 `runInTerminal` 所需的 FIFO。[早期 C++ 启动器](../native/legacy/launcher.cpp) · [早期 PowerShell 脚本](../Start-Debug.ps1) · [LLVM 21.1.8 对应源码](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.8/lldb/tools/lldb-dap/FifoFiles.cpp)

## 测试与本地安装包

```powershell
pnpm test
```

测试命令先编译 TypeScript 并执行 ESLint，再启动隔离的扩展宿主。宿主禁用额外安装的扩展，在临时工作区测试工具链探测、已有配置迁移，以及 Windows x64 上 C 和 C++ 的断点、单步、终端输入和重新启动。要指定已安装的 VS Code，可先设置 `$env:VSCODE_TEST_EXECUTABLE` 为该安装的 `Code.exe` 完整路径。[测试宿主配置](../.vscode-test.mjs) · [调试集成测试](../src/test/extension.test.ts)

制作 Windows x64 的本地验收包可以使用微软的打包工具。

```powershell
pnpm dlx @vscode/vsce ls --no-dependencies
pnpm dlx @vscode/vsce package --target win32-x64 --no-dependencies --out nbcpp-local.vsix
```

第一条命令可检查打包文件清单，重点查看 `out/extension.js`、`bin/terminal-launcher.exe`、`lldbv1.0/` 和 `third-party-notices/`。第二条会在本地生成 VSIX。在 VS Code 的扩展视图中选择「从 VSIX 安装」即可验收。VSIX 的平台标记需与内置原生程序一致。[打包过滤规则](../.vscodeignore) · [VS Code 官方打包说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions)

## 修改原生启动器

当前的 `bin/terminal-launcher.exe` 由项目里的 C 源码构建。准备 Windows x64 的 MinGW-w64 GCC，在仓库根目录运行下列命令。PowerShell 中将链接器参数作为一个字符串传给 GCC。

```powershell
gcc -std=c11 -Os -Wall -Wextra -Werror -municode -static -s '-Wl,--no-insert-timestamp' native/terminal-launcher.c -o bin/terminal-launcher.exe
pnpm test
```

`native/legacy/launcher.cpp` 整理自仓库早已公开的设计笔记，对应根目录历史文件 `launcher.exe` 的主程序。它使用窄字符版 Windows 进程接口，适合研究早期的外部窗口方案。修改 1.5.0 的终端行为请从 C 启动器入手。

## 内置 LLVM 的组成与构建来历

| 仓库位置 | 用途 |
| --- | --- |
| `lldbv1.0/bin/` | Clang 和 Clang++ 编译源码，LLD 链接程序，LLDB DAP 与 VS Code 通信。这个目录也放置工具和目标程序需要的 DLL。 |
| `lldbv1.0/lib/clang/21/` | Clang 自带的资源头文件与目标平台的 compiler-rt 内建函数库。 |
| `lldbv1.0/x86_64-w64-mingw32/` | Windows 目标的 sysroot，包含 MinGW-w64 头文件、启动对象、导入库和 libc++ 头文件。项目还放置了一个聚合头，供已有的 `#include <bits/stdc++.h>` 练习代码使用。 |

交叉编译时要区分两个平台。负责生成源码的 `llvm-tblgen`、`clang-tblgen` 要能在**构建机**上运行。最终放进 VSIX 的 `clang.exe` 和 `lldb-dap.exe` 要能在**用户的 Windows x64 机器**上运行。早期制作工具链时，先用 CMake 和 Ninja 生成宿主工具，再利用 llvm-mingw 面向 Windows 构建所需 LLVM 组件，并按上表组织目标 sysroot。体积优化还试验过 ThinLTO 和 PGO，包括在 Wine 中运行插桩后的 Windows 工具并用 `llvm-profdata` 合并采样。现有仓库尚缺整套历史构建的依赖提交、配置及训练输入，不能据此逐字节复现所有预编译组件。

维护工具链时，可用以下命令核对版本和目标三元组。替换工具或头文件后，应分别编译一个 C 样例和一个用到标准库的 C++ 样例，再运行上述交互调试测试。打包文件夹中的 `clang.cfg`、扩展在构建任务中传入的 sysroot，以及目标程序加载运行库所用的 PATH 都会影响结果。

```powershell
.\lldbv1.0\bin\clang.exe --version
.\lldbv1.0\bin\lldb-dap.exe --version
```

随包的 Clang 和 LLDB 报告版本为 21.1.8。相应源码可以从 LLVM 标签 `llvmorg-21.1.8` 获取。MinGW-w64 头文件中的版本宏标记为 14.0.0 alpha，完整 sysroot 及每个运行库的精确构建提交仍待补录。[LLVM 21.1.8 源码](https://github.com/llvm/llvm-project/tree/llvmorg-21.1.8) · [llvm-mingw 构建脚本](https://github.com/mstorsjo/llvm-mingw) · [MinGW-w64 源码](https://github.com/mingw-w64/mingw-w64)

## 许可证

NBCpp 自有的扩展和启动器代码使用仓库根目录的 MIT 许可证。内置组件保留各自适用的上游条款。LLVM 21.1.8 的主要许可证为 Apache 2.0 with LLVM Exceptions，部分子项目的许可证还列出其他声明。MinGW-w64 的头文件、运行库和 winpthreads 也有各自的声明。仓库收录 LLVM 对应版本的许可证，以及 MinGW-w64 v14.0.0 发布树中的参考声明，便于对照具体文件的版权标记。[NBCpp 许可证](../LICENSE) · [随附的第三方声明](../third-party-notices/) · [LLVM 上游许可证](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.8/LICENSE.TXT) · [MinGW-w64 发布树中的运行库声明](https://github.com/mingw-w64/mingw-w64/blob/v14.0.0/COPYING.MinGW-w64-runtime/COPYING.MinGW-w64-runtime.txt) · [winpthreads 声明](https://github.com/mingw-w64/mingw-w64/blob/v14.0.0/mingw-w64-libraries/winpthreads/COPYING)
