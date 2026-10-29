import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { clauseEcrituresVisibles } from "@/lib/queries/visibilite-listes";
import { toNumber } from "@/lib/utils";
import { jourAlger, soldesTresorerie, disponible, type FluxTresorerie, type SoldeCompte } from "../../domaine/tresorerie";
import { lireComptes, versCompte } from "../comptes";
import { CENTRAL_STATUS_LABEL, canDisburse, type CentralStatus } from "../../domaine/authorization";

/**
 * LES ORDRES AUTORISÉS ET PAS ENCORE RÉGLÉS — le prédicat du verrou de règlement (`canDisburse`),
 * jamais une liste recopiée : le jour où un état deviendrait payable, le disponible le retirerait
 * sans que personne pense à cet écran. Un paiement REPORTÉ reste PENDING : il reste dû, il compte.
 */
export const ORDRES_AUTORISES_NON_REGLES = {
  status: "PENDING" as const,
  centralStatus: { in: (Object.keys(CENTRAL_STATUS_LABEL) as CentralStatus[]).filter(canDisburse) },
};

const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Aoû", "Sep", "Oct", "Nov", "Déc"];

export interface LedgerRow {
  id: string;
  reference: string;
  date: string;
  direction: string;
  category: string;
  label: string;
  amount: number;
  signedAmount: number;
  method: string;
  account: string;
  counterparty: string;
  invoiceRef: string;
  notes: string;
  status: string;
}

/**
 * LE LIVRE — ses écritures et leurs agrégats du mois.
 *
 * La TRÉSORERIE n'est plus calculée ici (§118.176) : « ouverture + TOUS les flux réglés » comptait
 * deux fois tout ce qui précédait l'ouverture. Elle vit dans `chargerTresorerie`, et nulle part
 * ailleurs — deux calculs du même solde donneraient deux soldes au moment précis où il faut
 * décider si l'on peut payer (§118.5).
 */
export async function getFinanceData(userId: string) {
  const txs = await prisma.financeTransaction.findMany({ where: await clauseEcrituresVisibles(userId), orderBy: { date: "desc" } });
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let encMonth = 0;
  let decMonth = 0;
  let pendingIn = 0;
  let pendingOut = 0;
  const byCategoryOut = new Map<string, number>();
  const monthlyIn = new Array(12).fill(0);
  const monthlyOut = new Array(12).fill(0);

  for (const t of txs) {
    const amt = toNumber(t.amount);
    if (t.status === "SETTLED") {
      if (t.date.getFullYear() === now.getFullYear()) {
        if (t.direction === "IN") monthlyIn[t.date.getMonth()] += amt;
        else monthlyOut[t.date.getMonth()] += amt;
      }
      if (t.date >= monthStart) {
        if (t.direction === "IN") encMonth += amt;
        else decMonth += amt;
      }
      if (t.direction === "OUT") byCategoryOut.set(t.category, (byCategoryOut.get(t.category) ?? 0) + amt);
    } else if (t.status === "PENDING") {
      if (t.direction === "IN") pendingIn += amt;
      else pendingOut += amt;
    }
  }

  // Last 6 months: recettes vs dépenses + cumulative treasury.
  const cm = now.getMonth();
  const recVsDep: { label: string; recettes: number; depenses: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const idx = (cm - i + 12) % 12;
    recVsDep.push({ label: MONTHS_FR[idx], recettes: Math.round(monthlyIn[idx]), depenses: Math.round(monthlyOut[idx]) });
  }

  const rows: LedgerRow[] = txs.map((t) => {
    const amt = toNumber(t.amount);
    return {
      id: t.id, reference: t.reference, date: t.date.toISOString(), direction: t.direction,
      category: t.category, label: t.label, amount: amt,
      signedAmount: t.direction === "IN" ? amt : -amt, method: t.method, account: t.account,
      counterparty: t.counterparty ?? "", invoiceRef: t.invoiceRef ?? "", notes: t.notes ?? "", status: t.status,
    };
  });

  return {
    encMonth,
    decMonth,
    pendingIn,
    pendingOut,
    count: txs.length,
    byCategoryOut: [...byCategoryOut.entries()].sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount })),
    recVsDep,
    rows,
  };
}

// ───────────────────────────── La trésorerie ancrée (§118.176) ─────────────────────────────

export interface CompteLu extends SoldeCompte {
  banque: string | null;
  rib: string | null;
  societeId: string | null;
  societe: string | null;
  principal: boolean;
  notes: string | null;
}

export interface TresorerieLue {
  comptes: CompteLu[];
  /** La somme des soldes des comptes VISIBLES. */
  total: number;
  /** Les écritures de SA portée, postérieures au plus ancien ancrage, qu'aucun compte ne reçoit. */
  nonRattaches: { nombre: number; montant: number };
  /** Les ordres AUTORISÉS par le centre et pas encore réglés — reportés compris : ils restent dus. */
  autorises: { nombre: number; montant: number };
  /** Somme des comptes − paiements autorisés. N'est plus AFFICHÉ comme « solde » depuis le 05/10 (le solde bancaire est `total`) ; gardé pour les lecteurs qui comparent. */
  disponible: number;
}

/**
 * LA TRÉSORERIE d'une personne : ses comptes (ceux de ses entités, et ceux qui n'en ont pas), leurs
 * soldes ancrés, ce qu'aucun compte ne reçoit, et le disponible.
 *
 * Le rattachement se calcule sur TOUS les comptes, et l'affichage sur ceux qu'elle voit : rattacher
 * contre les seuls visibles ferait tomber sur « le compte unique » d'un comptable d'Adventum les
 * écritures de Pharmagène qui ne nomment pas leur compte.
 */
export async function chargerTresorerie(userId: string, entiteId: string | null = null): Promise<TresorerieLue> {
  const [tous, visiblesIds] = await Promise.all([
    lireComptes(),
    prisma.treasuryAccount.findMany({ where: await companyScopedWhere(userId, {}), select: { id: true } }),
  ]);
  const visibles = new Set(visiblesIds.map((v) => v.id));
  const comptes = tous.map(versCompte);

  // Les écritures qui peuvent compter : RÉGLÉES, et pas antérieures au plus ancien ancrage (un jour
  // de marge pour le fuseau). Une lecture bornée par la DATE, jamais par un nombre de lignes : une
  // somme sur une liste coupée serait fausse sans le dire (§118.60).
  const plusAncien = tous.reduce<Date | null>((min, c) => (min === null || c.openingDate < min ? c.openingDate : min), null);
  const [fluxTous, fluxPortee, autorises] = await Promise.all([
    plusAncien ? lireFlux({ status: "SETTLED", date: { gte: new Date(plusAncien.getTime() - 86_400_000) } }) : Promise.resolve([]),
    plusAncien
      ? prisma.financeTransaction.findMany({
          where: await companyScopedWhere(userId, { status: "SETTLED" as const, date: { gte: new Date(plusAncien.getTime() - 86_400_000) } }),
          select: { id: true },
        })
      : Promise.resolve([]),
    prisma.expenseOrder.aggregate({
      where: await companyScopedWhere(userId, entiteId ? { ...ORDRES_AUTORISES_NON_REGLES, companyId: entiteId } : ORDRES_AUTORISES_NON_REGLES),
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);
  const soldes = soldesTresorerie(comptes, fluxTous);
  // Ce qu'aucun compte ne reçoit se compte sur SA portée : compter celles d'une entité qu'on ne
  // voit pas dirait leur nombre et leur montant à qui n'a pas à les connaître.
  const dansLaPortee = new Set(fluxPortee.map((f) => f.id));
  const nonRattaches = soldesTresorerie(comptes, fluxTous.filter((f) => dansLaPortee.has(f.id) && (!entiteId || f.societeId === entiteId))).nonRattaches;

  const parId = new Map(tous.map((c) => [c.id, c]));
  const lus: CompteLu[] = soldes.comptes.filter((c) => visibles.has(c.id) && (!entiteId || parId.get(c.id)?.companyId === entiteId)).map((c) => {
    const brut = parId.get(c.id)!;
    return {
      ...c, banque: brut.bank, rib: brut.rib, societeId: brut.companyId,
      societe: brut.company ? brut.company.shortName || brut.company.name : null,
      principal: brut.principal, notes: brut.notes,
    };
  });
  const total = lus.reduce((t, c) => t + c.solde, 0);
  const montantAutorise = toNumber(autorises._sum.amount ?? 0);
  return {
    comptes: lus,
    total,
    nonRattaches,
    autorises: { nombre: autorises._count._all, montant: montantAutorise },
    disponible: disponible(total, montantAutorise),
  };
}

async function lireFlux(where: { status: "SETTLED"; date: { gte: Date } }): Promise<FluxTresorerie[]> {
  const rows = await prisma.financeTransaction.findMany({
    where,
    select: { id: true, direction: true, amount: true, status: true, date: true, treasuryAccountId: true, account: true, companyId: true },
  });
  return rows.map((t) => ({
    id: t.id, sens: t.direction === "IN" ? "IN" : "OUT", montant: toNumber(t.amount), statut: t.status,
    jour: jourAlger(t.date), compteId: t.treasuryAccountId, compte: t.account, societeId: t.companyId,
  }));
}
