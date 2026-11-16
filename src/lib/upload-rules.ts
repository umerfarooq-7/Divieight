/**
 * What a browser may upload, and how big. The same limits are enforced on the buckets themselves (storage-hardening.sql); this check gives a clear message first.
 * A file's declared type can be wrong, so the file name's extension must agree with it as well.
 */

export type UploadKind = "identity" | "selfie" | "document" | "receipt" | "compliance" | "media";

interface Rule {
  maxBytes: number;
  types: Record<string, string[]>; // mime type -> allowed extensions
  label: string;
}

const IMAGES: Record<string, string[]> = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] };
const MB = 1024 * 1024;

export const UPLOAD_RULES: Record<UploadKind, Rule> = {
  identity: { maxBytes: 10 * MB, types: { ...IMAGES, "application/pdf": ["pdf"] }, label: "a JPG, PNG, WebP or PDF up to 10 MB" },
  selfie: { maxBytes: 5 * MB, types: IMAGES, label: "a JPG, PNG or WebP up to 5 MB" },
  document: { maxBytes: 25 * MB, types: { ...IMAGES, "application/pdf": ["pdf"], "text/plain": ["txt"], "text/markdown": ["md"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"] }, label: "a PDF, Word document, image or text file up to 25 MB" },
  receipt: { maxBytes: 10 * MB, types: { ...IMAGES, "application/pdf": ["pdf"] }, label: "a PDF or image up to 10 MB" },
  compliance: { maxBytes: 10 * MB, types: { ...IMAGES, "application/pdf": ["pdf"] }, label: "a PDF or image up to 10 MB" },
  media: { maxBytes: 50 * MB, types: { ...IMAGES, "video/mp4": ["mp4"], "video/quicktime": ["mov"] }, label: "a JPG, PNG, WebP, MP4 or MOV up to 50 MB" },
};

/** What is wrong with a file (said plainly), or null when it may be uploaded. */
export function uploadProblem(file: { name: string; size: number; type: string }, kind: UploadKind): string | null {
  const rule = UPLOAD_RULES[kind];
  if (file.size <= 0) return "That file is empty.";
  if (file.size > rule.maxBytes) return `That file is too large. Use ${rule.label}.`;
  const allowed = rule.types[file.type.toLowerCase()];
  if (!allowed) return `That kind of file is not accepted. Use ${rule.label}.`;
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (!allowed.includes(ext)) return `The file's name does not match its type. Use ${rule.label}.`;
  return null;
}

/** A storage path that cannot climb out of its folder or carry odd characters: the person's own id, then a timestamp and a cleaned extension. */
export function safeUploadPath(userId: string, prefix: string, fileName: string, now: number = Date.now()): string {
  const ext = (fileName.includes(".") ? fileName.split(".").pop()! : "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${userId}/${cleanPrefix}-${now}.${ext}`;
}

/** How long a signed URL for a private file may live, at most. Short, because a URL cannot be taken back once it is shared. */
export const MAX_SIGNED_URL_SECONDS = 600;
