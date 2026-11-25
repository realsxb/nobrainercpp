# 构建内置 Windows 工具链

[English](README.md) · [历史构建脚本节选](historical-recipe.md)

NBCpp 的 `lldbv1.0/` 提供适用于 Windows x64 的编译器、链接器、调试器和裁剪过的 MinGW 系统库。这里把历史构建记录整理成可分阶段执行的脚本。日常使用扩展可以直接使用仓库中的二进制。

## 版本和记录

随项目发布的 Clang 与 LLDB 均报告 21.1.8。历史手册记载了 LLVM 21.1.8 工作目录、MinGW CMake 工具链文件、Wine 训练脚本 `train.sh` 和打包脚本 `sh-ctt-78`。本配方使用上游发布标签对应的提交 `2078da43e25a4623cab2d0d60decddf709aaea28`。原构建实际检出的提交、本地补丁、llvm-mingw 安装包、SQLite 版本、原始 PGO 样本和 CMake 缓存尚未找回，重新编译的文件可能与既有发行版不同。[LLVM 21.1.8 发布页](https://github.com/llvm/llvm-project/releases/tag/llvmorg-21.1.8)

手册中的两版最终配置都使用 X86 后端、Clang/LLD/LLDB、MinSizeRel、ThinLTO、PGO、共享 LLVM 和体积优化参数，差异集中在安装组件清单。本配方直接构建所需目标，用已发布文件的清单组装目录。一份历史日志记载选定的 EXE、DLL 经 UPX 4.2.2 处理、三个运行库未被压缩，目录约 106 MiB。该日志没有列出 LLDB 可执行文件。本配方输出未经 UPX 处理的二进制。

## 准备源码、交叉工具链和训练数据

使用 x86-64 Linux 或 WSL。宿主机需要支持 C++17 的原生 C/C++ 编译器、Python 3.9 及以上版本、Git、CMake、Ninja、可运行 Windows x64 程序的 Wine 和 `winepath`。以下命令使用 Bash，所有输出放在两个源码仓库以外的新目录。

1. 检出 LLVM 发布标签，核对提交与项目入口。

   ```bash
   git clone --depth 1 --branch llvmorg-21.1.8 https://github.com/llvm/llvm-project.git llvm-project
   T=/absolute/path/to/nobrainercpp/toolchain
   SRC="$(realpath llvm-project)"
   python3 "$T/build.py" check-source --source "$SRC"
   ```

2. 解压基于 LLVM 21、使用 UCRT、**在 Linux 上运行**的 llvm-mingw SDK。它提供目标平台的 C/C++ 头文件、库、compiler-rt builtins 与插桩运行库、交叉编译器及二进制工具。检查 `bin/x86_64-w64-mingw32-clang++`、`lib/clang/21`、`x86_64-w64-mingw32/lib`，记录所选发布包的文件名和 SHA-256。[llvm-mingw 发布页](https://github.com/mstorsjo/llvm-mingw/releases)
3. 下载包含 SQLite 命令行外壳的 amalgamation 源码包，解压得到 `sqlite3.c`、`sqlite3.h` 和 `shell.c`，保留配套头文件并记录版本与归档哈希。缺少这些文件时，训练会提示补齐数据。[SQLite 下载页](https://sqlite.org/download.html)

## 分阶段构建

```bash
SDK=/absolute/path/to/llvm-mingw
SQLITE=/absolute/path/to/sqlite-amalgamation
WORK=/absolute/path/to/new-nbcpp-build
mkdir -p "$WORK"
python3 "$T/build.py" host --source "$SRC" --out "$WORK/host" -j 2
python3 "$T/build.py" instrument --source "$SRC" --sdk "$SDK" --host "$WORK/host" --out "$WORK/instrument" -j 2
python3 "$T/build.py" train --sdk "$SDK" --sqlite "$SQLITE" --host "$WORK/host" --instrument "$WORK/instrument" --out "$WORK/train"
python3 "$T/build.py" final --source "$SRC" --sdk "$SDK" --host "$WORK/host" --profile "$WORK/train/llvm.profdata" --out "$WORK/final" -j 2
```

- **host** 生成 Linux 原生表生成器和 `llvm-profdata`。**instrument** 交叉编译带 IR 插桩的 Windows Clang 和 LLD。
- **train** 使用独立的 Wine 前缀依次编译并链接 SQLite 库和命令行外壳，编译普通及 ThinLTO 两种 C++ 容器、异常处理用例，再用 50 个目标文件训练相同代码折叠与无用段回收。Windows 版工具产生 `.profraw`，原生工具将其合并成 `train/llvm.profdata`。训练覆盖 Clang、LLD；LLDB 在最终构建阶段引入。
- **final** 生成 Clang、LLD、LLDB 和 `lldb-dap`，启用 `-Oz -DNDEBUG -g0`、ThinLTO、PGO 和共享 LLVM/Clang 库。关闭 LLDB 的 Python、Lua、curses、libedit 等可选组件。完整参数在 `build.py` 中。

每一步使用新的输出目录，脚本会检查路径，保护输入与已有产物。Ninja 构建中断时，解决报错后可复用脚本打印的 `cmake --build` 命令；交叉编译时保留 `export NBCPP_LLVM_MINGW="$SDK"`。重新训练可换用新的输出目录。[LLVM PGO 指南](https://releases.llvm.org/21.1.0/docs/HowToBuildWithPGO.html)

## 组装与核验

```bash
python3 "$T/package.py" stage --final "$WORK/final" --sdk "$SDK" --out "$WORK/dist/lldbv1.0"
python3 "$T/package.py" verify "$WORK/dist/lldbv1.0"
```

组装需要 NBCpp 的 Git 工作副本。脚本使用版本库中 `lldbv1.0/` 的文件清单来重建历史裁剪布局。复制前先检查所有输入，完成后检查 x64 PE 架构和 compiler-rt 归档。编译器、链接器和调试器来自最终构建，运行时 DLL、Clang 资源、CRT 启动对象、精选 Windows 导入库及 MinGW/libc++ 头文件来自 SDK。两份 Clang 默认配置和 `bits/stdc++.h` 兼容头文件来自本仓库。分发二进制时一并携带所用组件的上游许可声明。[第三方声明](../third-party-notices/)

**验证范围。** 已用上游检出的源码核对发布提交和项目入口，检查 Python 与 CMake 语法，并用已有二进制和 SDK 文件重新组装到新目录，逐字节比对当前发行包的 2,697 个受控文件。Linux/Wine 全量训练与 LLVM 全量重编译尚待验证。发布重新构建的工具链前，应在 Windows 上分别编译、调试 C 和 C++ 程序。
