/**
 * L'ACCÈS PAR BASE — la persistance (lot D2, décision 0057) : les réglages datés (`AccesBase`) et les paramètres par
 * base (`AccesBaseParametre`). Les gardes (motif, dates, garde-fou anti-verrouillage) vivent ici, une fois : l'action de
 * la console et les bancs passent par les mêmes fonctions.
 */
import type { NiveauAccesBase, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATALOGUE_BASES } from "../domaine/catalogue.genere";
import { BASE_CONSOLE, baseDe, niveauPour, propresDonneesParDefaut, refusVerrouillage, touchePlusRestrictifSuperAdmin } from "../domaine/regle";
import type { NiveauStocke, ReglageBase } from "../domaine/types";

/** Tous les réglages non révoqués (en vigueur ou à venir) — la table reste petite : quelques dizaines de lignes. */
export async function reglagesVivants(): Promise<ReglageBase[]> {
  const l = await prisma.accesBase.findMany({ where: { revoqueLe: null }, orderBy: { du: "desc" } });
  return l.map((r) => ({ id: r.id, base: r.base, userId: r.userId, role: r.role, niveau: r.niveau, ecriture: r.ecriture, du: r.du, au: r.au, revoqueLe: r.revoqueLe }));
}

/** L'historique complet d'une base (révoqués compris), pour la console. */
export function historiqueBase(base: string) {
  return prisma.accesBase.findMany({ where: { base }, orderBy: { createdAt: "desc" }, take: 100 });
}

/** Ses propres données quand la base est fermée : le paramètre enregistré, sinon le défaut du catalogue. */
export async function propresDonnees(): Promise<Record<string, boolean>> {
  const l = await prisma.accesBaseParametre.findMany();
  const enregistres = new Map(l.map((p) => [p.base, p.propresDonnees]));
  return Object.fromEntries(CATALOGUE_BASES.map((b) => [b.cle, enregistres.get(b.cle) ?? propresDonneesParDefaut(b.cle)]));
}

export interface DemandeReglage {
  base: string;
  cible: { userId: string } | { role: UserRole };
  niveau: NiveauStocke;
  ecriture: boolean;
  du: Date;
  au: Date | null;
  motif: string;
  /** « Oui, je ferme aussi pour un Super Admin » — exigé quand le réglage restrictif en touche un. */
  confirmeSuperAdmin: boolean;
}

export type ResultatReglage = { ok: true; id: string; resume: string } | { ok: false; erreur: string; confirmation?: true };

const superAdmins = () =>
  prisma.user.findMany({
    where: { isActive: true, OR: [{ role: "SUPER_ADMIN" }, { secondaryRole: "SUPER_ADMIN" }] },
    select: { id: true, role: true, secondaryRole: true },
  });

/** Vérifie puis écrit un réglage. Toute la logique de refus est ici. */
export async function poserReglage(d: DemandeReglage, auteurId: string): Promise<ResultatReglage> {
  const base = baseDe(d.base);
  if (!base) return { ok: false, erreur: "Base inconnue." };
  if (!["LECTURE_SEULE", "FERMEE", "OUVERTE"].includes(d.niveau)) return { ok: false, erreur: "Niveau inconnu." };
  const motif = d.motif.trim();
  if (motif.length < 5) return { ok: false, erreur: "Le motif est obligatoire (au moins 5 caractères) : il est écrit au journal." };
  if (Number.isNaN(d.du.getTime())) return { ok: false, erreur: "La date de début est obligatoire (AAAA-MM-JJ)." };
  if (d.au && d.au < d.du) return { ok: false, erreur: "La date de fin précède la date de début." };

  let nomCible: string;
  if ("userId" in d.cible) {
    const u = await prisma.user.findUnique({ where: { id: d.cible.userId }, select: { name: true, isActive: true } });
    if (!u) return { ok: false, erreur: "Personne introuvable." };
    nomCible = u.name;
  } else nomCible = `rôle ${d.cible.role}`;

  // Les Super Admins actifs que le réglage viserait, et ceux qui garderaient la console après lui.
  const sas = await superAdmins();
  const vises = sas.filter((u) => ("userId" in d.cible ? u.id === d.cible.userId : u.role === d.cible.role || u.secondaryRole === d.cible.role));
  if (touchePlusRestrictifSuperAdmin(d.niveau, vises.length) && !d.confirmeSuperAdmin) {
    return { ok: false, confirmation: true, erreur: `Ce réglage restreint l'accès d'un Super Admin (${vises.length}) à la base « ${base.nom} ». Confirmez explicitement pour l'appliquer — il se défait en un geste (révoquer, ou Annuler).` };
  }
  if (d.base === BASE_CONSOLE && d.niveau !== "OUVERTE") {
    const maintenant = new Date();
    const envisage: ReglageBase = {
      id: "envisage", base: d.base, userId: "userId" in d.cible ? d.cible.userId : null, role: "role" in d.cible ? d.cible.role : null,
      niveau: d.niveau, ecriture: false, du: d.du, au: d.au, revoqueLe: null,
    };
    // Le pire instant : on juge le réglage comme s'il était déjà en vigueur.
    const apres = [...(await reglagesVivants()), { ...envisage, du: new Date(Math.min(+d.du, +maintenant)) }];
    const gardent = sas.filter((u) => {
      const n = niveauPour({ userId: u.id, roles: [u.role, u.secondaryRole] }, BASE_CONSOLE, apres, maintenant).niveau;
      return n !== "FERMEE" && n !== "LECTURE_SEULE";
    }).length;
    const refus = refusVerrouillage(d.base, d.niveau, gardent);
    if (refus) return { ok: false, erreur: refus };
  }

  const r = await prisma.accesBase.create({
    data: {
      base: d.base, niveau: d.niveau as NiveauAccesBase, ecriture: d.niveau === "OUVERTE" && d.ecriture, du: d.du, au: d.au,
      motif: motif.slice(0, 500), accordeParId: auteurId,
      ...("userId" in d.cible ? { userId: d.cible.userId } : { role: d.cible.role }),
    },
  });
  const niveauFr = { LECTURE_SEULE: "lecture seule", FERMEE: "fermée", OUVERTE: d.ecriture ? "ouverte (lecture et écriture)" : "ouverte (lecture)" }[d.niveau];
  const resume = `Base « ${base.nom} » ${niveauFr} pour ${nomCible} du ${d.du.toISOString().slice(0, 10)}${d.au ? ` au ${d.au.toISOString().slice(0, 10)}` : ", sans fin"} — motif : ${motif} (réf. ${r.id})`;
  return { ok: true, id: r.id, resume };
}

/** Révoque un réglage (jamais de suppression : il reste au journal). Le garde-fou vaut aussi ici : on ne révoque pas
 *  l'OUVERTURE qui seule rendait la console au dernier Super Admin. */
export async function revoquerReglage(id: string, auteurId: string): Promise<ResultatReglage> {
  const r = await prisma.accesBase.findUnique({ where: { id } });
  if (!r || r.revoqueLe) return { ok: false, erreur: "Réglage introuvable ou déjà révoqué." };
  if (r.base === BASE_CONSOLE && r.niveau === "OUVERTE") {
    const maintenant = new Date();
    const apres = (await reglagesVivants()).filter((x) => x.id !== id);
    const gardent = (await superAdmins()).filter((u) => {
      const n = niveauPour({ userId: u.id, roles: [u.role, u.secondaryRole] }, BASE_CONSOLE, apres, maintenant).niveau;
      return n !== "FERMEE" && n !== "LECTURE_SEULE";
    }).length;
    const refus = refusVerrouillage(r.base, "FERMEE", gardent);
    if (refus) return { ok: false, erreur: refus };
  }
  await prisma.accesBase.update({ where: { id }, data: { revoqueLe: new Date(), revoqueParId: auteurId } });
  const base = baseDe(r.base);
  return { ok: true, id, resume: `Réglage révoqué : base « ${base?.nom ?? r.base} », ${r.userId ? `personne ${r.userId}` : `rôle ${r.role}`} (réf. ${id})` };
}

/** Règle, pour une base, l'accès à ses propres données quand elle est fermée. */
export async function reglerPropresDonnees(base: string, propres: boolean, auteurId: string): Promise<ResultatReglage> {
  const b = baseDe(base);
  if (!b) return { ok: false, erreur: "Base inconnue." };
  await prisma.accesBaseParametre.upsert({ where: { base }, create: { base, propresDonnees: propres, updatedById: auteurId }, update: { propresDonnees: propres, updatedById: auteurId } });
  return { ok: true, id: base, resume: `Base « ${b.nom} » fermée : ses propres données restent ${propres ? "visibles" : "fermées"} à la personne` };
}

