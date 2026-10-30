import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { deposerFichierDrive } from "@/lib/drive/mirror";
import { userCan, isTopManagement, type SessionUser } from "@/lib/rbac";
import { companyScopedWhere } from "@/lib/company";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { dossierStageLabel } from "@/platform/ia/lectures/regulatory-read";
import { recruitmentScope } from "@/lib/recruitment/access";
import {
  PHARMA_FORM, DOSAGE_UNIT, REGULATORY_STATUS, PRIORITY, DOCTOR_TITLE,
  MAIL_DIRECTION, ROLE_LABELS,
} from "@/lib/labels";
import { CONTRACT_LABEL, STAGE_LABEL, type RecruitmentContract, type RecruitmentStage } from "@/lib/recruitment/request-flow";

/**
 * L'ASSISTANT EXPORTE EN EXCEL — et le classeur atterrit dans le Drive de qui l'a demandé.
 *
 * Deux décisions expliquent tout ce fichier :
 *
 *   • le contenu ne dépasse JAMAIS ce que la personne a le droit de lire. Chaque jeu de données
 *     réutilise les mêmes portées que l'écran correspondant (`scopeRegulatory`, l'entité
 *     courante, le périmètre des recrutements). Un export est une lecture de plus, pas une porte
 *     dérobée — et c'est exactement le risque quand on donne un tel outil à un modèle ;
 *   • le fichier va dans le DRIVE PERSONNEL du demandeur, pas dans un lien éphémère. Un export
 *     contient souvent des rémunérations ou des coordonnées ; il doit vivre là où les
 *     autorisations existent déjà, se retrouver le lendemain, et se supprimer comme n'importe
 *     quel fichier. Un téléchargement direct depuis une conversation ne laisse aucune de ces
 *     prises.
 */

/** Le dossier du Drive où atterrissent les exports — un seul, pour ne pas éparpiller. */
const EXPORT_FOLDER = "Exports IA";

export type ExportDataset = "regulatory" | "annuaire" | "courriers" | "recrutement" | "comptes" | "employes";

interface DatasetSpec {
  /** Ce que l'on exporte, dit à l'utilisateur. */
  label: string;
  /** Le module qu'il faut pouvoir LIRE. `null` = réservé au sommet (comptes). */
  module: "REGULATORY" | "MEDICAL" | "MAIL_REGISTER" | "RECRUITMENT" | "RH" | null;
  sheet: string;
  columns: string[];
  widths: number[];
}

export const DATASETS: Record<ExportDataset, DatasetSpec> = {
  regulatory: {
    label: "Dossiers Regulatory", module: "REGULATORY", sheet: "Dossiers",
    columns: ["Référence", "DCI", "Nom commercial", "Dosage", "Forme", "Conditionnement", "Classe thérapeutique", "Partenaire", "Statut", "Priorité", "Étape ANPP", "Avancement", "Chargé du dossier", "Entité", "Date cible dépôt", "Date cible enregistrement", "Lien ERP"],
    widths: [16, 28, 22, 14, 18, 18, 22, 22, 12, 22, 16, 14],
  },
  annuaire: {
    label: "Annuaire médical", module: "MEDICAL", sheet: "Annuaire",
    columns: ["Nom", "Prénom", "Spécialité", "Grade", "Établissement", "Ville", "Wilaya", "Téléphone", "E-mail"],
    widths: [22, 18, 22, 20, 28, 18, 18, 18, 26],
  },
  courriers: {
    label: "Registre des courriers", module: "MAIL_REGISTER", sheet: "Courriers",
    columns: ["Chrono", "Sens", "Objet", "Expéditeur", "Destinataire", "Départ", "Arrivée", "Accusé", "Direction concernée", "Personne concernée", "Entité"],
    widths: [14, 12, 34, 22, 22, 18, 14, 14, 22, 22, 16],
  },
  recrutement: {
    label: "Demandes de recrutement", module: "RECRUITMENT", sheet: "Recrutement",
    columns: ["Référence", "Poste", "Contrat", "Postes", "Direction", "Demandeur", "Étape", "Candidats", "Déposée le"],
    widths: [16, 30, 14, 10, 22, 22, 24, 12, 14],
  },
  employes: {
    label: "Effectif", module: "RH", sheet: "Employés",
    columns: ["Nom", "Poste", "Département", "Entité", "Contrat", "Embauche", "Statut", "E-mail", "Téléphone"],
    widths: [26, 26, 22, 16, 14, 14, 12, 26, 18],
  },
  comptes: {
    label: "Comptes de la plateforme", module: null, sheet: "Comptes",
    columns: ["Nom", "E-mail", "Rôle", "Autre rôle", "Actif", "Créé le"],
    widths: [26, 30, 26, 26, 10, 14],
  },
};

export function isExportDataset(v: string): v is ExportDataset {
  return Object.prototype.hasOwnProperty.call(DATASETS, v);
}

const fr = (d: Date | null | undefined) =>
  d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "";

/** Le droit de lire ce jeu de données — la même question que celle de l'écran correspondant. */
export function canExport(user: SessionUser, dataset: ExportDataset): boolean {
  const spec = DATASETS[dataset];
  // La liste des comptes est une donnée de gouvernance : elle reste au sommet de la maison.
  if (spec.module === null) return user.role === "SUPER_ADMIN" || isTopManagement(user);
  return userCan(user, spec.module, "VIEW");
}

/** Les lignes du jeu de données, DANS LE PÉRIMÈTRE de la personne. */
async function fetchRows(user: SessionUser, dataset: ExportDataset, limit: number): Promise<string[][]> {
  const take = Math.min(Math.max(limit, 1), 5000);
  switch (dataset) {
    case "regulatory": {
      // LE MÊME PÉRIMÈTRE QUE L'ÉCRAN (`regulatoryVisibleWhere`) et le MÊME calcul d'étape
      // (`dossierStageLabel` → regProgress) : l'export ne contredit ni le tableau ni le Chief.
      const rows = await prisma.regulatoryProduct.findMany({
        where: await regulatoryVisibleWhere(user),
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        take,
        include: {
          responsible: { select: { name: true } },
          company: { select: { name: true, shortName: true } },
        },
      });
      return rows.map((p) => {
        const stage = dossierStageLabel(p.workflow);
        return [
          p.reference, p.dci, p.brandName ?? "",
          [p.dosage, p.dosageUnit ? DOSAGE_UNIT[p.dosageUnit] ?? p.dosageUnit : null].filter(Boolean).join(" "),
          p.pharmaceuticalForm ? PHARMA_FORM[p.pharmaceuticalForm] ?? p.pharmaceuticalForm : "",
          p.packaging ?? "", p.therapeuticClass ?? "",
          p.partnerLab ?? "",
          REGULATORY_STATUS[p.status]?.label ?? p.status,
          PRIORITY[p.priority]?.label ?? p.priority,
          stage.etape, stage.avancement,
          p.responsible?.name ?? "", p.company?.shortName ?? p.company?.name ?? "",
          fr(p.targetSubmissionDate), fr(p.targetDate),
          `/regulatory/${p.id}`,
        ];
      });
    }
    case "annuaire": {
      const rows = await prisma.medicalDoctor.findMany({ orderBy: { name: "asc" }, take });
      return rows.map((d) => [
        d.lastName ?? d.name ?? "", d.firstName ?? "", d.specialty ?? "",
        d.title ? DOCTOR_TITLE[d.title] ?? d.title : "",
        d.institution ?? "", d.city ?? "", d.wilaya ?? "", d.phone ?? "", d.email ?? "",
      ]);
    }
    case "courriers": {
      const rows = await prisma.mailEntry.findMany({
        where: await companyScopedWhere(user.id, {}),
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
        take,
        include: {
          company: { select: { name: true, shortName: true } },
          department: { select: { name: true } },
          concernedUser: { select: { name: true } },
        },
      });
      return rows.map((m) => [
        m.reference ?? "", MAIL_DIRECTION[m.direction]?.label ?? m.direction, m.title,
        m.sender ?? "", m.recipient ?? "", fr(m.sentAt), fr(m.receivedAt), fr(m.acknowledgedAt),
        m.department?.name ?? "", m.concernedUser?.name ?? "",
        m.company?.shortName ?? m.company?.name ?? "",
      ]);
    }
    case "recrutement": {
      const rows = await prisma.recruitmentRequest.findMany({
        where: await companyScopedWhere(user.id, { AND: [recruitmentScope(user)] }),
        orderBy: { createdAt: "desc" },
        take,
        include: {
          requester: { select: { name: true } },
          department: { select: { name: true } },
          _count: { select: { candidates: true } },
        },
      });
      return rows.map((r) => [
        r.reference, r.position,
        CONTRACT_LABEL[r.contractType as RecruitmentContract] ?? r.contractType,
        String(r.headcount), r.department?.name ?? "", r.requester?.name ?? "",
        STAGE_LABEL[r.stage as RecruitmentStage] ?? r.stage,
        String(r._count.candidates), fr(r.createdAt),
      ]);
    }
    case "employes": {
      const rows = await prisma.employee.findMany({
        where: await companyScopedWhere(user.id, {}),
        orderBy: { fullName: "asc" },
        take,
        include: { company: { select: { name: true, shortName: true } } },
      });
      // ⚠️ AUCUNE COLONNE DE RÉMUNÉRATION. Le brut, le net et le coût employeur sont
      // confidentiels ; un classeur circule, et il circule sans ses droits d'accès.
      return rows.map((e) => [
        e.fullName, e.position ?? "", e.department ?? "",
        e.company?.shortName ?? e.company?.name ?? "",
        e.contractType ?? "", fr(e.hireDate), e.isActive ? "Actif" : "Inactif",
        e.email ?? "", e.phone ?? "",
      ]);
    }
    case "comptes": {
      const rows = await prisma.user.findMany({ orderBy: { name: "asc" }, take });
      return rows.map((u) => [
        u.name, u.email ?? "", ROLE_LABELS[u.role] ?? u.role,
        u.secondaryRole ? ROLE_LABELS[u.secondaryRole] ?? u.secondaryRole : "",
        u.isActive ? "oui" : "non", fr(u.createdAt),
      ]);
    }
  }
}

/** Le classeur : en-tête figé, filtre automatique, largeurs tenables. */
async function buildWorkbook(spec: DatasetSpec, rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // L'en-tête est FIGÉ : passé la vingtième ligne, on ne sait plus quelle colonne on lit.
  const ws = wb.addWorksheet(spec.sheet, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = spec.columns.map((header, i) => ({ header, width: spec.widths[i] ?? 18 }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FF1F2937" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  for (const r of rows) ws.addRow(r);
  // Le filtre : c'est ce pour quoi on exporte — trier, isoler une entité, compter.
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Trouve (ou crée) un dossier nommé à la racine du Drive PERSONNEL de la personne. */
async function ensurePersonalFolder(ownerId: string, name: string): Promise<string> {
  const existing = await prisma.driveNode.findFirst({
    where: { type: "FOLDER", name, ownerId, spaceId: null, parentId: null, isTrashed: false },
    select: { id: true },
  });
  if (existing) return existing.id;
  const node = await prisma.driveNode.create({
    data: { name, type: "FOLDER", ownerId, createdById: ownerId },
    select: { id: true },
  });
  return node.id;
}

/**
 * DÉPOSE un fichier fabriqué par l'assistant dans le Drive personnel de la personne — la seule
 * porte de sortie des exports ET des rapports consolidés : un fichier généré vit là où les
 * autorisations existent déjà, jamais dans un lien qui traîne. Même nom = NOUVELLE VERSION.
 */
export async function depositBufferToDrive(
  ownerId: string,
  opts: { folder: string; filename: string; data: Buffer; mime: string; category?: string },
): Promise<{ nodeId: string }> {
  const folderId = await ensurePersonalFolder(ownerId, opts.folder);
  return deposerFichierDrive({ parentId: folderId, name: opts.filename, data: opts.data, mimeType: opts.mime, ownerId, category: opts.category ?? "Export" });
}

export interface ExportResult {
  ok: boolean;
  error?: string;
  /** Nom du fichier créé. */
  filename?: string;
  /** Nombre de lignes exportées — dire « 0 ligne » vaut mieux que livrer un classeur vide sans rien dire. */
  count?: number;
  /** Identifiant du nœud Drive, pour ouvrir directement le fichier. */
  nodeId?: string;
}

const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Construit le classeur et le dépose dans le Drive personnel du demandeur.
 *
 * Même nom le même jour = NOUVELLE VERSION, pas un doublon : on exporte souvent deux fois de
 * suite en corrigeant un filtre, et se retrouver avec « export (3).xlsx » ne sert personne.
 */
export async function exportDatasetToDrive(
  user: SessionUser,
  dataset: ExportDataset,
  opts: { limit?: number } = {},
): Promise<ExportResult> {
  const spec = DATASETS[dataset];
  if (!canExport(user, dataset)) {
    return { ok: false, error: `Vous n'avez pas accès à « ${spec.label} ».` };
  }

  /**
   * CHAQUE ÉTAPE NOMME SON ÉCHEC — le correctif d'un diagnostic faux vu en conversation réelle.
   *
   * L'export échouait et Adam répondait « échec lors de la lecture des données » alors que la
   * lecture avait RÉUSSI : c'est le DÉPÔT dans le Drive qui tombait (stockage objet en 402 —
   * facturation à régler, la même cause que les lectures de documents). Une erreur qui accuse
   * la mauvaise étape envoie chercher la panne au mauvais endroit ; celle-ci dit l'étape, la
   * cause, et ce qu'il reste à faire.
   */
  let rows: string[][];
  try {
    rows = await fetchRows(user, dataset, opts.limit ?? 2000);
  } catch (e) {
    return { ok: false, error: `La LECTURE des données « ${spec.label} » a échoué (${e instanceof Error ? e.message : "erreur"}). Aucun fichier créé.` };
  }
  const data = await buildWorkbook(spec, rows);

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const filename = `${dataset}-${stamp}.xlsx`;

  try {
    const { nodeId } = await depositBufferToDrive(user.id, { folder: EXPORT_FOLDER, filename, data, mime: MIME_XLSX });
    return { ok: true, filename, count: rows.length, nodeId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erreur";
    const facturation = /402/.test(msg)
      ? " Cause probable : le stockage objet répond 402 (facturation à régler côté hébergeur) — le même mur que la lecture des documents."
      : "";
    return {
      ok: false,
      error: `Les données ont été lues (${rows.length} ligne(s)) et le classeur construit, mais le DÉPÔT dans le Drive a échoué : ${msg}.${facturation} Aucun fichier n'est disponible.`,
    };
  }
}
