import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export interface VisualDiffReport {
  below_threshold: boolean;
  candidate: string;
  changed_pixels: number;
  diff_image: string | null;
  diff_score: number;
  reference: string;
  threshold: number;
  total_pixels: number;
  viewport: string;
}

export class VisualDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualDiffError";
  }
}

export function computeVisualDiffSync(options: {
  candidatePath: string;
  diffOutput?: string | null;
  referencePath: string;
  reportOutput?: string | null;
  threshold: number;
}): VisualDiffReport {
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) {
    throw new VisualDiffError("--threshold must be between 0 and 1");
  }
  const reference = readPngRgba(options.referencePath);
  const candidate = readPngRgba(options.candidatePath);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new VisualDiffError(
      `visual diff screenshots must have matching dimensions: reference=${reference.width}x${reference.height} candidate=${candidate.width}x${candidate.height}`,
    );
  }
  const diffPixels: Pixel[] = [];
  let changedPixels = 0;
  for (let index = 0; index < reference.pixels.length; index += 1) {
    const referencePixel = reference.pixels[index];
    const candidatePixel = candidate.pixels[index];
    if (!referencePixel || !candidatePixel) {
      throw new VisualDiffError("visual diff pixel buffers are inconsistent");
    }
    if (pixelsEqual(referencePixel, candidatePixel)) {
      diffPixels.push([0, 0, 0, 0]);
    } else {
      changedPixels += 1;
      diffPixels.push([255, 0, 0, 255]);
    }
  }
  const totalPixels = reference.width * reference.height;
  const diffScore = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  if (options.diffOutput) {
    writePngRgba(options.diffOutput, reference.width, reference.height, diffPixels);
  }
  const report = {
    below_threshold: diffScore <= options.threshold,
    candidate: options.candidatePath,
    changed_pixels: changedPixels,
    diff_image: options.diffOutput ?? null,
    diff_score: diffScore,
    reference: options.referencePath,
    threshold: options.threshold,
    total_pixels: totalPixels,
    viewport: `${reference.width}x${reference.height}`,
  };
  if (options.reportOutput) {
    mkdirSync(dirname(options.reportOutput), { recursive: true });
    writeFileSync(options.reportOutput, `${JSON.stringify(sortJson(report), null, 2)}\n`);
  }
  return report;
}

export type Pixel = [number, number, number, number];

interface PngImage {
  height: number;
  pixels: Pixel[];
  width: number;
}

function readPngRgba(path: string): PngImage {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VisualDiffError(`unable to read visual diff PNG ${path}: ${message}`);
  }
  if (!data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new VisualDiffError(`unsupported image format for visual diff: ${path} is not a PNG`);
  }
  let offset = 8;
  let width: number | null = null;
  let height: number | null = null;
  let bitDepth: number | null = null;
  let colorType: number | null = null;
  const compressed: Buffer[] = [];
  while (offset < data.length) {
    if (offset + 8 > data.length) {
      throw new VisualDiffError(`invalid PNG: truncated chunk header in ${path}`);
    }
    const length = data.readUInt32BE(offset);
    const kind = data.subarray(offset + 4, offset + 8).toString("ascii");
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 4 > data.length) {
      throw new VisualDiffError(`invalid PNG: truncated ${kind} chunk in ${path}`);
    }
    const payload = data.subarray(payloadStart, payloadEnd);
    offset = payloadEnd + 4;
    if (kind === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bitDepth = payload.readUInt8(8);
      colorType = payload.readUInt8(9);
      const compression = payload.readUInt8(10);
      const filterMethod = payload.readUInt8(11);
      const interlace = payload.readUInt8(12);
      if (bitDepth !== 8 || !new Set([2, 6]).has(colorType) || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
        throw new VisualDiffError("visual diff supports non-interlaced 8-bit RGB/RGBA PNG screenshots");
      }
    } else if (kind === "IDAT") {
      compressed.push(payload);
    } else if (kind === "IEND") {
      break;
    }
  }
  if (width === null || height === null || bitDepth === null || colorType === null) {
    throw new VisualDiffError(`invalid PNG: missing IHDR in ${path}`);
  }
  if (width < 1 || height < 1) {
    throw new VisualDiffError(`invalid PNG dimensions in ${path}: width and height must be positive`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(compressed));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VisualDiffError(`invalid PNG compression in ${path}: ${message}`);
  }
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new VisualDiffError(`invalid PNG scanline length in ${path}`);
  }
  const rows: Buffer[] = [];
  let position = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw.readUInt8(position);
    position += 1;
    const scanline = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let index = 0; index < scanline.length; index += 1) {
      const left = index >= channels ? scanline[index - channels] ?? 0 : 0;
      const up = previous[index] ?? 0;
      const upperLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
      let reconstructed: number;
      if (filterType === 0) {
        reconstructed = scanline[index] ?? 0;
      } else if (filterType === 1) {
        reconstructed = (scanline[index] ?? 0) + left;
      } else if (filterType === 2) {
        reconstructed = (scanline[index] ?? 0) + up;
      } else if (filterType === 3) {
        reconstructed = (scanline[index] ?? 0) + Math.floor((left + up) / 2);
      } else if (filterType === 4) {
        reconstructed = (scanline[index] ?? 0) + paeth(left, up, upperLeft);
      } else {
        throw new VisualDiffError(`unsupported PNG filter type ${filterType} in ${path}`);
      }
      scanline[index] = reconstructed & 0xff;
    }
    previous = Buffer.from(scanline);
    rows.push(previous);
  }
  const pixels: Pixel[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.length; index += channels) {
      pixels.push([
        row[index] ?? 0,
        row[index + 1] ?? 0,
        row[index + 2] ?? 0,
        channels === 4 ? row[index + 3] ?? 0 : 255,
      ]);
    }
  }
  return { height, pixels, width };
}

export function writePngRgba(path: string, width: number, height: number, pixels: Pixel[]): void {
  const rawRows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const rowPixels = pixels.slice(y * width, y * width + width);
    rawRows.push(Buffer.concat([Buffer.from([0]), Buffer.concat(rowPixels.map((pixel) => Buffer.from(pixel)))]));
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
      pngChunk("IDAT", deflateSync(Buffer.concat(rawRows))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function pngChunk(kind: string, payload: Buffer): Buffer {
  const kindBuffer = Buffer.from(kind, "ascii");
  const checksum = crc32(Buffer.concat([kindBuffer, payload]));
  return Buffer.concat([uint32(payload.length), kindBuffer, payload, uint32(checksum)]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function pixelsEqual(left: Pixel, right: Pixel): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
