/**
 * LE CONTRÔLE DU LIVRE — ce qui manque, et ce qui est sorti deux fois.
 *
 * ── LES DEUX QUESTIONS, ET ELLES NE SE CONFONDENT PAS ───────────────────────────────────────
 *
 * 1. **TOUT PAIEMENT EST-IL COMPTABILISÉ ?** Un ordre réglé sans écriture de trésorerie est de
 *    l'argent sorti que le livre ignore : le solde bancaire ne correspondra plus, et l'on
 *    cherchera l'écart des semaines plus tard, sur un mois entier.
 * 2. **QUELQUE CHOSE EST-IL SORTI DEUX FOIS ?** Un même fournisseur payé deux fois pour la même
 *    facture ne se voit pas dans un livre de trois mille lignes : les deux écritures sont
 *    régulières, chacune prise isolément.
 *
 * ── CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS ──────────────────────────────────────────
 *
 * Il SIGNALE, il ne corrige pas et il n'accuse pas. Un doublon apparent peut être deux règlements
 * légitimes du même montant au même fournisseur le même jour — cela arrive (deux factures d'un
 * même prestataire, deux avances au même montant). Supprimer automatiquement l'un des deux
 * effacerait une écriture vraie ; refuser l'écriture au moment de la saisie bloquerait un cas
 * réel. On rend donc des SOUPÇONS, nommés, avec de quoi trancher — et un humain tranche.
 *
 * C'est la raison pour laquelle il n'existe aucune fonction « supprimer les doublons » ici. Elle
 * serait appelée un jour, sur un lot qu'on n'aurait pas relu.
 *
 * ── POURQUOI CES CRITÈRES-LÀ ────────────────────────────────────────────────────────────────
 *
 * Le soupçon le plus SÛR n'est pas la ressemblance de deux écritures : c'est **une même dépense
 * d'origine réglée par deux ordres**. Le cas est réel et connu — le matériel promotionnel émet un
 * ordre au bordereau de paiement, puis un second au règlement final : deux ordres légitimes pour
 * un même dossier, qui deviennent un double paiement si le premier n'était pas un acompte. On le
 * remonte donc en tête, avec les deux références.
 *
 * Vient ensuite la RESSEMBLANCE EXACTE — même sens, même montant, même contrepartie, même jour.
 * Le même montant à un jour d'intervalle n'est PAS retenu : le bruit noierait le signal, et un
 * contrôle qui crie tous les jours est un contrôle qu'on désactive.
 *
 * Module PUR : ni base, ni session. Testé.
 */
import { formatMontant } from "@/lib/utils";

export interface LedgerEntry {
  id: string;
  reference: string;
  /** `IN` (encaissement) ou `OUT` (décaissement). */
  direction: string;
  amount: number;
  label: string;
  counterparty: string | null;
  /** Date de l'écriture, ISO ou `Date`. */
  date: Date | string;
}

export interface SettledOrder {
  id: string;
  reference: string;
  label: string;
  amount: number;
  /** L'écriture de trésorerie née du règlement — `null` = paiement NON comptabilisé. */
  transactionId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  paidDate: Date | string | null;
}

/** Un soupçon, sa gravité, et de quoi le trancher. */
export interface LedgerFinding {
  kind: "MISSING_ENTRY" | "DOUBLE_ORDER" | "DUPLICATE_ENTRY";
  /** `HIGH` = de l'argent peut manquer ou être sorti deux fois. `INFO` = à vérifier. */
  severity: "HIGH" | "INFO";
  title: string;
  detail: string;
  /** Les références concernées — c'est par elles qu'on retrouve les pièces. */
  references: string[];
  amount: number;
}

const jour = (d: Date | string | null | undefined): string => {
  if (!d) return "";
  const v = d instanceof Date ? d : new Date(d);
  return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
};

const money = (n: number): string => `${formatMontant(n)} DZD`;

/**
 * UN PAIEMENT SANS ÉCRITURE — le premier contrôle, et le plus grave.
 *
 * L'ordre est marqué réglé, l'argent est sorti, et le livre n'en sait rien. Ce n'est pas une
 * erreur d'affichage : c'est un écart bancaire qui grossira jusqu'à ce que quelqu'un rapproche
 * le relevé, à la main, sur un mois entier.
 *
 * Un ordre dont `transactionId` pointe une écriture DISPARUE compte pareil : la référence existe,
 * l'écriture non — et c'est plus trompeur encore qu'un champ vide, puisque tout a l'air en ordre.
 */
export function missingEntries(orders: readonly SettledOrder[], ledgerIds: ReadonlySet<string>): LedgerFinding[] {
  return orders
    .filter((o) => !o.transactionId || !ledgerIds.has(o.transactionId))
    .map((o) => ({
      kind: "MISSING_ENTRY" as const,
      severity: "HIGH" as const,
      title: `${o.reference} — réglé, mais aucune écriture au livre`,
      detail: `${o.label} · ${money(o.amount)}${o.paidDate ? ` · réglé le ${jour(o.paidDate).split("-").reverse().join("/")}` : ""}. L'argent est sorti et la comptabilité ne le porte pas.`,
      references: [o.reference],
      amount: o.amount,
    }));
}

/** Une remise de caisse d'avance — de l'argent qui quitte la banque pour alimenter un fond. */
export interface CashRemittance {
  id: string;
  label: string;
  amount: number;
  transactionId: string | null;
  date: Date | string | null;
}

/**
 * UNE CAISSE REMISE SANS ÉCRITURE — le même défaut, par une autre porte.
 *
 * Les DÉPENSES d'une caisse d'avance étaient suivies (ligne de budget du département) ; la SORTIE
 * qui fait exister le fond, elle, ne l'était pas. Le solde comptable et le solde bancaire
 * divergeaient d'autant, et l'écart ne se découvrait qu'au rapprochement.
 *
 * Les remises ANTÉRIEURES à la règle n'ont pas d'écriture et n'en auront pas d'office : on
 * n'invente pas rétroactivement une écriture datée dans un livre comptable. On les NOMME, et un
 * humain les passe en connaissance de cause.
 */
export function missingCashEntries(remittances: readonly CashRemittance[], ledgerIds: ReadonlySet<string>): LedgerFinding[] {
  return remittances
    .filter((r) => !r.transactionId || !ledgerIds.has(r.transactionId))
    .map((r) => ({
      kind: "MISSING_ENTRY" as const,
      severity: "HIGH" as const,
      title: `${r.label} — caisse remise, aucune écriture au livre`,
      detail: `${money(r.amount)}${r.date ? ` · remis le ${jour(r.date).split("-").reverse().join("/")}` : ""}. La somme a quitté la banque et la comptabilité ne la porte pas.`,
      references: [r.label],
      amount: r.amount,
    }));
}

/**
 * UNE MÊME DÉPENSE RÉGLÉE PAR DEUX ORDRES — le soupçon le plus sûr.
 *
 * Deux ordres réglés pointant la même origine. Ce n'est pas toujours une faute : un dossier peut
 * légitimement connaître un acompte puis un solde. Mais c'est le seul endroit où l'on peut
 * DÉSIGNER la dépense payée deux fois, plutôt que deviner d'après des montants qui se ressemblent.
 */
export function doubleSettledSources(orders: readonly SettledOrder[]): LedgerFinding[] {
  const groupes = new Map<string, SettledOrder[]>();
  for (const o of orders) {
    if (!o.sourceType || !o.sourceId) continue;
    const cle = `${o.sourceType}:${o.sourceId}`;
    const bucket = groupes.get(cle);
    if (bucket) bucket.push(o); else groupes.set(cle, [o]);
  }
  const out: LedgerFinding[] = [];
  for (const [, list] of groupes) {
    if (list.length < 2) continue;
    const total = list.reduce((a, o) => a + o.amount, 0);
    out.push({
      kind: "DOUBLE_ORDER",
      severity: "HIGH",
      title: `${list.length} règlements pour la même dépense`,
      detail: `${list.map((o) => `${o.reference} (${money(o.amount)})`).join(" · ")} — total ${money(total)}. Acompte puis solde, ou paiement en double : à trancher sur pièces.`,
      references: list.map((o) => o.reference),
      amount: total,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * DEUX ÉCRITURES IDENTIQUES LE MÊME JOUR — même sens, même montant, même contrepartie.
 *
 * Le critère est volontairement ÉTROIT. Élargir à « le même montant cette semaine » remonterait
 * les loyers, les abonnements et les salaires : le contrôle crierait tous les jours, et l'on
 * apprendrait à ne plus le lire. Une contrepartie VIDE n'est pas rapprochée d'une autre
 * contrepartie vide — deux écritures anonymes du même montant ne prouvent rien.
 */
export function duplicateEntries(entries: readonly LedgerEntry[]): LedgerFinding[] {
  const groupes = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const tiers = (e.counterparty ?? "").trim().toLowerCase();
    if (!tiers) continue;
    const cle = `${e.direction}|${e.amount}|${tiers}|${jour(e.date)}`;
    const bucket = groupes.get(cle);
    if (bucket) bucket.push(e); else groupes.set(cle, [e]);
  }
  const out: LedgerFinding[] = [];
  for (const [, list] of groupes) {
    if (list.length < 2) continue;
    const e = list[0];
    out.push({
      kind: "DUPLICATE_ENTRY",
      severity: "INFO",
      title: `${list.length} écritures identiques — ${e.counterparty}`,
      detail: `${money(e.amount)} le ${jour(e.date).split("-").reverse().join("/")}, ${e.direction === "OUT" ? "au débit" : "au crédit"} : ${list.map((x) => x.reference).join(" · ")}. Deux factures du même montant le même jour existent — à vérifier, pas à supprimer.`,
      references: list.map((x) => x.reference),
      amount: e.amount * (list.length - 1),
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export interface LedgerAudit {
  findings: LedgerFinding[];
  /** Combien d'argent est en jeu sur les soupçons GRAVES — c'est ce chiffre qui décide d'agir. */
  atRisk: number;
  /** Rien à signaler ? On le dit aussi : un écran muet se lit comme un écran en panne. */
  clean: boolean;
}

/**
 * LE CONTRÔLE COMPLET, dans l'ordre où il faut le lire : ce qui manque au livre d'abord, la
 * même dépense payée deux fois ensuite, les ressemblances en dernier.
 */
export function auditLedger(
  orders: readonly SettledOrder[],
  entries: readonly LedgerEntry[],
  remittances: readonly CashRemittance[] = [],
): LedgerAudit {
  const ledgerIds = new Set(entries.map((e) => e.id));
  const findings = [
    ...missingEntries(orders, ledgerIds),
    ...missingCashEntries(remittances, ledgerIds),
    ...doubleSettledSources(orders),
    ...duplicateEntries(entries),
  ];
  const atRisk = findings.filter((f) => f.severity === "HIGH").reduce((a, f) => a + f.amount, 0);
  return { findings, atRisk, clean: findings.length === 0 };
}

/** Ce que l'écran écrit en tête du contrôle. */
export function auditSummary(a: LedgerAudit): string {
  if (a.clean) return "Aucun écart : chaque règlement porte son écriture, et rien n'est sorti deux fois.";
  const graves = a.findings.filter((f) => f.severity === "HIGH").length;
  const infos = a.findings.length - graves;
  const morceaux: string[] = [];
  if (graves > 0) morceaux.push(`${graves} écart${graves > 1 ? "s" : ""} à traiter (${money(a.atRisk)} en jeu)`);
  if (infos > 0) morceaux.push(`${infos} ressemblance${infos > 1 ? "s" : ""} à vérifier`);
  return morceaux.join(" · ");
}
