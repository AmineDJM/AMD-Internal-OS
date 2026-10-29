import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";

/**
 * RECONSTRUIT L'UTILISATEUR à partir de son compte — sans session, puisqu'il n'y en a pas.
 *
 * Les DROITS sont relus en base (`getAccess`), jamais supposés : une mission lancée le lundi par
 * quelqu'un dont on a fermé un module le mardi ne doit pas continuer à s'en servir le mercredi.
 * C'est la propriété qui rend un balayage sans session acceptable — et c'est la même personne,
 * avec les mêmes droits, que la porte d'attention emploie pour lui parler par un connecteur.
 */
export async function proprietaire(userId: string): Promise<CurrentUser | null> {
  const u = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!u) return null;
  const access = await getAccess(u.id, u.role);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: access.role ?? u.role,
    secondaryRole: access.secondaryRole,
    access,
    mustChangePassword: false,
  };
}
