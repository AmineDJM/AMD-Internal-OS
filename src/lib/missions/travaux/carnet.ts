import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PlanTravail } from "@/lib/missions/travaux/plan";
import type { DocumentLivrable } from "@/lib/missions/travaux/persona";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CARNET DE TRAVAIL (J2) — la mémoire d'un chantier : objectif, plan, notes, trouvailles, livrables.
 *
 * Chaque étape d'analyse le RELIT à la place de l'historique complet : un travail de trois semaines
 * ne rejoue pas trois semaines de conversation à chaque appel de modèle, il relit ce qu'il a noté.
 *
 * L'écriture est IDEMPOTENTE PAR ÉTAPE : une étape réécrit SA part (ses notes remplacent ses notes),
 * sous un verrou de ligne. Une étape rejouée après un redémarrage — l'appel de modèle a eu lieu, le
 * reçu n'a pas été écrit — ne double donc pas ses trouvailles ; deux étapes parallèles ne s'écrasent
 * pas l'une l'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EntreeCarnet { etape: string; texte: string; at: string }
/** J8 : `document` — le vrai document déposé au Drive de la personne (Word, PDF, Excel), inscrit à la Bibliothèque. */
export interface LivrableCarnet { etape: string; titre: string; contenu: string; at: string; document?: DocumentLivrable }

export interface Carnet {
  objectif: string;
  /** Le plan tel que la personne l'a approuvé (ou va l'approuver) — la carte le relit. */
  plan: PlanTravail | null;
  notes: EntreeCarnet[];
  trouvailles: EntreeCarnet[];
  livrables: LivrableCarnet[];
}

const BORNES = { entrees: 300, texte: 2_000, livrable: 60_000 } as const;

export function carnetInitial(plan: PlanTravail): Carnet {
  return { objectif: plan.objectif, plan, notes: [], trouvailles: [], livrables: [] };
}

/** Relit un carnet venu de la base — retypé, jamais cru sur parole. */
export function lireCarnet(v: unknown): Carnet {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const entrees = (x: unknown): EntreeCarnet[] => (Array.isArray(x) ? x : [])
    .filter((e): e is EntreeCarnet => !!e && typeof e === "object" && typeof (e as EntreeCarnet).texte === "string")
    .map((e) => ({ etape: String(e.etape ?? ""), texte: e.texte, at: String(e.at ?? "") }));
  const livrables = (Array.isArray(o.livrables) ? o.livrables : [])
    .filter((e): e is LivrableCarnet => !!e && typeof e === "object" && typeof (e as LivrableCarnet).contenu === "string")
    .map((e) => ({
      etape: String(e.etape ?? ""), titre: String(e.titre ?? ""), contenu: e.contenu, at: String(e.at ?? ""),
      ...(e.document && typeof e.document === "object" && typeof e.document.nodeId === "string" ? { document: e.document } : {}),
    }));
  return {
    objectif: typeof o.objectif === "string" ? o.objectif : "",
    plan: o.plan && typeof o.plan === "object" ? (o.plan as PlanTravail) : null,
    notes: entrees(o.notes),
    trouvailles: entrees(o.trouvailles),
    livrables,
  };
}

/**
 * ÉCRIT LA PART D'UNE ÉTAPE dans le carnet — remplace ce que cette étape y avait mis (rejeu sûr), sous
 * `SELECT … FOR UPDATE` (deux étapes parallèles écrivent l'une après l'autre, jamais l'une SUR l'autre).
 */
export async function ecrireAuCarnet(
  missionId: string,
  etape: string,
  part: { notes?: string[]; trouvailles?: string[]; livrable?: { titre: string; contenu: string; document?: DocumentLivrable } },
  maintenant = new Date(),
): Promise<void> {
  const at = maintenant.toISOString();
  const coupe = (t: string) => t.trim().slice(0, BORNES.texte);
  await prisma.$transaction(async (tx) => {
    const lignes = await tx.$queryRaw<{ carnet: unknown }[]>`SELECT "carnet" FROM "Mission" WHERE "id" = ${missionId} FOR UPDATE`;
    if (lignes.length === 0) return;
    const c = lireCarnet(lignes[0]!.carnet);
    const sans = <T extends { etape: string }>(l: T[]) => l.filter((e) => e.etape !== etape);
    const notes = [...sans(c.notes), ...(part.notes ?? []).filter((t) => t.trim()).map((t) => ({ etape, texte: coupe(t), at }))].slice(-BORNES.entrees);
    const trouvailles = [...sans(c.trouvailles), ...(part.trouvailles ?? []).filter((t) => t.trim()).map((t) => ({ etape, texte: coupe(t), at }))].slice(-BORNES.entrees);
    const livrables = part.livrable
      ? [...sans(c.livrables), {
        etape, titre: part.livrable.titre.slice(0, 200), contenu: part.livrable.contenu.slice(0, BORNES.livrable), at,
        ...(part.livrable.document ? { document: part.livrable.document } : {}),
      }]
      : c.livrables;
    await tx.mission.update({
      where: { id: missionId },
      data: { carnet: { ...c, notes, trouvailles, livrables } as unknown as Prisma.InputJsonValue },
    });
  });
}

/**
 * CE QU'UNE ÉTAPE RELIT DU CARNET — borné : l'objectif, le plan en une ligne par étape, puis les
 * trouvailles et les notes les PLUS RÉCENTES jusqu'à `maxCaracteres`. Jamais l'historique entier.
 */
export function carnetPourEtape(c: Carnet, maxCaracteres = 12_000): string {
  const lignes: string[] = [`OBJECTIF : ${c.objectif}`];
  if (c.plan) lignes.push("PLAN :", ...c.plan.etapes.map((e, i) => `  ${i + 1}. [${e.type}] ${e.titre}`));
  const recentes = (titre: string, l: EntreeCarnet[]) => {
    const out: string[] = [];
    let taille = 0;
    for (const e of [...l].reverse()) {
      const ligne = `  • (${e.etape}) ${e.texte}`;
      if (taille + ligne.length > maxCaracteres / 2) break;
      out.unshift(ligne);
      taille += ligne.length;
    }
    return out.length ? [titre, ...out] : [];
  };
  lignes.push(...recentes("TROUVAILLES :", c.trouvailles), ...recentes("NOTES :", c.notes));
  return lignes.join("\n");
}
