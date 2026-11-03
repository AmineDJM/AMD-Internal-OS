import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { getBlob } from "@/lib/drive-storage";
import { exporterDemandesPaiement, exporterOrdresCentre } from "@/lib/exports/paiements";
import { JeuxDuTour } from "./domaine/analyse/jeux";
import { outilExporterDonnees } from "./infra/analyse/exporter";
import { accesParDefaut } from "./infra/outils-v1";

/**
 * K7, SUITE (décision 0037 — Direction, 01/11 : « l'export de tout »), sur la vraie base.
 *
 *   • `exporter_donnees` écrit un JEU DU TOUR en Excel / CSV / PDF au Drive « Exports » : les lignes viennent du jeu,
 *     les colonnes se choisissent par leur nom, une colonne confidentielle non jugée est écrite « [confidentiel] », un
 *     repère non révélé aussi ; un jeu que le tour n'a pas lu ne s'exporte pas (l'outil dit de le lire d'abord).
 *   • l'export des DEMANDES DE PAIEMENT a la portée de l'écran : chacun ses demandes, la file à instruire pour les
 *     Finances seulement.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__k7don_${Date.now().toString(36)}_`;
let finance: CurrentUser;
let demandeur: CurrentUser;

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

const octetsDe = async (nodeId: string) => {
  const n = await prisma.driveNode.findUniqueOrThrow({ where: { id: nodeId }, select: { ownerId: true, parent: { select: { name: true } }, versions: { select: { blobId: true } } } });
  return { n, octets: (await getBlob(n.versions[0]!.blobId))! };
};

const exporter = async (u: CurrentUser, jeux: JeuxDuTour, entree: Record<string, unknown>) =>
  JSON.parse(await outilExporterDonnees(u, { jeux, coffret: null, acces: accesParDefaut(u) }).run(entree, u)) as {
    statut?: string; ok?: boolean; erreur?: string; consigne?: string;
    fichier?: { nodeId: string; nom: string; lignes: number; colonnes: string[]; telecharger: string; masquees?: string[] };
  };

suite("K7 — l'export de tout : exporter_donnees, et les demandes de paiement", () => {
  beforeAll(async () => {
    finance = await compte("Finances", "FINANCE_BUDGET_MANAGER");
    demandeur = await compte("Demandeur", "VIEWER");
    await prisma.paymentRequest.createMany({
      data: [
        { reference: `${TAG}PAY-1`, title: `${TAG}Facture traiteur`, amount: 125000, payee: "Traiteur Blida", requesterId: demandeur.id, status: "ON_HOLD" },
        { reference: `${TAG}PAY-2`, title: `${TAG}Location salle`, amount: 300000, payee: "Hôtel Oran", requesterId: demandeur.id, status: "SUBMITTED" },
        { reference: `${TAG}PAY-3`, title: `${TAG}Autre demandeur`, amount: 50000, payee: "Imprimerie", requesterId: finance.id, status: "DRAFT" },
      ],
    });
  });

  afterAll(async () => {
    const ids = [finance?.id, demandeur?.id].filter(Boolean) as string[];
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const medecins = () => {
    const jeux = new JeuxDuTour();
    jeux.noter("annuaire_medecins", JSON.stringify({
      total: 3,
      medecins: [
        { nom: "Dr Amrani", specialite: "Cardiologie", wilaya: "Blida", potentiel: 12, salaire: "180000" },
        { nom: "Dr Benali", specialite: "Oncologie", wilaya: "Blida", potentiel: 8, salaire: "⟦S1⟧" },
        { nom: "Dr Cherif", specialite: "Pédiatrie", wilaya: "Blida", potentiel: 5, salaire: null },
      ],
    }));
    return jeux;
  };

  it("Excel : le classeur vérifié, au Drive « Exports », colonnes choisies, une colonne confidentielle jamais en clair", async () => {
    const r = await exporter(finance, medecins(), { source: "annuaire_medecins", format: "xlsx", titre: "Médecins de Blida" });
    expect(r.statut).toBe("FAIT");
    expect(r.fichier!.lignes).toBe(3);
    expect(r.fichier!.telecharger).toBe(`/api/drive/${r.fichier!.nodeId}/raw?dl=1`);
    expect(r.fichier!.masquees?.join(" ")).toMatch(/salaire/);
    const { n, octets } = await octetsDe(r.fichier!.nodeId);
    expect(n.ownerId).toBe(finance.id);
    expect(n.parent?.name).toBe("Exports");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(octets as unknown as ArrayBuffer);
    const texte = JSON.stringify(wb.getWorksheet("Analyse")!.getSheetValues());
    expect(texte).toContain("Dr Amrani");
    expect(texte).not.toContain("180000");
    expect(texte).not.toContain("⟦S1⟧");
    expect(texte).toContain("[confidentiel]");
    expect(wb.getWorksheet("Méthode")).toBeDefined();
  });

  it("CSV : les colonnes demandées, dans l'ordre, « ; » et BOM", async () => {
    const r = await exporter(finance, medecins(), { source: "annuaire_medecins", format: "csv", colonnes: ["Nom", "potentiel"] });
    expect(r.statut).toBe("FAIT");
    const texte = (await octetsDe(r.fichier!.nodeId)).octets.toString("utf8");
    expect(texte.charCodeAt(0)).toBe(0xfeff);
    expect(texte.split("\r\n")[1]).toBe("Dr Amrani;12");
    expect(texte).not.toMatch(/Cardiologie|salaire/i);
  });

  it("PDF : un vrai PDF, mis en page", async () => {
    const r = await exporter(finance, medecins(), { source: "annuaire_medecins", format: "pdf", colonnes: ["nom", "specialite", "wilaya"] });
    expect(r.statut).toBe("FAIT");
    const { octets } = await octetsDe(r.fichier!.nodeId);
    expect(octets.subarray(0, 5).toString()).toBe("%PDF-");
    // Une page pour trois lignes : le pied de page ne déborde pas (mesuré : il ouvrait une page de plus par pied).
    expect((octets.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length).toBe(1);
    expect(r.fichier!.nom).toMatch(/\.pdf$/);
  });

  it("une liste que le tour n'a pas lue ne s'exporte pas ; une colonne inconnue n'est pas devinée", async () => {
    const vide = await exporter(finance, new JeuxDuTour(), { source: "demandes_adpro" });
    expect(vide.ok).toBe(false);
    expect(vide.consigne).toMatch(/Lis d'abord la liste/);
    const inconnue = await exporter(finance, medecins(), { source: "annuaire_medecins", colonnes: ["telephone"] });
    expect(inconnue.erreur).toMatch(/colonne\(s\) inconnue\(s\) : telephone/);
  });

  it("les demandes de paiement : chacun les siennes ; la file à instruire, aux Finances seulement", async () => {
    const lui = await exporterDemandesPaiement(demandeur, {});
    expect(lui.ok && lui.fichier.resume).toMatch(/^2 demande\(s\) de paiement \(Mes demandes : 2\)/);
    const refus = await exporterDemandesPaiement(demandeur, { perimetre: "a_instruire" });
    expect(!refus.ok && refus.statut).toBe(403);
    const fin = await exporterDemandesPaiement(finance, { perimetre: "a_instruire", statuts: ["Mise en attente"] });
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(fin.fichier.octets) as unknown as ArrayBuffer);
    const texte = JSON.stringify(wb.worksheets[0]!.getSheetValues());
    expect(texte).toContain(`${TAG}Facture traiteur`);
    expect(texte).not.toContain(`${TAG}Location salle`);
    expect((await exporterDemandesPaiement(finance, { statuts: ["Presque payée"] })).ok).toBe(false);
  });

  it("le centre de paiement : la portée du chargeur de l'écran (rien pour qui n'a aucun ordre)", async () => {
    const r = await exporterOrdresCentre(demandeur, {});
    expect(!r.ok && r.statut).toBe(404);
  });
});
