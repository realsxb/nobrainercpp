# 历史构建脚本节选 · Historical build excerpts

这些片段来自 NBCpp 早期的 LLVM/LLDB 构建手册。手册显示作者在 LLVM 21.1.8 源码工作区中运行了打包命令 `bash sh-ctt-78`，将训练脚本记为 `train.sh`。两个留存的手册版本使用相同命令，修订版本调整了五行体积注释。以下节选保留历史选项；本机的 SDK 与输出目录改用变量。当前可执行的重建步骤见[中文指南](README.zh-CN.md)。

The early notebook records the packaging command `bash sh-ctt-78` and names the training script `train.sh`. Both surviving notebook versions contain the same commands and differ in five size annotations. The excerpts below retain the historical options, with local paths represented by variables. The [current build guide](README.md) describes the reconstructed procedure.

## 宿主与插桩构建 · Host and instrumented builds

手册先构建 Linux 原生表生成器与 profile 合并工具，再用它们交叉编译 Windows 插桩版 Clang/LLD。The historical host build supplied two native table generators and the profile merger for the Windows build.

```bash
cmake -G Ninja -S llvm -B build_host \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="clang;lld" \
    -DLLVM_TARGETS_TO_BUILD="X86" \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_TESTS=OFF
ninja -C build_host llvm-tblgen clang-tblgen llvm-profdata

cmake -G Ninja -S llvm -B build_pgo_instr \
    -DCMAKE_TOOLCHAIN_FILE="$PWD/toolchain-mingw.cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="clang;lld" \
    -DLLVM_TARGETS_TO_BUILD="X86" \
    -DLLVM_BUILD_INSTRUMENTED=IR \
    -DLLVM_BUILD_RUNTIME=No \
    -DLLVM_TABLEGEN="$PWD/build_host/bin/llvm-tblgen" \
    -DCLANG_TABLEGEN="$PWD/build_host/bin/clang-tblgen" \
    -DLLVM_PROFILE_DATA_DIR="$PWD/profiles/%p.profraw"
ninja -C build_pgo_instr clang lld
```

`LLVM_PROFILE_DATA_DIR` 的文件名写法按手册保留。新版在运行插桩工具时用 Wine 可识别的 Windows 路径设置 `LLVM_PROFILE_FILE`。The original entry used a filename pattern in the CMake profile-directory option. The new trainer sets the runtime filename explicitly using a path visible to Wine.

## train.sh 的训练输入 · Training workloads

`CLANG_EXE` 和 `CXX_EXE` 指向插桩构建目录中的 Windows 编译器。下面保留了修订后的 SQLite 双对象链接、C++ 普通编译、ThinLTO 和多对象压力链接。The flags retain the MinGW target, sysroot, LLD, compiler-rt, libunwind and libc++. The long flag string from the notebook is written here as a Bash array to preserve paths with spaces.

```bash
flags=(--target=x86_64-w64-mingw32 "--sysroot=$SDK/x86_64-w64-mingw32"
       -fuse-ld=lld -Wno-unused-command-line-argument --rtlib=compiler-rt
       --unwindlib=libunwind -stdlib=libc++)

wine "$CLANG_EXE" "${flags[@]}" -O3 -c sqlite3.c -o sqlite3.o
wine "$CLANG_EXE" "${flags[@]}" -O3 -c shell.c -o shell.o
wine "$CLANG_EXE" "${flags[@]}" shell.o sqlite3.o -o sqlite3.exe
wine "$CXX_EXE" "${flags[@]}" -O2 test_cpp.cpp -o test_cpp.exe
wine "$CXX_EXE" "${flags[@]}" -flto=thin -O2 test_cpp.cpp -o test_lto.exe
wine "$CXX_EXE" "${flags[@]}" -Wl,--icf=all -Wl,--gc-sections main.o stress_test_*.o -o stress_app.exe
build_host/bin/llvm-profdata merge -output=llvm.profdata profiles/*.profraw
```

原训练脚本生成了 50 个目标文件，C++ 样例使用容器、排序和异常处理；此节省略样例生成部分。The original workload generated 50 object files and a C++ workload using containers, sorting and exceptions. LLDB joined the build after training.

## 最终构建选项 · Final build options

以下是两版最终 CMake 命令共有的选项节选，选项与历史脚本相同。These are selected arguments shared by the two historical final configurations.

```text
-DCMAKE_BUILD_TYPE=MinSizeRel
-DLLVM_ENABLE_PROJECTS="clang;lld;lldb"
-DLLVM_ENABLE_LTO=Thin
-DLLVM_PROFDATA_FILE="$PWD/llvm.profdata"
-DLLVM_BUILD_LLVM_DYLIB=ON
-DLLVM_LINK_LLVM_DYLIB=ON
-DCMAKE_C_FLAGS_MINSIZEREL="-Oz -DNDEBUG -g0"
-DCMAKE_CXX_FLAGS_MINSIZEREL="-Oz -DNDEBUG -g0"
-DLLDB_ENABLE_PYTHON=OFF
-DLLDB_ENABLE_LUA=OFF
-DLLDB_ENABLE_CURSES=OFF
-DLLDB_ENABLE_LIBEDIT=OFF
-DLLDB_ENABLE_LIBXML2=OFF
-DLLDB_ENABLE_LZMA=OFF
-DCMAKE_EXE_LINKER_FLAGS="-Wl,--gc-sections -Wl,--icf=all -Wl,--strip-all"
```

第一版 `LLVM_DISTRIBUTION_COMPONENTS` 列出 `clang;lld;lldb;lldb-dap;clang-resource-headers;libclang-cpp;libLLVM`，后一版以 `clang-resource-headers` 结尾。两个版本随后均调用 `install-distribution`。The later component list omits the two shared-library entries. The separate packaging step explicitly copied the DLLs from the build tree.

## 文件筛选与压缩 · Selection and compression

原配方从 SDK 选取 CRT 对象、C/C++ 运行库与少量 Win32 导入库，并将 compiler-rt builtins 放到 Clang 目标三元组目录。以下为库清单与复制动作的节选，目标是新的 staging 目录。The example uses a fresh staging directory and shows a subset of the historical allowlist.

```bash
mkdir -p "$STAGE/x86_64-w64-mingw32/lib" "$STAGE/lib/clang/21/lib/x86_64-w64-windows-gnu"
for lib in libc++.a libc++abi.a libunwind.a libmingw32.a libmingwex.a libkernel32.a libws2_32.a; do
    cp "$SDK/x86_64-w64-mingw32/lib/$lib" "$STAGE/x86_64-w64-mingw32/lib/"
done
cp "$SDK/lib/clang/21/lib/windows/libclang_rt.builtins-x86_64.a" \
    "$STAGE/lib/clang/21/lib/x86_64-w64-windows-gnu/libclang_rt.builtins.a"
```

原脚本对复制品执行 strip，随后使用 UPX 的 `--best --lzma`。这里保留了压缩参数，将输出写到单独的新文件，并保留命令退出状态。The historical script applied strip to staged executables and DLLs and then attempted UPX compression in place. This excerpt retains the compression options and names a fresh output explicitly.

```bash
upx --best --lzma -o "$NEW_OUTPUT/clang-packed.exe" "$STAGE/bin/clang.exe"
```

留存日志列出 UPX 4.2.2 处理了 5 个 EXE、成功压缩了 2 个 DLL，另有 3 个带 GUARD_CF 的 DLL 未压缩。它没有列出 LLDB 可执行文件，日志末尾为 106M，修订注释为 102MB。当前已跟踪的包另含 LLDB、LLDB DAP 及其共享库，组装脚本按当前包的实际文件清单复制。The older thinning and compression log describes an earlier layout. The current package contains LLDB, its shared library and its DAP executable. Its tracked inventory is the reference for the new staging script.
