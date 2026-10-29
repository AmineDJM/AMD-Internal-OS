/**
 * INFORMATION MÉDICALE — une écriture interne partagée par deux actions : clore la demande « à revoir » qu'une
 * resoumission remplace.
 *
 * Sorti de `actions/medical-info-actions.ts` (lot V4). Ce module n'est PAS `"use server"` : elle reçoit un
 * acteur en argument et ne doit pas devenir un point d'entrée (§118.153).
 */
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";

/**
 * CLORE LA DEMANDE « À REVOIR » QU'UNE RESOUMISSION REMPLACE (audit 360°, I9).
 *
 * L'écriture est CONDITIONNELLE : seule une demande encore à revoir se clôt. Deux resoumissions
 * simultanées lisent toutes deux « à revoir » ; la première clôt et poursuit, la seconde trouve la
 * demande déjà close et s'arrête — sans quoi deux demandes vivraient pour une seule question, ce
 * que la règle d'avant existait pour empêcher. Non exportée : une fonction qui reçoit un acteur
 * en argument n'a pas sa place parmi les points d'entrée d'un fichier « use server » (§118.153).
 */
export async function clorePrecedente(validationId: string | null, acteurId: string, reference: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!validationId) return { ok: true };
  const r = await prisma.validationRequest.updateMany({
    where: { id: validationId, status: "CHANGES_REQUESTED" },
    data: { status: "CANCELLED" },
  });
  if (r.count !== 1) {
    return { ok: false, error: "Une nouvelle demande vient déjà d'être soumise pour ce dossier — rechargez la page." };
  }
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Validations",
    entityType: "VALIDATION_REQUEST", entityId: validationId,
    field: "status", newValue: "CANCELLED",
    summary: `Demande à revoir close par sa resoumission (${reference})`,
  });
  return { ok: true };
}
