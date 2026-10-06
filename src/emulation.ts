/** Screen traits Bunium can set on an off-screen guest independently of the host display. */
export interface DeviceEmulationDescriptor {
  /** Screen dimensions in CSS pixels. The guest viewport remains its bounds. */
  screen: { width: number; height: number };
  /** Target devicePixelRatio used by Chromium rasterization. */
  deviceScaleFactor: number;
  /** Touch capability exposed to the guest document. */
  touch?: { enabled: boolean; maxTouchPoints: number };
  /** CSS pointer and hover media features exposed to the guest document. */
  pointer?: {
    primary: "none" | "coarse" | "fine";
    any: "none" | "coarse" | "fine";
    hover: boolean;
    anyHover: boolean;
  };
}

/** Traits that the current CEF backend can and cannot emulate faithfully. */
export const deviceEmulationCapabilities = {
  viewport: "supported",
  screen: "supported",
  deviceScaleFactor: "supported",
  touch: "supported",
  pointer: "supported",
} as const;

export function validateDeviceEmulation(
  descriptor: DeviceEmulationDescriptor,
): DeviceEmulationDescriptor {
  const keys = Object.keys(descriptor);
  if (
    keys.some(
      (key) =>
        !["screen", "deviceScaleFactor", "touch", "pointer"].includes(key),
    )
  ) {
    throw new TypeError(
      "bunium: device emulation descriptor has unknown fields",
    );
  }
  if (
    Object.keys(descriptor.screen).some(
      (key) => key !== "width" && key !== "height",
    )
  ) {
    throw new TypeError(
      "bunium: emulated screen descriptor has unknown fields",
    );
  }
  const { width, height } = descriptor.screen;
  const scale = descriptor.deviceScaleFactor;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384
  ) {
    throw new RangeError(
      "bunium: emulated screen dimensions must be integers from 1 to 16384",
    );
  }
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 8) {
    throw new RangeError(
      "bunium: emulated deviceScaleFactor must be between 0.25 and 8",
    );
  }
  if (descriptor.touch) {
    if (
      Object.keys(descriptor.touch).some(
        (key) => key !== "enabled" && key !== "maxTouchPoints",
      )
    ) {
      throw new TypeError("bunium: touch descriptor has unknown fields");
    }
    const { enabled, maxTouchPoints } = descriptor.touch;
    if (
      typeof enabled !== "boolean" ||
      !Number.isSafeInteger(maxTouchPoints) ||
      maxTouchPoints < 0 ||
      maxTouchPoints > 16 ||
      (enabled && maxTouchPoints < 1) ||
      (!enabled && maxTouchPoints !== 0)
    ) {
      throw new RangeError(
        "bunium: touch maxTouchPoints must be 1–16 when enabled and 0 when disabled",
      );
    }
  }
  if (descriptor.pointer) {
    if (
      Object.keys(descriptor.pointer).some(
        (key) => !["primary", "any", "hover", "anyHover"].includes(key),
      )
    ) {
      throw new TypeError("bunium: pointer descriptor has unknown fields");
    }
    const { primary, any, hover, anyHover } = descriptor.pointer;
    const values = ["none", "coarse", "fine"];
    if (
      !values.includes(primary) ||
      !values.includes(any) ||
      typeof hover !== "boolean" ||
      typeof anyHover !== "boolean"
    ) {
      throw new TypeError("bunium: invalid pointer or hover media feature");
    }
    if (primary !== "none" && any === "none") {
      throw new RangeError(
        "bunium: any pointer must include the primary pointer",
      );
    }
    if (hover && !anyHover) {
      throw new RangeError("bunium: hover requires anyHover");
    }
  }
  return descriptor;
}

/** Two compact bitfields keep the flat native ABI below Bun's 8-argument limit. */
export function encodeInputEmulation(descriptor: DeviceEmulationDescriptor): {
  touch: number;
  pointer: number;
} {
  const touch = descriptor.touch?.enabled
    ? 1 | (descriptor.touch.maxTouchPoints << 1)
    : 0;
  const code = (value: "none" | "coarse" | "fine") =>
    ({ none: 0, coarse: 1, fine: 2 })[value];
  const p = descriptor.pointer;
  const pointer = p
    ? code(p.primary) |
      (code(p.any) << 2) |
      (Number(p.hover) << 4) |
      (Number(p.anyHover) << 5) |
      (1 << 6)
    : 0;
  return { touch, pointer };
}
