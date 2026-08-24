// Creates a plain solid-cyan X11 window at a fixed position, to be used as
// a background reference underneath a bunium transparent:true window
// placed at the exact same coordinates -- more reliable than trying to
// paint the X11 root window a known color, since picom (like most
// compositors) doesn't necessarily composite the bare root background/
// _XROOTPMAP_ID the same way a plain XClearWindow would show without a
// compositor (observed: falls back to a flat gray fill instead of the
// color set via xsetroot once picom is running).
//
// Build & run:
//   g++ -std=c++17 native/linux/test-alpha-bg-window.cc -lX11 -o /tmp/bgwin
//   DISPLAY=:99 /tmp/bgwin &
#include <X11/Xlib.h>
#include <cstdio>
#include <unistd.h>

int main() {
  Display *d = XOpenDisplay(nullptr);
  int screen = DefaultScreen(d);
  XSetWindowAttributes attrs = {};
  attrs.background_pixel = 0x00FFFF;  // cyan, easy to distinguish from red/black
  Window w = XCreateWindow(d, RootWindow(d, screen), 540, 309, 200, 200, 0,
                            DefaultDepth(d, screen), InputOutput,
                            DefaultVisual(d, screen), CWBackPixel, &attrs);
  XMapWindow(d, w);
  XFlush(d);
  printf("bg window id: 0x%lx\n", w);
  fflush(stdout);
  // Stay alive so the caller can screenshot while this window exists.
  sleep(60);
  return 0;
}
