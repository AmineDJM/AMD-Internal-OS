import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉMOIRE TECHNIQUE PERMANENTE (lot C1, décision 0042 ; CHANTIERS-DEV.md § 6) — ce qu'un chantier n'a pas à
 * réanalyser : dépôts (branche de base, commandes de vérification), services Render (id, type, santé, ordre),
 * branches, décisions, dépendances, incidents et leurs correctifs.
 *
 * Écrite par les événements (fin de chantier, déploiement, blocage, webhooks GitHub/Render via `noterEvenementDev`)
 * et lue PAR EXTRAITS : des clés EXACTES, au plus ~2 000 jetons — jamais « toute la mémoire » dans une consigne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPES_MEMOIRE = ["depot", "service", "branche", "decision", "dependance", "incident"] as const;
export type TypeMemoire = (typeof TYPES_MEMOIRE)[number];

/** ~4 caractères par jeton : 2 000 jetons ≈ 8 000 caractères. */
export const EXTRAIT_MAX_JETONS = 2_000;
const CARACTERES_PAR_JETON = 4;
const CONTENU_MAX = 4_000;

export async function memoriser(type: TypeMemoire, cle: string, contenu: string, origine?: { source?: string; missionId?: string }): Promise<void> {
  const texte = contenu.trim().slice(0, CONTENU_MAX);
  if (!texte || !cle.trim()) return;
  await prisma.memoireTechnique.upsert({
    where: { type_cle: { type, cle: cle.trim().slice(0, 200) } },
    create: { type, cle: cle.trim().slice(0, 200), contenu: texte, source: origine?.source ?? null, missionId: origine?.missionId ?? null },
    update: { contenu: texte, source: origine?.source ?? null, missionId: origine?.missionId ?? null },
  });
}

/**
 * UN EXTRAIT — les clés demandées, dans l'ordre, plus les `incidents` les plus récents d'un préfixe (ex. le dépôt),
 * tronqué au budget de jetons. Rend du texte prêt à poser dans une consigne, ou une chaîne vide.
 */
export async function extraitMemoire(d: {
  cles: readonly { type: TypeMemoire; cle: string }[]; incidentsDe?: string; incidentsMax?: number; maxJetons?: number;
}): Promise<string> {
  const budget = (d.maxJetons ?? EXTRAIT_MAX_JETONS) * CARACTERES_PAR_JETON;
  const exactes = d.cles.length
    ? await prisma.memoireTechnique.findMany({ where: { OR: d.cles.map((c) => ({ type: c.type, cle: c.cle })) }, select: { type: true, cle: true, contenu: true, majLe: true } })
    : [];
  const ordonnees = d.cles.flatMap((c) => exactes.filter((x) => x.type === c.type && x.cle === c.cle));
  const incidents = d.incidentsDe
    ? await prisma.memoireTechnique.findMany({
      where: { type: "incident", cle: { startsWith: d.incidentsDe } }, orderBy: { majLe: "desc" }, take: d.incidentsMax ?? 5,
      select: { type: true, cle: true, contenu: true, majLe: true },
    })
    : [];
  let texte = "";
  for (const m of [...ordonnees, ...incidents]) {
    const bloc = `[${m.type} ${m.cle} — ${m.majLe.toISOString().slice(0, 10)}]\n${m.contenu}\n`;
    if (texte.length + bloc.length > budget) {
      const reste = budget - texte.length;
      if (reste > 200) texte += `${bloc.slice(0, reste - 1)}…`;
      break;
    }
    texte += bloc;
  }
  return texte.trim();
}

/**
 * UN ÉVÉNEMENT DE LA FORGE OU DE L'HÉBERGEUR (webhook signé, traité par C2) — retenu en mémoire quand il apprend
 * quelque chose de durable (un service, sa santé, un déploiement échoué). Rend vrai si la mémoire a changé.
 */
export async function noterEvenementDev(e: { type: "service" | "incident" | "branche"; cle: string; contenu: string; source: string; missionId?: string }): Promise<boolean> {
  if (!e.contenu.trim()) return false;
  await memoriser(e.type, e.cle, e.contenu, { source: e.source, ...(e.missionId ? { missionId: e.missionId } : {}) });
  return true;
}
