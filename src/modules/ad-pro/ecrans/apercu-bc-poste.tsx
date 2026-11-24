"use client";

import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ComposerPieceSheet } from "@/components/pieces/composer-piece";
import { ETIQUETTE_BROUILLON } from "@/lib/bons-de-commande/brouillon";
import { apercuBcPoste, previsualiserApercuBcPoste, imprimerApercuBcPoste, modifierApercuBcPoste, annulerApercuBcPoste, validerEtEnvoyerBcPoste, choisirSocieteDuBcPoste, type ApercuBcPoste } from "../actions-postes-lignes";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * LA SOCIÉTÉ QUI COMMANDE, À CHOISIR (recette 24/11/2026) — la demande n'en nomme aucune et son demandeur n'est pas dans
 * l'annuaire RH. Plutôt qu'une impasse (« renseignez la fiche salarié »), la personne qui prépare le BC la choisit ici : elle
 * s'inscrit sur la demande, puis l'aperçu se recharge et le BC se compose.
 */
function ChoixSociete({ message, societes, peutChoisir, choisir, onChoisie }: {
  message: string;
  societes: { id: string; label: string }[];
  peutChoisir: boolean;
  choisir: (companyId: string) => Promise<Retour>;
  onChoisie: () => void;
}) {
  const [companyId, setCompanyId] = React.useState(societes.length === 1 ? societes[0].id : "");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [enCours, start] = React.useTransition();
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
      <p className="font-medium">Société qui commande</p>
      <p className="text-muted-foreground">{peutChoisir ? message : message.replace("Choisissez-la ci-dessous", "La personne qui a ajouté le devis (ou le Super Admin) la choisit ici")}</p>
      {peutChoisir && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!companyId) { setErreur("Choisissez la société qui commande."); return; }
            setErreur(null);
            start(async () => {
              let r: Retour;
              try {
                r = await choisir(companyId);
              } catch {
                setErreur(actionFailureMessage("THROWN"));
                return;
              }
              if (r.ok) onChoisie(); else setErreur(r.error ?? "La société n'a pas été enregistrée.");
            });
          }}
        >
          <label className="sr-only" htmlFor="societe-qui-commande">Société qui commande</label>
          <select
            id="societe-qui-commande" name="companyId" value={companyId} onChange={(e) => setCompanyId(e.target.value)}
            className="h-9 min-w-0 flex-1 basis-48 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">— Choisir la société —</option>
            {societes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <Button type="submit" size="sm" disabled={enCours || !companyId}>
            {enCours && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Utiliser cette société
          </Button>
        </form>
      )}
      {erreur && <p className="text-destructive" role="alert">{erreur}</p>}
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU DU BON DE COMMANDE D'UN DEVIS, À VALIDER PAR LE DEMANDEUR — OBLIGATOIRE ET ULTRA COMPLET (Direction, 14/10/2026).
 *
 * « Je veux l'aperçu obligatoire ; modification et révision possibles du BC ultra complètes, chaque détail peut être modifié
 * dans le BC. » Ce panneau n'est PAS un second formulaire : c'est le COMPOSEUR de pièces (`components/pieces/composer-piece`),
 * celui de la révision d'un BC émis, ouvert en mode « brouillon » — pré-rempli de la pièce telle que la fabrique la composerait
 * (lignes validées du devis + corrections déjà gardées), le PDF rendu à blanc en tête (numéro « à attribuer à la validation »).
 * Tout se corrige ; « Enregistrer le brouillon » garde la saisie, et chaque enregistrement s'inscrit à l'historique (avant →
 * après, lu par le Super Admin) ; « Valider le BC » (la personne qui a ajouté le devis, ou le Super Admin — Direction, 11/2026)
 * l'écrit puis émet le BC — numéro, PDF, centre de validation, puis la page Bons de commande pour la signature.
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
  /** Valider le BC et l'envoyer à la signature : la personne qui a ajouté le devis, ou le Super Admin. */
  peutValider: boolean;
  run: Run;
  onClose: () => void;
}) {
  const [etat, setEtat] = React.useState<ApercuBcPoste | null>(null);
  const [retrait, setRetrait] = React.useState<string | null>(null);
  const [chargement, setChargement] = React.useState(0);
  const [, start] = React.useTransition();
  const avec = React.useCallback((fd: FormData) => { fd.set("id", itemId); fd.set("pieceId", pieceId); return fd; }, [itemId, pieceId]);

  React.useEffect(() => {
    setEtat(null);
    start(async () => setEtat(await apercuBcPoste(avec(new FormData()))));
  }, [avec, chargement]);

  const titre = `Bon de commande — ${nomDevis}`;
  if (!etat || !etat.ok) {
    return (
      <Sheet open onClose={onClose} width="xl" title={titre} description={`${ETIQUETTE_BROUILLON}. Aucun numéro n'est attribué et rien n'est envoyé aux Finances tant que vous n'avez pas validé.`}>
        {!etat ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</p>
        ) : (
          <div className="space-y-3 text-sm">
            {etat.societes && etat.societes.length > 0 ? (
              <ChoixSociete
                message={etat.error} societes={etat.societes} peutChoisir={peutEditer}
                choisir={(companyId) => { const fd = avec(new FormData()); fd.set("companyId", companyId); return choisirSocieteDuBcPoste(fd); }}
                onChoisie={() => setChargement((n) => n + 1)}
              />
            ) : (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive" role="alert">{etat.error}</p>
            )}
            {peutEditer && (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => start(async () => {
                  let r: Awaited<ReturnType<typeof annulerApercuBcPoste>>;
                  try {
                    r = await annulerApercuBcPoste(avec(new FormData()));
                  } catch {
                    setRetrait(actionFailureMessage("THROWN"));
                    return;
                  }
                  if (r.ok) onClose(); else setRetrait(r.error ?? "L'aperçu n'a pas été retiré.");
                })}
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
        sansValidation: "La personne qui a ajouté ce devis (ou le Super Admin) modifie et valide ce bon de commande.",
        retirer: peutEditer ? () => annulerApercuBcPoste(avec(new FormData())) : undefined,
        libelleValider: "Valider le BC — l'envoyer à la signature",
      }}
    />
  );
}
