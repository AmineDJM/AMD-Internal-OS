import { readFile } from "fs/promises";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { sansBloquer } from "@/lib/journal";
import { anneeDuRegistre, attribuerAuRegistre, registreDe } from "@/lib/references/registre-serveur";
import { inscrireDocumentRh } from "@/modules/bibliotheque/api-inscription";
import {
  champPersonnalise, civiliteDe, isoAlger, MOTIF_CIVILITE, MOTIF_LIEU_NAISSANCE, societeImprimee,
} from "../domaine/attestation-travail/regles";
import { corpsCertificatParDefaut, nomCertificat, refusCertificat, type ChampsCertificat } from "../domaine/depart/certificat";
import { SOURCE_CERTIFICAT } from "../domaine/depart/regles";
import { remplirCertificatDeTravail } from "./certificat-travail/modele";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CERTIFICAT DE TRAVAIL — PRÉREMPLI, RELU, ÉMIS (lot rhdepart).
 *
 * Prérempli à l'accord final depuis la fiche (civilité, naissance, poste, embauche), la fin de contrat (date de fin) et
 * l'identité légale de la société (dénomination, signataire des documents) ; les RH relisent et réécrivent ce qu'ils
 * veulent — champs ET texte. ÉMETTRE : la référence au registre NNN/DG/AAAA de la société, le Word et le PDF sur le
 * papier de la société, rangés au DOSSIER RH du salarié (`EmployeeDocument`, jamais copiés au Drive — seuls les
 * contrats le sont), le PDF visible du salarié dans « Mon dossier RH ». Réémettre crée une nouvelle version ; la
 * précédente reste au dossier, retirée du salarié.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le papier de l'attestation de travail : le certificat en dérive (`certificat-travail/modele.ts`). */
const CHEMIN_MODELE = join(process.cwd(), "src", "modules", "rh", "infra", "attestation-travail", "modele-attestation-de-travail.docx");
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME_PDF = "application/pdf";
const DOC_TYPE = "CERTIFICAT_TRAVAIL" as const;
/** Le champ d'audit qui marque chaque émission — il compte les versions. */
export const CHAMP_AUDIT_CERTIFICAT = "certificat_travail";
type Echec = { ok: false; error: string };

/** Les champs préremplis — `null` si la fin de contrat n'existe pas. */
export async function champsCertificatPreremplis(departId: string, maintenant = new Date()): Promise<ChampsCertificat | null> {
  const d = await prisma.departSalarie.findUnique({
    where: { id: departId },
    select: {
      dateFin: true,
      employee: { select: { fullName: true, position: true, birthDate: true, hireDate: true, contractStart: true, custom: true, companyId: true, departmentRef: { select: { companyId: true } } } },
    },
  });
  if (!d) return null;
  const e = d.employee;
  const companyId = e.companyId ?? e.departmentRef?.companyId ?? null;
  const societe = companyId
    ? await prisma.company.findUnique({ where: { id: companyId }, select: { name: true, legalIdentity: { select: { legalName: true, legalForm: true, managerName: true, managerTitle: true } }, documentProfile: { select: { signatoryName: true, signatoryTitle: true } } } })
    : null;
  const imprimee = societeImprimee({ legalName: societe?.legalIdentity?.legalName, legalForm: societe?.legalIdentity?.legalForm, name: societe?.name });
  // LE SIGNATAIRE : celui des documents de la société, sinon son représentant légal — un couple nom + fonction.
  const profil = societe?.documentProfile;
  const signataire = profil?.signatoryName?.trim()
    ? { signataire: profil.signatoryName.trim(), signataireFonction: profil.signatoryTitle?.trim() ?? "" }
    : { signataire: societe?.legalIdentity?.managerName?.trim() ?? "", signataireFonction: societe?.legalIdentity?.managerTitle?.trim() ?? "" };
  const sansCorps: Omit<ChampsCertificat, "corps"> = {
    reference: "",
    civilite: civiliteDe(champPersonnalise(e.custom, MOTIF_CIVILITE)) ?? "",
    salarie: e.fullName,
    dateNaissance: isoAlger(e.birthDate),
    lieuNaissance: champPersonnalise(e.custom, MOTIF_LIEU_NAISSANCE) ?? "",
    societe: imprimee.societe,
    societeSignature: imprimee.societeSignature,
    poste: e.position ?? "",
    dateEmbauche: isoAlger(e.hireDate ?? e.contractStart),
    signataireCivilite: "",
    ...signataire,
    lieuSignature: "Alger",
    dateSignature: isoAlger(maintenant),
    dateFin: d.dateFin.toISOString().slice(0, 10),
  };
  return { ...sansCorps, corps: corpsCertificatParDefaut(sansCorps) };
}

async function chargerPourCertificat(departId: string) {
  return prisma.departSalarie.findUnique({
    where: { id: departId },
    select: {
      id: true, statut: true, employeeId: true, certificatReference: true,
      employee: { select: { fullName: true, userId: true, companyId: true, departmentRef: { select: { companyId: true } } } },
    },
  });
}

/** ENREGISTRER le brouillon (sans émettre) : les RH reviennent plus tard, rien n'est perdu. */
export async function enregistrerCertificat(acteurId: string, departId: string, champs: ChampsCertificat): Promise<{ ok: true; employeeId: string } | Echec> {
  const d = await chargerPourCertificat(departId);
  if (!d || d.statut !== "VALIDE") return { ok: false, error: "Le certificat se prépare une fois la fin de contrat validée." };
  await prisma.departSalarie.update({ where: { id: departId }, data: { certificat: champs as unknown as Prisma.InputJsonValue } });
  await recordAudit({ actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId, field: "depart_certificat", summary: `Certificat de travail de ${d.employee.fullName} — brouillon modifié` });
  return { ok: true, employeeId: d.employeeId };
}

/** ÉMETTRE le certificat : référence, Word + PDF au dossier RH, salarié prévenu, ligne de la liste cochée. */
export async function emettreCertificat(acteurId: string, departId: string, saisis: ChampsCertificat): Promise<{ ok: true; message: string; employeeId: string; reference: string } | Echec> {
  const d = await chargerPourCertificat(departId);
  if (!d || d.statut !== "VALIDE") return { ok: false, error: "Le certificat s'émet une fois la fin de contrat validée." };
  const refus = refusCertificat(saisis);
  if (refus) return { ok: false, error: refus };

  // LE REGISTRE COMMUN de la société employeuse. La référence d'une émission précédente se garde (même document, corrigé).
  const societeId = d.employee.companyId ?? d.employee.departmentRef?.companyId ?? null;
  const annee = anneeDuRegistre();
  let champs: ChampsCertificat = { ...saisis, reference: saisis.reference.trim() };
  if (societeId && (await registreDe(societeId, annee)).actif && !(d.certificatReference && champs.reference === d.certificatReference)) {
    const r = await attribuerAuRegistre({ companyId: societeId, annee, docType: DOC_TYPE, entityType: "DEPART_SALARIE", entityId: departId, createdById: acteurId, saisie: champs.reference || null });
    if (!r.ok) return { ok: false, error: r.motif };
    champs = { ...champs, reference: r.reference };
  }

  const docx = await remplirCertificatDeTravail(await readFile(CHEMIN_MODELE), champs);
  // Les versions se comptent sur la fiche (le journal n'a pas de type « fin de contrat ») : un salarié parti deux fois
  // a des certificats numérotés à la suite — la référence au registre, elle, distingue chaque document.
  const version = (await prisma.auditLog.count({ where: { entityType: "EMPLOYEE", entityId: d.employeeId, field: CHAMP_AUDIT_CERTIFICAT } })) + 1;
  const nom = nomCertificat(champs.reference, champs.salarie, version);
  const pdf = await docxToPdf(docx).catch(sansBloquer("depart-certificat.emettreCertificat.docxToPdf", { ok: false as const, error: "conversion impossible" }));
  const w = await putBlob(docx);
  const p = pdf.ok ? await putBlob(pdf.pdf) : null;

  const remises: { id: string; nom: string; mime: string; ecrit: { blobId: string; sha256: string; size: number } }[] = [];
  await prisma.$transaction(async (tx) => {
    // UNE NOUVELLE VERSION, JAMAIS UN ÉCRASEMENT : la précédente reste au dossier RH, retirée du salarié.
    await tx.employeeDocument.updateMany({ where: { employeeId: d.employeeId, category: "WORK_CERTIFICATE", name: { startsWith: "Certificat de travail" } }, data: { visibleToEmployee: false } });
    const word = await tx.employeeDocument.create({
      data: { employeeId: d.employeeId, category: "WORK_CERTIFICATE", name: `${nom}.docx`, blobId: w.blobId, mime: MIME_DOCX, size: w.size, visibleToEmployee: !p, uploadedById: acteurId },
      select: { id: true },
    });
    remises.push({ id: word.id, nom: `${nom}.docx`, mime: MIME_DOCX, ecrit: w });
    if (p) {
      const remis = await tx.employeeDocument.create({
        data: { employeeId: d.employeeId, category: "WORK_CERTIFICATE", name: `${nom}.pdf`, blobId: p.blobId, mime: MIME_PDF, size: p.size, visibleToEmployee: true, uploadedById: acteurId },
        select: { id: true },
      });
      remises.push({ id: remis.id, nom: `${nom}.pdf`, mime: MIME_PDF, ecrit: p });
    }
    await tx.departSalarie.update({ where: { id: departId }, data: { certificat: champs as unknown as Prisma.InputJsonValue, certificatEmisLe: new Date(), certificatReference: champs.reference || null } });
    await tx.departSalarieTache.updateMany({ where: { departId, source: SOURCE_CERTIFICAT, faitLe: null }, data: { faitLe: new Date(), faitParId: acteurId } });
  });
  // Les pièces entrent à la bibliothèque, CONFIDENTIELLES (pièces RH), une fois la transaction acquise.
  for (const r of remises) {
    await inscrireDocumentRh({ id: r.id, blobId: r.ecrit.blobId, sha256: r.ecrit.sha256, nom: r.nom, mime: r.mime, taille: r.ecrit.size, deposeParId: acteurId });
  }
  if (d.employee.userId) {
    await notifyUser({
      userId: d.employee.userId, type: "GENERIC",
      title: version > 1 ? "Nouvelle version de votre certificat de travail" : "Votre certificat de travail est prêt",
      body: champs.reference ? `Réf. ${champs.reference} — dans « Mon dossier RH ».` : "Dans « Mon dossier RH ».", link: "/mon-dossier",
    }).catch(sansBloquer("depart-certificat.emettreCertificat.notifyUser"));
  }
  await recordAudit({
    actorId: acteurId, action: "CREATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: CHAMP_AUDIT_CERTIFICAT, newValue: champs.reference || null,
    summary: `Certificat de travail${champs.reference ? ` ${champs.reference}` : ""} émis pour ${d.employee.fullName} (version ${version}) — signataire : ${champs.signataire}`,
  });
  return {
    ok: true, employeeId: d.employeeId, reference: champs.reference,
    message: p
      ? `Certificat de travail${champs.reference ? ` ${champs.reference}` : ""} émis (version ${version}) : le PDF est remis au salarié, le Word reste au dossier RH.`
      : `Certificat de travail${champs.reference ? ` ${champs.reference}` : ""} émis en Word (version ${version}) — le PDF n'a pas pu être produit.`,
  };
}
