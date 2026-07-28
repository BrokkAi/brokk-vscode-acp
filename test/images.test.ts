import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  normalizePromptImages,
} from "../src/images";

function encoded(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

describe("prompt images", () => {
  it("normalizes supported image formats, safe names, and defaults", () => {
    expect(normalizePromptImages(undefined)).toEqual([]);
    expect(
      normalizePromptImages([
        {
          data: encoded([137, 80, 78, 71, 13, 10, 26, 10]),
          mimeType: " IMAGE/PNG ",
          name: "../screen\u0000.png",
        },
        {
          data: encoded([0xff, 0xd8, 0xff]),
          mimeType: "image/jpeg",
        },
        {
          data: Buffer.from("GIF87a").toString("base64"),
          mimeType: "image/gif",
          name: "",
        },
        {
          data: Buffer.from("RIFFsizeWEBP").toString("base64"),
          mimeType: "image/webp",
          name: `${"x".repeat(130)}.webp`,
        },
      ]),
    ).toEqual([
      {
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        name: "screen.png",
      },
      {
        data: "/9j/",
        mimeType: "image/jpeg",
        name: "image-2.jpg",
      },
      {
        data: "R0lGODdh",
        mimeType: "image/gif",
        name: "image-3.gif",
      },
      {
        data: "UklGRnNpemVXRUJQ",
        mimeType: "image/webp",
        name: "x".repeat(120),
      },
    ]);
  });

  it("rejects invalid collection shapes, formats, encodings, and signatures", () => {
    expect(() => normalizePromptImages({})).toThrow("must be a list");
    expect(() => normalizePromptImages(Array(MAX_PROMPT_IMAGES + 1).fill({}))).toThrow(
      "at most",
    );
    expect(() => normalizePromptImages([null])).toThrow("Image 1 is invalid");
    expect(() =>
      normalizePromptImages([{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }]),
    ).toThrow("must be PNG");
    expect(() =>
      normalizePromptImages([{ mimeType: "image/png" }]),
    ).toThrow("has no encoded data");
    for (const data of ["", "not base64", "AAA", "AB=="]) {
      expect(() => normalizePromptImages([{ mimeType: "image/png", data }])).toThrow(
        "valid base64",
      );
    }
    expect(() =>
      normalizePromptImages([
        {
          mimeType: "image/png",
          data: Buffer.from("not a png").toString("base64"),
        },
      ]),
    ).toThrow("declared format");
  });

  it("enforces per-image and aggregate byte limits", () => {
    const oversized = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
    expect(() =>
      normalizePromptImages([
        {
          mimeType: "image/png",
          data: oversized.toString("base64"),
          name: "large.png",
        },
      ]),
    ).toThrow("10 MB");

    const full = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(full);
    expect(() =>
      normalizePromptImages([
        { mimeType: "image/png", data: full.toString("base64") },
        { mimeType: "image/png", data: full.toString("base64") },
        { mimeType: "image/png", data: "iVBORw0KGgo=" },
      ]),
    ).toThrow("20 MB");
  });
});
