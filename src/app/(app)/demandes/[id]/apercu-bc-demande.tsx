"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { ComposerPieceSheet } from "@/components/pieces/composer-piece";
import {
  ouvrirApercuBcDemande, previsualiserApercuBcDemande, imprimerApercuBcDemande, genererBonDeCommandeDemande, type OuvertureApercuBcDemande,
} from "@/lib/actions/secretariat-devis-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU DU BON DE COMMANDE D'UN FOURNISSEUR, AU BUREAU DU SECRÉTARIAT (Direction, 14/10/2026 — « Je veux l'aperçu
 * obligatoire ; chaque détail peut être modifié dans le BC »).
 *
 * « Comme dans Ad & Pro » : le MÊME composeur que la révision d'un BC émis (`components/pieces/composer-piece`), ouvert en mode
 * « brouillon » — pré-rempli de la pièce telle que la fabrique la composerait d'après les lignes retenues, le PDF rendu à blanc
 * en tête (numéro « à attribuer à la validation »). Tout se corrige. RIEN n'est écrit tant que le demandeur n'a pas cliqué
 * « Valider et envoyer » : fermer le panneau ne laisse aucune trace — ni brouillon, ni numéro, ni pièce.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Retour = { ok: boolean; error?: string; message?: string };

export function ApercuBcDemande({ requestId, cle, fournisseur, onClose, onEmis }: {
  requestId: string;
  /** La clé du fournisseur (`BcAGenerer.cle`). */
  cle: string;
  fournisseur: string;
  onClose: () => void;
  /** La phrase de l'émission, pour la carte qui a ouvert l'aperçu. */
  onEmis: (message: string) => void;
}) {
  const [etat, setEtat] = React.useState<OuvertureApercuBcDemande | null>(null);
  const [, start] = React.useTransition();
  const avec = React.useCallback((fd: FormData) => { fd.set("id", requestId); fd.set("fournisseur", cle); return fd; }, [requestId, cle]);

  React.useEffect(() => {
    setEtat(null);
    start(async () => setEtat(await ouvrirApercuBcDemande(avec(new FormData()))));
  }, [avec]);

  const titre = `Bon de commande — ${fournisseur}`;
  if (!etat || !etat.ok) {
    return (
      <Sheet open onClose={onClose} width="xl" title={titre} description="Aperçu à vérifier : rien n'est numéroté ni envoyé tant que vous n'avez pas validé.">
        {!etat
          ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</p>
          : <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{etat.error}</p>}
      </Sheet>
    );
  }

  const valider = async (fd: FormData): Promise<Retour> => {
    const r = await genererBonDeCommandeDemande(avec(fd));
    if (r.ok && r.message) onEmis(r.message);
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
        numeroExistant: null,
        numeroChoisi: null,
        pdfInitial: etat.pdfBase64 ? { base64: etat.pdfBase64, pages: etat.pages } : null,
        apercu: (fd) => previsualiserApercuBcDemande(avec(fd)),
        impression: (fd) => imprimerApercuBcDemande(avec(fd)),
        valider,
        libelleValider: "Valider et envoyer",
      }}
    />
  );
}
