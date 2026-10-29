import { prisma } from "@/lib/prisma";
import { EDITABLE_FIELDS, type NatureEditable } from "../../domaine/edition";

/**
 * Valeurs actuelles d'une demande Ad & Pro, prêtes pour le formulaire de correction.
 *
 * Le `select` est **dérivé de la liste blanche** : le formulaire ne peut donc pas afficher un
 * champ que le serveur refuserait d'écrire, et ajouter un champ modifiable ne demande de
 * toucher qu'un seul endroit (`EDITABLE_FIELDS`).
 *
 * La sérialisation est faite ici — un `Decimal` de Prisma et un `Date` ne traversent pas la
 * frontière serveur → client tels quels.
 */
export async function adProEditValues(
  kind: NatureEditable,
  id: string,
): Promise<Record<string, string | number | null>> {
  const select = Object.fromEntries(EDITABLE_FIELDS[kind].map((f) => [f.key, true]));
  const row =
    kind === "SPONSORING"
      ? await prisma.sponsoringRequest.findUnique({ where: { id }, select })
      : kind === "CONGRESS_NATIONAL"
        ? await prisma.congressNational.findUnique({ where: { id }, select })
        : kind === "PROMO_MATERIAL"
          ? await prisma.promoMaterial.findUnique({ where: { id }, select })
          : kind === "EVENT"
            ? await prisma.event.findUnique({ where: { id }, select })
            : kind === "CONSULTING_CONTRACT"
              ? await prisma.consultingContract.findUnique({ where: { id }, select })
              : kind === "AD_PRO_OTHER"
                ? await prisma.adProOtherRequest.findUnique({ where: { id }, select })
                : await prisma.congressInternational.findUnique({ where: { id }, select });
  if (!row) return {};

  const out: Record<string, string | number | null> = {};
  for (const f of EDITABLE_FIELDS[kind]) {
    const v = (row as Record<string, unknown>)[f.key];
    if (v === null || v === undefined) { out[f.key] = null; continue; }
    // Une date se présente en AAAA-MM-JJ (ce qu'attend `<input type="date">`), un montant en
    // nombre : `Decimal.toString()` donnerait « 1200.00 », que le champ numérique afficherait tel quel.
    if (f.type === "date") out[f.key] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    else if (f.type === "number") out[f.key] = Number(String(v));
    else out[f.key] = String(v);
  }
  return out;
}
