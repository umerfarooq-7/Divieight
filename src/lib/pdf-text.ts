/**
 * Browser-side PDF text extraction (pdf.js), used only to scan a report for
 * flag phrases. Scanned/image PDFs yield no text — the admin can paste it.
 */
let pdfModulePromise: Promise<any> | null = null;

async function loadPdfModule() {
  if (!pdfModulePromise) {
    pdfModulePromise = Promise.all([
      import("pdfjs-dist/build/pdf.mjs"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
  }
  return pdfModulePromise;
}

export async function extractPdfText(file: File, maxPages = 200): Promise<string> {
  if (file.type !== "application/pdf") return "";
  const pdfjs = await loadPdfModule();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it: { str?: string }) => it.str ?? "").join(" "));
  }
  return parts.join("\n");
}
