import { describe, expect, it } from "vitest";
import {
  NO_NATIVE_CAPABILITIES,
  fitToCapabilities,
  offerableActions,
  parseNativeCapabilities,
  type NativeCapabilities,
} from "./native-capabilities";
import type { SystemNotification } from "./notifier-api";

const macos: NativeCapabilities = {
  actions: true,
  maxActions: 2,
  images: true,
  removal: true,
  grouping: true,
  sound: true,
  responses: true,
};

const banner: SystemNotification = {
  tag: "t",
  group: "g",
  title: "Title",
  body: "Body",
  imagePath: "/tmp/a.png",
  sound: "Ping",
  actions: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny", destructive: true },
    { id: "extra", label: "Extra" },
  ],
};

describe("parseNativeCapabilities", () => {
  it("treats a missing or malformed report as no capabilities", () => {
    expect(parseNativeCapabilities(null)).toEqual(NO_NATIVE_CAPABILITIES);
    expect(parseNativeCapabilities("x")).toEqual(NO_NATIVE_CAPABILITIES);
    expect(parseNativeCapabilities({})).toEqual(NO_NATIVE_CAPABILITIES);
  });

  it("reads the backend's camelCase report", () => {
    expect(parseNativeCapabilities({ ...macos })).toEqual(macos);
  });

  it("does not claim actions without a positive maxActions", () => {
    const caps = parseNativeCapabilities({ actions: true, maxActions: 0 });
    expect(caps.actions).toBe(false);
    expect(caps.maxActions).toBe(0);
  });
});

describe("offerableActions", () => {
  it("offers nothing on a show-only backend", () => {
    expect(offerableActions(NO_NATIVE_CAPABILITIES, banner.actions ?? [])).toEqual([]);
  });

  it("offers nothing when nothing would hear the choice", () => {
    expect(offerableActions({ ...macos, responses: false }, banner.actions ?? [])).toEqual([]);
  });

  it("caps at what the backend can show", () => {
    expect(offerableActions(macos, banner.actions ?? []).map((a) => a.id)).toEqual([
      "allow",
      "deny",
    ]);
  });
});

describe("fitToCapabilities", () => {
  it("degrades a banner to a plain one on the fallback", () => {
    const fitted = fitToCapabilities(NO_NATIVE_CAPABILITIES, banner);
    expect(fitted).toEqual({ tag: "t", group: "g", title: "Title", body: "Body", actions: [] });
  });

  it("keeps what the backend supports", () => {
    const fitted = fitToCapabilities(macos, banner);
    expect(fitted.imagePath).toBe("/tmp/a.png");
    expect(fitted.sound).toBe("Ping");
    expect(fitted.actions).toHaveLength(2);
  });
});
