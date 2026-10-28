"use client";

import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ComposerPieceSheet } from "@/components/pieces/composer-piece";
import { ETIQUETTE_BROUILLON } from "@/lib/bons-de-commande/brouillon";
import { apercuBcPoste, previsualiserApercuBcPoste, imprimerApercuBcPoste, modifierApercuBcPoste, annulerApercuBcPoste, validerEtEnvoyerBcPoste, type ApercuBcPoste } from "../actions-postes-lignes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU DU BON DE COMMANDE D'UN DEVIS, À VALIDER PAR LE DEMANDEUR — OBLIGATOIRE ET ULTRA COMPLET (Direction, 14/10/2026).
 *
 * « Je veux l'aperçu obligatoire ; modification et révision possibles du BC ultra complètes, chaque détail peut être modifié
 * dans le BC. » Ce panneau n'est PAS un second formulaire : c'est le COMPOSEUR de pièces (`components/pieces/composer-piece`),
 * celui de la révision d'un BC émis, ouvert en mode « brouillon » — pré-rempli de la pièce telle que la fabrique la composerait
 * (lignes validées du devis + corrections déjà gardées), le PDF rendu à blanc en tête (numéro « à attribuer à la validation »).
 * Tout se corrige ; « Enregistrer le brouillon » garde la saisie ; « Valider et envoyer aux Finances » (le demandeur, ou le Super
 * Admin) l'écrit puis émet le BC — numéro, Word, PDF, centre de validation, signature.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Retour = { ok: boolean; error?: string; message?: string };
type Run = (key: string, fn: () => Promise<Retour>, okText: string) => Promise<void>;

export function ApercuBonDeCommande({ itemId, pieceId, nomDevis, peutEditer, peutValider, run, onClose }: {
  itemId: string;
  pieceId: string;
  nomDevis: string;
  /** Corriger, enregistrer, retirer l'aperçu. */
  peutEditer: boolean;
  /** Valider et envoyer aux Finances : le demandeur de la demande, ou le Super Admin. */
  peutValider: boolean;
  run: Run;
  onClose: () => void;
}) {
  const [etat, setEtat] = React.useState<ApercuBcPoste | null>(null);
  const [retrait, setRetrait] = React.useState<string | null>(null);
  const [, start] = React.useTransition();
  const avec = React.useCallback((fd: FormData) => { fd.set("id", itemId); fd.set("pieceId", pieceId); return fd; }, [itemId, pieceId]);

  React.useEffect(() => {
    setEtat(null);
    start(async () => setEtat(await apercuBcPoste(avec(new FormData()))));
  }, [avec]);

  const titre = `Bon de commande — ${nomDevis}`;
  if (!etat || !etat.ok) {
    return (
      <Sheet open onClose={onClose} width="xl" title={titre} description={`${ETIQUETTE_BROUILLON}. Aucun numéro n'est attribué et rien n'est envoyé aux Finances tant que vous n'avez pas validé.`}>
        {!etat ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive" role="alert">{etat.error}</p>
            {peutEditer && (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => start(async () => { const r = await annulerApercuBcPoste(avec(new FormData())); if (r.ok) onClose(); else setRetrait(r.error ?? "Échec."); })}
              >
                <Trash2 className="h-3.5 w-3.5" /> Retirer l&apos;aperçu
              </Button>
            )}
            {retrait && <p className="text-destructive">{retrait}</p>}
          </div>
        )}
      </Sheet>
    );
  }

  // « Valider et envoyer » passe par le geste de la carte : sa phrase (BC émis, centre, Finances) s'affiche sur le poste.
  const valider = async (fd: FormData): Promise<Retour> => {
    let r: Retour = { ok: false, error: "Un autre geste est en cours sur ce poste : réessayez dans un instant." };
    await run(`valbc:${pieceId}:${itemId}`, async () => { r = await validerEtEnvoyerBcPoste(avec(fd)); return r; }, "Bon de commande validé et envoyé.");
    return r;
  };

  return (
    <ComposerPieceSheet
      typeInitial="BON_DE_COMMANDE" typesAutorises={["BON_DE_COMMANDE"]}
      societes={[{ id: etat.societeId, label: etat.societeNom }]} societeParDefaut={etat.societeId}
      letterheads={etat.papeterie} peutReglerNumerotation={false}
      amont={{ options: [], tronquees: [], fermees: [], limite: 0 }}
      onClose={onClose}
      brouillon={{
        titre,
        valeurs: etat.valeurs,
        numeroExistant: etat.referenceExistante,
        pieceExistanteId: etat.bcExistantId,
        numeroModifie: etat.numeroModifie,
        numeroChoisi: etat.numeroChoisi,
        pdfInitial: etat.pdfBase64 ? { base64: etat.pdfBase64, pages: etat.pages } : null,
        apercu: (fd) => previsualiserApercuBcPoste(avec(fd)),
        impression: (fd) => imprimerApercuBcPoste(avec(fd)),
        enregistrer: peutEditer ? (fd) => modifierApercuBcPoste(avec(fd)) : undefined,
        valider: peutValider ? valider : undefined,
        sansValidation: "Le demandeur de la demande (ou le Super Admin) valide cet aperçu et l'envoie aux Finances.",
        retirer: peutEditer ? () => annulerApercuBcPoste(avec(new FormData())) : undefined,
        libelleValider: "Valider et envoyer aux Finances",
      }}
    />
  );
}
