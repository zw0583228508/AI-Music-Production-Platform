type SupportedSourceFormat = {
  extension: string;
  contentType: string;
  mimeTypes: readonly string[];
};

export const SUPPORTED_SOURCE_FORMATS: readonly SupportedSourceFormat[] = [
  {
    extension: "wav",
    contentType: "audio/wav",
    mimeTypes: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  },
  {
    extension: "flac",
    contentType: "audio/flac",
    mimeTypes: ["audio/flac", "audio/x-flac"],
  },
  {
    extension: "mp3",
    contentType: "audio/mpeg",
    mimeTypes: ["audio/mpeg", "audio/mp3", "audio/x-mp3"],
  },
  {
    extension: "m4a",
    contentType: "audio/mp4",
    mimeTypes: ["audio/mp4", "audio/x-m4a", "video/mp4"],
  },
  {
    extension: "aac",
    contentType: "audio/aac",
    mimeTypes: ["audio/aac", "audio/x-aac"],
  },
  {
    extension: "ogg",
    contentType: "audio/ogg",
    mimeTypes: ["audio/ogg", "audio/vorbis", "application/ogg"],
  },
  {
    extension: "mp4",
    contentType: "video/mp4",
    mimeTypes: ["video/mp4", "audio/mp4", "application/mp4"],
  },
  {
    extension: "mov",
    contentType: "video/quicktime",
    mimeTypes: ["video/quicktime"],
  },
  {
    extension: "webm",
    contentType: "video/webm",
    mimeTypes: ["video/webm", "audio/webm"],
  },
  {
    extension: "midi",
    contentType: "audio/midi",
    mimeTypes: ["audio/midi", "audio/x-midi", "application/x-midi"],
  },
  {
    extension: "mid",
    contentType: "audio/midi",
    mimeTypes: ["audio/midi", "audio/x-midi", "application/x-midi"],
  },
];

const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
]);

export const SUPPORTED_SOURCE_FILE_ACCEPT = SUPPORTED_SOURCE_FORMATS
  .map((format) => `.${format.extension}`)
  .join(",");

export const SUPPORTED_SOURCE_FORMAT_LABEL =
  "WAV, FLAC, MP3, M4A, AAC, OGG, MP4, MOV, WebM, or MIDI/MID";

type SourceFile = Pick<File, "name" | "type">;

type SourceFileValidation =
  | { valid: true; contentType: string }
  | { valid: false; message: string };

/**
 * Validates source files against the formats the import pipeline supports.
 * Browsers often omit MIME types (notably for MIDI), so a supported extension
 * is used only when the reported MIME type is absent or generic.
 */
export function validateSourceFile(file: SourceFile): SourceFileValidation {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const format = SUPPORTED_SOURCE_FORMATS.find(
    (candidate) => candidate.extension === extension,
  );

  if (!format) {
    return {
      valid: false,
      message: `“${file.name}” is not a supported source format. Choose ${SUPPORTED_SOURCE_FORMAT_LABEL}.`,
    };
  }

  const mimeType = file.type.trim().toLowerCase();
  if (!GENERIC_MIME_TYPES.has(mimeType) && !format.mimeTypes.includes(mimeType)) {
    return {
      valid: false,
      message: `“${file.name}” has unsupported file type “${file.type}”. Choose ${SUPPORTED_SOURCE_FORMAT_LABEL}.`,
    };
  }

  return { valid: true, contentType: format.contentType };
}