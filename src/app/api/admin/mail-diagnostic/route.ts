import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { mailDiagnostic } from "@/lib/mail";
import { recordAudit } from "@/lib/audit";
import { attendu } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * Diagnostic e-mail (admin) : tente une connexion IMAP réelle pour la boîte d'un compte
 * et renvoie l'erreur **brute** d'Infomaniak + sa cause probable (limite de connexions /
 * IP bloquée / identifiants / timeout). Aucune action sur la boîte.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user || !userCan(user, "ADMIN", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const body = (await req.json().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", {}))) as { userId?: string };
  const userId = body?.userId ? String(body.userId) : user.id;

  const account = await prisma.mailAccount.findUnique({ where: { userId } });
  if (!account) return NextResponse.json({ error: "Aucune boîte mail connectée pour ce compte." }, { status: 404 });

  const result = await mailDiagnostic(account);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Administration", summary: `Diagnostic e-mail (${account.email}) → ${result.category}` });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
