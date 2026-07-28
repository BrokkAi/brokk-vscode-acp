export const MAX_PROMPT_IMAGES = 4;
export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const PROMPT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export interface PromptImage {
  data: string;
  mimeType: (typeof PROMPT_IMAGE_MIME_TYPES)[number];
  name: string;
}

const MIME_TYPES = new Set<string>(PROMPT_IMAGE_MIME_TYPES);

export function normalizePromptImages(value: unknown): PromptImage[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Image attachments must be a list.");
  }
  if (value.length > MAX_PROMPT_IMAGES) {
    throw new Error(`Attach at most ${MAX_PROMPT_IMAGES} images to one prompt.`);
  }

  let totalBytes = 0;
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Image ${index + 1} is invalid.`);
    }
    const mimeType =
      typeof candidate.mimeType === "string"
        ? candidate.mimeType.trim().toLowerCase()
        : "";
    if (!MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Image ${index + 1} must be PNG, JPEG, GIF, or WebP.`,
      );
    }
    if (typeof candidate.data !== "string") {
      throw new Error(`Image ${index + 1} has no encoded data.`);
    }
    const data = candidate.data.trim();
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error(`Image ${index + 1} is not valid base64.`);
    }
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data) {
      throw new Error(`Image ${index + 1} is not valid base64.`);
    }
    if (decoded.byteLength > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error(`Image ${index + 1} exceeds the 10 MB limit.`);
    }
    if (!hasExpectedSignature(mimeType, decoded)) {
      throw new Error(`Image ${index + 1} does not match its declared format.`);
    }
    totalBytes += decoded.byteLength;
    if (totalBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
      throw new Error("Image attachments exceed the 20 MB total limit.");
    }

    return {
      data,
      mimeType: mimeType as PromptImage["mimeType"],
      name: normalizeImageName(candidate.name, index, mimeType),
    };
  });
}

function normalizeImageName(value: unknown, index: number, mimeType: string): string {
  if (typeof value === "string") {
    const leaf = value
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (leaf) {
      return leaf.slice(0, 120);
    }
  }
  const extension =
    mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return `image-${index + 1}.${extension}`;
}

function hasExpectedSignature(mimeType: string, data: Buffer): boolean {
  switch (mimeType) {
    case "image/png":
      return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/gif":
      return data.subarray(0, 6).toString("ascii") === "GIF87a" ||
        data.subarray(0, 6).toString("ascii") === "GIF89a";
    case "image/webp":
      return data.subarray(0, 4).toString("ascii") === "RIFF" &&
        data.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
