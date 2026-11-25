# Change Log

All notable changes to the "nobrainercpp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 1.5.1

- Add English and Chinese installation guides, development notes and source-build instructions. The publisher website and Marketplace listing link to both languages.
- Document the 48.82 MiB compressed Windows x64 toolchain, with tested C17 and C++17 examples. Localize the debug configuration descriptions for English and Simplified Chinese.
- 新增中英文安装指南、开发笔记和工具链构建说明，列出内嵌工具链的实测体积以及 C17、C++17 验证示例。调试配置说明支持简体中文和英文。

## 1.5.0

- Speed up debugging on Windows x64 with the bundled LLDB. Programs read input in the VS Code terminal. A small native launcher replaces the PowerShell startup script, C# compilation and temporary PID file.
- Start the compiler directly, search for GNU, Clang and MSVC concurrently, and select the compiler for the active file's language. The first usable result starts the initial build while the remaining probes finish.
- Use F5 in a new C/C++ workspace, keep user-edited workspace configurations and repair the original 1.4.1 bundled-toolchain paths after an extension update.
- Select the build folder from the active source file in multi-root workspaces. Support source paths with spaces, Chinese characters and shell metacharacters.
