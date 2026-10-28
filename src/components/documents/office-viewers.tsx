"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { SANDBOX_APERCU, documentApercuIsole } from "./apercu-isole";

/** Récupère les octets déchiffrés du fichier (route /raw, inline). */
function useRawBuffer(src: string) {
  const [buf, setBuf] = React.useState<ArrayBuffer | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((b) => { if (alive) setBuf(b); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [src]);
  return { buf, err };
}

function Loading() {
  return <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement de l'aperçu…</div>;
}

function Fallback({ src, message }: { src: string; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-5 text-center sm:p-10">
      <p className="text-sm text-muted-foreground">{message}</p>
      <a href={`${src}?dl=1`} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
        <Download className="h-4 w-4" /> Télécharger
      </a>
    </div>
  );
}

/**
 * LE CADRE ISOLÉ (audit 27/10, SA-12) — le HTML converti d'un fichier déposé par un autre ne touche jamais la page :
 * il s'affiche dans un `<iframe sandbox>` sans script ni origine partagée (`apercu-isole.ts`). Le tableau d'une
 * feuille Excel défile DANS ce cadre, jamais la page.
 */
function CadreIsole({ html, titre, tableur = false }: { html: string; titre: string; tableur?: boolean }) {
  return (
    <iframe
      title={titre}
      sandbox={SANDBOX_APERCU}
      srcDoc={documentApercuIsole(html, { tableur })}
      className="h-[78dvh] w-full rounded-lg border border-border bg-white"
    />
  );
}

/** Word (.docx) → HTML via mammoth (chargé à la demande). */
export function DocxView({ src, name }: { src: string; name: string }) {
  const { buf, err } = useRawBuffer(src);
  const [html, setHtml] = React.useState<string | null>(null);
  const [perr, setPerr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!buf) return;
    let alive = true;
    import("mammoth")
      .then((m) => m.convertToHtml({ arrayBuffer: buf }))
      .then((res) => { if (alive) setHtml(res.value || "<p><em>Document vide.</em></p>"); })
      .catch((e) => { if (alive) setPerr(String(e)); });
    return () => { alive = false; };
  }, [buf]);

  if (err || perr) return <Fallback src={src} message="Aperçu Word indisponible pour ce fichier." />;
  if (!html) return <Loading />;
  return <CadreIsole html={html} titre={`Aperçu de ${name}`} />;
}

/** Excel (.xlsx/.xls/.csv) → tableaux HTML via SheetJS (chargé à la demande). */
export function XlsxView({ src, name }: { src: string; name: string }) {
  const { buf, err } = useRawBuffer(src);
  const [sheets, setSheets] = React.useState<{ name: string; html: string }[] | null>(null);
  const [perr, setPerr] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);

  React.useEffect(() => {
    if (!buf) return;
    let alive = true;
    import("xlsx")
      .then((XLSX) => {
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        return wb.SheetNames.map((name) => ({ name, html: XLSX.utils.sheet_to_html(wb.Sheets[name]) }));
      })
      .then((s) => { if (alive) setSheets(s.length ? s : [{ name: "Feuille", html: "<p>Vide</p>" }]); })
      .catch((e) => { if (alive) setPerr(String(e)); });
    return () => { alive = false; };
  }, [buf]);

  if (err || perr) return <Fallback src={src} message="Aperçu Excel indisponible pour ce fichier." />;
  if (!sheets) return <Loading />;
  return (
    <div className="space-y-2">
      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {sheets.map((s, i) => (
            <button key={s.name} onClick={() => setActive(i)} className={`rounded-md px-2.5 py-2 text-xs font-medium sm:py-1 ${i === active ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-secondary/80"}`}>{s.name}</button>
          ))}
        </div>
      )}
      <CadreIsole html={sheets[active].html} titre={`Aperçu de ${name} — ${sheets[active].name}`} tableur />
    </div>
  );
}

/** PowerPoint (.pptx) → texte des diapositives extrait via JSZip (chargé à la demande). */
export function PptxView({ src }: { src: string; name: string }) {
  const { buf, err } = useRawBuffer(src);
  const [slides, setSlides] = React.useState<string[][] | null>(null);
  const [perr, setPerr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!buf) return;
    let alive = true;
    import("jszip")
      .then((mod) => mod.default.loadAsync(buf))
      .then(async (zip) => {
        const names = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => (parseInt(a.match(/(\d+)/)![1]) - parseInt(b.match(/(\d+)/)![1])));
        const parser = new DOMParser();
        const out: string[][] = [];
        for (const n of names) {
          const xml = await zip.files[n].async("string");
          const doc = parser.parseFromString(xml, "application/xml");
          const texts = Array.from(doc.getElementsByTagName("a:t")).map((t) => t.textContent ?? "").filter((t) => t.trim());
          out.push(texts);
        }
        return out;
      })
      .then((s) => { if (alive) setSlides(s); })
      .catch((e) => { if (alive) setPerr(String(e)); });
    return () => { alive = false; };
  }, [buf]);

  if (err || perr) return <Fallback src={src} message="Aperçu PowerPoint indisponible pour ce fichier." />;
  if (!slides) return <Loading />;
  if (slides.length === 0) return <Fallback src={src} message="Aucune diapositive détectée." />;
  return (
    <div className="max-h-[78dvh] space-y-3 overflow-auto">
      <p className="text-xs text-muted-foreground">Aperçu texte des {slides.length} diapositive{slides.length > 1 ? "s" : ""}. Téléchargez le fichier pour la mise en page complète.</p>
      {slides.map((texts, i) => (
        <div key={i} className="rounded-lg border border-border bg-white p-3 text-neutral-900 [overflow-wrap:anywhere] sm:p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diapositive {i + 1}</p>
          {texts.length === 0 ? (
            <p className="text-sm text-muted-foreground">(Aucun texte)</p>
          ) : (
            <div className="space-y-1">
              {texts.map((t, j) => <p key={j} className={j === 0 ? "font-semibold" : "text-sm"}>{t}</p>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
