import { prisma } from "@/lib/prisma";
import { FEATURE_ASSISTANT_IA } from "@/lib/agent/consommation";
import { debutJourAlger } from "@/lib/agent/consommation-regles";

/**
 * LES CHIFFRES DE L'ÉCRAN « CONSOMMATION IA » (lot V3-D) — lus dans `ModelCallLog` (feature
 * `assistant_ia`, une ligne par appel du modèle), agrégés EN BASE : l'écran lit quelques dizaines de
 * lignes, jamais des milliers d'appels. Un coût inconnu (tarif MiMo absent) est compté À PART : la
 * somme des coûts connus n'est jamais présentée comme le total quand des appels sans tarif existent.
 */

export interface Agregat {
  appels: number;
  entree: number;
  sortie: number;
  /** Somme des coûts CONNUS, en dollars. */
  coutUsd: number;
  /** Appels sans tarif — le coût ci-dessus n'est complet que s'il vaut zéro. */
  sansTarif: number;
}

export interface LignePersonne extends Agregat {
  userId: string;
  nom: string;
  jetonsAujourdhui: number;
  jetons7j: number;
}

export interface LigneJour extends Agregat { jour: string; personnes: number }
export interface LigneModele extends Agregat { provider: string; model: string }

export interface ConsommationAssistantIa {
  depuis: Date;
  jours: number;
  total: Agregat;
  aujourdHui: Agregat;
  parPersonne: LignePersonne[];
  parJour: LigneJour[];
  parModele: LigneModele[];
  plafondsAtteints: { nom: string; jour: string; jetons: number; plafond: number }[];
}

type Brut = { appels: unknown; entree: unknown; sortie: unknown; cout: unknown; sansTarif: unknown };
const n = (v: unknown): number => (v == null ? 0 : Number(v));
const agregat = (r: Brut | undefined): Agregat => ({
  appels: n(r?.appels), entree: n(r?.entree), sortie: n(r?.sortie),
  coutUsd: Math.round(n(r?.cout) * 1_000_000) / 1_000_000, sansTarif: n(r?.sansTarif),
});

// Les colonnes d'agrégat, écrites une fois.
const COLONNES = `COUNT(*) AS "appels", SUM("inputTokens") AS "entree", SUM("outputTokens") AS "sortie",
  SUM(COALESCE("costUsd", 0)) AS "cout", SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS "sansTarif"`;

export async function consommationAssistantIa(jours = 30, now: Date = new Date()): Promise<ConsommationAssistantIa> {
  const aujourdhui = debutJourAlger(now);
  const depuis = new Date(aujourdhui.getTime() - (jours - 1) * 86_400_000);
  const il7j = new Date(aujourdhui.getTime() - 6 * 86_400_000);
  const F = FEATURE_ASSISTANT_IA;

  const [total, jour, personnes, parJour, parModele, atteints] = await Promise.all([
    prisma.$queryRawUnsafe<Brut[]>(`SELECT ${COLONNES} FROM "ModelCallLog" WHERE "feature" = $1 AND "at" >= $2`, F, depuis),
    prisma.$queryRawUnsafe<Brut[]>(`SELECT ${COLONNES} FROM "ModelCallLog" WHERE "feature" = $1 AND "at" >= $2`, F, aujourdhui),
    prisma.$queryRawUnsafe<(Brut & { userId: string; jAujourdhui: unknown; j7: unknown })[]>(
      `SELECT "userId", ${COLONNES},
              SUM(CASE WHEN "at" >= $3 THEN "inputTokens" + "outputTokens" ELSE 0 END) AS "jAujourdhui",
              SUM(CASE WHEN "at" >= $4 THEN "inputTokens" + "outputTokens" ELSE 0 END) AS "j7"
       FROM "ModelCallLog" WHERE "feature" = $1 AND "at" >= $2 AND "userId" IS NOT NULL
       GROUP BY "userId" ORDER BY SUM("inputTokens" + "outputTokens") DESC LIMIT 100`,
      F, depuis, aujourdhui, il7j,
    ),
    // Le jour d'Alger : l'heure UTC décalée d'une heure, puis tronquée au jour.
    prisma.$queryRawUnsafe<(Brut & { jour: string; personnes: unknown })[]>(
      `SELECT to_char(date_trunc('day', "at" + interval '1 hour'), 'YYYY-MM-DD') AS "jour", ${COLONNES},
              COUNT(DISTINCT "userId") AS "personnes"
       FROM "ModelCallLog" WHERE "feature" = $1 AND "at" >= $2
       GROUP BY 1 ORDER BY 1 DESC`,
      F, depuis,
    ),
    prisma.$queryRawUnsafe<(Brut & { provider: string; model: string })[]>(
      `SELECT "provider", "model", ${COLONNES} FROM "ModelCallLog" WHERE "feature" = $1 AND "at" >= $2
       GROUP BY "provider", "model" ORDER BY SUM("inputTokens" + "outputTokens") DESC`,
      F, depuis,
    ),
    prisma.assistantIaPlafondAtteint.findMany({ where: { createdAt: { gte: depuis } }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);

  const ids = [...new Set([...personnes.map((p) => p.userId), ...atteints.map((a) => a.userId)])];
  const noms = new Map((ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const nomDe = (id: string) => noms.get(id) ?? "Compte supprimé";

  return {
    depuis, jours,
    total: agregat(total[0]),
    aujourdHui: agregat(jour[0]),
    parPersonne: personnes.map((p) => ({ ...agregat(p), userId: p.userId, nom: nomDe(p.userId), jetonsAujourdhui: n(p.jAujourdhui), jetons7j: n(p.j7) })),
    parJour: parJour.map((j) => ({ ...agregat(j), jour: j.jour, personnes: n(j.personnes) })),
    parModele: parModele.map((m) => ({ ...agregat(m), provider: m.provider, model: m.model })),
    plafondsAtteints: atteints.map((a) => ({ nom: nomDe(a.userId), jour: a.jour.toISOString().slice(0, 10), jetons: a.jetons, plafond: a.plafond })),
  };
}
