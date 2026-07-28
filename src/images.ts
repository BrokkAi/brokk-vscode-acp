export interface PromptImage {
  data: string;
  mimeType: string;
  name: string;
}

export function normalizePromptImages(value: unknown): PromptImage[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Image attachments must be a list.");
  }

  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Image ${index + 1} is invalid.`);
    }
    const mimeType =
      typeof candidate.mimeType === "string"
        ? candidate.mimeType.trim().toLowerCase()
        : "";
    if (!mimeType.startsWith("image/") || mimeType.length === "image/".length) {
      throw new Error(`Image ${index + 1} must have an image MIME type.`);
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

    return {
      data,
      mimeType,
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
  const extension = mimeType === "image/jpeg"
    ? "jpg"
    : mimeType
      .slice("image/".length)
      .split("+", 1)[0]
      .replace(/[^a-z0-9.-]/g, "") || "image";
  return `image-${index + 1}.${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
