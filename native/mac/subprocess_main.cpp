#include "bunium_common.h"
#include "include/cef_app.h"
#include "include/cef_sandbox_mac.h"
#include "include/wrapper/cef_library_loader.h"

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif
#include <cstdio>
#include <cstdlib>

#if defined(__APPLE__)
// DEBUG (packaging bisect): dump mainBundle identity before CEF takes over.
static void DumpBundleDebug(const char *who, int argc, char *argv[]) {
  if (!getenv("BUNIUM_BUNDLE_DEBUG"))
    return;
  CFBundleRef mb = CFBundleGetMainBundle();
  CFURLRef url = mb ? CFBundleCopyBundleURL(mb) : nullptr;
  CFStringRef id = mb ? CFBundleGetIdentifier(mb) : nullptr;
  char urlbuf[1024] = "?";
  if (url) {
    CFURLGetFileSystemRepresentation(url, true, (UInt8 *)urlbuf,
                                     sizeof(urlbuf));
    CFRelease(url);
  }
  char idbuf[256] = "?";
  if (id) {
    CFStringGetCString(id, idbuf, sizeof(idbuf), kCFStringEncodingUTF8);
  }
  bool no_sandbox_switch = false;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--no-sandbox") == 0)
      no_sandbox_switch = true;
  }
  fprintf(stderr,
          "[bundle-debug %s] pid=%d argv0=%s mainBundleURL=%s identifier=%s noSandboxSwitch=%d\n",
          who, (int)getpid(), argc > 0 ? argv[0] : "?", urlbuf, idbuf,
          no_sandbox_switch ? 1 : 0);
}
#endif

// Standalone helper executable. CEF re-execs this binary (via
// cef_settings.browser_subprocess_path) for renderer/GPU/utility processes.
// CefExecuteProcess inspects argv (CEF injects --type=... itself) and
// dispatches accordingly, then returns >= 0 when this process should exit.
int main(int argc, char *argv[]) {
#if defined(__APPLE__)
  DumpBundleDebug("subprocess", argc, argv);
#endif
  const char *cache_root = getenv("BUNIUM_ROOT_CACHE_PATH");
  const bool packaged = cache_root && *cache_root;
  CefScopedSandboxContext sandbox_context;
  CefScopedLibraryLoader library_loader;
  if (packaged) {
    if (!sandbox_context.Initialize(argc, argv)) {
      fprintf(stderr, "[sandbox] failed to initialize macOS helper sandbox\n");
      return 1;
    }
    fprintf(stderr, "[sandbox] macOS Seatbelt helper context initialized pid=%d\n",
            (int)getpid());
    if (!library_loader.LoadInHelper()) {
      fprintf(stderr, "[sandbox] failed to load CEF from helper bundle\n");
      return 1;
    }
  } else {
    const char *framework_dir = getenv("BUNIUM_FRAMEWORK_DIR");
    std::string cef_path = framework_dir ? framework_dir : "";
    cef_path += "/Chromium Embedded Framework";
    if (!cef_load_library(cef_path.c_str())) {
      fprintf(stderr, "[sandbox] failed to load development CEF framework: %s\n",
              cef_path.c_str());
      return 1;
    }
  }
#if defined(_WIN32)
  // Windows' CefMainArgs only takes an HINSTANCE (Chromium re-parses the
  // real command line) -- the POSIX (argc, argv) overload doesn't exist.
  CefMainArgs main_args(GetModuleHandleW(nullptr));
#else
  CefMainArgs main_args(argc, argv);
#endif
  CefRefPtr<BuniumApp> app(new BuniumApp);
  int result = CefExecuteProcess(main_args, app.get(), nullptr);
  if (!packaged)
    cef_unload_library();
  return result;
}
