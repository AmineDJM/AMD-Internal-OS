import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { persistUploadedDocument } from "@/lib/documents";
import { readFileByKey } from "@/lib/storage";
import { fichiersEmis } from "@/lib/lecteurs/fichiers-emis";
import { ETAPE_COPIE_SIGNEE } from "@/lib/bons-de-commande/copie-signee";
import { incruster } from "./incruster";
import { lireVisuel } from "./visuels";
import type { Qualite } from "./placement";
import { LIBELLE_QUALITE_SIGNATURE, titreSignataire } from "./partage";
import { enSuppleance } from "./suppleance";

// Les actions qui signent nomment qui a signé (la place, ou le Super Admin en suppléance) — par la porte qu'elles importent déjà.
export { enSuppleance } from "./suppleance";
export { titreSignataire } from "./partage";

/**
 * SIGNER UN BC EN LIGNE (Direction, 15/11/2026) — serveur seulement. La Direction Marketing d'abord (son PDF signé est
 * déposé sous `BC_SIGNE_DM`), puis les Finances, SUR ce PDF (le sien devient la copie signée du BC, `BC_SIGNE` — celle
 * que tout l'aval lit déjà). Chaque signature porte un JETON qui ouvre `/verifier-bc/<jeton>` et l'EMPREINTE SHA-256 du
 * PDF produit : qui reçoit le fichier peut vérifier qu'il n'a pas été retouché depuis.
 *
 * Les gardes métier (droit, étape du BC, contrôle renforcé) sont dans les actions ; ici on n'appose que si la place est
 * libre (`@@unique([legalDocumentId, qualite])`), et une panne rend la place.
 */

export const LIBELLE_QUALITE: Record<Qualite, string> = LIBELLE_QUALITE_SIGNATURE;
export const ETAPE_SIGNE_DM = "BC_SIGNE_DM";

/** Le BC est celui d'un poste « par une agence » : la Direction Marketing le signe AVANT les Finances. */
export async function exigeSignatureMarketing(legalDocumentId: string): Promise<boolean> {
  const n = await prisma.adProItemPiece.count({ where: { legalDocumentId, nature: "BON_DE_COMMANDE", item: { voie: "AGENCE" } } });
  return n > 0;
}

export async function signaturesDuBC(legalDocumentId: string) {
  return prisma.signatureBC.findMany({ where: { legalDocumentId }, orderBy: { signedAt: "asc" } });
}

export const REFUS_SIGNATURE_MARKETING_ABSENTE = "Ce bon de commande attend d'abord la signature de la Direction Marketing : il se signe aux Finances juste après.";

/** Le PDF sur lequel signer : celui de la Direction Marketing pour les Finances quand il existe, sinon le PDF émis. */
async function pdfDeBase(legalDocumentId: string, qualite: Qualite, lireBlob: LireBlob): Promise<Buffer | null> {
  if (qualite === "FINANCES") {
    const dm = await prisma.signatureBC.findUnique({ where: { legalDocumentId_qualite: { legalDocumentId, qualite: "DIRECTION_MARKETING" } }, select: { documentId: true } });
    if (dm?.documentId) {
      const doc = await prisma.document.findUnique({ where: { id: dm.documentId }, select: { fileKey: true } });
      if (doc?.fileKey) return readFileByKey(doc.fileKey).catch(() => null);
    }
  }
  const piece = await prisma.legalDocument.findUnique({ where: { id: legalDocumentId }, select: { custom: true } });
  const noeud = fichiersEmis(piece?.custom).pdf;
  if (!noeud) return null;
  const version = await prisma.fileVersion.findFirst({ where: { nodeId: noeud }, orderBy: { version: "desc" }, select: { blobId: true } });
  return version ? lireBlob(version.blobId) : null;
}

const baseUrl = () => (process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.AUTH_URL || "").replace(/\/+$/, "");
const dateFr = (d: Date) => d.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Le lecteur du stockage chiffré (`getBlob`), passé par l'appelant : la bureautique ne parle pas au fournisseur de stockage. */
export type LireBlob = (blobId: string) => Promise<Buffer | null>;

/** `suppleance` / `titre` : ce que le sceau a écrit sous le nom — les actions le reprennent au journal et dans leurs phrases. */
export type ResultatApposition = { ok: true; documentId: string; empreinte: string; jeton: string; suppleance: boolean; titre: string } | { ok: false; error: string };

export async function apposerSignatureEnLigne(i: {
  legalDocumentId: string; reference: string; qualite: Qualite; user: { id: string; name: string | null }; titre?: string | null; ip: string | null; agent: string | null;
  lireBlob: LireBlob;
}): Promise<ResultatApposition> {
  const [signature, cachet, porteur] = await Promise.all([
    lireVisuel(i.user.id, "SIGNATURE"), lireVisuel(i.user.id, "CACHET"),
    prisma.user.findUnique({ where: { id: i.user.id }, select: { role: true, secondaryRole: true } }),
  ]);
  if (!signature || !cachet) return { ok: false, error: "Déposez d'abord votre signature ET votre cachet (Mon espace › Ma signature)." };
  const base = await pdfDeBase(i.legalDocumentId, i.qualite, i.lireBlob);
  if (!base) return { ok: false, error: "Le PDF de ce bon de commande est introuvable : régénérez-le avant de le signer." };

  const jeton = randomBytes(18).toString("base64url");
  const nom = i.user.name?.trim() || "Signataire";
  // LE SUPER ADMIN EN SUPPLÉANCE (21/11/2026) : son nom, et ce qu'il est — jamais « Direction Marketing » sous son nom.
  const suppleance = enSuppleance(i.qualite, porteur);
  const titre = i.titre ?? titreSignataire(i.qualite, suppleance);
  const maintenant = new Date();
  // LA PLACE D'ABORD : une seule signature par qualité — deux clics n'en posent pas deux.
  let ligne: { id: string };
  try {
    ligne = await prisma.signatureBC.create({
      data: { legalDocumentId: i.legalDocumentId, qualite: i.qualite, userId: i.user.id, signataireNom: nom.slice(0, 120), signataireTitre: titre, methode: "EN_LIGNE", signedAt: maintenant, jeton, ip: i.ip, agent: i.agent?.slice(0, 250) ?? null },
      select: { id: true },
    });
  } catch {
    return { ok: false, error: `Ce bon de commande porte déjà la signature « ${LIBELLE_QUALITE[i.qualite]} ».` };
  }
  try {
    const pdf = await incruster(base, {
      qualite: i.qualite, signature, cachet,
      // Trois lignes : sur une seule, la fin (la qualité, la date) sortait du sceau — et avec elle « en suppléance ».
      mention: [`Signé électroniquement par ${nom}`, titre, `le ${dateFr(maintenant)}`].join("\n"),
      urlVerification: `${baseUrl()}/verifier-bc/${jeton}`,
    });
    const empreinte = createHash("sha256").update(pdf).digest("hex");
    const nomFichier = `BC-${i.reference.replace(/[^\w-]+/g, "-")}-signe-${i.qualite === "FINANCES" ? "finances" : "direction-marketing"}.pdf`;
    const depot = await persistUploadedDocument(i.user.id, {
      entityType: "LEGAL_DOCUMENT", entityId: i.legalDocumentId, category: "OTHER", confidentiality: "INTERNAL",
      stepKey: i.qualite === "FINANCES" ? ETAPE_COPIE_SIGNEE : ETAPE_SIGNE_DM,
      file: new File([new Uint8Array(pdf)], nomFichier, { type: "application/pdf" }), buffer: pdf,
    });
    if (!depot.ok || !depot.documentId) throw new Error(depot.error ?? "dépôt impossible");
    await prisma.signatureBC.update({ where: { id: ligne.id }, data: { empreinte, documentId: depot.documentId } });
    return { ok: true, documentId: depot.documentId, empreinte, jeton, suppleance, titre };
  } catch (e) {
    await prisma.signatureBC.delete({ where: { id: ligne.id } }).catch(() => undefined);
    return { ok: false, error: `La signature n'a pas pu être apposée (${e instanceof Error ? e.message : "erreur"}) : rien n'est signé, réessayez.` };
  }
}

/** Pour la file des signataires : quels BC attendent encore la Direction Marketing, et qui l'a signé. */
export async function etatMarketingDesBC(ids: readonly string[]): Promise<Record<string, { attend: boolean; dm: { nom: string; le: string } | null }>> {
  if (ids.length === 0) return {};
  const [exiges, dms] = await Promise.all([
    prisma.adProItemPiece.findMany({ where: { legalDocumentId: { in: [...ids] }, nature: "BON_DE_COMMANDE", item: { voie: "AGENCE" } }, select: { legalDocumentId: true } }),
    prisma.signatureBC.findMany({ where: { legalDocumentId: { in: [...ids] }, qualite: "DIRECTION_MARKETING" }, select: { legalDocumentId: true, signataireNom: true, signedAt: true } }),
  ]);
  const exige = new Set(exiges.map((e) => e.legalDocumentId));
  const dmDe = new Map(dms.map((d) => [d.legalDocumentId, { nom: d.signataireNom, le: d.signedAt.toISOString() }]));
  return Object.fromEntries(ids.map((id) => [id, { attend: exige.has(id) && !dmDe.has(id), dm: dmDe.get(id) ?? null }]));
}

/**
 * CE QUE LA PAGE PUBLIQUE DE VÉRIFICATION MONTRE (`/verifier-bc/<jeton>`) — le numéro, l'émetteur, l'état, les signataires,
 * l'empreinte du dernier PDF. Ni montant, ni lignes, ni fournisseur. `null` pour un jeton inconnu.
 */
export async function verificationDuJeton(jeton: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(jeton)) return null;
  const sig = await prisma.signatureBC.findUnique({ where: { jeton }, select: { legalDocumentId: true } });
  if (!sig) return null;
  const [piece, signatures] = await Promise.all([
    prisma.legalDocument.findUnique({ where: { id: sig.legalDocumentId }, select: { reference: true, status: true, company: { select: { name: true } } } }),
    prisma.signatureBC.findMany({ where: { legalDocumentId: sig.legalDocumentId }, orderBy: { signedAt: "asc" }, select: { qualite: true, signataireNom: true, signataireTitre: true, signedAt: true, empreinte: true, jeton: true } }),
  ]);
  if (!piece) return null;
  return { reference: piece.reference, annule: piece.status === "CANCELLED", emetteur: piece.company?.name ?? null, signatures };
}
