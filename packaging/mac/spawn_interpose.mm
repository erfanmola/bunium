// Debug interpose: log every posix_spawn/posix_spawnp call made by the
// browser process (bun), via the __DATA,__interpose section. Loaded with
// DYLD_INSERT_LIBRARIES. Used to capture the exact argv + errno of the
// renderer spawn that silently fails in the packaged app.
//
// Gotchas handled here:
//  1. Logging uses raw write(2) only -- stdio locks deadlock inside spawn.
//  2. No dlsym() anywhere: dlsym(RTLD_NEXT) inside an interposed function
//     either deadlocks with bun's spawn path or resolves back to our own
//     interposer (infinite recursion). The real function pointer is taken
//     via a direct link-time relocation (&posix_spawn), exactly like the
//     interpose table's own `replacee` field uses -- that binds to
//     libSystem's symbol, never to our interposer.
#include <errno.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void logf(const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  write(2, buf, n);
}

typedef int (*real_posix_spawn_t)(pid_t *, const char *, void *, void *,
                                  char *const argv[], char *const envp[]);
typedef int (*real_posix_spawnp_t)(pid_t *, const char *, void *, void *,
                                   char *const argv[], char *const envp[]);

// Direct link-time bindings to libSystem's implementations.
static real_posix_spawn_t g_real_spawn = (real_posix_spawn_t)&posix_spawn;
static real_posix_spawnp_t g_real_spawnp = (real_posix_spawnp_t)&posix_spawnp;

__attribute__((constructor)) static void interpose_ctor() {
  char buf[192];
  int n = snprintf(buf, sizeof(buf),
                   "[interpose] loaded pid=%d spawn=%p spawnp=%p\n",
                   (int)getpid(), (void *)g_real_spawn, (void *)g_real_spawnp);
  write(2, buf, n);
}

static int my_posix_spawn(pid_t *pid, const char *path, void *fa, void *attr,
                          char *const argv[], char *const envp[]) {
  int rv = g_real_spawn(pid, path, fa, attr, argv, envp);
  logf("[spawn] path=%s rv=%d (%s) pid=%d type=%s\n", path, rv,
       strerror(rv), pid ? *pid : -1,
       argv && argv[1] ? argv[1] : "?");
  return rv;
}

static int my_posix_spawnp(pid_t *pid, const char *path, void *fa, void *attr,
                           char *const argv[], char *const envp[]) {
  int rv = g_real_spawnp(pid, path, fa, attr, argv, envp);
  logf("[spawnp] path=%s rv=%d (%s) pid=%d type=%s\n", path, rv,
       strerror(rv), pid ? *pid : -1,
       argv && argv[1] ? argv[1] : "?");
  return rv;
}

struct interpose_t {
  const void *replacement;
  const void *replacee;
};

__attribute__((used)) static const interpose_t interposers[]
    __attribute__((section("__DATA,__interpose"))) = {
        {(const void *)my_posix_spawn, (const void *)posix_spawn},
        {(const void *)my_posix_spawnp, (const void *)posix_spawnp},
};
