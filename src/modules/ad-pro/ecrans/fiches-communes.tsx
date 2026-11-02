"use client";

import * as React from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { separerNom } from "../domaine/voyageurs";

/**
 * Ce que les fiches voyageurs (`voyageurs-bloc.tsx`) et hôtellerie (`hebergements-bloc.tsx`) affichent pareil :
 * le champ de saisie, l'entrée du menu « ⋯ », la personne de la demande avec son prénom et son nom, le pied
 * d'un formulaire. Écrits une fois, pour qu'une retouche de l'une ne laisse pas l'autre derrière.
 */

export const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";

export function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button" role="menuitem" onClick={onClick}
      className={`min-h-9 rounded px-3 py-2 text-[0.6875rem] font-medium hover:bg-secondary sm:min-h-0 sm:px-2 sm:py-1 ${danger ? "text-destructive" : "text-foreground"}`}
    >
      {children}
    </button>
  );
}

/** La personne de la demande (choix qui remplit le nom), puis le prénom et le nom — seul le nom est exigé. */
export function IdentiteDeLaFiche({ n, suggestions, prenom, setPrenom, nom, setNom }: {
  n: (cle: string) => string;
  suggestions: string[];
  prenom: string;
  setPrenom: (v: string) => void;
  nom: string;
  setNom: (v: string) => void;
}) {
  return (
    <>
      {suggestions.length > 0 && (
        <label className="text-xs sm:col-span-2">
          Personne de la demande
          <select
            defaultValue="" className={champ} aria-label="Choisir une personne de la demande"
            onChange={(e) => { if (e.target.value) { const c = separerNom(e.target.value); setPrenom(c.prenom); setNom(c.nom); } }}
          >
            <option value="">— Saisir à la main —</option>
            {suggestions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
      <label className="text-xs">
        Prénom
        <input name={n("prenom")} value={prenom} onChange={(e) => setPrenom(e.target.value)} placeholder="Amel" className={champ} />
      </label>
      <label className="text-xs">
        Nom
        <input name={n("nom")} required value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Haddad" className={champ} />
      </label>
    </>
  );
}

/** Le pied d'un formulaire de fiche : valider (le libellé du geste), annuler. */
export function PiedDeFiche({ busy, libelle, onCancel }: { busy: boolean; libelle: string; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button size="sm" type="submit" disabled={busy} className="h-10 w-full sm:h-8 sm:w-auto">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {libelle}
      </Button>
      <Button size="sm" type="button" variant="outline" onClick={onCancel} className="h-10 w-full sm:h-8 sm:w-auto">Annuler</Button>
    </div>
  );
}
