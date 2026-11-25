# NBCpp (NoBrainerCpp)

[English](https://github.com/realsxb/nobrainercpp/blob/main/README.md) · [使用指南](https://buaahmjh.com/projects/nbcpp) · [中文开发笔记](https://github.com/realsxb/nobrainercpp/blob/main/docs/development-notes.zh-CN.md)

在 VS Code 中编译、调试当前打开的 C 或 C++ 文件。Windows x64 上，NBCpp 可以使用系统编译器，也内置了 Clang 和 LLDB。即使电脑没有单独安装 MinGW、Visual Studio 或微软 C/C++ 扩展，你也可以设置断点，在集成终端给程序输入数据。

**包含 Clang、LLD 和 LLDB 的内置工具链压缩后为 48.82 MiB。** 其中包含运行下列示例所需的 Windows x64 工具、运行库和头文件。

## 用一个 C 程序上手

1. 在 Windows x64 的**桌面版 VS Code 1.105 或更高的 1.x 版本**中，打开扩展视图，安装 **NBCpp**。再打开一个你信任且可以保存源文件和可执行文件的文件夹。[扩展商店页面](https://marketplace.visualstudio.com/items?itemName=Nebulazeyv-RealSXB.nobrainercpp)
2. 将下面的程序保存为该文件夹里的 `main.c`。点击 `printf` 行号左侧的空白处，设置断点。
3. 点击编辑器工具栏的 **Smart Run**。在打开的集成终端里输入 `41` 并回车。程序停在断点后，可以在「变量」中看到 `n` 的值。按 **F10** 执行输出语句，终端应显示 `42`。

```c
#include <stdio.h>

int main(void) {
    int n;
    if (scanf("%d", &n) != 1) return 1;
    printf("%d\n", n + 1);
    return 0;
}
```

## 启动和控制调试

| 操作 | 用法 |
| --- | --- |
| **Smart Run C/C++** ![Smart Run 图标](https://raw.githubusercontent.com/realsxb/nobrainercpp/main/smartstart.png) | 识别当前文件的语言并编译。可点击编辑器按钮，或在命令面板运行 **C/C++: Smart Run C/C++**。 |
| **F5** | 在新的 C/C++ 工作区中启动调试。如果 VS Code 提示选择调试器，选择 **NBCpp C/C++**。项目已有自定义启动配置时，F5 会执行当前选中的配置，仍可用 Smart Run 单独调试活动文件。 |
| **Ctrl+Alt+C** / **Ctrl+Alt+D** | 光标在编辑器中时，前者指定按 **C** 编译，后者指定按 **C++** 编译。 |
| **F10** / **F11** / **Shift+F5** | 分别执行单步跳过、单步进入和停止调试。调试工具栏里的「重新启动」会创建新的程序进程。 |

## 可以写哪些程序

| 语言 | 用内置工具链验证过的例子 |
| --- | --- |
| **C** | 用 `scanf` 读取数据，用数组和结构体保存数值，比较 C 字符串，在终端输出结果，通过 C 标准 I/O 库读写文件。 |
| **C++** | 用 `std::cin` 和 `std::cout` 交互，编写类与模板，用 `std::vector` 保存字符串、用 `std::sort` 排序，通过文件流读写数据。内置工具链还附带一个 `bits/stdc++.h` 聚合头，方便运行使用该头文件的练习代码。 |

试一段 C++ 代码。把下面的程序保存为 `main.cpp`，点击 **Smart Run**，输入 `7 2 5`。在输出行设置断点，再单步执行这一行，终端会显示最小值 `2`。

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

自动构建每次编译**一个源文件**，生成调试信息，把可执行文件写在源码旁边，并以源码目录为工作目录运行程序。可以正常引用本地头文件。内置编译器已用 C17、C++17 示例验证。生成的 GNU 和 Clang 任务使用编译器的默认语言标准。需要指定版本时，可在自己的构建任务中设置。如果工程需要把多个源文件分别编译再链接，或者使用 CMake 目标、自定义链接参数、外部 SDK，就需要配置相应的构建任务。内置工具链面向 Windows x64 控制台程序，随附的是经过筛选的 Windows 库和头文件。

## 如何选择工具链

NBCpp 在 PATH 指定的目录中并发查找 GNU、Clang 和 MSVC。找到支持当前语言的可用组合后即可启动首次构建，其余探测在后台继续，后续运行再使用优先级较高的完整组合。使用 MSVC 时，需要先进入已配置头文件路径和库路径的开发环境。如果系统只有 C 编译器，C++ 练习仍可使用内置 Clang++。

安装了微软 C/C++ 扩展并找到匹配的系统工具链时，NBCpp 可以使用它的 GDB 集成或 Visual Studio 调试器。使用内置 LLDB 时，一个小型 Windows 启动器负责在 VS Code 终端中创建程序，让调试器在程序越过第一个断点前完成附加。每次运行时，状态栏会短暂显示所选的编译器和调试器。

NBCpp 可以在打开的文件夹中生成 `.vscode/tasks.json`、`launch.json` 和 `c_cpp_properties.json`。它会识别自己生成的配置，保留用户编辑过的文件。安装了微软 C/C++ 扩展时，该扩展可以读取生成的 IntelliSense 配置。

## 内置工具链体积

包内的 Clang、LLD 和 LLDB 版本均为 **21.1.8**。VSIX 里的 Windows x64 工具链位于 `lldbv1.0/` 目录，共有 2,697 个文件，ZIP 条目的压缩数据合计 51,190,475 字节，**解压后的文件内容合计 169.06 MiB**（177,267,939 字节）。整个 VSIX 还包含扩展代码、启动器、文档和归档元数据。

## 源码与反馈

项目自有的扩展和原生启动器使用 MIT 许可证，随包提供的 LLVM、MinGW-w64 组件保留各自的上游条款。反馈问题时，请注明 Windows、VS Code 和 NBCpp 版本、状态栏中显示的编译器，并附上能复现问题的最小程序。

- [发布者项目站](https://buaahmjh.com/) · [NBCpp 使用指南](https://buaahmjh.com/projects/nbcpp)
- [从源码运行与测试扩展](https://github.com/realsxb/nobrainercpp/blob/main/docs/development-notes.zh-CN.md) · [原生启动器源码](https://github.com/realsxb/nobrainercpp/blob/main/native/terminal-launcher.c)
- [工具链构建说明](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/README.zh-CN.md) · [工具链构建脚本](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/build.py)
- [项目许可证](https://github.com/realsxb/nobrainercpp/blob/main/LICENSE) · [第三方声明](https://github.com/realsxb/nobrainercpp/tree/main/third-party-notices) · [GitHub Issues 反馈](https://github.com/realsxb/nobrainercpp/issues)
