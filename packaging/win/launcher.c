// bunium Windows packaged-app launcher.
//
// Compiles to the packaged app's <Name>.exe (clang-cl, /SUBSYSTEM:WINDOWS) at
// package time -- see packaging/win/package.sh. Mirrors the macOS shell
// launcher from packaging/mac/package.sh, adapted to Windows' flat layout:
//
//   dist-app/Name/
//     Name.exe          this file, compiled
//     bun.exe           the Bun binary
//     Runtime/          CEF Release/ contents + bunium_shim.dll +
//                       bunium_subprocess.exe (browser-process DLL dir)
//     Resources/        CEF Resources/ (paks, icudtl.dat, locales/) -- the
//                       dir passed to bunium_init's resources_dir_path
//     app/              the app (dist/ + electron/main.ts + node_modules)
//
// What the launcher does (in order):
//   1. exports the four BUNIUM_* path overrides src/paths.ts reads, pointing
//      into this layout (SHIM + SUBPROCESS into Runtime/, FRAMEWORK_DIR at
//      Runtime/ -- unused on Windows but set for parity, RESOURCES_DIR at
//      Resources/, ROOT_CACHE_PATH at %LOCALAPPDATA%\<Name>\CEF);
//   2. prepends Runtime/ to PATH, so the loader resolves bunium_shim.dll's
//      libcef.dll import the same way the dev tree does (DLL search order);
//   3. spawns bun.exe on app/electron/main.ts, inheriting the caller's
//      standard handles so a CI/ssh run still sees the child's stdout/stderr,
//      and propagates its exit code (the packaging fixture verifier relies on
//      both).
//
// GUI subsystem: no console flash when double-clicked. Console runs get the
// real console handles (below), so `Name.exe` in CI/ssh still streams the
// app's output. The shim's interactive dialogs get real TaskDialogs because
// package.sh ships a bun.exe.manifest next to bun.exe (comctl32 v6 SxS
// activation is per-process, driven by the *executable's* manifest).

#define WIN32_LEAN_AND_MEAN
// MSVC CRT marks wcscat/wcscpy deprecated (the "_s" variants); this is a
// fixed-size building-block, the safe usage here, and warning noise otherwise.
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

// Join a\b (or a\b\c) into a fresh heap string. Callers free().
static WCHAR *JoinPath(const WCHAR *a, const WCHAR *b, const WCHAR *c) {
  size_t na = wcslen(a), nb = wcslen(b), nc = c ? wcslen(c) : 0;
  WCHAR *out = malloc((na + nb + nc + 3) * sizeof(WCHAR));
  if (!out) return NULL;
  wcscpy(out, a);
  wcscat(out, L"\\");
  wcscat(out, b);
  if (c) {
    wcscat(out, L"\\");
    wcscat(out, c);
  }
  return out;
}

static WCHAR *GetEnv(const WCHAR *name) {
  DWORD n = GetEnvironmentVariableW(name, NULL, 0);
  if (n == 0) return NULL;
  WCHAR *buf = malloc(n * sizeof(WCHAR));
  if (!buf) return NULL;
  GetEnvironmentVariableW(name, buf, n);
  return buf;
}

// A standard handle when the launcher has a real one (terminal / CI / ssh
// run), otherwise an inheritable NUL handle so a GUI-subsystem spawn from
// Explorer does not make bun.exe (a console-subsystem binary) pop its own
// console window. Returning NULL keeps the child running with no handle at
// all (last resort).
static HANDLE StdOrNul(DWORD stdId) {
  HANDLE h = GetStdHandle(stdId);
  if (h != NULL && h != INVALID_HANDLE_VALUE) return h;
  SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
  HANDLE nul =
      CreateFileW(L"\\\\.\\NUL", GENERIC_READ | GENERIC_WRITE, 0, &sa,
                  OPEN_EXISTING, 0, NULL);
  return (nul != INVALID_HANDLE_VALUE) ? nul : NULL;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR lpCmdLine,
                    int nCmdShow) {
  (void)hInst; (void)hPrev; (void)nCmdShow;

  WCHAR self[MAX_PATH];
  DWORD sn = GetModuleFileNameW(NULL, self, MAX_PATH);
  if (sn == 0 || sn >= MAX_PATH) return 127;
  WCHAR *slash = wcsrchr(self, L'\\');
  if (!slash) return 127;
  *slash = L'\0'; // self = package dir
  const WCHAR *name = wcsrchr(self, L'\\') ? wcsrchr(self, L'\\') + 1 : self;

  WCHAR *runtime = JoinPath(self, L"Runtime", NULL);
  WCHAR *resources = JoinPath(self, L"Resources", NULL);
  WCHAR *shim = JoinPath(runtime, L"bunium_shim.dll", NULL);
  WCHAR *subproc = JoinPath(runtime, L"bunium_subprocess.exe", NULL);
  WCHAR *bunPath = JoinPath(self, L"bun.exe", NULL);
  WCHAR *mainPath = JoinPath(self, L"app", L"electron\\main.ts");
  if (!runtime || !resources || !shim || !subproc || !bunPath || !mainPath)
    return 127;

  // 1. Path overrides (src/paths.ts reads these, env wins over dev tree).
  SetEnvironmentVariableW(L"BUNIUM_SHIM_PATH", shim);
  SetEnvironmentVariableW(L"BUNIUM_SUBPROCESS_PATH", subproc);
  SetEnvironmentVariableW(L"BUNIUM_FRAMEWORK_DIR", runtime);
  SetEnvironmentVariableW(L"BUNIUM_RESOURCES_DIR", resources);

  // Per-app CEF profile, mirroring the macOS launcher's per-app Application
  // Support dir: two crunchy bunium processes never abort each other over
  // CEF's ProcessSingleton, and cookies/cache stay private to the app.
  WCHAR *la = GetEnv(L"LOCALAPPDATA");
  if (!la) {
    WCHAR *profile = GetEnv(L"USERPROFILE");
    if (profile) {
      size_t n = wcslen(profile) + wcslen(L"\\AppData\\Local") + 1;
      la = malloc(n * sizeof(WCHAR));
      if (la) {
        wcscpy(la, profile);
        wcscat(la, L"\\AppData\\Local");
      }
      free(profile);
    }
  }
  if (la) {
    WCHAR *cache = JoinPath(la, name, L"CEF");
    if (cache) {
      SetEnvironmentVariableW(L"BUNIUM_ROOT_CACHE_PATH", cache);
      free(cache);
    }
    free(la);
  }

  // 2. PATH: Runtime/ first so libcef.dll (an import of bunium_shim.dll)
  // resolves, exactly like the dev tree's "native/build on PATH" recipe.
  WCHAR *oldPath = GetEnv(L"PATH");
  size_t pathN = wcslen(runtime) + 1;
  if (oldPath && *oldPath) pathN += 1 + wcslen(oldPath);
  WCHAR *newPath = malloc(pathN * sizeof(WCHAR));
  if (newPath) {
    wcscpy(newPath, runtime);
    if (oldPath && *oldPath) {
      wcscat(newPath, L";");
      wcscat(newPath, oldPath);
    }
    SetEnvironmentVariableW(L"PATH", newPath);
    free(newPath);
  }
  free(oldPath);

  // 3. Spawn the bundled bun on the app entry, appending the caller's raw
  // command line (already shell-escaped for this process, so re-quoting
  // would corrupt it).
  size_t clLen = lpCmdLine ? wcslen(lpCmdLine) : 0;
  size_t gap = (clLen && *lpCmdLine == L' ') ? 0 : 1;
  WCHAR *cmd = malloc((wcslen(bunPath) + 3 + wcslen(mainPath) + 3 + clLen +
                       gap) *
                      sizeof(WCHAR));
  if (!cmd) return 127;
  wcscpy(cmd, L"\"");
  wcscat(cmd, bunPath);
  wcscat(cmd, L"\" \"");
  wcscat(cmd, mainPath);
  wcscat(cmd, L"\"");
  if (clLen) {
    if (gap) wcscat(cmd, L" ");
    wcscat(cmd, lpCmdLine);
  }

  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = StdOrNul(STD_INPUT_HANDLE);
  si.hStdOutput = StdOrNul(STD_OUTPUT_HANDLE);
  si.hStdError = StdOrNul(STD_ERROR_HANDLE);

  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  BOOL ok = CreateProcessW(bunPath, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si,
                           &pi);
  if (!ok) return 127;

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return (int)code;
}