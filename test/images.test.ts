import { describe, expect, it } from "vitest";
import { normalizePromptImages } from "../src/images";

function encoded(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

describe("prompt images", () => {
  it("normalizes image MIME types, safe names, and defaults without a format allowlist", () => {
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
          data: Buffer.from("not format inspected").toString("base64"),
          mimeType: "image/heic",
          name: `${"x".repeat(130)}.heic`,
        },
        {
          data: Buffer.from("<svg/>").toString("base64"),
          mimeType: "image/svg+xml",
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
        data: "bm90IGZvcm1hdCBpbnNwZWN0ZWQ=",
        mimeType: "image/heic",
        name: "x".repeat(120),
      },
      {
        data: "PHN2Zy8+",
        mimeType: "image/svg+xml",
        name: "image-5.svg",
      },
    ]);
  });

  it("rejects invalid collection shapes, non-image MIME types, and encodings", () => {
    expect(() => normalizePromptImages({})).toThrow("must be a list");
    expect(() => normalizePromptImages([null])).toThrow("Image 1 is invalid");
    expect(() =>
      normalizePromptImages([{ mimeType: "application/pdf", data: "JVBERg==" }]),
    ).toThrow("image MIME type");
    expect(() =>
      normalizePromptImages([{ mimeType: "image/png" }]),
    ).toThrow("has no encoded data");
    for (const data of ["", "not base64", "AAA", "AB=="]) {
      expect(() => normalizePromptImages([{ mimeType: "image/png", data }])).toThrow(
        "valid base64",
      );
    }
  });

  it("does not impose attachment count or byte limits", () => {
    const formerlyOversized = Buffer.alloc(20 * 1024 * 1024 + 1, 7).toString("base64");
    const images = Array.from({ length: 12 }, (_, index) => ({
      mimeType: index === 0 ? "image/heic" : "image/x-custom",
      data: index === 0 ? formerlyOversized : encoded([index]),
    }));

    const normalized = normalizePromptImages(images);
    expect(normalized).toHaveLength(12);
    expect(normalized[0]).toMatchObject({
      data: formerlyOversized,
      mimeType: "image/heic",
      name: "image-1.heic",
    });
  });
});
