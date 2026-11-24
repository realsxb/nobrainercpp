# Change Log

All notable changes to the "nobrainercpp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 1.5.0

- Speed up debugging on Windows x64 with the bundled LLDB. Programs read input in the VS Code terminal. A small native launcher replaces the PowerShell startup script, C# compilation and temporary PID file.
- Start the compiler directly, search for GNU, Clang and MSVC concurrently, and select the compiler for the active file's language. The first usable result starts the initial build while the remaining probes finish.
- Use F5 in a new C/C++ workspace, keep user-edited workspace configurations and repair the original 1.4.1 bundled-toolchain paths after an extension update.
- Select the build folder from the active source file in multi-root workspaces. Support source paths with spaces, Chinese characters and shell metacharacters.