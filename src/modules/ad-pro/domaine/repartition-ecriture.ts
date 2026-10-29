import type { AdProItemBudgetKind, AdProItemKind, Prisma } from "@prisma/client";

/**
 * Une ligne de répartition PRÊTE À ÉCRIRE — le libellé est composé par l'appelant, qui détient la
 * table des natures (§118.175). Ce module n'écrit que ce qu'on lui donne.
 */
export interface PosteReparti {
  kind: AdProItemKind;
  label: string;
  montant: number;
  payeA: string | null;
}

/**
 * ÉCRIT LES POSTES D'UNE RÉPARTITION — un seul écrivain pour l'ajout d'un sponsoring indirect et
 * pour « Répartir par nature » sur le poste créé avec la demande : deux écritures de la même chose
 * finiraient par ne pas relier, nommer ou positionner les postes pareil (§118.5).
 *
 * `premierId` : le poste d'ORIGINE quand on répartit un poste existant — il devient la première
 * ligne et garde son identifiant, donc ses pièces, ses demandes au secrétariat et son historique.
 * Sinon la première ligne naît ici. Dans les deux cas, `repartitionId` est l'identifiant de la
 * première ligne : c'est la clé que l'écran regroupe.
 *
 * LA PREMIÈRE LIGNE REPART EN BROUILLON. Ce qui avait été accordé, imputé, refusé ou renvoyé en
 * révision l'avait été au « sponsoring indirect » d'un seul tenant : rien de cela ne vaut pour
 * l'imprimerie seule, et laisser « Refusé » sur elle dirait que la Direction a refusé une
 * imprimerie dont elle n'a jamais entendu parler. La décision passée reste lisible dans
 * l'historique des décisions du poste (`AdProItemDecision`), qu'on ne touche pas.
 *
 * Pourquoi ce module et non une aide locale du fichier d'actions : la dérivation des contrats ne
 * suit une aide LOCALE que lorsqu'elle reçoit le formulaire (`actions/contrat.ts`,
 * `deleguesDuCorps`) ; celle-ci ne le reçoit pas, et « Répartir par nature » sortait `ecrit: true`
 * avec `modelesEcrits: []` — une écriture sans table. Un délégué IMPORTÉ est lu, lui
 * (`faitsEcritureImportes`), et l'action déclare enfin `adProItem` (§118.116, §118.137).
 */
export async function ecrireRepartition(tx: Prisma.TransactionClient, a: {
  /** La colonne qui rattache le poste à sa demande — `{ sponsoringId: "…" }`. */
  rattachement: Record<string, string>;
  lignes: readonly PosteReparti[];
  premierId: string | null;
  userId: string;
  base: { label: string; notes: string | null; budgetKind: AdProItemBudgetKind; addedAfterDecision: boolean };
}): Promise<string[]> {
  const last = await tx.adProItem.findFirst({ where: a.rattachement, orderBy: { position: "desc" }, select: { position: true } });
  let position = last?.position ?? 0;
  const champs = (l: PosteReparti) => ({ kind: l.kind, label: l.label, amountEstimated: l.montant, supplier: l.payeA });
  const ids: string[] = [];
  const [tete, ...suite] = a.lignes;
  if (!tete) return ids;
  if (a.premierId) {
    await tx.adProItem.update({
      where: { id: a.premierId },
      data: {
        ...champs(tete), amountGranted: null, budgetCategoryId: null, repartitionId: a.premierId,
        status: "DRAFT", submittedAt: null, decidedAt: null, decidedById: null, decisionNote: null,
        updatedById: a.userId,
      },
    });
    ids.push(a.premierId);
  } else {
    const cree = await tx.adProItem.create({
      data: {
        ...a.rattachement, ...champs(tete), notes: a.base.notes, budgetKind: a.base.budgetKind,
        addedAfterDecision: a.base.addedAfterDecision, position: ++position, createdById: a.userId, updatedById: a.userId,
      },
      select: { id: true },
    });
    await tx.adProItem.update({ where: { id: cree.id }, data: { repartitionId: cree.id } });
    ids.push(cree.id);
  }
  const repartitionId = ids[0]!;
  for (const l of suite) {
    const cree = await tx.adProItem.create({
      data: {
        ...a.rattachement, ...champs(l), notes: `Réparti depuis « ${a.base.label} ».`, budgetKind: a.base.budgetKind,
        addedAfterDecision: a.base.addedAfterDecision, repartitionId, position: ++position,
        createdById: a.userId, updatedById: a.userId,
      },
      select: { id: true },
    });
    ids.push(cree.id);
  }
  return ids;
}
