#pragma once

#include <algorithm>
#include <atomic>
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

#include <cstdio>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
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

class BuniumClient : public CefClient,
                     public CefRenderHandler,
                     public CefLifeSpanHandler,
                     public CefDisplayHandler,
                     public CefLoadHandler {
public:
  explicit BuniumClient(int width, int height)
      : width_(width), height_(height) {}

  // CefClient
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

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
    if (BuniumVerbose())
      fprintf(stderr, "[after-created] id=%d\n", browser->GetIdentifier());
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
    }
  }
  void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override {
    if (frame->IsMain() && BuniumVerbose()) {
      fprintf(stderr, "[load-end] code=%d url=%s\n", httpStatusCode,
              frame->GetURL().ToString().c_str());
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
      auto args = message->GetArgumentList();
      std::string msg_name = args->GetString(0).ToString();
      std::string payload = args->GetString(1).ToString();
      std::lock_guard<std::mutex> lock(inbox_.mtx);
      inbox_.messages.emplace_back(std::move(msg_name), std::move(payload));
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
