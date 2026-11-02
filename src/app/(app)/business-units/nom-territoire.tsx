"use client";

import * as React from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { renommerSecteur } from "@/lib/actions/sales-planning-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { cn } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";

/**
 * LE NOM D'UN TERRITOIRE, RENOMMABLE SUR PLACE (Direction, 08/10 : « permets de nommer chaque territoire »).
 *
 * Le nom se lit tel quel ; à qui règle les secteurs, un crayon l'ouvre en saisie — Entrée enregistre, Échap annule. Seul
 * le NOM change (`renommerSecteur`) : la couverture du territoire ne passe pas par ce geste. Utilisé sur la ligne du KAM
 * (Business Units › Secteurs) et dans le tableau Force de vente › Territoires : un seul composant, une seule règle.
 *
 * Ce module n'importe qu'une action serveur et des utilitaires d'écran : la frontière client tient.
 */
export function NomTerritoire({ id, nom, peutRenommer, className }: {
  id: string;
  nom: string;
  peutRenommer: boolean;
  className?: string;
}) {
  const [edition, setEdition] = React.useState(false);
  const [valeur, setValeur] = React.useState(nom);
  const [envoi, setEnvoi] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const { enCours, rafraichir } = useRafraichir();
  const occupe = envoi || enCours;

  const ouvrir = () => { setValeur(nom); setErreur(null); setEdition(true); };
  const annuler = () => { setEdition(false); setErreur(null); };

  async function enregistrer() {
    const propre = valeur.replace(/\s+/g, " ").trim();
    if (!propre) { setErreur("Le nom du territoire est obligatoire."); return; }
    if (propre === nom) { setEdition(false); return; }
    setEnvoi(true); setErreur(null);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("name", propre);
    const r = await renommerSecteur(fd).catch(sansBloquer("nom-territoire.enregistrer.renommerSecteur", null));
    setEnvoi(false);
    if (!r?.ok) { setErreur(r?.error ?? "Le renommage a échoué."); return; }
    setEdition(false);
    rafraichir();
  }

  if (!edition) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{nom}</span>
        {peutRenommer && (
          <button
            type="button" onClick={ouvrir} disabled={occupe}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60"
            aria-label={`Renommer le territoire « ${nom} »`} title="Renommer"
          >
            {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Pencil className="h-3.5 w-3.5" aria-hidden />}
          </button>
        )}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <span className="inline-flex min-w-0 items-center gap-1">
        <input
          autoFocus value={valeur} maxLength={80} disabled={envoi}
          onChange={(e) => setValeur(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void enregistrer(); }
            if (e.key === "Escape") { e.preventDefault(); annuler(); }
          }}
          aria-label="Nom du territoire"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm font-normal"
        />
        <button type="button" onClick={() => void enregistrer()} disabled={envoi}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-60"
          aria-label="Enregistrer le nom">
          {envoi ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
        </button>
        <button type="button" onClick={annuler} disabled={envoi}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
          aria-label="Annuler">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </span>
      {erreur && <span role="alert" className="text-xs font-normal text-destructive">{erreur}</span>}
    </span>
  );
}
