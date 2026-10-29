"use client";

import * as React from "react";
import Link from "next/link";
import { Trash2, Loader2, Link2, ExternalLink, Send, FileText, RotateCcw, History, Pencil, MoreHorizontal, Wallet, Undo2, Ban, Scale, Paperclip, MessageSquarePlus, Inbox, Clock } from "lucide-react";
import type { AdProItemKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { ItemAskPanel } from "../item-ask-panel";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { canRemoveItem, ITEM_KIND_LABELS, ITEM_STATUS_LABELS, type AdProParent } from "../../domaine/postes";
import { updateAdProItem, deleteAdProItem, linkPromoMaterial, submitAdProItem, setAdProItemBudget, demanderPieceSecretariat, requestAdProItemOrder, approveAdProItemOrder } from "../../actions-postes";
import { repartirPoste, retirerDemandeBC, modifierDemandeBC, annulerOrdrePoste, demanderRevisionPoste, genererDemandeDevisPoste, referenceDemandeDevisPoste } from "../../actions-postes-decision";
import { ajouterDevisPoste, retirerDevisDuPoste, demanderPaiementPoste } from "../../actions-postes-paiement";
import { genererBonDeCommandePoste } from "../../actions-postes-lignes";
import { ChampReference } from "@/components/references/champ-reference";
import { deleteDocument } from "@/lib/actions/document-actions";
import { decideDocumentRequest } from "@/lib/actions/document-request-actions";
import { NATURES_PIECE_SECRETARIAT, PIECE_SECRETARIAT, peutDemanderPiece, type NaturePieceSecretariat } from "../../domaine/pieces-secretariat";
import { etapesDuPoste, prochainPas, faitsDuPoste, VERSEMENT_SANS_BC, LIBELLE_JUSTIFICATIF_DIRECT, type CleGeste, type EtatEtape, type RegardPoste } from "../../domaine/poste-etapes";
import { porteDesVoyageurs } from "../../domaine/voyageurs";
import { porteDesHebergements } from "../../domaine/hebergements";
import { DocumentUpload } from "@/components/documents/document-upload";
import { AD_PRO_DOC_CATEGORIES } from "../../domaine/doc-categories";
import { faitDeStock } from "@/lib/promo/reservations";
import { BlocMaterielStock, type ContexteMaterielStock } from "../materiel-stock";
import { BlocVoyageurs } from "../voyageurs-bloc";
import { BlocHebergements } from "../hebergements-bloc";
import { ConseilLuna } from "../conseil-luna";
import { refusGenerationBC } from "../../domaine/devis-poste";
import { BlocBonDeCommande, PanneauLignesDevis } from "../devis-bc-poste";
import { DeposerFactureBC, DemandePaiementBC, ControleDeFacture, bcsSansFacture, PaiementDemande } from "../facture-paiement-bc";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { ancrePoste } from "@/lib/chemins/ad-pro";
import type { ContexteDesPostes, ItemRow, Run } from "../items-panel";
import { CasePiece, ChaineDuPoste, estPosteStock, EtatBC, ETIQUETTE, IconeGeste, LettresDevis, LignePiece, type OngletChaine, POSTE_STOCK_EDITABLE, RAFRAICHISSEMENT, STYLE_ETAPE } from "./elements";
import { AllocateField, BoiteDecision, DemandeBC, DemandeSecretariat, EditItemForm, FormulairePiece, FormulaireRepartition, GesteAvecMotif, VerifierBC, VisaBC } from "./formulaires";

// La carte d'un poste, montée par `AdProItemsPanel` (`../items-panel.tsx`) — une par poste de la demande.

// ─────────────────────────────── La carte d'un poste ───────────────────────────────

type Panneau =
  | CleGeste | "MODIFIER" | "HISTORIQUE" | "MODIFIER_BC" | "RETIRER_BC" | "ANNULER_ORDRE" | "REVOIR_DECISION" | "REVISION_DEMANDEE"
  | "DEVIS" | "FICHIERS_DU_POSTE" | "SECRETARIAT" | "DEMANDES_SECRETARIAT" | "DEMANDER_A_QUELQU_UN" | "FACTURE_BC" | "LETTRE_DEVIS" | `LIGNES:${string}`;

/** Ce qu'un geste OUVRE (un petit formulaire) — seul « Soumettre » part au clic. */
const GESTES_A_FORMULAIRE: readonly CleGeste[] = [
  "REPARTIR", "CHIFFRER", "VALIDER_OPS", "DECIDER", "MONTANT", "BUDGET", "DEMANDER_BC", "VISER_BC", "VERIFIER_BC", "DEMANDER_PAIEMENT",
];

/** Un autre poste de la même demande — qu'un même devis peut couvrir aussi (§118.204). */
export interface PosteFrere { id: string; label: string; kind: AdProItemKind }

/** Le titre d'un poste, dit UNE fois : la nature seule quand le libellé la redit mot pour mot. */
function titreDuPoste(item: ItemRow): { titre: string; nature: string | null } {
  const nature = ITEM_KIND_LABELS[item.kind];
  const pareil = item.label.trim().toLocaleLowerCase("fr") === nature.toLocaleLowerCase("fr");
  return pareil ? { titre: nature, nature: null } : { titre: item.label, nature };
}

/**
 * LA CARTE D'UN POSTE — « trop de CTA, trop d'affichage, ça doit être clair et évident » (Direction, 04/10).
 *
 *   1. ce qu'il est (une fois), son état, et ce qu'il coûte — estimé → accordé — sur une ligne ;
 *   2. la frise ;
 *   3. UN bouton : le prochain geste de la personne qui regarde (`prochainPas`), ou la phrase grise
 *      qui dit ce qu'on attend et de qui ;
 *   4. les PIÈCES en trois cases alignées — devis / pro forma → bon de commande → facture — qui disent
 *      où en est la chaîne d'achat, avec un « Ajouter » discret là où l'on dépose quelque chose.
 *
 * Tout le reste (modifier, révision, demandes au secrétariat, fichiers joints, historique, retirer)
 * vit dans le menu « ⋯ » : rien ne disparaît, rien ne crie.
 */
export function PosteCarte({ item, parent, parentId, regard, freres, assistantes, budgetOptions, promoOptions, materiel, busy, run, parentLink, moduleLibelle, porteDg }: {
  item: ItemRow;
  parent: AdProParent;
  parentId: string;
  regard: RegardPoste;
  freres: PosteFrere[];
  assistantes: { id: string; name: string }[];
  budgetOptions: { id: string; label: string }[];
  promoOptions: { id: string; reference: string; title: string; status: string }[];
  materiel: ContexteMaterielStock;
  busy: string | null;
  run: Run;
  parentLink: string;
  /** Le module que lira le validateur d'une validation demandée depuis ce poste. */
  moduleLibelle: string;
  porteDg?: ContexteDesPostes["porteDg"];
}) {
  const [panneau, setPanneau] = React.useState<Panneau | null>(null);
  const [naturePiece, setNaturePiece] = React.useState<NaturePieceSecretariat>("DEVIS");
  const [menu, setMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  // LA PIÈCE QU'ON VIENT DE DÉPOSER, dans CETTE session : Luna dit si elle est au bon endroit. Un état
  // local, jamais au rechargement — chaque montage de <ConseilLuna> appelle un modèle payant.
  const [depose, setDepose] = React.useState<{ case: "DEVIS" | "FACTURE"; id: string | null; avant: string[] } | null>(null);

  // Le menu se ferme au clic ailleurs : un menu qui reste ouvert recouvre la carte d'en dessous.
  React.useEffect(() => {
    if (!menu) return;
    const fermer = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", fermer);
    return () => document.removeEventListener("mousedown", fermer);
  }, [menu]);

  const stock = estPosteStock(item);
  const direct = VERSEMENT_SANS_BC.includes(item.kind);
  const editer = regard.canEdit && !regard.fige;
  const arbitrer = regard.canAllocate && !regard.fige;
  const droits = regard.validation ?? { operations: false, marketing: false };
  // LA PORTE DU DG (27/10/2026) : la même pour tous les postes de la demande — la carte la lit, l'action la garde.
  const faits = { ...faitsDuPoste(item), porteDg: porteDg?.etat, porteDgPhrase: porteDg?.phrase ?? null };
  const pas = prochainPas(faits, regard);
  const etapes = etapesDuPoste(faits);
  const { titre, nature } = titreDuPoste(item);

  const fdOf = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("id", item.id);
    for (const [k, v] of Object.entries(extra)) if (v) fd.set(k, v);
    return fd;
  };
  const fermer = () => setPanneau(null);
  const basculer = (p: Panneau) => setPanneau((cur) => (cur === p ? null : p));

  /** Le geste principal — un formulaire qui s'ouvre, ou une action qui part. */
  const agir = (cle: CleGeste) => {
    if (GESTES_A_FORMULAIRE.includes(cle)) {
      basculer(cle === "CHIFFRER" ? "MODIFIER" : cle);
      return;
    }
    if (cle === "SOUMETTRE") void run(`submit:${item.id}`, () => submitAdProItem(undefined, fdOf()), "Poste soumis pour validation.");
    // « Générer le BC » : un BC par devis, d'après les lignes validées (§118.206) — la même action que le CTA de la case.
    if (cle === "GENERER_BC") void run(`gen:tous:${item.id}`, () => genererBonDeCommandePoste(fdOf()), "Aperçu du bon de commande prêt — à vérifier par le demandeur.");
  };

  // ── LE MENU « ⋯ » — ce qui ne crie pas, mais reste là. Chaque entrée n'apparaît que si
  //    l'action l'acceptera : un geste offert puis refusé est une fausse promesse (§118.83).
  const removable = canRemoveItem(
    { expenseOrderId: item.expenseOrderId, expenseOrderStatus: item.expenseOrder?.status ?? null },
    { canAllocate: arbitrer },
  );
  const entrees: { cle: string; libelle: string; icone: React.ReactNode; faire: () => void; danger?: boolean; decisif?: string }[] = [];
  if (editer) entrees.push({ cle: "modifier", libelle: "Modifier le poste", icone: <Pencil className="h-3.5 w-3.5" />, faire: () => setPanneau("MODIFIER") });
  if (arbitrer && !stock && !item.expenseOrderId && pas.geste?.cle !== "MONTANT") {
    entrees.push({ cle: "montant", libelle: "Affecter un montant", icone: <Wallet className="h-3.5 w-3.5" />, faire: () => setPanneau("MONTANT") });
  }
  if (arbitrer && !stock && item.status === "APPROVED" && item.orderStage !== "ISSUED" && item.budgetCategoryId && pas.geste?.cle !== "BUDGET") {
    entrees.push({ cle: "budget", libelle: "Changer le budget", icone: <Wallet className="h-3.5 w-3.5" />, faire: () => setPanneau("BUDGET") });
  }
  // LA DEMANDE DE BC SE CORRIGE ET SE RETIRE tant qu'aucun ordre n'est parti (§118.187, audit R06) —
  // le demandeur comme qui tranche (`retirerDemandeBC`, `modifierDemandeBC`). Un BC déjà établi dans
  // Legal lit sa validation sur ce poste : tant qu'il vit, la demande ne se retire pas, ne se refuse pas
  // et ne se rend pas à la Direction — la carte ne propose pas ces gestes, elle dit pourquoi.
  const bcEnCours = (item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK") && !item.expenseOrderId;
  const bcLegal = bcEnCours && item.bcEtablis.length > 0;
  const toucheBC = regard.canEdit || regard.canAllocate;
  // UN GESTE UNIQUE (constat 36) : un BC établi mais NON signé s'annule avec la demande ; signé, ou suivi
  // d'une facture, la demande est exécutée — la carte ne propose plus le geste et dit pourquoi.
  const bcAnnulable = bcEnCours && !item.refusAnnulationBc;
  if (bcEnCours && toucheBC) {
    entrees.push({ cle: "modifier-bc", libelle: "Modifier la demande de BC", icone: <Pencil className="h-3.5 w-3.5" />, faire: () => setPanneau("MODIFIER_BC") });
    if (bcAnnulable) entrees.push({ cle: "retirer-bc", libelle: "Annuler la demande de BC", icone: <Undo2 className="h-3.5 w-3.5" />, danger: bcLegal, faire: () => setPanneau("RETIRER_BC") });
  }
  // L'ORDRE ÉMIS S'ANNULE TANT QU'IL N'EST PAS RÉGLÉ (audit R06) — les Finances, qui tranche, ET le demandeur : l'action
  // l'accepte de lui (« on annule sa demande tant qu'elle n'a pas été exécutée », 04/10), la carte ne le lui cachait pas
  // moins (audit Ad & Pro, 14/10). Un ordre déjà ANNULÉ ailleurs (facture annulée dans Legal) se « libère » par le même
  // geste : sans lui, le poste restait « paiement en cours » pour toujours, et ne se repayait plus.
  const ordreAnnulable = Boolean(item.expenseOrderId) && ["PENDING", "REVISION_REQUESTED", "CANCELLED"].includes(item.expenseOrder?.status ?? "");
  const peutAnnulerOrdre = ordreAnnulable && (regard.canEmettre || regard.canEdit);
  if (peutAnnulerOrdre) {
    entrees.push({
      cle: "annuler-ordre",
      libelle: item.expenseOrder?.status === "CANCELLED" ? "Libérer le poste (ordre annulé)" : "Annuler la demande de paiement",
      icone: <Ban className="h-3.5 w-3.5" />, danger: true, faire: () => setPanneau("ANNULER_ORDRE"),
    });
  }
  // REVOIR LA DÉCISION (audit R12) — qui tranche le SECOND temps pour un poste d'argent (l'action le
  // refuse à tout autre), qui arbitre pour le matériel du stock. Le demandeur, lui, DEMANDE une révision.
  const revisable = (item.status === "APPROVED" || item.status === "REJECTED" || item.status === "REVISION") && !item.expenseOrderId && item.orderStage !== "ISSUED";
  const peutRevoir = stock ? arbitrer : droits.marketing && !regard.fige;
  if (peutRevoir && revisable) {
    entrees.push({ cle: "revoir", libelle: "Revoir la décision", icone: <Scale className="h-3.5 w-3.5" />, faire: () => setPanneau("REVOIR_DECISION") });
  }
  const peutDemanderRevision = !arbitrer && editer && !stock && !bcLegal && item.status === "APPROVED" && !item.expenseOrderId && item.orderStage !== "ISSUED";
  if (peutDemanderRevision) {
    entrees.push({ cle: "revision", libelle: "Demander une révision", icone: <RotateCcw className="h-3.5 w-3.5" />, faire: () => setPanneau("REVISION_DEMANDEE") });
  }
  // DEMANDER UN DEVIS (ou réclamer la facture) À L'ASSISTANTE — la liste canonique et sa garde
  // d'enchaînement (`peutDemanderPiece`), jamais deux boutons écrits à la main (§118.5).
  if (regard.canEdit && !stock) {
    const naturesOuvertes = item.demandes.filter((d) => d.status !== "DONE" && d.status !== "CANCELLED").map((d) => d.nature);
    NATURES_PIECE_SECRETARIAT.map((n) => {
      const garde = peutDemanderPiece(n, { ouvertes: naturesOuvertes, bcDemande: item.orderStage !== "NONE" });
      if (!garde.ok) return;
      entrees.push({
        cle: `secretariat-${n}`, libelle: n === "DEVIS" ? "Demander un devis à l'assistante" : "Réclamer la facture à l'assistante",
        icone: <MessageSquarePlus className="h-3.5 w-3.5" />, faire: () => { setNaturePiece(n); setPanneau("SECRETARIAT"); },
      });
    });
  }
  const nbDemandes = item.demandes.length + item.travauxBc.length;
  if (nbDemandes > 0) {
    entrees.push({ cle: "demandes", libelle: `Demandes au secrétariat (${nbDemandes})`, icone: <Inbox className="h-3.5 w-3.5" />, faire: () => setPanneau("DEMANDES_SECRETARIAT") });
  }
  if (regard.canEdit || item.documentCount > 0) {
    entrees.push({
      cle: "fichiers", libelle: `Fichiers joints au poste${item.documentCount > 0 ? ` (${item.documentCount})` : ""}`,
      icone: <Paperclip className="h-3.5 w-3.5" />, faire: () => setPanneau("FICHIERS_DU_POSTE"),
    });
  }
  if (regard.canEdit) {
    entrees.push({ cle: "demander", libelle: "Demander une pièce ou une validation", icone: <Send className="h-3.5 w-3.5" />, faire: () => setPanneau("DEMANDER_A_QUELQU_UN") });
  }
  if (item.decisions.length > 0) {
    // L'historique est borné : le compte dit combien il en montre SUR combien (§118.60).
    const libelleHisto = item.decisionsTotal > item.decisions.length
      ? `Historique (${item.decisions.length} dernières sur ${item.decisionsTotal})`
      : `Historique (${item.decisions.length})`;
    entrees.push({ cle: "historique", libelle: libelleHisto, icone: <History className="h-3.5 w-3.5" />, faire: () => setPanneau("HISTORIQUE") });
  }
  // RETIRER — libre tant qu'aucun ordre n'est parti aux Finances ; réservé à la Direction ensuite,
  // avec annulation de l'ordre (et jamais si déjà réglé). Un poste dont le matériel est dehors, ou
  // a été remis, ne se retire pas : l'action le refuserait (`faitDeStock`).
  if (editer && removable.ok && !item.lignesStock.some((l) => faitDeStock(l) != null)) {
    entrees.push({
      cle: "retirer", libelle: "Retirer le poste", icone: <Trash2 className="h-3.5 w-3.5" />, danger: true,
      decisif: item.expenseOrderId ? `retirer le poste et annuler l'ordre ${item.expenseOrder?.reference ?? ""}` : `retirer le poste « ${item.label} »`,
      faire: () => { void run(`del:${item.id}`, () => deleteAdProItem(undefined, fdOf()), "Poste retiré."); },
    });
  }

  const enCours = busy !== null && (busy === RAFRAICHISSEMENT || busy.endsWith(`:${item.id}`));
  // DÉPOSER UN DEVIS : le demandeur ou qui arbitre (`ajouterDevisPoste`), tant que le poste vit et n'est pas payé.
  const peutDeposerDevis = (regard.canEdit || regard.canAllocate) && !regard.fige && !stock && item.status !== "REJECTED" && !item.expenseOrderId;
  const paiementOuvert = pas.geste?.cle === "DEMANDER_PAIEMENT";
  // LA CASE FACTURE SE DÉBLOQUE À LA SIGNATURE DU BC (Direction, 06/10) — BC par BC : un poste à deux BC dépose la
  // facture du premier signé sans attendre le second ; le paiement, lui, attend que tout soit signé et facturé.
  const factureOuverte = !direct && (regard.canEdit || regard.canAllocate) && !item.expenseOrderId && bcsSansFacture(item.pieces.bcs, item.pieces.factures).length > 0;
  // LA GÉNÉRATION DU BC (§118.206) : la même règle que l'action (`refusGenerationBC`), jamais une copie.
  const peutGenerer = regard.canEdit && !stock && !direct && item.orderStage !== "ISSUED" && !item.expenseOrderId;
  const refusGeneration = refusGenerationBC({
    status: item.status, amountGranted: item.amountGranted, budgetCategoryId: item.budgetCategoryId, orderStage: item.orderStage,
    expenseOrderId: item.expenseOrderId, demandeChez: item.demandeBC?.assistante ?? null, demandeOuverte: item.demandeBC !== null,
  });
  // « Joindre un BC existant » = la demande à l'assistante (qui l'uploade) : le geste d'avant, tant qu'il est ouvert.
  const peutJoindreBC = (pas.geste?.cle === "DEMANDER_BC" || pas.geste?.cle === "GENERER_BC") && item.orderStage !== "REQUESTED" && item.orderStage !== "DIRECTION_OK";
  const pieceDeposee = depose
    ? (depose.case === "DEVIS" ? item.pieces.devis : item.pieces.factures)
      .find((p) => (depose.id ? p.id === depose.id : !depose.avant.includes(p.id))) ?? null
    : null;
  const conseil = (cas: "DEVIS" | "FACTURE") => pieceDeposee?.fichierId && depose?.case === cas ? (
    <ConseilLuna
      entityType={parent} entityId={parentId} fichierId={pieceDeposee.fichierId}
      emplacement={{ type: "POSTE", posteId: item.id, case: cas }}
    />
  ) : null;

  return (
    // L'ANCRE DU POSTE : une notification qui parle de CE poste (« Poste à valider », « BC validé »…)
    // mène ici (`lienPosteAdPro`), pas en haut d'une fiche à faire défiler.
    <li id={ancrePoste(item.id)} className="scroll-mt-20 space-y-2.5 rounded-xl border border-border bg-card p-3">
      {/* 1. CE QU'IL EST — une fois, son état, ce qu'il coûte. */}
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-tight">{titre}</p>
          {nature && <p className="text-xs text-muted-foreground">{nature}</p>}
        </div>
        <Badge tone={ITEM_STATUS_LABELS[item.status].tone} dot={false}>{ITEM_STATUS_LABELS[item.status].label}</Badge>
        {entrees.length > 0 && (
          <div ref={menuRef} className="relative">
            <button
              type="button" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} disabled={busy === RAFRAICHISSEMENT}
              aria-label={`Autres actions — ${item.label}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary sm:h-7 sm:w-7"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1 text-sm shadow-lg">
                {entrees.map((e) => e.decisif ? (
                  <BoutonDecisif
                    brut key={e.cle} type="button" role="menuitem" confirmation={e.decisif}
                    onClick={() => { setMenu(false); e.faire(); }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left hover:bg-secondary sm:py-1.5 ${e.danger ? "text-destructive" : ""}`}
                  >
                    {e.icone} {e.libelle}
                  </BoutonDecisif>
                ) : (
                  <button
                    key={e.cle} type="button" role="menuitem"
                    onClick={() => { setMenu(false); e.faire(); }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left hover:bg-secondary sm:py-1.5 ${e.danger ? "text-destructive" : ""}`}
                  >
                    {e.icone} {e.libelle}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {!stock && (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className="tabular-nums">{item.amountEstimated != null ? formatCurrency(item.amountEstimated) : "Non chiffré"}</span>
          {item.amountGranted != null && (
            <>
              <span aria-hidden>→</span>
              <span className="tabular-nums font-semibold text-foreground" title="Montant accordé">{formatCurrency(item.amountGranted)} accordé</span>
            </>
          )}
          {item.supplier && <span>· {item.supplier}</span>}
          {item.budgetCategoryLabel && <span>· {item.budgetCategoryLabel}</span>}
          {item.budgetKind === "ADDITIONAL" && <span className={ETIQUETTE}>Rallonge</span>}
          {item.addedAfterDecision && <span className={ETIQUETTE}>Ajouté après décision</span>}
        </p>
      )}

      {/* La parole de qui a renvoyé ou refusé le poste — ce qu'il faut corriger. */}
      {item.decisionNote && (item.status === "REVISION" || item.status === "REJECTED") && (
        <p className="rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-foreground"><strong>Motif :</strong> {item.decisionNote}</p>
      )}

      {/* 3. LE PROCHAIN GESTE — un bouton, ou une phrase qui dit qui on attend.
          JAMAIS DEUX FOIS LE MÊME CTA (Direction, 06/10) : « Générer le BC » vit dans la case « Bon de commande »,
          en bas — le geste ne se répète pas en haut de la carte. */}
      {/* UNE PHRASE, PAS UN PARAGRAPHE (Direction, 07/10 : « trop d'infos, trop d'écriture ») : le geste de la personne
          qui regarde, sinon OÙ en est le poste et CHEZ QUI. Le pourquoi — un BC établi dans Legal qui empêche de retirer
          la demande (§118.83) — passe dans un ⓘ. */}
      {((pas.geste && pas.geste?.cle !== "GENERER_BC") || (!pas.geste && pas.attente) || bcLegal) && (
        <div className="flex items-start gap-2">
          {pas.geste && pas.geste?.cle !== "GENERER_BC" ? (
            <Button size="sm" className="w-full sm:w-auto" onClick={() => agir(pas.geste!.cle)} disabled={enCours}>
              {enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <IconeGeste cle={pas.geste.cle} />}
              {pas.geste.libelle}
            </Button>
          ) : !pas.geste && pas.attente ? (
            <p className="flex min-w-0 flex-1 items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm font-medium text-primary">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" /> <span>{pas.attente}</span>
            </p>
          ) : null}
          {bcLegal && (
            <InfoBulle label="À propos du bon de commande">
              Bon de commande {item.bcEtablis.join(", ")} établi dans Legal.{" "}
              {item.refusAnnulationBc
                ? item.refusAnnulationBc
                : "Pour l'annuler : menu ⋯ › « Annuler la demande de BC ». Pour refuser le poste ou le rendre à la Direction, annulez d'abord cette demande."}
            </InfoBulle>
          )}
        </div>
      )}

      {/* Les petits formulaires qu'un geste ouvre — un seul à la fois. */}
      {panneau === "MODIFIER" && editer && (
        <EditItemForm
          item={item}
          busy={busy === `edit:${item.id}`}
          onCancel={fermer}
          onSave={(fd) => {
            fd.set("id", item.id);
            void run(`edit:${item.id}`, () => updateAdProItem(undefined, fd), "Poste modifié.").then(fermer);
          }}
        />
      )}
      {panneau === "REPARTIR" && editer && (
        <FormulaireRepartition
          origine={item.amountEstimated}
          busy={busy === `rep:${item.id}`}
          onCancel={fermer}
          onSubmit={(fd) => {
            fd.set("id", item.id);
            void run(`rep:${item.id}`, () => repartirPoste(undefined, fd), "Poste réparti.").then(fermer);
          }}
        />
      )}
      {panneau === "VALIDER_OPS" && droits.operations && item.status === "PENDING" && (
        <BoiteDecision item={item} mode="OPERATIONS" budgetOptions={budgetOptions} busy={busy} run={run} fdOf={fdOf} onCancel={fermer} />
      )}
      {panneau === "DECIDER" && item.status === "PENDING" && (stock ? arbitrer : droits.marketing) && (
        <BoiteDecision item={item} mode={stock ? "STOCK" : "MARKETING"} budgetOptions={budgetOptions} busy={busy} run={run} fdOf={fdOf} onCancel={fermer} />
      )}
      {panneau === "REVOIR_DECISION" && peutRevoir && revisable && (
        <BoiteDecision item={item} mode={stock ? "STOCK" : "MARKETING"} budgetOptions={budgetOptions} busy={busy} run={run} fdOf={fdOf} onCancel={fermer} revoir accordSeul={bcLegal} />
      )}
      {panneau === "MODIFIER_BC" && bcEnCours && toucheBC && (
        <DemandeBC
          initial={item.orderNote ?? ""} bouton="Mettre à jour la demande" assistantes={[]}
          busy={busy === `pom:${item.id}`} onCancel={fermer} onSend={(message) =>
            void run(`pom:${item.id}`, () => modifierDemandeBC(undefined, fdOf({ note: message })), "Demande de bon de commande mise à jour.").then(fermer)
          }
        />
      )}
      {panneau === "RETIRER_BC" && bcAnnulable && toucheBC && (
        <GesteAvecMotif
          titre="Annuler la demande de bon de commande"
          aide={bcLegal
            ? `Le bon de commande ${item.bcEtablis.join(", ")} n'est pas signé : il est annulé au registre avec la demande. Le motif reste à l'historique, l'assistante et les Finances sont prévenues.`
            : "Le motif reste à l'historique ; la demande à l'assistante se ferme avec, et les Finances sont prévenues si le centre l'avait visée."}
          bouton="Annuler la demande" danger busy={busy === `por:${item.id}`} onCancel={fermer}
          onSend={(motif) => void run(`por:${item.id}`, () => retirerDemandeBC(undefined, fdOf({ motif })), "Demande de bon de commande annulée.").then(fermer)}
        />
      )}
      {panneau === "ANNULER_ORDRE" && peutAnnulerOrdre && (
        <GesteAvecMotif
          titre={`Annuler la demande de paiement ${item.expenseOrder?.reference ?? ""}`}
          aide="Elle n'est pas réglée : elle s'annule, et la facture pourra être redéposée — corrigée si besoin."
          bouton="Annuler la demande de paiement" danger busy={busy === `poc:${item.id}`} onCancel={fermer}
          onSend={(motif) => void run(`poc:${item.id}`, () => annulerOrdrePoste(undefined, fdOf({ motif })), "Demande de paiement annulée.").then(fermer)}
        />
      )}
      {panneau === "REVISION_DEMANDEE" && !arbitrer && editer && item.status === "APPROVED" && (
        <GesteAvecMotif
          titre="Demander une révision"
          aide="Le poste repasse « en attente » et se revalide ; l'accord d'hier reste à l'historique. Une demande de BC en cours se retire avec lui."
          bouton="Demander la révision" busy={busy === `prv:${item.id}`} onCancel={fermer}
          extra={{ nom: "amountEstimated", libelle: "Nouvelle estimation (DZD, facultatif)" }}
          onSend={(motif, extra) => void run(`prv:${item.id}`, () => demanderRevisionPoste(undefined, fdOf({ motif, amountEstimated: extra })), "Révision demandée.").then(fermer)}
        />
      )}
      {panneau === "MONTANT" && (arbitrer || droits.marketing) && !item.expenseOrderId && (
        <AllocateField itemId={item.id} current={item.amountGranted} busy={busy === `alloc:${item.id}`} onSave={(v) => {
          void run(`alloc:${item.id}`, () => updateAdProItem(undefined, fdOf({ amountGranted: v })), "Montant affecté.").then(fermer);
        }} />
      )}
      {panneau === "BUDGET" && (arbitrer || droits.marketing) && item.status === "APPROVED" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={item.budgetCategoryId ?? ""}
            onChange={(e) => void run(`budget:${item.id}`, () => setAdProItemBudget(undefined, fdOf({ budgetCategoryId: e.target.value })), "Budget choisi.").then(fermer)}
            aria-label="Budget imputé à ce poste"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-2 text-base outline-none focus:border-primary/60 sm:py-1 sm:text-xs"
          >
            <option value="">Choisir le budget (enveloppe › catégorie)…</option>
            {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {busy === `budget:${item.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </div>
      )}
      {panneau === "DEMANDER_BC" && regard.canEdit && item.status === "APPROVED" && (
        <DemandeBC assistantes={assistantes} busy={busy === `po:${item.id}`} onCancel={fermer} onSend={(message, assistantId) =>
          void run(`po:${item.id}`, () => requestAdProItemOrder(undefined, fdOf({ note: message, assistantId })), "Bon de commande demandé.").then(fermer)
        } />
      )}
      {panneau === "VISER_BC" && regard.canViserBC && item.orderStage === "REQUESTED" && (
        <VisaBC busy={busy === `poa:${item.id}`} onCancel={fermer} onDecide={(decision, note) =>
          // CE QUE LE CENTRE A LU (§118.187) : le montant et le prestataire affichés partent avec le visa.
          void run(`poa:${item.id}`, () => approveAdProItemOrder(undefined, fdOf({
            decision, note, montantVu: item.amountGranted != null ? String(item.amountGranted) : "", prestataireVu: item.supplier ?? "",
          })),
            decision === "APPROVE" ? "Bon de commande validé." : "Bon de commande refusé.").then(fermer)
        } />
      )}
      {panneau === "VERIFIER_BC" && regard.verifieLeBC && item.demandeBC && (
        <VerifierBC demandeId={item.demandeBC.id} busy={busy === `vbc:${item.id}`} onCancel={fermer} onDecide={(accepte, note) => {
          const fd = new FormData();
          fd.set("id", item.demandeBC!.id);
          fd.set("accept", accepte ? "1" : "0");
          if (note) fd.set("note", note);
          void run(`vbc:${item.id}`, () => decideDocumentRequest(fd),
            accepte ? "Bon de commande accepté — il part à la signature." : "Bon de commande refusé — l'assistante est prévenue.").then(fermer);
        }} />
      )}
      {(panneau === "FACTURE_BC" || (panneau === "DEMANDER_PAIEMENT" && paiementOuvert)) && factureOuverte && (
        <DeposerFactureBC itemId={item.id} bcs={item.pieces.bcs} factures={item.pieces.factures} busy={busy} run={run} onClose={fermer} />
      )}
      {panneau === "DEMANDER_PAIEMENT" && paiementOuvert && direct && (
        <FormulairePiece
          titre={direct ? `Joindre la ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} et demander le paiement` : "Déposer la facture du bon de commande et demander le paiement"}
          aide={direct
            ? `La ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} est exigée${(item.pieces?.devis ?? []).some((d) => !d.annulee && d.fichiers > 0) ? " — elle est déjà sur le poste, il n'y a rien à joindre de plus" : ""} ; la facture est facultative. Le montant ne dépasse pas l'accordé${item.amountGranted != null ? ` (${formatCurrency(item.amountGranted)})` : ""}.`
            : `La facture est obligatoire. Son montant ne dépasse pas l'accordé${item.amountGranted != null ? ` (${formatCurrency(item.amountGranted)})` : ""}.`}
          libelleFichier={direct ? LIBELLE_JUSTIFICATIF_DIRECT : undefined}
          fichierObligatoire={!(direct && (item.pieces?.devis ?? []).some((d) => !d.annulee && d.fichiers > 0))}
          factureFacultative={direct}
          montantObligatoire montantMax={item.amountGranted} montantInitial={item.amountGranted}
          bouton="Demander le paiement" busy={busy === `pay:${item.id}`} onCancel={fermer}
          onSubmit={(fd) => {
            fd.set("id", item.id);
            // L'action rend l'ordre de dépense, pas la facture : on la retrouvera parmi les factures NOUVELLES.
            const avant = item.pieces.factures.map((f) => f.id);
            void run(`pay:${item.id}`, async () => {
              const r = await demanderPaiementPoste(undefined, fd);
              if (r.ok) setDepose({ case: "FACTURE", id: null, avant });
              return r;
            }, direct ? `${LIBELLE_JUSTIFICATIF_DIRECT} jointe — paiement demandé au centre de paiement.` : "Facture déposée — paiement demandé au centre de paiement.").then(fermer);
          }}
        />
      )}
      {panneau === "LETTRE_DEVIS" && peutDeposerDevis && (
        <form
          className="space-y-2 rounded-lg border border-border bg-background p-2.5 text-sm"
          action={(fd: FormData) => {
            fd.set("id", item.id);
            void run(`lettre:${item.id}`, () => genererDemandeDevisPoste(fd), "Demande de devis générée.").then(fermer);
          }}
        >
          <ChampReference cle={item.id} charger={() => { const fd = new FormData(); fd.set("id", item.id); return referenceDemandeDevisPoste(fd); }} />
          <label className="block space-y-1">
            <span className="font-medium">Précisions pour l&apos;agence <span className="font-normal text-muted-foreground">(facultatif)</span></span>
            <textarea name="note" rows={2} placeholder="Quantité, format, date de l'événement, lieu…" className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm" />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" size="sm" disabled={busy === `lettre:${item.id}`}>
              {busy === `lettre:${item.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Générer la demande de devis
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={fermer}>Annuler</Button>
          </div>
        </form>
      )}
      {panneau === "DEVIS" && peutDeposerDevis && (
        <FormulairePiece
          titre={direct ? `Joindre la ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")}` : "Joindre un devis ou une facture pro forma"}
          aide="Le fichier est obligatoire. Un même devis peut couvrir d'autres postes de cette demande."
          montantInitial={null} fournisseurInitial={item.supplier ?? ""} proforma={direct ? "imposee" : "choix"} freres={freres}
          plusieursDevis
          bouton="Joindre" busy={busy === `dev:${item.id}`} onCancel={fermer}
          onSubmit={(fd) => {
            fd.set("id", item.id);
            const avant = item.pieces.devis.map((d) => d.id);
            void run(`dev:${item.id}`, async () => {
              const r = await ajouterDevisPoste(undefined, fd);
              if (r.ok) setDepose({ case: "DEVIS", id: r.id ?? null, avant });
              return r;
            }, "Pièce jointe au poste.").then(fermer);
          }}
        />
      )}
      {typeof panneau === "string" && panneau.startsWith("LIGNES:") && (() => {
        const lu = item.devisLignes.find((v) => v.pieceId === panneau.slice("LIGNES:".length));
        return lu ? (
          <PanneauLignesDevis itemId={item.id} devis={lu} peutEditer={peutDeposerDevis} busy={busy} run={run} onClose={fermer} />
        ) : null;
      })()}
      {panneau === "SECRETARIAT" && regard.canEdit && (
        <DemandeSecretariat
          nature={naturePiece} busy={busy === `piece:${item.id}`} onCancel={fermer}
          onSend={(message) => void run(
            `piece:${item.id}`,
            () => demanderPieceSecretariat(undefined, fdOf({ nature: naturePiece, note: message })),
            `Demande de ${PIECE_SECRETARIAT[naturePiece].libelle.toLowerCase()} envoyée à l'assistante.`,
          ).then(fermer)}
        />
      )}
      {panneau === "DEMANDES_SECRETARIAT" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2 text-xs">
          {item.demandes.map((d) => (
            <Link key={d.id} href={`/demandes/${d.id}`} className="inline-flex items-center gap-1 py-1 font-medium text-primary hover:underline">
              {PIECE_SECRETARIAT[d.nature].libelle} {d.reference} <ExternalLink className="h-3 w-3" />
            </Link>
          ))}
          {item.travauxBc.map((d) => (
            <Link key={d.id} href={`/demandes/${d.id}`} className="inline-flex items-center gap-1 py-1 font-medium text-primary hover:underline">
              BC à établir {d.reference}{d.status === "CANCELLED" ? " (close)" : d.status === "DONE" ? " (fait)" : ""} <ExternalLink className="h-3 w-3" />
            </Link>
          ))}
          <button type="button" onClick={fermer} className="ml-auto px-2 py-1.5 text-muted-foreground hover:text-foreground">Fermer</button>
        </div>
      )}
      {panneau === "FICHIERS_DU_POSTE" && (
        <div className="space-y-1 rounded-lg border border-border bg-background p-2 text-xs">
          <p className="text-muted-foreground">
            Fichiers joints au poste{item.documentCount > 0 ? ` : ${item.documentCount}` : ""}. Un devis, un BC ou une facture se déposent plutôt dans leurs cases ci-dessous.
          </p>
          {regard.canEdit && <DocumentUpload entityType="AD_PRO_ITEM" entityId={item.id} categories={[...AD_PRO_DOC_CATEGORIES]} compact />}
          <button type="button" onClick={fermer} className="py-1.5 text-muted-foreground hover:text-foreground">Fermer</button>
        </div>
      )}
      {panneau === "DEMANDER_A_QUELQU_UN" && regard.canEdit && (
        <div className="space-y-1 rounded-lg border border-border bg-background p-2 text-xs">
          <ItemAskPanel
            entityType="AD_PRO_ITEM"
            entityId={item.id}
            link={parentLink}
            subject={`${ITEM_KIND_LABELS[item.kind]} : ${item.label}`}
            moduleLibelle={moduleLibelle}
          />
          <button type="button" onClick={fermer} className="py-1.5 text-muted-foreground hover:text-foreground">Fermer</button>
        </div>
      )}
      {panneau === "HISTORIQUE" && item.decisions.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-secondary/40 p-2 text-[0.6875rem]">
          {item.decisions.map((d, i) => (
            <li key={i} className="flex flex-wrap gap-x-2 text-muted-foreground">
              <span className="font-medium text-foreground">{ITEM_STATUS_LABELS[d.decision].label}</span>
              {d.amount != null && <span className="tabular-nums">{formatCurrency(d.amount)}</span>}
              <span>{formatDate(d.at)}</span>
              {d.by && <span>· {d.by}</span>}
              {d.note && <span className="w-full italic">« {d.note} »</span>}
            </li>
          ))}
          <li><button type="button" onClick={fermer} className="py-1.5 text-muted-foreground hover:text-foreground">Masquer</button></li>
        </ul>
      )}

      {/* LE MATÉRIEL DU STOCK a son propre bloc : lister, puis confirmer après l'événement. */}
      {stock && (
        <BlocMaterielStock
          itemId={item.id}
          lignes={item.lignesStock}
          magasin={materiel.magasin}
          editable={editer && POSTE_STOCK_EDITABLE.includes(item.status)}
          peutConfirmer={materiel.peutConfirmer}
          busy={busy}
          run={run}
        />
      )}

      {/* Le matériel promotionnel : on RENVOIE vers son circuit, on ne le recopie pas. */}
      {item.kind === "PROMO_MATERIAL" && (
        <div className="rounded-lg border border-border px-2.5 py-2 text-xs">
          {item.promoMaterial ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/promo-material/${item.promoMaterialId}`} className="inline-flex items-center gap-1 py-1 font-medium text-primary hover:underline">
                {item.promoMaterial.reference} <ExternalLink className="h-3 w-3" />
              </Link>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.promoMaterial.title}</span>
              <Badge tone="info" dot={false}>{item.promoMaterial.status}</Badge>
            </div>
          ) : editer ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  void run(`link:${item.id}`, () => linkPromoMaterial(undefined, fdOf({ promoMaterialId: e.target.value })), "Matériel rattaché.");
                }}
                aria-label="Rattacher un matériel promotionnel existant"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-2 text-base outline-none focus:border-primary/60 sm:py-1 sm:text-xs"
              >
                <option value="">Rattacher un matériel promotionnel existant…</option>
                {promoOptions.map((p) => <option key={p.id} value={p.id}>{p.reference} — {p.title}</option>)}
              </select>
              <Link href="/promo-material" className="whitespace-nowrap text-primary hover:underline">ou en créer un</Link>
            </div>
          ) : (
            <span className="text-muted-foreground">Aucun matériel rattaché.</span>
          )}
        </div>
      )}

      {/* LA BILLETTERIE : qui voyage, quand — et la réservation à l'assistante de direction. */}
      {porteDesVoyageurs(item.kind) && (
        <BlocVoyageurs
          itemId={item.id}
          voyageurs={item.voyageurs}
          nomsSuggeres={item.nomsSuggeres}
          reservation={item.reservation}
          // Les voyageurs sont une précision d'EXÉCUTION : ils se tiennent à jour même sur une
          // demande clôturée, comme le bon de commande.
          peutEditer={regard.canEdit}
          peutReserver={item.status !== "REJECTED"}
          busy={busy}
          run={run}
          // §118.205 : la somme des devis retenus se compare au montant accordé (sans le changer), et le BC
          // se demande d'ici d'après eux dès que le poste en est là (`prochainPas`).
          montantAccorde={item.amountGranted}
          bcPossible={pas.geste?.cle === "DEMANDER_BC" && item.orderStage !== "REQUESTED" && item.orderStage !== "DIRECTION_OK"}
          assistantes={assistantes}
          envois={item.envois}
        />
      )}

      {/* L'HÔTELLERIE : une fiche par personne logée (Direction, 06/10) — facultatives en sponsoring indirect. */}
      {porteDesHebergements(item.kind) && (
        <BlocHebergements
          itemId={item.id}
          hebergements={item.hebergements}
          nomsSuggeres={item.nomsSuggeres}
          peutEditer={regard.canEdit}
          obligatoire={!item.priseEnChargeIndirecte}
          busy={busy}
          run={run}
          envois={item.envois}
        />
      )}

      {/* 4. LA CHAÎNE DU POSTE — une barre d'étapes, et SEULE l'étape choisie dépliée (Direction, 07/10). Elle s'ouvre
          sur l'étape EN COURS : on voit où en est le poste sans rien lire, et le détail d'une étape se lit en un clic. */}
      {!stock && (() => {
        const accord = etapes.filter((e) => e.cle === "CHIFFRE" || e.cle === "OPERATIONS" || e.cle === "MARKETING");
        const etatAccord: EtatEtape = accord.some((e) => e.etat === "REFUSE") ? "REFUSE" : accord.every((e) => e.etat === "FAIT") ? "FAIT" : "EN_COURS";
        const etatDe = (cle: string): EtatEtape => etapes.find((e) => e.cle === cle)?.etat ?? "A_VENIR";
        const avecBC = !(direct && !item.pieces.bc && item.orderStage === "NONE");
        const onglets: OngletChaine[] = [
          {
            cle: "accord", libelle: "Accord", etat: etatAccord,
            contenu: (
              <CasePiece titre="Accord">
                <ul className="space-y-1">
                  {accord.map((e) => (
                    <li key={e.cle} className={cn("flex items-center gap-1.5", STYLE_ETAPE[e.etat].texte)}>{STYLE_ETAPE[e.etat].icone} {e.libelle}</li>
                  ))}
                </ul>
                {item.opsDecidedAt && item.opsDecisionNote && (
                  <p className="text-muted-foreground"><span className="font-medium text-foreground">Direction des opérations :</span> {item.opsDecisionNote}</p>
                )}
              </CasePiece>
            ),
          },
          ...(direct ? [] : [{
            cle: "demande", libelle: "Demande de devis", court: "Demande",
            etat: (item.demandesDevis.length > 0 || item.pieces.devis.some((d) => !d.annulee) ? "FAIT" : "A_VENIR") as EtatEtape,
            contenu: (
              <CasePiece titre="Demande de devis" ajouter={peutDeposerDevis && !enCours ? () => basculer("LETTRE_DEVIS") : undefined} libelleAjouter={item.demandesDevis.length ? "Régénérer" : "Générer"}>
                <LettresDevis lettres={item.demandesDevis} supprimer={editer ? (id) => void run(`rlettre:${item.id}`, () => deleteDocument(id), "Fichier supprimé.") : undefined} />
              </CasePiece>
            ),
          }]),
          {
            cle: "devis", libelle: direct ? "Justificatif" : "Devis",
            etat: direct ? etatDe("FACTURE") : item.pieces.devis.some((d) => !d.annulee) ? "FAIT" : "A_VENIR",
            contenu: (
              <CasePiece titre={direct ? LIBELLE_JUSTIFICATIF_DIRECT : "Devis / pro forma"} ajouter={peutDeposerDevis && !enCours ? () => basculer("DEVIS") : undefined}>
                {item.pieces.devis.length === 0 ? (
                  <p className="text-muted-foreground">Aucun pour l&apos;instant.</p>
                ) : item.pieces.devis.map((d) => {
                  const lu = item.devisLignes.find((v) => v.pieceId === d.id);
                  return (
                    <div key={d.id} className="space-y-0.5">
                      <LignePiece
                        piece={d}
                        retirer={editer && !d.annulee ? () => {
                          void run(`rdev:${item.id}`, () => retirerDevisDuPoste(undefined, fdOf({ pieceId: d.id })), "Pièce retirée du poste.");
                        } : undefined}
                      />
                      {lu && !d.annulee && (
                        <button type="button" onClick={() => basculer(`LIGNES:${d.id}`)} className="ml-4 py-1 text-primary hover:underline" aria-label={`Lignes du devis ${d.reference ?? d.titre}`}>
                          {lu.structure ? `Lignes (${lu.nbValidees}/${lu.lignes.length} validées)` : "Lignes à lire"}
                        </button>
                      )}
                    </div>
                  );
                })}
                {conseil("DEVIS")}
              </CasePiece>
            ),
          },
        ];
        if (avecBC) {
          onglets.push({
            cle: "bc", libelle: "Bon de commande", court: "BC", etat: etatDe("BC"),
            contenu: (
              <CasePiece titre="Bon de commande">
                <BlocBonDeCommande
                  itemId={item.id}
                  bcs={item.pieces.bcs}
                  devis={item.devisLignes}
                  accorde={item.amountGranted}
                  refusGeneration={refusGeneration}
                  peutGenerer={peutGenerer}
                  peutValider={regard.peutValiderBc === true && !stock && !direct && item.orderStage !== "ISSUED" && !item.expenseOrderId}
                  peutJoindre={peutJoindreBC}
                  peutModifier={regard.canEdit && !regard.fige && !item.expenseOrderId}
                  busy={busy}
                  run={run}
                  onJoindre={() => basculer("DEMANDER_BC")}
                  onReviser={peutDemanderRevision ? () => setPanneau("REVISION_DEMANDEE") : undefined}
                  repli={<EtatBC item={item} />}
                />
                {bcAnnulable && toucheBC && (
                  <button type="button" onClick={() => setPanneau("RETIRER_BC")} className="inline-flex min-h-9 items-center gap-1 text-xs text-destructive hover:underline sm:min-h-0">
                    <Undo2 className="h-3.5 w-3.5" /> Annuler la demande de BC
                  </button>
                )}
              </CasePiece>
            ),
          });
        }
        onglets.push({
          cle: "facture", libelle: "Facture",
          etat: direct ? (item.pieces.factures.some((f) => !f.annulee) ? "FAIT" : "A_VENIR") : etatDe("FACTURE"),
          contenu: (
            <CasePiece
              titre={direct ? "Facture (facultative)" : "Facture"}
              ajouter={direct
                ? (paiementOuvert && item.pieces.factures.length === 0 && !enCours ? () => basculer("DEMANDER_PAIEMENT") : undefined)
                : (factureOuverte && !enCours ? () => basculer("FACTURE_BC") : undefined)}
            >
              {item.pieces.factures.length === 0 ? (
                <p className="text-muted-foreground">{direct ? "Non exigée pour le paiement." : factureOuverte ? "Le BC est signé : déposez la facture." : "Après la signature du BC."}</p>
              ) : item.pieces.factures.map((f) => (
                <div key={f.id} className="space-y-0.5">
                  <LignePiece piece={f} />
                  <ControleDeFacture piece={f} />
                </div>
              ))}
              {conseil("FACTURE")}
            </CasePiece>
          ),
        });
        onglets.push({
          cle: "paiement", libelle: "Paiement", etat: etatDe("PAIEMENT"),
          contenu: (
            <CasePiece titre="Paiement">
              {direct ? (
                item.expenseOrder ? (
                  <PaiementDemande
                    expenseOrder={item.expenseOrder} paye={item.expenseOrder.status === "PAID"}
                    peutRelancer={regard.canEdit || regard.canAllocate}
                  />
                ) : <p className="text-muted-foreground">Après le justificatif.</p>
              ) : (
                <DemandePaiementBC
                  itemId={item.id} bcs={item.pieces.bcs} factures={item.pieces.factures} accorde={item.amountGranted}
                  peutDemander={(regard.canEdit || regard.canAllocate) && item.status === "APPROVED"}
                  expenseOrder={item.expenseOrder ?? null} busy={busy} run={run}
                />
              )}
            </CasePiece>
          ),
        });
        return <ChaineDuPoste onglets={onglets} />;
      })()}    </li>
  );
}
