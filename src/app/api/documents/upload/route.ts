import { NextRequest, NextResponse } from "next/server";
import type { Confidentiality, DocumentCategory, EntityType } from "@prisma/client";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { getAppSettings } from "@/lib/settings";
import { persistUploadedDocument, dossierSur } from "@/lib/documents";
import { mirrorRegulatoryUpload } from "@/lib/regulatory-drive-mirror";
import { mirrorDocumentsToDrive } from "@/lib/drive/document-mirror";
import { shouldMirrorToDrive } from "@/lib/drive/mirror-path";
import { prisma } from "@/lib/prisma";
import { refusDevisLibre } from "@/lib/promo-material/rangement";
import { gardeDuDepotLibre } from "@/lib/factures/connues";

/**
 * Téléversement de documents **en lot** (fichiers ET dossiers) pour un objet métier :
 * `POST /api/documents/upload` (multipart). Route en **flux** (pas la limite des Server
 * Actions) → gros volumes acceptés ; le client envoie les fichiers **en parallèle** pour
 * la vitesse. Un lot = une catégorie / confidentialité / étape ; nombre de fichiers non
 * limité (borne de **taille par fichier** réglable en Administration).
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });

  const form = await req.formData();
  const entityType = String(form.get("entityType") ?? "") as EntityType;
  const entityId = String(form.get("entityId") ?? "");
  const category = (String(form.get("category") ?? "OTHER") || "OTHER") as DocumentCategory;
  const confidentiality = (String(form.get("confidentiality") ?? "INTERNAL") || "INTERNAL") as Confidentiality;
  const stepKey = form.get("stepKey") ? String(form.get("stepKey")) : null;
  // Dossier d'origine (dépôt d'un DOSSIER) : l'arborescence se garde sur la fiche ET dans le Drive.
  const folder = dossierSur(form.get("folder") ? String(form.get("folder")) : null);
  // Le dépôt vient du bloc « CTD initiale » d'un dossier Regulatory (§118.213) ; `persistUploadedDocument` le juge.
  const ctd = String(form.get("ctd") ?? "") === "1";
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  if (!entityType || !entityId) return NextResponse.json({ error: "Entité manquante." }, { status: 400 });
  if (!(await canAccessEntity(user, entityType, entityId, "UPLOAD"))) {
    return NextResponse.json({ error: "Vous n'êtes pas autorisé à téléverser ici." }, { status: 403 });
  }
  if (files.length === 0) return NextResponse.json({ error: "Aucun fichier." }, { status: 400 });
  // UN DEVIS DU MATÉRIEL PROMOTIONNEL N'EST PAS UN FICHIER LIBRE (§118.204) : au circuit 2, un devis se
  // dépose avec SON fournisseur et devient un devis du circuit — un fichier « Devis » posé ici attendrait
  // qu'on lui crée une fiche, et c'est ce que la Direction a retiré.
  if (entityType === "PROMO_MATERIAL" && category === "QUOTE") {
    const refus = refusDevisLibre(await prisma.promoMaterial.findUnique({ where: { id: entityId }, select: { circuitVersion: true } }));
    if (refus) return NextResponse.json({ error: refus }, { status: 400 });
  }

  // Une seule lecture des réglages pour tout le lot (repli généreux si la lecture échoue).
  const maxUploadMb = await getAppSettings().then((s) => s.maxUploadMb).catch(() => 200);
  // TOUT document téléversé est AUSSI répliqué dans le Drive : Regulatory dans le dossier du produit de
  // la catégorie « Regulatory » (Direction, 06/10 — repli : l'ancien miroir), les autres modules sous
  // « Mes documents importés / <module> / <objet> ». On garde le binaire pour ça.
  const isRegulatory = entityType === "REGULATORY_PRODUCT";
  const mirrorHere = isRegulatory || shouldMirrorToDrive(entityType);
  const toMirror: { name: string; data: Buffer; mime?: string }[] = [];
  let created = 0;
  // LES IDENTIFIANTS CRÉÉS voyagent avec la réponse : l'écran qui vient de déposer peut demander
  // à Luna où ranger la pièce (« + Pièce jointe » des détails d'une demande Ad & Pro).
  const ids: string[] = [];
  const errors: { name: string; error: string }[] = [];
  // UNE FACTURE DÉJÀ CONNUE AILLEURS NE SE DÉPOSE PAS UNE SECONDE FOIS (Direction, 14/10/2026) : la première pièce
  // d'une facture du registre, ou un fichier « Facture » posé sur un dossier. Jugé avant d'écrire ; le fichier refusé
  // a son erreur (la phrase du blocage), les autres du lot passent.
  // Les octets ne sont relus ici que pour un dépôt qui PEUT être une facture : un lot de quarante pièces réglementaires
  // ne passe pas deux fois en mémoire.
  const peutEtreFacture = entityType === "LEGAL_DOCUMENT" || category === "INVOICE";
  const garde = await gardeDuDepotLibre(user, { entityType, entityId, category }, peutEtreFacture
    ? await Promise.all(files.map(async (f) => ({ octets: Buffer.from(await f.arrayBuffer()), nom: f.name })))
    : []);
  for (const [index, file] of files.entries()) {
    const refusFacture = garde.refus.get(index);
    if (refusFacture) { errors.push({ name: file.name, error: refusFacture }); continue; }
    // Chaque fichier est isolé : une erreur (lecture, stockage, base) devient une erreur DE CE
    // fichier avec sa cause exacte — jamais une 500 opaque qui ferait échouer tout le lot.
    try {
      // Lecture unique du binaire : réutilisée par l'enregistrement ET le miroir Drive (Regulatory).
      const buffer = Buffer.from(await file.arrayBuffer());
      // `mirrorToDrive: false` — le lot fait son miroir lui-même, en une seule fois, après la
      // boucle : un envoi de 40 fichiers ne doit pas rouvrir 40 fois la même arborescence.
      const r = await persistUploadedDocument(user.id, { entityType, entityId, category, confidentiality, stepKey, folder, file, maxUploadMb, buffer, mirrorToDrive: false, ctd });
      if (r.ok) {
        created++;
        if (r.documentId) ids.push(r.documentId);
        if (mirrorHere) toMirror.push({ name: isRegulatory && folder ? `${folder}/${file.name}` : file.name, data: buffer, mime: file.type || undefined });
      } else {
        errors.push({ name: file.name, error: r.error ?? "Échec du téléversement." });
      }
    } catch (err) {
      console.error("[documents upload] fichier en échec", { name: file.name, entityType, entityId }, err);
      errors.push({ name: file.name, error: err instanceof Error ? err.message : "Échec du téléversement." });
    }
  }

  if (created > 0) await garde.apres();

  // Miroir Drive automatique EN ARRIÈRE-PLAN : on NE bloque PAS la réponse dessus. Le document
  // est déjà enregistré (c'est ce que l'utilisateur voit) ; la copie Drive se termine juste après,
  // sur le serveur persistant (Render) → téléversement ressenti « instantané », l'utilisateur peut
  // enchaîner d'autres tâches. Best-effort : toute erreur est journalisée, jamais propagée.
  if (toMirror.length > 0) {
    const mirror = isRegulatory
      // Regulatory : rangé dans le dossier du produit de la catégorie « Regulatory », d'après les fiches créées.
      ? mirrorRegulatoryUpload({ productId: entityId, ownerId: user.id, files: toMirror, documentIds: ids })
      : mirrorDocumentsToDrive({ ownerId: user.id, entityType, entityId, files: toMirror });
    void mirror.catch((e) => console.error("[documents upload] miroir Drive en arrière-plan a échoué", e));
  }

  return NextResponse.json({ ok: errors.length === 0, created, ids, errors });
}
