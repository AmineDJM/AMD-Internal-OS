/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DOUBLE ÉCRITURE DES PERSONNES (refonte des données, palier P3, lot V2-B).
 *
 * Les écrivains de création (`docs/architecture/refonte-p3-inventaire.md` §1 — salarié, praticien,
 * bénéficiaire de prise en charge, voyageur, hébergement, candidat, compte) appellent `relierALaPersonne`
 * DANS LEUR TRANSACTION, juste après avoir créé leur ligne : la Personne est créée ou reliée par le MÊME
 * geste que la reprise (`rattachement.ts`), donc avec le même identifiant déterministe.
 *
 * DERRIÈRE UN INTERRUPTEUR (`AppSetting.refontePersonnesDoubleEcriture`, éteint par défaut) : tant qu'il est
 * éteint, l'écrivain se comporte exactement comme avant. Lu dans la transaction de l'écrivain, il ne coûte
 * qu'une lecture de la ligne de réglages.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { assurerRole, delegue, lireSource, rattacher, suivreFusion, type Db } from "@/lib/referentiels/personnes/rattachement";
import { ROLE_DE_LA_SOURCE, type SourcePersonne } from "@/lib/referentiels/personnes/sources";

export async function doubleEcriturePersonnesActive(db: Db): Promise<boolean> {
  const r = await db.appSetting.findUnique({ where: { id: "global" }, select: { refontePersonnesDoubleEcriture: true } });
  return r?.refontePersonnesDoubleEcriture === true;
}

/** Relie la ligne créée à sa Personne, si l'interrupteur est allumé. À appeler dans la transaction de l'écrivain. */
export async function relierALaPersonne(db: Db, source: SourcePersonne, id: string, creeParId: string | null): Promise<void> {
  if (!(await doubleEcriturePersonnesActive(db))) return;
  await rattacher(db, source, id, { creeParId });
}

/** Même chose pour plusieurs lignes d'une même table (les fiches créées avec un poste, les bénéficiaires d'une demande). */
export async function relierLesPersonnes(db: Db, source: SourcePersonne, ids: readonly string[], creeParId: string | null): Promise<void> {
  if (!ids.length || !(await doubleEcriturePersonnesActive(db))) return;
  for (const id of ids) await rattacher(db, source, id, { creeParId });
}

/**
 * La ligne créée À PARTIR d'une autre (la fiche salarié née d'une candidature) rejoint la Personne de cette autre ligne,
 * même si celle-ci était déjà reliée — le lien que l'ERP pose (`employeeId`) va de la candidature vers la fiche, la
 * remontée des racines ne le verrait donc pas dans ce sens. Une ligne modèle encore sans Personne est rattachée
 * normalement : sa chaîne relie les deux.
 */
export async function relierCommeLaLigne(
  db: Db, source: SourcePersonne, id: string, modele: { source: SourcePersonne; id: string }, creeParId: string | null,
): Promise<void> {
  if (!(await doubleEcriturePersonnesActive(db))) return;
  const m = await lireSource(db, modele.source, modele.id);
  if (!m?.personneId) {
    await rattacher(db, modele.source, modele.id, { creeParId });
    await rattacher(db, source, id, { creeParId });
    return;
  }
  const personneId = await suivreFusion(db, m.personneId);
  await assurerRole(db, personneId, ROLE_DE_LA_SOURCE[source], creeParId);
  await delegue(db, source).updateMany({ where: { id, personneId: null }, data: { personneId } });
}
