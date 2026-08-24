// Real on-screen alpha-compositing verification fixture -- the missing
// half of examples/transparent-window-test.ts's coverage. That test only
// inspects CEF's OWN internal OSR buffer (via captureScreenshot(), which
// reads bunium's in-process pixel copy, never touching the X server at
// all), so it can pass even if bunium_window_create ignored `transparent`
// entirely and created a plain opaque 24-bit-visual window -- which is
// exactly what native/linux/bunium_window_linux.cc did before this
// window's fix (see FindArgbVisual/h->visual/h->depth there).
//
// This creates a transparent:true bunium window with an opaque red square
// in one corner (same page as transparent-window-test.ts) and keeps it
// open long enough for an external tool to read the REAL on-screen
// composited result (through a real compositor, picom in this session)
// via a screenshot -- as opposed to captureScreenshot()'s internal-buffer
// read. Prints the window's X11 window ID (decimal, convert to hex for
// xdotool/xwininfo) so the caller can locate/move/raise it precisely.
//
// Verified procedure (2026-08-23, Xvfb :99 + openbox + picom --backend
// xrender):
//   1. Build a plain solid-cyan X11 reference window at a fixed position
//      (native/linux/test-alpha-bg-window.cc) -- more reliable than
//      painting the X11 root background a known color, since picom
//      doesn't necessarily composite a bare root background/_XROOTPMAP_ID
//      the way a compositor-less XClearWindow would (observed: falls back
//      to flat gray once picom is running, even after xsetroot -solid).
//   2. Run this fixture, xdotool-move/raise the bunium window to the same
//      position/on top of the cyan window.
//   3. `import -window root` (ImageMagick) to capture the true composited
//      screen, then `convert ... -format '%[pixel:p{x,y}]'` to sample.
//   4. Result: corner pixel = opaque red (255,0,0) -- the painted square.
//      Middle pixel = cyan (0,255,255) -- the reference window's color
//      showing through the transparent area, NOT the opaque-black that
//      the pre-fix 24-bit-visual bug would have produced. This proves the
//      ARGB visual + colormap + border_pixel=0 changes in
//      bunium_window_create/BlitFrame actually produce real on-screen
//      alpha compositing under a genuine compositor, not just a
//      alpha-byte-correct-but-never-displayed internal buffer.
import { BuniumWindow } from "../../src/index";

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:transparent">
<div style="position:absolute;top:0;left:0;width:50px;height:50px;background:red"></div>
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 200,
  height: 200,
  transparent: true,
  frame: true,
});

// @ts-expect-error -- internal field, test-only introspection.
const handle = win.windowHandle as unknown as bigint | number;
console.log("WINDOW_HANDLE_PTR", handle);

await Bun.sleep(30000);
win.close();
process.exit(0);
