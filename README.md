# NBCpp (NoBrainerCpp)

[简体中文](https://github.com/realsxb/nobrainercpp/blob/main/README.zh-CN.md) · [User guide](https://buaahmjh.com/en/projects/nbcpp) · [Developer notes](https://github.com/realsxb/nobrainercpp/blob/main/docs/development-notes.en.md)

Compile and debug the active C or C++ source file in VS Code. On Windows x64, NBCpp can use a system compiler or its bundled Clang and LLDB. You can set breakpoints and type input into the integrated terminal, even on a machine without MinGW, Visual Studio or the Microsoft C/C++ extension installed separately.

**Clang, LLD and LLDB in 48.82 MiB of compressed toolchain data.** The bundle includes the Windows x64 tools, runtime libraries and headers used by the examples below.

## Try it with a C program

1. Install **NBCpp** from the Extensions view in **desktop VS Code 1.105 or later (1.x)** on Windows x64. Open a folder you trust where you can save source files and executables. [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=Nebulazeyv-RealSXB.nobrainercpp)
2. Save the example below as `main.c` in that folder. Click the gutter next to `printf` to set a breakpoint.
3. Click **Smart Run** in the editor toolbar. When the integrated terminal opens, type `41` and press Enter. At the breakpoint, inspect `n` in **Variables**. Press **F10** to execute the output line. The terminal should display `42`.

```c
#include <stdio.h>

int main(void) {
    int n;
    if (scanf("%d", &n) != 1) return 1;
    printf("%d\n", n + 1);
    return 0;
}
```

## Launch and control a session

| Action | How to use it |
| --- | --- |
| **Smart Run C/C++** ![Smart Run icon](https://raw.githubusercontent.com/realsxb/nobrainercpp/main/smartstart.png) | Builds the active file in its detected language. Select the editor button or run **C/C++: Smart Run C/C++** from the Command Palette. |
| **F5** | Starts debugging in a new C/C++ workspace. If VS Code asks you to pick a debugger, choose **NBCpp C/C++**. In a project with a custom launch configuration, F5 follows the selected configuration. Smart Run is available for building just the active file. |
| **Ctrl+Alt+C** / **Ctrl+Alt+D** | With focus in the editor, choose **C** with the first shortcut or **C++** with the second. |
| **F10** / **F11** / **Shift+F5** | Step over a line, step into a call or stop debugging. Use **Restart** in the debug toolbar to launch a fresh process. |

## What you can build

| | Examples verified with the bundled toolchain |
| --- | --- |
| **C** | Read values with `scanf`, store them in arrays and structures, compare C strings, print a result and read or write a file with the C standard I/O library. |
| **C++** | Use `std::cin` and `std::cout`, write classes and templates, store strings in a `std::vector`, sort them with `std::sort` and work with files using streams. The bundle also includes a `bits/stdc++.h` convenience header for exercises that use it. |

For a C++ exercise, save this as `main.cpp`, start **Smart Run**, then enter `7 2 5`. Set a breakpoint on the output line. Step over it to print the smallest value, `2`.

```cpp
#include <algorithm>
#include <iostream>
#include <vector>

int main() {
    std::vector<int> numbers(3);
    for (int& n : numbers) {
        if (!(std::cin >> n)) return 1;
    }
    std::sort(numbers.begin(), numbers.end());
    std::cout << numbers.front() << '\n';
}
```

The automatic build compiles **one source file** with debug information, writes the executable next to the source and runs it with the source directory as its working directory. Local headers can be included as usual. The bundled compilers have been tested with C17 and C++17 examples. Generated GNU and Clang tasks use the compiler's default language standard. A project that needs an explicit standard can set it in its own build task. Projects with multiple separately compiled source files, CMake targets, custom linker flags or external SDKs need their own build tasks. The bundled toolchain targets Windows x64 console programs. Its Windows libraries and headers are a selected subset.

## How NBCpp chooses a toolchain

NBCpp checks the directories on PATH for GNU, Clang and MSVC concurrently. The first usable set for the active file can start the initial build while discovery continues. Later runs can use a preferred complete toolchain. MSVC requires a developer environment with its include and library paths configured. If the system has a C compiler only, the bundled Clang++ can still build a C++ exercise.

With the Microsoft C/C++ extension, NBCpp can use its GDB integration or Visual Studio debugger with a matching system toolchain. The bundled LLDB path uses a small Windows launcher to start your program in a VS Code terminal and attach before it runs past the first breakpoint. The status bar briefly shows the compiler and debugger for each run.

NBCpp can generate `.vscode/tasks.json`, `launch.json` and `c_cpp_properties.json` in an open folder. It recognizes its own generated files and preserves user-edited configurations. The IntelliSense configuration can be used by the Microsoft C/C++ extension if installed.

## Bundled toolchain size

The bundled Clang, LLD and LLDB tools report version **21.1.8**. Inside the VSIX, the bundled Windows x64 toolchain occupies 2,697 files under `lldbv1.0/`. Their ZIP entries contain 51,190,475 bytes of compressed data. Their unpacked file contents total **169.06 MiB** (177,267,939 bytes). The complete VSIX also contains the extension, launcher, documentation and archive metadata.

## Source and support

The extension and native launcher are available under the repository's MIT license. The bundled LLVM and MinGW-w64 components retain their upstream licenses. For a problem report, include your Windows, VS Code and NBCpp versions, the compiler shown in the status bar and a small program that reproduces the issue.

- [Publisher website](https://buaahmjh.com/en) · [NBCpp user guide](https://buaahmjh.com/en/projects/nbcpp)
- [Run and test the extension from source](https://github.com/realsxb/nobrainercpp/blob/main/docs/development-notes.en.md) · [Native launcher source](https://github.com/realsxb/nobrainercpp/blob/main/native/terminal-launcher.c)
- [Toolchain build guide](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/README.md) · [Toolchain build script](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/build.py)
- [License](https://github.com/realsxb/nobrainercpp/blob/main/LICENSE) · [Third-party notices](https://github.com/realsxb/nobrainercpp/tree/main/third-party-notices) · [Report an issue](https://github.com/realsxb/nobrainercpp/issues)

## 中文快速入门

在 Windows x64 的桌面版 VS Code 中安装 NBCpp，用「打开文件夹」打开练习目录，保存一个带 `main` 函数的 `.c` 或 `.cpp` 文件。点击编辑器右上角 **Smart Run**。新工作区也可按 **F5**，遇到调试器选择时选 **NBCpp C/C++**。在行号左侧设置断点，在集成终端给 `scanf` 或 `std::cin` 输入数据，按 **F10** 单步执行。[完整中文说明](https://github.com/realsxb/nobrainercpp/blob/main/README.zh-CN.md) · [中文使用指南](https://buaahmjh.com/projects/nbcpp)
