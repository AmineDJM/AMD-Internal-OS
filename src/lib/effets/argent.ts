import type { Prisma } from "@prisma/client";
import type { DetailEffet } from "./annulation";
import { infoModele, type InfoModele } from "./modeles";
import { valeurLisible } from "./valeurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARGENT NE S'EFFACE PAS : IL SE COMPENSE (lot K10a, décision 0040) — la politique « argent » de l'annulation J7.
 *
 * « Toutes les actions sont réversibles » (Direction, 31/10/2026). Pour l'argent, réversible ne veut jamais dire
 * effacé : une écriture de trésorerie est un fait du livre. Défaire le geste qui l'a posée écrit une ligne DE PLUS,
 * datée du jour et liée à la première (`compensationDeId`) :
 *
 *   • une écriture PRÉVUE (`PENDING`) n'a rien changé au solde : elle passe à `CANCELLED` (la trace reste) ;
 *   • une écriture RÉALISÉE posée par une saisie (saisie, encaissement rapide, import, facture) est CONTRE-PASSÉE :
 *     même sens, montant opposé — le solde revient à l'euro (au dinar) près, les deux lignes restent ;
 *   • un DÉCAISSEMENT posé par un PAIEMENT (un ordre, une facture, une paie passés à « payé » dans le même geste) a
 *     pu réellement partir : il reste au livre, et une écriture « À RÉCUPÉRER » (encaissement prévu, même compte, même
 *     montant) naît à côté. Recouvré — ou s'il n'était jamais parti — on la passe à « réalisé » : elle le neutralise.
 *     Le statut « payé » de l'ordre, lui, revient à sa valeur d'avant (il est de nouveau dû) : c'est la levée du
 *     refus « PAIEMENT_EXECUTE » de J7, pour les seuls modèles d'argent, quand le geste est un paiement.
 *
 * Et rien n'est perdu à l'envers : l'annulation est elle-même journalisée (`annulation.ts`), et la défaire — rétablir —
 * contre-passe la contre-passation, annule l'« à récupérer », remet « payé ». On n'écrit jamais qu'une ligne de plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les modèles d'ARGENT dont un statut « payé » se remet quand le geste est défait (l'argent, lui, se compense). */
export const MODELES_ARGENT: ReadonlySet<string> = new Set([
  "ExpenseOrder", "FinanceTransaction", "LegalDocument", "PayrollEntry", "PayrollWire", "PettyCashAllotment", "PettyCashTopUpRequest",
  "PaymentRequest", "PaymentPiece", "DepartmentBudgetExpense", "SalaryAdvance", "AdProItem", "BudgetProposal", "PchFournisseurProduit",
]);

const PAYE = /^(PAID|PAYE|PAYEE|SETTLED|REGLE|REGLEE|VERSE|VERSEE)$/;

/** Un geste est un PAIEMENT quand un modèle d'argent y passe à « payé » (statut, ou date de paiement posée). */
export function gesteDePaiement(effets: readonly { type: string; modele: string | null; operation: string | null; champs: string[]; apres: unknown; avant: unknown }[]): boolean {
  return effets.some((e) => {
    if (e.type !== "ECRITURE" || e.operation !== "UPDATE" || !e.modele || e.modele === "FinanceTransaction" || !MODELES_ARGENT.has(e.modele)) return false;
    const apres = (e.apres ?? {}) as Record<string, unknown>;
    const avant = (e.avant ?? {}) as Record<string, unknown>;
    return e.champs.some((c) => (/^(status|statut)$/.test(c) && PAYE.test(String(apres[c] ?? "")))
      || (/^(paidDate|paidAt|payeLe)$/.test(c) && avant[c] == null && apres[c] != null));
  });
}

export interface OutilsArgent {
  effetId: string;
  quoi: string;
  appliquer: boolean;
  paiement: boolean;
  acteurId: string;
  lire: (info: InfoModele, id: string) => Promise<Record<string, unknown> | null>;
  ecrireVerrouille: (info: InfoModele, id: string, verifier: (relue: Record<string, unknown> | null) => boolean, ecrire: (t: Record<string, unknown>) => Promise<unknown>) => Promise<boolean>;
}

type Tx = Prisma.TransactionClient;
const SUFFIXE = { CONTRE_PASSATION: "CP", A_RECUPERER: "AR" } as const;

async function referenceLibre(t: Tx, base: string): Promise<string> {
  for (let i = 1; i < 50; i += 1) {
    const ref = i === 1 ? base : `${base}${i}`;
    if (!(await t.financeTransaction.count({ where: { reference: ref } }))) return ref;
  }
  return `${base}-${Date.now()}`;
}

/**
 * UNE ÉCRITURE DE TRÉSORERIE CRÉÉE PAR LE GESTE — jamais retirée : annulée si prévue, sinon compensée.
 * `null` : ce n'est pas une écriture de trésorerie (la règle générale de J7 s'applique).
 */
export async function defaireEcritureTresorerie(e: { modele: string | null; operation: string | null; enregistrementId: string | null }, o: OutilsArgent): Promise<DetailEffet | null> {
  if (e.modele !== "FinanceTransaction" || e.operation !== "CREATE" || !e.enregistrementId) return null;
  const info = infoModele("FinanceTransaction")!;
  const id = e.enregistrementId;
  const base = { effetId: o.effetId, quoi: o.quoi };
  const actuelle = await o.lire(info, id);
  if (!actuelle) return { ...base, issue: "SANS_OBJET", pourquoi: "l'écriture n'existe plus" };
  if (actuelle.status === "CANCELLED") return { ...base, issue: "SANS_OBJET", pourquoi: "l'écriture est déjà annulée" };
  if (actuelle.status === "PENDING") {
    if (o.appliquer) {
      const fait = await o.ecrireVerrouille(info, id, (r) => r?.status === "PENDING",
        (t) => (t as unknown as Tx).financeTransaction.update({ where: { id }, data: { status: "CANCELLED" } }));
      if (!fait) return { ...base, issue: "IMPOSSIBLE", pourquoi: "son statut a changé au moment même de l'annulation : laissée telle quelle", aLaPlace: "la reprendre depuis la Trésorerie" };
    }
    return { ...base, issue: "COMPENSE", pourquoi: "écriture prévue, jamais réalisée : passée à « annulée », la trace reste (le solde n'avait pas bougé)" };
  }
  const nature = o.paiement && actuelle.direction === "OUT" ? "A_RECUPERER" : "CONTRE_PASSATION";
  const montant = Number((actuelle.amount as { $decimal?: string } | null)?.$decimal ?? actuelle.amount ?? 0);
  const phrase = nature === "A_RECUPERER"
    ? `le décaissement de ${valeurLisible(montant)} DZD a pu réellement partir : il reste au livre, et une écriture « à récupérer » (encaissement prévu, même compte) le compense — recouvrée, ou si rien n'était parti, passez-la à « réalisé » : elle le neutralise`
    : `contre-passée : une écriture inverse de ${valeurLisible(-montant)} DZD, datée du jour et liée, ramène le solde ; les deux lignes restent au livre`;
  if (o.appliquer) {
    const fait = await o.ecrireVerrouille(info, id, (r) => r?.status === "SETTLED", async (t) => {
      const tx = t as unknown as Tx;
      if (await tx.financeTransaction.count({ where: { compensationDeId: id, status: { not: "CANCELLED" } } })) throw new Error("déjà compensée");
      // La ligne RELUE sous le verrou, dans ses types (montant décimal, dates) : la compensation en recopie le compte.
      const a = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
      const ref = await referenceLibre(tx, `${a.reference}-${SUFFIXE[nature]}`);
      await tx.financeTransaction.create({
        data: {
          reference: ref, date: new Date(), category: a.category, method: a.method,
          direction: nature === "A_RECUPERER" ? "IN" : a.direction,
          amount: nature === "A_RECUPERER" ? a.amount : a.amount.negated(),
          status: nature === "A_RECUPERER" ? "PENDING" : "SETTLED",
          label: `${nature === "A_RECUPERER" ? "À récupérer" : "Contre-passation"} — ${a.label}`.slice(0, 300),
          account: a.account, counterparty: a.counterparty, invoiceRef: a.invoiceRef, companyId: a.companyId,
          employeeId: a.employeeId, budgetCategoryId: a.budgetCategoryId,
          treasuryAccountId: a.treasuryAccountId,
          notes: `Annulation du geste qui avait posé ${a.reference} (${nature === "A_RECUPERER" ? "décaissement à récupérer" : "contre-passation"}).`,
          createdById: o.acteurId, compensationDeId: id, compensation: nature,
        },
      });
    });
    if (!fait) return { ...base, issue: "IMPOSSIBLE", pourquoi: "l'écriture a changé de statut ou est déjà compensée au moment même de l'annulation : rien n'est écrit", aLaPlace: "voir la Trésorerie" };
  }
  return { ...base, issue: "COMPENSE", pourquoi: phrase };
}

/**
 * RÉTABLIR UNE ÉCRITURE COMPENSÉE (K10a, avec `retablissement.ts` de K10b) — l'annulation l'avait laissée au livre et
 * avait écrit une ligne de plus ; rétablir écrit encore une ligne de plus, jamais un effacement :
 *   • elle avait été passée à `CANCELLED` (prévue) → son statut d'avant lui est rendu ;
 *   • « à récupérer » encore prévu → passé à `CANCELLED` (le paiement redevient un paiement) ;
 *   • contre-passation → contre-passée à son tour (le solde redescend, trois lignes au livre).
 * `null` : ce n'est pas une écriture de trésorerie (la règle générale de K10b s'applique).
 */
export async function retablirEcritureTresorerie(
  e: { modele: string | null; operation: string | null; enregistrementId: string | null; apres: unknown },
  o: Pick<OutilsArgent, "acteurId" | "ecrireVerrouille">,
): Promise<{ ok: boolean; pourquoi: string } | null> {
  if (e.modele !== "FinanceTransaction" || e.operation !== "CREATE" || !e.enregistrementId) return null;
  const info = infoModele("FinanceTransaction")!;
  const id = e.enregistrementId;
  let pourquoi = "";
  const fait = await o.ecrireVerrouille(info, id, (r) => !!r, async (t) => {
    const tx = t as unknown as Tx;
    const a = await tx.financeTransaction.findUniqueOrThrow({ where: { id } });
    const statutAvant = String(((e.apres ?? {}) as Record<string, unknown>).status ?? "SETTLED") as "PENDING" | "SETTLED";
    if (a.status === "CANCELLED") {
      await tx.financeTransaction.update({ where: { id }, data: { status: statutAvant } });
      pourquoi = "rétablie : son statut d'avant l'annulation lui est rendu";
      return;
    }
    const comp = await tx.financeTransaction.findFirst({ where: { compensationDeId: id, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } });
    if (!comp) throw new Error("aucune compensation vivante");
    if (comp.compensation === "A_RECUPERER") {
      if (comp.status !== "PENDING") throw new Error("déjà recouvrée");
      await tx.financeTransaction.update({ where: { id: comp.id }, data: { status: "CANCELLED" } });
      pourquoi = `rétablie : l'écriture « à récupérer » ${comp.reference} est annulée — le décaissement redevient le paiement de l'ordre`;
      return;
    }
    await tx.financeTransaction.create({
      data: {
        reference: await referenceLibre(tx, `${comp.reference}-CP`), date: new Date(), category: comp.category, method: comp.method,
        direction: comp.direction, amount: comp.amount.negated(), status: "SETTLED", label: `Contre-passation — ${comp.label}`.slice(0, 300),
        account: comp.account, counterparty: comp.counterparty, invoiceRef: comp.invoiceRef, companyId: comp.companyId,
        employeeId: comp.employeeId, budgetCategoryId: comp.budgetCategoryId, treasuryAccountId: comp.treasuryAccountId,
        notes: `Rétablissement : la contre-passation ${comp.reference} est contre-passée (${a.reference} vaut de nouveau).`,
        createdById: o.acteurId, compensationDeId: comp.id, compensation: "CONTRE_PASSATION",
      },
    });
    pourquoi = `rétablie : la contre-passation ${comp.reference} est contre-passée à son tour — le solde redescend, les lignes restent au livre`;
  });
  return fait ? { ok: true, pourquoi } : { ok: false, pourquoi: "l'écriture ou sa compensation a bougé depuis l'annulation (recouvrée, annulée à la main) : rien n'est réécrit" };
}
