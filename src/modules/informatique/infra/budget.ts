import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { trouverOuCreerEnveloppe } from "@/lib/budget/enveloppe-unique";
import { CODE_ENVELOPPE_INFORMATIQUE, CLE_LIGNE_IA, LIGNES_INFORMATIQUE, lignesManquantes, nomEnveloppeInformatique } from "../domaine/budget";
import { responsablesInformatique } from "./departement";
import { sousVerrou } from "./verrou";

/**
 * L'ENVELOPPE INFORMATIQUE D'UNE SOCIÉTÉ — trouvée, sinon ouverte d'office : au modèle de l'enveloppe de l'année des pôles
 * (`budget/enveloppes-pole.ts`, « l'enveloppe de l'année existe d'emblée »). Une `BudgetEnvelope` ordinaire (domaine
 * GÉNÉRAL : Budgets la lit, l'additionne et la règle comme les budgets de direction RH ou Administration), du 1er janvier au
 * 31 décembre, ses trois lignes de départ à ZÉRO, ouverte en lecture au responsable du département. Le montant est une
 * décision : il se fixe dans Budgets ou par la campagne budgétaire.
 */

export interface EnveloppeInformatique {
  envelopeId: string;
  nom: string;
  /** L'id de chaque ligne de départ, par sa clé. */
  lignes: Record<string, string>;
  creee: boolean;
}

export async function enveloppeInformatique(companyId: string, date: Date, actorId: string | null): Promise<EnveloppeInformatique> {
  const responsable = (await responsablesInformatique([companyId])).get(companyId) ?? null;
  const r = await sousVerrou(`budget-informatique:${companyId}`, async (tx) => {
    // La clé (société, INFORMATIQUE, année) par la fonction unique (`lib/budget/enveloppe-unique.ts`) ; une enveloppe
    // d'avant le code, reconnue à sa ligne IA, est adoptée (elle reçoit le code) plutôt que doublée.
    const annee = date.getUTCFullYear();
    const trouvee = await trouverOuCreerEnveloppe(
      { companyId, annee, direction: CODE_ENVELOPPE_INFORMATIQUE },
      {
        name: nomEnveloppeInformatique(annee), domaine: "GENERAL", module: CODE_ENVELOPPE_INFORMATIQUE, modules: [],
        totalAmount: 0, isActive: true, accessUserIds: responsable ? [responsable] : [], createdById: actorId,
        notes: "Budget du département Informatique — l'IA (consommation imputée chaque mois), les abonnements, le matériel. Montants à fixer.",
      },
      { tx, reconnaitre: { companyId, categories: { some: { cle: CLE_LIGNE_IA } } } },
    );
    const env = await tx.budgetEnvelope.findUniqueOrThrow({ where: { id: trouvee.id }, select: { id: true, name: true, accessUserIds: true } });
    const creee = trouvee.creee;
    if (!creee && responsable && !env.accessUserIds.includes(responsable)) {
      // Le responsable désigné depuis lit SON budget, comme le responsable d'un pôle lit l'enveloppe de sa campagne.
      await tx.budgetEnvelope.update({ where: { id: env.id }, data: { accessUserIds: { push: responsable } } });
    }
    const existantes = await tx.budgetCategoryLine.findMany({ where: { envelopeId: env.id }, select: { id: true, name: true, cle: true, parentId: true } });
    for (const l of lignesManquantes(existantes)) {
      const adoptee = l.adopter ? existantes.find((c) => c.parentId === null && !c.cle && c.name === l.adopter) : undefined;
      if (adoptee) {
        await tx.budgetCategoryLine.update({ where: { id: adoptee.id }, data: { cle: l.cle } });
        adoptee.cle = l.cle;
      } else {
        existantes.push({ ...(await tx.budgetCategoryLine.create({ data: { envelopeId: env.id, name: l.nom, cle: l.cle, allocated: 0 }, select: { id: true, name: true, cle: true, parentId: true } })) });
      }
    }
    const lignes: Record<string, string> = {};
    for (const l of LIGNES_INFORMATIQUE) {
      const c = existantes.find((e) => e.parentId === null && e.cle === l.cle);
      if (c) lignes[l.cle] = c.id;
    }
    return { envelopeId: env.id, nom: env.name, lignes, creee };
  });
  if (r.creee) {
    await recordAudit({
      actorId, action: "CREATE", module: "Budgets", entityId: r.envelopeId,
      summary: `Enveloppe « ${r.nom} » du département Informatique ouverte d'office (IA, abonnements & licences, matériel) — montants à fixer`,
    }).catch(sansBloquer("informatique.enveloppe.recordAudit"));
  }
  return r;
}
