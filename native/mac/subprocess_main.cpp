#include "bunium_common.h"
#include "include/cef_app.h"

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif
#include <cstdio>
#include <cstdlib>

#if defined(__APPLE__)
// DEBUG (packaging bisect): dump mainBundle identity before CEF takes over.
static void DumpBundleDebug(const char *who, const char *argv0) {
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
  fprintf(stderr,
          "[bundle-debug %s] pid=%d argv0=%s mainBundleURL=%s identifier=%s\n",
          who, (int)getpid(), argv0 ? argv0 : "?", urlbuf, idbuf);
}
#endif

// Standalone helper executable. CEF re-execs this binary (via
// cef_settings.browser_subprocess_path) for renderer/GPU/utility processes.
// CefExecuteProcess inspects argv (CEF injects --type=... itself) and
// dispatches accordingly, then returns >= 0 when this process should exit.
int main(int argc, char *argv[]) {
#if defined(__APPLE__)
  DumpBundleDebug("subprocess", argc > 0 ? argv[0] : nullptr);
#endif
#if defined(_WIN32)
  // Windows' CefMainArgs only takes an HINSTANCE (Chromium re-parses the
  // real command line) -- the POSIX (argc, argv) overload doesn't exist.
  CefMainArgs main_args(GetModuleHandleW(nullptr));
#else
  CefMainArgs main_args(argc, argv);
#endif
  CefRefPtr<BuniumApp> app(new BuniumApp);
  return CefExecuteProcess(main_args, app.get(), nullptr);
}