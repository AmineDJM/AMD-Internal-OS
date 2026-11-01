import { prismaBrut } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { journaliserGeste } from "./journal";
import { etatDuGeste } from "./magasin";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GESTE D'ÉCRAN RÉVERSIBLE (K10b, décision 0038) — « toute action peut être réversible », d'un bouton.
 *
 * `gesteReversible(user, { capaciteId, libelle }, geste)` exécute le corps d'une action de l'ERP SOUS LE JOURNAL DES
 * EFFETS (J7) : chaque écriture garde sa ligne avant / après, chaque effet sortant attend sa FENÊTRE D'ANNULATION
 * (`fenetre.ts`). L'action rend exactement ce qu'elle rendait ; le geste entre au journal avec l'origine `ecran`, et la
 * barre « Annuler » de l'application (`ecrans/barre-annulation.tsx`) le propose aussitôt à la personne ; l'historique
 * de la fiche (`gestesDeLaFiche`) le garde.
 *
 * Sous une carte de l'assistant (ou un travail), le geste est déjà journalisé : rien n'est ouvert en double, ses
 * écritures vont au geste qui le contient — l'annulation est la même.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MetaGesteEcran {
  /** L'action du contrat (`fichier:fonction`) — le registre la relie à sa déclaration d'annulation. */
  capaciteId: string;
  /** La phrase du geste, montrée dans la barre et l'historique : « Courrier enregistré », « Directive publiée ». */
  libelle: string;
}

export async function gesteReversible<T>(user: CurrentUser | { id: string }, meta: MetaGesteEcran, geste: () => Promise<T>): Promise<T> {
  // Une simulation (carte en préparation) ou un geste déjà journalisé : il n'ouvre rien.
  if (etatDuGeste()?.capture) return geste();
  const { resultat } = await journaliserGeste(user as CurrentUser, { origine: "ecran", capaciteId: meta.capaciteId, libelle: meta.libelle }, geste);
  return resultat;
}

export interface GesteEcranVu {
  id: string;
  libelle: string;
  capaciteId: string | null;
  quand: string;
  resultat: string;
  annuleLe: string | null;
  /** Le compte rendu de la dernière annulation (ou du rétablissement), s'il y en a un. */
  issue: string | null;
}

/** Les gestes RÉCENTS d'une personne (écran, cartes) — la barre « Annuler » de l'application. */
export async function gestesRecents(user: CurrentUser, minutes = 10): Promise<GesteEcranVu[]> {
  const gestes = await prismaBrut.assistantGesteJournal.findMany({
    where: { principalId: user.id, resultat: "FAIT", creeLe: { gte: new Date(Date.now() - minutes * 60_000) }, effets: { some: {} } },
    orderBy: { creeLe: "desc" }, take: 5,
    select: { id: true, libelle: true, capaciteId: true, creeLe: true, resultat: true, annuleLe: true, annulation: true },
  });
  return gestes.map(vue);
}

/** L'HISTORIQUE D'UNE FICHE — les gestes journalisés qui ont touché cette ligne (le plus récent d'abord). */
export async function gestesDeLaFiche(user: CurrentUser, modele: string, id: string): Promise<GesteEcranVu[]> {
  const gestes = await prismaBrut.assistantGesteJournal.findMany({
    where: { ...(user.role === "SUPER_ADMIN" ? {} : { principalId: user.id }), effets: { some: { modele, enregistrementId: id } } },
    orderBy: { creeLe: "desc" }, take: 20,
    select: { id: true, libelle: true, capaciteId: true, creeLe: true, resultat: true, annuleLe: true, annulation: true },
  });
  return gestes.map(vue);
}

function vue(g: { id: string; libelle: string; capaciteId: string | null; creeLe: Date; resultat: string; annuleLe: Date | null; annulation: unknown }): GesteEcranVu {
  const a = g.annulation as { resume?: string } | null;
  return { id: g.id, libelle: g.libelle, capaciteId: g.capaciteId, quand: g.creeLe.toISOString(), resultat: g.resultat, annuleLe: g.annuleLe?.toISOString() ?? null, issue: a?.resume ?? null };
}
