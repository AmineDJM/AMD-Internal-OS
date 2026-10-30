import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { UserRole } from "@prisma/client";
import { putBlob } from "@/lib/drive-storage";
import { docxDeParagraphes } from "@/lib/artifact/adapters/fixtures";
import { adaptateurPour } from "@/lib/artifact/adapters/registry";
import { getBlob } from "@/lib/drive-storage";
import { oublierSession } from "@/lib/artifact/runtime/engine";
import { documentSensible, ongletsAtelier, ouvrirDansAtelier } from "@/platform/ia/artifact/atelier/service";
import { outilsAtelier } from "./infra/atelier/outils";
import { choisirVoie, demanderConversion, libreOfficeLocal } from "@/platform/ia/artifact/atelier/conversions";
import { carteEnregistrement, ENREGISTRER_ATELIER } from "./infra/operations/atelier-enregistrer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATELIER SUR UNE VRAIE BASE (J3, décision 0017) — les droits du Drive, de bout en bout, par les OUTILS que
 * l'Assistant IA appelle : un collaborateur sans droit ne peut ni ouvrir ni modifier ; un lecteur ouvre en
 * lecture seule et ne modifie pas ; la propriétaire modifie EN PLACE et enregistre une NOUVELLE version
 * (la v1 reste intacte), inscrite à la Bibliothèque ; un document d'un espace partagé passe par la carte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__atelier__${Date.now()}`;
const users: CurrentUser[] = [];
let proprietaire: CurrentUser;
let etranger: CurrentUser;
let lecteur: CurrentUser;
let nodeId = "";
let blobV1 = "";

async function personne(nom: string, role: UserRole): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${nom}`, email: `${TAG}.${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  const c: CurrentUser = { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
  users.push(c);
  return c;
}

const outil = (u: CurrentUser, nom: string) => {
  const o = outilsAtelier(u).find((x) => x.def.name === nom);
  if (!o) throw new Error(nom);
  return (e: Record<string, unknown>) => o.run(e, u).then((s) => JSON.parse(s) as Record<string, unknown>);
};

suite("l'Atelier — droits, modification en place, nouvelle version (vraie base)", () => {
  beforeAll(async () => {
    proprietaire = await personne("rh", "SALES_USER");
    etranger = await personne("etranger", "SALES_USER");
    lecteur = await personne("lecteur", "SALES_USER");
    const octets = await docxDeParagraphes(["Contrat de travail", "La période d'essai est de 3 mois.", "Le salaire est versé chaque mois."], { premierEstTitre: true });
    const b = await putBlob(octets);
    blobV1 = b.blobId;
    const n = await prisma.driveNode.create({
      data: {
        name: `${TAG} Contrat Benali.docx`, type: "FILE", ownerId: proprietaire.id, createdById: proprietaire.id,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: b.size,
        versions: { create: { blobId: b.blobId, version: 1, size: b.size, createdById: proprietaire.id } },
      },
    });
    nodeId = n.id;
    await prisma.driveShare.create({ data: { nodeId, userId: lecteur.id, access: "VIEW" } });
  });

  afterAll(async () => {
    if (!dbOk) return;
    await prisma.artifactSession.deleteMany({ where: { nodeId } });
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    await prisma.atelierConversion.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: users.map((u) => u.id) } } });
    await prisma.driveSpace.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  });

  it("un collaborateur SANS droit ne peut ni ouvrir ni modifier — et rien n'est créé à son nom", async () => {
    expect((await ouvrirDansAtelier(etranger, { nodeId })).ok).toBe(false);
    expect(await outil(etranger, "ouvrir_dans_l_atelier")({ document: nodeId })).toMatchObject({ statut: "REFUS" });
    expect(await outil(etranger, "modifier_document")({ document: nodeId, gestes: [{ action: "remplacer_texte", chercher: "3 mois", remplacer: "6 mois" }] }))
      .toMatchObject({ statut: "REFUS" });
    expect(await ongletsAtelier(etranger.id)).toEqual([]);
    expect(await prisma.fileVersion.count({ where: { nodeId } })).toBe(1);
  });

  it("un LECTEUR ouvre en lecture seule ; sa demande de modification est refusée AVANT d'être appliquée", async () => {
    const o = await outil(lecteur, "ouvrir_dans_l_atelier")({ document: nodeId });
    expect(o).toMatchObject({ statut: "OUVERT", modifiable: false });
    expect(String(o.structure)).toContain("période d'essai");
    const m = await outil(lecteur, "modifier_document")({ document: String(o.document), gestes: [{ action: "remplacer_texte", chercher: "3 mois", remplacer: "6 mois" }] });
    expect(m).toMatchObject({ statut: "REFUS" });
    expect(String(m.raison)).toMatch(/pas le modifier/);
    expect(await prisma.artifactOperation.count({ where: { sessionId: String(o.document) } })).toBe(0);
  });

  it("la propriétaire modifie EN PLACE (une ligne d'historique, zones notées) puis enregistre une NOUVELLE version, inscrite à la Bibliothèque", async () => {
    const o = await outil(proprietaire, "ouvrir_dans_l_atelier")({ document: nodeId });
    expect(o).toMatchObject({ statut: "OUVERT", modifiable: true, format: "DOCX" });
    const sessionId = String(o.document);
    const m = await outil(proprietaire, "modifier_document")({ document: sessionId, gestes: [{ action: "remplacer_texte", chercher: "3 mois", remplacer: "6 mois" }, { action: "ajouter_diapo", titre: "x" }] });
    expect(m.statut).toBe("MODIFIE_NON_ENREGISTRE");
    const gestes = m.gestes as { ok: boolean; refus?: string }[];
    expect(gestes[0]!.ok).toBe(true);
    expect(gestes[1]).toMatchObject({ ok: false });
    expect(gestes[1]!.refus).toMatch(/document Word/);
    const ops = await prisma.artifactOperation.findMany({ where: { sessionId } });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.revue).toBeNull();

    // Rien n'est enregistré tant que la personne n'a pas confirmé.
    expect(await prisma.fileVersion.count({ where: { nodeId } })).toBe(1);
    const p = await ENREGISTRER_ATELIER.proposer({ document: sessionId }, proprietaire);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.warnings).toEqual([]);
    oublierSession(sessionId);
    const r = await ENREGISTRER_ATELIER.executer(p.args, proprietaire);
    expect(r).toMatchObject({ ok: true });
    const versions = await prisma.fileVersion.findMany({ where: { nodeId }, orderBy: { version: "asc" } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.blobId).toBe(blobV1);
    const v2 = await adaptateurPour("DOCX").ouvrir((await getBlob(versions[1]!.blobId))!);
    const m2 = v2.modele();
    if (m2.kind !== "DOCX") throw new Error("format");
    expect(m2.paragraphs.map((x) => x.text)).toEqual(["Contrat de travail", "La période d'essai est de 6 mois.", "Le salaire est versé chaque mois."]);
    expect(m2.paragraphs[0]!.styleName).toBe("Heading1");
    expect(await prisma.piece.count({ where: { blobId: versions[1]!.blobId } })).toBe(1);
  });

  it("un document d'un ESPACE PARTAGÉ est sensible : l'enregistrement passe par une carte de confirmation", async () => {
    const espace = await prisma.driveSpace.create({ data: { name: `${TAG} Juridique`, managerUserIds: [proprietaire.id] } });
    await prisma.driveNode.update({ where: { id: nodeId }, data: { spaceId: espace.id } });
    expect(await documentSensible(nodeId)).toMatch(/espace partagé/);
    const o = await outil(proprietaire, "ouvrir_dans_l_atelier")({ document: nodeId });
    await outil(proprietaire, "modifier_document")({ document: String(o.document), gestes: [{ action: "remplacer_texte", chercher: "chaque mois", remplacer: "le 25 de chaque mois" }] });
    const c = await carteEnregistrement(proprietaire, String(o.document));
    if (!c.ok) throw new Error(c.erreur);
    expect(c.intent.warnings?.[0]).toMatch(/Document sensible/);
    const intent = await prisma.assistantActionIntent.findUnique({ where: { id: c.intent.id } });
    expect(intent?.status).toBe("PROPOSED");
    expect(await prisma.fileVersion.count({ where: { nodeId } })).toBe(2);
  });

  it("CONVERSIONS : la voie est choisie et DITE — tableau → Excel (composition intégrée), Word → PDF ; un étranger ne convertit pas", async () => {
    // Sans worker qui bat, jamais la voie WORKER.
    const voie = await choisirVoie("DOCX", "PDF");
    expect("voie" in voie && voie.voie).not.toBe("WORKER");
    const tableau = await putBlob(await docxDeParagraphes(["Tarifs"], { tableau: [["Produit", "Prix"], ["Amoxival", "1200"], ["Betacor", "900"]] }));
    const n = await prisma.driveNode.create({
      data: { name: `${TAG} Tarifs.docx`, type: "FILE", ownerId: proprietaire.id, size: tableau.size, versions: { create: { blobId: tableau.blobId, version: 1, size: tableau.size } } },
    });
    expect((await demanderConversion(etranger, n.id, "XLSX")).ok).toBe(false);
    const x = await demanderConversion(proprietaire, n.id, "XLSX");
    expect(x).toMatchObject({ ok: true, voie: "MAISON", etat: "FAITE" });
    const v = await prisma.fileVersion.findFirst({ where: { nodeId: x.resultat!.nodeId } });
    const classeur = (await adaptateurPour("XLSX").ouvrir((await getBlob(v!.blobId))!)).modele();
    if (classeur.kind !== "XLSX") throw new Error("format");
    expect(classeur.sheets[0]!.cells.find((c) => c.ref === "A2")?.value).toBe("Amoxival");
    expect(await prisma.piece.count({ where: { blobId: v!.blobId } })).toBe(1);

    const pdf = await demanderConversion(proprietaire, n.id, "PDF");
    expect(pdf.ok).toBe(true);
    expect(pdf.voie).toBe((await libreOfficeLocal()) ? "LOCAL" : "RENDU");
    expect(pdf.resultat?.nom).toMatch(/\.pdf$/);
  }, 120_000);
});
