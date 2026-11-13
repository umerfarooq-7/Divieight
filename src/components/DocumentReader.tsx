import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, Minus, Plus, Search } from "lucide-react";
import {
  clampScale,
  countMatches,
  downloadFileName,
  fontPx,
  highlight,
  linkReferences,
  parseBlocks,
  reachedEnd,
  stepScale,
  tableOfContents,
  type CrossRefTargets,
} from "@/lib/document-reader";
import { renderTextPdf } from "@/lib/simple-pdf";

const SCALE_KEY = "divieight.reader-scale";

function storedScale(): number {
  try {
    return clampScale(window.localStorage.getItem(SCALE_KEY) ?? 100);
  } catch {
    return 100;
  }
}

/**
 * The one reader every document is shown in: Terms, the PRA review, each Pre-Signing Review, and the preview on the signing screen.
 * Scrollable region you can focus and scroll with the keyboard, a clickable table of contents, in-document search, adjustable text size (never under 14px),
 * a downloadable PDF, live links to other documents, and the document's full hash. It reports when the reader has reached the bottom.
 */
export function DocumentReader({
  title,
  version,
  effectiveDate,
  text,
  hash,
  hashLabel = "Document hash",
  crossRefs = { terms: true, pra: false },
  onReachedEnd,
  heightClass = "h-[60vh] min-h-[280px]",
  downloadNote,
}: {
  title: string;
  version: string;
  effectiveDate?: string;
  text: string;
  /** The hash of exactly this text, shown in full. On a signing screen this is the hash that is stored with the signature. */
  hash?: string | null;
  hashLabel?: string;
  crossRefs?: CrossRefTargets;
  onReachedEnd?: (reached: boolean) => void;
  heightClass?: string;
  downloadNote?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(100);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [ended, setEnded] = useState(false);

  useEffect(() => setScale(storedScale()), []);
  const rescale = (dir: 1 | -1) => {
    const next = stepScale(scale, dir);
    setScale(next);
    try {
      window.localStorage.setItem(SCALE_KEY, String(next));
    } catch {
      /* the size still applies for this visit */
    }
  };

  const blocks = useMemo(() => parseBlocks(text), [text]);
  const toc = useMemo(() => tableOfContents(blocks), [blocks]);
  const total = useMemo(() => countMatches(text, query), [text, query]);
  useEffect(() => setActive(0), [query]);

  // Report the bottom, including a document short enough to fit without scrolling.
  const check = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (reachedEnd(el)) setEnded(true);
  }, []);
  // Reaching the bottom is remembered for this text: enlarging the text afterwards does not take it back.
  useEffect(() => {
    setEnded(false);
    const t = window.setTimeout(check, 50);
    return () => window.clearTimeout(t);
  }, [text, check]);
  useEffect(() => {
    const t = window.setTimeout(check, 50);
    return () => window.clearTimeout(t);
  }, [scale, check]);
  useEffect(() => {
    onReachedEnd?.(ended);
  }, [ended, onReachedEnd]);

  const goTo = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    const box = scrollRef.current;
    if (el && box) {
      box.scrollTo({ top: el.offsetTop - box.offsetTop - 8, behavior: "smooth" });
      el.focus({ preventScroll: true });
    }
  };
  // A link such as /terms#section-11 opens at that section.
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    if (id) window.setTimeout(() => goTo(id), 80);
  }, [text]);

  const jump = (dir: 1 | -1) => {
    if (!total) return;
    const next = (active + dir + total) % total;
    setActive(next);
    const marks = scrollRef.current?.querySelectorAll<HTMLElement>("mark[data-hit]");
    const el = marks?.[next];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const download = () => {
    const header = `${title}\nVersion: ${version}${effectiveDate ? `\nEffective: ${effectiveDate}` : ""}${hash ? `\n${hashLabel}: ${hash}` : ""}\n\n`;
    const bytes = renderTextPdf(header + text, `${title} ${version}`);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFileName(title, version);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  let hitIndex = -1;
  const px = fontPx(scale);
  const btn = "inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

  return (
    <section aria-label={`${title}, version ${version}`} className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <div className="flex min-w-0 flex-1 items-center gap-2" role="search">
          <label className="sr-only" htmlFor={`find-${title}`}>
            Search this document
          </label>
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id={`find-${title}`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") jump(e.shiftKey ? -1 : 1);
              }}
              placeholder="Search this document"
              className="h-10 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>
          <span aria-live="polite" className="whitespace-nowrap text-sm text-muted-foreground">
            {query.trim().length < 2 ? "" : total ? `${active + 1} of ${total}` : "No matches"}
          </span>
          <button type="button" className={btn} onClick={() => jump(-1)} disabled={!total} aria-label="Previous match">
            <ChevronUp aria-hidden className="h-4 w-4" />
          </button>
          <button type="button" className={btn} onClick={() => jump(1)} disabled={!total} aria-label="Next match">
            <ChevronDown aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={btn} onClick={() => rescale(-1)} disabled={scale <= 100} aria-label="Smaller text">
            <Minus aria-hidden className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-sm text-muted-foreground" aria-live="polite">
            {scale}%
          </span>
          <button type="button" className={btn} onClick={() => rescale(1)} disabled={scale >= 200} aria-label="Larger text">
            <Plus aria-hidden className="h-4 w-4" />
          </button>
          <button type="button" className={btn} onClick={download}>
            <Download aria-hidden className="h-4 w-4" /> Download PDF
          </button>
        </div>
      </div>

      {toc.length > 1 ? (
        <details className="border-b border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Table of contents ({toc.length})</summary>
          <nav aria-label="Table of contents" className="mt-2">
            <ol className="grid gap-1 sm:grid-cols-2">
              {toc.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => goTo(t.id)} className="w-full rounded px-2 py-1.5 text-left text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                    {t.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </details>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={check}
        role="region"
        aria-label={`${title} text. Scroll with the arrow keys or Page Down.`}
        tabIndex={0}
        style={{ fontSize: `${px}px` }}
        className={`${heightClass} overflow-y-auto px-4 py-4 leading-relaxed text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:px-6`}
      >
        {blocks.map((b, i) => {
          if (b.kind === "blank") return <div key={i} aria-hidden style={{ height: "0.6em" }} />;
          const segs = linkReferences(highlight(b.text, query), crossRefs);
          const content = segs.map((s, j) => {
            if (s.hit) {
              hitIndex += 1;
              const current = hitIndex === active;
              return (
                <mark key={j} data-hit className={current ? "rounded bg-accent px-0.5 text-accent-foreground ring-2 ring-ring" : "rounded bg-yellow-200 px-0.5 text-black"}>
                  {s.text}
                </mark>
              );
            }
            if (s.href) {
              return (
                <a key={j} href={s.href} title={s.title} className="font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                  {s.text}
                </a>
              );
            }
            return <span key={j}>{s.text}</span>;
          });
          return b.kind === "heading" ? (
            <h3 key={i} id={b.id} tabIndex={-1} className="mt-5 scroll-mt-3 font-display font-semibold text-foreground first:mt-0 focus:outline-none">
              {content}
            </h3>
          ) : (
            <p key={i} className="whitespace-pre-wrap font-serif">
              {content}
            </p>
          );
        })}
      </div>

      <div className="space-y-1 border-t border-border px-4 py-3 text-sm text-muted-foreground">
        <p aria-live="polite" className={ended ? "font-medium text-foreground" : ""}>
          {ended ? "✓ You have reached the end of the document." : "Scroll to the bottom of the document to continue."}
        </p>
        <p>
          {title} · version {version}
          {effectiveDate ? ` · effective ${effectiveDate}` : ""}
        </p>
        {hash ? (
          <p>
            {hashLabel}: <span className="break-all font-mono text-foreground">{hash}</span>
          </p>
        ) : null}
        {downloadNote ? <p>{downloadNote}</p> : null}
      </div>
    </section>
  );
}
