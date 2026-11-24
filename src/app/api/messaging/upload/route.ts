import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { validateDriveUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { canAccessConversation, signBlob } from "@/lib/messaging";
import { typeDeDepot } from "@/lib/drive/mime-nom";

export const dynamic = "force-dynamic";

/**
 * Upload d'une pièce jointe de messagerie. Stocke le contenu chiffré (FileBlob,
 * déduplication par SHA-256) et renvoie une signature HMAC liant le blob à notre
 * route — `sendMessage` n'accepte que des pièces jointes ainsi signées.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Mot de passe à changer." }, { status: 403 });
  if (!userCan(user, "MESSAGING", "UPLOAD")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });

  const conversationId = (form.get("conversationId") as string) || null;
  if (!conversationId || !(await canAccessConversation(user.id, conversationId))) {
    return NextResponse.json({ error: "Conversation non autorisée." }, { status: 403 });
  }

  // MÊME RÈGLE QUE LE DRIVE : on refuse les EXÉCUTABLES, et rien d'autre. La liste blanche
  // étroite d'origine (pdf, docx, xlsx, png, zip…) rejetait une vidéo de congrès, un export
  // .msg de boîte mail, un .odt, un .7z — des pièces parfaitement ordinaires que les gens
  // envoyaient alors par WhatsApp, hors de l'outil. La limite de TAILLE, elle, reste celle des
  // pièces jointes (plus basse que le Drive) : une conversation n'est pas un espace de stockage.
  const err = validateDriveUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const { blobId, size } = await putBlob(buf);
  const mime = typeDeDepot(file.name, file.type);

  return NextResponse.json({
    blobId,
    sig: signBlob(blobId),
    name: file.name,
    mime,
    size,
  });
}
