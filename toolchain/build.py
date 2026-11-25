#!/usr/bin/env python3
"""Build the NBCpp x64 Windows tools on Linux (Python 3.9+)."""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

REVISION = "2078da43e25a4623cab2d0d60decddf709aaea28"  # llvmorg-21.1.8
TRIPLE = "x86_64-w64-mingw32"
NATIVE = ("llvm-tblgen", "llvm-min-tblgen", "clang-tblgen", "lldb-tblgen", "llvm-profdata")


def run(args, **kwargs):
    print("+", shlex.join(map(str, args)), flush=True)
    subprocess.run(args, check=True, **kwargs)


def require(paths):
    for p in paths:
        if not p.is_file():
            raise ValueError(f"Missing input: {p}")


def source_check(root):
    require(root / sub / "CMakeLists.txt" for sub in ("llvm", "lld", "clang", "lldb"))
    head = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    if head != REVISION:
        raise ValueError(f"Expected llvmorg-21.1.8 ({REVISION}), found {head}")


def new_directory(output, inputs):
    # Resolve existing symlinks in the parent before checking boundaries.
    for item in inputs:
        item = item.resolve()
        if output == item or item in output.parents or output in item.parents:
            raise ValueError(f"Output overlaps an input: {item}")
    output.mkdir(parents=True, exist_ok=False)


def compile_stage(a):
    source_check(a.source)
    options = ["-DLLVM_TARGETS_TO_BUILD=X86", "-DLLVM_INCLUDE_TESTS=OFF",
               "-DLLVM_INCLUDE_BENCHMARKS=OFF", "-DLLDB_INCLUDE_TESTS=OFF"]
    env = os.environ.copy()
    inputs = [a.source, Path(__file__).resolve().parent.parent]
    if a.stage == "host":
        options += ["-DCMAKE_BUILD_TYPE=Release", "-DLLVM_ENABLE_PROJECTS=clang;lld;lldb",
                    "-DLLDB_ENABLE_PYTHON=OFF", "-DLLDB_ENABLE_LUA=OFF"]
        targets = NATIVE
    else:
        inputs += [a.sdk, a.host]
        require(a.host / "bin" / name for name in NATIVE)
        require(a.sdk / "bin" / name for name in (TRIPLE + "-clang", TRIPLE + "-clang++",
                TRIPLE + "-windres", "llvm-ar", "llvm-ranlib"))
        env["NBCPP_LLVM_MINGW"] = str(a.sdk)
        options += [f"-DCMAKE_TOOLCHAIN_FILE={Path(__file__).with_name('mingw.cmake').resolve()}",
                    f"-DLLVM_NATIVE_TOOL_DIR={a.host / 'bin'}", "-DLLVM_USE_LINKER=lld",
                    "-DLLVM_DEFAULT_TARGET_TRIPLE=" + TRIPLE]
        if a.stage == "instrument":
            options += ["-DCMAKE_BUILD_TYPE=Release", "-DLLVM_ENABLE_PROJECTS=clang;lld",
                        "-DLLVM_BUILD_INSTRUMENTED=IR", "-DLLVM_BUILD_RUNTIME=OFF"]
            targets = ("clang", "lld")
        else:
            require([a.profile])
            inputs.append(a.profile)
            options += ["-DCMAKE_BUILD_TYPE=MinSizeRel", "-DLLVM_ENABLE_PROJECTS=clang;lld;lldb",
                        "-DLLVM_ENABLE_LTO=Thin", f"-DLLVM_PROFDATA_FILE={a.profile}",
                        "-DLLVM_BUILD_LLVM_DYLIB=ON", "-DLLVM_LINK_LLVM_DYLIB=ON",
                        "-DCLANG_LINK_CLANG_DYLIB=ON", "-DCMAKE_C_FLAGS_MINSIZEREL=-Oz -DNDEBUG -g0",
                        "-DCMAKE_CXX_FLAGS_MINSIZEREL=-Oz -DNDEBUG -g0",
                        "-DCMAKE_EXE_LINKER_FLAGS=-Wl,--gc-sections,--icf=all,--strip-all",
                        "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,--gc-sections,--icf=all,--strip-all"]
            options += ["-D" + k + "=OFF" for k in (
                "LLDB_ENABLE_PYTHON", "LLDB_ENABLE_LUA", "LLDB_ENABLE_CURSES", "LLDB_ENABLE_LIBEDIT",
                "LLDB_ENABLE_LIBXML2", "LLDB_ENABLE_LZMA", "LLVM_ENABLE_ZLIB", "LLVM_ENABLE_ZSTD",
                "LLVM_ENABLE_LIBXML2", "LLVM_ENABLE_LIBEDIT", "LLVM_ENABLE_BACKTRACES",
                "LLVM_ENABLE_CRASH_OVERRIDES", "LLVM_ENABLE_DIA_SDK", "LLVM_ENABLE_PLUGINS",
                "LLVM_ENABLE_CONTROL_FLOW_GUARD", "CLANG_ENABLE_STATIC_ANALYZER", "CLANG_ENABLE_ARCMT")]
            targets = ("clang", "lld", "lldb", "lldb-dap")
    new_directory(a.out, inputs)
    run(["cmake", "-S", a.source / "llvm", "-B", a.out, "-G", "Ninja", *options], env=env)
    run(["cmake", "--build", a.out, "--parallel", str(a.jobs), "--target", *targets], env=env)


def train(a):
    sql = [a.sqlite / name for name in ("sqlite3.c", "sqlite3.h", "shell.c")]
    compiler = a.instrument / "bin" / "clang.exe"
    linker = a.instrument / "bin" / "lld.exe"
    merger = a.host / "bin" / "llvm-profdata"
    require(sql + [compiler, linker, merger])
    if not shutil.which("wine") or not shutil.which("winepath"):
        raise ValueError("Install Wine with x86_64 PE support and winepath.")
    resource = a.sdk / "lib/clang/21"
    sysroot = a.sdk / TRIPLE
    require([sysroot / "lib/libc++.a", resource / "include/stddef.h"])
    new_directory(a.out, [a.sqlite, a.instrument, a.sdk, a.host, Path(__file__).resolve().parent.parent])
    raw = a.out / "raw"
    raw.mkdir()
    env = {**os.environ, "WINEPREFIX": str(a.out / "wine"), "WINEDEBUG": "-all"}

    def win(p):
        return subprocess.check_output(["winepath", "-w", p], env=env, text=True).strip()

    env["WINEPATH"] = ";".join(win(p) for p in (compiler.parent, sysroot / "bin"))
    env["LLVM_PROFILE_FILE"] = win(raw) + r"\%m-%p.profraw"
    # lld selects the GNU driver from its filename; keep the original build tree read-only.
    shutil.copy2(linker, a.out / "ld.lld.exe")
    flags = ["--target=" + TRIPLE, "--sysroot=" + win(sysroot), "-resource-dir", win(resource),
             "--ld-path=" + win(a.out / "ld.lld.exe"), "-fuse-ld=lld", "--rtlib=compiler-rt",
             "--unwindlib=libunwind", "-Wno-unused-command-line-argument"]

    def clang(args, cpp=False):
        mode = ["--driver-mode=g++", "-stdlib=libc++"] if cpp else []
        run(["wine", compiler, *mode, *flags, *args], cwd=a.out, env=env)

    for name in ("sqlite3", "shell"):
        clang(["-O3", "-c", win(a.sqlite / (name + ".c")), "-o", name + ".o"])
    clang(["shell.o", "sqlite3.o", "-o", "sqlite.exe"])

    (a.out / "sample.cpp").write_text(
        "#include <algorithm>\n#include <vector>\n#include <map>\n#include <stdexcept>\n"
        "int main(int n, char**) { std::vector<int> v{n,2,1}; std::sort(v.begin(),v.end()); "
        "std::map<int,int> m{{n,v[0]}}; try { return m.at(0); } "
        "catch(const std::out_of_range&) { return 0; } }\n", encoding="utf-8")
    for name, extra in (("cpp", []), ("thin", ["-flto=thin"])):
        clang(["-O2", *extra, "sample.cpp", "-o", name + ".exe"], cpp=True)
    objects = []
    for i in range(50):
        unit = f"unit{i}"
        (a.out / (unit + ".cpp")).write_text(
            f"template<class T>T twice(T n){{return n+n;}} int f{i}(int n){{return twice(n);}}\n",
            encoding="utf-8")
        clang(["-O2", "-ffunction-sections", "-c", unit + ".cpp", "-o", unit + ".o"], cpp=True)
        objects.append(unit + ".o")
    (a.out / "main.cpp").write_text(
        "".join(f"int f{i}(int);\n" for i in range(50)) +
        "int main(int n,char**){ return " + "+".join(f"f{i}(n)" for i in range(50)) + "; }\n",
        encoding="utf-8")
    clang(["main.cpp", *objects, "-Wl,--gc-sections,--icf=all", "-o", "many.exe"], cpp=True)
    profiles = sorted(p for p in raw.glob("*.profraw") if p.stat().st_size)
    if not profiles:
        raise ValueError("Wine produced no raw profiles.")
    run([merger, "merge", "-o", a.out / "llvm.profdata", *profiles])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    stages = parser.add_subparsers(dest="stage", required=True)
    for stage in ("check-source", "host", "instrument", "train", "final"):
        cmd = stages.add_parser(stage)
        if stage != "train":
            cmd.add_argument("--source", type=lambda s: Path(s).resolve(), required=True)
        if stage != "check-source":
            cmd.add_argument("--out", type=lambda s: Path(s).resolve(), required=True, help="new output directory")
        if stage not in ("check-source", "train"):
            cmd.add_argument("-j", "--jobs", type=int, default=2)
        if stage in ("instrument", "train", "final"):
            cmd.add_argument("--sdk", type=lambda s: Path(s).resolve(), required=True)
            cmd.add_argument("--host", type=lambda s: Path(s).resolve(), required=True)
        if stage == "train":
            cmd.add_argument("--instrument", type=lambda s: Path(s).resolve(), required=True)
            cmd.add_argument("--sqlite", type=lambda s: Path(s).resolve(), required=True)
        if stage == "final":
            cmd.add_argument("--profile", type=lambda s: Path(s).resolve(), required=True)
    a = parser.parse_args()
    if a.stage == "check-source":
        source_check(a.source)
        print("LLVM 21.1.8 source revision confirmed.")
        return
    if sys.platform != "linux":
        parser.error("Use a Linux host or WSL for the build stages.")
    if getattr(a, "jobs", 1) < 1:
        parser.error("jobs must be positive")
    if a.stage == "train":
        train(a)
    else:
        compile_stage(a)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
