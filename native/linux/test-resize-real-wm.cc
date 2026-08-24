// Real-WM verification of the _NET_WM_MOVERESIZE hand-off added to
// bunium_window_linux.cc -- the missing half of
// test-resize-moveresize.cc's coverage. That test proves bunium SENDS the
// correct ClientMessage; it deliberately does not require a WM, so it
// cannot prove anything actually CONSUMES the message and performs a real
// resize. This test requires a real window manager (run under openbox on
// this session's host) and checks the window's ACTUAL geometry changes
// after a synthesized border-drag, via XGetWindowAttributes queried
// through the WM's reparenting (bunium's own XTranslateCoordinates-based
// geometry, not just "a ClientMessage was seen").
//
// Sequence: create a frameless+resizable window, locate its left border,
// synthesize ButtonPress there (triggers bunium's SendNetWmMoveResize),
// synthesize mouse motion further left while button held (this is what a
// real user drag looks like -- openbox's own resize grab, once it takes
// over via the WM_MOVERESIZE protocol, tracks subsequent motion+release
// itself, not bunium), synthesize ButtonRelease, then poll window geometry
// until it stabilizes and confirm width actually grew.
//
// Build & run (from repo root, DISPLAY pointed at Xvfb with openbox running):
//   g++ -std=c++17 native/linux/test-resize-real-wm.cc \
//       -lX11 -lXtst -ldl -o /tmp/test-resize-real-wm
//   DISPLAY=:99 LD_LIBRARY_PATH=native/build-linux /tmp/test-resize-real-wm
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <cstdio>
#include <dlfcn.h>
#include <unistd.h>

typedef void *(*CreateWindowFn)(int, int, const char *, int, int);
typedef void (*SetConstraintsFn)(void *, int, int, int, int, int);
typedef void (*PumpEventsFn)();
typedef int (*GetIdFn)(void *);

int main() {
  void *lib = dlopen("/home/debian/bunium/native/build-linux/bunium_shim.so",
                      RTLD_NOW);
  if (!lib) {
    fprintf(stderr, "dlopen failed: %s\n", dlerror());
    return 1;
  }
  auto create_window = (CreateWindowFn)dlsym(lib, "bunium_window_create");
  auto set_constraints =
      (SetConstraintsFn)dlsym(lib, "bunium_set_native_window_constraints");
  auto pump_events = (PumpEventsFn)dlsym(lib, "bunium_window_pump_events");
  auto get_id = (GetIdFn)dlsym(lib, "bunium_window_get_id");
  if (!create_window || !set_constraints || !pump_events || !get_id) {
    fprintf(stderr, "dlsym failed: %s\n", dlerror());
    return 1;
  }

  void *h = create_window(400, 300, "real wm resize test", 0, 0);
  if (!h) {
    fprintf(stderr, "window create failed\n");
    return 1;
  }
  set_constraints(h, /*resizable=*/1, 0, 0, 0, 0);

  Display *d = XOpenDisplay(nullptr);
  if (!d) {
    fprintf(stderr, "XOpenDisplay failed\n");
    return 1;
  }
  Window w = (Window)get_id(h);

  // Give the WM a moment to map/reparent/decorate(-lessly) the window
  // before we query geometry or synthesize input against it.
  for (int i = 0; i < 40; i++) {
    pump_events();
    usleep(10000);
  }
  XSync(d, False);

  XWindowAttributes before;
  XGetWindowAttributes(d, w, &before);
  int root_x, root_y;
  Window child;
  XTranslateCoordinates(d, w, DefaultRootWindow(d), 0, 0, &root_x, &root_y,
                         &child);
  printf("before: %dx%d at root (%d,%d)\n", before.width, before.height,
         root_x, root_y);

  // Press at the left border (window-relative x=2, mid-height) -- inside
  // ResizeDirectionAtPoint's 6px zone -- to trigger bunium's
  // SendNetWmMoveResize(SizeLeft) call.
  int press_x = root_x + 2;
  int press_y = root_y + before.height / 2;
  XTestFakeMotionEvent(d, -1, press_x, press_y, CurrentTime);
  XSync(d, False);
  XTestFakeButtonEvent(d, 1, True, CurrentTime);
  XSync(d, False);
  for (int i = 0; i < 10; i++) {
    pump_events();
    usleep(5000);
  }
  XSync(d, False);

  // Drag left by 60px -- once the WM has grabbed the resize (via the
  // _NET_WM_MOVERESIZE protocol), it tracks this motion itself; bunium's
  // own window does not need to see these motion events at all.
  for (int step = 1; step <= 6; step++) {
    XTestFakeMotionEvent(d, -1, press_x - step * 10, press_y, CurrentTime);
    XSync(d, False);
    usleep(20000);
  }

  XTestFakeButtonEvent(d, 1, False, CurrentTime);
  XSync(d, False);

  // Let openbox settle the resize and let bunium process any resulting
  // ConfigureNotify.
  XWindowAttributes after = before;
  for (int i = 0; i < 60; i++) {
    pump_events();
    usleep(20000);
    XGetWindowAttributes(d, w, &after);
    if (after.width != before.width) break;
  }
  printf("after: %dx%d\n", after.width, after.height);

  bool grew = after.width > before.width;
  printf("RESULT: %s (width %d -> %d)\n", grew ? "PASS" : "FAIL",
         before.width, after.width);

  XCloseDisplay(d);
  return grew ? 0 : 1;
}
