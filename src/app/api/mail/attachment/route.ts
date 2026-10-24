import { NextRequest, NextResponse } from "next/server";
import { entetesAntiExecution } from "@/lib/http/types-actifs";
import { getCurrentUser } from "@/lib/session";
import { getMailAccount, getAttachment } from "@/lib/mail";
import { contentDisposition } from "@/lib/http/content-disposition";

export const dynamic = "force-dynamic";

/** Télécharge une pièce jointe d'un e-mail. Serveur uniquement (IMAP). */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const account = await getMailAccount(user.id);
  if (!account) return NextResponse.json({ error: "Aucune boîte connectée" }, { status: 404 });

  const mailbox = req.nextUrl.searchParams.get("mailbox") || "INBOX";
  const uid = Number(req.nextUrl.searchParams.get("uid"));
  const index = Number(req.nextUrl.searchParams.get("index") || 0);
  if (!uid) return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
  try {
    const att = await getAttachment(account, mailbox, uid, index);
    if (!att) return NextResponse.json({ error: "Pièce jointe introuvable" }, { status: 404 });
    // Aperçu in-app (inline) ou téléchargement selon le paramètre.
    const inline = req.nextUrl.searchParams.get("inline") === "1";
    return new NextResponse(att.content as unknown as BodyInit, {
      headers: {
        "Content-Type": att.contentType,
        // Un type actif (HTML, SVG, XML) s'affiche sans jamais s'exécuter dans l'ERP (`lib/http/types-actifs.ts`).
        ...entetesAntiExecution(att.contentType),
        "Content-Disposition": contentDisposition(att.filename, inline ? "inline" : "attachment"),
        // Empêche l'exécution de contenu actif dans l'aperçu.
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self';",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    console.error("[mail] attachment failed", e);
    return NextResponse.json({ error: "Téléchargement impossible." }, { status: 502 });
  }
}
