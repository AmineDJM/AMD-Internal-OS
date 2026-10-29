import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ficheScopedWhere, getMyCompanies, myCompanyScope, companyLabel } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { poleDe } from "@/lib/lecteurs/consulting";
import { awaitsCentre, sitsOnPaymentCentre, ORDRE_NON_ANNULE, type CentralStatus } from "../../domaine/authorization";
import {
  ENTITE_SANS, SECTIONS_CENTRE, choisirEntite, choisirSection, classerOrdre, origineEffective,
  type SectionCentre,
} from "../../domaine/sections-centre";

/**
 * LE CHARGEUR DU CENTRE DE PAIEMENT — les entités en haut, trois sections dessous (§118.211).
 *
 * ── CE QUE CE MODULE DÉCIDE, ET CE QU'IL NE DÉCIDE PAS ──────────────────────────────────────
 *
 * Il ne décide RIEN du droit : les ordres lus sont ceux que l'écran lisait déjà — tout le centre
 * pour qui y siège, ses propres demandes sinon — dans les sociétés auxquelles la personne a droit
 * (`ficheScopedWhere`), les ordres sans société compris (§118.154 : une ligne sans entité n'est le
 * secret de personne, et la cacher la rendrait impossible à rattacher). Ce que le changement
 * apporte est un REGROUPEMENT : l'entité choisie dans la page, puis la section.
 *
 * `ficheScopedWhere` et non `companyScopedWhere` : la liste suivait avant le sélecteur de la barre
 * supérieure ; l'entité se choisit maintenant DANS la page, parmi toutes celles que la personne a
 * le droit de voir. Le cookie n'est lu que comme une PRÉFÉRENCE de départ, et VALIDÉE
 * (`myCompanyScope`) — jamais l'identifiant brut d'un cookie qui se modifie à la main (§118.177).
 * Une valeur d'adresse qui ne désigne aucune pastille n'ouvre rien : elle retombe sur le défaut.
 *
 * Les comptes (par entité, par section) sont EXACTS : ils se calculent sur toutes les lignes
 * (cinq colonnes légères), pas sur les trois cents que l'écran affiche. Une coupe qui se lit comme
 * un compte est un mensonge (§118.60) — l'écran dit combien de lignes plus anciennes il ne montre pas.
 */

export const LIMITE_LIGNES_CENTRE = 300;

export interface EntiteDuCentre {
  /** Identifiant de la société, ou `ENTITE_SANS`. */
  cle: string;
  label: string;
  /** Ordres qui attendent une décision du centre. */
  enAttente: number;
  montantEnAttente: number;
  total: number;
}

export interface SectionDuCentre {
  section: SectionCentre;
  enAttente: number;
  total: number;
  /** Lignes rangées ici faute d'origine lisible — seul « Autres » en porte. */
  repli: number;
}

export interface CentreCharge {
  canDecide: boolean;
  /** Rien à montrer ET aucun droit de siège : l'écran dit la règle. */
  aucunOrdre: boolean;
  entites: EntiteDuCentre[];
  entiteChoisie: string | null;
  sections: SectionDuCentre[];
  sectionChoisie: SectionCentre;
  /** Les compteurs de l'entité choisie, sections confondues. */
  bilan: { enAttente: number; montantEnAttente: number; autorises: number; refuses: number };
  /** Les identifiants à afficher, du plus récent au plus ancien — au plus `LIMITE_LIGNES_CENTRE`. */
  idsAffiches: string[];
  /** Combien de lignes de cette section l'écran ne montre PAS (les plus anciennes). */
  nonAffiches: number;
}

const LOT = 2000;
const parLots = <T,>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += LOT) out.push(xs.slice(i, i + LOT));
  return out;
};

interface Ligne {
  id: string;
  companyId: string | null;
  sourceType: EntityType | null;
  sourceId: string | null;
  centralStatus: CentralStatus;
  amount: number;
  createdAt: Date;
}

/**
 * L'ORIGINE QUE DÉCLARE CHAQUE PORTEUR, en trois lectures par lot — jamais une par ordre.
 * Clé `TYPE:id` → l'origine (`type`, `id`) que le porteur désigne.
 */
async function origineDesPorteurs(lignes: readonly Ligne[]): Promise<Map<string, { type: EntityType | null; id: string | null }>> {
  const out = new Map<string, { type: EntityType | null; id: string | null }>();
  const ids = (t: EntityType) => [...new Set(lignes.filter((l) => l.sourceType === t && l.sourceId).map((l) => l.sourceId as string))];
  for (const lot of parLots(ids("PAYMENT_REQUEST"))) {
    const rows = await prisma.paymentRequest.findMany({ where: { id: { in: lot } }, select: { id: true, entityType: true, entityId: true } });
    for (const r of rows) out.set(`PAYMENT_REQUEST:${r.id}`, { type: r.entityType, id: r.entityId });
  }
  for (const lot of parLots(ids("ADMIN_REQUEST"))) {
    const rows = await prisma.administrativeRequest.findMany({ where: { id: { in: lot } }, select: { id: true, linkedEntityType: true, linkedEntityId: true } });
    for (const r of rows) out.set(`ADMIN_REQUEST:${r.id}`, { type: r.linkedEntityType, id: r.linkedEntityId });
  }
  for (const lot of parLots(ids("LEGAL_DOCUMENT"))) {
    const rows = await prisma.legalDocument.findMany({ where: { id: { in: lot } }, select: { id: true, sourceType: true, sourceId: true } });
    for (const r of rows) out.set(`LEGAL_DOCUMENT:${r.id}`, { type: r.sourceType, id: r.sourceId });
  }
  return out;
}

/** La section de chaque ordre, et si c'est un repli — UNE fonction pour les comptes ET pour la liste. */
export async function classerLesLignes(
  lignes: readonly { id: string; sourceType: EntityType | null; sourceId: string | null }[],
): Promise<Map<string, { section: SectionCentre; repli: boolean }>> {
  const base = lignes.map((l) => ({ ...l, centralStatus: "AWAITING" as CentralStatus, companyId: null, amount: 0, createdAt: new Date(0) }));
  const porteurs = await origineDesPorteurs(base);
  const effectives = new Map<string, { type: EntityType | null; id: string | null }>();
  for (const l of base) {
    const decl = l.sourceType && l.sourceId ? porteurs.get(`${l.sourceType}:${l.sourceId}`) : undefined;
    const type = origineEffective(l.sourceType, decl?.type ?? null);
    // L'identifiant de l'origine : celui du porteur quand le type vient de lui, sinon celui de l'ordre.
    effectives.set(l.id, { type, id: type && type === l.sourceType ? l.sourceId : decl?.id ?? null });
  }
  const contrats = [...new Set([...effectives.values()].filter((e) => e.type === "CONSULTING_CONTRACT" && e.id).map((e) => e.id as string))];
  const contratRH = new Set<string>();
  for (const lot of parLots(contrats)) {
    const rows = await prisma.consultingContract.findMany({ where: { id: { in: lot } }, select: { id: true, pole: true } });
    for (const r of rows) if (poleDe(r.pole) === "RH") contratRH.add(r.id);
  }
  const out = new Map<string, { section: SectionCentre; repli: boolean }>();
  for (const l of base) {
    const e = effectives.get(l.id)!;
    out.set(l.id, classerOrdre({
      sourceType: e.type,
      contratRH: e.type === "CONSULTING_CONTRACT" && e.id ? contratRH.has(e.id) : false,
    }));
  }
  return out;
}

const cleDeLEntite = (companyId: string | null): string => companyId ?? ENTITE_SANS;

export async function chargerCentre(
  user: SessionUser, demande: { entite?: string | null; section?: string | null },
): Promise<CentreCharge> {
  const canDecide = sitsOnPaymentCentre(user);

  const base: Prisma.ExpenseOrderWhereInput = {
    AND: [
      { centralStatus: { not: "NOT_REQUIRED" } },
      // Une demande retirée annule son ordre : il quitte le centre — liste, compteurs, bilan (`ORDRE_NON_ANNULE`).
      ORDRE_NON_ANNULE,
      ...(canDecide ? [] : [{ requestedById: user.id }]),
    ],
  };
  const where = await ficheScopedWhere(user.id, base);
  const rows = await prisma.expenseOrder.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    select: { id: true, companyId: true, sourceType: true, sourceId: true, centralStatus: true, amount: true, createdAt: true },
  });
  const lignes: Ligne[] = rows.map((r) => ({ ...r, centralStatus: r.centralStatus as CentralStatus, amount: toNumber(r.amount) }));
  const classes = await classerLesLignes(lignes);

  // ── Les pastilles : chaque société que la personne voit, même vide (changer d'entité se fait
  //    d'un clic, un compte à zéro est une information) ; « Sans entité » seulement s'il y a des lignes.
  const mesSocietes = await getMyCompanies(user.id);
  const connues = new Set(mesSocietes.map((c) => c.id));
  const inconnues = [...new Set(lignes.map((l) => l.companyId).filter((c): c is string => Boolean(c) && !connues.has(c as string)))];
  const horsListe = inconnues.length
    ? await prisma.company.findMany({ where: { id: { in: inconnues } }, select: { id: true, name: true, shortName: true } })
    : [];

  const entites = new Map<string, EntiteDuCentre>();
  for (const c of mesSocietes) entites.set(c.id, { cle: c.id, label: companyLabel(c), enAttente: 0, montantEnAttente: 0, total: 0 });
  // Une société désactivée porte encore des ordres : elle garde sa pastille, dite « (désactivée) ».
  for (const c of horsListe) entites.set(c.id, { cle: c.id, label: `${c.shortName || c.name} (désactivée)`, enAttente: 0, montantEnAttente: 0, total: 0 });
  if (lignes.some((l) => !l.companyId)) entites.set(ENTITE_SANS, { cle: ENTITE_SANS, label: "Sans entité", enAttente: 0, montantEnAttente: 0, total: 0 });
  for (const l of lignes) {
    const e = entites.get(cleDeLEntite(l.companyId));
    if (!e) continue;
    e.total += 1;
    if (awaitsCentre(l.centralStatus)) { e.enAttente += 1; e.montantEnAttente += l.amount; }
  }
  const liste = [...entites.values()];

  const preferee = await myCompanyScope(user.id);
  const entiteChoisie = choisirEntite(liste, demande.entite, preferee);

  // ── L'entité choisie : ses sections, son bilan, ses lignes.
  const deLEntite = lignes.filter((l) => cleDeLEntite(l.companyId) === entiteChoisie);
  const sections: SectionDuCentre[] = SECTIONS_CENTRE.map((section) => ({ section, enAttente: 0, total: 0, repli: 0 }));
  const parSection = new Map(sections.map((s) => [s.section, s]));
  const bilan = { enAttente: 0, montantEnAttente: 0, autorises: 0, refuses: 0 };
  for (const l of deLEntite) {
    const c = classes.get(l.id)!;
    const s = parSection.get(c.section)!;
    s.total += 1;
    if (c.repli) s.repli += 1;
    if (awaitsCentre(l.centralStatus)) { s.enAttente += 1; bilan.enAttente += 1; bilan.montantEnAttente += l.amount; }
    if (l.centralStatus === "APPROVED") bilan.autorises += 1;
    if (l.centralStatus === "REFUSED") bilan.refuses += 1;
  }
  const sectionChoisie = choisirSection(demande.section, {
    REGULATORY: parSection.get("REGULATORY")!, SALES_MARKETING: parSection.get("SALES_MARKETING")!, AUTRES: parSection.get("AUTRES")!,
  });
  const dansLaSection = deLEntite.filter((l) => classes.get(l.id)!.section === sectionChoisie);

  return {
    canDecide,
    aucunOrdre: lignes.length === 0,
    entites: liste,
    entiteChoisie,
    sections,
    sectionChoisie,
    bilan,
    idsAffiches: dansLaSection.slice(0, LIMITE_LIGNES_CENTRE).map((l) => l.id),
    nonAffiches: Math.max(0, dansLaSection.length - LIMITE_LIGNES_CENTRE),
  };
}
