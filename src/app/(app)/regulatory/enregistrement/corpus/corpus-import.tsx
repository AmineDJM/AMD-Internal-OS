"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Upload, Loader2, CheckCircle2, XCircle, MinusCircle, FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { importCorpusFileAction } from "@/lib/regulatory/intelligence/corpus/actions";
// Module PUR : aucune dépendance à Prisma ni à l'extraction — sinon la compilation de
// production échouerait sur « Can't resolve 'fs' » (cf. import-formats.ts).
import { CORPUS_IMPORT_EXTS, type FileIngestStatus } from "@/lib/regulatory/intelligence/corpus/import-formats";

/**
 * IMPORT EN MASSE DE TEXTES RÉGLEMENTAIRES.
 *
 * Trois décisions portent tout l'écran :
 *
 * 1. **Un fichier par requête, deux à la fois.** Tout envoyer d'un coup mettrait cinquante
 *    documents en mémoire au même instant, sur le serveur comme dans le navigateur, pour une
 *    requête de plusieurs centaines de mégaoctets — et un seul fichier fautif ferait échouer les
 *    quarante-neuf autres. Une file à concurrence bornée garde la mémoire constante quel que
 *    soit le nombre de fichiers, et deux en vol suffisent à saturer le temps de traitement sans
 *    étouffer le serveur (l'extraction PDF est du calcul, pas de l'attente).
 *
 * 2. **Chaque fichier a son verdict, visible.** Un import qui annonce « 47 réussis » sans dire
 *    lesquels ont échoué est inexploitable : on ne sait pas quoi recommencer. Ici chaque ligne
 *    porte son issue et, en cas d'échec, son MOTIF — c'est ce qui dit quoi corriger.
 *
 * 3. **Déposer SUFFIT.** L'import démarre tout seul dès la sélection (pas de second bouton à
 *    trouver), et chaque texte importé est ACTIF immédiatement : l'écran est réservé au Super
 *    Admin, son geste vaut décision. Le seul bouton restant sert à réessayer les échecs.
 */

type Row = {
  id: string;
  file: File;
  state: "pending" | "running" | FileIngestStatus;
  message?: string;
  sections?: number;
  /** Un scan reconnu par OCR ne se lit pas comme un texte natif : l'écran le DIT (§118.63). */
  ocr?: { confiance?: number; aRelire?: boolean };
};

const ACCEPT = CORPUS_IMPORT_EXTS.map((e) => `.${e}`).join(",");
/** Deux extractions en vol : au-delà, on se dispute le processeur sans rien gagner. */
const CONCURRENCY = 2;

const AUTHORITIES = ["ANPP", "ICH", "EMA", "WHO", "EDQM", "FDA", "INTERNE"] as const;

/** Le corpus dépasse la pharma : chaque texte se range dans une catégorie de connaissance. */
const CATEGORIES = [
  "Enregistrement", "ANPP", "MIPH", "Droit du travail", "Droit fiscal", "Droit des sociétés",
  "Marchés publics / PCH", "Douanes & importation", "Pharmacovigilance", "Interne",
] as const;

export function CorpusImport() {
  const { rafraichir } = useRafraichir();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [authority, setAuthority] = React.useState<string>("ANPP");
  const [jurisdiction, setJurisdiction] = React.useState("DZ");
  const [category, setCategory] = React.useState<string>("Enregistrement");
  const [language, setLanguage] = React.useState<string>("fr");
  const [running, setRunning] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Le compteur de progression vit dans une ref : le relire depuis l'état donnerait la valeur
  // figée à la création de la boucle (piège classique des fermetures sur un état React).
  const cancelled = React.useRef(false);

  // Traite UNE liste de lignes (file à curseur partagé, concurrence bornée). Reçoit les lignes
  // en paramètre plutôt que de relire l'état : appelable immédiatement après la sélection.
  const runQueue = async (queue: Row[]) => {
    if (running || queue.length === 0) return;
    setRunning(true);
    cancelled.current = false;
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length && !cancelled.current) {
        const row = queue[cursor++];
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, state: "running", message: undefined } : r)));
        try {
          const fd = new FormData();
          fd.set("file", row.file);
          fd.set("authority", authority);
          fd.set("jurisdiction", jurisdiction);
          fd.set("category", category);
          fd.set("language", language);
          const res = await importCorpusFileAction(fd);
          setRows((prev) => prev.map((r) => (r.id === row.id
            ? {
              ...r, state: res.status, message: res.error, sections: res.sections,
              ...(res.methode === "ocr" ? { ocr: { confiance: res.confiance, aRelire: res.aRelire } } : {}),
            }
            : r)));
        } catch {
          // Un échec réseau reste un échec DE CE FICHIER : la file continue.
          setRows((prev) => prev.map((r) => (r.id === row.id
            ? { ...r, state: "FAILED" as const, message: "Envoi interrompu — réessayez ce fichier." }
            : r)));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setRunning(false);
    rafraichir(); // la liste « Textes utilisés » reflète l'import
  };

  // DÉPOSER SUFFIT : l'import démarre dès la sélection — pas de second bouton à trouver.
  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.size > 0);
    if (list.length === 0) return;
    // Un même fichier glissé deux fois ne crée pas deux lignes : le nom ET la taille.
    const seen = new Set(rows.map((r) => `${r.file.name}|${r.file.size}`));
    const next = list
      .filter((f) => !seen.has(`${f.name}|${f.size}`))
      .map((f) => ({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, file: f, state: "pending" as const }));
    if (next.length === 0) return;
    setRows((prev) => [...prev, ...next]);
    if (!running) void runQueue(next);
  };

  // Le bouton ne sert plus qu'aux reprises : échecs à réessayer, ou fichiers ajoutés pendant
  // qu'un import tournait déjà.
  const start = () => {
    void runQueue(rows.filter((r) => r.state === "pending" || r.state === "FAILED"));
  };

  const counts = React.useMemo(() => ({
    pending: rows.filter((r) => r.state === "pending").length,
    ok: rows.filter((r) => r.state === "INGESTED").length,
    dup: rows.filter((r) => r.state === "UNCHANGED").length,
    ko: rows.filter((r) => r.state === "FAILED").length,
  }), [rows]);

  const done = counts.ok + counts.dup + counts.ko;

  return (
    <section className="surface space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Importer des textes</h2>
          <p className="text-xs text-muted-foreground">
            PDF, Word, texte, HTML, tableur. Déposez-en autant que vous voulez — ils sont traités un par un
            et <strong>utilisés immédiatement par toutes les analyses</strong>.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={running}>
          <Upload className="h-4 w-4" /> Choisir des fichiers
        </Button>
      </div>

      <input
        ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden"
        onChange={(e) => { addFiles(e.target.files ?? []); e.target.value = ""; }}
      />

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-6 text-center text-sm transition ${dragOver ? "border-primary bg-primary/5" : "border-border text-muted-foreground"}`}
      >
        <Upload className="h-5 w-5" />
        <p>Glissez vos documents ici</p>
        <p className="text-xs">Formats : {CORPUS_IMPORT_EXTS.join(", ")}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Autorité émettrice</Label>
          <Select value={authority} onChange={(e) => setAuthority(e.target.value)} disabled={running}>
            {AUTHORITIES.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
          <p className="text-[0.6875rem] text-muted-foreground">Sert à filtrer les citations dans l&apos;analyse.</p>
        </div>
        <div className="space-y-1">
          <Label>Juridiction</Label>
          <Input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} disabled={running} placeholder="DZ, EU, INT…" />
          <p className="text-[0.6875rem] text-muted-foreground">DZ pour l&apos;Algérie, EU pour l&apos;Union européenne, INT pour l&apos;ICH/OMS.</p>
        </div>
        <div className="space-y-1">
          <Label>Catégorie de connaissance</Label>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} disabled={running}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <p className="text-[0.6875rem] text-muted-foreground">Le corpus dépasse la pharma : droit du travail, fiscal, marchés… Sert au filtrage des recherches.</p>
        </div>
        <div className="space-y-1">
          <Label>Langue du texte</Label>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={running}>
            <option value="fr">Français</option>
            <option value="ar">العربية (arabe)</option>
            <option value="en">Anglais</option>
          </Select>
          <p className="text-[0.6875rem] text-muted-foreground">Les articles « المادة 12 » des textes arabes sont découpés comme les « Article 12 » français.</p>
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" /> Import en cours — {done}/{rows.length}
                </span>
                <Button size="sm" variant="outline" onClick={() => { cancelled.current = true; }}>
                  Arrêter après le fichier en cours
                </Button>
              </>
            ) : (
              <>
                {counts.pending + counts.ko > 0 && (
                  <Button size="sm" onClick={start}>
                    <Upload className="h-4 w-4" /> Réessayer {counts.pending + counts.ko} document(s)
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setRows([])}>
                  <Trash2 className="h-4 w-4" /> Vider la liste
                </Button>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {counts.ok} actif(s) · {counts.dup} déjà présent(s) · {counts.ko} en échec
            </span>
          </div>

          {/* Chaque fichier porte son issue : un import qui dit « 47 réussis » sans dire
              lesquels ont échoué ne permet pas de savoir quoi recommencer. */}
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <StateIcon state={r.state} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {Math.max(1, Math.round(r.file.size / 1024))} Ko
                    {r.state === "INGESTED" && ` · ${r.sections ?? 0} section(s) · ACTIF — utilisé par les analyses`}
                    {r.ocr && ` · texte OCÉRISÉ${typeof r.ocr.confiance === "number" ? ` (confiance ${r.ocr.confiance} %)` : ""}${r.ocr.aRelire ? " — des pages méritent une relecture" : ""}`}
                    {r.state === "UNCHANGED" && " · contenu identique à la version connue — rien créé"}
                    {r.message && ` · ${r.message}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
        Déposer suffit : chaque texte est <strong>actif dès l&apos;import</strong> et cité par toutes les analyses.
        Réimporter un document au contenu identique ne crée <strong>jamais de doublon</strong> ; une nouvelle
        version du même texte remplace l&apos;ancienne.
      </p>
    </section>
  );
}

function StateIcon({ state }: { state: Row["state"] }) {
  if (state === "running") return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
  if (state === "INGESTED") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
  if (state === "UNCHANGED") return <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
  if (state === "FAILED") return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  return <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}
