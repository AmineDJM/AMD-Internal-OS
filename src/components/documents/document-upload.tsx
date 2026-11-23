"use client";

import * as React from "react";
import { UploadCloud, CheckCircle2, FileUp, FolderUp, X } from "lucide-react";
import type { EntityType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { DOCUMENT_CATEGORY, CONFIDENTIALITY } from "@/lib/labels";
import { useBackgroundUpload } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { envoiDocument, construireEnvoi, lireDepot, FICHIER_PARASITE, type EntreeDepot } from "./envoi-document";
import { cn } from "@/lib/utils";

interface DocumentUploadProps {
  entityType: EntityType;
  entityId: string;
  categories?: string[]; // restreint les catégories proposées pour le module
  stepKey?: string; // rattache les documents à une étape (Regulatory)
  compact?: boolean; // version condensée (par étape)
  /** Les identifiants des `Document` créés, fichier par fichier, une fois chacun déposé. */
  onUploaded?: (ids: string[]) => void;
  /** Le dépôt vise la « CTD initiale » d'un dossier Regulatory (étape 1, catégorie « CTD complet ») — §118.213. */
  ctd?: boolean;
  /** Le dossier de la CTD où poser le lot (« Compléments ») ; absent = la racine. */
  dossierBase?: string | null;
  /**
   * Un geste qui DOIT réussir avant que le lot parte (remplacer la CTD : l'ancienne part d'abord à la
   * corbeille). `false` = rien n'est envoyé et la sélection reste intacte — la personne ne perd pas ses fichiers.
   */
  avantEnvoi?: () => Promise<boolean>;
  /** Le libellé du bouton d'envoi, quand « Téléverser » ne dit pas ce qui va se passer. */
  libelleEnvoi?: string;
  /** Si posé, le bouton d'envoi est un bouton décisif : un second clic confirme (« Remplacer la CTD »). */
  confirmationEnvoi?: string;
}

interface Item { id: string; file: File; path: string }

// Un dossier choisi par le sélecteur porte son chemin relatif dans `webkitRelativePath`.
type FichierAvecChemin = File & { webkitRelativePath?: string };

const humanSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(n / 1024))} Ko`);

let uid = 0;

/**
 * Téléversement de documents : un ou plusieurs **fichiers de tout type**, **un dossier entier** (avec
 * son arborescence — plus besoin de le compresser) ou **une archive ZIP**, **sans limite de nombre**,
 * jusqu'à 10 Go par fichier (envoi direct au bucket au-delà du seuil). L'envoi est
 * confié au **gestionnaire d'envois global** (arrière-plan) : dès qu'on clique « Téléverser », on
 * peut **changer de module et continuer à travailler** — les fichiers montent en parallèle et la
 * pastille flottante suit la progression partout. En contexte Regulatory, tout est en plus répliqué
 * dans le **dossier Drive du produit** (le ZIP y reste entier et navigable). File d'attente locale
 * seulement pour la sélection.
 */
export function DocumentUpload({ entityType, entityId, categories, stepKey, compact, onUploaded, ctd, dossierBase, avantEnvoi, libelleEnvoi, confirmationEnvoi }: DocumentUploadProps) {
  const { enqueue } = useBackgroundUpload();
  const filesRef = React.useRef<HTMLInputElement>(null);
  const dossierRef = React.useRef<HTMLInputElement>(null);
  const [items, setItems] = React.useState<Item[]>([]);
  const [dragOver, setDragOver] = React.useState(false);
  const [queued, setQueued] = React.useState(0); // dernier lot confié à l'arrière-plan

  const categoryEntries = categories
    ? categories.map((c) => [c, DOCUMENT_CATEGORY[c] ?? c] as const)
    : Object.entries(DOCUMENT_CATEGORY);
  const [category, setCategory] = React.useState(categoryEntries[0]?.[0] ?? "OTHER");
  const [confidentiality, setConfidentiality] = React.useState("INTERNAL");

  // LE REFUS AVANT L'ENVOI (audit du 04/10, constats 11 et 13) : un fichier vide, d'un type
  // interdit ou plus lourd que la limite est dit TOUT DE SUITE, à côté de son nom, avec la phrase
  // du serveur — pas après avoir envoyé 300 Mo pour lire « Body exceeded ». Sans limites lues
  // (serveur muet), on laisse passer : le serveur reste la garde.
  const limites = useLimitesEnvoi();
  const [refuses, setRefuses] = React.useState<{ id: string; path: string; raison: string }[]>([]);

  const refusDe = limites ? envoiDocument({ entityType, entityId, category, confidentiality, stepKey, ctd }, limites, () => null).refus : undefined;

  function addEntries(list: EntreeDepot[]) {
    if (list.length === 0) return;
    const next: Item[] = [];
    const ko: { id: string; path: string; raison: string }[] = [];
    for (const { file, path } of list) {
      if (FICHIER_PARASITE.test(file.name)) continue; // .DS_Store, Thumbs.db… posés par le système, jamais par la personne
      const raison = file.size === 0 ? "Fichier vide (0 octet)." : refusDe ? refusDe(file) : null;
      if (raison) ko.push({ id: `r${uid++}`, path, raison });
      else next.push({ id: `u${uid++}`, file, path });
    }
    setItems((cur) => [...cur, ...next]);
    setRefuses(ko);
    setQueued(0);
  }

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    addEntries(Array.from(list).map((file) => ({ file, path: (file as FichierAvecChemin).webkitRelativePath || file.name })));
  }

  // UNE SÉLECTION NON ENVOYÉE NE SE PERD PAS EN SILENCE (constat 10). L'envoi se fait en deux
  // gestes (choisir, puis « Téléverser ») ; quitter la page entre les deux perdait le choix sans
  // un mot. Le navigateur demande désormais confirmation tant qu'une sélection attend.
  React.useEffect(() => {
    if (items.length === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [items.length]);

  const removeItem = (id: string) => setItems((cur) => cur.filter((it) => it.id !== id));

  /** Confie le lot au gestionnaire global : l'envoi continue même si on quitte la page. */
  async function uploadAll() {
    if (items.length === 0) return;
    if (avantEnvoi && !(await avantEnvoi())) return;
    const cat = category, conf = confidentiality;
    // UNE construction pour tous les téléverseurs (`construireEnvoi`) : le dossier d'origine de chaque fichier
    // (« CTD/Module 1 ») et le dossier de DESTINATION choisi s'y joignent — l'arborescence se garde sur la fiche.
    enqueue(construireEnvoi({
      cible: { entityType, entityId, category: cat, confidentiality: conf, stepKey, ctd },
      entrees: items.map((it) => ({ file: it.file, path: it.path })),
      limites,
      dossierBase,
      onFileDone: onUploaded
        ? (_file, body) => {
            const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
            if (ids.length > 0) onUploaded(ids);
          }
        : undefined,
    }));
    setQueued(items.length);
    setItems([]);
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void lireDepot(e.dataTransfer).then(addEntries); }}
        className={cn(
          "rounded-xl border-2 border-dashed text-center transition-colors",
          compact ? "px-3 py-2.5" : "px-4 py-5",
          dragOver ? "border-primary bg-accent/50" : "border-border bg-muted/30",
        )}
      >
        <div className={cn("flex items-center justify-center gap-2", compact ? "" : "flex-col")}>
          <UploadCloud className={cn("text-muted-foreground", compact ? "h-4 w-4" : "h-6 w-6")} />
          {!compact && <span className="text-sm font-medium text-foreground">Glissez des fichiers, un dossier ou un ZIP ici, ou :</span>}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => filesRef.current?.click()}>
              <FileUp className="h-4 w-4" /> Choisir des fichiers ou un ZIP
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => dossierRef.current?.click()}>
              <FolderUp className="h-4 w-4" /> Choisir un dossier
            </Button>
          </div>
        </div>
        {!compact && <p className="mt-1.5 text-xs text-muted-foreground">Des <strong>fichiers de tout type</strong>, un <strong>dossier entier</strong> (arborescence conservée) ou une archive <strong>.ZIP</strong> · jusqu&apos;à 10 Go par fichier · envoi en arrière-plan</p>}
        <input ref={filesRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        {/* Sélecteur de DOSSIER : `webkitdirectory` (non standard mais pris en charge par tous les navigateurs courants). */}
        <input
          ref={dossierRef}
          type="file"
          multiple
          hidden
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {/* LE TYPE SE CHOISIT, MÊME EN COMPACT (Direction, 06/10) : un dépôt compact retombait toujours sur le premier
          type de la liste — un passeport et un justificatif finissaient sous la même étiquette, sans que la personne
          puisse choisir celui que l'écran lui demandait. */}
      {compact && categoryEntries.length > 1 && (
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 text-xs sm:h-8" aria-label="Type de document">
          {categoryEntries.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
      )}
      {!compact && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="text-sm">
            {categoryEntries.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
          <Select value={confidentiality} onChange={(e) => setConfidentiality(e.target.value)} className="text-sm">
            {Object.entries(CONFIDENTIALITY).map(([value, v]) => (
              <option key={value} value={value}>{v.label}</option>
            ))}
          </Select>
        </div>
      )}

      {items.length > 0 && (
        <ul className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
              <FileUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={it.path}>{it.path}</span>
              <span className="shrink-0 text-muted-foreground">{humanSize(it.file.size)}</span>
              <button type="button" onClick={() => removeItem(it.id)} className="shrink-0 rounded p-2 text-muted-foreground hover:text-destructive sm:p-0.5" aria-label="Retirer"><X className="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button>
            </li>
          ))}
        </ul>
      )}

      {refuses.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-1.5" aria-live="polite">
          {refuses.map((r) => (
            <li key={r.id} className="flex items-start gap-2 px-2 py-1 text-xs text-destructive">
              <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0"><strong className="break-all">{r.path}</strong> — non envoyé : {r.raison}</span>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        // L'AIDE NOMME LE BOUTON TEL QU'IL S'AFFICHE (recette du 23/11/2026) : sur le passeport d'un voyageur, il s'appelle
        // « Joindre le passeport (1) », et l'aide renvoyait à un « Téléverser » introuvable.
        <p className="text-xs text-warning">Sélection pas encore envoyée — cliquez « {libelleEnvoi ?? "Téléverser"} » pour l&apos;envoyer.</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-xs">
          {queued > 0 && items.length === 0 && (
            <span className="flex items-center gap-1.5 text-success"><CheckCircle2 className="h-4 w-4" /> {queued} document·s en envoi — vous pouvez continuer à travailler.</span>
          )}
        </div>
        {confirmationEnvoi ? (
          <BoutonDecisif type="button" size="sm" onClick={() => void uploadAll()} disabled={items.length === 0} confirmation={confirmationEnvoi}>
            <UploadCloud className="h-4 w-4" />
            {libelleEnvoi ?? "Téléverser"}{items.length > 0 ? ` (${items.length})` : ""}
          </BoutonDecisif>
        ) : (
          <Button type="button" size="sm" onClick={() => void uploadAll()} disabled={items.length === 0}>
            <UploadCloud className="h-4 w-4" />
            {libelleEnvoi ?? "Téléverser"}{items.length > 0 ? ` (${items.length})` : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
