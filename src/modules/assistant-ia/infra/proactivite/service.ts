import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { accesAssistantIa } from "../role-config";
import { veilleurOuvert } from "./sources";
import { lireConsoleProactivite } from "./reglages";
import { interruptionsDuJour, preferencesDe } from "./veille";
import { capacitesOuvertes, listerMandats } from "./mandats";
import { ajusterFacteur, CIBLE_UTILE, estDiscret, normaliserPreferences, phraseUtilite, tauxUtile } from "../../domaine/proactivite/budget";
import { estCodeVeilleur, FICHE_VEILLEUR, LIBELLE_POLE, seuilEffectif, VEILLEURS } from "../../domaine/proactivite/veilleurs";

/**
 * L'ÉCRAN « CE QUE MON ASSISTANT SURVEILLE » (J12) — lectures et réglages de la personne sur SA veille :
 * ses veilleurs (activer, désactiver, seuil), ses préférences (budget d'interruptions, heures calmes), ses
 * constats (juger en un clic, écarter), ses mandats. Toujours par `userId` de la session : jamais celui d'un autre.
 */

export async function etatDeMaVeille(user: CurrentUser, now = new Date()) {
  const [acces, console_, reglages, signaux, mandats, capacites] = await Promise.all([
    accesAssistantIa(user), lireConsoleProactivite(),
    prisma.assistantVeilleur.findMany({ where: { userId: user.id } }),
    prisma.assistantSignal.findMany({
      where: { userId: user.id, OR: [{ etat: { in: ["EN_ATTENTE", "LIVRE", "JOURNAL"] } }, { detecteLe: { gte: new Date(now.getTime() - 7 * 86_400_000) } }] },
      orderBy: { detecteLe: "desc" }, take: 60,
    }),
    listerMandats(user.id, now), capacitesOuvertes(user),
  ]);
  const prefs = await preferencesDe(user.id, console_.interruptionsMaxJour);
  const parCode = new Map(reglages.map((r) => [r.code, r]));
  const veilleurs = VEILLEURS.map((f) => {
    const r = parCode.get(f.code);
    const retours = { utiles: r?.utiles ?? 0, inutiles: r?.inutiles ?? 0 };
    return {
      code: f.code, pole: LIBELLE_POLE[f.pole], libelle: f.libelle, description: f.description, unite: f.seuil.unite,
      min: f.seuil.min, max: f.seuil.max, seuil: r?.seuil ?? f.seuil.valeur, seuilEffectif: seuilEffectif(f, r?.seuil, r?.facteur ?? 1),
      ouvert: veilleurOuvert(f, user, acces), actif: r?.actif ?? f.actifParDefaut, discret: estDiscret(retours), utilite: phraseUtilite(retours),
    };
  });
  const total = reglages.reduce((a, r) => ({ utiles: a.utiles + r.utiles, inutiles: a.inutiles + r.inutiles }), { utiles: 0, inutiles: 0 });
  return {
    coupee: console_.coupee, plafondConsole: console_.interruptionsMaxJour,
    preferences: { interruptionsMax: prefs.interruptionsMax, calmeDebut: prefs.calmeDebut, calmeFin: prefs.calmeFin, weekendCalme: prefs.weekendCalme, pointDuMatin: prefs.pointDuMatin },
    interruptionsAujourdhui: await interruptionsDuJour(user.id, now),
    utilite: { phrase: phraseUtilite(total), taux: tauxUtile(total), cible: CIBLE_UTILE },
    veilleurs,
    signaux: signaux.map((s) => ({
      id: s.id, veilleur: FICHE_VEILLEUR.get(s.veilleur as never)?.libelle ?? "Mandat", titre: s.titre, detail: s.detail, gravite: s.gravite, lien: s.lien,
      etat: s.etat, canal: s.canal, detecteLe: s.detecteLe.toISOString(), retour: s.retour,
    })),
    mandats,
    capacites: capacites.map((c) => ({ code: c.code, libelle: c.libelle, description: c.description, montant: c.montant })),
  };
}

export async function reglerVeilleur(userId: string, code: string, r: { actif?: boolean; seuil?: number | null }): Promise<{ ok: true } | { ok: false; erreur: string }> {
  if (!estCodeVeilleur(code)) return { ok: false, erreur: "Veilleur inconnu." };
  const f = FICHE_VEILLEUR.get(code)!;
  const seuil = r.seuil === undefined ? undefined : r.seuil === null ? null : Math.min(f.seuil.max, Math.max(f.seuil.min, Math.round(Number(r.seuil))));
  if (seuil !== undefined && seuil !== null && !Number.isFinite(seuil)) return { ok: false, erreur: "Seuil illisible." };
  const data = { ...(typeof r.actif === "boolean" ? { actif: r.actif } : {}), ...(seuil !== undefined ? { seuil } : {}) };
  await prisma.assistantVeilleur.upsert({ where: { userId_code: { userId, code } }, create: { userId, code, ...data }, update: data });
  // Désactivé : ce qui attendait de lui ne partira plus.
  if (r.actif === false) await prisma.assistantSignal.updateMany({ where: { userId, veilleur: code, etat: "EN_ATTENTE" }, data: { etat: "ECARTE" } });
  return { ok: true };
}

export async function reglerPreferences(userId: string, p: Record<string, unknown>): Promise<{ ok: true }> {
  const { interruptionsMaxJour } = await lireConsoleProactivite();
  const n = normaliserPreferences(p as never, interruptionsMaxJour);
  await prisma.assistantVeille.upsert({ where: { userId }, create: { userId, ...n }, update: n });
  return { ok: true };
}

/**
 * LE RETOUR EN UN CLIC — « utile » / « pas utile ». Compté sur le veilleur (taux d'utilité), il AJUSTE son
 * seuil (facteur). Changer d'avis corrige le compte au lieu de l'ajouter.
 */
export async function donnerRetour(userId: string, signalId: string, retour: "UTILE" | "PAS_UTILE", now = new Date()): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const s = await prisma.assistantSignal.findFirst({ where: { id: signalId, userId } });
  if (!s) return { ok: false, erreur: "Constat introuvable." };
  if (s.retour === retour) return { ok: true };
  await prisma.assistantSignal.update({ where: { id: s.id }, data: { retour, retourLe: now } });
  if (!estCodeVeilleur(s.veilleur)) return { ok: true };
  const r = await prisma.assistantVeilleur.findUnique({ where: { userId_code: { userId, code: s.veilleur } } });
  const utiles = (r?.utiles ?? 0) + (retour === "UTILE" ? 1 : 0) - (s.retour === "UTILE" ? 1 : 0);
  const inutiles = (r?.inutiles ?? 0) + (retour === "PAS_UTILE" ? 1 : 0) - (s.retour === "PAS_UTILE" ? 1 : 0);
  const facteur = ajusterFacteur(r?.facteur ?? 1, retour);
  await prisma.assistantVeilleur.upsert({
    where: { userId_code: { userId, code: s.veilleur } },
    create: { userId, code: s.veilleur, utiles: Math.max(0, utiles), inutiles: Math.max(0, inutiles), facteur },
    update: { utiles: Math.max(0, utiles), inutiles: Math.max(0, inutiles), facteur },
  });
  return { ok: true };
}

export async function ecarterSignal(userId: string, signalId: string): Promise<boolean> {
  return (await prisma.assistantSignal.updateMany({ where: { id: signalId, userId, etat: { in: ["EN_ATTENTE", "LIVRE", "JOURNAL"] } }, data: { etat: "ECARTE" } })).count === 1;
}

/**
 * À L'OUVERTURE D'UN DOSSIER — les constats ouverts de la personne sur CETTE fiche. Ne coûte aucune
 * interruption (elle est déjà là, elle regarde) ; un constat en attente est dit ici, et compte comme livré.
 */
export async function suggestionsDuDossier(userId: string, entiteType: string, entiteId: string, now = new Date()) {
  const signaux = await prisma.assistantSignal.findMany({
    where: { userId, entiteType, entiteId, etat: { in: ["EN_ATTENTE", "LIVRE", "JOURNAL"] } }, orderBy: { detecteLe: "desc" }, take: 5,
  });
  const enAttente = signaux.filter((s) => s.etat === "EN_ATTENTE").map((s) => s.id);
  if (enAttente.length) await prisma.assistantSignal.updateMany({ where: { id: { in: enAttente } }, data: { etat: "LIVRE", canal: "DOSSIER", livreLe: now } });
  return signaux.map((s) => ({ id: s.id, titre: s.titre, detail: s.detail, gravite: s.gravite, retour: s.retour }));
}

/** LA MESURE POUR LA CONSOLE — utilité et interruptions des 7 derniers jours, mandats en cours. */
export async function mesureProactivite(now = new Date()) {
  const depuis = new Date(now.getTime() - 7 * 86_400_000);
  const [retours, livraisons, mandats] = await Promise.all([
    prisma.assistantSignal.groupBy({ by: ["retour"], where: { retourLe: { gte: depuis }, retour: { not: null } }, _count: true }),
    prisma.assistantSignal.groupBy({ by: ["userId", "livreLe"], where: { canal: { in: ["INTERRUPTION", "MATIN"] }, livreLe: { gte: depuis } } }),
    listerMandats(null, now),
  ]);
  const utiles = retours.find((r) => r.retour === "UTILE")?._count ?? 0;
  const inutiles = retours.find((r) => r.retour === "PAS_UTILE")?._count ?? 0;
  const personnes = new Set(livraisons.map((l) => l.userId)).size;
  return {
    utilite: phraseUtilite({ utiles, inutiles }), taux: tauxUtile({ utiles, inutiles }),
    interruptionsParPersonneJour: personnes ? Math.round((livraisons.length / personnes / 7) * 10) / 10 : 0,
    personnes, mandats,
  };
}
