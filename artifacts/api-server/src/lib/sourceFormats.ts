const FORMATS = {
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  flac: ["audio/flac", "audio/x-flac"],
  mp3: ["audio/mpeg", "audio/mp3", "audio/x-mp3"],
  m4a: ["audio/mp4", "audio/x-m4a", "video/mp4"],
  aac: ["audio/aac", "audio/x-aac"],
  ogg: ["audio/ogg", "audio/vorbis", "application/ogg"],
  mp4: ["video/mp4", "audio/mp4", "application/mp4"],
  mov: ["video/quicktime"],
  webm: ["video/webm", "audio/webm"],
  mid: ["audio/midi", "audio/x-midi", "application/x-midi"],
  midi: ["audio/midi", "audio/x-midi", "application/x-midi"],
} as const;

const genericTypes = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
]);

export function validateSourceFileMetadata(
  fileName: string,
  contentType: string,
): {
  valid: true;
  normalizedContentType: string;
  mediaKind: "audio" | "video" | "midi";
} | { valid: false } {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  const allowedTypes = FORMATS[extension as keyof typeof FORMATS];
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!allowedTypes || (!genericTypes.has(normalizedType) && !allowedTypes.includes(
    normalizedType as never,
  ))) {
    return { valid: false };
  }
  const normalizedContentType = genericTypes.has(normalizedType)
    ? allowedTypes[0]
    : normalizedType;
  const mediaKind = extension === "mid" || extension === "midi"
    ? "midi"
    : extension === "mp4" || extension === "mov" || extension === "webm" ||
        normalizedContentType.startsWith("video/")
      ? "video"
      : "audio";
  return { valid: true, normalizedContentType, mediaKind };
}