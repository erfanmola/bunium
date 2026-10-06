import { describe, expect, test } from "bun:test";
import {
  deviceEmulationCapabilities,
  validateDeviceEmulation,
} from "./emulation";

describe("device emulation descriptor", () => {
  test("accepts bounded screen, raster, touch and pointer traits", () => {
    const descriptor = validateDeviceEmulation({
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: { enabled: true, maxTouchPoints: 5 },
      pointer: {
        primary: "coarse",
        any: "coarse",
        hover: false,
        anyHover: false,
      },
    });
    expect(descriptor.deviceScaleFactor).toBe(3);
    expect(descriptor.touch?.maxTouchPoints).toBe(5);
    expect(deviceEmulationCapabilities.touch).toBe("supported");
    expect(deviceEmulationCapabilities.pointer).toBe("supported");
  });

  test("rejects invalid dimensions, scale and touch values", () => {
    for (const descriptor of [
      { screen: { width: 0, height: 844 }, deviceScaleFactor: 2 },
      { screen: { width: 390.5, height: 844 }, deviceScaleFactor: 2 },
      { screen: { width: 390, height: 844 }, deviceScaleFactor: 0 },
      { screen: { width: 390, height: 844 }, deviceScaleFactor: 9 },
      {
        screen: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        touch: { enabled: true, maxTouchPoints: 0 },
      },
    ]) {
      expect(() => validateDeviceEmulation(descriptor)).toThrow(RangeError);
    }
  });

  test("rejects unknown fields and contradictory pointer traits", () => {
    expect(() =>
      validateDeviceEmulation({
        screen: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        pointer: "coarse",
      } as never),
    ).toThrow("unknown fields");
    expect(() =>
      validateDeviceEmulation({
        screen: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        pointer: {
          primary: "coarse",
          any: "none",
          hover: false,
          anyHover: false,
        },
      }),
    ).toThrow(RangeError);
  });
});
