/**
 * LIEUX — LIRE ET POSER `wilayaCode` EN BASE (serveur). La règle est dans `rattachement.ts` (pur) ; ici, seulement
 * l'accès : lire un lot de fiches, écrire les codes qui ont changé, et la DOUBLE ÉCRITURE appelée par les actions.
 *
 * SQL brut, et pourquoi : la même lecture sert cinq tables aux colonnes différentes, et l'écriture ne doit PAS
 * toucher `updatedAt` — rattacher 8 000 praticiens à leur wilaya n'est pas « modifier 8 000 fiches », et un tri
 * « récemment modifiés » n'a pas à s'en trouver bouleversé. Les noms de table et de colonne interpolés viennent
 * tous de `COLONNES_LIEU` (constantes) ; les valeurs passent en paramètres.
 */
import { prisma } from "@/lib/prisma";
import { COLONNES_LIEU, rattacherFiche, type ModeleLieu, type ValeursLieu } from "../domaine/rattachement";

export interface FicheLieu {
  id: string;
  valeurs: ValeursLieu;
  wilayaCode: string | null;
}

function colonnes(modele: ModeleLieu): string[] {
  const c = COLONNES_LIEU[modele];
  return [c.wilaya, c.ville, c.region, c.pays].filter((x): x is string => Boolean(x));
}

function selectFiches(modele: ModeleLieu): string {
  const cols = colonnes(modele).map((c) => `"${c}"`).join(", ");
  return `SELECT "id", "wilayaCode", ${cols} FROM "${modele}"`;
}

function versFiche(modele: ModeleLieu, r: Record<string, string | null>): FicheLieu {
  const valeurs: Record<string, string | null> = {};
  for (const c of colonnes(modele)) valeurs[c] = r[c] ?? null;
  return { id: r.id!, wilayaCode: r.wilayaCode ?? null, valeurs };
}

/** Un lot de fiches dans l'ordre des identifiants, après `apresId` (exclu). */
export async function lireLotLieux(modele: ModeleLieu, apresId: string | null, taille: number): Promise<FicheLieu[]> {
  const rangs = await prisma.$queryRawUnsafe<Record<string, string | null>[]>(
    `${selectFiches(modele)} WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT $2`,
    apresId,
    taille,
  );
  return rangs.map((r) => versFiche(modele, r));
}

/** Les fiches désignées (double écriture). */
export async function lireFichesLieux(modele: ModeleLieu, ids: readonly string[]): Promise<FicheLieu[]> {
  if (!ids.length) return [];
  const rangs = await prisma.$queryRawUnsafe<Record<string, string | null>[]>(
    `${selectFiches(modele)} WHERE "id" = ANY($1::text[])`,
    [...ids],
  );
  return rangs.map((r) => versFiche(modele, r));
}

/** Écrit les codes, regroupés par valeur (une requête par code), sans toucher `updatedAt`. Rend le nombre écrit. */
export async function poserWilayaCodes(modele: ModeleLieu, changements: readonly { id: string; code: string | null }[]): Promise<number> {
  const parCode = new Map<string | null, string[]>();
  for (const { id, code } of changements) parCode.set(code, [...(parCode.get(code) ?? []), id]);
  let n = 0;
  for (const [code, ids] of parCode) {
    n += await prisma.$executeRawUnsafe(
      `UPDATE "${modele}" SET "wilayaCode" = $1 WHERE "id" = ANY($2::text[]) AND "wilayaCode" IS DISTINCT FROM $1`,
      code,
      ids,
    );
  }
  return n;
}

/** L'interrupteur de la double écriture (`AppSetting.lieuxDoubleEcriture`, vrai par défaut et sans ligne). */
export async function doubleEcritureLieuxActive(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { lieuxDoubleEcriture: true } });
  return row?.lieuxDoubleEcriture ?? true;
}

/**
 * DOUBLE ÉCRITURE — à appeler APRÈS l'écriture du texte, avec les fiches touchées : relit leur lieu tel qu'il est
 * maintenant en base et pose le code qui en découle (ou `null` si le texte est devenu vide ou ambigu). Relire
 * plutôt que recevoir la saisie : une mise à jour partielle (la seule ville, une cellule de la feuille) laisse les
 * autres colonnes en place, et c'est la fiche ENTIÈRE qui dit sa wilaya.
 *
 * NON BLOQUANTE (palier P3, `refonte-p3-inventaire.md` §5.1) : un échec est journalisé et laisse l'ancien code —
 * la reprise le rattrapera. L'action métier ne doit pas échouer à cause du référentiel tant qu'aucun écran ne lit
 * le code pour décider.
 */
export async function reposerWilayaCode(modele: ModeleLieu, ids: string | readonly string[]): Promise<void> {
  const liste = typeof ids === "string" ? [ids] : ids;
  if (!liste.length) return;
  try {
    if (!(await doubleEcritureLieuxActive())) return;
    const fiches = await lireFichesLieux(modele, liste);
    const changements = fiches
      .map((f) => ({ id: f.id, code: rattacherFiche(modele, f.valeurs).code, avant: f.wilayaCode }))
      .filter((c) => c.code !== c.avant);
    if (changements.length) await poserWilayaCodes(modele, changements);
  } catch (e) {
    console.error(`[lieux] double écriture ${modele} (${liste.length} fiche(s)) :`, e instanceof Error ? e.message : e);
  }
}
