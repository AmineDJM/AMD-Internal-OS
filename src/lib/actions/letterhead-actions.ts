"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { releaseBlob } from "@/lib/drive-storage";
import { peutGererDirectionArtistique } from "@/lib/direction-artistique/droits";
import { deposerPapier, papierDansPerimetre, MODULE_AUDIT } from "@/lib/direction-artistique/serveur";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * LES PAPIERS EN-TÊTE — la papeterie de la société, tenue par l'assistante de direction.
 *
 * On téléverse un VRAI document Office déjà mis en page. Créer « avec en-tête » en recopiera
 * les octets : le résultat s'ouvre exactement comme le modèle, sans conversion. C'est la seule
 * façon de garantir des marges, un pied de page et un logo identiques — injecter une image dans
 * un document vierge produit des décalages qu'on ne découvre qu'à l'impression, chez le
 * destinataire.
 */

// La papeterie vit désormais dans « Direction artistique » (Transverse) ; le Drive la propose
// toujours à la création d'un document.
const PATHS = ["/direction-artistique", "/drive"];
const revalider = () => { for (const p of PATHS) revalidatePath(p); };

/** Téléverse un papier en-tête. Le fichier doit correspondre au type annoncé. */
export async function uploadLetterhead(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await deposerPapier(user, {
    kind: fdStr(formData, "kind"), file: formData.get("file"),
    name: fdStr(formData, "name"), companyId: fdStr(formData, "companyId"),
  });
  if (!r.ok) return r;
  revalider();
  return { ok: true, id: r.id };
}

/** Renomme un papier en-tête, le rattache à une entité, ou le désactive. */
export async function updateLetterhead(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererDirectionArtistique(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "En-tête introuvable." };
  const existing = await prisma.officeLetterhead.findUnique({ where: { id }, select: { name: true, companyId: true } });
  // Hors périmètre = introuvable : on ne révèle pas la papeterie d'une entité qu'on ne voit pas.
  if (!existing || !(await papierDansPerimetre(user.id, existing.companyId))) return { ok: false, error: "En-tête introuvable." };

  const activeRaw = formData.get("isActive");
  const name = fdStr(formData, "name") || existing.name;
  const companyRaw = formData.get("companyId");
  // On ne rattache pas un modèle à une entité qu'on ne voit pas.
  if (companyRaw != null && String(companyRaw) && !(await papierDansPerimetre(user.id, String(companyRaw)))) {
    return { ok: false, error: "Cette entité n'est pas dans votre périmètre." };
  }

  await prisma.officeLetterhead.update({
    where: { id },
    data: {
      name,
      // `companyId` absent du formulaire = on n'y touche pas ; présent et vide = commun au groupe.
      ...(companyRaw != null ? { companyId: String(companyRaw) || null } : {}),
      ...(activeRaw != null ? { isActive: activeRaw === "on" || activeRaw === "true" || activeRaw === "1" } : {}),
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT,
    summary: `Papier en-tête modifié : ${existing.name}${name !== existing.name ? ` → ${name}` : ""}`,
  });
  revalider();
  return { ok: true };
}

/**
 * Supprime un papier en-tête et libère son binaire.
 *
 * Les DOCUMENTS déjà créés dessus ne bougent pas : ils portent leur propre copie des octets
 * depuis leur création. Supprimer le modèle ne réécrit donc jamais un courrier déjà parti.
 */
export async function deleteLetterhead(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererDirectionArtistique(user, "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "En-tête introuvable." };
  const existing = await prisma.officeLetterhead.findUnique({ where: { id }, select: { name: true, blobId: true, companyId: true } });
  if (!existing || !(await papierDansPerimetre(user.id, existing.companyId))) return { ok: false, error: "En-tête introuvable." };

  await prisma.officeLetterhead.delete({ where: { id } });
  await releaseBlob(existing.blobId).catch(() => undefined);
  await recordAudit({
    actorId: user.id, action: "DELETE", module: MODULE_AUDIT,
    summary: `Papier en-tête supprimé : ${existing.name}`,
  });
  revalider();
  return { ok: true };
}
