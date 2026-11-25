import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createRequest } from "@/lib/actions/admin-request-actions";
import { TITRE_BC_A_ETABLIR } from "@/modules/ad-pro/partage";
import { FAMILLES_BUREAU, lignesDuBureau, sansDoublon } from "./bureau";
import { clauseFichesVisibles, ficheDuBureau } from "./reservations-fiches";
import { autresTachesAssistante } from "./autres-taches-assistante";
import type { LigneBureau } from "@/lib/secretariat/ligne-bureau";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bureau${Date.now().toString(36)}__`;

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const role = u.role as SessionUser["role"];
  return { id, name: u.name, email: u.email, role, secondaryRole: u.secondaryRole, access: await getAccess(id, role), mustChangePassword: false } as CurrentUser;
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

describe("le bureau — une ligne par objet métier (PUR)", () => {
  const l = (cle: string, cleMetier: string | null): LigneBureau => ({
    cle, famille: cle.split(":")[0]!, type: "Bon de commande", objet: cle, reference: null, demandeur: null, dates: null,
    etat: "A_PRENDRE", chezQui: null, echeance: null, depuis: "2026-11-01T00:00:00.000Z", href: "/x", cleMetier,
  });
  it("deux familles qui voient le même BC de poste n'en montrent qu'une ligne : la première l'emporte", () => {
    const r = sansDoublon([l("demande:a", "poste:p1:bc"), l("agence:p1", "poste:p1:agence"), l("bc-poste:x", "poste:p1:bc"), l("demande:b", null), l("demande:c", null)]);
    expect(r.map((x) => x.cle)).toEqual(["demande:a", "agence:p1", "demande:b", "demande:c"]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUREAU DU SECRÉTARIAT, UN SEUL TABLEAU (Super Admin, 24/11/2026) — `lignesDuBureau`, sur la base :
 *   • un demandeur ordinaire ne voit que SES demandes (et la fiche de voyage qu'il a envoyée) — aucun travail de l'assistante ;
 *   • l'assistante voit la fiche (à prendre, chez elle) et l'ancienne demande « BC à établir » ; le poste agence qui
 *     l'attend et la demande de pièce du BC N'Y SONT PAS : ils vivent sur « Prospection d'agences », module à part
 *     (Super Admin, 25/11/2026) — une seule fois, pas aussi au bureau ;
 *   • une famille en panne n'éteint pas les autres, et la page le sait ;
 *   • la page d'une fiche suit la MÊME clause que sa ligne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Bureau du secrétariat — lignesDuBureau (base réelle)", () => {
  let demId = "", autreId = "", astId = "", pmId = "";
  let maDemande = "", autreDemande = "", bcAEtablir = "", pieceBc = "", ficheId = "";
  let eventId = "", posteAgence = "", posteBc = "", congresId = "";

  beforeAll(async () => {
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } })).id;
    demId = await mk("dem", "MEDICAL_DELEGATE");
    autreId = await mk("autre", "MEDICAL_DELEGATE");
    astId = await mk("ast", "DIRECTION_ASSISTANT");
    pmId = await mk("pm", "PRODUCT_MANAGER");

    // DEUX DEMANDES, par l'écran : la mienne (un déplacement daté) et celle d'un autre.
    ACTOR = await acteur(demId);
    const r1 = await createRequest(undefined, fd({ type: "TRAVEL", title: `${TAG}Mission Oran`, priority: "MEDIUM", f_villeDepart: "Alger", f_villeArrivee: "Oran", f_dateDepart: "2026-12-11", f_dateRetour: "2026-12-14" }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    maDemande = r1.id!;
    ACTOR = await acteur(autreId);
    const r2 = await createRequest(undefined, fd({ type: "OTHER", title: `${TAG}Demande d'un autre`, priority: "MEDIUM" }));
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    autreDemande = r2.id!;
    const societe = (await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: maDemande }, select: { companyId: true } })).companyId;

    // UN POSTE PAYÉ PAR UNE AGENCE, confié à l'assistante, dont la prospection est demandée : devis à déposer.
    eventId = (await prisma.event.create({ data: { name: `${TAG}Journée`, requesterId: pmId, requestStatus: "APPROVED" } })).id;
    posteAgence = (await prisma.adProItem.create({ data: { label: `${TAG}Stand`, eventId, kind: "PRINTING", status: "APPROVED", amountGranted: 90_000, voie: "AGENCE" } })).id;
    await prisma.adProExecutionPoste.create({ data: { itemId: posteAgence, assistanteId: astId, prospectionDemandeeAt: new Date(), cahierDesCharges: "Stand 3x3" } });

    // UN BC DE POSTE DEMANDÉ DEUX FOIS : l'ancienne demande « BC à établir » ET la demande de pièce.
    posteBc = (await prisma.adProItem.create({ data: { label: `${TAG}Hébergement`, eventId, kind: "ACCOMMODATION", status: "APPROVED", amountGranted: 40_000 } })).id;
    bcAEtablir = (await prisma.administrativeRequest.create({
      data: {
        reference: `${TAG}REQ-BC`, title: `${TITRE_BC_A_ETABLIR} — ${TAG}Hébergement`, type: "OTHER", status: "NEW", priority: "MEDIUM",
        requesterId: pmId, createdById: pmId, companyId: societe, linkedEntityType: "AD_PRO_ITEM", linkedEntityId: posteBc,
      },
    })).id;
    pieceBc = (await prisma.documentRequest.create({
      data: { reference: `${TAG}PIE-1`, entityType: "AD_PRO_ITEM", entityId: posteBc, label: "Bon de commande", kind: "PURCHASE_ORDER", askedById: pmId, askedToId: astId, status: "PENDING" },
    })).id;

    // UNE FICHE BILLET envoyée par le demandeur (prise en charge nationale).
    congresId = (await prisma.congressNational.create({ data: { name: `${TAG}Congrès`, requestStatus: "APPROVED", requesterId: demId }, select: { id: true } })).id;
    const personne = await prisma.careBeneficiary.create({ data: { congressNationalId: congresId, firstName: "Karim", lastName: `${TAG}Mansouri`, status: "APPROVED" } });
    const cellule = await prisma.careCell.create({
      data: { beneficiaryId: personne.id, kind: "SERVICE", serviceKind: "TICKET", label: "Billetterie", trajet: "ALLER_RETOUR", transport: "AVION", fromCity: "Alger", toCity: "Oran", dateStart: new Date("2026-12-11"), dateEnd: new Date("2026-12-14") },
    });
    ficheId = (await prisma.demandeReservation.create({
      data: { nature: "BILLET", careCellId: cellule.id, careBeneficiaryId: personne.id, operationType: "CONGRESS_NATIONAL", operationId: congresId, demandeurId: demId, etat: "ENVOYEE" },
    })).id;
  }, 120_000);

  afterAll(async () => {
    ACTOR = null;
    const demandes = [maDemande, autreDemande, bcAEtablir].filter(Boolean);
    for (const cle of [...demandes, ficheId, pieceBc].filter(Boolean)) await prisma.notification.deleteMany({ where: { link: { contains: cle } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: demandes } }, { actorId: { in: [demId, autreId, astId, pmId] } }] } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { id: pieceBc } }).catch(() => {});
    await prisma.demandeReservation.deleteMany({ where: { operationId: congresId } }).catch(() => {});
    await prisma.careCell.deleteMany({ where: { beneficiary: { congressNationalId: congresId } } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: congresId } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: congresId } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: [posteAgence, posteBc] } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: [posteAgence, posteBc] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  it("UN DEMANDEUR ORDINAIRE ne voit que ses demandes — et sa fiche de voyage, chez l'assistante ; aucun travail de l'assistante", async () => {
    const { lignes, pannes } = await lignesDuBureau(await acteur(demId));
    expect(pannes).toEqual([]);
    const mienne = lignes.find((l) => l.cle === `demande:${maDemande}`);
    expect(mienne).toMatchObject({ type: "Déplacement", etat: "A_PRENDRE", dates: "11 → 14 déc.", href: `/demandes/${maDemande}` });
    expect(lignes.some((l) => l.cle === `demande:${autreDemande}`), "la demande d'un autre").toBe(false);
    expect(lignes.find((l) => l.cle === `fiche-voyage:${ficheId}`)).toMatchObject({ type: "Billet", etat: "A_PRENDRE", chezQui: "Assistante" });
    expect(lignes.filter((l) => ["agence", "bc-poste", "promo", "devis-pec"].includes(l.famille))).toEqual([]);
  }, 120_000);

  it("L'ASSISTANTE voit la fiche à prendre et la demande « BC à établir » — ni le poste agence ni le BC de poste (module à part)", async () => {
    const ast = await acteur(astId);
    const { lignes, pannes } = await lignesDuBureau(ast);
    expect(pannes).toEqual([]);
    expect(lignes.find((l) => l.cle === `fiche-voyage:${ficheId}`)).toMatchObject({ etat: "A_PRENDRE", chezQui: "Vous", href: `/demandes/fiches/${ficheId}` });
    expect(lignes.filter((l) => l.famille === "agence" || l.famille === "bc-poste"), "plus de double affichage").toEqual([]);
    expect(lignes.some((l) => l.href === `/agences/${posteAgence}`)).toBe(false);
    const bc = lignes.filter((l) => l.cleMetier === `poste:${posteBc}:bc`);
    expect(bc, "aucun doublon BC").toHaveLength(1);
    expect(bc[0]).toMatchObject({ cle: `demande:${bcAEtablir}`, type: "Bon de commande" });
    // La demande de pièce du BC se lit sur « Prospection d'agences », dans « Vos autres tâches » — et nulle part au bureau.
    const autres = await autresTachesAssistante(ast);
    expect(autres.find((g) => g.cle === "BC")?.lignes.find((t) => t.cle === `bc-poste:${pieceBc}`)).toMatchObject({ geste: "Établir le BC", href: `/pieces/${pieceBc}` });
    expect(autres.find((g) => g.cle === "VOYAGES")?.lignes[0]).toMatchObject({ href: "/demandes", geste: "Ouvrir le bureau" });
    expect(await autresTachesAssistante(await acteur(pmId)), "sa page à elle seule").toEqual([]);
    // Les deux demandes du secrétariat lui sont ouvertes : elle tient le bureau.
    expect(lignes.some((l) => l.cle === `demande:${maDemande}`) && lignes.some((l) => l.cle === `demande:${autreDemande}`)).toBe(true);
  }, 120_000);

  it("UNE FAMILLE EN PANNE n'empêche pas les autres : ses lignes manquent, et le bureau dit laquelle", async () => {
    const panne = { cle: "panne", libelle: "la famille en panne", lignes: async () => { throw new Error("base indisponible"); } };
    const { lignes, pannes } = await lignesDuBureau(await acteur(astId), [panne, ...FAMILLES_BUREAU]);
    expect(pannes).toEqual(["la famille en panne"]);
    expect(lignes.some((l) => l.cle === `demande:${maDemande}`)).toBe(true);
    expect(lignes.some((l) => l.cle === `fiche-voyage:${ficheId}`)).toBe(true);
  }, 120_000);

  it("LA PAGE D'UNE FICHE suit la clause de sa ligne : le demandeur et l'assistante l'ouvrent, un autre non", async () => {
    expect(clauseFichesVisibles(await acteur(astId))).toEqual({});
    expect(clauseFichesVisibles(await acteur(demId))).toEqual({ demandeurId: demId });
    expect((await ficheDuBureau(await acteur(demId), ficheId))?.ligne.personne).toContain("Mansouri");
    expect(await ficheDuBureau(await acteur(astId), ficheId)).not.toBeNull();
    expect(await ficheDuBureau(await acteur(autreId), ficheId)).toBeNull();
  }, 120_000);
});
