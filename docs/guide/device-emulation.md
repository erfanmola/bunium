# Device emulation

Untrusted guests accept an optional `emulation` descriptor. It sets the guest's
reported screen dimensions and Chromium raster scale independently of the
physical host display; guest bounds continue to define its CSS viewport.

```ts
const guest = win.createGuest({
  url: "https://example.test/",
  x: 0,
  y: 0,
  width: 360,
  height: 640,
  bridgeScript: "return function () {}",
  emulation: {
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  },
});
```

Touch and pointer traits can be set per guest. Touch enables Chromium touch
capability and sets the maximum touch-point count. Pointer values control the
`pointer`, `any-pointer`, `hover`, and `any-hover` media features:

```ts
emulation: {
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: { enabled: true, maxTouchPoints: 5 },
  pointer: { primary: "coarse", any: "coarse", hover: false, anyHover: false },
}
```

`deviceEmulationCapabilities` reports supported traits. These settings emulate
browser-visible capabilities; this fixture does not certify physical
touchscreen input or a specific device's touch behavior.

The descriptor bounds dimensions to 1–16384 CSS pixels and scale to 0.25–8.
`guest.renderedSize` exposes the latest physical paint dimensions for
qualification; it is zero until the first frame arrives.
