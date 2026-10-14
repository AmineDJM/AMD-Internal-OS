"use client";

import * as React from "react";
import { Plane, BedDouble, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChampsVoyageur } from "@/components/ad-pro/voyageurs-bloc";
import { ChampsHebergement } from "@/components/ad-pro/hebergements-bloc";
import { CHAMP_FICHES, FICHES_MAX, prefixeFiche } from "@/lib/ad-pro/fiches-saisie";

/** Une fiche en cours de saisie dans le formulaire d'ajout d'un poste — ses fichiers choisis (les champs vivent dans le DOM). */
export interface FicheBrouillon { cle: number; identite: File[]; documents: File[] }

let suivante = 0;
export const nouvelleFiche = (): FicheBrouillon => ({ cle: suivante++, identite: [], documents: [] });

/**
 * JOINDRE LES FICHIERS DES FICHES au formulaire d'ajout — sous le préfixe de chaque fiche, avec les noms que
 * lit l'action (`passeport` pour un voyageur, `pieceIdentite` pour une personne logée, `documents`).
 */
export function joindreFichiersDesFiches(fd: FormData, fiches: readonly FicheBrouillon[], nature: "VOYAGEUR" | "HEBERGEMENT"): void {
  const cleIdentite = nature === "VOYAGEUR" ? "passeport" : "pieceIdentite";
  for (const f of fiches) {
    const p = prefixeFiche(f.cle);
    for (const x of f.identite) fd.append(`${p}${cleIdentite}`, x);
    for (const x of f.documents) fd.append(`${p}documents`, x);
  }
}

/**
 * LES FICHES SAISIES AVEC LE POSTE (Direction, 10/2026) — « Prise en charge de la billetterie » : ses voyageurs ;
 * « de l'hôtellerie » : ses personnes logées. Les MÊMES champs que « Ajouter un voyageur » / « Ajouter une fiche »
 * (`ChampsVoyageur`, `ChampsHebergement`), un bloc par fiche, « + Ajouter une fiche ». Le poste et ses fiches
 * partent ensemble à l'enregistrement : une fiche refusée, aucun poste créé.
 */
export function FichesNouveauPoste({ nature, fiches, onChange }: {
  nature: "VOYAGEUR" | "HEBERGEMENT";
  fiches: FicheBrouillon[];
  onChange: (fiches: FicheBrouillon[]) => void;
}) {
  const maj = (cle: number, patch: Partial<FicheBrouillon>) => onChange(fiches.map((f) => (f.cle === cle ? { ...f, ...patch } : f)));
  const voyageur = nature === "VOYAGEUR";
  const Icone = voyageur ? Plane : BedDouble;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-2.5">
      <legend className="flex items-center gap-1.5 px-1 text-xs font-medium text-foreground">
        <Icone className="h-3.5 w-3.5 text-muted-foreground" />
        {voyageur ? "Voyageurs" : "Personnes logées"} ({fiches.length})
      </legend>
      {fiches.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {voyageur ? "Saisissez les voyageurs ici, ou plus tard depuis le poste." : "Saisissez les personnes logées ici, ou plus tard depuis le poste."}
        </p>
      )}
      {fiches.map((f, i) => (
        <div key={f.cle} className="space-y-2 rounded-lg border border-border bg-background p-2">
          <input type="hidden" name={CHAMP_FICHES} value={prefixeFiche(f.cle)} />
          <div className="flex items-center gap-2 text-[0.6875rem] font-medium text-muted-foreground">
            <span className="flex-1">{voyageur ? "Voyageur" : "Fiche hôtellerie"} {i + 1}</span>
            <button
              type="button" onClick={() => onChange(fiches.filter((x) => x.cle !== f.cle))}
              aria-label={`Retirer la fiche ${i + 1}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-secondary sm:h-auto sm:w-auto sm:p-1"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {voyageur ? (
            <ChampsVoyageur
              prefixe={prefixeFiche(f.cle)} suggestions={[]}
              passeports={f.identite} setPasseports={(x) => maj(f.cle, { identite: x })}
              documents={f.documents} setDocuments={(x) => maj(f.cle, { documents: x })}
            />
          ) : (
            <ChampsHebergement
              prefixe={prefixeFiche(f.cle)} suggestions={[]}
              pieces={f.identite} setPieces={(x) => maj(f.cle, { identite: x })}
              documents={f.documents} setDocuments={(x) => maj(f.cle, { documents: x })}
            />
          )}
        </div>
      ))}
      <Button
        type="button" size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto"
        disabled={fiches.length >= FICHES_MAX} onClick={() => onChange([...fiches, nouvelleFiche()])}
      >
        <Plus className="h-4 w-4" /> Ajouter une fiche
      </Button>
    </fieldset>
  );
}
