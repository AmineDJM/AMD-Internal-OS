"use server";

import { AuthError } from "next-auth";
import bcrypt from "bcryptjs";
import { auth, signIn, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { effacerVueExacte } from "@/lib/vue-exacte";

/** Server action used by the login form. Returns an error string on failure. */
export async function authenticate(
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  // UNE CONNEXION NEUVE NE REPREND JAMAIS LA « VUE EXACTE » D'UNE AUTRE SESSION (Direction, 06/10 : « c'est
  // seulement quand je quitte cette vue que je reviens à mon profil ») : un autre Super Admin qui se connecte
  // sur ce navigateur ne doit pas tomber dans l'écran que le précédent visualisait.
  try { await effacerVueExacte(); } catch { /* hors requête : rien à effacer */ }
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/mon-espace",
    });
  } catch (error) {
    // signIn throws a NEXT_REDIRECT on success — let it propagate.
    if (error instanceof AuthError) {
      return "Identifiants invalides. Vérifiez votre email et votre mot de passe.";
    }
    throw error;
  }
  return undefined;
}

export async function doSignOut() {
  // Revoke the current session so its token can't be reused.
  const session = await auth();
  const sid = session?.user?.sid;
  if (sid) {
    await prisma.userSession
      .update({ where: { id: sid }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }
  // Se déconnecter termine aussi la vue : elle ne ressurgit pas à la connexion suivante.
  try { await effacerVueExacte(); } catch { /* hors requête */ }
  await signOut({ redirectTo: "/login" });
}

/** Self-service password change. Clears mustChangePassword and revokes all
 * sessions (forces a fresh login with the new password). */
export async function changePassword(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const session = await auth();
  if (!session?.user) return "Session expirée.";

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (next.length < 8) return "Le nouveau mot de passe doit faire au moins 8 caractères.";
  if (next !== confirm) return "La confirmation ne correspond pas.";

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) return "Utilisateur introuvable.";
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    return "Mot de passe actuel incorrect.";
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(next, 10), mustChangePassword: false },
  });
  // Invalidate every existing session for this user.
  await prisma.userSession.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await recordAudit({
    actorId: user.id,
    action: "UPDATE",
    module: "Authentification",
    summary: "Changement de mot de passe",
  });

  await signOut({ redirectTo: "/login?changed=1" });
  return undefined;
}
