# Linux dev/build environment for bunium's Phase 6 port. arm64 base to match
# Docker Desktop's native platform on this (Apple Silicon) host -- avoids QEMU
# emulation for the CEF build. CEF ships a linuxarm64 distro at the same
# version as vendor/cef-macosarm64 (151.3.16), so behavior stays comparable.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Build toolchain (clang/cmake, matching the clang-based mac/win builds) +
# X11 dev headers (windowing) + the runtime shared-lib surface CEF's
# Chromium core dlopens at runtime (NSS, ATK, GTK, DRM/GBM, PulseAudio/ALSA,
# Cairo/Pango) + Xvfb for headless smoke tests (no real display in a
# container) + curl/bzip2 for fetching the CEF distro.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang lld cmake ninja-build pkg-config \
    curl ca-certificates bzip2 unzip git \
    libx11-dev libxrandr-dev libxrender-dev libxext-dev libxfixes-dev \
    libxi-dev libxcursor-dev libxdamage-dev libxcomposite-dev libxtst-dev \
    libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
    libdrm2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libgtk-3-0t64 \
    xvfb x11-utils imagemagick gdb \
    dbus dbus-x11 libdbus-1-dev libglib2.0-dev libgtk-3-dev \
    && rm -rf /var/lib/apt/lists/*

# Bun (official installer), on PATH for all shells.
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

WORKDIR /work
