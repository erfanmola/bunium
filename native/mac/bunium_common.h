#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32)
// CEF's Windows headers pull in windows.h themselves (CefWindowInfo has
// HWND members), so every TU that reaches them must pre-set NOMINMAX or
// windef.h's min/max macros break CEF's own std::min/::max usage. This is
// the single choke point common to shim, subprocess, and window TUs.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_display_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_parser.h"
#include "include/cef_process_message.h"
#include "include/cef_render_handler.h"
#include "include/cef_render_process_handler.h"
#include "include/cef_scheme.h"
#include "include/cef_v8.h"

// Injected once per page (alongside the reportBounds/send/on bootstrap in
// BuniumApp::OnContextCreated below) -- registers a real <bunium-webview>
// custom element. App code just writes <bunium-webview src="..."> in HTML;
// no manual bounds-reporting API. Reuses the generic window.__bunium.send()
// channel (4 reserved message names: __bunium_webview_create/_bounds/
// _navigate/_destroy) rather than adding new native ABI/CefProcessMessage
// plumbing -- BuniumWindow (window.ts) intercepts them the same way it
// already intercepts __bunium_drag_regions, and drives the existing
// bunium_create_native_sublayer/bunium_create_view/bunium_attach_window/
// bunium_navigate/bunium_close_* ABI directly to realize each element as a
// CAMetalLayer sublayer + its own CEF view. Position tracking uses a rAF
// loop (not just ResizeObserver, which only fires on size changes, not
// scroll/reflow-driven moves) reading getBoundingClientRect() every frame,
// only sending an update when the rounded rect actually changed -- cheap
// steady state, no update spam. A #define (not a std::string literal like
// the rest of the bootstrap) purely to keep this large chunk of JS visually
// separate/independently editable; still concatenated into one
// ExecuteJavaScript call at the site below.
#define WEBVIEW_ELEMENT_JS                                                     \
  "if (!customElements.get('bunium-webview')) {"                               \
  "  class BuniumWebview extends HTMLElement {"                                \
  "    connectedCallback() {"                                                  \
  "      if (!this.style.display) this.style.display = 'block';"               \
  "      this._id = 'wv-' + (BuniumWebview._nextId++);"                        \
  "      this._created = false;"                                               \
  "      this._lastRect = null;"                                               \
  "      this._lastClip = null;"                                               \
  "      var self = this;"                                                     \
  "      var tick = function() {"                                              \
  "        if (!self.isConnected) return;"                                     \
  "        self._sync();"                                                      \
  "        self._raf = requestAnimationFrame(tick);"                           \
  "      };"                                                                   \
  "      this._raf = requestAnimationFrame(tick);"                             \
  "    }"                                                                      \
  "    _sync() {"                                                              \
  "      var r = this.getBoundingClientRect();"                                \
  "      var rect = {x: Math.round(r.left), y: Math.round(r.top),"             \
  "                  width: Math.round(r.width), height: "                     \
  "Math.round(r.height)};"                                                     \
  "      if (rect.width <= 0 || rect.height <= 0) return;"                     \
  "      if (!this._created) {"                                                \
  "        this._created = true;"                                              \
  "        this._lastRect = rect;"                                             \
  "        window.__bunium.send('__bunium_webview_create', JSON.stringify({"   \
  "          id: this._id, src: this.getAttribute('src') || 'about:blank',"    \
  "          x: rect.x, y: rect.y, width: rect.width, height: rect.height"     \
  "        }));"                                                               \
  "        this._syncClip(rect);"                                              \
  "        BuniumWebview._syncOrder();"                                        \
  "        return;"                                                            \
  "      }"                                                                    \
  "      var last = this._lastRect;"                                           \
  "      if (!last || last.x !== rect.x || last.y !== rect.y ||"               \
  "          last.width !== rect.width || last.height !== rect.height) {"      \
  "        this._lastRect = rect;"                                             \
  "        window.__bunium.send('__bunium_webview_bounds', JSON.stringify({"   \
  "          id: this._id, x: rect.x, y: rect.y, width: rect.width, height: "  \
  "rect.height"                                                                \
  "        }));"                                                               \
  "      }"                                                                    \
  "      this._syncClip(rect);"                                                \
  "      BuniumWebview._syncOrder();"                                          \
  "    }"                                                                      \
  "    _syncClip(rect) {"                                                      \
  "      var clip = null;"                                                     \
  "      var node = this.parentElement;"                                       \
  "      while (node && node !== document.body && node !== "                   \
  "document.documentElement) {"                                                \
  "        var cs = getComputedStyle(node);"                                   \
  "        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {"    \
  "          var ar = node.getBoundingClientRect();"                           \
  "          var ac = {x: Math.round(ar.left), y: Math.round(ar.top),"         \
  "                    width: Math.round(ar.width), height: "                  \
  "Math.round(ar.height)};"                                                    \
  "          clip = clip ? {"                                                  \
  "            x: Math.max(clip.x, ac.x), y: Math.max(clip.y, ac.y),"          \
  "            width: Math.min(clip.x + clip.width, ac.x + ac.width) - "       \
  "Math.max(clip.x, ac.x),"                                                    \
  "            height: Math.min(clip.y + clip.height, ac.y + ac.height) - "    \
  "Math.max(clip.y, ac.y)"                                                     \
  "          } : ac;"                                                          \
  "        }"                                                                  \
  "        node = node.parentElement;"                                         \
  "      }"                                                                    \
  "      var needsClip = !!clip && (clip.x > rect.x || clip.y > rect.y ||"     \
  "        clip.x + clip.width < rect.x + rect.width ||"                       \
  "        clip.y + clip.height < rect.y + rect.height);"                      \
  "      var payload = needsClip"                                              \
  "        ? {id: this._id, clipped: true, x: clip.x, y: clip.y, width: "      \
  "Math.max(0, clip.width), height: Math.max(0, clip.height)}"                 \
  "        : {id: this._id, clipped: false};"                                  \
  "      var lc = this._lastClip;"                                             \
  "      if (lc && lc.clipped === payload.clipped && lc.x === payload.x &&"    \
  "          lc.y === payload.y && lc.width === payload.width &&"              \
  "          lc.height === payload.height) return;"                            \
  "      this._lastClip = payload;"                                            \
  "      window.__bunium.send('__bunium_webview_clip', "                       \
  "JSON.stringify(payload));"                                                  \
  "    }"                                                                      \
  "    static _syncOrder() {"                                                  \
  "      var all = Array.prototype.slice.call("                                \
  "        document.querySelectorAll('bunium-webview'));"                      \
  "      var els = all.filter(function(el) { return el._created; });"          \
  "      els.sort(function(a, b) {"                                            \
  "        var za = parseInt(getComputedStyle(a).zIndex, 10);"                 \
  "        var zb = parseInt(getComputedStyle(b).zIndex, 10);"                 \
  "        if (isNaN(za)) za = 0;"                                             \
  "        if (isNaN(zb)) zb = 0;"                                             \
  "        return za - zb;"                                                    \
  "      });"                                                                  \
  "      var order = els.map(function(el) { return el._id; });"                \
  "      var last = BuniumWebview._lastOrder;"                                 \
  "      if (last && last.length === order.length &&"                          \
  "          last.every(function(id, i) { return id === order[i]; })) return;" \
  "      BuniumWebview._lastOrder = order;"                                    \
  "      window.__bunium.send('__bunium_webview_order',"                       \
  "        JSON.stringify({order: order}));"                                   \
  "    }"                                                                      \
  "    static get observedAttributes() { return ['src']; }"                    \
  "    attributeChangedCallback(name, oldV, newV) {"                           \
  "      if (name === 'src' && this._created && newV !== oldV) {"              \
  "        window.__bunium.send('__bunium_webview_navigate',"                  \
  "          JSON.stringify({id: this._id, src: newV}));"                      \
  "      }"                                                                    \
  "    }"                                                                      \
  "    disconnectedCallback() {"                                               \
  "      if (this._raf) cancelAnimationFrame(this._raf);"                      \
  "      if (this._created) {"                                                 \
  "        window.__bunium.send('__bunium_webview_destroy', "                  \
  "JSON.stringify({id: this._id}));"                                           \
  "        BuniumWebview._syncOrder();"                                        \
  "      }"                                                                    \
  "    }"                                                                      \
  "  }"                                                                        \
  "  BuniumWebview._nextId = 1;"                                               \
  "  BuniumWebview._lastOrder = null;"                                         \
  "  customElements.define('bunium-webview', BuniumWebview);"                  \
  "}"

// Implemented in bunium_window_mac.mm, linked into the same dylib.
extern "C" void bunium_window_update_frame(void *handle, const uint8_t *bgra,
                                           int width, int height);
extern "C" void bunium_sublayer_set_frame(void *handle, int x, int y, int width,
                                          int height);

// Set (once, from bunium_shim.cpp) to BuniumWakeJs, which writes one byte
// to the wake self-pipe so src/app.ts's JS event loop finds out about
// newly-arrived work immediately instead of waiting for its next
// setTimeout-scheduled pump tick. A function pointer rather than a direct
// extern call because this header is also compiled into subprocess_main.cpp
// (a separate executable, built and linked without bunium_shim.cpp/dylib --
// see native/mac/build.sh) -- an extern reference to a symbol that only
// exists in the shim dylib would fail to link there even though child
// processes never actually need to call it (each process has its own
// BuniumApp instance; only the browser process's ever has a real wake pipe
// to write to). Stays nullptr (safe no-op) in every process except the
// browser process.
inline void (*g_wake_js_fn)() = nullptr;

// Name of the raw CefProcessMessage sent renderer->browser every time the
// injected window.__bunium.reportBounds(x, y, w, h) JS function is called.
// One-way, fire-and-forget -- no response expected, unlike CefMessageRouter
// which is request/response shaped and a worse fit for a per-animation-frame
// push (see ARCHITECTURE.md for why this mechanism was chosen over it).
inline constexpr const char *kBoundsMessageName = "bunium-report-bounds";

// Name of the raw CefProcessMessage behind the GENERAL-PURPOSE
// window.__bunium.send(name, jsonPayloadString) bridge -- unlike
// reportBounds (a one-off, deliberately not generalized -- see
// ARCHITECTURE.md), this is the mechanism future features (draggable
// regions, webview control messages, system-API callbacks) should build on
// instead of adding their own bespoke CefV8Handler each time. Two string
// args: [0] = the app-defined message name, [1] = a JSON-encoded payload
// (encoding happens on the JS side via JSON.stringify -- native just
// carries the string through, doesn't parse it).
inline constexpr const char *kSendMessageName = "bunium-send";

// Name of the raw CefProcessMessage carrying the main -> renderer push
// direction (native-originated events, e.g. a future "menu item clicked" --
// the other half of the typed IPC layer; kSendMessageName above is the
// renderer -> main half). Same two-string-args shape (message name, JSON
// payload) as kSendMessageName, just traveling the opposite way and
// dispatched via a JS-side listener registry instead of a native C++ inbox
// (see the bootstrap script injected in BuniumApp::OnContextCreated).
inline constexpr const char *kDispatchMessageName = "bunium-dispatch";

// Thread-safe inbox for generic named messages (see kSendMessageName).
// Written on CEF's UI thread inside OnProcessMessageReceived, drained from
// JS's pump loop via bunium_poll_message -- same producer/consumer pattern
// as FrameBuffer below.
struct MessageInbox {
  std::mutex mtx;
  std::deque<std::pair<std::string, std::string>> messages; // (name, payload)
};

// Holds the latest painted BGRA frame for one view. Written on CEF's UI
// thread inside OnPaint, read from bunium_get_frame() on whatever thread
// calls it (Bun's JS thread) -- guarded by a mutex since the two can race.
struct FrameBuffer {
  std::vector<uint8_t> pixels;
  int width = 0;
  int height = 0;
  std::mutex mtx;
};

// Env-gated verbose diagnostics for packaging/debugging (BUNIUM_CEF_VERBOSE
// raises CEF's log severity to INFO and turns on the [paint]/[load-*] lines
// below). Default off so normal runs stay quiet; matches how
// BUNIUM_BUNDLE_DEBUG gates the mainBundle dumps in bunium_shim.cpp.
inline bool BuniumVerbose() {
  static const bool on = getenv("BUNIUM_CEF_VERBOSE") != nullptr;
  return on;
}

// std::chrono::steady_clock is backed by the same system-wide monotonic
// timebase (mach_absolute_time on macOS, CLOCK_MONOTONIC on Linux) in
// every process on the machine -- unlike JS's performance.now() (which is
// relative to a per-context/process time origin), a steady_clock reading
// taken in the browser process and one taken in the renderer process are
// directly subtractable. Used only for the BUNIUM_IPC_DIAG round-trip
// latency breakdown (see bunium_ipc_diag_log in bunium_shim.cpp, and every
// BuniumIpcDiagLog call below) -- not part of the shipped hot path.
static int64_t MonotonicNowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

static bool BuniumIpcDiagEnabled() {
  static const bool enabled = getenv("BUNIUM_IPC_DIAG") != nullptr;
  return enabled;
}

// process_type: "browser" or "renderer" -- passed explicitly by each call
// site rather than queried from CEF, both are recognizable in the
// interleaved stderr output without needing to track PIDs by hand.
static void BuniumIpcDiagLog(const char *stage, const char *process_type) {
  if (!BuniumIpcDiagEnabled())
    return;
  fprintf(stderr, "[ipc-diag] t=%lld us stage=%s process=%s\n",
          (long long)MonotonicNowUs(), stage,
          (process_type && *process_type) ? process_type : "browser");
}

class BuniumClient : public CefClient,
                     public CefRenderHandler,
                     public CefLifeSpanHandler,
                     public CefDisplayHandler,
                     public CefLoadHandler,
                     public CefContextMenuHandler {
public:
  explicit BuniumClient(int width, int height)
      : width_(width), height_(height) {}

  // CefClient
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
    return this;
  }

  // CefContextMenuHandler -- without an explicit handler, CEF falls back to
  // its own native (Views-framework) context menu on right-click, which
  // isn't supported in windowless/OSR rendering and crashes the whole Bun
  // process (real repro: two-finger trackpad right-click -> "panic: A C++
  // exception occurred", an unhandled Cocoa/Views exception propagating
  // across the FFI boundary). Clearing the model suppresses CEF's default
  // menu entirely -- bunium doesn't have its own native context-menu API
  // yet, so "no menu" is the correct minimal behavior until one exists,
  // not a regression (right-click events still reach the page's own JS
  // contextmenu handler if any, unaffected by this).
  void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           CefRefPtr<CefContextMenuParams> params,
                           CefRefPtr<CefMenuModel> model) override {
    model->Clear();
  }

  // CefDisplayHandler -- page console.log/warn/error forwarded to our own
  // stderr. Was completely silent before this (page JS output had nowhere
  // to go), which made diagnosing the IPC latency issue (task #21) much
  // harder than it needed to be. Worth keeping permanently, not a one-off
  // debug hack.
  bool OnConsoleMessage(CefRefPtr<CefBrowser> browser, cef_log_severity_t level,
                        const CefString &message, const CefString &source,
                        int line) override {
    fprintf(stderr, "[console] %s:%d: %s\n", source.ToString().c_str(), line,
            message.ToString().c_str());
    return true; // suppress CEF's own default logging of it (avoid dupes)
  }

  // CefLifeSpanHandler
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    browser_ = browser;
    if (BuniumVerbose()) {
      fprintf(stderr, "[after-created] id=%d\n", browser->GetIdentifier());
      fprintf(stderr, "[startup-diag] t=%lld us stage=after_created\n",
              (long long)MonotonicNowUs());
    }
    // EXPERIMENT (task #21): explicitly assert not-occluded/visible in case
    // Chromium's rAF occlusion-throttling is misfiring in this environment
    // and causing the ~140-200ms bounds-sync lag measured in
    // examples/ipc-latency-test.ts. CEF's default assumption without this
    // call is unconfirmed -- this makes it explicit either way.
    browser->GetHost()->WasHidden(false);
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    browser_ = nullptr;
  }

  // CefLoadHandler
  void OnLoadingStateChange(CefRefPtr<CefBrowser> browser, bool isLoading,
                            bool canGoBack, bool canGoForward) override {
    if (BuniumVerbose()) {
      fprintf(stderr, "[loading] isLoading=%d\n", isLoading ? 1 : 0);
      if (isLoading)
        fprintf(stderr, "[startup-diag] t=%lld us stage=loading_start\n",
                (long long)MonotonicNowUs());
    }
  }
  void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override {
    if (frame->IsMain() && BuniumVerbose()) {
      fprintf(stderr, "[load-end] code=%d url=%s\n", httpStatusCode,
              frame->GetURL().ToString().c_str());
      fprintf(stderr, "[startup-diag] t=%lld us stage=load_end\n",
              (long long)MonotonicNowUs());
    }
  }
  void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode, const CefString &errorText,
                   const CefString &failedUrl) override {
    if (frame->IsMain()) {
      fprintf(stderr, "[load-error] code=%d text=%s url=%s\n", (int)errorCode,
              errorText.ToString().c_str(), failedUrl.ToString().c_str());
    }
  }

  // CefRenderHandler
  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect &rect) override {
    rect = CefRect(0, 0, width_, height_);
  }

  // Without this, CEF assumes device_scale_factor=1.0 and rasterizes at
  // logical (CSS) pixel resolution -- on a 2x Retina display that buffer
  // then gets upscaled onto a physically-2x CAMetalLayer, which is exactly
  // what blur looks like. width_/height_ above stay logical (CSS px); this
  // is what makes CEF internally produce an OnPaint buffer sized
  // width*scale x height*scale instead.
  bool GetScreenInfo(CefRefPtr<CefBrowser> browser,
                     CefScreenInfo &screen_info) override {
    screen_info.device_scale_factor = static_cast<float>(device_scale_factor_);
    return true;
  }

  void SetDeviceScaleFactor(double scale) {
    if (scale == device_scale_factor_)
      return;
    device_scale_factor_ = scale;
    if (browser_)
      browser_->GetHost()->NotifyScreenInfoChanged();
  }

  void OnPaint(CefRefPtr<CefBrowser> browser, PaintElementType type,
               const RectList &dirtyRects, const void *buffer, int width,
               int height) override {
    if (type != PET_VIEW)
      return;
    if (BuniumVerbose()) {
      fprintf(stderr, "[paint] %dx%d dirty=%zu\n", width, height,
              dirtyRects.size());
      if (!first_paint_logged_) {
        first_paint_logged_ = true;
        fprintf(stderr, "[startup-diag] t=%lld us stage=first_paint\n",
                (long long)MonotonicNowUs());
      }
    }
    {
      std::lock_guard<std::mutex> lock(frame_.mtx);
      size_t needed = static_cast<size_t>(width) * height * 4;
      frame_.pixels.resize(needed);
      std::memcpy(frame_.pixels.data(), buffer, needed);
      frame_.width = width;
      frame_.height = height;
    }
    frame_count_.fetch_add(1, std::memory_order_relaxed);

    if (native_window_) {
      bunium_window_update_frame(
          native_window_, static_cast<const uint8_t *>(buffer), width, height);
    }
  }

  void AttachWindow(void *native_window) { native_window_ = native_window; }

  // The sublayer (see bunium_create_sublayer) that this view's page reports
  // its DOM element bounds against -- e.g. the outer app tracking where its
  // <bunium-webview> element sits. Not the same as native_window_: that's
  // this view's own paint target, this is a *different* view's paint
  // target that this view's JS is allowed to reposition.
  void SetTrackedSublayer(void *sublayer) { tracked_sublayer_ = sublayer; }

  // Draggable regions (-webkit-app-region: drag equivalent). Set via
  // bunium_set_drag_regions (bunium_shim.cpp), queried natively at
  // mouseDown time by BuniumContentView (bunium_window_mac.mm) before
  // deciding whether to forward the click to CEF or start a window drag --
  // both happen on the same thread as this setter (Bun's pump-loop tick
  // drives both Cocoa event dispatch and CEF message processing), so no
  // locking needed.
  struct Rect {
    int x, y, w, h;
  };
  void SetDragRegions(std::vector<Rect> regions) {
    drag_regions_ = std::move(regions);
  }
  bool IsPointDraggable(int x, int y) const {
    for (const auto &r : drag_regions_) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
        return true;
    }
    return false;
  }

  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override {
    const auto &name = message->GetName();
    if (name == kBoundsMessageName) {
      if (!tracked_sublayer_)
        return true;
      auto args = message->GetArgumentList();
      int x = static_cast<int>(args->GetDouble(0));
      int y = static_cast<int>(args->GetDouble(1));
      int w = static_cast<int>(args->GetDouble(2));
      int h = static_cast<int>(args->GetDouble(3));
      bunium_sublayer_set_frame(tracked_sublayer_, x, y, w, h);
      return true;
    }
    if (name == kSendMessageName) {
      BuniumIpcDiagLog("browser_inbox_recv", "browser");
      auto args = message->GetArgumentList();
      std::string msg_name = args->GetString(0).ToString();
      std::string payload = args->GetString(1).ToString();
      {
        std::lock_guard<std::mutex> lock(inbox_.mtx);
        inbox_.messages.emplace_back(std::move(msg_name), std::move(payload));
      }
      // Don't wait for CEF to separately call OnScheduleMessagePumpWork for
      // this -- wake the JS pump loop directly the instant a message is
      // queued, so window.__bunium.send() replies aren't gated by the next
      // timer-scheduled tick (see g_wake_js_fn's comment).
      if (g_wake_js_fn) g_wake_js_fn();
      return true;
    }
    return false;
  }

  // Returns true and fills outName/outPayload if a message was pending,
  // false if the inbox was empty. Pops one at a time (FIFO) -- callers
  // should loop until it returns false to drain everything queued since
  // the last poll.
  bool PopMessage(std::string *out_name, std::string *out_payload) {
    std::lock_guard<std::mutex> lock(inbox_.mtx);
    if (inbox_.messages.empty())
      return false;
    *out_name = std::move(inbox_.messages.front().first);
    *out_payload = std::move(inbox_.messages.front().second);
    inbox_.messages.pop_front();
    return true;
  }

  void Resize(int width, int height) {
    width_ = width;
    height_ = height;
    if (browser_)
      browser_->GetHost()->WasResized();
  }

  CefRefPtr<CefBrowser> browser() { return browser_; }
  FrameBuffer &frame() { return frame_; }
  uint64_t frame_count() const {
    return frame_count_.load(std::memory_order_relaxed);
  }

private:
  int width_;
  int height_;
  CefRefPtr<CefBrowser> browser_;
  FrameBuffer frame_;
  std::atomic<uint64_t> frame_count_{0};
  void *native_window_ = nullptr;
  void *tracked_sublayer_ = nullptr;
  double device_scale_factor_ = 1.0;
  bool first_paint_logged_ = false;
  MessageInbox inbox_;
  std::vector<Rect> drag_regions_;

  IMPLEMENT_REFCOUNTING(BuniumClient);
};

// Backs window.__bunium.reportBounds(x, y, w, h) in the renderer process.
// Runs on the V8/renderer-main thread; just packs args into a
// CefProcessMessage and fires it at the browser process. No return value,
// no error handling beyond "wrong arg count/type is silently ignored" --
// this is an internal bridge the framework itself controls both ends of,
// not a public API surface that needs to be defensive against misuse.
class BuniumV8Handler : public CefV8Handler {
public:
  bool Execute(const CefString &name, CefRefPtr<CefV8Value> object,
               const CefV8ValueList &arguments, CefRefPtr<CefV8Value> &retval,
               CefString &exception) override {
    CefRefPtr<CefV8Context> context = CefV8Context::GetCurrentContext();

    if (name == "reportBounds") {
      if (arguments.size() != 4)
        return false;
      auto message = CefProcessMessage::Create(kBoundsMessageName);
      auto args = message->GetArgumentList();
      for (size_t i = 0; i < 4; i++) {
        args->SetDouble(i, arguments[i]->GetDoubleValue());
      }
      context->GetFrame()->SendProcessMessage(PID_BROWSER, message);
      return true;
    }

    if (name == "send") {
      if (arguments.size() != 2 || !arguments[0]->IsString() ||
          !arguments[1]->IsString()) {
        return false;
      }
      auto message = CefProcessMessage::Create(kSendMessageName);
      auto args = message->GetArgumentList();
      args->SetString(0, arguments[0]->GetStringValue());
      args->SetString(1, arguments[1]->GetStringValue());
      BuniumIpcDiagLog("renderer_send_v8", "renderer");
      context->GetFrame()->SendProcessMessage(PID_BROWSER, message);
      return true;
    }

    return false;
  }

private:
  IMPLEMENT_REFCOUNTING(BuniumV8Handler);
};

// Production static-file serving: `bunium://app/<path>` resolves against a
// registered root directory on disk and streams the file back, entirely
// offline -- no localhost server, no `file://` (which has its own CORS/
// relative-path quirks CEF docs specifically call out, see the Phase 3 plan
// note in PLAN.md). `bunium` is registered as a CEF "standard" scheme (URL
// canonicalization/relative-path resolution work the same as http/https)
// with CORS + fetch enabled, so `<script type="module">`, relative
// `fetch()`/`import()`, and `<link>`/`<img>` all resolve exactly like a real
// site would -- unlike `file://` URLs, which CEF explicitly restricts (see
// CEF_SCHEME_OPTION_LOCAL's own doc comment: "normal pages cannot link to or
// access local URLs"). Registered once in OnRegisterCustomSchemes (must run
// in every process per CefApp's own contract, not just the browser process)
// and given a concrete handler via CefRegisterSchemeHandlerFactory from
// OnContextInitialized (browser process only, once CEF's IO thread exists).
//
// Root directory is set from JS via bunium_set_app_root (bunium_shim.cpp) --
// a plain global here, not per-window, matching Electron's own
// app.setAppLogsPath-style single-root convention; multi-root support isn't
// needed until a real multi-window-with-different-bundles use case shows up.
static std::string g_bunium_scheme_root;

class BuniumSchemeResourceHandler : public CefResourceHandler {
public:
  explicit BuniumSchemeResourceHandler(std::string file_path)
      : file_path_(std::move(file_path)) {}

  bool Open(CefRefPtr<CefRequest> /*request*/, bool &handle_request,
            CefRefPtr<CefCallback> /*callback*/) override {
    handle_request = true;
    FILE *f = fopen(file_path_.c_str(), "rb");
    if (BuniumVerbose()) {
      fprintf(stderr, "[scheme-open] %s -> %s\n", f ? "ok" : "ENOENT",
              file_path_.c_str());
    }
    if (!f) {
      status_code_ = 404;
      return true;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size > 0) {
      data_.resize(static_cast<size_t>(size));
      size_t read = fread(data_.data(), 1, data_.size(), f);
      data_.resize(read);
    }
    fclose(f);
    status_code_ = 200;
    return true;
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t &response_length,
                          CefString & /*redirectUrl*/) override {
    response->SetStatus(status_code_);
    if (status_code_ != 200) {
      response_length = 0;
      return;
    }
    // Extension-based MIME sniffing (CefGetMimeType, parser.h) -- good
    // enough for the static assets a Vite build actually produces (html,
    // js, css, json, common image/font formats); files with no/unknown
    // extension fall back to CEF's own "application/octet-stream" default.
    auto dot = file_path_.find_last_of('.');
    std::string ext =
        dot == std::string::npos ? "" : file_path_.substr(dot + 1);
    CefString mime = CefGetMimeType(ext);
    response->SetMimeType(mime.empty() ? CefString("application/octet-stream")
                                       : mime);
    response_length = static_cast<int64_t>(data_.size());
  }

  bool Read(void *data_out, int bytes_to_read, int &bytes_read,
            CefRefPtr<CefResourceReadCallback> /*callback*/) override {
    size_t remaining = data_.size() - offset_;
    if (remaining == 0) {
      bytes_read = 0;
      return false;
    }
    size_t n = std::min(remaining, static_cast<size_t>(bytes_to_read));
    memcpy(data_out, data_.data() + offset_, n);
    offset_ += n;
    bytes_read = static_cast<int>(n);
    if (BuniumVerbose()) {
      fprintf(stderr, "[scheme-read] %d bytes (offset %zu/%zu)\n", n, offset_,
              data_.size());
    }
    return true;
  }

  void Cancel() override {
    if (BuniumVerbose())
      fprintf(stderr, "[scheme-cancel] %s\n", file_path_.c_str());
  }

private:
  std::string file_path_;
  std::vector<uint8_t> data_;
  size_t offset_ = 0;
  int status_code_ = 404;

  IMPLEMENT_REFCOUNTING(BuniumSchemeResourceHandler);
};

class BuniumSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> /*browser*/,
                                       CefRefPtr<CefFrame> /*frame*/,
                                       const CefString & /*scheme_name*/,
                                       CefRefPtr<CefRequest> request) override {
    if (g_bunium_scheme_root.empty()) {
      if (BuniumVerbose())
        fprintf(stderr, "[scheme-create] NULL: root not set\n");
      return nullptr;
    }

    CefURLParts parts;
    if (!CefParseURL(request->GetURL(), parts)) {
      if (BuniumVerbose())
        fprintf(stderr, "[scheme-create] NULL: parse fail: %s\n",
                request->GetURL().ToString().c_str());
      return nullptr;
    }
    std::string path = CefString(&parts.path).ToString();
    if (path.empty() || path == "/")
      path = "/index.html";

    // Reject any path containing ".." after CEF's own URL canonicalization
    // (which already collapses most traversal attempts for standard
    // schemes) -- defense in depth, not the only guard.
    if (path.find("..") != std::string::npos) {
      if (BuniumVerbose())
        fprintf(stderr, "[scheme-create] NULL: traversal: %s\n", path.c_str());
      return nullptr;
    }

    std::string full_path = g_bunium_scheme_root + path;
    if (BuniumVerbose()) {
      fprintf(stderr, "[scheme-create] serving root=%s path=%s\n",
              g_bunium_scheme_root.c_str(), path.c_str());
    }
    return new BuniumSchemeResourceHandler(full_path);
  }

  IMPLEMENT_REFCOUNTING(BuniumSchemeHandlerFactory);
};
// Adaptive message pump (Phase: beat-Electron-on-idle-CPU). With
// settings.external_message_pump = true, CEF stops expecting
// CefDoMessageLoopWork() on a blind fixed interval and instead tells the
// host exactly when it next needs pumping via
// BuniumApp::OnScheduleMessagePumpWork(delay_ms) below. That callback can
// fire from any CEF-internal thread (documented CEF contract), so the
// requested wake time is stored here as a monotonic-clock deadline in an
// atomic, always kept at the *earliest* pending request -- a later call
// with a larger delay must not push out an earlier one. src/app.ts's pump
// loop reads it once per tick (via bunium_get_next_pump_delay_ms in
// bunium_shim.cpp) to size its next setTimeout, instead of a fixed
// interval. Deliberately NOT a native->JS async callback (bun:ffi
// JSCallback fired from an arbitrary native thread) -- see PLAN.md's
// Phase-1 writeup for why that's not worth the added FFI-threading risk
// here; this is the bounded-polling middle ground.
static std::atomic<int64_t> g_next_wake_time_ms{-1};

static int64_t MonotonicNowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class BuniumApp : public CefApp,
                  public CefBrowserProcessHandler,
                  public CefRenderProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
    return this;
  }

  // Force the real Metal ANGLE backend instead of falling back to
  // SwiftShader (software Vulkan), which adds GPU-process overhead with
  // none of the speed benefit.
  void OnBeforeCommandLineProcessing(
      const CefString &process_type,
      CefRefPtr<CefCommandLine> command_line) override {
    command_line->AppendSwitch("disable-gpu");
    command_line->AppendSwitch("disable-gpu-compositing");
    // GPU compositing is already off (see above) -- the isolated GPU process
    // exists only to do CPU-side compositing work with no real driver code
    // running in it, so merging it into the browser process costs no real
    // crash-isolation benefit today. Verified clean previously (37/37
    // examples, 6/6 scaffolds); re-shipping to re-measure against Electron.
    command_line->AppendSwitch("in-process-gpu");
#if defined(__APPLE__)
    // Verified clean on macOS (37/37 examples, real RSS/process-count win,
    // no perf cost -- see ARCHITECTURE.md #19). NOT enabled on Windows/Linux:
    // docs/guide/dev-from-mac.md documents a real "bun + in-process CEF
    // SEGVs" finding from Windows bring-up with this exact flag -- gate to
    // mac only until independently verified on those platforms, don't let a
    // shared-header change silently ship an unverified crash risk there.
    command_line->AppendSwitch("single-process");
    // --no-proxy-server (needed on GitHub Actions' macOS runners -- PAC/WPAD
    // auto-discovery there breaks single-process mode outright, not just
    // the documented harmless log line below) is injected into the real
    // initial argv in bunium_shim.cpp's CefInitialize call instead of here:
    // SystemNetworkContextManager reads the command line for its
    // single-process + auto-proxy check before OnBeforeCommandLineProcessing
    // switches get merged back in, so appending it only here is invisible
    // to that check.
#endif
    // Linux verification (2026-09-03, real hardware -- WSL2 Ubuntu 24.04
    // x64, native g++ build via native/linux/build.sh, not emulation):
    // tested with __linux__ temporarily added to the gate above. Full
    // examples/*.ts sweep: 36/37 passed clean (same 2 pre-existing
    // failures as the baseline without this flag -- color-scheme-live-
    // test.ts needs macOS's osascript, and the vite-dev-test cold-cache
    // flake). BUT examples/vite-dev-test.ts also reproduced a NEW,
    // consistently reproducible crash (3 of 3 reruns, not a flake) not
    // present in the baseline: SIGTRAP ("Trace/breakpoint trap"), core
    // dump, during app.shutdown() cleanup -- after both in-test assertions
    // had already passed. Real, single-process-specific instability on
    // Linux, not present without the flag. NOT enabling --single-process
    // on Linux as a result -- see benchmark/RESULTS.md and PLAN.md's
    // Linux verification notes for the full repro and reasoning.
    //
    // Windows verification (2026-09-03, real hardware -- GitHub Actions
    // windows-latest via .github/workflows/win-smoke.yml, Tier 1 of
    // docs/guide/dev-from-mac.md's remote-Windows workflow, clang-cl build
    // via native/win/build.sh): tested with _WIN32 temporarily added to the
    // gate above. Baseline (flag off) full examples/*.ts sweep: 37/38 clean
    // (only the expected mac-only color-scheme-live-test.ts failure). With
    // the flag on: 34/38, three NEW failures not present in the baseline --
    // relaunch-test.ts (shim timing assertion failed), scheme-handler-
    // test.ts (hung to timeout, CEF logged "Cannot use V8 Proxy resolver in
    // single process mode" -- an explicit CEF-side rejection of this
    // combination, not a flake), and vite-dev-test.ts (dev server never
    // became ready). This matches and confirms the pre-existing documented
    // "bun + in-process CEF SEGVs" risk from Windows native bring-up in
    // docs/guide/dev-from-mac.md. NOT enabling --single-process on Windows
    // -- confirmed genuinely unsafe to ship there, not just unverified. See
    // benchmark/RESULTS.md and PLAN.md's Windows verification notes for the
    // full repro and reasoning.
    // Chromium's spare-renderer-process feature pre-spawns an idle renderer
    // ahead of the next navigation as a latency optimization for real
    // browsers with tabs/link-clicking. A bunium window's one navigation is
    // already known at CreateBrowser time -- there's no "next tab" to
    // pre-warm for -- so this only costs an extra always-on renderer
    // process for nothing. Confirmed via ps against benchmark/electron-*:
    // Electron's own renderer command line already carries
    // --disable-features=...SpareRendererForSitePerProcess..., and
    // disabling it here dropped bunium's process count 6->5 (matching
    // Electron) with no functional loss (verified full example/scaffold
    // sweep after this change).
    // AppendSwitchWithValue would clobber, not merge, any
    // "disable-features" CEF/Chromium already set on this command line
    // internally (observed non-empty on renderer processes) -- merge
    // explicitly instead of gambling on undocumented CommandLine merge
    // behavior.
    // Mach port rendezvous peer code-signature validation
    // (MachPortRendezvousValidatePeerRequirements /
    // MachPortRendezvousEnforcePeerRequirements, base/mac/process_requirement*
    // upstream) is FEATURE_DISABLED_BY_DEFAULT in Chromium but active in this
    // CEF build's baked-in field-trial config -- confirmed via a real
    // symbolicated profile (CEF's own release_symbols dSYM matched by UUID
    // against the vendored framework, see PLAN.md/benchmark/RESULTS.md for the
    // full methodology): a ThreadPoolForegroundWorker thread spent its entire
    // sampled window inside
    // base::mac::ProcessRequirement::{ValidateProcess,GatherMetrics}.
    // The real dominant idle-CPU driver turned out to be a SEPARATE feature,
    // "GatherProcessRequirementMetrics" (base/mac/process_requirement.cc,
    // FEATURE_ENABLED_BY_DEFAULT) -- it independently calls the exact same
    // ValidateProcess/GatherMetrics code path purely to record
    // Mac.ProcessRequirement.* UMA histograms, regardless of the two
    // Mach-port-rendezvous flags above. In this dev (unbundled `bun run`,
    // not a signed .app) environment that code-signature validation call
    // hangs for the entire process lifetime on one ThreadPoolBackgroundWorker
    // thread -- confirmed via a fresh symbolicated `sample` capture showing
    // the thread's ENTIRE sampled window inside ValidateProcess/GatherMetrics
    // again despite the two flags above already being disabled. Disabling
    // this one flag measured idle CPU 59.4% -> 3.0% (benchmark/RESULTS.md).
    std::string disable_features =
        "SpareRendererForSitePerProcess,"
        "MachPortRendezvousValidatePeerRequirements,"
        "MachPortRendezvousEnforcePeerRequirements,"
        "GatherProcessRequirementMetrics";
    if (command_line->HasSwitch("disable-features")) {
      std::string existing = command_line->GetSwitchValue("disable-features").ToString();
      if (!existing.empty())
        disable_features = existing + "," + disable_features;
    }
    command_line->AppendSwitchWithValue("disable-features", disable_features);
  }

  // CefBrowserProcessHandler contract, only meaningful with
  // settings.external_message_pump = true (bunium_shim.cpp). CEF calls this
  // to say "call CefDoMessageLoopWork() again in delay_ms" (0/negative =
  // as soon as possible) -- may be called from any thread, and may be
  // called again before an earlier request's delay has elapsed (must not
  // push the wake time later in that case). src/app.ts's pump loop polls
  // the resulting deadline via bunium_get_next_pump_delay_ms() each tick.
  void OnScheduleMessagePumpWork(int64_t delay_ms) override {
    if (BuniumIpcDiagEnabled()) {
      fprintf(stderr,
              "[ipc-diag] t=%lld us stage=browser_pump_schedule_requested "
              "delay_ms=%lld process=browser\n",
              (long long)MonotonicNowUs(), (long long)delay_ms);
    }
    if (getenv("BUNIUM_PUMP_DIAG")) {
      static std::atomic<int64_t> call_count{0};
      int64_t n = call_count.fetch_add(1, std::memory_order_relaxed);
      fprintf(stderr, "[pump-diag] OnScheduleMessagePumpWork call #%lld delay_ms=%lld\n",
              (long long)n, (long long)delay_ms);
    }
    int64_t candidate = MonotonicNowMs() + std::max<int64_t>(delay_ms, 0);
    int64_t current = g_next_wake_time_ms.load(std::memory_order_relaxed);
    while (current == -1 || candidate < current) {
      if (g_next_wake_time_ms.compare_exchange_weak(current, candidate,
                                                     std::memory_order_relaxed))
        break;
    }
    // delay_ms <= 0 means "as soon as possible" -- don't make JS wait to
    // discover this on its next already-scheduled tick, wake it now.
    if (delay_ms <= 0 && g_wake_js_fn)
      g_wake_js_fn();
  }

  // Registers the `bunium` custom scheme (Phase 3 prod static-file serving,
  // see BuniumSchemeHandlerFactory's own comment above). Must run in every
  // process, per CefApp's own documented contract for
  // OnRegisterCustomSchemes -- not just the browser process where the
  // handler factory itself is registered below -- otherwise child
  // (renderer/GPU) processes wouldn't agree on the scheme's security
  // properties (standard/CORS-enabled/fetch-enabled) and requests could be
  // silently blocked as cross-origin.
  void
  OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme("bunium", CEF_SCHEME_OPTION_STANDARD |
                                             CEF_SCHEME_OPTION_CORS_ENABLED |
                                             CEF_SCHEME_OPTION_FETCH_ENABLED |
                                             CEF_SCHEME_OPTION_CSP_BYPASSING);
  }

  // Browser-process-only (per CefBrowserProcessHandler's contract) --
  // CefRegisterSchemeHandlerFactory needs CEF's IO thread, which doesn't
  // exist yet during OnRegisterCustomSchemes above.
  void OnContextInitialized() override {
    if (BuniumVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=context_initialized\n",
              (long long)MonotonicNowUs());
    CefRegisterSchemeHandlerFactory("bunium", "app",
                                    new BuniumSchemeHandlerFactory());
  }

  // Injects window.__bunium.reportBounds(x, y, w, h) into every page bunium
  // loads. Runs in the renderer process, once per V8 context (so once per
  // frame/iframe, but bunium pages are single-frame for now).
  void OnContextCreated(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override {
    if (BuniumVerbose()) {
      fprintf(stderr, "[context-created] url=%s\n",
              frame->GetURL().ToString().c_str());
      fprintf(stderr,
              "[startup-diag] t=%lld us stage=renderer_context_created "
              "process=renderer\n",
              (long long)MonotonicNowUs());
    }
    CefRefPtr<CefV8Value> global = context->GetGlobal();
    CefRefPtr<CefV8Value> bunium_obj =
        CefV8Value::CreateObject(nullptr, nullptr);
    CefRefPtr<CefV8Handler> handler = new BuniumV8Handler();
    CefRefPtr<CefV8Value> report_bounds_fn =
        CefV8Value::CreateFunction("reportBounds", handler);
    bunium_obj->SetValue("reportBounds", report_bounds_fn,
                         V8_PROPERTY_ATTRIBUTE_NONE);
    CefRefPtr<CefV8Value> send_fn = CefV8Value::CreateFunction("send", handler);
    bunium_obj->SetValue("send", send_fn, V8_PROPERTY_ATTRIBUTE_NONE);
    global->SetValue("__bunium", bunium_obj, V8_PROPERTY_ATTRIBUTE_NONE);

    // Main -> renderer push (the other direction of the typed IPC layer):
    // .on()/the listener registry/dispatch fan-out are pure JS -- no native
    // handler needed for them, only __dispatch needs to be callable from
    // C++ (see OnProcessMessageReceived below), so plain ExecuteJavaScript
    // is simpler here than hand-building V8 objects/arrays via the C++ API.
    frame->ExecuteJavaScript(
        "window.__bunium._listeners = {};"
        "window.__bunium.on = function(name, cb) {"
        "  (window.__bunium._listeners[name] ="
        "    window.__bunium._listeners[name] || []).push(cb);"
        "};"
        "window.__bunium.__dispatch = function(name, payloadJson) {"
        "  var cbs = window.__bunium._listeners[name];"
        "  if (!cbs) return;"
        "  var payload = JSON.parse(payloadJson);"
        "  for (var i = 0; i < cbs.length; i++) cbs[i](payload);"
        "};"
        // Draggable regions: same convention as Electron's
        // -webkit-app-region: drag. Scans the whole DOM for elements with
        // that computed style, reports their rects to native whenever the
        // page loads/resizes/mutates (debounced to one scan per animation
        // frame via a pending-flag instead of a raw rAF-every-mutation
        // storm). querySelectorAll('*') is O(all elements) per scan --
        // acceptable for v1, a data-attribute convention would be cheaper
        // for very large pages if this becomes a bottleneck later.
        "window.__bunium._scanDragRegions = function() {"
        "  var els = document.querySelectorAll('*');"
        "  var regions = [];"
        "  for (var i = 0; i < els.length; i++) {"
        "    var style = getComputedStyle(els[i]);"
        "    if (style.getPropertyValue('-webkit-app-region').trim() === "
        "'drag') {"
        "      var r = els[i].getBoundingClientRect();"
        "      regions.push({x: r.left, y: r.top, width: r.width, height: "
        "r.height});"
        "    }"
        "  }"
        "  window.__bunium.send('__bunium_drag_regions', "
        "JSON.stringify(regions));"
        "};"
        "window.__bunium._dragScanScheduled = false;"
        "window.__bunium._scheduleDragScan = function() {"
        "  if (window.__bunium._dragScanScheduled) return;"
        "  window.__bunium._dragScanScheduled = true;"
        "  requestAnimationFrame(function() {"
        "    window.__bunium._dragScanScheduled = false;"
        "    window.__bunium._scanDragRegions();"
        "  });"
        "};"
        "window.addEventListener('load', window.__bunium._scheduleDragScan);"
        "window.addEventListener('resize', window.__bunium._scheduleDragScan);"
        // document.documentElement doesn't exist yet at OnContextCreated
        // time (V8 context is created before the DOM is parsed) --
        // MutationObserver needs a real Node to observe, so defer setup
        // until DOMContentLoaded guarantees documentElement exists.
        "document.addEventListener('DOMContentLoaded', function() {"
        "  new MutationObserver(window.__bunium._scheduleDragScan)"
        "    .observe(document.documentElement, "
        "      {attributes: true, childList: true, subtree: "
        "true});"
        "});" WEBVIEW_ELEMENT_JS,
        frame->GetURL(), 0);

    contexts_[frame->GetIdentifier().ToString()] = context;
  }

  void OnContextReleased(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override {
    contexts_.erase(frame->GetIdentifier().ToString());
  }

  // Renderer-side half of main -> renderer push: looks up the V8 context
  // for the target frame and calls window.__bunium.__dispatch(name,
  // payload) directly. Runs on the renderer's main/V8 thread already (this
  // callback IS that thread), so entering the context here is safe.
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override {
    if (message->GetName() != kDispatchMessageName)
      return false;
    BuniumIpcDiagLog("renderer_dispatch_recv", "renderer");

    auto it = contexts_.find(frame->GetIdentifier().ToString());
    if (it == contexts_.end())
      return true;

    auto args = message->GetArgumentList();
    CefString msg_name = args->GetString(0);
    CefString payload = args->GetString(1);

    CefRefPtr<CefV8Context> context = it->second;
    if (!context->Enter())
      return true;
    CefRefPtr<CefV8Value> global = context->GetGlobal();
    CefRefPtr<CefV8Value> bunium_obj = global->GetValue("__bunium");
    if (bunium_obj && bunium_obj->IsObject()) {
      CefRefPtr<CefV8Value> dispatch_fn = bunium_obj->GetValue("__dispatch");
      if (dispatch_fn && dispatch_fn->IsFunction()) {
        CefV8ValueList js_args;
        js_args.push_back(CefV8Value::CreateString(msg_name));
        js_args.push_back(CefV8Value::CreateString(payload));
        dispatch_fn->ExecuteFunction(bunium_obj, js_args);
      }
    }
    context->Exit();
    return true;
  }

private:
  std::map<std::string, CefRefPtr<CefV8Context>> contexts_;

  IMPLEMENT_REFCOUNTING(BuniumApp);
};
