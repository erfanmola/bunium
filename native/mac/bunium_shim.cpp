#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unordered_map>

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#endif
#if defined(_WIN32)
// windows.h min/max macros collide with CEF headers (and std::min/max) --
// NOMINMAX + LEAN_AND_MEAN are the standard CEF-on-Windows incantations.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

#include "bunium_common.h"
#include "include/cef_app.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"
#include "include/wrapper/cef_helpers.h"

// Flat C ABI consumed by bun:ffi. No CEF types cross this boundary --
// only plain ints/pointers, to keep the FFI side free of struct-layout
// guesswork.

struct BuniumView {
  CefRefPtr<BuniumClient> client;
  std::vector<uint8_t> export_buf; // scratch copy returned to caller
  std::string export_message;      // scratch copy for bunium_poll_message
};

static CefRefPtr<BuniumApp> g_app;

// Reverse lookup (native window/sublayer paint-target handle -> the view
// attached to it) so raw Cocoa input events, which only know "which native
// handle got clicked," can be forwarded to the right CefBrowser. Populated
// in bunium_attach_window. Only handles the primary-view case for now --
// sublayer hit-testing (routing a click to whichever *sublayer* is under
// the cursor, not just the window's main view) is a separate follow-up.
static std::unordered_map<void *, CefRefPtr<BuniumClient>> g_target_to_client;

// Which sublayers belong to which window, for input hit-testing (topmost
// last -- CALayer's addSublayer appends on top, so checking in reverse
// insertion order approximates z-order without tracking it explicitly).
static std::unordered_map<void *, std::vector<void *>> g_window_sublayers;

// The target (window or sublayer handle) that most recently received a
// mouse click -- used to route keyboard events once multiple views can
// exist in one window. Not a full focus-manager subsystem, just "last
// clicked wins," which is what most such subsystems reduce to anyway for
// the common case.
static void *g_last_focused_target = nullptr;

extern "C" void bunium_sublayer_get_frame(void *layer_handle, int *out_x,
                                          int *out_y, int *out_width,
                                          int *out_height);
extern "C" void bunium_sublayer_get_clip(void *layer_handle, int *out_clipped,
                                         int *out_x, int *out_y, int *out_width,
                                         int *out_height);

// Returns the sublayer handle under (x, y) in window-local coordinates, or
// nullptr if none (falls back to the window's own primary view). Also
// writes the point converted to that sublayer's local coordinates. Clip-aware:
// consults bunium_sublayer_get_clip so a click landing in a portion of a
// sublayer's nominal rect that's actually clipped away by a DOM
// overflow:hidden ancestor (bunium_sublayer_set_clip) correctly falls
// through to whatever's visually underneath, instead of hitting an
// invisible/clipped-away region -- matches how a real DOM child element
// only receives clicks within its own visually-clipped bounds.
static void *HitTestSublayer(void *window_handle, int x, int y,
                             int *out_local_x, int *out_local_y) {
  auto it = g_window_sublayers.find(window_handle);
  if (it == g_window_sublayers.end())
    return nullptr;
  const auto &sublayers = it->second;
  for (auto rit = sublayers.rbegin(); rit != sublayers.rend(); ++rit) {
    int sx, sy, sw, sh;
    bunium_sublayer_get_frame(*rit, &sx, &sy, &sw, &sh);

    int clipped, cx, cy, cw, ch;
    bunium_sublayer_get_clip(*rit, &clipped, &cx, &cy, &cw, &ch);
    if (clipped) {
      sx = cx;
      sy = cy;
      sw = cw;
      sh = ch;
    }

    if (x >= sx && x < sx + sw && y >= sy && y < sy + sh) {
      // Local coordinates are still reported relative to the sublayer's
      // true (unclipped) origin -- bunium_sublayer_get_frame's own frame,
      // not the clip rect -- since that's what CEF's own coordinate space
      // for this view expects; only the hit-test bounds check itself needs
      // clip-awareness, not the coordinate translation.
      int true_x, true_y, true_w, true_h;
      bunium_sublayer_get_frame(*rit, &true_x, &true_y, &true_w, &true_h);
      *out_local_x = x - true_x;
      *out_local_y = y - true_y;
      return *rit;
    }
  }
  return nullptr;
}

// Implemented in bunium_window_mac.mm, linked into the same dylib.
extern "C" void *bunium_window_create(int width, int height, const char *title,
                                      int transparent, int frame);
extern "C" void bunium_window_set_constraints(void *handle, int resizable,
                                              int min_width, int min_height,
                                              int max_width, int max_height);
extern "C" void bunium_window_pump_events();
extern "C" int bunium_window_get_id(void *handle);
extern "C" void bunium_window_get_size(void *handle, int *out_width,
                                       int *out_height);
extern "C" int bunium_window_is_closed(void *handle);
extern "C" void bunium_window_close(void *handle);
extern "C" double bunium_window_get_scale(void *handle);
extern "C" int bunium_window_is_resizable(void *handle);
extern "C" void bunium_window_get_size_constraints(void *handle,
                                                   int *out_min_width,
                                                   int *out_min_height,
                                                   int *out_max_width,
                                                   int *out_max_height);
extern "C" void *bunium_create_sublayer(void *window_handle, int x, int y,
                                        int width, int height);
extern "C" void bunium_sublayer_set_frame(void *layer_handle, int x, int y,
                                          int width, int height);
extern "C" void bunium_sublayer_get_frame(void *layer_handle, int *out_x,
                                          int *out_y, int *out_width,
                                          int *out_height);
extern "C" void bunium_close_sublayer(void *layer_handle);
extern "C" void bunium_sublayer_set_clip(void *layer_handle, int clip_x,
                                         int clip_y, int clip_w, int clip_h);
extern "C" void bunium_sublayer_clear_clip(void *layer_handle);
extern "C" void bunium_sublayer_get_clip(void *layer_handle, int *out_clipped,
                                         int *out_x, int *out_y, int *out_width,
                                         int *out_height);

#if defined(_WIN32)
// dllexport is Windows' only export mechanism -- the visibility attribute
// form silently exports nothing from a DLL (visibility only affects ELF),
// which would make bun:ffi's dlopen() fail on every symbol.
#define BUNIUM_EXPORT __declspec(dllexport)
#else
#define BUNIUM_EXPORT __attribute__((visibility("default")))
#endif

extern "C" {

BUNIUM_EXPORT int bunium_init(const char *subprocess_path,
                              const char *framework_dir_path,
                              const char *resources_dir_path,
                              const char *root_cache_path) {
  if (getenv("BUNIUM_BUNDLE_DEBUG")) {
#if defined(__APPLE__)
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
            "[bundle-debug browser] pid=%d mainBundleURL=%s identifier=%s\n",
            (int)getpid(), urlbuf, idbuf);
#endif
  }
  // BUNIUM_CEF_SWITCHES: extra command-line switches for the browser
  // process, e.g. "--enable-logging=stderr --v=1". The real argv here is
  // `bun <script>` -- Chromium stops switch-parsing at the first non-switch
  // arg, so switches after the script path never register; injecting them
  // here keeps debugging packaged apps possible. Child processes inherit
  // most switches from the browser on their own.
  static std::vector<std::string> injected_argv;
  std::vector<char *> argv_ptrs;
#if defined(_WIN32)
  // CEF's Windows CefMainArgs only accepts an HINSTANCE (Chromium always
  // re-parses the real command line), so the BUNIUM_CEF_SWITCHES argv
  // injection below is macOS/Linux-only for now -- switches on Windows must
  // go through CefSettings or the launcher's command line directly.
  CefMainArgs main_args(GetModuleHandleW(nullptr));
#else
  CefMainArgs main_args(0, nullptr);
  const char *switches = getenv("BUNIUM_CEF_SWITCHES");
  if (switches && *switches) {
    injected_argv.clear();
    injected_argv.push_back("bunium");
    std::string s(switches);
    size_t pos = 0;
    while (pos <= s.size()) {
      size_t sp = s.find(' ', pos);
      if (sp == std::string::npos)
        sp = s.size();
      if (sp > pos)
        injected_argv.push_back(s.substr(pos, sp - pos));
      pos = sp + 1;
    }
    for (auto &a : injected_argv)
      argv_ptrs.push_back(a.data());
    main_args =
        CefMainArgs(static_cast<int>(argv_ptrs.size()), argv_ptrs.data());
  }
#endif
  g_app = new BuniumApp();

  CefSettings settings;
  settings.no_sandbox = true;
  settings.windowless_rendering_enabled = true;
  settings.multi_threaded_message_loop = false;
  settings.external_message_pump = false;
  // BUNIUM_CEF_VERBOSE raises the CEF log severity to INFO for debugging
  // packaged-app issues; default WARNING keeps normal runs quiet.
  settings.log_severity =
      getenv("BUNIUM_CEF_VERBOSE") ? LOGSEVERITY_INFO : LOGSEVERITY_WARNING;
  // Chromium derives child --lang from the browser's locale; with an empty
  // CefSettings.locale the GPU subprocess is spawned without --lang and its
  // main-delegate CHECK (chrome_main_delegate.cc) hard-crashes. Default to
  // en-US like cefclient does with unset locale.
  CefString(&settings.locale).FromASCII("en-US");
  CefString(&settings.browser_subprocess_path).FromASCII(subprocess_path);
  CefString(&settings.framework_dir_path).FromASCII(framework_dir_path);
  CefString(&settings.resources_dir_path).FromASCII(resources_dir_path);
#if defined(_WIN32)
  // CefSettings.framework_dir_path is macOS-only. Windows CEF keeps its
  // resources (.pak/.dat/.bin) flat in resources_dir_path with locales/
  // hanging off it; Chromium won't find them without an explicit
  // locales_dir_path (default is "icudtl.dat's dir/locales", which is only
  // right for the standard CEF sample layout).
  std::string locales_dir = std::string(resources_dir_path) + "/locales";
  CefString(&settings.locales_dir_path).FromASCII(locales_dir.c_str());
#endif
  // Per-app profile dir (packaged .app launchers pass a per-app Application
  // Support path). Empty string = CEF's shared default profile, which is
  // what dev processes want -- a per-app root_cache_path avoids two crunchy
  // bunium processes aborting each other over CEF's ProcessSingleton and
  // keeps each app's cache/cookies private.
  if (root_cache_path && *root_cache_path) {
    CefString(&settings.root_cache_path).FromASCII(root_cache_path);
  }

  return CefInitialize(main_args, settings, g_app.get(), nullptr) ? 1 : 0;
}

BUNIUM_EXPORT void bunium_do_message_loop_work() { CefDoMessageLoopWork(); }

// Sets the root directory the bunium://app/... custom scheme (Phase 3 prod
// static-file serving) resolves against -- see BuniumSchemeHandlerFactory's
// comment (bunium_common.h) for why a custom scheme is used instead of
// file://. Safe to call before any window is created; g_bunium_scheme_root
// is read lazily on each request.
BUNIUM_EXPORT void bunium_set_app_root(const char *root_dir_path) {
  g_bunium_scheme_root = root_dir_path;
}

BUNIUM_EXPORT void *bunium_create_view(const char *url, int width, int height,
                                       int transparent) {
  auto *view = new BuniumView();
  view->client = new BuniumClient(width, height);

  CefWindowInfo window_info;
  window_info.SetAsWindowless(kNullWindowHandle);

  CefBrowserSettings browser_settings;
  // Default is 30fps (see cef_types.h) -- far too low for anything claiming
  // to be "buttery smooth." 60 matches typical display refresh; measured
  // impact on JS<->native bounds-sync lag, see ARCHITECTURE.md.
  browser_settings.windowless_frame_rate = 60;
  // Per cef_types.h: a fully-transparent (alpha=0) background_color enables
  // transparent painting for windowless browsers; fully-opaque is the
  // default otherwise. There's no partial-alpha window background this
  // way -- it's a binary switch at the CEF level, matching the
  // transparent:boolean option shape (not a general translucency slider).
  browser_settings.background_color = transparent
                                          ? CefColorSetARGB(0, 0, 0, 0)
                                          : CefColorSetARGB(255, 255, 255, 255);
  CefBrowserHost::CreateBrowser(window_info, view->client, CefString(url),
                                browser_settings, nullptr, nullptr);
  return view;
}

BUNIUM_EXPORT void bunium_navigate(void *handle, const char *url) {
  auto *view = static_cast<BuniumView *>(handle);
  auto browser = view->client->browser();
  if (!browser)
    return;
  browser->GetMainFrame()->LoadURL(CefString(url));
}

BUNIUM_EXPORT void bunium_resize(void *handle, int width, int height) {
  auto *view = static_cast<BuniumView *>(handle);
  view->client->Resize(width, height);
}

BUNIUM_EXPORT void bunium_send_scroll(void *handle, int x, int y, int deltaX,
                                      int deltaY) {
  auto *view = static_cast<BuniumView *>(handle);
  auto browser = view->client->browser();
  if (!browser)
    return;
  CefMouseEvent evt;
  evt.x = x;
  evt.y = y;
  browser->GetHost()->SendMouseWheelEvent(evt, deltaX, deltaY);
}

// Returns pointer to a BGRA buffer valid until the next call on this view.
BUNIUM_EXPORT const uint8_t *bunium_get_frame(void *handle, int *out_width,
                                              int *out_height) {
  auto *view = static_cast<BuniumView *>(handle);
  auto &frame = view->client->frame();
  std::lock_guard<std::mutex> lock(frame.mtx);
  view->export_buf = frame.pixels;
  *out_width = frame.width;
  *out_height = frame.height;
  return view->export_buf.empty() ? nullptr : view->export_buf.data();
}

BUNIUM_EXPORT uint64_t bunium_frame_count(void *handle) {
  auto *view = static_cast<BuniumView *>(handle);
  return view->client->frame_count();
}

// Physical pixel dimensions of the latest painted frame, without copying
// the pixel buffer itself -- cheap enough to poll for "rendered size"
// separately from the logical (CSS px) size passed at view creation.
BUNIUM_EXPORT void bunium_view_get_frame_size(void *handle, int *out_width,
                                              int *out_height) {
  auto *view = static_cast<BuniumView *>(handle);
  auto &frame = view->client->frame();
  std::lock_guard<std::mutex> lock(frame.mtx);
  *out_width = frame.width;
  *out_height = frame.height;
}

BUNIUM_EXPORT void *bunium_create_native_window(int width, int height,
                                                const char *title,
                                                int transparent, int frame) {
  return bunium_window_create(width, height, title, transparent, frame);
}

// Separate call from bunium_create_native_window on purpose -- see the
// comment on bunium_window_set_constraints (bunium_window_mac.mm) for why
// (a bun:ffi >8-arg issue on arm64, not a design preference).
BUNIUM_EXPORT void
bunium_set_native_window_constraints(void *window_handle, int resizable,
                                     int min_width, int min_height,
                                     int max_width, int max_height) {
  bunium_window_set_constraints(window_handle, resizable, min_width, min_height,
                                max_width, max_height);
}

BUNIUM_EXPORT int bunium_get_native_window_is_resizable(void *window_handle) {
  return bunium_window_is_resizable(window_handle);
}

BUNIUM_EXPORT void bunium_get_native_window_size_constraints(
    void *window_handle, int *out_min_width, int *out_min_height,
    int *out_max_width, int *out_max_height) {
  bunium_window_get_size_constraints(window_handle, out_min_width,
                                     out_min_height, out_max_width,
                                     out_max_height);
}

BUNIUM_EXPORT void bunium_attach_window(void *view_handle,
                                        void *window_handle) {
  auto *view = static_cast<BuniumView *>(view_handle);
  view->client->AttachWindow(window_handle);
  g_target_to_client[window_handle] = view->client;
  // Fixes Retina blur: without this CEF assumes 1.0 and rasterizes at
  // logical-pixel resolution, upscaled onto a physically-2x layer. See
  // BuniumClient::GetScreenInfo/SetDeviceScaleFactor, bunium_common.h.
  view->client->SetDeviceScaleFactor(bunium_window_get_scale(window_handle));
}

BUNIUM_EXPORT void bunium_pump_native_events() { bunium_window_pump_events(); }

BUNIUM_EXPORT void bunium_get_native_window_size(void *window_handle,
                                                 int *out_width,
                                                 int *out_height) {
  bunium_window_get_size(window_handle, out_width, out_height);
}

BUNIUM_EXPORT double bunium_get_native_window_scale(void *window_handle) {
  return bunium_window_get_scale(window_handle);
}

BUNIUM_EXPORT void bunium_close_native_window(void *window_handle) {
  g_target_to_client.erase(window_handle);
  bunium_window_close(window_handle);
}

BUNIUM_EXPORT int bunium_is_native_window_closed(void *window_handle) {
  return bunium_window_is_closed(window_handle);
}

// A sublayer handle can be attached to a view exactly like a window handle
// (bunium_attach_window doesn't care which it is -- both are just the
// void* BuniumClient paints into), so no new "attach" ABI is needed here.
BUNIUM_EXPORT void *bunium_create_native_sublayer(void *window_handle, int x,
                                                  int y, int width,
                                                  int height) {
  void *sublayer = bunium_create_sublayer(window_handle, x, y, width, height);
  g_window_sublayers[window_handle].push_back(sublayer);
  return sublayer;
}

BUNIUM_EXPORT void bunium_set_native_sublayer_frame(void *layer_handle, int x,
                                                    int y, int width,
                                                    int height) {
  bunium_sublayer_set_frame(layer_handle, x, y, width, height);
}

// DOM overflow:hidden ancestor clipping for <bunium-webview> sublayers --
// see the detailed comment on bunium_sublayer_set_clip (bunium_window_mac.mm)
// for the reparent-under-a-masking-layer mechanism. No hit-test registry
// changes needed here: HitTestSublayer above still calls
// bunium_sublayer_get_frame, which keeps returning the sublayer's true
// absolute frame regardless of clip state (it reads `layer.frame`, which
// BuniumSublayerReposition always keeps consistent with the sublayer's real
// on-window position) -- clicking within a clipped-away portion of a
// sublayer's nominal rect will still hit-test as "inside" today, since
// hit-testing isn't clip-aware yet. Matches the standing known-gap pattern
// for input-forwarding edge cases documented in PLAN.md; the clip only
// affects what's drawn, not (yet) what's clickable.
BUNIUM_EXPORT void bunium_set_native_sublayer_clip(void *layer_handle,
                                                   int clip_x, int clip_y,
                                                   int clip_w, int clip_h) {
  bunium_sublayer_set_clip(layer_handle, clip_x, clip_y, clip_w, clip_h);
}

BUNIUM_EXPORT void bunium_clear_native_sublayer_clip(void *layer_handle) {
  bunium_sublayer_clear_clip(layer_handle);
}

// Verification-only readback -- see bunium_sublayer_get_clip's own comment
// (bunium_window_mac.mm) for the exact semantics of *out_clipped and the
// visible rect.
BUNIUM_EXPORT void bunium_get_native_sublayer_clip(void *layer_handle,
                                                   int *out_clipped, int *out_x,
                                                   int *out_y, int *out_width,
                                                   int *out_height) {
  bunium_sublayer_get_clip(layer_handle, out_clipped, out_x, out_y, out_width,
                           out_height);
}

// Implemented in bunium_window_mac.mm -- raises the sublayer's CALayer (or
// its clipLayer, if clipping is active) to the top of its superlayer's
// paint order.
extern "C" void bunium_sublayer_raise_to_top(void *layer_handle);

// Syncs a sublayer's stacking position to the top, both visually (via
// bunium_sublayer_raise_to_top) and in g_window_sublayers -- the latter is
// what HitTestSublayer actually consults (topmost-last), so both must move
// together or a click could hit-test against the wrong element even though
// it visually looks correct (or vice versa). Called once per element, in
// ascending desired-order, by WebviewManager.updateOrder (window.ts) --
// raising each element in turn from bottom to top reproduces the full
// stacking order with only "raise to top" as a primitive, no separate
// "insert at index" needed.
BUNIUM_EXPORT void bunium_raise_native_sublayer(void *window_handle,
                                                void *layer_handle) {
  bunium_sublayer_raise_to_top(layer_handle);
  auto it = g_window_sublayers.find(window_handle);
  if (it == g_window_sublayers.end())
    return;
  auto &sublayers = it->second;
  sublayers.erase(std::remove(sublayers.begin(), sublayers.end(), layer_handle),
                  sublayers.end());
  sublayers.push_back(layer_handle);
}

BUNIUM_EXPORT void bunium_close_native_sublayer(void *layer_handle) {
  // Must happen before bunium_close_sublayer frees the handle -- leaving a
  // stale entry in g_window_sublayers would make the next click's
  // hit-test call bunium_sublayer_get_frame on freed memory.
  for (auto &[window, sublayers] : g_window_sublayers) {
    sublayers.erase(
        std::remove(sublayers.begin(), sublayers.end(), layer_handle),
        sublayers.end());
  }
  g_target_to_client.erase(layer_handle);
  if (g_last_focused_target == layer_handle)
    g_last_focused_target = nullptr;
  bunium_close_sublayer(layer_handle);
}

BUNIUM_EXPORT void bunium_get_native_sublayer_frame(void *layer_handle,
                                                    int *out_x, int *out_y,
                                                    int *out_width,
                                                    int *out_height) {
  bunium_sublayer_get_frame(layer_handle, out_x, out_y, out_width, out_height);
}

// Marks `sublayer_handle` as the paint target that `view_handle`'s page is
// allowed to reposition via window.__bunium.reportBounds() (see
// BuniumClient::OnProcessMessageReceived, bunium_common.h).
BUNIUM_EXPORT void bunium_view_track_sublayer(void *view_handle,
                                              void *sublayer_handle) {
  auto *view = static_cast<BuniumView *>(view_handle);
  view->client->SetTrackedSublayer(sublayer_handle);
}

// Drains one pending window.__bunium.send(name, payload) message (see
// bunium_common.h). Returns a JSON envelope string like
// {"name":"...","payload":"..."} (payload is the already-JSON-encoded
// string the page passed in, carried through as an opaque string rather
// than re-parsed/re-embedded -- callers do JSON.parse twice: once for the
// envelope, once for payload) or null if the inbox is empty. Poll in a
// loop until null to drain everything queued since the last call. Uses
// CefValue/CefWriteJSON for the envelope instead of hand-rolled string
// concatenation, so message names can't accidentally break the encoding.
BUNIUM_EXPORT const char *bunium_poll_message(void *view_handle) {
  auto *view = static_cast<BuniumView *>(view_handle);
  std::string name, payload;
  if (!view->client->PopMessage(&name, &payload))
    return nullptr;

  auto dict = CefDictionaryValue::Create();
  dict->SetString("name", name);
  dict->SetString("payload", payload);
  auto value = CefValue::Create();
  value->SetDictionary(dict);

  view->export_message = CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
  return view->export_message.c_str();
}

// Main -> renderer push: sends (name, payloadJson) to this view's page via
// window.__bunium.on(name, ...) listeners (see
// BuniumApp::OnProcessMessageReceived, bunium_common.h, for the renderer-side
// dispatch).
BUNIUM_EXPORT void bunium_emit_to_renderer(void *view_handle, const char *name,
                                           const char *payload_json) {
  auto *view = static_cast<BuniumView *>(view_handle);
  auto browser = view->client->browser();
  if (!browser)
    return;

  auto message = CefProcessMessage::Create(kDispatchMessageName);
  auto args = message->GetArgumentList();
  args->SetString(0, CefString(name));
  args->SetString(1, CefString(payload_json));
  browser->GetMainFrame()->SendProcessMessage(PID_RENDERER, message);
}

// CefDictionaryValue::GetDouble() returns 0 (not an auto-converted value)
// when the underlying JSON number was parsed as VTYPE_INT rather than
// VTYPE_DOUBLE -- which whole numbers like `400` or `0` are, as opposed to
// `400.5`. getBoundingClientRect() values are frequently whole numbers, so
// this bit unconditional GetDouble() calls immediately. Read the type and
// branch instead of assuming DOUBLE.
static double GetJsonNumber(CefRefPtr<CefDictionaryValue> dict,
                            const CefString &key) {
  switch (dict->GetType(key)) {
  case VTYPE_INT:
    return dict->GetInt(key);
  case VTYPE_DOUBLE:
    return dict->GetDouble(key);
  default:
    return 0;
  }
}

// Draggable regions (-webkit-app-region: drag equivalent). `regions_json`
// is a JSON array of DOMRect-shaped objects: [{x,y,width,height}, ...] --
// matches what a page would get straight from getBoundingClientRect(), no
// reshaping needed on the JS side. Reached via BuniumWindow.pollMessages()
// special-casing the reserved "__bunium_drag_regions" message name (see
// window.ts) and passing the raw payload straight through, not through the
// typed .on() dispatch -- this isn't a message the app itself should see.
BUNIUM_EXPORT void bunium_set_drag_regions(void *view_handle,
                                           const char *regions_json) {
  auto *view = static_cast<BuniumView *>(view_handle);

  auto value = CefParseJSON(CefString(regions_json), JSON_PARSER_RFC);
  std::vector<BuniumClient::Rect> regions;
  if (value && value->GetType() == VTYPE_LIST) {
    auto list = value->GetList();
    for (size_t i = 0; i < list->GetSize(); i++) {
      if (list->GetType(i) != VTYPE_DICTIONARY)
        continue;
      auto dict = list->GetDictionary(i);
      regions.push_back(BuniumClient::Rect{
          static_cast<int>(GetJsonNumber(dict, "x")),
          static_cast<int>(GetJsonNumber(dict, "y")),
          static_cast<int>(GetJsonNumber(dict, "width")),
          static_cast<int>(GetJsonNumber(dict, "height")),
      });
    }
  }
  view->client->SetDragRegions(std::move(regions));
}

// Queried natively (bunium_window_mac.mm's mouseDown: handler) before
// deciding whether to forward a click to CEF or start a window drag.
// Routes through the same window_handle -> primary-client lookup as mouse
// dispatch; draggable regions are scoped to the primary view only for now,
// not sublayers.
BUNIUM_EXPORT int bunium_is_window_point_draggable(void *window_handle, int x,
                                                   int y) {
  auto it = g_target_to_client.find(window_handle);
  if (it == g_target_to_client.end())
    return 0;
  return it->second->IsPointDraggable(x, y) ? 1 : 0;
}

// Called from bunium_window_mac.mm's custom NSView event handlers with raw
// window-local coordinates (top-left origin, matching CEF's convention --
// the view is geometry-flipped so no manual flip needed here). Hit-tests
// registered sublayers first (topmost last-added wins); falls back to the
// window's own primary attached view if no sublayer is under the point.
BUNIUM_EXPORT void bunium_dispatch_mouse_click(void *window_handle, int x,
                                               int y, int button, int mouse_up,
                                               int click_count) {
  int local_x = x, local_y = y;
  void *target = HitTestSublayer(window_handle, x, y, &local_x, &local_y);
  if (!target)
    target = window_handle;

  auto it = g_target_to_client.find(target);
  if (it == g_target_to_client.end())
    return;
  auto browser = it->second->browser();
  if (!browser)
    return;

  g_last_focused_target = target;

  CefMouseEvent event;
  event.x = local_x;
  event.y = local_y;
  cef_mouse_button_type_t type = button == 1   ? MBT_MIDDLE
                                 : button == 2 ? MBT_RIGHT
                                               : MBT_LEFT;
  browser->GetHost()->SendMouseClickEvent(event, type, mouse_up != 0,
                                          click_count);
}

BUNIUM_EXPORT void bunium_dispatch_mouse_move(void *window_handle, int x, int y,
                                              int mouse_leave) {
  int local_x = x, local_y = y;
  void *target = HitTestSublayer(window_handle, x, y, &local_x, &local_y);
  if (!target)
    target = window_handle;

  auto it = g_target_to_client.find(target);
  if (it == g_target_to_client.end())
    return;
  auto browser = it->second->browser();
  if (!browser)
    return;

  CefMouseEvent event;
  event.x = local_x;
  event.y = local_y;
  browser->GetHost()->SendMouseMoveEvent(event, mouse_leave != 0);
}

// `event_type` matches cef_key_event_type_t (0=RAWKEYDOWN, 1=KEYDOWN,
// 2=KEYUP, 3=CHAR). `key_code` is macOS's raw NSEvent.keyCode used directly
// as both windows_key_code and native_key_code -- a known simplification
// (real Windows virtual-key mapping differs), good enough for basic
// key-down/up and ASCII character typing, not for full IME/composition
// support (that needs NSTextInputClient, unimplemented).
BUNIUM_EXPORT void bunium_dispatch_key_event(void *window_handle,
                                             int event_type, int modifiers,
                                             int key_code, uint16_t character) {
  // Route to whichever view (window's primary, or a sublayer) most
  // recently received a mouse click, not necessarily window_handle itself
  // -- that's what makes typing land in an embedded webview after clicking
  // into it, rather than always going to the outer app.
  void *target = g_last_focused_target ? g_last_focused_target : window_handle;
  auto it = g_target_to_client.find(target);
  if (it == g_target_to_client.end())
    return;
  auto browser = it->second->browser();
  if (!browser)
    return;

  CefKeyEvent event;
  event.type = static_cast<cef_key_event_type_t>(event_type);
  event.modifiers = static_cast<uint32_t>(modifiers);
  event.windows_key_code = key_code;
  event.native_key_code = key_code;
  event.character = character;
  event.unmodified_character = character;
  browser->GetHost()->SendKeyEvent(event);
}

BUNIUM_EXPORT void bunium_close_view(void *handle) {
  auto *view = static_cast<BuniumView *>(handle);
  auto browser = view->client->browser();
  if (browser)
    browser->GetHost()->CloseBrowser(true);
  delete view;
}

BUNIUM_EXPORT void bunium_shutdown() {
  CefShutdown();
  g_app = nullptr;
}

} // extern "C"
