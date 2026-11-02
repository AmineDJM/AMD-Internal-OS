"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Plus, CheckCircle2, XCircle, AlertTriangle, Split } from "lucide-react";
import type { AdProItemKind, AdProItemStatus, AdProItemBudgetKind, AdProItemOrderStage } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { breakdown, plannedGaps, type AdProParent } from "../domaine/postes";
import { addAdProItem } from "../actions-postes";
import type { DroitsValidation } from "../domaine/validation-poste";
import { kindLabel } from "../domaine/unified";
import type { NaturePieceSecretariat } from "../domaine/pieces-secretariat";
import { grouperParRepartition } from "../domaine/poste-etapes";
import type { LigneStockVue, ContexteMaterielStock } from "./materiel-stock";
import type { VoyageurVue } from "./voyageurs-bloc";
import type { HebergementVue } from "./hebergements-bloc";
import type { EnvoiVue } from "@/lib/reservation-fiche/etat";
import type { PiecesDuPoste, DemandeBCDuPoste } from "../infra/pieces-poste";
import type { DevisDePosteVue } from "../infra/requetes/devis-poste";
import { ancrePoste } from "@/lib/chemins/ad-pro";
import type { EtatPorteDg } from "@/lib/seuils/porte-dg-total";
import { CartePorteDg } from "./porte-dg-carte";
import { PosteCarte } from "./postes/poste-carte";
import { estPosteStock, RAFRAICHISSEMENT } from "./postes/elements";
import { AddItemForm, Figure } from "./postes/formulaires";

export type { LigneStockVue } from "./materiel-stock";

export type { VoyageurVue } from "./voyageurs-bloc";

export type { HebergementVue } from "./hebergements-bloc";

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

export type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;

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
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText) : (r.error ?? "Le geste n'a pas abouti.") });
      if (r.ok) rafraichir();
    } catch {
      // Une action qui LÈVE (connexion coupée, redéploiement) se dit ; elle ne remonte plus nue.
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
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
            onSubmit={(fd) => void run("add", () => addAdProItem(undefined, fd).then((r) => {
              if (r.ok) setAdding(false);
              return r;
            }), "Poste ajouté.")}
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
