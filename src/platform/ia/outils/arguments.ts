/**
 * LA LECTURE DES ARGUMENTS D'OUTIL — chaînes et nombres tirés de l'entrée du modèle, et la
 * résolution d'une personne de l'annuaire interne (unique, ambiguë ou introuvable — jamais inventée).
 */

import type { Priority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resoudreEntite } from "@/lib/fabric/entites";
import { sansBloquer } from "@/lib/journal";

/** Un libellé replié pour être comparé : minuscules, sans accents, ponctuation réduite à un espace. */
export const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Une priorité lue dans l'entrée du modèle — `null` si ce n'en est pas une. */
export function normPriority(p: string): Priority | null {
  const up = p.toUpperCase();
  return (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).includes(up as Priority) ? (up as Priority) : null;
}

/** Une date lue dans l'entrée du modèle, rendue AAAA-MM-JJ — `null` si elle ne se lit pas. */
export function isoDate(s: string): string | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function asStr(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Un nombre venu du modèle — `null` s'il n'en a pas donné, ou s'il a écrit autre chose. */
export function asNum(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

interface PersonMatch { id: string; name: string; title: string | null; department: string | null; role: string }

export async function findPeople(query: string, limit = 8): Promise<PersonMatch[]> {
  const q = query.trim();
  if (!q) return [];
  // Recherche par NOM **ou par FONCTION** (title) : « l'assistante de direction »,
  // « la Direction Marketing »… se résolvent par leur intitulé de poste, pas seulement
  // par leur prénom.
  const users = await prisma.user.findMany({
    where: { isActive: true, OR: [{ name: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
    select: { id: true, name: true, title: true, role: true, department: { select: { name: true } } },
    take: limit,
    orderBy: { name: "asc" },
  });
  return users.map((u) => ({ id: u.id, name: u.name, title: u.title, department: u.department?.name ?? null, role: u.role }));
}

/**
 * Résout un nom OU une fonction en un utilisateur unique pour l'assignation.
 *
 * LA BRIQUE DE RÉSOLUTION (fabric F9) tranche d'abord — fautes de frappe, ordre des mots,
 * homonymes : CERTAIN ou PROBABLE = un compte ; AMBIGU = la liste, jamais un choix à la place de
 * la personne. La recherche par FONCTION (« le DAF ») reste celle de l'annuaire des comptes.
 */
export async function resolvePerson(brut: string): Promise<{ id: string; name: string } | { ambiguous: PersonMatch[] } | null> {
  /**
   * ── « Nom <adresse> » EST UNE DÉSIGNATION VALIDE, PAS UNE ÉNIGME ──────────────────────
   *
   * MESURÉ live (chaîne budgétaire) : une mission a échoué sur
   * « Destinataire « Yacine Benali <yacine.benali@adventum-bench.dz> » introuvable ou ambigu ».
   * Yacine Benali est le PDG, il EST en base, et son adresse était là, dans la chaîne même.
   * Adam avait la personne ; c'est le lecteur qui ne savait pas lire la forme la plus naturelle
   * qu'un modèle emploie pour désigner un destinataire — celle de tous les clients de courrier.
   *
   * Un « je ne peux pas » de cette espèce est artificiel (§63) : rien ne manquait. On détache
   * donc l'adresse du libellé, on résout sur le NOM, et l'adresse sert de recours EXACT —
   * une adresse n'est pas un indice flou, c'est un identifiant.
   */
  const mailbox = brut.match(/^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  const query = (mailbox?.[1] || brut).trim() || brut.trim();
  const adresse = mailbox?.[2]?.toLowerCase() ?? null;

  const q = query.trim().toLowerCase();
  const matches = await findPeople(query, 8);
  const exact = matches.filter((m) => m.name.toLowerCase() === q || (m.title ?? "").toLowerCase() === q);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name };
  const r = await resoudreEntite(query, { types: ["PERSONNE"] }).catch(sansBloquer("assistant.resolvePerson.resoudreEntite", null));
  if (r && (r.verdict === "CERTAIN" || r.verdict === "PROBABLE") && r.retenu) {
    // La brique rend l'identifiant du COMPTE quand il existe (un salarié sans compte ne peut rien recevoir).
    const compte = await prisma.user.findUnique({ where: { id: r.retenu.id }, select: { id: true, name: true, isActive: true } }).catch(sansBloquer("assistant.resolvePerson.user", null));
    if (compte?.isActive) return { id: compte.id, name: compte.name };
  }
  if (r && r.verdict === "AMBIGU" && r.candidats.length) {
    const comptes = await prisma.user.findMany({ where: { id: { in: r.candidats.map((c) => c.id) }, isActive: true }, select: { id: true, name: true, title: true, role: true, department: { select: { name: true } } } }).catch(sansBloquer("assistant.resolvePerson.user", []));
    if (comptes.length >= 2) return { ambiguous: comptes.map((u) => ({ id: u.id, name: u.name, title: u.title, department: u.department?.name ?? null, role: u.role })) };
  }
  // L'ADRESSE TRANCHE, ET ELLE NE TRANCHE QU'À L'EXACT. Elle sert quand le nom n'a rien donné
  // comme quand il en a donné trop : entre deux homonymes, l'adresse désigne sans ambiguïté.
  if (adresse) {
    const parAdresse = await prisma.user.findFirst({
      where: { email: { equals: adresse, mode: "insensitive" }, isActive: true },
      select: { id: true, name: true },
    }).catch(sansBloquer("assistant.resolvePerson.user", null));
    if (parAdresse) return parAdresse;
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  return { ambiguous: matches };
}
