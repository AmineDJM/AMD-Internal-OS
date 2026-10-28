import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { estModeleSensible, type ModeleSensible } from "../domaine/champs";
import { estNatureCoffre, type NatureCoffre } from "../domaine/natures";

/**
 * LE JOURNAL DES ACCÈS AU COFFRE, LU PAR LE SUPER ADMIN (refonte V2-E) — « qui a lu l'IBAN de qui, quand,
 * pour quel geste ». Les filtres viennent de l'adresse (`?lecteur=…&decision=refus`) : `filtresDepuis`
 * les valide (module pur à l'essai), `lireJournal` les applique. Rien n'est déchiffré ici.
 */

export const TAILLE_PAGE = 100;

export interface FiltresJournal {
  lecteurId: string | null;
  modele: ModeleSensible | null;
  nature: NatureCoffre | null;
  decision: "accord" | "refus" | null;
  du: Date | null;
  au: Date | null;
  page: number;
}

const date = (v: string | undefined, finDeJournee: boolean): Date | null => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T${finDeJournee ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Les filtres d'une adresse ; une valeur inconnue est ignorée, jamais interprétée. */
export function filtresDepuis(q: Record<string, string | string[] | undefined>): FiltresJournal {
  const s = (k: string) => (typeof q[k] === "string" ? (q[k] as string).trim() : undefined) || undefined;
  const page = Number(s("page") ?? "1");
  return {
    lecteurId: s("lecteur") ?? null,
    modele: estModeleSensible(s("modele")) ? (s("modele") as ModeleSensible) : null,
    nature: estNatureCoffre(s("nature")) ? (s("nature") as NatureCoffre) : null,
    decision: s("decision") === "accord" || s("decision") === "refus" ? (s("decision") as "accord" | "refus") : null,
    du: date(s("du"), false),
    au: date(s("au"), true),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export function whereJournal(f: FiltresJournal): Prisma.AccesDonneeSensibleWhereInput {
  return {
    ...(f.lecteurId ? { userId: f.lecteurId } : {}),
    ...(f.modele ? { origineModele: f.modele } : {}),
    ...(f.nature ? { nature: f.nature } : {}),
    ...(f.decision ? { autorise: f.decision === "accord" } : {}),
    ...(f.du || f.au ? { createdAt: { ...(f.du ? { gte: f.du } : {}), ...(f.au ? { lte: f.au } : {}) } } : {}),
  };
}

export interface LigneJournal {
  id: string;
  le: Date;
  lecteur: string;
  geste: string;
  modele: string | null;
  champ: string | null;
  /** De qui : le salarié, le partenaire, la société — ou la fiche du référentiel. */
  titulaire: string;
  nature: string;
  autorise: boolean;
  motif: string | null;
}

async function libellesOrigines(lignes: { origineModele: string | null; origineId: string | null }[]): Promise<Map<string, string>> {
  const ids = (m: string) => [...new Set(lignes.filter((l) => l.origineModele === m && l.origineId).map((l) => l.origineId!))];
  const [emp, cc, li] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids("Employee") } }, select: { id: true, fullName: true } }),
    prisma.companyContact.findMany({ where: { id: { in: ids("CompanyContact") } }, select: { id: true, name: true } }),
    prisma.companyLegalIdentity.findMany({ where: { id: { in: ids("CompanyLegalIdentity") } }, select: { id: true, company: { select: { name: true, shortName: true } } } }),
  ]);
  return new Map<string, string>([
    ...emp.map((e) => [`Employee:${e.id}`, e.fullName] as const),
    ...cc.map((c) => [`CompanyContact:${c.id}`, c.name] as const),
    ...li.map((l) => [`CompanyLegalIdentity:${l.id}`, l.company.shortName || l.company.name] as const),
  ]);
}

export async function lireJournal(f: FiltresJournal): Promise<{ lignes: LigneJournal[]; total: number }> {
  const where = whereJournal(f);
  const [rows, total] = await Promise.all([
    prisma.accesDonneeSensible.findMany({ where, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * TAILLE_PAGE, take: TAILLE_PAGE }),
    prisma.accesDonneeSensible.count({ where }),
  ]);
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
  const [users, origines] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    libellesOrigines(rows),
  ]);
  const nom = new Map(users.map((u) => [u.id, u.name]));
  return {
    total,
    lignes: rows.map((r) => ({
      id: r.id,
      le: r.createdAt,
      lecteur: r.userId ? nom.get(r.userId) ?? "Compte supprimé" : `Modèle d'IA « ${r.lecteurNom ?? "?"} »`,
      geste: r.geste,
      modele: r.origineModele,
      champ: r.origineChamp,
      titulaire: (r.origineModele && r.origineId && origines.get(`${r.origineModele}:${r.origineId}`))
        || (r.titulaireType ? `${r.titulaireType === "PERSONNE" ? "Personne" : "Organisation"} ${r.titulaireId}` : "—"),
      nature: r.nature,
      autorise: r.autorise,
      motif: r.motif,
    })),
  };
}

/** Les comptes qui apparaissent au journal — la liste du filtre « Lecteur ». */
export async function lecteursDuJournal(): Promise<{ id: string; name: string }[]> {
  const ids = await prisma.accesDonneeSensible.findMany({ where: { userId: { not: null } }, distinct: ["userId"], select: { userId: true } });
  const uids = ids.map((i) => i.userId).filter((v): v is string => Boolean(v));
  if (!uids.length) return [];
  return prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}
