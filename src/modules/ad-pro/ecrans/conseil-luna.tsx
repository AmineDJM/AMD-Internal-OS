"use client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * <ConseilLuna /> — LUNA DIT SI UNE PIÈCE EST AU BON ENDROIT, et sinon CONSEILLE. Rien d'autre.
 *
 * API (à monter juste sous une pièce qu'on vient de déposer) :
 *
 *   <ConseilLuna
 *     entityType="SPONSORING" | "CONGRESS_INTERNATIONAL" | "CONGRESS_NATIONAL" | "EVENT"
 *     entityId={demande.id}
 *     fichierId={document.id}            // l'identifiant du `Document` déposé
 *     emplacement={{ type: "DETAILS" }}  // ou { type: "POSTE", posteId, case: "DEVIS" | "BON_DE_COMMANDE" | "FACTURE" }
 *   />
 *
 * Il appelle `conseillerPiece` (action serveur, consultative) une fois par pièce/emplacement, et
 * affiche UNE ligne discrète — « Luna : bien placé ✓ », « à déplacer — … », ou ce qui l'empêche de
 * conseiller — dépliable pour lire le résumé et les gestes conseillés. AUCUN bouton n'agit à la
 * place de la personne : les gestes sont des phrases, c'est elle qui range.
 *
 * Il n'importe rien de serveur hors l'action (frontière client/serveur, `client-bundle-guard`) :
 * le module pur `conseil-pieces.ts` ne lui sert que pour ses types et sa phrase courte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from "react";
import { conseillerPiece } from "../actions-conseil";
import { phraseConseil, type EmplacementPiece, type NatureDemandeConseil } from "../domaine/conseil-pieces";

type Resultat = Awaited<ReturnType<typeof conseillerPiece>>;

export interface ConseilLunaProps {
  entityType: NatureDemandeConseil;
  entityId: string;
  fichierId: string;
  emplacement: EmplacementPiece;
}

export function ConseilLuna({ entityType, entityId, fichierId, emplacement }: ConseilLunaProps) {
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const cleEmplacement = JSON.stringify(emplacement);

  useEffect(() => {
    let vivant = true;
    setResultat(null);
    const fd = new FormData();
    fd.set("entityType", entityType);
    fd.set("entityId", entityId);
    fd.set("fichierId", fichierId);
    fd.set("emplacement", cleEmplacement);
    conseillerPiece(fd)
      .then((r) => { if (vivant) setResultat(r); })
      .catch(() => { if (vivant) setResultat({ ok: false, raison: "ECHEC", error: "Luna n'a pas pu lire la pièce — réessayez plus tard." }); });
    return () => { vivant = false; };
  }, [entityType, entityId, fichierId, cleEmplacement]);

  if (!resultat) {
    return <p className="text-xs text-muted-foreground" aria-live="polite">Luna lit la pièce…</p>;
  }
  if (!resultat.ok) {
    return <p className="text-xs text-muted-foreground" aria-live="polite">Luna : {resultat.error}</p>;
  }
  const c = resultat.conseil;
  const couleur = c.verdict === "BON_ENDROIT" ? "text-emerald-700 dark:text-emerald-400"
    : c.verdict === "A_DEPLACER" ? "text-amber-700 dark:text-amber-400"
    : "text-muted-foreground";
  return (
    <div className="text-xs" aria-live="polite">
      <button
        type="button"
        className={`min-h-9 py-1.5 text-left underline-offset-2 [overflow-wrap:anywhere] hover:underline sm:min-h-0 sm:py-0 ${couleur}`}
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        {phraseConseil(c)}
      </button>
      {ouvert && (
        <div className="mt-1 space-y-1 border-l-2 border-muted pl-2 text-muted-foreground">
          {c.resume && <p>{c.resume}</p>}
          {c.conseils.length > 0 && (
            <ul className="list-disc pl-4">
              {c.conseils.map((g, i) => <li key={i}>{g.texte}</li>)}
            </ul>
          )}
          <p>Confiance : {Math.round(c.confiance * 100)} % — Luna conseille, il ne déplace rien.</p>
          {resultat.coupe && <p>{resultat.coupe}</p>}
        </div>
      )}
    </div>
  );
}
