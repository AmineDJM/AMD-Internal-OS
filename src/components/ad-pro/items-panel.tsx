"use client";

import * as React from "react";
import Link from "next/link";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import {
  Plus, Trash2, Loader2, CheckCircle2, XCircle, Link2, AlertTriangle, ExternalLink, Send, FileText,
  ThumbsUp, ThumbsDown, RotateCcw, History, Pencil, MoreHorizontal, Circle, X, Wallet, Split,
  Undo2, Ban, Scale, Paperclip, ShieldCheck, FileCheck2, MessageSquarePlus, Inbox, Clock,
} from "lucide-react";
import type { AdProItemKind, AdProItemStatus, AdProItemBudgetKind, AdProItemOrderStage } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { ItemAskPanel } from "./item-ask-panel";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  breakdown, canRemoveItem, budgetKindLocked, plannedGaps,
  ITEM_KINDS, ITEM_KIND_LABELS, ITEM_STATUS_LABELS, ITEM_BUDGET_KIND_LABELS, LIBELLE_BC_SOUS_LE_SEUIL, LIBELLE_ORDRE_EMIS,
  type AdProParent,
} from "@/lib/ad-pro-items";
import {
  addAdProItem, updateAdProItem, deleteAdProItem, repartirPoste, linkPromoMaterial,
  submitAdProItem, decideAdProItem, setAdProItemBudget,
  demanderPieceSecretariat, requestAdProItemOrder, approveAdProItemOrder,
  retirerDemandeBC, modifierDemandeBC, annulerOrdrePoste, demanderRevisionPoste,
  ajouterDevisPoste, retirerDevisDuPoste, demanderPaiementPoste, genererBonDeCommandePoste, genererDemandeDevisPoste,
  referenceDemandeDevisPoste,
} from "@/lib/actions/ad-pro-item-actions";
import { ChampReference } from "@/components/references/champ-reference";
import { deleteDocument } from "@/lib/actions/document-actions";
import { decideDocumentRequest } from "@/lib/actions/document-request-actions";
import type { DroitsValidation } from "@/lib/ad-pro/validation-poste";
import { LIBELLE_ETAPE_BC } from "@/lib/bons-de-commande/regle";
import { kindLabel } from "@/lib/ad-pro/unified";
import {
  NATURES_PIECE_SECRETARIAT, PIECE_SECRETARIAT, peutDemanderPiece, type NaturePieceSecretariat,
} from "@/lib/ad-pro/pieces-secretariat";
import {
  etapesDuPoste, prochainPas, grouperParRepartition, faitsDuPoste, VERSEMENT_SANS_BC, LIBELLE_JUSTIFICATIF_DIRECT,
  type CleGeste, type EtatEtape, type RegardPoste,
} from "@/lib/ad-pro/poste-etapes";
import { NATURES_REPARTITION } from "@/lib/ad-pro/repartition";
import { porteDesVoyageurs } from "@/lib/ad-pro/voyageurs";
import { porteDesHebergements } from "@/lib/ad-pro/hebergements";
import { DocumentUpload } from "@/components/documents/document-upload";
import { AD_PRO_DOC_CATEGORIES } from "@/lib/ad-pro/doc-categories";
import { faitDeStock, NATURE_MATERIEL_STOCK } from "@/lib/promo/reservations";
import { BlocMaterielStock, type LigneStockVue, type ContexteMaterielStock } from "./materiel-stock";
import { BlocVoyageurs, type VoyageurVue } from "./voyageurs-bloc";
import { BlocHebergements, type HebergementVue } from "./hebergements-bloc";
import { FichesNouveauPoste, joindreFichiersDesFiches, type FicheBrouillon } from "./fiches-nouveau-poste";
import type { EnvoiVue } from "@/lib/reservation-fiche/etat";
import { ConseilLuna } from "./conseil-luna";
import type { PiecesDuPoste, PieceDePoste, DemandeBCDuPoste } from "@/lib/ad-pro/pieces-poste";
import type { DevisDePosteVue } from "@/lib/queries/ad-pro-devis-poste";
import { refusGenerationBC } from "@/lib/ad-pro/devis-poste";
import { BlocBonDeCommande, PanneauLignesDevis } from "./devis-bc-poste";
import { DeposerFactureBC, DemandePaiementBC, ControleDeFacture, bcsSansFacture, PaiementDemande } from "./facture-paiement-bc";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { ancrePoste } from "@/lib/chemins/ad-pro";
import type { EtatPorteDg } from "@/lib/seuils/porte-dg-total";
import { CartePorteDg } from "./porte-dg-carte";

export type { LigneStockVue, ContexteMaterielStock, ArticleMagasinVue } from "./materiel-stock";
export type { VoyageurVue } from "./voyageurs-bloc";
export type { HebergementVue } from "./hebergements-bloc";

/** Un poste « Matériel du stock » n'engage pas d'argent : il ne montre ni montant, ni budget, ni BC. */
const estPosteStock = (it: { kind: AdProItemKind }) => it.kind === NATURE_MATERIEL_STOCK;
/** Un poste qui liste les articles du stock se compose tant qu'il n'est ni soumis ni accordé. */
const POSTE_STOCK_EDITABLE: readonly AdProItemStatus[] = ["DRAFT", "REVISION", "REJECTED"];
/**
 * La rangée de boutons au pied d'un petit formulaire : empilée et pleine largeur au téléphone (le pouce
 * vise une barre, pas un mot), en ligne au-delà. Un `BoutonDecisif` y prend `max-sm:w-full` : son
 * enveloppe s'étire seule, pas le bouton qu'elle contient.
 */
const RANGEE_ACTIONS = "flex flex-col gap-2 sm:flex-row sm:flex-wrap";

export interface ItemRow {
  id: string;
  kind: AdProItemKind;
  label: string;
  notes: string | null;
  supplier: string | null;
  amountEstimated: number | null;
  amountGranted: number | null;
  addedAfterDecision: boolean;
  promoMaterialId: string | null;
  promoMaterial: { reference: string; title: string; status: string } | null;
  expenseOrderId: string | null;
  expenseOrder: { id?: string; reference: string; status: string; centralStatus?: string | null } | null;
  /** Cycle de validation propre au poste. */
  status: AdProItemStatus;
  budgetKind: AdProItemBudgetKind;
  decisionNote: string | null;
  decidedAt: string | null;
  /** Budget (catégorie d'enveloppe) qui portera la dépense, choisi après accord. */
  budgetCategoryId: string | null;
  budgetCategoryLabel: string | null;
  /** Les demandes de pièce ouvertes au secrétariat pour ce poste (devis, facture). */
  demandes: { id: string; reference: string; nature: NaturePieceSecretariat; status: string }[];
  /** Le « BC à établir » de l'assistante — le travail qui suit la demande de bon de commande. */
  travauxBc: { id: string; reference: string; status: string }[];
  /**
   * Les BC déjà établis dans Legal pour ce poste, non annulés (`ad-pro/bc-etablis.ts`) : ils lisent
   * leur validation SUR le poste — retirer la demande de BC, la refuser ou la rendre à la Direction
   * les laisserait sans porte. L'écran ne propose donc pas ces gestes ; il dit pourquoi (§118.83).
   */
  bcEtablis: string[];
  /**
   * Ce qui empêche « Annuler la demande de BC » (constat 36) : un BC signé par les Finances, ou une facture
   * qui en découle. `null` : le geste unique annule le BC non signé au registre, puis retire la demande.
   */
  refusAnnulationBc: string | null;
  /** Combien de pièces jointes le poste porte — le détail se déplie à la demande. */
  documentCount: number;
  /** Les lettres de demande de devis du poste (PDF et Word), la plus récente d'abord (Direction, 07/10). */
  demandesDevis: { id: string; nom: string; pdf: boolean; le: string }[];
  /** Émission du bon de commande : demande → visa du centre (au-dessus du seuil) → Finances. */
  orderStage: AdProItemOrderStage;
  /** Vrai quand le BC est passé aux Finances SOUS le seuil, sans visa d'aucun centre (§118.149). */
  orderSansCentre?: boolean;
  /** Le message du DEMANDEUR : contenu du bon de commande, références, fournisseur. */
  orderNote: string | null;
  /** La note de la Direction sur son visa ou son refus — elle n'écrase plus la précédente. */
  orderDecisionNote: string | null;
  /** Historique des allers-retours avec la Direction (le plus récent en tête) — borné ; le total suit. */
  decisions: { decision: AdProItemStatus; note: string | null; amount: number | null; at: string; by: string | null }[];
  /** Combien de décisions le poste porte EN TOUT : l'historique affiché n'en montre que les dernières. */
  decisionsTotal: number;
  /** Le matériel du magasin listé par un poste « Matériel du stock » (§118.167) — vide sinon. */
  lignesStock: LigneStockVue[];
  /** Les postes nés d'une même répartition d'un sponsoring indirect (§118.175). */
  repartitionId: string | null;
  /** Le sujet de réservation d'une billetterie, s'il a été ouvert. */
  /** Le sujet de réservation ; `refusRetrait` : ce qui empêche de retirer la demande (`null` : elle se retire). */
  reservation: { id: string; reference: string; refusRetrait: string | null } | null;
  /** Les voyageurs d'un poste « billetterie » — vide sinon. */
  voyageurs: VoyageurVue[];
  /** Les fiches hôtellerie d'un poste « hôtellerie » — vide sinon (Direction, 06/10). */
  hebergements: HebergementVue[];
  /** L'état de chaque fiche (voyageur, fiche hôtellerie) chez l'assistante de direction — par fiche (14/10). */
  envois?: Record<string, EnvoiVue>;
  /**
   * Le poste vit dans un sponsoring INDIRECT (né d'une répartition, ou posé sur un sponsoring de
   * nature indirecte) : ses fiches par personne sont facultatives. Calculé au serveur.
   */
  priseEnChargeIndirecte: boolean;
  /** Les noms que la demande porte déjà — proposés à la saisie d'un voyageur, jamais imposés. */
  nomsSuggeres: string[];
  /** Premier temps de validation franchi (Direction des opérations) — `null` tant qu'il ne l'est pas (§118.204). */
  opsDecidedAt: string | null;
  opsDecisionNote: string | null;
  /** La chaîne d'achat du poste : devis / pro forma → bon de commande → factures. */
  pieces: PiecesDuPoste;
  /** La demande de BC OUVERTE chez l'assistante, s'il y en a une. */
  demandeBC: DemandeBCDuPoste | null;
  /** Les devis du poste lus avec leurs lignes structurées — d'après elles se génèrent les BC (§118.206). */
  devisLignes: DevisDePosteVue[];
  /**
   * UN POSTE HISTORIQUE (intégration des dépenses réelles Ad & Pro 2026) : déjà payé, il ne passe par aucun circuit —
   * ni validation, ni BC, ni paiement. La carte le montre payé, sans geste. `null` pour tout autre poste.
   */
  historique?: { montant: number; ligne: number | null; payeLe: string | null } | null;
}

interface Props {
  parent: AdProParent;
  parentId: string;
  items: ItemRow[];
  /** Enveloppe accordée par la Direction (DZD), ou null si elle n'a pas encore tranché. */
  amountGranted: number | null;
  decided: boolean;
  /**
   * Un poste ajouté MAINTENANT l'est-il après la décision sur l'ARGENT (§118.151) ? Par défaut,
   * `decided`. Un sponsoring dont la TENUE est pré-validée est décidé sans avoir d'enveloppe :
   * y ajouter des postes est l'étape même de la procédure, pas un dépassement à signaler.
   */
  tardif?: boolean;
  /**
   * La demande est CLÔTURÉE : postes, montants, décisions et budgets sont arrêtés (§118.151).
   * Ce qui EXÉCUTE ce qui a été validé reste offert — pièces, bon de commande, émission — sans
   * quoi la clôture laisserait en plan un poste accordé dont le BC n'était pas encore parti.
   */
  fige?: boolean;
  canEdit: boolean;
  /** Affecter les montants et engager la dépense : Direction uniquement. */
  canAllocate: boolean;
  /**
   * Siège au CENTRE DE VALIDATION AD & PRO — seul à viser un bon de commande (§118.148). Distinct
   * de `canAllocate` : répartir l'enveloppe entre les postes reste un geste de la Direction ; le
   * visa d'un BC ne l'est plus. Calculé au serveur, jamais deviné ici.
   */
  canViserBC?: boolean;
  promoOptions: { id: string; reference: string; title: string; status: string }[];
  /** Congrès : ce qui est ANNONCÉ (stand, symposium) et qu'il faudrait chiffrer. */
  plan?: { hasBooth?: boolean | null; hasSymposium?: boolean | null };
  /** Faux : la fiche porte déjà l'enveloppe et ce qui est affecté dans un bandeau commun (Direction, 07/10). */
  resume?: boolean;
  /** (Sous-)catégories budgétaires proposées pour imputer un poste accordé. */
  budgetOptions?: { id: string; label: string }[];
  /** Les Finances émettent le bon de commande visé par la Direction. */
  canIssueOrder?: boolean;
  /**
   * Le magasin où un poste « Matériel du stock » pioche, et qui confirme après l'événement
   * (§118.167). Obligatoire : une page qui l'oublierait laisserait ses postes de stock sans
   * article à lister ni confirmation possible, en silence.
   */
  materiel: ContexteMaterielStock;
  /**
   * Ce que la personne qui regarde peut trancher dans les DEUX temps de validation, les assistantes de
   * direction qui établissent un BC, et qui elle est (`contextePostes`, calculé au serveur). Obligatoire :
   * une page qui l'oublierait laisserait ses postes sans validateur ni vérification du BC, en silence.
   */
  contexte: ContexteDesPostes;
}

/** Le contexte calculé par `contextePostes` (requêtes, côté serveur) — recopié en type pour rester client. */
export interface ContexteDesPostes {
  validation: DroitsValidation;
  assistantes: { id: string; name: string }[];
  userId: string;
  /** La demande vient de la Direction Marketing : le second temps revient à la Direction des opérations. */
  secondTempsParOperations: boolean;
  /** Valider l'aperçu du BC et l'envoyer aux Finances : le demandeur de la demande, ou le Super Admin. */
  peutValiderBc: boolean;
  /** La porte du DG sur le total de la demande (27/10/2026) — calculée au serveur (`contextePostes`). */
  porteDg?: { etat: EtatPorteDg; phrase: string | null; total: number; seuil: number | null; note: string | null; peutStatuer: boolean };
}

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;

/**
 * DE QUOI EST FAIT LE MONTANT — les postes d'une opération Ad & Pro (§118.175).
 *
 * « Ici c'est trop complexe : plus simple, plus séparé, plus lisible, moins de boutons et de CTA
 * partout » (Direction, 01/10). Un poste affichait jusqu'à neuf commandes à la fois, dont
 * plusieurs désactivées avec leur raison collée à côté ; on lisait tout pour trouver la seule
 * chose qu'on pouvait faire. Chaque poste est maintenant une CARTE :
 *
 *   1. ce qu'il est (nature, libellé, statut) et ce qu'il coûte, sur deux lignes ;
 *   2. une FRISE — chiffré → Direction → budget → bon de commande → paiement ;
 *   3. UN bouton, le prochain geste de la personne qui regarde — ou, s'il n'est pas le sien, une
 *      phrase qui dit ce qu'on attend et de qui (`prochainPas`, une règle pure et testée) ;
 *   4. la chaîne d'achat en trois cases — devis / pro forma → bon de commande → facture ;
 *   5. le reste dans un menu « ⋯ » : rien ne disparaît, rien ne crie.
 *
 * Les quatre principes d'avant tiennent toujours : chaque poste se valide À PART ; le dépassement
 * se voit ; le matériel promotionnel n'est pas recopié ici ; ce qui est annoncé doit être chiffré.
 * Et un sponsoring indirect se RÉPARTIT par nature : ses postes s'affichent ensemble, sous leur
 * total.
 */
/** Où vit chaque opération porteuse de postes — une seule table, jamais recopiée. */
const PARENT_PATH: Record<AdProParent, string> = {
  SPONSORING: "/sponsoring",
  CONGRESS_NATIONAL: "/congress-national",
  CONGRESS_INTERNATIONAL: "/congress-international",
  EVENT: "/events",
  AD_PRO_OTHER: "/ad-pro/autres",
};

export function AdProItemsPanel({
  parent, parentId, items, amountGranted, decided, tardif = decided, fige = false, canEdit: canEditBrut, canAllocate: canAllocateBrut, promoOptions, plan,
  budgetOptions = [], canIssueOrder = false, canViserBC = false, materiel, contexte, resume = true,
}: Props) {
  // CLÔTURÉE : on ne décrit, ne chiffre, ne décide et ne réimpute plus — l'action le refuserait
  // (`refusSiClos`), et un bouton qu'une action refuse n'est pas un bouton. Les gestes
  // d'EXÉCUTION (pièces, BC, émission) gardent leurs droits d'origine, passés à part.
  const canEdit = canEditBrut && !fige;
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : entre la fin d'une action et l'arrivée des nouvelles
  // données, la carte montrerait l'état d'AVANT avec ses gestes déjà cliquables — « Modifier le
  // poste » ou un voyageur s'ouvriraient sur un instantané périmé, et l'enregistrer réécrirait
  // l'ancien état par-dessus le nouveau. Les gestes restent fermés jusqu'à ce que l'écran soit à jour.
  const { enCours: rafraichissement, rafraichir } = useRafraichir();
  const [busyAction, setBusy] = React.useState<string | null>(null);
  const busy = busyAction ?? (rafraichissement ? RAFRAICHISSEMENT : null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = React.useState(false);
  const lock = React.useRef(false);

  // Le chemin de l'opération porteuse : la demande de pièce y renvoie, pour que celui qui a
  // demandé retrouve son dossier depuis le fil.
  const parentLink = `${PARENT_PATH[parent]}/${parentId}`;

  const b = breakdown(items, amountGranted);
  const gaps = plannedGaps(items, plan ?? {});
  const groupes = grouperParRepartition(items);

  const run: Run = async (key, fn, okText) => {
    if (lock.current || rafraichissement) return;
    lock.current = true;
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      // La phrase de l'ACTION l'emporte quand elle en rend une : elle seule sait, par exemple,
      // qu'un BC sous le seuil est parti aux Finances sans passer par le centre (§118.149).
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText) : (r.error ?? "Échec.") });
      if (r.ok) rafraichir();
    } finally {
      setBusy(null);
      lock.current = false;
    }
  };

  const carte = (it: ItemRow) => it.historique ? (
    <li key={it.id} id={ancrePoste(it.id)} className="flex flex-wrap items-center gap-2 rounded-xl border border-purple-200 bg-purple-50/40 p-3 text-sm dark:bg-purple-500/5">
      <Badge tone="purple">Historique 2026</Badge>
      <span className="min-w-0 flex-1 font-medium">{it.label}</span>
      <span className="text-xs text-muted-foreground">
        {it.budgetCategoryLabel ?? "—"}{it.historique.ligne ? ` · fichier L${it.historique.ligne}` : ""}{it.historique.payeLe ? ` · payé le ${formatDate(it.historique.payeLe)}` : ""}
      </span>
      <Badge tone="success">payé</Badge>
      <span className="font-semibold tabular-nums">{formatCurrency(it.historique.montant)}</span>
    </li>
  ) : (
    <PosteCarte
      key={it.id}
      item={it}
      parent={parent}
      parentId={parentId}
      regard={{
        canEdit: canEditBrut, canAllocate: canAllocateBrut, canViserBC,
        // ANNULER UN ORDRE ÉMIS non réglé : les Finances, ou qui arbitre.
        canEmettre: canIssueOrder || canAllocateBrut,
        fige, operationDecidee: decided,
        validation: contexte.validation,
        secondTempsParOperations: contexte.secondTempsParOperations,
        // C'est celle qui a DEMANDÉ le BC qui vérifie la pièce que l'assistante a déposée.
        verifieLeBC: Boolean(it.demandeBC) && it.demandeBC?.askedById === contexte.userId,
        peutValiderBc: contexte.peutValiderBc,
      }}
      freres={items.filter((x) => x.id !== it.id && !estPosteStock(x) && x.status !== "REJECTED").map((x) => ({ id: x.id, label: x.label, kind: x.kind }))}
      assistantes={contexte.assistantes}
      budgetOptions={budgetOptions}
      promoOptions={promoOptions}
      materiel={materiel}
      busy={busy}
      run={run}
      parentLink={parentLink}
      moduleLibelle={`Ad & Pro — ${kindLabel(parent === "AD_PRO_OTHER" ? "OTHER" : parent)}`}
      porteDg={contexte.porteDg}
    />
  );

  return (
    <div className="space-y-4">
      {/* ── La porte du DG sur le total (27/10/2026) : visible dès qu'elle est requise. ── */}
      {contexte.porteDg && <CartePorteDg parent={parent} parentId={parentId} porte={contexte.porteDg} />}
      {/* ── La ventilation, avant la liste : c'est la question qu'on se pose en arrivant. ── */}
      {resume && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Figure
          label="Enveloppe accordée"
          value={b.envelopeDzd != null ? formatCurrency(b.envelopeDzd) : "—"}
          // DÉCIDÉE SANS ENVELOPPE : une tenue pré-validée (§118.151) n'a pas « rien de tranché »,
          // elle a un montant qui se fixera à la validation finale — le dire évite de lire un oubli.
          hint={b.envelopeDzd == null ? (decided && !tardif ? "fixée à la validation finale" : "Direction non tranchée") : undefined}
        />
        <Figure label="Estimé par le demandeur" value={formatCurrency(b.estimatedDzd)} hint={`${b.itemCount} poste(s)`} />
        <Figure
          label="Affecté aux postes"
          value={formatCurrency(b.allocatedDzd)}
          hint={b.additionalDzd > 0 ? `+ ${formatCurrency(b.additionalDzd)} en budget supplémentaire` : undefined}
        />
        {b.overrunDzd > 0 ? (
          <Figure label="Dépassement" value={formatCurrency(b.overrunDzd)} tone="danger" hint="au-delà de l'enveloppe" />
        ) : (
          <Figure
            label="Reste à affecter"
            value={b.envelopeDzd != null ? formatCurrency(b.unallocatedDzd) : "—"}
            tone={b.balanced ? "success" : undefined}
            hint={b.balanced ? "ventilation complète" : undefined}
          />
        )}
      </div>}

      {fige && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span className="flex-1">Demande <strong className="text-foreground">clôturée</strong> : postes et montants arrêtés.</span>
          <InfoBulle label="Ce que veut dire « clôturée »">
            Les bons de commande et factures des postes accordés suivent leur cours. Pour corriger un poste, rouvrez la demande.
          </InfoBulle>
        </p>
      )}

      {/* Une RALLONGE assumée n'est pas un dépassement subi : deux lignes distinctes, deux décisions. */}
      {(b.additionalDzd > 0 || b.pendingDzd > 0) && (
        <p className="rounded-xl border border-border bg-secondary/30 p-3 text-sm text-muted-foreground">
          {b.additionalDzd > 0 && (
            <>Postes demandés <strong className="text-foreground">en plus</strong> de l&apos;enveloppe : <strong className="tabular-nums text-foreground">{formatCurrency(b.additionalDzd)}</strong>. </>
          )}
          {b.pendingDzd > 0 && (
            <>En attente de décision de la Direction : <strong className="tabular-nums text-foreground">{formatCurrency(b.pendingDzd)}</strong>.</>
          )}
        </p>
      )}

      {b.overrunDzd > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">Dépassement de l&apos;enveloppe : <strong>{formatCurrency(b.overrunDzd)}</strong>.</span>
          <InfoBulle label="Que faire du dépassement">
            {b.hasLateAdditions
              ? "Des postes ont été ajoutés après la décision — c'est autorisé, mais la Direction doit le savoir avant le règlement."
              : "Réduisez un poste ou faites relever l'enveloppe."}
          </InfoBulle>
        </p>
      )}

      {/* Annoncé mais pas chiffré : le budget est incomplet, et personne ne le voyait. */}
      {gaps.any && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {gaps.boothUnbudgeted && <>Un <strong>stand</strong> est annoncé sur cet événement mais aucun poste ne le chiffre. </>}
            {gaps.symposiumUnbudgeted && <>Un <strong>symposium</strong> est annoncé mais aucun poste ne le chiffre. </>}
          </span>
          <InfoBulle label="Faut-il le chiffrer ?">S&apos;il est offert par l&apos;organisateur, ignorez ce rappel — sinon le budget est incomplet.</InfoBulle>
        </p>
      )}

      {/* ── Les postes ── */}
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Aucun poste. Ajoutez ce que couvre l&apos;opération : appui, stand, imprimerie, billetterie, prestation…
        </p>
      ) : (
        <ul className="space-y-3">
          {groupes.map((g) => g.repartitionId ? (
            <li key={g.cle} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-2.5">
              <p className="flex flex-wrap items-center gap-2 px-1 text-sm">
                <Split className="h-4 w-4 text-primary" />
                <strong>Sponsoring indirect</strong>
                <span className="tabular-nums text-muted-foreground">
                  {formatCurrency(g.items.reduce((s, it) => s + (it.amountGranted ?? it.amountEstimated ?? 0), 0))}
                </span>
                <span className="text-muted-foreground">· {g.items.length} nature{g.items.length > 1 ? "s" : ""}</span>
              </p>
              <ul className="space-y-2">{g.items.map(carte)}</ul>
            </li>
          ) : carte(g.items[0]!))}
        </ul>
      )}

      {msg && (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          {msg.text}
        </p>
      )}

      {/* ── Ajouter ── */}
      {canEdit && (
        adding ? (
          <AddItemForm
            parent={parent}
            parentId={parentId}
            decided={tardif}
            busy={busy === "add"}
            onCancel={() => setAdding(false)}
            onSubmit={(fd) => void run("add", async () => {
              const r = await addAdProItem(undefined, fd);
              if (r.ok) setAdding(false);
              return r;
            }, "Poste ajouté.")}
          />
        ) : (
          <Button size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Ajouter un poste
          </Button>
        )
      )}
    </div>
  );
}

/** L'état « l'écran se met à jour » — tous les gestes de toutes les cartes attendent. */
const RAFRAICHISSEMENT = "rafraichissement";

// ─────────────────────────────── La carte d'un poste ───────────────────────────────

type Panneau =
  | CleGeste | "MODIFIER" | "HISTORIQUE" | "MODIFIER_BC" | "RETIRER_BC" | "ANNULER_ORDRE" | "REVOIR_DECISION" | "REVISION_DEMANDEE"
  | "DEVIS" | "FICHIERS_DU_POSTE" | "SECRETARIAT" | "DEMANDES_SECRETARIAT" | "DEMANDER_A_QUELQU_UN" | "FACTURE_BC" | "LETTRE_DEVIS" | `LIGNES:${string}`;

/** Ce qu'un geste OUVRE (un petit formulaire) — seul « Soumettre » part au clic. */
const GESTES_A_FORMULAIRE: readonly CleGeste[] = [
  "REPARTIR", "CHIFFRER", "VALIDER_OPS", "DECIDER", "MONTANT", "BUDGET", "DEMANDER_BC", "VISER_BC", "VERIFIER_BC", "DEMANDER_PAIEMENT",
];

/** Un autre poste de la même demande — qu'un même devis peut couvrir aussi (§118.204). */
interface PosteFrere { id: string; label: string; kind: AdProItemKind }

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
function PosteCarte({ item, parent, parentId, regard, freres, assistantes, budgetOptions, promoOptions, materiel, busy, run, parentLink, moduleLibelle, porteDg }: {
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

/** Une case de la chaîne d'achat — son titre, son contenu, et un « Ajouter » discret quand il y a lieu. */
function CasePiece({ titre, ajouter, libelleAjouter = "Ajouter", children }: { titre: string; ajouter?: () => void; libelleAjouter?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg bg-secondary/30 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 font-medium text-foreground">{titre}</p>
        {/* Au téléphone, une vraie cible (40 px, bordée) : c'est ici qu'on dépose devis et factures. */}
        {ajouter && (
          <button
            type="button" onClick={ajouter}
            className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg border border-primary/40 bg-card px-3 text-sm font-medium text-primary hover:underline sm:h-auto sm:gap-0.5 sm:border-0 sm:bg-transparent sm:px-0 sm:text-xs sm:font-normal"
          >
            <Plus className="h-4 w-4 sm:h-3 sm:w-3" /> {libelleAjouter}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * LA DEMANDE DE DEVIS DU POSTE (Direction, 07/10) — la lettre la plus récente, en PDF et Word, cliquable ; chaque fichier se
 * supprime. Les générations précédentes ne s'affichent pas : la dernière fait foi.
 */
function LettresDevis({ lettres, supprimer }: { lettres: { id: string; nom: string; pdf: boolean; le: string }[]; supprimer?: (id: string) => void }) {
  if (lettres.length === 0) return <p className="text-muted-foreground">Pas encore générée.</p>;
  const derniere = lettres[0].le.slice(0, 16);
  const recentes = lettres.filter((l) => l.le.slice(0, 16) === derniere);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Générée le {formatDate(lettres[0].le)}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {recentes.map((l) => (
          <li key={l.id} className="inline-flex items-center gap-1">
            <a href={`/api/documents/${l.id}`} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 font-medium text-primary hover:underline sm:min-h-0">
              <FileText className="h-3.5 w-3.5" /> {l.pdf ? "PDF" : "Word"}
            </a>
            {supprimer && (
              <BoutonDecisif brut type="button" onClick={() => supprimer(l.id)} aria-label={`Supprimer ${l.nom}`} className="rounded p-1.5 text-muted-foreground hover:text-destructive sm:p-0.5">
                <X className="h-3.5 w-3.5" />
              </BoutonDecisif>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Une pièce du registre — titre court, montant, fichiers ; le titre mène à sa fiche Legal. */
function LignePiece({ piece, retirer }: { piece: PieceDePoste; retirer?: () => void }) {
  return (
    <div className={`flex min-w-0 items-start gap-1.5 ${piece.annulee ? "opacity-60" : ""}`}>
      <FileText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {/* Le FICHIER, pas la fiche Legal : qui voit la demande lit les pièces de ses postes (exception de
            lecture, §118.204), mais la fiche `/legal/[id]` peut lui rester fermée — un lien vers une page
            refusée est un geste offert puis retiré (§118.83). */}
        {piece.fichierId ? (
          <a href={`/api/documents/${piece.fichierId}`} target="_blank" rel="noreferrer" className={`block truncate font-medium text-primary hover:underline ${piece.annulee ? "line-through" : ""}`} title={piece.titre}>
            {piece.reference ?? piece.titre}
          </a>
        ) : (
          <span className={`block truncate font-medium ${piece.annulee ? "line-through" : ""}`} title={piece.titre}>{piece.reference ?? piece.titre}</span>
        )}
        <p className="text-muted-foreground">
          {piece.montant != null ? <span className="tabular-nums">{formatCurrency(piece.montant)}</span> : "montant non saisi"}
          {piece.fichiers > 0 && <> · <Paperclip className="inline h-3 w-3" /> {piece.fichiers}</>}
          {piece.annulee && " · annulée"}
        </p>
        {piece.aussiPour.length > 0 && <p className="truncate text-muted-foreground" title={piece.aussiPour.join(", ")}>Couvre aussi : {piece.aussiPour.join(", ")}</p>}
        {/* TOUS LES FICHIERS DE LA PIÈCE (Direction, 07/10) — le titre ouvre le premier ; les autres se listent ici. */}
        {piece.fichiersListe.length > 1 && (
          <ul className="mt-0.5 space-y-0.5">
            {piece.fichiersListe.map((f) => (
              <li key={f.id} className="min-w-0">
                <a href={`/api/documents/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline" title={f.nom}>
                  <Paperclip className="h-3 w-3 shrink-0" /> <span className="truncate">{f.nom}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {retirer && (
        <BoutonDecisif brut type="button" onClick={retirer} aria-label={`Retirer ${piece.titre} du poste`} className="-m-1.5 rounded p-2 text-muted-foreground hover:text-destructive sm:m-0 sm:p-0.5">
          <X className="h-4 w-4 sm:h-3 sm:w-3" />
        </BoutonDecisif>
      )}
    </div>
  );
}

/** Où en est le bon de commande du poste — chez l'assistante, déposé, au centre, à signer, signé. */
function EtatBC({ item }: { item: ItemRow }) {
  const bc = item.pieces.bc;
  const note = (
    <>
      {item.orderNote && <p className="line-clamp-2 text-muted-foreground" title={item.orderNote}>Demande : {item.orderNote}</p>}
      {item.orderDecisionNote && (
        <p className="line-clamp-2 text-muted-foreground" title={item.orderDecisionNote}>
          {item.orderSansCentre ? LIBELLE_BC_SOUS_LE_SEUIL : "Centre"} : {item.orderDecisionNote}
        </p>
      )}
    </>
  );
  if (bc) {
    const etape = bc.etape ?? "HORS_CIRCUIT";
    return (
      <>
        <LignePiece piece={bc} />
        <p className={etape === "SIGNE" ? "text-success" : etape === "REFUSE" ? "text-destructive" : "text-muted-foreground"}>{LIBELLE_ETAPE_BC[etape]}</p>
      </>
    );
  }
  if (item.demandeBC?.etat === "DEPOSE") {
    return (
      <>
        <p className="font-medium text-foreground">Déposé — à vérifier</p>
        <Link href={`/pieces/${item.demandeBC.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">Ouvrir le BC déposé <ExternalLink className="h-3 w-3" /></Link>
        {note}
      </>
    );
  }
  if (item.demandeBC?.etat === "CHEZ_ASSISTANTE") {
    return <><p className="text-muted-foreground">Chez {item.demandeBC.assistante ?? "l'assistante de direction"}</p>{note}</>;
  }
  const phrase: Partial<Record<AdProItemOrderStage, string>> = {
    REQUESTED: "Au centre de validation Ad & Pro",
    DIRECTION_OK: "Validé — à établir par l'assistante",
    REFUSED: "Refusé par le centre — à redemander",
    ISSUED: LIBELLE_ORDRE_EMIS,
  };
  return <><p className="text-muted-foreground">{phrase[item.orderStage] ?? (item.status === "APPROVED" ? "À demander" : "Après l'accord.")}</p>{note}</>;
}

function IconeGeste({ cle }: { cle: CleGeste }) {
  switch (cle) {
    case "REPARTIR": return <Split className="h-4 w-4" />;
    case "CHIFFRER": return <Pencil className="h-4 w-4" />;
    case "VALIDER_OPS": case "DECIDER": case "VISER_BC": return <ThumbsUp className="h-4 w-4" />;
    case "GENERER_BC": return <FileText className="h-4 w-4" />;
    case "MONTANT": case "BUDGET": return <Wallet className="h-4 w-4" />;
    case "VERIFIER_BC": return <ShieldCheck className="h-4 w-4" />;
    case "DEMANDER_PAIEMENT": return <FileCheck2 className="h-4 w-4" />;
    default: return <Send className="h-4 w-4" />;
  }
}

/** Une étiquette sur la ligne du poste (« Rallonge », « Ajouté après décision ») — un mot, pas une phrase. */
const ETIQUETTE = "rounded-md bg-warning/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning";

/** Le rendu d'un état d'étape — le même partout sur la carte : fait, en cours, à venir, refusé. */
const STYLE_ETAPE: Record<EtatEtape, { texte: string; barre: string; icone: React.ReactNode; dit: string }> = {
  FAIT: { texte: "text-success", barre: "border-success", icone: <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />, dit: "fait" },
  EN_COURS: { texte: "font-medium text-primary", barre: "border-primary", icone: <Clock className="h-3.5 w-3.5 shrink-0" />, dit: "en cours" },
  A_VENIR: { texte: "text-muted-foreground", barre: "border-border", icone: <Circle className="h-3.5 w-3.5 shrink-0" />, dit: "à venir" },
  REFUSE: { texte: "font-medium text-destructive", barre: "border-destructive", icone: <X className="h-3.5 w-3.5 shrink-0" />, dit: "refusé" },
};

interface OngletChaine { cle: string; libelle: string; court?: string; etat: EtatEtape; contenu: React.ReactNode }

/**
 * LA CHAÎNE DU POSTE — Accord → Devis → Bon de commande → Facture → Paiement, en une barre ; dessous, UNE étape à la fois.
 * Elle s'ouvre sur l'étape en cours (ou refusée), à défaut sur la dernière faite : quatre colonnes serrées obligeaient
 * à tout lire pour trouver la seule qui comptait.
 */
function ChaineDuPoste({ onglets }: { onglets: OngletChaine[] }) {
  const parDefaut = (onglets.find((o) => o.etat === "EN_COURS" || o.etat === "REFUSE")
    ?? [...onglets].reverse().find((o) => o.etat === "FAIT")
    ?? onglets[0]).cle;
  const [choisi, setChoisi] = React.useState<string | null>(null);
  const actif = onglets.find((o) => o.cle === choisi) ?? onglets.find((o) => o.cle === parDefaut) ?? onglets[0];
  return (
    <div className="space-y-2 border-t border-border/70 pt-2.5">
      <div role="tablist" aria-label="Étapes du poste" className="grid gap-1" style={{ gridTemplateColumns: `repeat(${onglets.length}, minmax(0, 1fr))` }}>
        {onglets.map((o) => {
          const s = STYLE_ETAPE[o.etat];
          const selectionne = o.cle === actif.cle;
          return (
            <button
              key={o.cle} type="button" role="tab" aria-selected={selectionne} aria-label={`${o.libelle} : ${s.dit}`}
              onClick={() => setChoisi(o.cle)}
              className={cn(
                "flex min-h-10 min-w-0 items-center gap-1 rounded-b-md border-t-[3px] px-1.5 py-1.5 text-left text-xs transition-colors",
                s.barre, s.texte, selectionne ? "bg-secondary/70" : "hover:bg-secondary/40",
              )}
            >
              {s.icone}
              <span className="truncate">
                <span className="sm:hidden">{o.court ?? o.libelle}</span>
                <span className="hidden sm:inline">{o.libelle}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={actif.libelle}>{actif.contenu}</div>
    </div>
  );
}

/**
 * TRANCHER UN POSTE — trois temps, une boîte.
 *  - `OPERATIONS` : la Direction des opérations valide (premier temps) ;
 *  - `MARKETING` : la Direction Marketing valide ET fixe le montant accordé ET choisit le budget
 *    (`decideAdProItem` exige le budget à l'accord) ;
 *  - `STOCK` : la décision unique du matériel du stock.
 * Renvoyer et refuser exigent un motif à chaque temps.
 */
function BoiteDecision({ item, mode, budgetOptions, busy, run, fdOf, onCancel, revoir = false, accordSeul = false }: {
  item: ItemRow; mode: "OPERATIONS" | "MARKETING" | "STOCK"; budgetOptions: { id: string; label: string }[];
  busy: string | null; run: Run; fdOf: (extra?: Record<string, string>) => FormData; onCancel: () => void;
  /** REVOIR UNE DÉCISION DÉJÀ PRISE (audit R12) : la décision d'hier reste à l'historique. */
  revoir?: boolean;
  /** UN BC ÉTABLI DANS LEGAL lit sa validation sur ce poste : seul l'accord se redonne. */
  accordSeul?: boolean;
}) {
  const [note, setNote] = React.useState("");
  const montantDepart = item.amountGranted ?? item.amountEstimated;
  const [montant, setMontant] = React.useState(montantDepart != null ? String(montantDepart) : "");
  const [budget, setBudget] = React.useState(item.budgetCategoryId ?? "");
  const occupe = busy === `dec:${item.id}`;
  const offrir = (s: AdProItemStatus) => (!revoir || item.status !== s) && (!accordSeul || s === "APPROVED");
  const marketing = mode === "MARKETING";
  const montantOk = Number(montant.replace(",", ".")) > 0;
  const accordPret = !marketing || (montantOk && Boolean(budget));
  const decider = (decision: AdProItemStatus, ok: string) => void run(`dec:${item.id}`, () => decideAdProItem(undefined, fdOf({
    decision, note: note.trim(),
    ...(marketing && decision === "APPROVED" ? { amountGranted: montant.replace(",", "."), budgetCategoryId: budget } : {}),
  })), ok);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5">
      {revoir && (
        <p className="text-xs text-muted-foreground">
          Revoir la décision ({ITEM_STATUS_LABELS[item.status].label.toLowerCase()}) — elle reste à l&apos;historique ; le demandeur est prévenu.
        </p>
      )}
      {accordSeul && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Un bon de commande est déjà établi dans Legal ({item.bcEtablis.join(", ")}) : pour refuser ou renvoyer ce poste, annulez d&apos;abord la demande de BC
          {item.refusAnnulationBc ? ` — ${item.refusAnnulationBc}` : " (« Annuler la demande de BC » l'annule avec elle)."}
        </p>
      )}
      {marketing && offrir("APPROVED") && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Montant accordé (DZD)
            <input
              type="number" inputMode="decimal" min="0" step="0.01" name="amountGranted" value={montant} onChange={(e) => setMontant(e.target.value)}
              aria-label="Montant accordé à ce poste"
              className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base tabular-nums outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm"
            />
          </label>
          <label className="text-xs">
            Budget
            <select
              value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget qui portera ce poste"
              className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm"
            >
              <option value="">Choisir le budget…</option>
              {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        </div>
      )}
      <input
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Motif (obligatoire pour renvoyer ou refuser)"
        aria-label="Motif de la décision sur le poste"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        {offrir("APPROVED") && (
          <BoutonDecisif
            size="sm" className="max-sm:w-full" disabled={occupe || !accordPret}
            title={!accordPret ? "Indiquez le montant accordé et choisissez le budget." : mode === "STOCK" ? "Accorder réserve le matériel au magasin." : undefined}
            onClick={() => decider("APPROVED", mode === "OPERATIONS" ? "Validé — transmis au second temps." : mode === "STOCK" ? "Poste accordé — le matériel est réservé au magasin." : "Poste accordé.")}
          >
            <ThumbsUp className="h-4 w-4" /> {mode === "OPERATIONS" ? "Valider" : mode === "STOCK" ? "Accorder et réserver" : "Accorder"}
          </BoutonDecisif>
        )}
        {offrir("REVISION") && (
          <BoutonDecisif
            size="sm" variant="outline" className="max-sm:w-full" disabled={occupe || !note.trim()}
            title={!note.trim() ? "Indiquez ce qu'il faut revoir" : undefined}
            onClick={() => decider("REVISION", "Renvoyé au demandeur pour correction.")}
          >
            <RotateCcw className="h-4 w-4" /> {mode === "STOCK" ? "Revoir la liste" : "Renvoyer"}
          </BoutonDecisif>
        )}
        {offrir("REJECTED") && (
          <BoutonDecisif
            size="sm" variant="outline" className="text-destructive max-sm:w-full" disabled={occupe || !note.trim()}
            title={!note.trim() ? "Indiquez le motif du refus" : undefined}
            onClick={() => decider("REJECTED", "Poste refusé.")}
          >
            <ThumbsDown className="h-4 w-4" /> Refuser
          </BoutonDecisif>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * LE MESSAGE QUI PART AVEC LA DEMANDE DE BON DE COMMANDE — ce que l'assistante de direction lit pour
 * l'ÉTABLIR. S'il y a plusieurs assistantes, on choisit celle qui l'établira (l'action l'exige).
 */
function DemandeBC({ busy, onSend, onCancel, assistantes, initial = "", bouton = "Envoyer la demande" }: {
  busy: boolean; onSend: (message: string, assistantId: string) => void; onCancel: () => void;
  assistantes: { id: string; name: string }[];
  /** Le message déjà envoyé, quand on CORRIGE une demande en cours (§118.187) — rien à retaper. */
  initial?: string;
  bouton?: string;
}) {
  const [message, setMessage] = React.useState(initial);
  const [assistante, setAssistante] = React.useState("");
  const choix = assistantes.length > 1;
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      {choix && (
        <select
          value={assistante} onChange={(e) => setAssistante(e.target.value)} aria-label="Assistante de direction qui établira le bon de commande"
          className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
        >
          <option value="">Assistante de direction…</option>
          {assistantes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      <textarea
        value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
        placeholder="Contenu du bon de commande, références, coordonnées du fournisseur — ce que l'assistante doit y porter."
        aria-label="Message de la demande d'émission du bon de commande"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" disabled={busy || (choix && !assistante)} title={choix && !assistante ? "Choisissez l'assistante de direction" : undefined} onClick={() => onSend(message, assistante)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {bouton}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/** Le demandeur VÉRIFIE le bon de commande que l'assistante a déposé : l'accepter l'envoie à la suite du circuit. */
function VerifierBC({ demandeId, busy, onDecide, onCancel }: {
  demandeId: string; busy: boolean; onDecide: (accepte: boolean, note: string) => void; onCancel: () => void;
}) {
  const [note, setNote] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      <Link href={`/pieces/${demandeId}`} target="_blank" className="inline-flex items-center gap-1 py-1 font-medium text-primary hover:underline">
        Ouvrir le bon de commande déposé <ExternalLink className="h-3 w-3" />
      </Link>
      <input
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Ce qui ne va pas (obligatoire pour refuser)"
        aria-label="Remarque sur le bon de commande déposé"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        <BoutonDecisif size="sm" className="max-sm:w-full" disabled={busy} onClick={() => onDecide(true, note.trim())}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />} Accepter le BC
        </BoutonDecisif>
        <BoutonDecisif
          size="sm" variant="outline" className="text-destructive max-sm:w-full" disabled={busy || !note.trim()}
          title={note.trim() ? undefined : "Indiquez ce qu'il faut corriger"} onClick={() => onDecide(false, note.trim())}
        >
          <ThumbsDown className="h-4 w-4" /> Refuser
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * DÉPOSER UNE PIÈCE SUR LE POSTE — un devis / une pro forma (`ajouterDevisPoste`), ou la facture qui
 * demande le paiement (`demanderPaiementPoste`). Le fichier est toujours exigé (l'action le refuse aussi).
 */
function FormulairePiece({
  titre, aide, bouton, busy, onSubmit, onCancel, montantInitial, montantMax = null, montantObligatoire = false,
  fournisseurInitial, proforma, freres = [], libelleFichier = "Fichier", fichierObligatoire = true, factureFacultative = false,
  plusieursDevis = false,
}: {
  /**
   * DÉPÔT DE DEVIS : plusieurs fichiers joints d'un coup sont, d'office, PLUSIEURS devis — chacun lu et transformé en lignes
   * (`ajouterDevisPoste`, `unDevisParFichier`). La case se décoche quand les fichiers sont les pages d'un même devis.
   */
  plusieursDevis?: boolean;
  titre: string; aide: string; bouton: string; busy: boolean; onSubmit: (fd: FormData) => void; onCancel: () => void;
  montantInitial: number | null; montantMax?: number | null; montantObligatoire?: boolean;
  /** Ce que le fichier principal EST (« Proforma / lettre de demande de sponsoring » pour un versement à l'association). */
  libelleFichier?: string;
  /** Faux quand la pièce exigée est déjà sur le poste : rien de plus à joindre. */
  fichierObligatoire?: boolean;
  /** Un second fichier, la facture, qu'on peut joindre mais qu'on n'exige pas (sponsoring direct). */
  factureFacultative?: boolean;
  /** Le fournisseur (devis seulement). */
  fournisseurInitial?: string;
  /** Devis : « choix » = case à cocher ; « imposee » = c'est forcément une pro forma (sponsoring direct). */
  proforma?: "choix" | "imposee";
  /** Les autres postes que la même pièce peut couvrir (devis seulement). */
  freres?: PosteFrere[];
}) {
  const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm";
  const [nbFichiers, setNbFichiers] = React.useState(0);
  const [unParFichier, setUnParFichier] = React.useState(true);
  const separes = plusieursDevis && nbFichiers > 1 && unParFichier;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
      className="space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs sm:space-y-2 sm:p-2.5"
    >
      <p className="font-medium text-foreground">{titre}</p>
      <p className="text-muted-foreground">{aide}</p>
      <label className="block">
        {libelleFichier}{fichierObligatoire ? "" : " — déjà sur le poste"}
        <input
          type="file" name="attachment" multiple required={fichierObligatoire} className="mt-1 block w-full text-xs"
          onChange={(e) => setNbFichiers(e.target.files?.length ?? 0)}
        />
      </label>
      {plusieursDevis && nbFichiers > 1 && (
        <label className="inline-flex min-h-9 items-start gap-1.5 sm:min-h-0">
          <input type="checkbox" name="unDevisParFichier" checked={unParFichier} onChange={(e) => setUnParFichier(e.target.checked)} className="mt-0.5" />
          <span>
            Un devis par fichier ({nbFichiers} devis) — chacun est lu et transformé en lignes. Décochez si ces fichiers sont les pages d&apos;un même devis.
          </span>
        </label>
      )}
      {factureFacultative && (
        <label className="block">
          Facture — facultative
          <input type="file" name="facture" multiple className="mt-1 block w-full text-xs" />
        </label>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {/* Plusieurs devis d'un coup : le montant et la référence se lisent sur CHACUN — un champ unique serait faux pour tous. */}
        {!separes && (
          <>
            <label>
              Montant (DZD){montantObligatoire ? "" : " — facultatif"}
              <input
                type="number" inputMode="decimal" name="montant" min="0" step="0.01" required={montantObligatoire}
                max={montantMax ?? undefined} defaultValue={montantInitial ?? ""} className={`${champ} tabular-nums`}
              />
            </label>
            <label>
              Référence — facultatif
              <input name="reference" placeholder="N° de la pièce" className={champ} />
            </label>
          </>
        )}
        {fournisseurInitial !== undefined && (
          <label className="sm:col-span-2">
            Fournisseur — facultatif
            <input name="fournisseur" defaultValue={fournisseurInitial} className={champ} />
          </label>
        )}
      </div>
      {proforma === "imposee" && <input type="hidden" name="proforma" value="on" />}
      {proforma === "choix" && (
        <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
          <input type="checkbox" name="proforma" /> C&apos;est une facture pro forma
        </label>
      )}
      {freres.length > 0 && (
        <fieldset className="rounded-lg border border-border p-2">
          <legend className="px-1 text-muted-foreground">Ce document couvre aussi…</legend>
          <div className="flex flex-col gap-1">
            {freres.map((f) => (
              <label key={f.id} className="inline-flex min-h-9 flex-wrap items-center gap-1.5 sm:min-h-0">
                <input type="checkbox" name="autresPostes" value={f.id} /> {f.label}
                {f.label.trim().toLocaleLowerCase("fr") !== ITEM_KIND_LABELS[f.kind].toLocaleLowerCase("fr") && (
                  <span className="text-muted-foreground">({ITEM_KIND_LABELS[f.kind]})</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} {bouton}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/** Demander un devis (ou réclamer la facture) à l'assistante — le message part AVEC la demande. */
function DemandeSecretariat({ nature, busy, onSend, onCancel }: {
  nature: NaturePieceSecretariat; busy: boolean; onSend: (message: string) => void; onCancel: () => void;
}) {
  const [message, setMessage] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      <textarea
        value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
        placeholder={PIECE_SECRETARIAT[nature].aide}
        aria-label={`Message de la demande de ${PIECE_SECRETARIAT[nature].libelle.toLowerCase()}`}
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" disabled={busy} onClick={() => onSend(message)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer à l&apos;assistante
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * UN GESTE QUI EXIGE UN MOTIF — retirer une demande de BC, annuler un ordre, demander une révision
 * (§118.187). Le motif est ce que lira la personne d'en face : le bouton reste fermé tant qu'il est vide,
 * et l'action le refuse aussi (un formulaire se forge).
 */
function GesteAvecMotif({ titre, aide, bouton, danger = false, busy, extra, onSend, onCancel }: {
  titre: string; aide: string; bouton: string; danger?: boolean; busy: boolean;
  /** Un second champ facultatif (une nouvelle estimation). */
  extra?: { nom: string; libelle: string };
  onSend: (motif: string, extra: string) => void; onCancel: () => void;
}) {
  const [motif, setMotif] = React.useState("");
  const [valeur, setValeur] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      <p className="font-medium text-foreground">{titre}</p>
      <p className="text-muted-foreground">{aide}</p>
      <textarea
        value={motif} onChange={(e) => setMotif(e.target.value)} rows={2}
        placeholder="Motif (obligatoire)"
        aria-label={`Motif — ${titre}`}
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      {extra && (
        <input
          type="number" inputMode="decimal" min={0} step="any" value={valeur} onChange={(e) => setValeur(e.target.value)}
          placeholder={extra.libelle} aria-label={extra.libelle}
          className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
        />
      )}
      <div className={RANGEE_ACTIONS}>
        <BoutonDecisif
          size="sm" variant={danger ? "outline" : "primary"} className={danger ? "text-destructive max-sm:w-full" : "max-sm:w-full"}
          disabled={busy || !motif.trim()} title={motif.trim() ? undefined : "Indiquez le motif"}
          onClick={() => onSend(motif.trim(), valeur.trim())}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {bouton}
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={onCancel}>Retour</Button>
      </div>
    </div>
  );
}

/** Le centre de validation Ad & Pro vise le bon de commande — un refus porte son motif. */
function VisaBC({ busy, onDecide, onCancel }: { busy: boolean; onDecide: (decision: "APPROVE" | "REFUSE", note: string) => void; onCancel: () => void }) {
  const [note, setNote] = React.useState("");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2 sm:flex-row sm:flex-wrap sm:items-center">
      <BoutonDecisif size="sm" className="max-sm:w-full" disabled={busy} onClick={() => onDecide("APPROVE", note)}>
        <ThumbsUp className="h-4 w-4" /> Valider le BC
      </BoutonDecisif>
      <BoutonDecisif
        size="sm" variant="outline" className="text-destructive max-sm:w-full" disabled={busy || !note.trim()}
        title={note.trim() ? undefined : "Indiquez le motif du refus dans le champ ci-dessous."}
        onClick={() => onDecide("REFUSE", note)}
      >
        <ThumbsDown className="h-4 w-4" /> Refuser
      </BoutonDecisif>
      <input
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Motif (obligatoire pour refuser)"
        aria-label="Motif de la décision sur le bon de commande"
        className="order-first min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-2 text-base outline-none focus:border-primary/60 sm:order-none sm:py-1 sm:text-xs"
      />
      <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
    </div>
  );
}

/** Saisie du montant affecté, validée à la sortie du champ — pas de bouton par ligne. */
function AllocateField({ itemId, current, busy, onSave }: { itemId: string; current: number | null; busy: boolean; onSave: (v: string) => void }) {
  const [value, setValue] = React.useState(current != null ? String(current) : "");
  React.useEffect(() => { setValue(current != null ? String(current) : ""); }, [current]);

  return (
    <label className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      Montant accordé :
      <input
        type="number" inputMode="decimal" min="0" step="0.01" value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== (current != null ? String(current) : "")) onSave(value); }}
        aria-label={`Montant affecté au poste ${itemId}`}
        className="w-36 rounded-lg border border-border bg-background px-2 py-2 text-base tabular-nums outline-none focus:border-primary/60 sm:w-32 sm:py-1 sm:text-sm"
      />
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      <span className="text-xs">DZD</span>
    </label>
  );
}

// ─────────────────────────────── Répartir un sponsoring indirect ───────────────────────────────

interface LigneSaisie { kind: string; montant: string; precision: string; payeA: string }
const ligneVide = (): LigneSaisie => ({ kind: "", montant: "", precision: "", payeA: "" });

/**
 * LES NATURES D'UN SPONSORING INDIRECT — une ligne par nature, le total sous les yeux (§118.175).
 * Le formulaire envoie un JSON (`repartition`) : des clés `ligne-3-montant` rendraient l'action
 * illisible à la dérivation des contrats (§118.73).
 */
function EditeurRepartition({ origine }: { origine?: number | null }) {
  const [lignes, setLignes] = React.useState<LigneSaisie[]>([ligneVide(), ligneVide()]);
  const total = lignes.reduce((s, l) => {
    const n = Number(l.montant.replace(/\s/g, "").replace(",", "."));
    return s + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  const maj = (i: number, champ: keyof LigneSaisie, v: string) => setLignes((ls) => ls.map((l, j) => (j === i ? { ...l, [champ]: v } : l)));
  const champ = "w-full rounded-lg border border-border bg-background px-2 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm";
  return (
    <div className="space-y-2">
      <input type="hidden" name="repartition" value={JSON.stringify(lignes)} />
      <p className="text-xs text-muted-foreground">
        Donnez la ou les natures et leur montant — par exemple <strong>imprimerie 400 000</strong> et <strong>hôtellerie 600 000</strong>.
        Chaque nature devient un poste, qui se valide, se commande et se paie à part.
      </p>
      {lignes.map((l, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1.2fr_0.8fr_1fr_1fr_auto]">
          <select value={l.kind} onChange={(e) => maj(i, "kind", e.target.value)} aria-label={`Prise en charge ${i + 1}`} className={champ}>
            <option value="">— Prise en charge —</option>
            {NATURES_REPARTITION.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
          <input value={l.montant} onChange={(e) => maj(i, "montant", e.target.value)} inputMode="decimal" placeholder="Montant DZD" aria-label={`Montant ${i + 1}`} className={`${champ} tabular-nums`} />
          <input value={l.precision} onChange={(e) => maj(i, "precision", e.target.value)} placeholder="Précision (facultatif)" aria-label={`Précision ${i + 1}`} className={champ} />
          <input value={l.payeA} onChange={(e) => maj(i, "payeA", e.target.value)} placeholder="Fournisseur (facultatif)" aria-label={`Fournisseur ${i + 1}`} className={champ} />
          <button
            type="button" disabled={lignes.length <= 1}
            onClick={() => setLignes((ls) => ls.filter((_, j) => j !== i))}
            aria-label={`Retirer la ligne ${i + 1}`}
            className="inline-flex items-center justify-center justify-self-end rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 sm:justify-self-auto sm:p-1.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button" onClick={() => setLignes((ls) => [...ls, ligneVide()])}
          className="inline-flex h-10 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-primary/50 px-3 text-sm font-medium text-primary hover:bg-primary/5 sm:h-8 sm:w-auto sm:text-xs"
        >
          <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> Ajouter une nature
        </button>
        <span className="ml-auto text-muted-foreground">
          Total : <strong className="tabular-nums text-foreground">{formatCurrency(total)}</strong>
          {origine != null && Math.round(origine) !== Math.round(total) && total > 0 && (
            <> — le poste portait <span className="tabular-nums">{formatCurrency(origine)}</span></>
          )}
        </span>
      </div>
    </div>
  );
}

function FormulaireRepartition({ origine, busy, onSubmit, onCancel }: {
  origine: number | null; busy: boolean; onSubmit: (fd: FormData) => void; onCancel: () => void;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <EditeurRepartition origine={origine} />
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />} Répartir
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

// ─────────────────────────────── Ajouter / modifier ───────────────────────────────

function AddItemForm({ parent, parentId, decided, busy, onCancel, onSubmit }: {
  parent: AdProParent; parentId: string; decided: boolean; busy: boolean; onCancel: () => void; onSubmit: (fd: FormData) => void;
}) {
  // « MATÉRIEL DU STOCK » n'a ni fournisseur, ni montant, ni nature de budget (§118.167) : ces
  // champs disparaissent quand on la choisit — les envoyer quand même ferait refuser l'ajout.
  // « SPONSORING INDIRECT » se donne en NATURES (§118.175) : le montant unique cède la place à la
  // répartition, qui crée un poste par nature.
  const [nature, setNature] = React.useState<AdProItemKind>("STAND");
  const stock = nature === NATURE_MATERIEL_STOCK;
  const indirect = nature === "INDIRECT_SUPPORT";
  // LES FICHES SAISIES AVEC LE POSTE (Direction, 10/2026) : billetterie → voyageurs, hôtellerie → personnes logées.
  const natureFiches = porteDesVoyageurs(nature) ? "VOYAGEUR" as const : porteDesHebergements(nature) ? "HEBERGEMENT" as const : null;
  const [fiches, setFiches] = React.useState<FicheBrouillon[]>([]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (natureFiches) joindreFichiersDesFiches(fd, fiches, natureFiches);
        onSubmit(fd);
      }}
      className="space-y-2 rounded-xl border border-border p-3"
    >
      <input type="hidden" name="parent" value={parent} />
      <input type="hidden" name="parentId" value={parentId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Nature
          <select
            name="kind" value={nature} onChange={(e) => { setNature(e.target.value as AdProItemKind); setFiches([]); }}
            className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm"
          >
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="text-xs">
          Libellé
          <input
            name="label" required
            placeholder={stock ? "Matériel du stand — congrès SAHO" : indirect ? "Sponsoring indirect — congrès SAHO" : "Stand 12 m² — hall B"}
            className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm"
          />
        </label>
        {!stock && !indirect && (
          <>
            <label className="text-xs">
              Payé à
              <input name="supplier" placeholder="Organisateur, agence, association…" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm" />
            </label>
            <label className="text-xs">
              Montant estimé (DZD)
              <input name="amountEstimated" type="number" inputMode="decimal" min="0" step="0.01" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base tabular-nums outline-none focus:border-primary/60 sm:text-sm" />
            </label>
          </>
        )}
      </div>

      {indirect && <EditeurRepartition />}

      {natureFiches && <FichesNouveauPoste key={natureFiches} nature={natureFiches} fiches={fiches} onChange={setFiches} />}

      {stock && (
        <p className="rounded-lg bg-secondary/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          Vous listerez ensuite les articles du magasin et leurs quantités. Rien n&apos;en sort avant l&apos;accord du poste ;
          après l&apos;événement, vous direz ce qui a été remis, et le reste reviendra au magasin.
        </p>
      )}

      {/* LA question à poser au moment de l'ajout : cet argent est-il déjà accordé, ou en plus ? */}
      {!stock && (
        <fieldset className="rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs text-muted-foreground">Ce poste est-il déjà couvert par le budget accordé ?</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="INCLUDED" defaultChecked /> Inclus dans le budget accordé
            </label>
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="ADDITIONAL" /> Budget supplémentaire (rallonge)
            </label>
          </div>
        </fieldset>
      )}
      <label className="block text-xs">
        Précisions
        <input name="notes" placeholder="Facultatif" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm" />
      </label>

      {decided && !stock && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          L&apos;opération est déjà tranchée : ce poste sera marqué « ajouté après décision ». S&apos;il
          est <strong>inclus</strong> dans le budget accordé, il fera apparaître un dépassement tant
          qu&apos;il n&apos;est pas compensé ; s&apos;il s&apos;agit d&apos;une <strong>rallonge</strong>, il sera compté à part.
        </p>
      )}

      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/**
 * MODIFIER UN POSTE — ce qui le DÉCRIT, pas ce qui l'engage.
 *
 * Ces champs ne portent aucun engagement financier — seul le montant AFFECTÉ a été transmis aux
 * Finances, et lui seul se verrouille avec l'ordre de dépense. La nature de budget (inclus /
 * rallonge) reste modifiable tant que la Direction n'a pas tranché : après, c'est sur quoi elle
 * s'est prononcée.
 */
function EditItemForm({ item, busy, onCancel, onSave }: {
  item: ItemRow; busy: boolean; onCancel: () => void; onSave: (fd: FormData) => void;
}) {
  const budgetLocked = budgetKindLocked(item);
  const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm";
  // UN POSTE « MATÉRIEL DU STOCK » ne se décrit que par son libellé et ses précisions : ni montant,
  // ni fournisseur, ni nature de budget — et sa nature ne change plus hors d'un brouillon vierge
  // (`refusChangementNature`). Son matériel se compose dans son propre bloc.
  if (estPosteStock(item)) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); onSave(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <label className="block text-xs">Libellé<input name="label" required defaultValue={item.label} className={champ} /></label>
        <label className="block text-xs">Précisions<input name="notes" defaultValue={item.notes ?? ""} placeholder="Facultatif" className={champ} /></label>
        <div className={RANGEE_ACTIONS}>
          <Button size="sm" type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
          <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
        </div>
      </form>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Nature
          <select name="kind" defaultValue={item.kind} className={champ}>
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="text-xs">Libellé<input name="label" required defaultValue={item.label} className={champ} /></label>
        <label className="text-xs">Payé à<input name="supplier" defaultValue={item.supplier ?? ""} placeholder="Organisateur, agence, association…" className={champ} /></label>
        <label className="text-xs">
          Montant estimé (DZD)
          <input name="amountEstimated" type="number" inputMode="decimal" min="0" step="0.01" defaultValue={item.amountEstimated ?? ""} className={`${champ} tabular-nums`} />
        </label>
      </div>
      <label className="block text-xs">Précisions<input name="notes" defaultValue={item.notes ?? ""} placeholder="Facultatif" className={champ} /></label>

      {budgetLocked ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          La Direction a tranché : la nature du budget ({ITEM_BUDGET_KIND_LABELS[item.budgetKind]}) ne change plus —
          c&apos;est sur elle qu&apos;elle s&apos;est prononcée.
        </p>
      ) : (
        <fieldset className="rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs text-muted-foreground">Ce poste est-il couvert par le budget accordé ?</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="INCLUDED" defaultChecked={item.budgetKind === "INCLUDED"} /> Inclus dans le budget accordé
            </label>
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="ADDITIONAL" defaultChecked={item.budgetKind === "ADDITIONAL"} /> Budget supplémentaire (rallonge)
            </label>
          </div>
        </fieldset>
      )}

      {item.expenseOrderId && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-muted-foreground">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warning" />
          Un ordre de dépense a été émis : le <strong>montant affecté</strong> ne change plus. Le reste se corrige librement.
        </p>
      )}

      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "success" }) {
  const cls = tone === "danger" ? "text-destructive" : tone === "success" ? "text-success" : "";
  return (
    <div className="min-w-0 rounded-lg border border-border px-2.5 py-2 sm:px-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums [overflow-wrap:anywhere] sm:text-base ${cls}`}>{value}</p>
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}
