// Phase 9: bsdiff/bspatch delta-patch bridge for the auto-updater.
//
// The vendored mendsley/bsdiff implementation (vendor/bsdiff) exposes an
// in-memory, stream-callback API (struct bsdiff_stream / bspatch_stream)
// that bun:ffi cannot marshal (function pointers + callbacks). This file is
// a thin flat-C-ABI wrapper compiled into bunium_shim.dylib: it reads whole
// files into memory, drives the vendored library, and writes the result.
//
// NOTE on the file format: mendsley's bsdiff()/bspatch() do NOT themselves
// handle the 24-byte header (16-byte magic "ENDSLEY/BSDIFF43" + 8-byte LE
// new-file size) -- in the upstream repo that lives in the BSDIFF_EXECUTABLE
// main() paths, which we deliberately do not compile (they pull in bzlib).
// This wrapper writes (bsdiff) / parses+validates (bspatch) the header so
// patches are interchangeable with upstream mendsley tooling.
//
// All exports take only plain cstrings/pointers (≤8 args) and return an int
// status: 0 = OK, negative = error kind (see kStatus* below).
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// The vendored C headers name a parameter `new`, which is a C++ keyword.
// Rename it (only) while the headers are in scope; the compiled symbol names
// (bsdiff/bspatch) are unaffected. Vendored sources themselves stay untouched.
#define new new_data_param
extern "C" {
#include "bsdiff.h"
#include "bspatch.h"
}
#undef new

#if defined(_WIN32)
#define BUNIUM_BSDIFF_EXPORT __declspec(dllexport)
#else
#define BUNIUM_BSDIFF_EXPORT __attribute__((visibility("default")))
#endif

namespace {

// Status codes shared by all exports in this file.
constexpr int kStatusOk = 0;
constexpr int kStatusFileError = -1;   // open/read/write/seek failure
constexpr int kStatusBadHeader = -2;   // corrupt patch (magic/size mismatch)
constexpr int kStatusPatchError = -3;  // bsdiff/bspatch algorithm failed
constexpr int kStatusMemory = -4;      // malloc failure

constexpr size_t kMagicLen = 16;
constexpr size_t kHeaderLen = 24;  // magic + 8-byte LE new size
constexpr char kMagic[kMagicLen + 1] = "ENDSLEY/BSDIFF43";

// Reads the entire file at `path` into a malloc'd buffer. Returns the buffer
// (caller frees) or nullptr on any failure; *out_size receives its size.
uint8_t* ReadWholeFile(const char* path, int64_t* out_size) {
  FILE* f = fopen(path, "rb");
  if (!f) return nullptr;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return nullptr;
  }
  const long size = ftell(f);
  if (size < 0 || fseek(f, 0, SEEK_SET) != 0) {
    fclose(f);
    return nullptr;
  }
  // size+1 so a zero-length file still yields a non-null buffer (bsdiff
  // allocated oldsize+1 for the same reason).
  uint8_t* buf = static_cast<uint8_t*>(malloc(static_cast<size_t>(size) + 1));
  if (!buf) {
    fclose(f);
    return nullptr;
  }
  if (size > 0 &&
      fread(buf, 1, static_cast<size_t>(size), f) != static_cast<size_t>(size)) {
    free(buf);
    fclose(f);
    return nullptr;
  }
  fclose(f);
  *out_size = static_cast<int64_t>(size);
  return buf;
}

// Writes size bytes from buf to the file at path (truncating). 0 = OK.
int WriteWholeFile(const char* path, const uint8_t* buf, int64_t size) {
  FILE* f = fopen(path, "wb");
  if (!f) return kStatusFileError;
  if (size > 0 && fwrite(buf, 1, static_cast<size_t>(size), f) !=
                      static_cast<size_t>(size)) {
    fclose(f);
    return kStatusFileError;
  }
  if (fclose(f) != 0) return kStatusFileError;
  return kStatusOk;
}

// 8-byte little-endian signed size, matching upstream offtout() (mendsley
// encodes the *signed* value; sizes are never negative here, and bspatch's
// header parser also decodes signed).
void EncodeSize(int64_t x, uint8_t* buf) {
  for (int i = 0; i < 8; ++i) buf[i] = static_cast<uint8_t>((x >> (8 * i)) & 0xff);
}

int64_t DecodeSize(const uint8_t* buf) {
  int64_t y = 0;
  for (int i = 7; i >= 0; --i) y = (y << 8) | buf[i];
  return y;
}

// bsdiff stream writer that appends into an in-memory growable buffer.
struct PatchBuffer {
  uint8_t* data;
  int64_t size;
  int64_t cap;
};

int PatchBufferWrite(struct bsdiff_stream* stream, const void* buffer, int size) {
  auto* pb = static_cast<PatchBuffer*>(stream->opaque);
  if (pb->size + size > pb->cap) {
    const int64_t new_cap = pb->cap ? pb->cap * 2 : (1 << 16);
    uint8_t* grown = static_cast<uint8_t*>(realloc(pb->data, static_cast<size_t>(new_cap)));
    if (!grown) return -1;
    pb->data = grown;
    pb->cap = new_cap;
  }
  memcpy(pb->data + pb->size, buffer, static_cast<size_t>(size));
  pb->size += size;
  return 0;  // 0 = success, -1 = failure (upstream write-callback contract)
}

// bspatch stream reader that consumes the payload of an in-memory patch
// (the 24-byte header is skipped by the caller, which buffers the payload).
struct PayloadReader {
  const uint8_t* data;
  int64_t size;
  int64_t pos;
};

int PayloadRead(const struct bspatch_stream* stream, void* buffer, int length) {
  auto* pr = static_cast<PayloadReader*>(stream->opaque);
  if (pr->pos + length > pr->size) return -1;
  memcpy(buffer, pr->data + pr->pos, static_cast<size_t>(length));
  pr->pos += length;
  return 0;
}

// Owns a heap buffer (from malloc/ReadWholeFile) so early returns never leak.
// Wrapper cannot be copied; the buffer is freed on destruction.
class BufferOwner {
 public:
  explicit BufferOwner(uint8_t* ptr) : ptr_(ptr) {}
  ~BufferOwner() { free(ptr_); }
  BufferOwner(const BufferOwner&) = delete;
  BufferOwner& operator=(const BufferOwner&) = delete;
  uint8_t* get() const { return ptr_; }
  explicit operator bool() const { return ptr_ != nullptr; }

 private:
  uint8_t* ptr_;
};

}  // namespace

// Builds `patch_path` as a delta from `old_path` to `new_path`.
extern "C" BUNIUM_BSDIFF_EXPORT int
bunium_bsdiff(const char* old_path, const char* new_path, const char* patch_path) {
  int64_t old_size = 0, new_size = 0;
  BufferOwner old(ReadWholeFile(old_path, &old_size));
  if (!old) return kStatusFileError;
  BufferOwner src(ReadWholeFile(new_path, &new_size));
  if (!src) return kStatusFileError;

  PatchBuffer patch = {};
  struct bsdiff_stream stream;
  stream.opaque = &patch;
  stream.malloc = malloc;
  stream.free = free;
  stream.write = PatchBufferWrite;

  if (bsdiff(old.get(), old_size, src.get(), new_size, &stream) != 0)
    return kStatusPatchError;

  // Header: magic + new-file size, then the control/diff/extra payload.
  // Built in memory so a failure never leaves a truncated patch on disk.
  const int64_t total = static_cast<int64_t>(kHeaderLen) + patch.size;
  BufferOwner out(static_cast<uint8_t*>(malloc(static_cast<size_t>(total))));
  if (!out) {
    free(patch.data);
    return kStatusMemory;
  }
  memcpy(out.get(), kMagic, kMagicLen);
  EncodeSize(new_size, out.get() + kMagicLen);
  memcpy(out.get() + kHeaderLen, patch.data, static_cast<size_t>(patch.size));
  free(patch.data);
  return WriteWholeFile(patch_path, out.get(), total);
}

// Applies `patch_path` (built against `old_path`) to produce `new_path`.
// Validates the header (magic + sane new size) before applying so a corrupt
// or mismatched patch fails fast without touching the output file.
extern "C" BUNIUM_BSDIFF_EXPORT int
bunium_bspatch(const char* old_path, const char* patch_path, const char* new_path) {
  int64_t patch_size = 0;
  BufferOwner patch(ReadWholeFile(patch_path, &patch_size));
  if (!patch) return kStatusFileError;
  if (patch_size < static_cast<int64_t>(kHeaderLen)) return kStatusBadHeader;
  if (memcmp(patch.get(), kMagic, kMagicLen) != 0) return kStatusBadHeader;
  const int64_t new_size = DecodeSize(patch.get() + kMagicLen);
  if (new_size < 0 || new_size > (1LL << 40)) return kStatusBadHeader;

  int64_t old_size = 0;
  BufferOwner old(ReadWholeFile(old_path, &old_size));
  if (!old) return kStatusFileError;

  // Output must be presentable to bspatch as a writable buffer even at
  // size 0 (its loops only touch it while newpos < newsize).
  BufferOwner new_data(
      static_cast<uint8_t*>(malloc(static_cast<size_t>(new_size) + 1)));
  if (!new_data) return kStatusMemory;

  PayloadReader pr = {patch.get() + kHeaderLen,
                     patch_size - static_cast<int64_t>(kHeaderLen), 0};
  struct bspatch_stream stream;
  stream.opaque = &pr;
  stream.read = PayloadRead;
  if (bspatch(old.get(), old_size, new_data.get(), new_size, &stream) != 0)
    return kStatusPatchError;

  return WriteWholeFile(new_path, new_data.get(), new_size);
}

// Reads + validates a patch header. Returns kStatusOk or a negative status;
// *out_new_size receives the expected size of the patched file.
extern "C" BUNIUM_BSDIFF_EXPORT int
bunium_bsdiff_patch_info(const char* patch_path, int64_t* out_new_size) {
  int64_t patch_size = 0;
  BufferOwner patch(ReadWholeFile(patch_path, &patch_size));
  if (!patch) return kStatusFileError;
  if (patch_size < static_cast<int64_t>(kHeaderLen)) return kStatusBadHeader;
  if (memcmp(patch.get(), kMagic, kMagicLen) != 0) return kStatusBadHeader;
  const int64_t new_size = DecodeSize(patch.get() + kMagicLen);
  if (new_size < 0 || new_size > (1LL << 40)) return kStatusBadHeader;
  *out_new_size = new_size;
  return kStatusOk;
}
