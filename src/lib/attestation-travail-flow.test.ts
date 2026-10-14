import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { genererAttestationDeTravail, preparerAttestationDeTravail } from "@/lib/actions/hr-document-actions";
import { isoAlger } from "@/lib/hr/attestation-travail/regles";
import { CHAMP_AUDIT_ATTESTATION } from "@/lib/attestation-travail-depot";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__attesttrav__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/** Un contrat de travail en Word, avec son texte — ce que les RH versent au dossier. */
async function contratDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const lignes = [
    "CONTRAT DE TRAVAIL À DURÉE INDÉTERMINÉE",
    `Entre les soussignés : la SARL ${TAG} PHARMA, représentée par Monsieur SAIDI Karim en qualité de Gérant, d'une part,`,
    `Et Madame KACI Lina ${TAG}, née le 05/03/1990 à Tizi Ouzou demeurant à Alger, d'autre part.`,
    "Article 1 : Objet. Le présent contrat définit les conditions de l'engagement du salarié au sein de la société.",
    "Article 2 : Madame KACI Lina est recrutée en qualité de Déléguée médicale.",
    "Article 3 : Le présent contrat prend effet à compter du 1er juillet 2025, pour une durée indéterminée.",
    "Article 4 : La période d'essai est fixée à six mois, renouvelable une fois, conformément à la convention collective.",
  ];
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
    lignes.map((l) => `<w:p><w:r><w:t xml:space="preserve">${l.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`).join("")
  }</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATTESTATION DE TRAVAIL — par les VRAIS points d'entrée, IA COUPÉE (le chemin déterministe, celui qui ne doit
 * jamais bloquer).
 *
 * Une demande d'attestation de travail d'une salariée dont la fiche RH est presque vide ; son contrat de travail est
 * versé au dossier. Les RH ouvrent « Générer l'attestation » : le formulaire est prérempli — la naissance, le poste et la
 * date d'embauche LUS DANS LE CONTRAT (sans Luna : l'interrupteur est coupé), la société et le signataire depuis
 * l'identité légale ; ils génèrent : la référence est attribuée au registre NNN/DG/AAAA, le PDF est remis à la salariée,
 * le Word reste aux RH, la demande passe « prête », la génération est auditée. Régénérer crée une VERSION 2 : la
 * première quitte la demande et n'est plus montrée à la salariée, sans être supprimée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Attestation de travail — préremplie par le contrat, générée, versionnée (IA coupée)", () => {
  let rhId = "", delegueId = "", companyId = "", employeeId = "", signataireEmpId = "", requestId = "", autreRequestId = "";

  beforeAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => true); // L'IA est COUPÉE : rien ne doit partir chez un fournisseur.
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    rhId = (await mk("rh", "DIRECTION")).id;
    delegueId = (await mk("delegue", "MEDICAL_DELEGATE")).id;
    const societe = await prisma.company.create({
      data: {
        name: `${TAG} Pharma`,
        legalIdentity: { create: { legalName: `${TAG} PHARMA`, legalForm: "SARL", managerName: "SAIDI Karim", managerTitle: "Gérant" } },
        documentProfile: { create: { settings: { registreDG: true } } },
      },
    });
    companyId = societe.id;
    const emp = await prisma.employee.create({ data: { fullName: `KACI Lina ${TAG}`, companyId } });
    employeeId = emp.id;
    signataireEmpId = (await prisma.employee.create({ data: { fullName: `BELHADJ Sara ${TAG}`, position: "Directrice des Ressources Humaines", companyId } })).id;
    const blob = await putBlob(await contratDocx());
    await prisma.employeeDocument.create({
      data: { employeeId, category: "CONTRACT", name: "Contrat de travail.docx", blobId: blob.blobId, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: blob.size, visibleToEmployee: false },
    });
    requestId = (await prisma.hrDocumentRequest.create({ data: { employeeId, type: "WORK_CERTIFICATE", details: "Pour mon dossier de visa" } })).id;
    autreRequestId = (await prisma.hrDocumentRequest.create({ data: { employeeId, type: "CNAS_CERTIFICATE" } })).id;
  });

  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    const reqs = [requestId, autreRequestId].filter(Boolean);
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityType: "HR_REQUEST", entityId: { in: reqs } }, { entityType: "EMPLOYEE", entityId: { in: [employeeId, signataireEmpId] } }] } }).catch(() => {});
    await prisma.documentReference.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.employeeDocument.deleteMany({ where: { employeeId } }).catch(() => {});
    await prisma.hrDocumentRequest.deleteMany({ where: { id: { in: reqs } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, signataireEmpId] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    await prisma.notification.deleteMany({ where: { userId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la porte : sans le droit de traiter les demandes RH, ni préparation ni génération ; une autre demande n'est pas une attestation", async () => {
    ACTOR = await actorFor(delegueId, "MEDICAL_DELEGATE");
    expect(await preparerAttestationDeTravail(form({ requestId }))).toEqual({ ok: false, error: "Non autorisé." });
    expect((await genererAttestationDeTravail(form({ requestId }))).error).toBe("Non autorisé.");
    ACTOR = await actorFor(rhId, "DIRECTION");
    expect(await preparerAttestationDeTravail(form({ requestId: autreRequestId }))).toMatchObject({ ok: false, error: "Cette demande n'est pas une attestation de travail." });
  });

  let prep: Awaited<ReturnType<typeof preparerAttestationDeTravail>>;
  it("le formulaire s'ouvre PRÉREMPLI : le contrat comble la fiche (sans Luna), la société et le signataire viennent de l'identité légale", async () => {
    ACTOR = await actorFor(rhId, "DIRECTION");
    prep = await preparerAttestationDeTravail(form({ requestId }));
    expect(prep.ok, prep.ok ? "" : prep.error).toBe(true);
    if (!prep.ok) return;
    const { champs, provenance } = prep;
    expect(champs.salarie).toBe(`KACI Lina ${TAG}`);
    expect(provenance.salarie).toBe("fiche");
    // LU DANS LE CONTRAT — par la lecture déterministe : l'interrupteur est coupé, Luna n'a rien lu.
    expect(champs).toMatchObject({ civilite: "Madame", dateNaissance: "1990-03-05", lieuNaissance: "Tizi Ouzou", poste: "Déléguée médicale", dateEmbauche: "2025-07-01" });
    for (const k of ["civilite", "dateNaissance", "lieuNaissance", "poste", "dateEmbauche"] as const) expect(provenance[k], k).toBe("contrat");
    expect(prep.note).toMatch(/sans Luna/);
    expect(prep.contrat).toEqual({ nom: "Contrat de travail.docx" });
    // La société (forme + dénomination), le signataire de son identité légale, « Fait à Alger » aujourd'hui (Alger).
    expect(champs.societe).toBe(`SARL ${TAG} PHARMA`);
    expect(champs.societeSignature).toBe(`${TAG} PHARMA`);
    expect(champs).toMatchObject({ signataire: "SAIDI Karim", signataireFonction: "Gérant", lieuSignature: "Alger", dateSignature: isoAlger(new Date()) });
    expect(provenance.signataire).toBe("societe");
    // Les signataires possibles : les salariés actifs, avec leur fonction.
    expect(prep.signataires).toContainEqual({ id: `e:${signataireEmpId}`, nom: `BELHADJ Sara ${TAG}`, fonction: "Directrice des Ressources Humaines", civilite: "" });
    // Le registre de la société, et sa prochaine référence (prévue, pas réservée).
    expect(prep.registre).toMatchObject({ ok: true, actif: true, societeId: companyId });
    expect(prep.referenceExistante).toBeNull();
    expect(prep.version).toBe(1);
    // Préparer n'écrit rien : la demande est toujours en attente, aucune pièce.
    expect((await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("PENDING");
  });

  const saisie = (extra: Record<string, string> = {}) => {
    if (!prep.ok) throw new Error("préparation absente");
    const c = prep.champs;
    return form({
      requestId, reference: prep.registre.ok ? (prep.registre.prochaine ?? "") : "", referenceSuggeree: prep.registre.ok ? (prep.registre.prochaine ?? "") : "",
      civilite: c.civilite, salarie: c.salarie, dateNaissance: c.dateNaissance, lieuNaissance: c.lieuNaissance, poste: c.poste,
      dateEmbauche: c.dateEmbauche, societe: c.societe, societeSignature: c.societeSignature,
      // LE SIGNATAIRE CHOISI DANS LA LISTE, sa fonction reprise et modifiable.
      signataireCivilite: "Madame", signataire: `BELHADJ Sara ${TAG}`, signataireFonction: "Directrice des Ressources Humaines",
      lieuSignature: c.lieuSignature, dateSignature: "2026-10-14", ...extra,
    });
  };

  it("ce qui manque se dit, et rien n'est produit", async () => {
    ACTOR = await actorFor(rhId, "DIRECTION");
    const r = await genererAttestationDeTravail(saisie({ signataire: "", dateEmbauche: "" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Pour générer l'attestation, indiquez la date d'embauche, le signataire.");
    expect(await prisma.employeeDocument.count({ where: { employeeId, category: "WORK_CERTIFICATE" } })).toBe(0);
  });

  let reference = "";
  it("GÉNÉRER : la référence au registre, le PDF remis à la salariée, le Word aux RH, la demande prête, l'audit", async () => {
    ACTOR = await actorFor(rhId, "DIRECTION");
    const r = await genererAttestationDeTravail(saisie());
    expect(r.ok, r.error).toBe(true);
    const ref = await prisma.documentReference.findFirstOrThrow({ where: { entityType: "HR_REQUEST", entityId: requestId } });
    expect(ref.docType).toBe("ATTESTATION_TRAVAIL");
    expect(ref.reference).toMatch(/^\d{3,}\/DG\/\d{4}$/);
    reference = ref.reference;
    expect(r.message).toContain(reference);

    const demande = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: requestId }, include: { fulfilment: true } });
    expect(demande.status).toBe("READY");
    expect(demande.handledById).toBe(rhId);
    expect(demande.fulfilment?.category).toBe("WORK_CERTIFICATE");
    expect(demande.fulfilment?.visibleToEmployee).toBe(true);
    const pieces = await prisma.employeeDocument.findMany({ where: { employeeId, category: "WORK_CERTIFICATE" }, orderBy: { createdAt: "asc" } });
    const word = pieces.find((p) => p.name.endsWith(".docx"))!;
    expect(word.name).toBe(`Attestation de travail ${reference.replace(/\//g, "-")} — KACI Lina ${TAG}.docx`);
    if (demande.fulfilment?.mime === "application/pdf") {
      expect(word.visibleToEmployee, "le Word reste aux RH quand le PDF est remis").toBe(false);
      expect(pieces).toHaveLength(2);
    }
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "HR_REQUEST", entityId: requestId, field: CHAMP_AUDIT_ATTESTATION } });
    expect(audit.newValue).toBe(reference);
    expect(audit.summary).toMatch(/version 1/);
    expect(audit.summary).toContain(`signataire : BELHADJ Sara ${TAG}, Directrice des Ressources Humaines`);
  });

  it("RÉGÉNÉRER : une version 2, la même référence gardée, la version 1 retirée de la salariée mais conservée", async () => {
    ACTOR = await actorFor(rhId, "DIRECTION");
    const avant = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: requestId }, include: { fulfilment: true } });
    const p2 = await preparerAttestationDeTravail(form({ requestId }));
    expect(p2.ok && p2.referenceExistante).toBe(reference);
    expect(p2.ok && p2.version).toBe(2);

    const r = await genererAttestationDeTravail(saisie({ reference, poste: "Déléguée médicale senior" }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/version 2/);
    // La même référence — aucun nouveau numéro consommé au registre.
    expect(await prisma.documentReference.count({ where: { entityType: "HR_REQUEST", entityId: requestId } })).toBe(1);

    const apres = await prisma.hrDocumentRequest.findUniqueOrThrow({ where: { id: requestId }, include: { fulfilment: true } });
    expect(apres.fulfilment!.id).not.toBe(avant.fulfilment!.id);
    expect(apres.fulfilment!.name).toMatch(/\(v2\)\.(pdf|docx)$/);
    const ancienne = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: avant.fulfilment!.id } });
    expect(ancienne.requestId).toBeNull();
    expect(ancienne.visibleToEmployee).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityType: "HR_REQUEST", entityId: requestId, field: CHAMP_AUDIT_ATTESTATION } })).toBe(2);
  });
});
