# NBCpp development notes

[简体中文](development-notes.zh-CN.md) · [Project README](../README.md) · [User guide](https://buaahmjh.com/en/projects/nbcpp) · [Source repository](https://github.com/realsxb/nobrainercpp)

NBCpp helps beginners debug the active C or C++ source file in desktop VS Code on Windows x64. The extension host runs JavaScript compiled from TypeScript, the compiler produces a Windows executable, and a debug adapter handles requests from VS Code to set breakpoints, step through code and inspect variables. Version 1.5.0 introduced the integrated-terminal launcher described here. See the README for supported editor versions and measured package sizes. [Project README](../README.md)

## Run the extension from source

Install Git, Node.js, pnpm and desktop VS Code. Run the following commands in PowerShell.

```powershell
git clone https://github.com/realsxb/nobrainercpp.git
cd nobrainercpp
pnpm install --frozen-lockfile
pnpm run compile
code .
```

In the repository window, select **Run Extension** in **Run and Debug** and press F5. The Extension Development Host opens a second window with NBCpp loaded from your checkout. In **that second window**, open a folder for your exercises and save the following program as `main.cpp`.

```cpp
#include <iostream>

int main() {
    int n = 0;
    std::cin >> n;
    std::cout << n + 1 << '\n';
}
```

Set a breakpoint on the output statement. Click **Smart Run** in the editor toolbar, enter `41` in the integrated terminal and press Enter. When the debugger stops, inspect `n` and press F10. The terminal should print `42`. F5 in the repository window starts the development host. F5 in the exercise folder starts a C++ debug session with the NBCpp launch configuration. [Extension host launch configuration](https://github.com/realsxb/nobrainercpp/blob/main/.vscode/launch.json)

### Tested single-file programs

We compiled and ran these two programs in directories with spaces and Chinese characters. Both used the bundled compilers and sysroot with the same arguments as the generated build tasks. The test processes had only the bundled tool directory and Windows System32 on PATH. Each program read its output file back and checked the result.

| Language | Operations exercised | Input and result |
| --- | --- | --- |
| C | Read a name and three integers into a structure using `scanf`, sum an integer array, write the result with `fprintf`, then read and check it with `fscanf` and `strcmp`. | `Alice 3 11 -2` produced `Alice 12` in the output file and on standard output. |
| C++ | Read words from `std::cin` into a template class backed by `std::vector<std::string>`, call `std::sort`, write with `std::ofstream` and read back with `std::ifstream`. | For `cat apple fish`, the output order was `apple cat fish`. |

The default build task compiles the active source file. For a program that links multiple source files, include those files in the project's build configuration. An external SDK needs its own headers, libraries and search paths. For a different library or language-standard feature, check the selected compiler and the build options used by that project.

## How a debug session starts

1. **Resolve the source file.** Smart Run identifies the active C or C++ file, saves changes and finds the workspace folder that owns it. The build task carries the file path, language and compiler path, so equally named files in different workspace folders can be debugged separately. [Extension entry point](https://github.com/realsxb/nobrainercpp/blob/main/src/extension.ts)
2. **Discover compilers and debuggers.** NBCpp searches PATH for GNU, Clang and MSVC tools concurrently. For example, a C++ build can proceed once the results seen so far include a C++ compiler and a debugger. When the searches finish, NBCpp prefers a complete toolchain in GNU, Clang, MSVC order. It combines available tools by language when needed. A machine with only a system C compiler can still use the bundled Clang++ for C++. MSVC detection requires an initialized header and library environment. If a cached executable moves, a subsequent run searches again. [Toolchain discovery](https://github.com/realsxb/nobrainercpp/blob/main/src/toolchainFinder.ts)
3. **Choose the tasks and debug adapter.** The compiler runs as a separate process and receives the filename and flags as individual arguments. NBCpp can generate build, launch and IntelliSense configurations, and recognizes files edited by the user. With Microsoft's C/C++ extension installed, the configuration generator can select `cppdbg` for a matching GDB setup or `cppvsdbg` for MSVC. Other supported Windows configurations can use the bundled LLDB debug adapter. [Configuration generator](https://github.com/realsxb/nobrainercpp/blob/main/src/configuration.ts) · [Workspace files and migration](https://github.com/realsxb/nobrainercpp/blob/main/src/projectFiles.ts)
4. **Connect program input to the terminal.** After a successful build, a VS Code process task runs the native launcher. It creates the target in a suspended state in the integrated terminal and sends its process ID to the extension over a session-specific named pipe. LLDB attaches to that ID. The target thread resumes after breakpoint configuration, allowing short-lived programs to hit the first user breakpoint and allowing `scanf` and `std::cin` to read terminal input. Restarting creates a fresh adapter and target. A Windows Job Object ties the target's lifetime to its launcher. [VS Code integration](https://github.com/realsxb/nobrainercpp/blob/main/src/terminalDebugger.ts) · [Native launcher](https://github.com/realsxb/nobrainercpp/blob/main/native/terminal-launcher.c)

The earliest launcher created a separate console and printed the suspended target's process ID to standard output. In 1.4.1, PowerShell compiled a C# launcher and the extension polled a temporary PID file. Version 1.5.0 introduced the process task and named pipe. The bundled Windows build of LLDB 21.1.8 lacks the FIFO implementation that upstream LLDB needs for its native `runInTerminal` request. [Early C++ launcher](https://github.com/realsxb/nobrainercpp/blob/main/native/legacy/launcher.cpp) · [Early PowerShell script](https://github.com/realsxb/nobrainercpp/blob/main/Start-Debug.ps1) · [LLVM 21.1.8 implementation](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.8/lldb/tools/lldb-dap/FifoFiles.cpp)

## Test and package locally

```powershell
pnpm test
```

The test command compiles TypeScript and runs ESLint before launching an isolated extension host with other installed extensions disabled. It uses a temporary workspace to cover toolchain discovery and migration of existing configurations. On Windows x64, integration tests exercise C and C++ breakpoints, stepping, terminal input and restarting. To select a local VS Code installation, first set `$env:VSCODE_TEST_EXECUTABLE` to the full path to its `Code.exe`. [Test host configuration](https://github.com/realsxb/nobrainercpp/blob/main/.vscode-test.mjs) · [Debug integration tests](https://github.com/realsxb/nobrainercpp/blob/main/src/test/extension.test.ts)

Microsoft's packaging tool can build a Windows x64 VSIX for local testing.

```powershell
pnpm dlx @vscode/vsce ls --no-dependencies
pnpm dlx @vscode/vsce package --target win32-x64 --no-dependencies --out nbcpp-local.vsix
```

The first command lists the packaged files. Check for `out/extension.js`, `bin/terminal-launcher.exe`, `lldbv1.0/` and `third-party-notices/`. The second command creates a local VSIX. Choose **Install from VSIX** in the Extensions view to try it. The published 1.5.0 VSIX used a universal package label and bundled Windows x64 binaries. The local packaging command above explicitly selects the Windows x64 target. [Packaging rules](https://github.com/realsxb/nobrainercpp/blob/main/.vscodeignore) · [VS Code packaging documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions)

## Rebuild the native launcher

The project builds `bin/terminal-launcher.exe` from its C source. With MinGW-w64 GCC for Windows x64 installed, run the following from the repository root. PowerShell needs the linker option in quotes so GCC receives it as one argument.

```powershell
gcc -std=c11 -Os -Wall -Wextra -Werror -municode -static -s '-Wl,--no-insert-timestamp' native/terminal-launcher.c -o bin/terminal-launcher.exe
pnpm test
```

The historical `native/legacy/launcher.cpp` comes from the project's public design notes and corresponds to the main program in the old `launcher.exe` at the repository root. It uses the narrow-character Windows process API and illustrates the early separate-console design. Changes to the current terminal behavior belong in the C launcher.

## Bundled LLVM layout and build history

On a Linux host or in WSL, start with the Python build entry point. Run `python3 toolchain/build.py --help` from the repository root to list its source check, host tools, instrumented build, profile training and final build stages. The accompanying packaging script stages and verifies the toolchain layout. You can use the checked-in `lldbv1.0/` tree when installing and testing the extension from source. [Build script](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/build.py) · [Toolchain packaging script](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/package.py) · [Toolchain build guide](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/README.md) · [中文工具链构建说明](https://github.com/realsxb/nobrainercpp/blob/main/toolchain/README.zh-CN.md)

| Repository path | Contents and purpose |
| --- | --- |
| `lldbv1.0/bin/` | Clang and Clang++ compile the source, LLD links the executable and LLDB DAP communicates with VS Code. The directory also contains runtime DLLs used by the tools and compiled programs. |
| `lldbv1.0/lib/clang/21/` | Clang resource headers and the compiler-rt builtins library for the target. |
| `lldbv1.0/x86_64-w64-mingw32/` | Windows target sysroot with MinGW-w64 headers, startup objects, import libraries and libc++ headers. An additional aggregate header supports existing exercises that include `<bits/stdc++.h>`. |

In a cross-build, `llvm-tblgen` and `clang-tblgen` must run on the **build host** to generate source code. The final `clang.exe` and `lldb-dap.exe` must run on the **user's Windows x64 machine**. Early work used CMake and Ninja to produce the host tools, then used llvm-mingw to build the required LLVM components for Windows and assembled the target sysroot shown above. Size experiments included ThinLTO and profile-guided optimization (PGO), with instrumented Windows tools run under Wine and profiles merged with `llvm-profdata`. Some historical dependency revisions, build settings and training inputs are still unknown. A byte-for-byte reconstruction of all prebuilt components has yet to be established.

To inspect the installed version and compiler target triple, run the following. After replacing tools or headers, compile a C sample and a C++ sample that uses the standard library, then run the interactive debug tests. The bundled `clang.cfg`, the sysroot passed to the build task and the runtime DLL search path all affect the result.

```powershell
.\lldbv1.0\bin\clang.exe --version
.\lldbv1.0\bin\lldb-dap.exe --version
```

The bundled Clang and LLDB identify themselves as 21.1.8. The matching LLVM release source is available at tag `llvmorg-21.1.8`. Version macros in the MinGW-w64 headers identify 14.0.0 alpha. The exact historical build revisions for the complete sysroot and each runtime component remain to be documented. [LLVM 21.1.8 source](https://github.com/llvm/llvm-project/tree/llvmorg-21.1.8) · [llvm-mingw build scripts](https://github.com/mstorsjo/llvm-mingw) · [MinGW-w64 source](https://github.com/mingw-w64/mingw-w64)

## Licenses

NBCpp's extension and launchers use the repository's MIT license. Bundled components retain their applicable upstream terms. LLVM 21.1.8 primarily uses Apache 2.0 with LLVM Exceptions, with additional notices for some subprojects. The MinGW-w64 headers, runtimes and winpthreads also carry their own notices. The repository includes licenses from the corresponding LLVM release and reference notices from the MinGW-w64 v14.0.0 release tree, alongside the copyright markings present in individual files. [NBCpp license](../LICENSE) · [Bundled third-party notices](../third-party-notices/) · [LLVM upstream license](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.8/LICENSE.TXT) · [MinGW-w64 runtime notices](https://github.com/mingw-w64/mingw-w64/blob/v14.0.0/COPYING.MinGW-w64-runtime/COPYING.MinGW-w64-runtime.txt) · [winpthreads notice](https://github.com/mingw-w64/mingw-w64/blob/v14.0.0/mingw-w64-libraries/winpthreads/COPYING)
