// Build with MinGW-w64: gcc -std=c11 -Os -Wall -Wextra -Werror -municode -static -s -Wl,--no-insert-timestamp native/terminal-launcher.c -o bin/terminal-launcher.exe
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

typedef struct {
    HANDLE pipe;
    HANDLE initial_thread;
} Session;

static void report_error(HANDLE pipe, DWORD error) {
    char message[48];
    DWORD written;
    int length = snprintf(message, sizeof(message), "ERR %lu\n", (unsigned long)error);
    WriteFile(pipe, message, (DWORD)length, &written, NULL);
    fprintf(stderr, "NBCpp: failed to start the program (Windows error %lu).\n",
            (unsigned long)error);
}

// The first two arguments (our executable path and pipe name) cannot contain a
// literal quote. Pass the remaining command line to the child byte-for-byte.
static wchar_t *target_command_line(void) {
    wchar_t *cursor = GetCommandLineW();
    for (int i = 0; i < 2; i++) {
        int quoted = 0;
        while (*cursor == L' ' || *cursor == L'\t') ++cursor;
        while (*cursor && (quoted || (*cursor != L' ' && *cursor != L'\t'))) {
            if (*cursor++ == L'"') quoted = !quoted;
        }
    }
    while (*cursor == L' ' || *cursor == L'\t') ++cursor;
    return cursor;
}

// The extension keeps the pipe open for the whole session. Losing it (e.g.
// the editor closes) ends the wait even if the child is stopped at a breakpoint.
static DWORD WINAPI monitor_session(void *data) {
    Session *session = data;
    char command;
    DWORD count;
    if (!ReadFile(session->pipe, &command, 1, &count, NULL) ||
        count != 1 || command != 'R') return 1;
    if (ResumeThread(session->initial_thread) == (DWORD)-1) return 1;
    while (ReadFile(session->pipe, &command, 1, &count, NULL) && count == 1) {
        if (command == 'X') break;
    }
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 3) return 2;
    HANDLE pipe = CreateFileW(argv[1], GENERIC_READ | GENERIC_WRITE, 0, NULL,
                              OPEN_EXISTING, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) return 1;

    // Closing the VS Code terminal terminates the helper. The OS then closes
    // the last job handle and releases this session's target and its children.
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                         &limits, sizeof(limits))) {
        report_error(pipe, GetLastError());
        return 1;
    }
    // Assign the job atomically at process creation. Closing the terminal even
    // during startup cannot strand a suspended child between two API calls.
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, size);
    if (!startup.lpAttributeList) {
        report_error(pipe, ERROR_OUTOFMEMORY);
        return 1;
    }
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &size) ||
        !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                   &job, sizeof(job), NULL, NULL)) {
        report_error(pipe, GetLastError());
        return 1;
    }
    PROCESS_INFORMATION child;
    if (!CreateProcessW(argv[2], target_command_line(), NULL, NULL, TRUE,
                        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL,
                        &startup.StartupInfo, &child)) {
        report_error(pipe, GetLastError());
        return 1;
    }
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);

    char message[32];
    DWORD written;
    int length = snprintf(message, sizeof(message), "%lu\n", (unsigned long)child.dwProcessId);
    if (!WriteFile(pipe, message, (DWORD)length, &written, NULL) || written != (DWORD)length) return 1;
    Session session = {pipe, child.hThread};
    HANDLE monitor = CreateThread(NULL, 0, monitor_session, &session, 0, NULL);
    if (!monitor) return 1;
    HANDLE events[] = {child.hProcess, monitor};
    DWORD exit_code = 1;
    if (WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0)
        GetExitCodeProcess(child.hProcess, &exit_code);
    // The monitor may still be blocked in ReadFile. Exiting the process closes
    // its thread and all handles, including the job that owns the target.
    ExitProcess(exit_code);
}
