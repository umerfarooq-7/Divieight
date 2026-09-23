export type DataRoomDocumentType =
  | "inspection"
  | "appraisal"
  | "title_teaser"
  | "tax_projection"
  | "other";

export const DATA_ROOM_TYPES: DataRoomDocumentType[] = [
  "inspection",
  "appraisal",
  "title_teaser",
  "tax_projection",
  "other",
];

export const DATA_ROOM_TYPE_LABELS: Record<DataRoomDocumentType, string> = {
  inspection: "Inspection reports",
  appraisal: "Appraisal reports",
  title_teaser: "Title documents",
  tax_projection: "Tax & rental projections",
  other: "Other documents",
};

export const DATA_ROOM_TYPE_HINTS: Record<DataRoomDocumentType, string> = {
  inspection: "Home, roof, pest and structural inspection findings.",
  appraisal: "Independent appraisals of the property's value.",
  title_teaser: "Preliminary title report, deed and encumbrance summaries.",
  tax_projection: "Property tax estimates and rental income projections.",
  other: "HOA packets, warranties and anything else.",
};

export interface DataRoomDocument {
  id: string;
  property_id: string;
  document_name: string;
  document_type: DataRoomDocumentType;
  file_url: string;
  uploaded_at: string;
}

export function normalizeType(value: string): DataRoomDocumentType {
  return (DATA_ROOM_TYPES as string[]).includes(value)
    ? (value as DataRoomDocumentType)
    : "other";
}

export function groupByType(docs: DataRoomDocument[]) {
  return DATA_ROOM_TYPES.map((type) => ({
    type,
    docs: docs.filter((d) => normalizeType(d.document_type) === type),
  })).filter((g) => g.docs.length > 0);
}

export function formatUploadedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
