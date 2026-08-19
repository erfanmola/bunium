// throwaway bring-up harness (deleted post-debug): loads bunium_shim.dll
// from its own dir and calls bunium_init with dev-tree paths.
#include <windows.h>
#include <stdio.h>

typedef int (*InitFn)(const char*, const char*, const char*, const char*);
typedef void (*WorkFn)();
typedef void (*ShutdownFn)();

static InitFn init;
static WorkFn work;
static void* g_exc_addr;
static ULONG_PTR g_exc_access;
static unsigned long g_exc_code;
static CONTEXT g_ctx;

// Walk the faulting context's x64 stack using .pdata unwind info (works on
// stripped binaries -- no symbol table needed).
static void dump_stack(CONTEXT* ctx) {
  fprintf(stderr, "  [stack-walk] start rip=%p\n", (void*)ctx->Rip);
  UNWIND_HISTORY_TABLE ht;
  memset(&ht, 0, sizeof(ht));
  for (int i = 0; i < 20; i++) {
    DWORD64 base = 0;
    RUNTIME_FUNCTION* rf = RtlLookupFunctionEntry(ctx->Rip, &base, &ht);
    if (!rf) {
      fprintf(stderr, "  [stack-walk] no fn entry at rip=%p\n",
              (void*)ctx->Rip);
      break;
    }
    void* hd = NULL;
    ULONG64 est = 0;
    RtlVirtualUnwind(0, base, ctx->Rip, rf, ctx, &hd, &est, NULL);
    fprintf(stderr, "  frame %2d: rip=%p base=%p fn=%p\n", i,
            (void*)ctx->Rip, (void*)base, (void*)rf);
    if (ctx->Rip == 0) break;
  }
}

int seh_filter(void) {
  return EXCEPTION_EXECUTE_HANDLER;
}

int main(void) {
  SetDllDirectoryW(L"C:\\Users\\Erfan Mola\\Documents\\bunium\\native\\build");
  HMODULE m = LoadLibraryW(
      L"C:\\Users\\Erfan Mola\\Documents\\bunium\\native\\build\\bunium_shim_dbg.dll");
  if (!m) {
    fprintf(stderr, "load failed %lu\n", GetLastError());
    return 1;
  }
  fprintf(stderr, "[harness] dll loaded\n");
  HMODULE lc = GetModuleHandleW(L"libcef.dll");
  void* cfi = lc ? (void*)GetProcAddress(lc, "CefInitialize") : NULL;
  fprintf(stderr, "[harness] libcef=%p CefInitialize=%p\n", (void*)lc, cfi);
  init = (InitFn)GetProcAddress(m, "bunium_init");
  work = (WorkFn)GetProcAddress(m, "bunium_do_message_loop_work");
  ShutdownFn down = (ShutdownFn)GetProcAddress(m, "bunium_shutdown");
  fprintf(stderr, "[harness] procs ok\n");
  int rc = -999;
  __try {
    rc = init(
      "C:\\Users\\Erfan Mola\\Documents\\bunium\\native\\build\\bunium_subprocess.exe",
      "C:\\Users\\Erfan Mola\\Documents\\bunium\\native\\build",
      "C:\\Users\\Erfan Mola\\Documents\\bunium\\native\\build",
      "");
    fprintf(stderr, "[harness] init rc=%d\n", rc);
  } __except (g_exc_code = GetExceptionCode(),
              g_ctx = *GetExceptionInformation()->ContextRecord,
              g_exc_addr = (void*)g_ctx.Rip,
              g_exc_access = GetExceptionInformation()->ExceptionRecord
                                 ->ExceptionInformation[1],
              EXCEPTION_EXECUTE_HANDLER) {
    HMODULE h1 = NULL, h2 = NULL;
    wchar_t n1[260] = L"?", n2[260] = L"?";
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)g_exc_addr, &h1);
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)g_exc_access, &h2);
    if (h1) GetModuleFileNameW(h1, n1, 260);
    if (h2) GetModuleFileNameW(h2, n2, 260);
    fprintf(stderr,
            "[harness] SEH: code=0x%08lx inst=%p [%ls +0x%llx] access=0x%llx [%ls +0x%llx]\n",
            g_exc_code, g_exc_addr, n1,
            (unsigned long long)((char*)g_exc_addr - (char*)h1), (unsigned long long)g_exc_access, n2,
            (unsigned long long)((char*)g_exc_access - (char*)h2));
    fprintf(stderr, "[harness] stack:\n");
    CONTEXT c = g_ctx;
    dump_stack(&c);
  }
  for (int i = 0; i < 5; i++) {
    Sleep(100);
    __try {
      work();
    } __except (g_exc_code = GetExceptionCode(),
                g_exc_addr = GetExceptionInformation()->ExceptionRecord
                                  ->ExceptionAddress,
                g_exc_access = GetExceptionInformation()->ExceptionRecord
                                   ->ExceptionInformation[1],
                EXCEPTION_EXECUTE_HANDLER) {
      fprintf(stderr, "[harness] SEH in work: code=0x%08lx addr=%p access=0x%llx\n",
              g_exc_code, g_exc_addr, (unsigned long long)g_exc_access);
      break;
    }
  }
  down();
  fprintf(stderr, "[harness] done\n");
  return 0;
}