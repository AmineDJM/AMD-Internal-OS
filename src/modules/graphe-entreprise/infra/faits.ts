import type { TypeSujetFait } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { faitsVisibles } from "@/modules/bibliotheque/api";
import { etatA, type FaitDate } from "../domaine/faits-dates";
import { lireRef, valideA, type Provenance, type TypeNoeud } from "../domaine/noeuds";
import { aretesDe } from "./aretes";
import { decrire, type NoeudDecrit } from "./noeuds";
import { perimetreDe } from "./perimetre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FAITS DATÉS D'UNE ENTITÉ ET LEUR PROVENANCE (J9, décision 0021).
 *
 *   `etatALaDate`  ce qui était vrai d'une entité à une date (et, au besoin, ce qu'on en savait à une autre date) :
 *                  ses faits confirmés (bitemporels) et ses relations valides ce jour-là ;
 *   `dOuVient`     la chaîne d'un fait : la pièce, l'extraction, la confiance, qui l'a confirmé et quand, ce qu'il a
 *                  remplacé, par quoi il a été remplacé, les conflits.
 *
 * Un fait se lit sous LA règle de la Bibliothèque (`faitsVisibles` : jamais sensible, pièce ouvrable) ; l'entité sous
 * le périmètre du graphe. Tout ce qui sort porte sa source.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const jour = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const SUJETS: Partial<Record<TypeNoeud, TypeSujetFait>> = { PERSONNE: "PERSONNE", ORGANISATION: "ORGANISATION", PRODUIT: "PRODUIT" };

async function nomsDe(ids: (string | null)[]): Promise<Map<string, string>> {
  const l = [...new Set(ids.filter((x): x is string => !!x))];
  if (!l.length) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

/** Les faits LISIBLES d'un sujet (fermés compris : l'histoire est une donnée). */
async function faitsDuSujet(user: SessionUser, type: TypeNoeud, id: string) {
  const sujetType = SUJETS[type];
  if (!sujetType || id.includes(":")) return [];
  const lignes = await prisma.faitConfirme.findMany({
    where: { sujetType, sujetId: id, sensible: false },
    select: { id: true, attribut: true, valeur: true, valideDu: true, valideAu: true, confirmeLe: true, fermeLe: true, source: true, pieceId: true, confirmeParId: true, sensible: true },
    orderBy: { confirmeLe: "asc" },
    take: 500,
  });
  const visibles = await faitsVisibles(user, lignes);
  return lignes.filter((_, i) => visibles[i]);
}

export interface ValeurSourcee { attribut: string; valeur: string | null; depuis: string | null; fait: string; source: Provenance }
export interface RelationALaDate { relation: string; sens: "sortant" | "entrant"; avec: NoeudDecrit; depuis: string | null; jusqua: string | null; note: string | null; source: Provenance }

export type EtatEntite =
  | { ok: false; raison: "INTROUVABLE" }
  | { ok: true; entite: NoeudDecrit; date: string; connuLe: string | null; valeurs: ValeurSourcee[]; inconnus: string[]; relations: RelationALaDate[] };

export async function etatALaDate(user: SessionUser, refEntite: string, date: Date, o: { connuLe?: Date | null; exclus?: readonly TypeNoeud[]; pourModele?: boolean } = {}): Promise<EtatEntite> {
  const l = lireRef(refEntite);
  const perimetre = perimetreDe(user, { exclus: o.exclus, pourModele: o.pourModele });
  if (!l || !(await perimetre.autoriser([refEntite])).has(refEntite)) return { ok: false, raison: "INTROUVABLE" };
  const [faits, aretes, descr] = await Promise.all([faitsDuSujet(user, l.type, l.id), aretesDe([refEntite], perimetre.types), decrire([refEntite])]);
  const entite = descr.get(refEntite);
  if (!entite) return { ok: false, raison: "INTROUVABLE" };
  const noms = await nomsDe(faits.map((f) => f.confirmeParId));
  const fd: FaitDate[] = faits.map((f) => ({ ...f, source: f.source }));
  const e = etatA(fd, date, { connuLe: o.connuLe ?? null });
  const parId = new Map(faits.map((f) => [f.id, f]));
  const valeurs: ValeurSourcee[] = e.valeurs.flatMap((v) => v.valeurs.map((x) => {
    const f = parId.get(x.faitId)!;
    return {
      attribut: v.attribut, valeur: x.valeur, depuis: jour(x.depuis), fait: x.faitId,
      source: { table: "FaitConfirme", id: x.faitId, piece: f.pieceId, par: noms.get(f.confirmeParId ?? "") ?? null, le: jour(f.confirmeLe) },
    };
  }));
  // Les relations valides ce jour-là — l'autre bout passe le périmètre AVANT d'être décrit.
  const valides = aretes.filter((a) => valideA(a, date) && (!o.connuLe || !a.source.le || a.source.le <= jour(o.connuLe)!));
  const autres = valides.map((a) => (a.de === refEntite ? a.a : a.de));
  const ok = await perimetre.autoriser([...new Set(autres)]);
  const decrits = await decrire([...ok]);
  const relations: RelationALaDate[] = valides.flatMap((a) => {
    const autre = a.de === refEntite ? a.a : a.de;
    const avec = decrits.get(autre);
    if (!ok.has(autre) || !avec) return [];
    return [{ relation: a.relation, sens: a.de === refEntite ? "sortant" as const : "entrant" as const, avec, depuis: jour(a.depuis), jusqua: jour(a.jusqua), note: a.note ?? null, source: a.source }];
  }).slice(0, 80);
  return { ok: true, entite, date: jour(date)!, connuLe: jour(o.connuLe), valeurs, inconnus: e.inconnus, relations };
}

export interface Provenance360 {
  fait: { id: string; attribut: string; valeur: string | null; valideDu: string | null; valideAu: string | null; actif: boolean; source: Provenance };
  sujet: NoeudDecrit | null;
  origine: string;
  piece: { id: string; nom: string; lien: string; source: Provenance } | null;
  extraction: { moteur: string; le: string | null; confiance: number | null; page: number | string | null; extrait: string | null; source: Provenance } | null;
  confirmation: { par: string | null; le: string | null; decision: string | null; source: Provenance };
  fermeture: { le: string | null; par: string | null; remplacePar: string | null; source: Provenance } | null;
  remplace: { fait: string; valeur: string | null; source: Provenance }[];
  conflits: { statut: string; valeurActuelle: string | null; valeurProposee: string | null; resoluLe: string | null; source: Provenance }[];
}

/** D'OÙ VIENT ce fait confirmé — `null` s'il n'existe pas ou si la personne ne peut pas le lire. */
export async function dOuVient(user: SessionUser, faitId: string, o: { exclus?: readonly TypeNoeud[]; pourModele?: boolean } = {}): Promise<Provenance360 | null> {
  const f = await prisma.faitConfirme.findUnique({
    where: { id: faitId },
    include: {
      piece: { select: { id: true, nom: true } },
      faitPropose: { select: { id: true, confiance: true, preuve: true, decision: true, decideeLe: true, extraction: { select: { id: true, moteur: true, createdAt: true } } } },
      conflits: { select: { id: true, statut: true, valeurActuelle: true, valeurProposee: true, resoluLe: true } },
    },
  });
  if (!f || f.sensible) return null;
  const [visible] = await faitsVisibles(user, [f]);
  if (!visible) return null;
  const sujetRef = `${f.sujetType}:${f.sujetId}`;
  const perimetre = perimetreDe(user, { exclus: o.exclus, pourModele: o.pourModele });
  const sujetOk = (await perimetre.autoriser([sujetRef])).has(sujetRef);
  const [noms, descr, remplaces] = await Promise.all([
    nomsDe([f.confirmeParId, f.fermeParId]),
    sujetOk ? decrire([sujetRef]) : Promise.resolve(new Map<string, NoeudDecrit>()),
    prisma.faitConfirme.findMany({ where: { remplaceParId: f.id, sensible: false }, select: { id: true, valeur: true } }),
  ]);
  const src = (table: string, id: string, extra: Partial<Provenance> = {}): Provenance => ({ table, id, ...extra });
  const preuve = (f.faitPropose?.preuve ?? {}) as { page?: number | string; extrait?: string };
  return {
    fait: { id: f.id, attribut: f.attribut, valeur: f.valeur, valideDu: jour(f.valideDu), valideAu: jour(f.valideAu), actif: f.actif, source: src("FaitConfirme", f.id, { piece: f.pieceId }) },
    sujet: descr.get(sujetRef) ?? null,
    origine: f.source === "PIECE" ? "lu sur une pièce, puis confirmé" : f.source === "SAISIE" ? "saisi à la main" : "importé",
    piece: f.piece ? { id: f.piece.id, nom: f.piece.nom, lien: `/pieces/${f.piece.id}`, source: src("Piece", f.piece.id) } : null,
    extraction: f.faitPropose ? {
      moteur: f.faitPropose.extraction.moteur, le: jour(f.faitPropose.extraction.createdAt), confiance: f.faitPropose.confiance,
      page: preuve.page ?? null, extrait: typeof preuve.extrait === "string" ? preuve.extrait.slice(0, 300) : null,
      source: src("FaitPropose", f.faitPropose.id, { piece: f.pieceId }),
    } : null,
    confirmation: { par: noms.get(f.confirmeParId ?? "") ?? (f.confirmeParId ? null : "confirmation d'office"), le: jour(f.confirmeLe), decision: f.faitPropose?.decision ?? null, source: src("FaitConfirme", f.id) },
    fermeture: f.actif ? null : { le: jour(f.fermeLe ?? f.valideAu), par: noms.get(f.fermeParId ?? "") ?? null, remplacePar: f.remplaceParId, source: src("FaitConfirme", f.id) },
    remplace: remplaces.map((r) => ({ fait: r.id, valeur: r.valeur, source: src("FaitConfirme", r.id) })),
    conflits: f.conflits.map((c) => ({ statut: c.statut, valeurActuelle: c.valeurActuelle, valeurProposee: c.valeurProposee, resoluLe: jour(c.resoluLe), source: src("ConflitDeFait", c.id) })),
  };
}

/** Les faits d'un sujet pour un attribut — pour retrouver « le fait » quand on ne connaît que l'entité et l'attribut. */
export async function faitsDeLAttribut(user: SessionUser, refEntite: string, attribut: string): Promise<{ id: string; valeur: string | null; actif: boolean }[]> {
  const l = lireRef(refEntite);
  if (!l) return [];
  const faits = await faitsDuSujet(user, l.type, l.id);
  const a = attribut.toLowerCase();
  return faits.filter((f) => f.attribut.toLowerCase().includes(a)).map((f) => ({ id: f.id, valeur: f.valeur, actif: !f.fermeLe && !f.valideAu }));
}
