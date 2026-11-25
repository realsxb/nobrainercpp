#!/usr/bin/env python3
"""Assemble or inspect the NBCpp Windows x64 bundle (Python 3.9+)."""
import argparse
from pathlib import Path
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / "lldbv1.0"
TARGET = "x86_64-w64-mingw32"
BUILTINS = Path("lib/clang/21/lib/x86_64-w64-windows-gnu/libclang_rt.builtins.a")
RUNTIME = {"libc++.dll", "libunwind.dll", "libwinpthread-1.dll"}
ALIASES = {"clang++.exe": "clang.exe", "clang-cl.exe": "clang.exe", "ld.lld.exe": "lld.exe"}


def inventory():
    # The delivered file list expresses the historical header/library trimming.
    raw = subprocess.check_output(["git", "-C", ROOT, "ls-files", "-z", "--", "lldbv1.0/"])
    files = [Path(name.decode("utf-8")).relative_to("lldbv1.0") for name in raw.split(b"\0") if name]
    for expected in ["bin/lldb-dap.exe", "bin/clang++.exe", str(BUILTINS),
                     TARGET + "/include/c++/v1/iostream", TARGET + "/lib/crt2.o"]:
        if Path(expected) not in files:
            raise ValueError("Reference inventory is incomplete: " + expected)
    return files


def source_for(rel, final, sdk):
    if rel in (Path("bin/clang.cfg"), Path("bin/clang++.cfg"),
               Path(TARGET + "/include/c++/v1/bits/stdc++.h")):
        return [REFERENCE / rel]  # NBCpp overlays.
    if rel.parts[0] == "bin":
        if rel.name in RUNTIME:
            return [sdk / TARGET / "bin" / rel.name]
        paths = [final / rel]
        if rel.name in ALIASES:
            paths.append(final / "bin" / ALIASES[rel.name])
        return paths
    if rel == BUILTINS:
        return [sdk / rel, sdk / "lib/clang/21/lib/windows/libclang_rt.builtins-x86_64.a"]
    if rel.parts[:2] == (TARGET, "include"):
        return [sdk / rel, sdk / "generic-w64-mingw32" / Path(*rel.parts[1:])]
    return [sdk / rel]


def verify(bundle, files):
    for rel in files:
        file = bundle / rel
        if not file.is_file():
            raise ValueError(f"Missing package member: {rel}")
        if file.suffix.lower() in (".exe", ".dll"):
            with file.open("rb") as stream:
                if stream.read(2) != b"MZ":
                    raise ValueError(f"Missing DOS header: {rel}")
                stream.seek(60)
                stream.seek(struct.unpack("<I", stream.read(4))[0])
                if stream.read(6) != b"PE\0\0\x64\x86":
                    raise ValueError(f"Expected Windows x64 PE: {rel}")
    with (bundle / BUILTINS).open("rb") as stream:
        if stream.read(8) != b"!<arch>\n":
            raise ValueError("Invalid compiler-rt archive.")
    print(f"Verified {len(files)} reference paths and x64 PE headers in {bundle}")


def stage(a, files):
    for p in (a.final, a.sdk, ROOT):
        if p == a.out or p in a.out.parents or a.out in p.parents:
            raise ValueError(f"Output overlaps an input: {p}")
    if a.out.exists():
        raise ValueError("Choose a new output directory.")
    copies = []
    for rel in files:
        source = next((p for p in source_for(rel, a.final, a.sdk) if p.is_file()), None)
        if not source:
            raise ValueError(f"Missing build/SDK input for {rel}")
        copies.append((source, a.out / rel))
    a.out.mkdir(parents=True, exist_ok=False)
    for source, destination in copies:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    verify(a.out, files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    check = modes.add_parser("verify")
    check.add_argument("bundle", type=Path)
    pack = modes.add_parser("stage")
    for name in ("final", "sdk", "out"):
        pack.add_argument("--" + name, type=lambda s: Path(s).resolve(), required=True)
    a = parser.parse_args()
    files = inventory()
    if a.mode == "verify":
        verify(a.bundle, files)
    else:
        stage(a, files)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, struct.error, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
