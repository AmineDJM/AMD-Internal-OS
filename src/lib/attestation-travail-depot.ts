import { readFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/prisma";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { marquerDemandeRhTraitee } from "@/lib/hr-demande-traitee";
import { saisieEffective, type ReferenceProchaine } from "@/lib/references/registre";
import { anneeDuRegistre, attribuerAuRegistre, etatDuRegistre, registreDe } from "@/lib/references/registre-serveur";
import { societeDeLOrdreDeMission } from "@/lib/ordre-mission-depot";
import { lireContratPourAttestation, type LectureContrat } from "@/lib/attestation-travail-luna";
import {
  champPersonnalise, champsAChercherDansLeContrat, civiliteDe, fusionnerPrefill, isoAlger, MOTIF_CIVILITE, MOTIF_LIEU_NAISSANCE,
  nomAttestation, refusAttestation, remplirAttestationDeTravail, societeImprimee,
  type ChampsAttestation, type Civilite, type ProvenanceChamp,
} from "@/lib/hr/attestation-travail/modele";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATTESTATION DE TRAVAIL GÉNÉRÉE ET REMISE AU SALARIÉ (Direction, 10/2026) — le pendant de `ordre-mission-depot.ts`,
 * HORS DU DOMAINE RH pour la même raison : il touche au stockage (drive-storage) et au fournisseur d'IA (par
 * `attestation-travail-luna.ts`) ; le domaine garde le modèle et ses règles (`hr/attestation-travail/`).
 *
 *   • PRÉPARER : le formulaire s'ouvre PRÉREMPLI — la fiche RH d'abord, puis ce que Luna (ou la lecture déterministe)
 *     a lu dans le CONTRAT DE TRAVAIL versé au dossier, puis l'identité légale de la société ; la liste des signataires
 *     possibles (salariés actifs, leur fonction ; comptes sans fiche) ; l'état du registre NNN/DG/AAAA. Rien n'est écrit.
 *   • GÉNÉRER : la référence est attribuée au registre commun (comme l'ordre de mission), le modèle est rempli, le PDF
 *     produit ; le PDF est la pièce qui RÉPOND à la demande (visible du salarié dans « Mon dossier RH »), le Word reste
 *     aux RH. RÉGÉNÉRER crée une NOUVELLE VERSION : la précédente quitte la demande et n'est plus montrée au salarié,
 *     mais reste au dossier RH — jamais écrasée. La référence d'une version précédente se garde si les RH ne la changent
 *     pas (c'est le même document, corrigé) ; chaque génération est auditée sur la demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const CHEMIN_MODELE = join(process.cwd(), "src", "lib", "hr", "attestation-travail", "modele-attestation-de-travail.docx");
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME_PDF = "application/pdf";
/** Le champ d'audit qui marque chaque génération — il compte les versions. */
export const CHAMP_AUDIT_ATTESTATION = "attestation_travail";
const DOC_TYPE = "ATTESTATION_TRAVAIL" as const;
const STATUTS_FERMES = ["CANCELLED", "REJECTED"];

export interface SignataireOption {
  /** `e:<employeeId>` ou `u:<userId>` (compte sans fiche RH). */
  id: string;
  nom: string;
  fonction: string;
  civilite: Civilite | "";
}

export interface PreparationAttestation {
  ok: true;
  champs: ChampsAttestation;
  provenance: Record<keyof ChampsAttestation, ProvenanceChamp>;
  signataires: SignataireOption[];
  /** Le registre de la société qui émet (le champ « Référence » le lit). */
  registre: ReferenceProchaine;
  /** La référence de la version précédente, gardée par défaut. */
  referenceExistante: string | null;
  /** Le numéro de la version que la génération produira. */
  version: number;
  contrat: { nom: string } | null;
  /** Ce que l'écran dit de la lecture du contrat. */
  note: string;
}

type Echec = { ok: false; error: string };

/** Les versions déjà générées pour cette demande (l'audit en garde une ligne par génération). */
async function versionsGenerees(requestId: string): Promise<number> {
  return prisma.auditLog.count({ where: { entityType: "HR_REQUEST", entityId: requestId, field: CHAMP_AUDIT_ATTESTATION } });
}

/** La référence que la demande porte déjà au registre (version précédente), s'il y en a une. */
async function referenceDejaAttribuee(requestId: string): Promise<string | null> {
  const r = await prisma.documentReference.findFirst({
    where: { entityType: "HR_REQUEST", entityId: requestId, docType: DOC_TYPE }, orderBy: { createdAt: "desc" }, select: { reference: true },
  });
  return r?.reference ?? null;
}

async function chargerDemande(requestId: string) {
  return prisma.hrDocumentRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true, type: true, status: true, employeeId: true,
      employee: {
        select: {
          fullName: true, position: true, birthDate: true, hireDate: true, contractStart: true, custom: true, userId: true, companyId: true,
          departmentRef: { select: { companyId: true } },
        },
      },
    },
  });
}

/** Les signataires possibles : les salariés actifs (leur fonction), puis les comptes actifs sans fiche RH. */
async function signatairesPossibles(): Promise<SignataireOption[]> {
  const [employes, comptes] = await Promise.all([
    prisma.employee.findMany({ where: { isActive: true }, select: { id: true, fullName: true, position: true, custom: true }, orderBy: { fullName: "asc" }, take: 500 }),
    prisma.user.findMany({ where: { isActive: true, employee: { is: null } }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
  ]);
  return [
    ...employes.map((e) => ({ id: `e:${e.id}`, nom: e.fullName, fonction: e.position ?? "", civilite: civiliteDe(champPersonnalise(e.custom, MOTIF_CIVILITE)) ?? "" as const })),
    ...comptes.filter((u) => u.name.trim()).map((u) => ({ id: `u:${u.id}`, nom: u.name, fonction: "", civilite: "" as const })),
  ];
}

/**
 * PRÉPARER le formulaire — lecture seule (hors le cache de lecture du contrat et le journal d'usage de l'IA).
 * `lireContrat` s'injecte : un banc ne lit pas de vrai contrat par un vrai modèle.
 */
export async function preparerAttestationTravail(
  acteurId: string, requestId: string,
  opts: { maintenant?: Date; lireContrat?: typeof lireContratPourAttestation } = {},
): Promise<PreparationAttestation | Echec> {
  const d = await chargerDemande(requestId);
  if (!d) return { ok: false, error: "Demande introuvable." };
  if (d.type !== "WORK_CERTIFICATE") return { ok: false, error: "Cette demande n'est pas une attestation de travail." };
  if (STATUTS_FERMES.includes(d.status)) return { ok: false, error: "Cette demande est close (annulée ou refusée)." };
  const e = d.employee;

  const companyId = e.companyId ?? e.departmentRef?.companyId ?? null;
  const societe = companyId
    ? await prisma.company.findUnique({ where: { id: companyId }, select: { name: true, legalIdentity: { select: { legalName: true, legalForm: true, managerName: true, managerTitle: true } }, documentProfile: { select: { signatoryName: true, signatoryTitle: true } } } })
    : null;
  const imprimee = societeImprimee({ legalName: societe?.legalIdentity?.legalName, legalForm: societe?.legalIdentity?.legalForm, name: societe?.name });

  const fiche: Partial<ChampsAttestation> = {
    civilite: civiliteDe(champPersonnalise(e.custom, MOTIF_CIVILITE)) ?? "",
    salarie: e.fullName,
    dateNaissance: isoAlger(e.birthDate),
    lieuNaissance: champPersonnalise(e.custom, MOTIF_LIEU_NAISSANCE) ?? "",
    poste: e.position ?? "",
    dateEmbauche: isoAlger(e.hireDate ?? e.contractStart),
  };

  // LE CONTRAT DE TRAVAIL VERSÉ AU DOSSIER — le plus récent. Il n'est lu que pour ce que la fiche n'a pas.
  const contratDoc = await prisma.employeeDocument.findFirst({
    where: { employeeId: d.employeeId, category: "CONTRACT" }, orderBy: { createdAt: "desc" }, select: { name: true, blobId: true },
  });
  const manquants = champsAChercherDansLeContrat(fiche);
  let lecture: LectureContrat = { lu: {}, parLuna: [], note: "" };
  if (!contratDoc) {
    lecture.note = manquants.length
      ? "Aucun contrat de travail n'est versé au dossier : complétez les champs vides."
      : "Préremplie depuis la fiche RH.";
  } else if (manquants.length === 0) {
    lecture.note = "Préremplie depuis la fiche RH — le contrat n'a pas eu besoin d'être lu.";
  } else {
    const octets = await getBlob(contratDoc.blobId).catch(() => null);
    lecture = octets
      ? await (opts.lireContrat ?? lireContratPourAttestation)({ octets, nomFichier: contratDoc.name, manquants, userId: acteurId })
          .catch(() => ({ lu: {}, parLuna: [], note: "Le contrat n'a pas pu être lu : complétez les champs vides." }))
      : { lu: {}, parLuna: [], note: "Le fichier du contrat est introuvable : complétez les champs vides." };
  }

  const [referenceExistante, registre, signataires, versions] = await Promise.all([
    referenceDejaAttribuee(requestId),
    etatDuRegistre(companyId).catch((): ReferenceProchaine => ({ ok: false, error: "Le registre n'a pas pu être lu." })),
    signatairesPossibles(),
    versionsGenerees(requestId),
  ]);

  // LE SIGNATAIRE PROPOSÉ : celui des documents de la société (profil documentaire), sinon son représentant légal — un
  // COUPLE nom + fonction, jamais le nom de l'un avec la fonction de l'autre. Les RH le changent en fin de formulaire.
  const profil = societe?.documentProfile;
  const signataireSociete = profil?.signatoryName?.trim()
    ? { signataire: profil.signatoryName, signataireFonction: profil.signatoryTitle ?? "" }
    : { signataire: societe?.legalIdentity?.managerName ?? "", signataireFonction: societe?.legalIdentity?.managerTitle ?? "" };
  const { champs, provenance } = fusionnerPrefill({
    fiche,
    contrat: lecture.lu,
    parLuna: lecture.parLuna,
    societe: { societe: imprimee.societe, societeSignature: imprimee.societeSignature, ...signataireSociete },
    defauts: { reference: referenceExistante ?? "", lieuSignature: "Alger", dateSignature: isoAlger(opts.maintenant ?? new Date()) },
  });
  // Le signataire proposé est dans la liste des personnes : sa civilité, et sa fonction (le poste de sa fiche) si la
  // société n'en dit pas.
  const connu = signataires.find((s) => s.nom.trim().toLowerCase() === champs.signataire.trim().toLowerCase());
  if (connu?.civilite && !champs.signataireCivilite) champs.signataireCivilite = connu.civilite;
  if (connu?.fonction && !champs.signataireFonction) { champs.signataireFonction = connu.fonction; provenance.signataireFonction = "fiche"; }

  return {
    ok: true, champs, provenance, signataires, registre, referenceExistante, version: versions + 1,
    contrat: contratDoc ? { nom: contratDoc.name } : null, note: lecture.note,
  };
}

/**
 * GÉNÉRER ET REMETTRE — la référence au registre, le Word, le PDF, la pièce rattachée à la demande (nouvelle version si
 * une précédente existe), la demande « prête », le salarié prévenu, l'audit.
 */
export async function genererEtRemettreAttestation(
  acteurId: string, requestId: string, saisis: ChampsAttestation,
  /** Le numéro que le formulaire avait prérempli : laissé tel quel, le registre attribue le prochain libre. */
  opts: { referenceSuggeree?: string | null } = {},
): Promise<{ ok: true; message: string; employeeId: string; version: number; reference: string } | Echec> {
  const d = await chargerDemande(requestId);
  if (!d) return { ok: false, error: "Demande introuvable." };
  if (d.type !== "WORK_CERTIFICATE") return { ok: false, error: "Cette demande n'est pas une attestation de travail." };
  if (STATUTS_FERMES.includes(d.status)) return { ok: false, error: "Cette demande est close (annulée ou refusée)." };
  const refus = refusAttestation(saisis);
  if (refus) return { ok: false, error: refus };

  // LE REGISTRE COMMUN NNN/DG/AAAA de la société qui émet (celle que l'attestation imprime, sinon l'employeur). La
  // référence d'une version précédente se garde telle quelle ; une autre saisie est vérifiée et attribuée.
  const societeId = await societeDeLOrdreDeMission(requestId, saisis.societeSignature || saisis.societe);
  const annee = anneeDuRegistre();
  const registre = await registreDe(societeId, annee);
  const auRegistre = registre.actif && societeId !== null;
  let champs: ChampsAttestation = { ...saisis, reference: saisis.reference.trim() };
  if (auRegistre) {
    const existante = await referenceDejaAttribuee(requestId);
    if (!(existante && champs.reference === existante)) {
      const r = await attribuerAuRegistre({
        companyId: societeId, annee, docType: DOC_TYPE, entityType: "HR_REQUEST", entityId: requestId, createdById: acteurId,
        saisie: saisieEffective(saisis.reference, opts.referenceSuggeree),
      });
      if (!r.ok) return { ok: false, error: r.motif };
      champs = { ...champs, reference: r.reference };
    }
  }

  const docx = await remplirAttestationDeTravail(await readFile(CHEMIN_MODELE), champs);
  const version = (await versionsGenerees(requestId)) + 1;
  const nom = nomAttestation(champs.reference, champs.salarie, version);
  // LE PDF EST LA PIÈCE REMISE (comme l'ordre de mission) ; sans PDF, c'est le Word — et la phrase le dit.
  const pdf = await docxToPdf(docx).catch(() => ({ ok: false as const, error: "conversion impossible" }));
  const w = await putBlob(docx);
  const p = pdf.ok ? await putBlob(pdf.pdf) : null;

  let remplacees = 0;
  try {
    await prisma.$transaction(async (tx) => {
      // UNE NOUVELLE VERSION, JAMAIS UN ÉCRASEMENT : la pièce précédente quitte la demande et n'est plus montrée au
      // salarié — elle reste au dossier RH, avec son nom (et son numéro de version).
      remplacees = (await tx.employeeDocument.updateMany({ where: { requestId }, data: { requestId: null, visibleToEmployee: false } })).count;
      await tx.employeeDocument.create({
        data: {
          employeeId: d.employeeId, category: "WORK_CERTIFICATE", name: `${nom}.docx`, blobId: w.blobId, mime: MIME_DOCX, size: w.size,
          visibleToEmployee: !p, uploadedById: acteurId, requestId: p ? undefined : requestId,
        },
      });
      if (p) {
        await tx.employeeDocument.create({
          data: {
            employeeId: d.employeeId, category: "WORK_CERTIFICATE", name: `${nom}.pdf`, blobId: p.blobId, mime: MIME_PDF, size: p.size,
            visibleToEmployee: true, uploadedById: acteurId, requestId,
          },
        });
      }
      await tx.hrDocumentRequest.update({ where: { id: requestId }, data: { status: "READY", handledById: acteurId } });
    });
  } catch {
    return { ok: false, error: "L'attestation n'a pas pu être rattachée à la demande (une autre génération était peut-être en cours) : réessayez." };
  }
  await marquerDemandeRhTraitee(requestId); // brique KPI « demandes traitées »

  const salarie = d.employee.fullName;
  if (d.employee.userId) {
    await notifyUser({
      userId: d.employee.userId, type: "GENERIC",
      title: version > 1 ? "Nouvelle version de votre attestation de travail" : "Votre attestation de travail est prête",
      body: champs.reference ? `Réf. ${champs.reference}` : "Attestation de travail",
      link: `/mon-dossier#demande-rh-${requestId}`,
    }).catch(() => undefined);
  }
  await recordAudit({
    actorId: acteurId, action: "CREATE", module: "RH", entityType: "HR_REQUEST", entityId: requestId,
    field: CHAMP_AUDIT_ATTESTATION, newValue: champs.reference || null,
    summary: `Attestation de travail${champs.reference ? ` ${champs.reference}` : ""} générée pour ${salarie} (version ${version}`
      + `${remplacees ? `, remplace la précédente` : ""}) — signataire : ${champs.signataire}, ${champs.signataireFonction}`,
  });

  const qui = `${salarie}${version > 1 ? ` (version ${version} — la précédente reste au dossier RH, retirée du salarié)` : ""}`;
  return {
    ok: true, employeeId: d.employeeId, version, reference: champs.reference,
    message: p
      ? `Attestation de travail${champs.reference ? ` ${champs.reference}` : ""} générée et remise à ${qui} en PDF (le Word reste aux RH) — il la retrouve dans « Mon dossier RH ».`
      : `Attestation de travail${champs.reference ? ` ${champs.reference}` : ""} générée et remise à ${qui} en Word — le PDF n'a pas pu être produit (${pdf.ok ? "" : pdf.error}).`,
  };
}
