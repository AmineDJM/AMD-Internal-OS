"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMyCompanies } from "@/lib/company";
import { identityFieldKeys } from "@/lib/legal/identity";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { doubleEcrireCoffre } from "@/lib/coffre/ecriture";
import { champsNonSaisis } from "@/lib/coffre/champs";

/**
 * LA CARTE D'IDENTITÉ LÉGALE ET FISCALE D'UNE ENTITÉ — écriture.
 *
 * Qui peut : qui peut ÉCRIRE dans Legal, et seulement pour une entité de son périmètre. Ces
 * numéros engagent la société sur des appels d'offres et des dossiers bancaires ; les laisser
 * modifier par tout porteur du module reviendrait à confier son RIB à qui passe.
 *
 * Enregistrement en UPSERT : la carte d'une entité est unique, et « créer » ou « corriger » est
 * le même geste pour celui qui la remplit. Rien n'est deviné — un champ laissé vide reste vide,
 * on n'invente pas un numéro fiscal.
 */

const PATH = "/legal/identites";

export async function saveCompanyIdentity(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LEGAL", "UPDATE")) return { ok: false, error: "Non autorisé." };

  const companyId = fdStr(formData, "companyId");
  if (!companyId) return { ok: false, error: "Entité manquante." };

  // Le périmètre s'applique ICI aussi : on ne renseigne pas — ni ne lit — la carte fiscale
  // d'une société du groupe qu'on n'a pas le droit de voir.
  const mine = await getMyCompanies(user.id);
  const company = mine.find((c) => c.id === companyId);
  if (!company) return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };

  // Les champs viennent de la carte elle-même : ajouter une ligne au document suffit, sans
  // toucher à cette action — et rien d'autre que la carte ne peut se glisser dans l'écriture.
  const data: Record<string, string | null> = {};
  for (const key of identityFieldKeys()) data[key] = fdStr(formData, key) || null;
  // ÉCRIRE SANS LIRE (refonte V2-E) : un RIB / IBAN que l'écran ne montrait que masqué revient masqué — il reste en place.
  for (const champ of champsNonSaisis("CompanyLegalIdentity", formData)) delete data[champ];

  const identite = await prisma.companyLegalIdentity.upsert({
    where: { companyId },
    create: { companyId, ...data, updatedById: user.id },
    update: { ...data, updatedById: user.id },
    select: { id: true },
  });
  // LE COFFRE (refonte V2-E) : RIB et IBAN de la société copiés chiffrés — derrière l'interrupteur, jamais bloquant.
  await doubleEcrireCoffre("CompanyLegalIdentity", identite.id, data, user.id);

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    summary: `Coordonnées légales & fiscales mises à jour — ${company.shortName || company.name}`,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Coordonnées enregistrées." };
}
