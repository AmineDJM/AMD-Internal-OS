import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ATTRIBUT_PAR_CLE } from "./types";
import { enrichissementActif } from "./signalement";

/**
 * LES LECTURES DES ÉCRANS DE L'ENRICHISSEMENT — l'état de la file (Super Admin) et la file « À confirmer »
 * d'une personne. Serveur seulement ; aucune valeur sensible n'en sort (les faits sensibles n'en ont pas).
 */

export interface EtatFile {
  actif: boolean;
  parStatut: Record<"A_FAIRE" | "EN_COURS" | "FAITE" | "ECHEC" | "IGNOREE", number>;
  echecs: { id: string; nomFichier: string; erreur: string | null; tentatives: number }[];
  faits: { aConfirmer: number; conflits: number; confirmesDOffice: number; auCoffre: number; sansSujet: number };
}

export async function etatFile(): Promise<EtatFile> {
  const [actif, groupes, echecs, aConfirmer, conflits, confirmesDOffice, auCoffre, sansSujet] = await Promise.all([
    enrichissementActif(),
    prisma.tacheEnrichissement.groupBy({ by: ["statut"], _count: { _all: true } }),
    prisma.tacheEnrichissement.findMany({ where: { statut: "ECHEC" }, orderBy: { updatedAt: "desc" }, take: 10, select: { id: true, nomFichier: true, derniereErreur: true, tentatives: true } }),
    prisma.faitPropose.count({ where: { decision: "EN_ATTENTE", sujetId: { not: null } } }),
    prisma.conflitDeFait.count({ where: { statut: "OUVERT" } }),
    prisma.faitPropose.count({ where: { decision: "CONFIRME_D_OFFICE" } }),
    prisma.faitPropose.count({ where: { decision: "COFFRE" } }),
    prisma.faitPropose.count({ where: { decision: "EN_ATTENTE", sujetId: null } }),
  ]);
  const parStatut = { A_FAIRE: 0, EN_COURS: 0, FAITE: 0, ECHEC: 0, IGNOREE: 0 };
  for (const g of groupes) parStatut[g.statut] = g._count._all;
  return {
    actif, parStatut,
    echecs: echecs.map((e) => ({ id: e.id, nomFichier: e.nomFichier, erreur: e.derniereErreur, tentatives: e.tentatives })),
    faits: { aConfirmer, conflits, confirmesDOffice, auCoffre, sansSujet },
  };
}

export interface LigneAConfirmer {
  id: string;
  attribut: string;
  libelle: string;
  valeur: string | null;
  confiance: number;
  extrait: string;
  raison: string | null;
  sujet: { type: "PERSONNE" | "ORGANISATION" | "PRODUIT"; id: string | null; libelle: string };
  piece: { nom: string; nature: string | null };
  conflit: { id: string; valeurActuelle: string | null } | null;
}

/** Les faits qui attendent la personne : à confirmer, en conflit, et ceux restés sans fiche. */
export async function faitsAConfirmer(user: { id: string; superAdmin: boolean }, limite = 200): Promise<{ aTrancher: LigneAConfirmer[]; sansFiche: LigneAConfirmer[] }> {
  const portee: Prisma.FaitProposeWhereInput = user.superAdmin ? {} : { extraction: { piece: { deposeeParId: user.id } } };
  const select = {
    id: true, attribut: true, valeur: true, confiance: true, preuve: true, raisonDecision: true, sujetType: true, sujetId: true, decision: true,
    extraction: { select: { piece: { select: { nom: true, nature: true } } } },
    conflits: { where: { statut: "OUVERT" as const }, select: { id: true, valeurActuelle: true }, take: 1 },
  } satisfies Prisma.FaitProposeSelect;
  const [aTrancher, sansFiche] = await Promise.all([
    prisma.faitPropose.findMany({ where: { AND: [portee, { sensible: false, sujetId: { not: null }, decision: { in: ["EN_ATTENTE", "CONFLIT"] } }] }, select, orderBy: { createdAt: "asc" }, take: limite }),
    prisma.faitPropose.findMany({ where: { AND: [portee, { sensible: false, sujetId: null, decision: "EN_ATTENTE" }] }, select, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const ids = (type: "PERSONNE" | "ORGANISATION") => [...new Set(aTrancher.filter((f) => f.sujetType === type && f.sujetId).map((f) => f.sujetId!))];
  const [personnes, organisations] = await Promise.all([
    prisma.personne.findMany({ where: { id: { in: ids("PERSONNE") } }, select: { id: true, nom: true, prenoms: true } }),
    prisma.organisation.findMany({ where: { id: { in: ids("ORGANISATION") } }, select: { id: true, raisonSociale: true } }),
  ]);
  const libelleDe = new Map<string, string>([
    ...personnes.map((p) => [p.id, [p.prenoms, p.nom].filter(Boolean).join(" ")] as [string, string]),
    ...organisations.map((o) => [o.id, o.raisonSociale] as [string, string]),
  ]);
  const ligne = (f: (typeof aTrancher)[number]): LigneAConfirmer => ({
    id: f.id,
    attribut: f.attribut,
    libelle: ATTRIBUT_PAR_CLE.get(f.attribut)?.libelle ?? f.attribut,
    valeur: f.valeur,
    confiance: f.confiance,
    extrait: typeof f.preuve === "object" && f.preuve && "extrait" in f.preuve ? String((f.preuve as { extrait?: unknown }).extrait ?? "") : "",
    raison: f.raisonDecision,
    sujet: { type: f.sujetType, id: f.sujetId, libelle: f.sujetId ? (libelleDe.get(f.sujetId) ?? "fiche") : "aucune fiche" },
    piece: { nom: f.extraction.piece.nom, nature: f.extraction.piece.nature },
    conflit: f.decision === "CONFLIT" && f.conflits[0] ? { id: f.conflits[0].id, valeurActuelle: f.conflits[0].valeurActuelle } : null,
  });
  return { aTrancher: aTrancher.filter((f) => f.decision === "EN_ATTENTE" || f.conflits.length > 0).map(ligne), sansFiche: sansFiche.map(ligne) };
}
