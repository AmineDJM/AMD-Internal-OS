import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { copierAuCoffre, type ResultatCopie } from "./copies";
import type { ModeleSensible } from "./champs";
import type { RefTitulaire } from "./depot";

/**
 * LA DOUBLE ÉCRITURE DU COFFRE (refonte V2-E) — ce qu'un écrivain appelle APRÈS avoir écrit une colonne
 * sensible, avec les valeurs qu'il vient d'écrire.
 *
 * Derrière l'interrupteur `AppSetting.coffreEcriture` (fermé par défaut) : fermé, rien ne se passe.
 *
 * Dans la transaction de l'écrivain quand il en a une (`tx`) : la copie et l'écriture vivent ou meurent
 * ensemble. Sans transaction (`prisma`), la copie a la sienne, et un échec est JOURNALISÉ sans bloquer
 * l'écriture métier — la colonne reste la vérité jusqu'au palier P5, et la reprise rejouée rattrape
 * l'écart (`refonte-p3-inventaire.md` §5.1 : « erreur non bloquante pendant P3 »).
 *
 * Le titulaire est lu sur l'origine : la `Personne` du salarié, l'`Organisation` du partenaire ou de la
 * société — quand les reprises V2-B / V2-C les ont posées ; sinon la copie est tenue par son origine.
 */

type ClientEcriture = Prisma.TransactionClient;

export async function titulaireDeLOrigine(client: ClientEcriture, modele: ModeleSensible, id: string): Promise<RefTitulaire | null> {
  if (modele === "Employee") {
    const e = await client.employee.findUnique({ where: { id }, select: { personneId: true } });
    return e?.personneId ? { genre: "PERSONNE", personneId: e.personneId } : null;
  }
  if (modele === "CompanyContact") {
    const c = await client.companyContact.findUnique({ where: { id }, select: { organisationId: true } });
    return c?.organisationId ? { genre: "ORGANISATION", organisationId: c.organisationId } : null;
  }
  const l = await client.companyLegalIdentity.findUnique({ where: { id }, select: { company: { select: { organisationId: true } } } });
  return l?.company.organisationId ? { genre: "ORGANISATION", organisationId: l.company.organisationId } : null;
}

async function copier(client: ClientEcriture, modele: ModeleSensible, origineId: string, valeurs: Record<string, unknown>, parId: string | null) {
  const titulaire = await titulaireDeLOrigine(client, modele, origineId);
  return copierAuCoffre(client, { modele, origineId, valeurs, titulaire, parId });
}

/**
 * Copie au coffre les colonnes sensibles de `valeurs` (les autres clés sont ignorées). Rend `null`
 * quand l'interrupteur est fermé, les issues sinon. Avec `tx`, une erreur remonte (même transaction) ;
 * sans, elle est journalisée et `null` est rendu.
 */
export async function doubleEcrireCoffre(
  modele: ModeleSensible,
  origineId: string,
  valeurs: Record<string, unknown>,
  parId: string | null,
  tx?: ClientEcriture,
): Promise<ResultatCopie[] | null> {
  if (!(await getAppSettings()).coffreEcriture) return null;
  if (tx) return copier(tx, modele, origineId, valeurs, parId);
  try {
    return await prisma.$transaction((t) => copier(t, modele, origineId, valeurs, parId));
  } catch (err) {
    // Jamais la valeur : le modèle, l'identifiant et la nature de l'erreur suffisent à rejouer.
    console.error(`[coffre] double écriture ${modele}/${origineId} en échec — la reprise la rattrapera :`, err instanceof Error ? err.name : "erreur");
    return null;
  }
}
