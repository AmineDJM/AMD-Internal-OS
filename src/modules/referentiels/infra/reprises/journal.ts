import { prisma } from "@/lib/prisma";

/**
 * LE JOURNAL DES REPRISES : une ligne d'audit par lot exécuté (module « Refonte des données », champ = la clé
 * de la reprise, `newValue` = le bilan en JSON). Pas de table de plus : le journal d'audit est déjà celui que
 * la Direction relit, avec l'auteur et l'heure.
 */
export const MODULE_JOURNAL_REFONTE = "Refonte des données";

export interface EntreeJournal {
  le: Date;
  par: string | null;
  resume: string | null;
  /** Curseur du lot suivant — nul : la reprise était terminée après ce lot. */
  suite: string | null;
}

export async function lireJournal(cle: string, n = 8): Promise<EntreeJournal[]> {
  const lignes = await prisma.auditLog.findMany({
    where: { module: MODULE_JOURNAL_REFONTE, field: cle },
    orderBy: { createdAt: "desc" },
    take: n,
    select: { createdAt: true, summary: true, newValue: true, actor: { select: { name: true } } },
  });
  return lignes.map((l) => ({ le: l.createdAt, par: l.actor?.name ?? null, resume: l.summary, suite: suiteDe(l.newValue) }));
}

function suiteDe(json: string | null): string | null {
  try {
    const v = json ? (JSON.parse(json) as { suite?: unknown }) : null;
    return typeof v?.suite === "string" ? v.suite : null;
  } catch {
    return null;
  }
}
