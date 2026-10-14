"use client";

import * as React from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { tailleLisible } from "@/lib/files/politique-televersement";
import { ajouterAuChoix } from "@/lib/fil-pieces";

/**
 * CHOISIR PLUSIEURS FICHIERS AVANT D'ENVOYER UN FORMULAIRE — un geste pour plusieurs, d'autres ensuite.
 *
 * Pour les formulaires qui partent d'UN coup (un message de fil, un voyageur créé avec son passeport) :
 * la sélection s'accumule (recto, verso, visa… choisis ensemble ou l'un après l'autre), chaque fichier
 * se retire d'une croix, et ce que le serveur refuserait (type exécutable, vide, trop lourd pour la
 * limite des réglages) est dit TOUT DE SUITE, avec sa phrase — rien n'est envoyé pour être refusé.
 *
 * Le dépôt direct sur une fiche (sans formulaire autour) reste `DocumentUpload`, qui envoie en arrière-plan.
 */
export function ChoixFichiers({
  fichiers, onChange, libelle = "Joindre des fichiers", accept, disabled, ariaLabel, compact,
}: {
  fichiers: File[];
  onChange: (fichiers: File[]) => void;
  libelle?: string;
  accept?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Le bouton réduit à l'icône (barre d'un message). */
  compact?: boolean;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const limites = useLimitesEnvoi();
  const [refus, setRefus] = React.useState<{ nom: string; raison: string }[]>([]);

  const ajouter = (liste: FileList | null) => {
    if (!liste || liste.length === 0) return;
    const r = ajouterAuChoix(fichiers, Array.from(liste), limites?.maxUploadMb ?? null);
    setRefus(r.refus);
    onChange(r.fichiers);
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <input
        ref={ref} type="file" multiple hidden accept={accept} aria-label={ariaLabel ?? libelle}
        onChange={(e) => { ajouter(e.target.files); e.target.value = ""; }}
      />
      <Button
        type="button" size="sm" variant="outline" disabled={disabled} onClick={() => ref.current?.click()}
        title={libelle} aria-label={compact ? libelle : undefined}
      >
        <Paperclip className="h-4 w-4" />{compact ? null : <> {libelle}{fichiers.length > 0 ? ` (${fichiers.length})` : ""}</>}
      </Button>
      {fichiers.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Fichiers choisis">
          {fichiers.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 max-w-[12rem] truncate" title={f.name}>{f.name}</span>
              <span className="shrink-0 text-muted-foreground">{tailleLisible(f.size)}</span>
              <button
                type="button" disabled={disabled} onClick={() => onChange(fichiers.filter((_, j) => j !== i))}
                aria-label={`Retirer ${f.name}`}
                className="-my-1 -mr-1.5 shrink-0 rounded-full p-1.5 text-muted-foreground hover:text-destructive sm:m-0 sm:p-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {refus.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" aria-live="polite">
          {refus.map((r, i) => <li key={i}><strong className="break-all">{r.nom}</strong> — non joint : {r.raison}</li>)}
        </ul>
      )}
    </div>
  );
}
