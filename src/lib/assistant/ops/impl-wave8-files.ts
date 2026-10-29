import { prisma } from "@/lib/prisma";
import { uploadDocument } from "@/lib/actions/document-actions";
import { importTransactions } from "@/modules/finances/actions-tresorerie";
import { spendFromPettyCash } from "@/lib/actions/petty-cash-actions";
import { addPaymentPiece } from "@/modules/finances/actions-demandes";
import { importDirectorySheet } from "@/lib/actions/medical-directory-actions";
import { fulfillDocRequest } from "@/lib/actions/medical-info-actions";
import { analyzeTenderDocument } from "@/lib/actions/pch-tender-line-actions";
import { uploadLetterhead } from "@/lib/actions/letterhead-actions";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { getBlob } from "@/lib/drive-storage";
import { DOCUMENT_CATEGORY, ENTITY_TYPE_LABELS } from "@/lib/labels";
import { KIND_EXTENSION, KIND_LABEL } from "@/platform/in-process/office";
import { hasGlobalView } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { fieldsOf, dzd } from "./helpers";
import { matchLabel, fold } from "./impl-regulatory";
import { resolveRecordOfType } from "./impl-wave7d";

/**
 * OPS VAGUE 8 — LES FICHIERS DEVIENNENT FIRST-CLASS : les huit derniers gestes d'écran qui
 * exigent un FICHIER passent par le Chief. Le fichier se donne par NOM (Drive) — la personne
 * l'a déposé au Drive ou l'a glissé dans la conversation (le flux « sans re-téléversement »
 * référence déjà le Drive). La proposition RÉSOUT et MONTRE le fichier (nom, taille) ; à
 * l'exécution, les droits Drive sont REVÉRIFIÉS, le contenu est relu (dernière version) et
 * rejoué à l'ACTION CANONIQUE de l'écran — qui revalide tout (droits, formats, plafonds).
 * Aucun octet n'est mémorisé dans l'intention : seulement la référence du fichier.
 */

export interface DriveFileHit { id: string; name: string; size: number; mimeType: string | null }

export const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const extOf = (name: string): string => (name.split(".").pop() ?? "").toLowerCase();

/** Un fichier du Drive par NOM : les MIENS d'abord, sinon les fichiers accessibles (bornés, filtrés par droit). */
export async function resolveDriveFile(user: CurrentUser, raw: string): Promise<DriveFileHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nommez le fichier (champ « file ») — un fichier du Drive (glissé dans la conversation ou déposé)." };
  const pick = (rows: DriveFileHit[]): DriveFileHit | null => {
    if (rows.length === 1) return rows[0];
    const exact = rows.filter((r) => fold(r.name) === fold(q));
    return exact.length === 1 ? exact[0] : null;
  };
  const mine = await prisma.driveNode.findMany({
    where: { ownerId: user.id, type: "FILE", isTrashed: false, name: { contains: q, mode: "insensitive" } },
    select: { id: true, name: true, size: true, mimeType: true },
    orderBy: { updatedAt: "desc" }, take: 6,
  });
  const own = pick(mine);
  if (own) return own;
  if (mine.length > 1) {
    return { error: `Plusieurs de VOS fichiers correspondent à « ${q} » : ${mine.map((r) => `${r.name} (${kb(r.size)})`).join(" ; ")} — préciser le nom exact.` };
  }
  // Pas à moi : fichiers partagés/accessibles — candidats bornés, droit vérifié UN PAR UN.
  const others = await prisma.driveNode.findMany({
    where: { type: "FILE", isTrashed: false, name: { contains: q, mode: "insensitive" }, NOT: { ownerId: user.id } },
    select: { id: true, name: true, size: true, mimeType: true },
    orderBy: { updatedAt: "desc" }, take: 8,
  });
  const visible: DriveFileHit[] = [];
  for (const r of others) {
    if (canViewDrive(await resolveDriveAccess(user, r.id))) visible.push(r);
  }
  const shared = pick(visible);
  if (shared) return shared;
  if (visible.length > 1) {
    return { error: `Plusieurs fichiers accessibles correspondent à « ${q} » : ${visible.map((r) => `${r.name} (${kb(r.size)})`).join(" ; ")} — préciser le nom exact.` };
  }
  return { error: `Aucun fichier « ${q} » dans votre Drive ni parmi les fichiers qui vous sont accessibles — déposez-le (ou glissez-le dans la conversation) puis redemandez.` };
}

/** Reconstruit un File réel depuis le Drive à l'EXÉCUTION — droits revérifiés, dernière version. */
export async function driveNodeToFile(user: CurrentUser, nodeId: string): Promise<File | { error: string }> {
  if (!canViewDrive(await resolveDriveAccess(user, nodeId))) return { error: "Ce fichier du Drive ne vous est plus accessible." };
  const node = await prisma.driveNode.findUnique({ where: { id: nodeId }, select: { name: true, type: true, mimeType: true, isTrashed: true } });
  if (!node || node.type !== "FILE" || node.isTrashed) return { error: "Fichier du Drive introuvable (déplacé ou supprimé ?)." };
  const version = await prisma.fileVersion.findFirst({ where: { nodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  if (!version) return { error: "Ce fichier n'a aucun contenu téléversé." };
  const bytes = await getBlob(version.blobId);
  if (!bytes || bytes.length === 0) return { error: "Le contenu du fichier est illisible dans le stockage." };
  return new File([new Uint8Array(bytes)], node.name, { type: node.mimeType ?? "application/octet-stream" });
}

const CATEGORY_PAIRS: [string, string][] = Object.entries(DOCUMENT_CATEGORY as Record<string, string>);
const OCR_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"]);

// ─────────────────────────── OPS ───────────────────────────

/** Pièce jointe d'un objet métier (bibliothèque « Documents » des fiches). */
export const FILE_WS_OPS_IMPL: Record<string, OpImpl> = {
  upload_document: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const entityType = matchLabel(opStr(input, "kind") || opStr(input, "type"), Object.entries(ENTITY_TYPE_LABELS as Record<string, string>));
      if (typeof entityType !== "string") return entityType;
      const rec = await resolveRecordOfType(entityType, opStr(input, "target") || opStr(input, "record"));
      if ("error" in rec) return rec;
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;
      let category = "OTHER";
      const catRaw = opStr(input, "category");
      if (catRaw) {
        const m = matchLabel(catRaw, CATEGORY_PAIRS);
        if (typeof m !== "string") return m;
        category = m;
      }
      return {
        title: `Joindre « ${f.name} » à ${rec.name}`,
        fields: fieldsOf([
          ["Objet", `${rec.name} (${ENTITY_TYPE_LABELS[entityType as keyof typeof ENTITY_TYPE_LABELS] ?? entityType})`],
          ["Fichier", `${f.name} (${kb(f.size)})`],
          ["Catégorie", DOCUMENT_CATEGORY[category] ?? category],
        ]),
        warnings: [
          "Le contenu est COPIÉ dans la bibliothèque de la fiche (le fichier du Drive reste intact).",
          "Le droit de TÉLÉVERSEMENT sur l'objet est revérifié par l'action.",
        ],
        args: { entityType, entityId: rec.id, category, fileNodeId: f.id },
        successMessage: `« ${f.name} » joint à ${rec.name}.`,
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("entityType", args.entityType ?? "");
      fd.set("entityId", args.entityId ?? "");
      fd.set("category", args.category ?? "OTHER");
      fd.set("file", file);
      const r = await uploadDocument(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Téléversement refusé." };
      return { ok: true, message: "Pièce jointe déposée." };
    },
  },
};

/** Finances : import CSV, dépense de caisse avec pièce, pièce d'une demande de paiement. */
export const FILE_FINANCE_OPS_IMPL: Record<string, OpImpl> = {
  import_transactions: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const inline = opStr(input, "note");
      const fileRaw = opStr(input, "file");
      if (!inline && !fileRaw) {
        return { error: "Donnez le CSV : un fichier .csv du Drive (champ « file ») ou les lignes collées (champ « note »). En-tête attendu : date;direction;categorie;libelle;montant;methode;compte;contrepartie." };
      }
      let csvArgs: Record<string, string | null>;
      let sourceShown: string;
      let lineCount: number;
      if (fileRaw) {
        const f = await resolveDriveFile(user, fileRaw);
        if ("error" in f) return f;
        const ext = extOf(f.name);
        if (ext !== "csv" && ext !== "txt") {
          return { error: `« ${f.name} » n'est pas un CSV (.csv / .txt attendu — un classeur Excel doit être enregistré en CSV d'abord).` };
        }
        if (f.size > 2 * 1048576) return { error: `« ${f.name} » dépasse 2 Mo — découpez l'import.` };
        const file = await driveNodeToFile(user, f.id);
        if (!(file instanceof File)) return { error: file.error };
        const text = Buffer.from(await file.arrayBuffer()).toString("utf8");
        lineCount = Math.max(0, text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length - 1);
        csvArgs = { fileNodeId: f.id };
        sourceShown = `${f.name} (${kb(f.size)})`;
      } else {
        lineCount = Math.max(0, inline.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length - 1);
        csvArgs = { csv: inline };
        sourceShown = "lignes collées dans la conversation";
      }
      if (lineCount === 0) return { error: "Aucune ligne sous l'en-tête — rien à importer." };
      return {
        title: `Importer ${lineCount} mouvement(s) de trésorerie`,
        fields: fieldsOf([
          ["Source", sourceShown],
          ["Lignes sous l'en-tête", String(lineCount)],
        ]),
        warnings: [
          "CRÉE un mouvement par ligne exploitable (références FIN-AAAA-NNN attribuées à la suite) — les lignes illisibles sont ignorées sans bloquer les autres.",
          "Format : date;direction(IN/OUT);catégorie;libellé;montant;méthode;compte;contrepartie.",
        ],
        args: csvArgs,
        successMessage: "Import de trésorerie effectué.",
      };
    },
    async execute(args, user) {
      let csv = args.csv ?? "";
      if (!csv && args.fileNodeId) {
        const file = await driveNodeToFile(user, args.fileNodeId);
        if (!(file instanceof File)) return { ok: false, error: file.error };
        csv = Buffer.from(await file.arrayBuffer()).toString("utf8");
      }
      if (!csv) return { ok: false, error: "CSV introuvable." };
      const fd = new FormData();
      fd.set("csv", csv);
      const r = await importTransactions(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Import refusé." };
      // Le bilan de l'action dit ce qui est entré et ce qui a été écarté, ligne par ligne :
      // « Mouvements importés. » sur un relevé à moitié refusé serait un faux succès.
      return { ok: true, message: r.message ?? "Mouvements importés." };
    },
  },

  spend_from_petty_cash: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const label = opStr(input, "label") || opStr(input, "name");
      if (!label) return { error: "Indiquez ce qui a été acheté (champ « label »)." };
      const amountRaw = opStr(input, "amount").replace(/\s/g, "").replace(",", ".");
      const amount = Number(amountRaw);
      if (!amountRaw || Number.isNaN(amount) || amount <= 0) return { error: "Champ « amount » : le montant DZD de la dépense." };
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;

      const periodRaw = opStr(input, "period");
      const where = {
        status: { not: "CLOSED" as const },
        ...(hasGlobalView(user) ? {} : { holderId: user.id }),
        ...(periodRaw ? { period: periodRaw } : {}),
      };
      const cashes = await prisma.pettyCashAllotment.findMany({
        where, orderBy: { period: "desc" }, take: 5,
        select: { id: true, period: true, status: true, amount: true, holder: { select: { name: true } }, department: { select: { name: true } } },
      });
      if (cashes.length === 0) {
        return { error: periodRaw ? `Aucune caisse ouverte pour « ${periodRaw} »${hasGlobalView(user) ? "" : " à votre nom"}.` : `Aucune caisse d'avance ouverte${hasGlobalView(user) ? "" : " à votre nom"}.` };
      }
      const open = cashes.filter((c) => c.status === "RECEIVED");
      const cash = (open.length === 1 ? open[0] : null) ?? (cashes.length === 1 ? cashes[0] : null);
      if (!cash) {
        return { error: `Plusieurs caisses possibles : ${cashes.map((c) => `${c.period} (${c.department.name}${c.holder ? `, ${c.holder.name}` : ""}, ${c.status})`).join(" ; ")} — précisez la période (champ « period », AAAA-MM).` };
      }
      return {
        title: `Dépense de caisse — ${label}`,
        fields: fieldsOf([
          ["Caisse", `${cash.period} — ${cash.department.name}${cash.holder ? ` (${cash.holder.name})` : ""}`],
          ["Dépense", label],
          ["Montant", dzd(amount)],
          ["Pièce", `${f.name} (${kb(f.size)})`],
        ]),
        warnings: [
          "La pièce (facture / bon) est OBLIGATOIRE — une dépense sans pièce n'est qu'une affirmation.",
          "Le solde de la caisse est recontrôlé par l'action au moment de l'imputation (détenteur seul, sauf vue globale).",
        ],
        args: { cashId: cash.id, label, amount: String(amount), fileNodeId: f.id },
        successMessage: `Dépense « ${label} » imputée à la caisse ${cash.period}.`,
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("cashId", args.cashId ?? "");
      fd.set("label", args.label ?? "");
      fd.set("amount", args.amount ?? "");
      fd.append("files", file);
      const r = await spendFromPettyCash(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Dépense refusée." };
      return { ok: true, message: "Dépense imputée, pièce jointe déposée." };
    },
  },

  add_payment_piece: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "target") || opStr(input, "reference");
      if (!q) return { error: "Désignez la demande de paiement (référence PAY-… ou titre — champ « target »)." };
      const rows = await prisma.paymentRequest.findMany({
        where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
        select: { id: true, reference: true, title: true, status: true, payee: true },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de paiement « ${q} ».` };
      if (rows.length > 1) return { error: `Plusieurs demandes correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.title}`).join(" ; ")} — préciser la référence.` };
      const req = rows[0];
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;
      return {
        title: `Ajouter une pièce à ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.title} (${req.payee})`],
          ["Pièce", `${f.name} (${kb(f.size)})`],
        ]),
        warnings: [
          "Réservé au DEMANDEUR ou aux Finances ; un dossier clos ne reçoit plus de pièce — revérifié par l'action.",
          "La pièce entre dans la bibliothèque du dossier et dans le circuit de contrôle des pièces.",
        ],
        args: { requestId: req.id, fileNodeId: f.id },
        successMessage: `Pièce « ${f.name} » ajoutée à ${req.reference}.`,
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("requestId", args.requestId ?? "");
      fd.set("file", file);
      const r = await addPaymentPiece(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Ajout refusé." };
      return { ok: true, message: "Pièce déposée." };
    },
  },
};

/** Annuaire médical : import d'un classeur de praticiens. */
export const FILE_MEDICAL_OPS_IMPL: Record<string, OpImpl> = {
  import_directory_sheet: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;
      const ext = extOf(f.name);
      if (!["xlsx", "xls", "csv"].includes(ext)) {
        return { error: `« ${f.name} » n'est ni un classeur Excel (.xlsx, .xls) ni un CSV.` };
      }
      return {
        title: `Importer l'annuaire depuis « ${f.name} »`,
        fields: fieldsOf([["Fichier", `${f.name} (${kb(f.size)})`]]),
        warnings: [
          "CRÉE une fiche praticien par ligne exploitable (colonne « Nom » requise : Nom, Praticien, Médecin ou Nom et prénom) — les lignes sans nom sont ignorées.",
          "Les colonnes reconnues (spécialité, wilaya, potentiel…) sont rapportées par l'action après import.",
        ],
        args: { fileNodeId: f.id },
        successMessage: "Annuaire importé.",
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("file", file);
      const r = await importDirectorySheet(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Import refusé." };
      return { ok: true, message: r.message ?? "Annuaire importé." };
    },
  },
};

/** Information médicale : déposer la pièce qui M'a été demandée. */
export const FILE_MEDINFO_OPS_IMPL: Record<string, OpImpl> = {
  fulfill_doc_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pending = await prisma.medicalInfoDocRequest.findMany({
        where: { status: "PENDING", targetUserId: user.id },
        select: { id: true, label: true, declaration: { select: { reference: true } } },
        orderBy: { createdAt: "desc" }, take: 10,
      });
      if (pending.length === 0) return { error: "Aucune pièce ne vous est demandée (Information médicale)." };
      const q = fold(opStr(input, "label") || opStr(input, "target"));
      const show = (r: (typeof pending)[number]) => `« ${r.label} » (${r.declaration.reference ?? "déclaration"})`;
      let req = pending[0];
      if (q && pending.length > 1) {
        const hits = pending.filter((r) => fold(r.label).includes(q) || fold(r.declaration.reference ?? "").includes(q));
        if (hits.length === 0) return { error: `Aucune demande ne correspond à « ${opStr(input, "label")} » — en attente : ${pending.map(show).join(" ; ")}.` };
        if (hits.length > 1) return { error: `Plusieurs demandes correspondent : ${hits.map(show).join(" ; ")} — préciser.` };
        req = hits[0];
      } else if (!q && pending.length > 1) {
        return { error: `Plusieurs pièces vous sont demandées : ${pending.map(show).join(" ; ")} — nommez celle que vous déposez (champ « label »).` };
      }
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;
      const note = opStr(input, "note");
      return {
        title: `Déposer la pièce ${show(req)}`,
        fields: fieldsOf([
          ["Demande", show(req)],
          ["Fichier", `${f.name} (${kb(f.size)})`],
          ["Précision", note || "—"],
        ]),
        warnings: ["Le dépôt clôt la demande (statut « déposée ») et notifie le demandeur — une pièce déjà déposée ne se redépose pas."],
        args: { requestId: req.id, fileNodeId: f.id, note: note || null },
        successMessage: `Pièce « ${f.name} » déposée.`,
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("requestId", args.requestId ?? "");
      if (args.note) fd.set("note", args.note);
      fd.set("file", file);
      const r = await fulfillDocRequest(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Dépôt refusé." };
      return { ok: true, message: "Pièce déposée, demandeur notifié." };
    },
  },
};

/** PCH : lecture IA d'un appel d'offres (OCR → lignes du marché). */
export const FILE_PCH_OPS_IMPL: Record<string, OpImpl> = {
  analyze_tender_document: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "target") || opStr(input, "reference");
      if (!q) return { error: "Désignez le marché PCH (référence ou intitulé — champ « target »)." };
      const rows = await prisma.pchTender.findMany({
        where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
        select: { id: true, reference: true, title: true },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucun marché PCH « ${q} ».` };
      if (rows.length > 1) return { error: `Plusieurs marchés correspondent à « ${q} » : ${rows.map((r) => `${r.reference}${r.title ? ` — ${r.title}` : ""}`).join(" ; ")} — préciser la référence.` };
      const tender = rows[0];
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;
      const ext = extOf(f.name);
      if (!OCR_EXTS.has(ext)) return { error: `« ${f.name} » : format .${ext} non pris en charge pour l'OCR (PDF ou image).` };
      return {
        title: `Lire l'appel d'offres ${tender.reference} (IA)`,
        fields: fieldsOf([
          ["Marché", `${tender.reference}${tender.title ? ` — ${tender.title}` : ""}`],
          ["Document", `${f.name} (${kb(f.size)})`],
        ]),
        warnings: [
          "Texte du document lu tel quel (OCR seulement pour un scan), puis EXTRACTION IA des lignes du marché — une nouvelle lecture REMPLACE les lignes des lectures précédentes que personne n'a touchées (les lignes modifiées, chiffrées, soumises, annotées ou rattachées restent) ; opération facturée (IA).",
        ],
        args: { tenderId: tender.id, fileNodeId: f.id },
        successMessage: `Appel d'offres ${tender.reference} lu — lignes extraites.`,
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("tenderId", args.tenderId ?? "");
      fd.set("file", file);
      const r = await analyzeTenderDocument(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Lecture refusée." };
      return { ok: true, message: r.message ?? "Lignes du marché extraites." };
    },
  },
};

/** Papeterie : déposer un papier en-tête (assistante de direction / Super Admin). */
export const FILE_ORG_OPS_IMPL: Record<string, OpImpl> = {
  upload_letterhead: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const kindRaw = fold(opStr(input, "kind") || opStr(input, "type"));
      let kind: "word" | "cell" | "slide" | "" = "";
      if (/word|docx|courrier|lettre|document/.test(kindRaw)) kind = "word";
      else if (/excel|xlsx|classeur|tableur|cell/.test(kindRaw)) kind = "cell";
      else if (/power|pptx|pr[ée]sentation|slide|diapo/.test(kindRaw)) kind = "slide";
      if (!kind) return { error: "Champ « kind » : Word, Excel ou PowerPoint." };
      const f = await resolveDriveFile(user, opStr(input, "file"));
      if ("error" in f) return f;
      const expected = KIND_EXTENSION[kind];
      if (extOf(f.name) !== expected) {
        return { error: `Un en-tête ${KIND_LABEL[kind]} doit être un fichier .${expected} — « ${f.name} » n'en est pas un.` };
      }
      let companyShown = "—";
      const args: Record<string, string | null> = { kind, fileNodeId: f.id };
      const companyRaw = opStr(input, "company");
      if (companyRaw) {
        const rows = await prisma.company.findMany({
          where: { name: { contains: companyRaw, mode: "insensitive" }, isActive: true },
          select: { id: true, name: true }, take: 4,
        });
        if (rows.length !== 1) return { error: rows.length === 0 ? `Aucune entité « ${companyRaw} ».` : `Plusieurs entités correspondent : ${rows.map((c) => c.name).join(", ")} — préciser.` };
        args.companyId = rows[0].id;
        companyShown = rows[0].name;
      }
      return {
        title: `Déposer le papier en-tête ${KIND_LABEL[kind]} « ${f.name} »`,
        fields: fieldsOf([
          ["Type", KIND_LABEL[kind]],
          ["Fichier", `${f.name} (${kb(f.size)})`],
          ["Entité", companyShown],
        ]),
        warnings: [
          "Ce modèle servira à TOUS les documents « avec en-tête » créés ensuite (les octets sont recopiés tels quels) — vérifiez marges, logo et mentions avant de déposer.",
          "Papeterie tenue par l'assistante de direction et le Super Admin — revérifié par l'action ; l'entité doit être dans votre périmètre.",
        ],
        args,
        successMessage: `Papier en-tête ${KIND_LABEL[kind]} déposé.`,
      };
    },
    async execute(args, user) {
      const file = await driveNodeToFile(user, args.fileNodeId ?? "");
      if (!(file instanceof File)) return { ok: false, error: file.error };
      const fd = new FormData();
      fd.set("kind", args.kind ?? "");
      if (args.companyId) fd.set("companyId", args.companyId);
      fd.set("file", file);
      const r = await uploadLetterhead(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Dépôt refusé." };
      return { ok: true, message: "Papier en-tête déposé." };
    },
  },
};
