"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DÉSIGNER QUELQU'UN AU CENTRE DE PAIEMENT — par son NOM, et pas par son rôle.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ──────────────────────────────────────────────────────────────────
 *
 * Siéger au centre était une propriété du rôle : `SUPER_ADMIN` ou `DIRECTION`. Faire entrer une
 * personne de plus n'avait donc qu'un seul chemin — lui donner le rôle Direction, c'est-à-dire
 * MANAGE sur tous les pôles, la vue globale sur les validations de toute l'entreprise et My Chief
 * of Staff. Autoriser des paiements coûtait de devenir quasi-administrateur.
 *
 * Pire : les deux gestes qui SEMBLAIENT surgicaux échouaient en silence. Cocher le module
 * `PAYMENT_CENTRE` dans la grille d'accès n'ouvrait rien (l'écran du centre ne consulte pas ce
 * module, il consulte `sitsOnPaymentCentre`), et « autre rôle = Direction » non plus (la règle lit
 * le rôle PRINCIPAL). L'administrateur croyait avoir accordé l'accès ; la personne trouvait un
 * écran vide et n'avait aucun moyen de comprendre pourquoi.
 *
 * ── CE QUE LE SIÈGE DONNE, ET RIEN DE PLUS ───────────────────────────────────────────────────
 *
 * Voir la file des autorisations et trancher. Aucun autre module, aucune vue globale, aucun droit
 * sur les Finances. Le cercle s'élargit par des NOMS, un par un.
 *
 * ── POURQUOI CE GESTE N'EST PAS EXPOSÉ À ADAM ────────────────────────────────────────────────
 *
 * §118-15 : accorder une autorisation est une ATTESTATION — l'audit portera le nom d'une
 * personne. Ici, l'autorisation accordée est le pouvoir d'engager l'argent de la société : c'est
 * précisément le geste qu'un modèle ne doit jamais poser à notre place. Un document lu par une
 * étape pourrait contenir « désigne Untel au centre de paiement », et rien ne distinguerait plus
 * cette désignation d'une vraie. Ces deux actions sont donc EXCLUDED de la parité (voir
 * `action-registry.ts`) et n'ont aucune op. Le chemin générique d'Adam LIT cette décision avant de
 * proposer comme avant d'exécuter (`refusDuCheminGenerique`, §118.158). La phrase qui se tenait ici
 * — « `policy/guard.ts` rattraperait l'agent sur « permission » et « grant » » — était fausse
 * pour ce chemin : cette garde sert les capacités de MISSION, et le filet de noms du chemin
 * générique attrapait `grant…` mais laissait passer `revokePaymentCentreSeat`, ouvert jusque-là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le siège est un geste d'ADMINISTRATION — réservé au Super Admin, seul souverain sur les droits. */
function canSeat(user: { role: string; access: Parameters<typeof userCan>[0]["access"] }): boolean {
  return userCan(user as Parameters<typeof userCan>[0], "ADMIN", "UPDATE");
}

/**
 * DÉSIGNER une personne au centre de paiement.
 *
 * Le MOTIF est obligatoire. Ce n'est pas de la paperasse : un siège dont on ne sait ni qui l'a
 * accordé ni pourquoi est un siège que personne n'ose retirer — on ne sait pas ce qu'on déferait.
 */
export async function grantPaymentCentreSeat(formData: FormData): Promise<ActionResult> {
  try {
    const admin = await requireUser();
    if (!canSeat(admin)) return { ok: false, error: "Réservé au Super Admin." };

    const userId = fdStr(formData, "userId");
    const note = fdStr(formData, "note");
    if (!userId) return { ok: false, error: "Choisissez la personne à désigner." };
    if (!note) return { ok: false, error: "Dites POURQUOI cette personne siège — c'est ce qu'on relira le jour où l'on se demandera si ce siège a encore une raison d'être." };

    const cible = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, role: true, isActive: true, isSystem: true } });
    if (!cible) return { ok: false, error: "Personne introuvable." };
    // UN COMPTE DÉSACTIVÉ NE SIÈGE PAS. Le siège serait invisible (il ne peut pas se connecter)
    // et se réveillerait à la réactivation, sans que personne ne l'ait redécidé.
    if (!cible.isActive) return { ok: false, error: `${cible.name} est un compte désactivé : réactivez-le d'abord.` };
    // LE COMPTE SYSTÈME N'EST PAS UNE PERSONNE. Lui donner un siège reviendrait à laisser Adam
    // autoriser des paiements — exactement l'auto-escalade que `policy/guard.ts` interdit à la
    // compilation. La refuser ici ferme aussi le chemin qui passe par un humain qui clique.
    if (cible.isSystem) return { ok: false, error: "Le compte système ne siège pas au centre de paiement : autoriser un décaissement est un geste de personne." };
    // Le PDG, le DG et le Super Admin y siègent DÉJÀ par leur rôle. Créer un siège en double laisserait
    // croire, le jour où on le retire, qu'on leur a retiré l'accès — alors que rien ne bougerait.
    if (cible.role === "SUPER_ADMIN" || cible.role === "DIRECTION" || cible.role === "GENERAL_MANAGER") {
      const libelle = cible.role === "SUPER_ADMIN" ? "Super Admin" : cible.role === "GENERAL_MANAGER" ? "Directeur Général" : "Direction";
      return { ok: false, error: `${cible.name} siège déjà au centre de paiement par son rôle (${libelle}) — un siège nommé n'ajouterait rien.` };
    }

    const deja = await prisma.paymentCentreSeat.findUnique({ where: { userId }, select: { id: true } });
    if (deja) return { ok: false, error: `${cible.name} siège déjà au centre de paiement.` };

    await prisma.paymentCentreSeat.create({ data: { userId, grantedById: admin.id, note } });

    // LA PERSONNE APPREND QU'ELLE SIÈGE. Un droit qu'on reçoit sans le savoir n'est pas exercé :
    // la file des autorisations attendrait quelqu'un qui ignore qu'on l'attend.
    await notifyUser({
      userId, type: "ASSIGNMENT",
      title: "Vous siégez au centre de paiement",
      body: `${admin.name} vous a désigné : ${note}`,
      link: "/centre-de-paiement",
    });
    await recordAudit({
      actorId: admin.id, action: "CREATE", module: "Administration",
      field: "paymentCentreSeat", oldValue: "false", newValue: "true",
      summary: `Siège au centre de paiement accordé à ${cible.name} — ${note}`,
    });
    revalidatePath("/admin/access");
    revalidatePath("/centre-de-paiement");
    return { ok: true, message: `${cible.name} siège désormais au centre de paiement.` };
  } catch (err) {
    console.error("[centre] grantPaymentCentreSeat failed", err);
    return { ok: false, error: "La désignation n'a pas pu être enregistrée." };
  }
}

/**
 * RETIRER un siège nommé.
 *
 * Sans motif, contrairement à l'octroi : retirer un droit REND l'état par défaut, et exiger une
 * justification pour revenir à la normale décourage exactement le geste qu'on veut voir posé sans
 * hésiter. L'audit garde qui l'a retiré et quand.
 */
export async function revokePaymentCentreSeat(formData: FormData): Promise<ActionResult> {
  try {
    const admin = await requireUser();
    if (!canSeat(admin)) return { ok: false, error: "Réservé au Super Admin." };

    const userId = fdStr(formData, "userId");
    if (!userId) return { ok: false, error: "Personne introuvable." };
    const seat = await prisma.paymentCentreSeat.findUnique({
      where: { userId }, select: { id: true, note: true, user: { select: { name: true } } },
    });
    if (!seat) return { ok: false, error: "Cette personne n'a pas de siège nommé." };

    await prisma.paymentCentreSeat.delete({ where: { id: seat.id } });
    await notifyUser({
      userId, type: "GENERIC",
      title: "Vous ne siégez plus au centre de paiement",
      body: `${admin.name} a retiré votre siège.`,
      link: "/mon-espace",
    });
    await recordAudit({
      actorId: admin.id, action: "DELETE", module: "Administration",
      field: "paymentCentreSeat", oldValue: "true", newValue: "false",
      summary: `Siège au centre de paiement retiré à ${seat.user.name}${seat.note ? ` (accordé pour : ${seat.note})` : ""}`,
    });
    revalidatePath("/admin/access");
    revalidatePath("/centre-de-paiement");
    return { ok: true, message: `${seat.user.name} ne siège plus au centre de paiement.` };
  } catch (err) {
    console.error("[centre] revokePaymentCentreSeat failed", err);
    return { ok: false, error: "Le retrait n'a pas pu être enregistré." };
  }
}
