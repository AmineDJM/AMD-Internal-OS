import { actsForUser } from "@/lib/hr/stand-in-resolve";
import { ouverteALInterim } from "@/lib/doc-request";

/**
 * L'INTÉRIMAIRE DE LA PERSONNE SOLLICITÉE (audit Assistante de direction, 10/2026) — les faits que la règle pure
 * (`doc-request.ts` : `canSubmit`, `ouverteALInterim`) ne lit pas : remplace-t-on AUJOURD'HUI celle à qui la
 * pièce est demandée ? Une seule lecture pour l'action, la porte des pièces (`entity-access`) et l'écran `/pieces` :
 * trois écritures de « qui dépose à sa place » finiraient par ne plus dire la même chose (§118.5).
 */
export async function tientPourLaSollicitee(
  userId: string,
  req: { askedToId: string; entityType: string; kind: string | null },
): Promise<boolean> {
  if (req.askedToId === userId || !ouverteALInterim(req)) return false;
  return actsForUser(userId, req.askedToId);
}

