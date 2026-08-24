// Standalone smoke test for the _NET_WM_MOVERESIZE hand-off added to
// bunium_window_linux.cc. Not part of the normal build (no build.sh rule
// references it) -- compiled and run ad hoc, see the comment at the bottom
// of this file for the exact command. Not wired into the examples/ sweep
// because it needs XTest (an extra system lib bunium itself never links
// against) and a root-window ClientMessage snooper, both irrelevant to
// bunium's actual runtime.
//
// What it proves that frameless-resize-test.ts and draggable-regions-test.ts
// cannot: a REAL X11 ButtonPress (synthesized via XTestFakeButtonEvent, so
// it goes through the actual X server and wakes up bunium_window_pump_events'
// normal XNextEvent loop, not the raw dispatch-ABI shortcut) at a border
// pixel of a frame:false+resizable:true bunium window results in a
// _NET_WM_MOVERESIZE ClientMessage being sent to the root window with the
// expected direction code -- i.e. the ResizeDirectionAtPoint +
// SendNetWmMoveResize wiring in bunium_window_pump_events' ButtonPress case
// actually fires for a genuine hardware-equivalent input event, not just
// "doesn't crash at creation time" (frameless-resize-test.ts's documented
// limitation) or "the region math is correct in isolation"
// (draggable-regions-test.ts's documented limitation, checking
// bunium_is_window_point_draggable directly without ever going through
// ButtonPress at all).
//
// It intentionally does NOT require a running window manager: no WM means
// no SubstructureRedirect owner exists to consume/act on the message, but
// XSendEvent unconditionally delivers it to any client selecting
// SubstructureNotifyMask on the root window (which this test itself does)
// -- so the message's presence and payload can be verified even in the
// bare-Xvfb CI-style environment used for the rest of this session's
// testing, where no WM is installed. Actually moving/resizing the window
// still requires a real WM and is NOT verified here; that remains a
// manual/visual verification step, same category mac/win already
// acknowledge for their own resize-edge code in frameless-resize-test.ts's
// header comment.
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <cstdio>
#include <cstring>
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
  auto create_window =
      (CreateWindowFn)dlsym(lib, "bunium_window_create");
  auto set_constraints =
      (SetConstraintsFn)dlsym(lib, "bunium_set_native_window_constraints");
  auto pump_events = (PumpEventsFn)dlsym(lib, "bunium_window_pump_events");
  auto get_id = (GetIdFn)dlsym(lib, "bunium_window_get_id");
  if (!create_window || !set_constraints || !pump_events || !get_id) {
    fprintf(stderr, "dlsym failed: %s\n", dlerror());
    return 1;
  }

  // Frameless + resizable, per ResizeDirectionAtPoint's gating.
  void *h = create_window(400, 300, "resize moveresize test", 0, 0);
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
  Window root = DefaultRootWindow(d);
  XSelectInput(d, root, SubstructureNotifyMask);
  XSync(d, False);

  int xid = get_id(h);
  Window w = (Window)xid;

  // Let a real WM (if one is running) map/reparent/position the window
  // first -- querying position immediately after create_window() races
  // against the WM's own initial placement (which happens asynchronously
  // after the MapRequest this test's XCreateWindow triggers). Under a
  // bare Xvfb with no WM this loop is a harmless no-op since nothing
  // repositions the window away from (0,0) anyway.
  for (int i = 0; i < 20; i++) {
    pump_events();
    usleep(10000);
  }
  XSync(d, False);

  // Find the window's current screen position so we can compute an
  // absolute (root-relative) coordinate for XTestFakeMotionEvent -- XTest
  // synthesizes real hardware-equivalent events at absolute screen coords,
  // it has no notion of "window-relative".
  XWindowAttributes wa;
  XGetWindowAttributes(d, w, &wa);
  int root_x, root_y;
  Window child;
  XTranslateCoordinates(d, w, root, 0, 0, &root_x, &root_y, &child);

  Atom moveresize_atom = XInternAtom(d, "_NET_WM_MOVERESIZE", False);

  auto click_and_check = [&](int wx, int wy) -> int {
    XTestFakeMotionEvent(d, -1, root_x + wx, root_y + wy, CurrentTime);
    XSync(d, False);
    XTestFakeButtonEvent(d, 1, True, CurrentTime);
    XSync(d, False);
    XTestFakeButtonEvent(d, 1, False, CurrentTime);
    XSync(d, False);
    // Let bunium's own event loop (not this test's XNextEvent) consume
    // the synthesized ButtonPress and, if the resize-edge/drag logic
    // fires, emit the ClientMessage we're watching for on root. Give the
    // X server a moment to actually deliver the synthetic events -- under
    // Xvfb this is fast but not instant, and querying XPending() too
    // early on either connection (this test's or bunium's) can race.
    for (int i = 0; i < 20; i++) {
      pump_events();
      usleep(5000);
    }
    XSync(d, False);
    int direction = -1;
    while (XPending(d) > 0) {
      XEvent ev;
      XNextEvent(d, &ev);
      if (ev.type == ClientMessage &&
          ev.xclient.message_type == moveresize_atom) {
        direction = static_cast<int>(ev.xclient.data.l[2]);
      }
    }
    return direction;
  };

  // Case 1: (2, 150) window-relative -- inside the 6px left border, well
  // clear of top/bottom zones. Expect kNetWmMoveResizeSizeLeft (=7).
  int dir_left = click_and_check(2, 150);
  bool pass1 = dir_left == 7;
  printf("left border click -> direction %d (expected 7 SizeLeft): %s\n",
         dir_left, pass1 ? "PASS" : "FAIL");

  // Case 2: (200, 150) window-relative -- dead center, not a resize edge,
  // no drag regions registered on this window (bunium_set_drag_regions
  // never called) -- expect no ClientMessage at all (direction stays -1),
  // i.e. this click should fall through to normal CEF forwarding instead.
  int dir_center = click_and_check(200, 150);
  bool pass2 = dir_center == -1;
  printf("center click -> direction %d (expected -1 none): %s\n",
         dir_center, pass2 ? "PASS" : "FAIL");

  bool all_pass = pass1 && pass2;
  printf("RESULT: %s\n", all_pass ? "PASS" : "FAIL");

  XCloseDisplay(d);
  return all_pass ? 0 : 1;
}

// Build & run (from repo root, with DISPLAY pointed at a running Xvfb):
//   g++ -std=c++17 native/linux/test-resize-moveresize.cc \
//       -lX11 -lXtst -ldl -o /tmp/test-resize-moveresize
//   DISPLAY=:99 /tmp/test-resize-moveresize
