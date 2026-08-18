import path from "node:path";
import { open, realpath, stat } from "node:fs/promises";

const MAX_OUTPUT_IMAGES = 4;
const MAX_OUTPUT_IMAGE_BYTES = 25 * 1024 * 1024;
const LOCAL_IMAGE_LINK = /!?\[[^\]\n]*\]\(\s*<?(\/[^)\n>]+?\.(?:png|jpe?g|webp|gif))>?\s*\)/gi;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function linkedImagePaths(message) {
  if (typeof message !== "string" || !message) return [];
  return [...message.matchAll(LOCAL_IMAGE_LINK)].map((match) => match[1]);
}

async function detectedImageType(filePath) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return ".jpg";
    if (bytesRead >= 6 && (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")) return ".gif";
    if (bytesRead >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
    return null;
  } finally {
    await handle.close();
  }
}

function extensionMatches(filePath, detectedType) {
  const extension = path.extname(filePath).toLocaleLowerCase();
  return extension === detectedType || (detectedType === ".jpg" && extension === ".jpeg");
}

/**
 * Resolves Codex output images into Discord.js attachment descriptors.
 * Generated-image events may use /tmp; paths merely mentioned in prose must
 * stay inside the selected allow-listed workspace.
 */
export async function discordOutputImages({ generatedPaths = [], message = "", workspace }) {
  const candidates = [
    ...generatedPaths.map((filePath) => ({ filePath, generated: true })),
    ...linkedImagePaths(message).map((filePath) => ({ filePath, generated: false }))
  ];
  let workspaceRoot;
  let temporaryRoot;
  try {
    workspaceRoot = await realpath(workspace);
    temporaryRoot = await realpath("/tmp");
  } catch {
    return { files: [], skipped: candidates.length };
  }

  const files = [];
  const seen = new Set();
  let skipped = 0;
  for (const candidate of candidates) {
    if (files.length >= MAX_OUTPUT_IMAGES) {
      skipped += 1;
      continue;
    }
    if (typeof candidate.filePath !== "string" || !path.isAbsolute(candidate.filePath)) {
      skipped += 1;
      continue;
    }
    try {
      const resolved = await realpath(candidate.filePath);
      if (seen.has(resolved)) continue;
      const allowed = isWithin(workspaceRoot, resolved)
        || (candidate.generated && isWithin(temporaryRoot, resolved));
      if (!allowed) {
        skipped += 1;
        continue;
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_OUTPUT_IMAGE_BYTES) {
        skipped += 1;
        continue;
      }
      const detectedType = await detectedImageType(resolved);
      if (!detectedType || !extensionMatches(resolved, detectedType)) {
        skipped += 1;
        continue;
      }
      seen.add(resolved);
      files.push({ attachment: resolved, name: path.basename(resolved) });
    } catch {
      skipped += 1;
    }
  }
  return { files, skipped };
}
