import { prismaBrut } from "@/lib/prisma";

/**
 * LES GESTES FAITS EN « AGIR COMME » (Direction, 16/11/2026) — ce que le Super Admin a fait dans la peau d'une personne, du
 * plus récent au plus ancien, avec ce que chaque geste a touché et s'il est déjà annulé. Lu par la page du Super Admin seul.
 */
export interface GesteAgirComme {
  id: string;
  quand: string;
  libelle: string;
  personneId: string;
  personne: string;
  superAdmin: string;
  ecritures: number;
  modeles: string[];
  annuleLe: string | null;
  issue: string | null;
}

export async function gestesAgirComme(limite = 300): Promise<GesteAgirComme[]> {
  const gestes = await prismaBrut.assistantGesteJournal.findMany({
    where: { parVueExacteId: { not: null }, origine: { not: "annulation" } },
    orderBy: { creeLe: "desc" }, take: limite,
    select: {
      id: true, creeLe: true, libelle: true, principalId: true, parVueExacteId: true, annuleLe: true, annulation: true,
      effets: { select: { modele: true, type: true } },
    },
  });
  const ids = [...new Set(gestes.flatMap((g) => [g.principalId, g.parVueExacteId!]))];
  const noms = new Map((ids.length ? await prismaBrut.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  return gestes.map((g) => ({
    id: g.id, quand: g.creeLe.toISOString(), libelle: g.libelle, personneId: g.principalId,
    personne: noms.get(g.principalId) ?? "—", superAdmin: noms.get(g.parVueExacteId!) ?? "—",
    ecritures: g.effets.filter((e) => e.type === "ECRITURE").length,
    modeles: [...new Set(g.effets.map((e) => e.modele).filter((m): m is string => Boolean(m)))].slice(0, 6),
    annuleLe: g.annuleLe?.toISOString() ?? null,
    issue: (g.annulation as { resume?: string } | null)?.resume ?? null,
  }));
}
