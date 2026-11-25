# Building the bundled Windows toolchain

[中文](README.zh-CN.md) · [Historical script excerpts](historical-recipe.md)

NBCpp ships an x86-64 Windows compiler, linker, debugger and a small MinGW sysroot in `lldbv1.0/`. The scripts in this directory reconstruct the project's build and packaging procedure. You can run the extension with the binaries already in the repository.

## What is known about the shipped bundle

Both the shipped Clang and LLDB report 21.1.8. The historical build notes name a Linux work directory for LLVM 21.1.8, a MinGW CMake toolchain file, a Wine workload named `train.sh`, and a packaging script named `sh-ctt-78`. The new driver pins the upstream release tag to commit `2078da43e25a4623cab2d0d60decddf709aaea28`. The exact historical source revision, local patches, llvm-mingw archive, SQLite revision, raw profiles and CMake cache have not been recovered. A fresh build can differ from the distributed executables. [LLVM 21.1.8 release](https://github.com/llvm/llvm-project/releases/tag/llvmorg-21.1.8)

The two surviving final-build recipes agree on X86, Clang/LLD/LLDB, MinSizeRel, ThinLTO, PGO, shared LLVM, and size-oriented compiler and linker flags. They differ on the install component list. This driver builds the necessary targets explicitly and uses the shipped file inventory to stage dependencies. One historical packaging log reports 106 MiB after applying UPX 4.2.2 to selected binaries, while three runtime DLLs declined compression. That log omits the LLDB executables. The public recipe leaves binaries unpacked.

## Prepare the inputs

Use an x86-64 Linux host or WSL with a native C/C++17 compiler, Python 3.9+, Git, CMake, Ninja and a Wine installation capable of running x86-64 Windows executables. Include `winepath`. The example assumes Bash and a new build directory outside both source trees.

1. Clone the upstream LLVM release. The following commands pin its identity and check the required project roots.

   ```bash
   git clone --depth 1 --branch llvmorg-21.1.8 https://github.com/llvm/llvm-project.git llvm-project
   T=/absolute/path/to/nobrainercpp/toolchain
   SRC="$(realpath llvm-project)"
   python3 "$T/build.py" check-source --source "$SRC"
   ```

2. Extract a **Linux-hosted** llvm-mingw SDK built with LLVM 21 and UCRT into a separate directory. It supplies the Windows target headers, both C++ runtime libraries, x64 compiler-rt builtins and instrumentation runtime, binutils and target Clang drivers. Check that the archive contains `bin/x86_64-w64-mingw32-clang++`, `lib/clang/21` and `x86_64-w64-mingw32/lib`. Record the exact archive filename and SHA-256 for your build. [llvm-mingw releases](https://github.com/mstorsjo/llvm-mingw/releases)
3. Extract an SQLite amalgamation archive with its shell into a directory containing `sqlite3.c`, `sqlite3.h` and `shell.c`. Keep the accompanying headers and record the release and archive hash. The training script compiles these inputs and refuses to substitute an empty workload. [SQLite source downloads](https://sqlite.org/download.html)

## Build and collect the profile

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

- **Host** builds native table generators and a matching `llvm-profdata`. **Instrument** cross-compiles Windows Clang and LLD with IR profile instrumentation.
- **Train** gives Wine its own prefix in the training output. It compiles and links the SQLite shell, compiles a C++ STL/exception workload with and without ThinLTO, then links 50 objects with identical code folding and section garbage collection. The Windows tools write `.profraw` files. The native merger produces `train/llvm.profdata`. These workloads exercise Clang and LLD. LLDB is introduced in the final stage.
- **Final** builds Clang, LLD, LLDB and `lldb-dap` with `-Oz -DNDEBUG -g0`, ThinLTO, PGO and shared LLVM/Clang libraries. LLDB Python, Lua, curses, libedit and several optional libraries are disabled. The build driver lists the full set of flags.

Each stage creates a new directory. Inputs and existing outputs are protected from replacement. For an interrupted Ninja compilation, use the `cmake --build` command printed by the driver after resolving the failure; preserve the SDK environment for cross builds (`export NBCPP_LLVM_MINGW="$SDK"`). A new training run needs a fresh output. [LLVM PGO guide](https://releases.llvm.org/21.1.0/docs/HowToBuildWithPGO.html)

## Assemble and verify the distribution

```bash
python3 "$T/package.py" stage --final "$WORK/final" --sdk "$SDK" --out "$WORK/dist/lldbv1.0"
python3 "$T/package.py" verify "$WORK/dist/lldbv1.0"
```

Run the packaging script from a Git checkout of NBCpp. It takes the tracked paths in `lldbv1.0/` as the allowlist, resolves every input before copying, and checks the resulting x64 PE files and compiler-rt archive. The compiler, LLD and LLDB binaries come from the final build. The SDK supplies runtime DLLs, Clang resources, CRT objects, selected Windows import libraries and the MinGW/libc++ headers. The two Clang driver configuration files and the NBCpp `bits/stdc++.h` compatibility header come from this repository. Preserve the applicable upstream notices alongside any redistributed binary package. [Third-party notices](../third-party-notices/)

**Validation scope.** The release tag and project roots were checked against an upstream checkout. The Python and CMake files passed syntax checks. A fresh staging directory assembled from previously built inputs matched all 2,697 tracked files in the current distribution byte for byte. This validates the packaging paths and copies. Running the complete Linux/Wine training and LLVM rebuild from clean sources remains pending. On a rebuilt bundle, compile and debug a C program and a C++ program on Windows before release.
