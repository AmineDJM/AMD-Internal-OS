import { requireUser, type CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";

/**
 * LA PORTE DES ACTIONS DE L'ASSISTANT IA — l'identité vient TOUJOURS de la session (`requireUser`), jamais d'un
 * paramètre (§118.153) ; le module `ASSISTANT_IA` est exigé ; une écriture est refusée en « Vue exacte » (on ne
 * modifie pas la mémoire, les routines ni les documents de quelqu'un en se mettant à sa place).
 */
export type Porte = { ok: true; user: CurrentUser } | { ok: false; erreur: string };

export async function porte(ecriture: boolean): Promise<Porte> {
  const user = await requireUser();
  if (!peutUtiliserAssistantIA(user)) return { ok: false, erreur: REFUS_ASSISTANT_IA };
  if (ecriture && (user.impersonatedBy || user.visualise)) return { ok: false, erreur: "Indisponible en « Vue exacte »." };
  return { ok: true, user };
}
