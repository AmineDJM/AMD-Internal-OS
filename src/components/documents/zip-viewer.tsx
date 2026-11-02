"use client";

import * as React from "react";
import { Download, FileArchive, File as FileIcon, Folder, Loader2, AlertCircle, Search, Eye, ChevronRight, House, Maximize2, Minimize2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { natureApercu } from "@/lib/formats/apercu";
import { sansBloquer } from "@/lib/journal";

/**
 * VISIONNEUSE D'ARCHIVE ZIP — dans le Drive, on ouvre un .zip et on le PARCOURT comme un vrai
 * dossier (à la Filez / explorateur de fichiers) : dossier par dossier, fil d'Ariane, double-clic
 * pour entrer, aperçu inline du fichier choisi (image, PDF, texte, vidéo, audio) ou téléchargement.
 * Une recherche balaie toute l'archive. L'archive reste entière ; le serveur extrait UNE entrée à
 * la demande (voir /api/drive/[id]/zip). Rien n'est décompressé sur le disque ; une GROSSE entrée compressée est
 * extraite une fois dans le bucket, qui la sert par plages (lib/storage/zip-apercu).
 */

interface ZipEntry { path: string; size: number | null }
interface ZipList { ok: boolean; name?: string; count?: number; truncated?: boolean; entries?: ZipEntry[]; error?: string }

/**
 * Au-delà, l'aperçu se PRÉPARE : le serveur extrait l'entrée UNE fois dans le bucket, qui la sert ensuite par plages
 * (la première page d'un PDF de 488 Mo s'affiche aussitôt). Même seuil que `SEUIL_CACHE_APERCU` (zip-apercu-regles.ts,
 * non importable ici : il tire `crypto`). En deçà — ou sans bucket — le serveur répond « prêt » tout de suite.
 */
const SEUIL_PREPARATION = 8 * 1024 * 1024;
/** Le survol prépare la suite sans attendre le clic — borné : un balayage de la liste ne lance pas dix extractions. */
const MAX_PRECHAUFFAGES_SURVOL = 3;
const DELAI_SURVOL_MS = 300;
/** Sous ce délai, l'attente se résume à un indicateur discret ; au-delà, un mot (et la progression si on la connaît). */
const DELAI_TEXTE_MS = 1500;

const humanSize = (n: number | null) => (n == null ? "" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : n >= 1024 ? `${Math.round(n / 1024)} Ko` : `${n} o`);

function previewKind(name: string): "image" | "pdf" | "text" | "video" | "audio" | "none" {
  // La table UNIQUE des aperçus (formats/apercu.ts) : plus de liste propre au visualiseur de ZIP.
  const n = natureApercu(name);
  if (n === "image" || n === "pdf" || n === "video" || n === "audio") return n;
  if (n === "texte" || n === "html") return "text";
  return "none";
}

/** Enfants immédiats (sous-dossiers + fichiers) d'un préfixe de chemin dans l'archive. */
function childrenOf(entries: ZipEntry[], prefix: string): { folders: { name: string; count: number }[]; files: ZipEntry[] } {
  const folderCounts = new Map<string, number>();
  const files: ZipEntry[] = [];
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest === "") continue; // l'entrée-dossier elle-même
    const segs = rest.split("/");
    if (segs.length === 1) {
      if (segs[0]) files.push(e); // fichier directement dans ce dossier
    } else {
      folderCounts.set(segs[0], (folderCounts.get(segs[0]) ?? 0) + 1);
    }
  }
  const folders = [...folderCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { folders, files };
}

/**
 * `id` = nœud Drive par défaut ; pour un DOCUMENT (checklist, dossiers…), on passe `zipUrl` (la route
 * qui liste et sert les entrées) et `downloadUrl` (l'archive entière). Un seul composant : deux
 * visionneuses finiraient par ne plus se comporter pareil.
 */
export function ZipViewer({ id, name, zipUrl, downloadUrl }: { id: string; name: string; zipUrl?: string; downloadUrl?: string }) {
  const base = zipUrl ?? `/api/drive/${id}/zip`;
  const archive = downloadUrl ?? `/api/drive/${id}/raw?dl=1`;
  const [list, setList] = React.useState<ZipList | null>(null);
  const [q, setQ] = React.useState("");
  const [path, setPath] = React.useState<string[]>([]); // dossier courant DANS l'archive
  const [sel, setSel] = React.useState<string | null>(null);
  // PLEIN ÉCRAN (Direction, 06/10) : l'aperçu prend tout l'écran — le panneau lui-même, par l'API du navigateur.
  const apercuRef = React.useRef<HTMLDivElement>(null);
  const [plein, setPlein] = React.useState(false);
  React.useEffect(() => {
    const suivre = () => setPlein(document.fullscreenElement === apercuRef.current && apercuRef.current !== null);
    document.addEventListener("fullscreenchange", suivre);
    return () => document.removeEventListener("fullscreenchange", suivre);
  }, []);
  const basculerPlein = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(sansBloquer("zip-viewer.basculerPlein.exitFullscreen"));
    else void apercuRef.current?.requestFullscreen?.().catch(sansBloquer("zip-viewer.basculerPlein.requestFullscreen"));
  };

  React.useEffect(() => {
    let alive = true;
    fetch(base, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: ZipList) => { if (alive) setList(d); })
      .catch(() => { if (alive) setList({ ok: false, error: "Lecture de l'archive impossible." }); });
    return () => { alive = false; };
  }, [base]);

  // ── APERÇU SANS ATTENTE PERÇUE (Direction, 06/10 : « je ne veux pas ce ressenti d'expérience ») ──
  // Une grosse entrée se prépare côté serveur (préchauffage au survol, puis à la sélection) ; l'aperçu ne se charge
  // qu'une fois prête, et un voile discret couvre le panneau jusqu'au premier rendu — sans message d'excuse.
  const [pretPour, setPretPour] = React.useState<string | null>(null);
  const [progres, setProgres] = React.useState<{ octets: number; total: number } | null>(null);
  const [rendu, setRendu] = React.useState(false);
  const [lent, setLent] = React.useState(false);
  const survol = React.useRef<{ minuteur?: ReturnType<typeof setTimeout>; faits: Set<string> }>({ faits: new Set() });
  const aPreparer = React.useCallback((p: string) => {
    const taille = list?.entries?.find((e) => e.path === p)?.size ?? 0;
    return previewKind(p) !== "none" && taille > SEUIL_PREPARATION;
  }, [list]);
  const urlPrechauffage = React.useCallback((p: string) => `${base}?path=${encodeURIComponent(p)}&prechauffer=1`, [base]);

  React.useEffect(() => {
    setRendu(false); setLent(false); setProgres(null); setPretPour(null);
    if (!sel) return;
    let vivant = true;
    const minuteur = setTimeout(() => { if (vivant) setLent(true); }, DELAI_TEXTE_MS);
    if (!aPreparer(sel)) setPretPour(sel);
    else {
      void (async () => {
        // 202 = extraction en cours (le serveur retient la réponse jusqu'à ~1 s) ; toute autre réponse = on charge.
        for (let i = 0; vivant && i < 3000; i++) {
          try {
            const r = await fetch(urlPrechauffage(sel), { cache: "no-store" });
            if (r.status !== 202) break;
            const d = (await r.json()) as { octets?: number; total?: number };
            if (vivant && d.total) setProgres({ octets: d.octets ?? 0, total: d.total });
          } catch { break; }
          await new Promise((ok) => setTimeout(ok, 400));
        }
        if (vivant) setPretPour(sel);
      })();
    }
    return () => { vivant = false; clearTimeout(minuteur); };
  }, [sel, aPreparer, urlPrechauffage]);

  const survolerEntree = (p: string) => {
    clearTimeout(survol.current.minuteur);
    const s = survol.current;
    if (p === sel || s.faits.has(p) || s.faits.size >= MAX_PRECHAUFFAGES_SURVOL || !aPreparer(p)) return;
    s.minuteur = setTimeout(() => {
      s.faits.add(p);
      void fetch(urlPrechauffage(p), { cache: "no-store" }).catch(sansBloquer("zip-viewer.survolerEntree.fetch"));
    }, DELAI_SURVOL_MS);
  };
  const quitterEntree = () => clearTimeout(survol.current.minuteur);

  if (!list) {
    return <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lecture de l'archive…</div>;
  }
  if (!list.ok) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-10 text-center">
        <AlertCircle className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{list.error ?? "Archive illisible."}</p>
        <a href={archive} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"><Download className="h-4 w-4" /> Télécharger l'archive</a>
      </div>
    );
  }

  const entries = list.entries ?? [];
  const term = q.trim().toLowerCase();
  const prefix = path.length ? path.join("/") + "/" : "";
  const { folders, files } = childrenOf(entries, prefix);
  // Recherche : liste plate de toutes les entrées correspondantes (on quitte la navigation).
  const searchResults = term ? entries.filter((e) => e.path.toLowerCase().includes(term) && !e.path.endsWith("/")) : [];
  const selUrl = sel ? `${base}?path=${encodeURIComponent(sel)}` : null;
  const kind = sel ? previewKind(sel) : "none";
  const tailleSel = sel ? entries.find((e) => e.path === sel)?.size ?? null : null;
  const openFile = (p: string) => setSel(p);
  const enterFolder = (folderName: string) => { setPath((p) => [...p, folderName]); setSel(null); };
  const goTo = (depth: number) => { setPath((p) => p.slice(0, depth)); setSel(null); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
        <FileArchive className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{list.count} fichier·s{list.truncated ? " (aperçu limité)" : ""}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Explorateur de l'archive (navigation dossier par dossier) */}
        <div className="rounded-lg border border-border">
          <div className="relative border-b border-border p-2">
            <Search className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher dans toute l'archive…" className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-2 text-base outline-none focus:border-primary sm:py-1.5 sm:text-sm" />
          </div>

          {/* Au téléphone, l'aperçu s'empile SOUS la liste : une liste moins haute le garde à portée de pouce. */}
          {term ? (
            // ── Résultats de recherche (plats) ──
            <ul className="max-h-[45dvh] divide-y divide-border overflow-y-auto lg:max-h-[62dvh]">
              {searchResults.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">Aucune entrée pour « {q} ».</li>
              ) : searchResults.map((e) => (
                <li key={e.path} onMouseEnter={() => survolerEntree(e.path)} onMouseLeave={quitterEntree} className={cn("flex items-center gap-2 px-3 py-1 text-sm sm:py-1.5", sel === e.path && "bg-accent/60")}>
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <button type="button" onClick={() => openFile(e.path)} className="min-w-0 flex-1 truncate py-2 text-left hover:text-primary sm:py-0" title={e.path}>{e.path}</button>
                  <span className="shrink-0 text-xs text-muted-foreground">{humanSize(e.size)}</span>
                  <a href={`${base}?path=${encodeURIComponent(e.path)}&dl=1`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-primary sm:h-auto sm:w-auto sm:p-1" title="Télécharger" aria-label="Télécharger"><Download className="h-3.5 w-3.5" /></a>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {/* Fil d'Ariane dans l'archive */}
              <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-1.5 text-xs">
                <button type="button" onClick={() => goTo(0)} className="inline-flex items-center gap-1 rounded px-1 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:py-0.5"><House className="h-3.5 w-3.5" /> Archive</button>
                {path.map((seg, i) => (
                  <span key={i} className="inline-flex items-center gap-0.5">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    <button type="button" onClick={() => goTo(i + 1)} className="max-w-[60vw] truncate rounded px-1 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:max-w-none sm:py-0.5" title={seg}>{seg}</button>
                  </span>
                ))}
              </div>
              <ul className="max-h-[45dvh] divide-y divide-border overflow-y-auto lg:max-h-[58vh]">
                {folders.length === 0 && files.length === 0 ? (
                  <li className="px-3 py-6 text-center text-sm text-muted-foreground">Dossier vide.</li>
                ) : (
                  <>
                    {folders.map((f) => (
                      <li key={`d:${f.name}`} className="flex items-center gap-2 px-3 py-1 text-sm sm:py-1.5">
                        <Folder className="h-4 w-4 shrink-0 text-primary" />
                        <button type="button" onDoubleClick={() => enterFolder(f.name)} onClick={() => enterFolder(f.name)} className="min-w-0 flex-1 truncate py-2 text-left font-medium hover:text-primary sm:py-0" title={f.name}>{f.name}</button>
                        <span className="shrink-0 text-xs text-muted-foreground">{f.count} élément·s</span>
                      </li>
                    ))}
                    {files.map((e) => {
                      const nom = e.path.split("/").pop() ?? e.path;
                      return (
                        <li key={e.path} onMouseEnter={() => survolerEntree(e.path)} onMouseLeave={quitterEntree} className={cn("flex items-center gap-2 px-3 py-1 text-sm sm:py-1.5", sel === e.path && "bg-accent/60")}>
                          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <button type="button" onClick={() => openFile(e.path)} className="min-w-0 flex-1 truncate py-2 text-left hover:text-primary sm:py-0" title={nom}>{nom}</button>
                          <span className="shrink-0 text-xs text-muted-foreground">{humanSize(e.size)}</span>
                          <a href={`${base}?path=${encodeURIComponent(e.path)}&dl=1`} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-primary sm:h-auto sm:w-auto sm:p-1" title="Télécharger" aria-label="Télécharger"><Download className="h-3.5 w-3.5" /></a>
                        </li>
                      );
                    })}
                  </>
                )}
              </ul>
            </>
          )}
        </div>

        {/* Aperçu de l'entrée sélectionnée */}
        <div ref={apercuRef} className={cn("flex flex-col gap-2 rounded-lg border border-border p-2", plein && "bg-background p-3")}>
          {sel && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium" title={sel}>{sel.split("/").pop()}{tailleSel != null ? ` · ${humanSize(tailleSel)}` : ""}</span>
              <a href={selUrl!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-2 hover:bg-muted sm:py-1"><ExternalLink className="h-3.5 w-3.5" /> Nouvel onglet</a>
              <a href={`${selUrl}&dl=1`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-2 hover:bg-muted sm:py-1"><Download className="h-3.5 w-3.5" /> Télécharger</a>
              <button type="button" onClick={basculerPlein} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-2 hover:bg-muted sm:py-1" aria-pressed={plein}>
                {plein ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />} {plein ? "Quitter le plein écran" : "Plein écran"}
              </button>
            </div>
          )}
          {!sel ? (
            <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Eye className="h-5 w-5" /> Sélectionnez un fichier pour l'afficher.
            </div>
          ) : kind !== "none" ? (
            // L'élément n'existe qu'une fois l'entrée prête ; le voile reste jusqu'à son premier rendu.
            <div className={cn("relative", !rendu && "min-h-[40vh]")}>
              {pretPour !== sel ? (
                <div className={cn("w-full rounded", kind === "pdf" || kind === "text" ? (plein ? "h-[calc(100dvh-5rem)]" : "h-[62dvh]") : "h-[40vh]")} />
              ) : kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={sel} src={selUrl!} alt={sel} onLoad={() => setRendu(true)} onError={() => setRendu(true)} className={cn("mx-auto rounded object-contain", plein ? "max-h-[calc(100dvh-5rem)]" : "max-h-[62dvh]")} />
              ) : kind === "pdf" || kind === "text" ? (
                <iframe key={sel} src={selUrl!} title={sel} onLoad={() => setRendu(true)} className={cn("w-full rounded border border-border bg-white", plein ? "h-[calc(100dvh-5rem)]" : "h-[62dvh]")} />
              ) : kind === "video" ? (
                <video key={sel} src={selUrl!} controls onLoadedMetadata={() => setRendu(true)} onError={() => setRendu(true)} className={cn("w-full rounded bg-black", plein ? "max-h-[calc(100dvh-5rem)]" : "max-h-[62dvh]")} />
              ) : (
                <div className="flex h-full min-h-[40vh] items-center justify-center p-4"><audio key={sel} src={selUrl!} controls onLoadedMetadata={() => setRendu(true)} onError={() => setRendu(true)} className="w-full" /></div>
              )}
              {!rendu && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded bg-background/85 text-xs text-muted-foreground" aria-live="polite" aria-busy="true">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  {lent && (
                    <>
                      <span>{progres && pretPour !== sel ? `Préparation de l'aperçu… ${Math.min(99, Math.floor((progres.octets / Math.max(progres.total, 1)) * 100))} %` : "Ouverture de l'aperçu…"}</span>
                      {progres && pretPour !== sel && (
                        <span className="h-1 w-40 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.min(100, (progres.octets / Math.max(progres.total, 1)) * 100)}%` }} />
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">Ce format s'affiche une fois sorti de l'archive : téléchargez-le, ou déposez l'archive décompressée dans le Drive pour le lire ici.</p>
              <a href={`${selUrl}&dl=1`} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"><Download className="h-4 w-4" /> Télécharger « {sel.split("/").pop()} »</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
