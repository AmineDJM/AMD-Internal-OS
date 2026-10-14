import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { chargerPorteeStock, chargerHopitauxStock, chargerProduitsStock } from "@/lib/queries/stock-portee";
import { explicationPortee, porteeVide } from "@/lib/stocks/portee";
import { createStockHospital, recordStockSnapshot, deleteStockSnapshot } from "@/lib/actions/stock-snapshot-actions";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { FINISHED_REG_STATUSES } from "@/lib/regulatory/stage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__portee_stock__";

/**
 * ═══════════════════════════════════════════════════════════
 * LA PORTÉE DE STOCK PAR LES VRAIS POINTS D'ENTRÉE (§118.134).
 *
 * « Les hôpitaux et produits visibles par chaque KAM sont ceux de l'annuaire des établissements
 * qui sont dans son secteur, dans sa BU ; le National Sales voit toute sa BU. » Ce banc le tient
 * là où ça compte — le chargeur que lit l'écran, les actions qui écrivent, et l'outil qu'Adam
 * appelle — avec des acteurs SANS vue globale : une portée éprouvée avec un Super Admin ne peut
 * pas tomber (§118.104).
 *
 * Le décor : la BU Onco (supervisée par le National Sales) porte deux secteurs — Est (Sétif,
 * Constantine ; KAM Amel) et Ouest (Oran ; KAM Karim) — et deux produits ; la BU Cardio porte
 * Mustapha et un troisième produit. Nadir a une fiche dans la BU Onco et AUCUN secteur. Un lieu
 * de stock HÉRITÉ (sans établissement) porte aussi des relevés.
 * ═══════════════════════════════════════════════════════════
 */
suite("Portée de stock — KAM, National Sales, chaîne d'approvisionnement", () => {
  const ids = {
    amel: "", karim: "", nadir: "", ns: "", ops: "", sa: "",
    buOnco: "", buCardio: "",
    setif: "", constantine: "", oran: "", mustapha: "", vierge: "",
    p1: "", p2: "", p3: "",
    lieuSetif: "", lieuOran: "", lieuMustapha: "", lieuHerite: "",
    snapOran: "", snapSetif: "",
  };

  const acteur = async (id: string, role: SessionUser["role"]): Promise<SessionUser> =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role) } as unknown as SessionUser);
  const current = async (id: string, role: SessionUser["role"]): Promise<CurrentUser> => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: u.name, email: u.email, role, access: await getAccess(id, role), mustChangePassword: false };
  };
  const form = (fields: Record<string, string>): FormData => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const lire = async (u: CurrentUser, input: Record<string, unknown> = {}) => {
    const brut = await executePowerTool("read_stock", input, u);
    const texte = typeof brut === "string" ? brut : JSON.stringify(brut);
    if (!texte.trim().startsWith("{")) return { texte, lieux: [] as string[] };
    const json = JSON.parse(texte) as { niveaux?: { lieu: string; produit: string }[]; note?: string };
    return { texte, lieux: (json.niveaux ?? []).map((n) => n.lieu), note: json.note ?? "" };
  };

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [amel, karim, nadir, ns, ops, sa] = await Promise.all([
      mk("Amel", "MEDICAL_DELEGATE"), mk("Karim", "MEDICAL_DELEGATE"), mk("Nadir", "MEDICAL_DELEGATE"),
      mk("NS", "MEDICAL_DELEGATE"), mk("Ops", "OPERATIONS_DIRECTOR"), mk("SA", "SUPER_ADMIN"),
    ]);
    Object.assign(ids, { amel: amel.id, karim: karim.id, nadir: nadir.id, ns: ns.id, ops: ops.id, sa: sa.id });
    // Tous les acteurs terrain ont le module STOCKS en écriture (et suppression) : la portée doit
    // tenir MALGRÉ le droit de module, pas grâce à son absence.
    await prisma.userAccess.createMany({
      data: [amel.id, karim.id, nadir.id, ns.id].map((userId) => ({
        userId, module: "STOCKS", canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" as const,
      })),
    });

    const [buOnco, buCardio] = await Promise.all([
      prisma.businessUnit.create({ data: { name: `${TAG} BU Onco`, supervisorId: ns.id } }),
      prisma.businessUnit.create({ data: { name: `${TAG} BU Cardio` } }),
    ]);
    ids.buOnco = buOnco.id; ids.buCardio = buCardio.id;
    await prisma.salesRepProfile.createMany({
      data: [
        { repId: amel.id, businessUnitId: buOnco.id },
        { repId: karim.id, businessUnitId: buOnco.id },
        { repId: nadir.id, businessUnitId: buOnco.id },
      ],
    });

    // Des produits dont le traitement est TERMINÉ : le sélecteur de produits des stocks ne propose
    // pas un dossier en cours (on ne tient pas de stock d'un produit pas encore enregistré).
    const fini = [...FINISHED_REG_STATUSES][0] as never;
    const [p1, p2, p3] = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-P1`, dci: `${TAG} Nivolumab`, brandName: `${TAG} Nivolex`, status: fini } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-P2`, dci: `${TAG} Trastuzumab`, brandName: `${TAG} Trastuzex`, status: fini } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-P3`, dci: `${TAG} Amlodipine`, brandName: `${TAG} Cardiomax`, status: fini } }),
    ]);
    ids.p1 = p1.id; ids.p2 = p2.id; ids.p3 = p3.id;
    await prisma.promoProduct.createMany({
      data: [
        { name: `${TAG} Nivolex`, businessUnitId: buOnco.id, regulatoryProductId: p1.id },
        { name: `${TAG} Trastuzex`, businessUnitId: buOnco.id, regulatoryProductId: p2.id },
        { name: `${TAG} Cardiomax`, businessUnitId: buCardio.id, regulatoryProductId: p3.id },
      ],
    });

    const [setif, constantine, oran, mustapha, vierge] = await Promise.all([
      prisma.medicalInstitution.create({ data: { name: `${TAG} CHU Sétif`, wilaya: "Sétif" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG} CHU Constantine`, wilaya: "Constantine" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG} CHU Oran`, wilaya: "Oran" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG} CHU Mustapha`, wilaya: "Alger" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG} EPH Vierge`, wilaya: "Blida" } }),
    ]);
    Object.assign(ids, { setif: setif.id, constantine: constantine.id, oran: oran.id, mustapha: mustapha.id, vierge: vierge.id });

    await Promise.all([
      prisma.salesSector.create({ data: {
        name: `${TAG} Est`, businessUnitId: buOnco.id,
        institutions: { create: [{ institutionId: setif.id }, { institutionId: constantine.id }] },
        reps: { create: [{ repId: amel.id }] },
      } }),
      prisma.salesSector.create({ data: {
        name: `${TAG} Ouest`, businessUnitId: buOnco.id,
        institutions: { create: [{ institutionId: oran.id }] },
        reps: { create: [{ repId: karim.id }] },
      } }),
      prisma.salesSector.create({ data: {
        name: `${TAG} Alger`, businessUnitId: buCardio.id,
        institutions: { create: [{ institutionId: mustapha.id }] },
      } }),
    ]);

    // Les lieux de stock et leurs relevés — Constantine et Vierge n'ont encore AUCUN lieu.
    const [lieuSetif, lieuOran, lieuMustapha, lieuHerite] = await Promise.all([
      prisma.stockAnnex.create({ data: { name: `${TAG} CHU Sétif`, kind: "HOSPITAL", institutionId: setif.id } }),
      prisma.stockAnnex.create({ data: { name: `${TAG} CHU Oran`, kind: "HOSPITAL", institutionId: oran.id } }),
      prisma.stockAnnex.create({ data: { name: `${TAG} CHU Mustapha`, kind: "HOSPITAL", institutionId: mustapha.id } }),
      prisma.stockAnnex.create({ data: { name: `${TAG} Hôpital hérité`, kind: "HOSPITAL" } }),
    ]);
    Object.assign(ids, { lieuSetif: lieuSetif.id, lieuOran: lieuOran.id, lieuMustapha: lieuMustapha.id, lieuHerite: lieuHerite.id });
    const d = new Date("2031-03-01T00:00:00Z");
    const [snapSetif, snapOran] = await Promise.all([
      prisma.stockSnapshot.create({ data: { scope: "HOSPITAL", annexId: lieuSetif.id, productId: p1.id, date: d, quantity: 10, createdById: ops.id } }),
      prisma.stockSnapshot.create({ data: { scope: "HOSPITAL", annexId: lieuOran.id, productId: p1.id, date: d, quantity: 20, createdById: ops.id } }),
      prisma.stockSnapshot.create({ data: { scope: "HOSPITAL", annexId: lieuMustapha.id, productId: p3.id, date: d, quantity: 30, createdById: ops.id } }),
      prisma.stockSnapshot.create({ data: { scope: "HOSPITAL", annexId: lieuHerite.id, productId: p1.id, date: d, quantity: 5, createdById: ops.id } }),
      prisma.stockSnapshot.create({ data: { scope: "PCH", productId: p1.id, date: d, quantity: 100, createdById: ops.id } }),
    ]);
    ids.snapSetif = snapSetif.id; ids.snapOran = snapOran.id;
  });

  afterAll(async () => {
    const produits = [ids.p1, ids.p2, ids.p3].filter(Boolean);
    await prisma.stockSnapshot.deleteMany({ where: { productId: { in: produits } } }).catch(() => {});
    await prisma.stockAnnex.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesSector.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: [ids.amel, ids.karim, ids.nadir] } } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la prémisse : aucun acteur terrain n'a la vue globale ni la chaîne d'approvisionnement", async () => {
    // Sans cette ligne, le jour où MEDICAL_DELEGATE gagnerait PCH, tout le banc passerait au vert
    // sans plus rien garder (§118.104).
    for (const id of [ids.amel, ids.karim, ids.nadir, ids.ns]) {
      const u = await acteur(id, "MEDICAL_DELEGATE");
      expect(hasGlobalView(u)).toBe(false);
      expect(userCan(u, "PCH", "VIEW")).toBe(false);
      expect(userCan(u, "STOCKS", "CREATE")).toBe(true);
    }
  });

  it("le KAM voit les établissements de SON secteur et les produits de SA BU — rien d'autre", async () => {
    const p = await chargerPorteeStock(await acteur(ids.amel, "MEDICAL_DELEGATE"));
    expect(p.mode).toBe("SECTEUR");
    if (p.mode === "GLOBALE") return;
    expect(p.institutionIds).toEqual([ids.setif, ids.constantine].sort());
    expect(p.productIds).toEqual([ids.p1, ids.p2].sort());
    expect(p.secteurs.map((s) => s.nom)).toEqual([`${TAG} Est`]);
    expect(porteeVide(p)).toBe(false);
  });

  it("le National Sales voit TOUS les secteurs de sa BU — et pas l'autre BU", async () => {
    const p = await chargerPorteeStock(await acteur(ids.ns, "MEDICAL_DELEGATE"));
    expect(p.mode).toBe("BU");
    if (p.mode === "GLOBALE") return;
    expect(p.institutionIds).toEqual([ids.setif, ids.constantine, ids.oran].sort());
    expect(p.institutionIds).not.toContain(ids.mustapha);
    expect(p.productIds).toEqual([ids.p1, ids.p2].sort());
    expect(p.secteurs.map((s) => s.nom).sort()).toEqual([`${TAG} Est`, `${TAG} Ouest`].sort());
  });

  it("un KAM sans secteur a une portée VIDE, et l'écran sait dire pourquoi", async () => {
    const p = await chargerPorteeStock(await acteur(ids.nadir, "MEDICAL_DELEGATE"));
    expect(p.mode).toBe("SECTEUR");
    expect(porteeVide(p)).toBe(true);
    expect(explicationPortee(p)).toMatch(/Aucun secteur de votre BU/);
    const { hopitaux } = await chargerHopitauxStock(p);
    expect(hopitaux).toEqual([]);
  });

  it("la chaîne d'approvisionnement voit tout : la portée est GLOBALE", async () => {
    expect((await chargerPorteeStock(await acteur(ids.ops, "OPERATIONS_DIRECTOR"))).mode).toBe("GLOBALE");
    expect((await chargerPorteeStock(await acteur(ids.sa, "SUPER_ADMIN"))).mode).toBe("GLOBALE");
  });

  it("la liste des hôpitaux du KAM : ses établissements, avec ou SANS lieu — jamais un lieu hérité", async () => {
    const p = await chargerPorteeStock(await acteur(ids.amel, "MEDICAL_DELEGATE"));
    const { hopitaux, disponibles } = await chargerHopitauxStock(p);
    expect(hopitaux.map((h) => h.institutionId).sort()).toEqual([ids.setif, ids.constantine].sort());
    const constantine = hopitaux.find((h) => h.institutionId === ids.constantine);
    expect(constantine?.annexId).toBeNull();
    expect(constantine?.key).toBe(`etab:${ids.constantine}`);
    expect(hopitaux.find((h) => h.institutionId === ids.setif)?.annexId).toBe(ids.lieuSetif);
    expect(hopitaux.some((h) => h.herite)).toBe(false);
    expect(disponibles).toEqual([]);
    const produits = await chargerProduitsStock(await acteur(ids.amel, "MEDICAL_DELEGATE"), p);
    expect(produits.map((x) => x.id).sort()).toEqual([ids.p1, ids.p2].sort());
  });

  it("la vue globale liste les lieux existants — les hérités marqués — et les établissements encore sans lieu", async () => {
    const p = await chargerPorteeStock(await acteur(ids.sa, "SUPER_ADMIN"));
    const { hopitaux, disponibles } = await chargerHopitauxStock(p, { avecDisponibles: true });
    const herite = hopitaux.find((h) => h.annexId === ids.lieuHerite);
    expect(herite?.herite).toBe(true);
    expect(hopitaux.find((h) => h.annexId === ids.lieuOran)?.institutionId).toBe(ids.oran);
    expect(disponibles.map((d) => d.id)).toContain(ids.vierge);
    expect(disponibles.map((d) => d.id)).not.toContain(ids.setif);
  });

  it("read_stock lit la MÊME portée : le KAM ne voit ni l'autre secteur, ni la PCH, ni le lieu hérité", async () => {
    const amel = await lire(await current(ids.amel, "MEDICAL_DELEGATE"));
    expect(amel.lieux, amel.texte).toContain(`${TAG} CHU Sétif`);
    expect(amel.lieux).not.toContain(`${TAG} CHU Oran`);
    expect(amel.lieux).not.toContain("PCH (centrale)");
    expect(amel.lieux).not.toContain(`${TAG} Hôpital hérité`);
    expect(amel.note).toMatch(/vos secteurs/);
    // Un seuil VIDE (« low_threshold: "" », ce qu'un modèle envoie pour « pas de seuil ») se lit comme
    // ABSENT, jamais comme 0 : avant §118.134, `Number("")` valait 0 et l'outil répondait « aucun stock
    // ≤ 0 — rien de critique » sur des stocks bien réels. Le cas sans clé est couvert par `lire(amel)`.
    const seuilVide = await lire(await current(ids.amel, "MEDICAL_DELEGATE"), { low_threshold: "" });
    expect(seuilVide.lieux, seuilVide.texte).toContain(`${TAG} CHU Sétif`);

    const ns = await lire(await current(ids.ns, "MEDICAL_DELEGATE"));
    expect(ns.lieux).toEqual(expect.arrayContaining([`${TAG} CHU Sétif`, `${TAG} CHU Oran`]));
    expect(ns.lieux).not.toContain(`${TAG} CHU Mustapha`);
    expect(ns.lieux).not.toContain("PCH (centrale)");

    const nadir = await lire(await current(ids.nadir, "MEDICAL_DELEGATE"));
    expect(nadir.lieux).toEqual([]);
    expect(nadir.texte).toMatch(/Aucun secteur/);

    const ops = await lire(await current(ids.ops, "OPERATIONS_DIRECTOR"), { product: `${TAG}` });
    expect(ops.lieux).toEqual(expect.arrayContaining([`${TAG} CHU Sétif`, `${TAG} CHU Oran`, `${TAG} CHU Mustapha`, `${TAG} Hôpital hérité`, "PCH (centrale)"]));
  });

  it("écrire suit la portée : le KAM relève Constantine (le lieu naît rattaché), pas Oran, pas un produit de l'autre BU", async () => {
    ACTOR = await current(ids.amel, "MEDICAL_DELEGATE");
    const ok = await recordStockSnapshot(form({ scope: "HOSPITAL", institutionId: ids.constantine, productId: ids.p2, date: "2031-04-01", quantity: "8" }));
    expect(ok.ok, ok.error).toBe(true);
    const lieu = await prisma.stockAnnex.findUnique({ where: { institutionId: ids.constantine }, select: { id: true, name: true } });
    expect(lieu?.name).toBe(`${TAG} CHU Constantine`);
    expect(await prisma.stockSnapshot.count({ where: { annexId: lieu?.id, productId: ids.p2 } })).toBe(1);

    const oran = await recordStockSnapshot(form({ scope: "HOSPITAL", institutionId: ids.oran, productId: ids.p1, date: "2031-04-01", quantity: "8" }));
    expect(oran.ok).toBe(false);
    expect(oran.error).toMatch(/secteur/);
    const parLieu = await recordStockSnapshot(form({ scope: "HOSPITAL", annexId: ids.lieuOran, productId: ids.p1, date: "2031-04-01", quantity: "8" }));
    expect(parLieu.ok).toBe(false);
    const herite = await recordStockSnapshot(form({ scope: "HOSPITAL", annexId: ids.lieuHerite, productId: ids.p1, date: "2031-04-01", quantity: "8" }));
    expect(herite.ok).toBe(false);
    expect(herite.error).toMatch(/rattaché à aucun établissement/);
    const gamme = await recordStockSnapshot(form({ scope: "HOSPITAL", institutionId: ids.setif, productId: ids.p3, date: "2031-04-01", quantity: "8" }));
    expect(gamme.ok).toBe(false);
    expect(gamme.error).toMatch(/gamme/);
  });

  it("le National Sales écrit dans toute sa BU, pas dans l'autre", async () => {
    ACTOR = await current(ids.ns, "MEDICAL_DELEGATE");
    const oran = await recordStockSnapshot(form({ scope: "HOSPITAL", institutionId: ids.oran, productId: ids.p2, date: "2031-04-02", quantity: "3" }));
    expect(oran.ok, oran.error).toBe(true);
    const mustapha = await recordStockSnapshot(form({ scope: "HOSPITAL", institutionId: ids.mustapha, productId: ids.p3, date: "2031-04-02", quantity: "3" }));
    expect(mustapha.ok).toBe(false);
    expect(mustapha.error).toMatch(/BU/);
  });

  it("effacer suit la portée : le KAM n'efface pas le relevé d'un autre secteur, même avec le droit Supprimer", async () => {
    ACTOR = await current(ids.amel, "MEDICAL_DELEGATE");
    const r = await deleteStockSnapshot(form({ id: ids.snapOran }));
    expect(r.ok).toBe(false);
    expect(await prisma.stockSnapshot.count({ where: { id: ids.snapOran } })).toBe(1);
    const mien = await deleteStockSnapshot(form({ id: ids.snapSetif }));
    expect(mien.ok, mien.error).toBe(true);
  });

  it("un lieu hérité HOMONYME n'est jamais rattaché tout seul : le premier relevé refuse et nomme le geste", async () => {
    // Le nom exact est un indice fort, pas une preuve : deux établissements peuvent s'appeler
    // pareil, et joindre l'historique d'un lieu au mauvais hôpital serait un faux succès muet.
    const etab = await prisma.medicalInstitution.create({ data: { name: `${TAG} EPH Homonyme`, wilaya: "Tizi Ouzou" } });
    const legacy = await prisma.stockAnnex.create({ data: { name: `${TAG} EPH Homonyme`, kind: "HOSPITAL" } });
    ACTOR = await current(ids.ops, "OPERATIONS_DIRECTOR");
    const r = await recordStockSnapshot(form({ scope: "HOSPITAL", institutionId: etab.id, productId: ids.p1, date: "2031-04-03", quantity: "1" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rattachez-le/);
    expect((await prisma.stockAnnex.findUnique({ where: { id: legacy.id }, select: { institutionId: true } }))?.institutionId).toBeNull();
    expect(await prisma.stockAnnex.count({ where: { institutionId: etab.id } })).toBe(0);
  });

  it("le Super Admin ajoute un établissement de l'annuaire, rattache un lieu hérité — et un KAM ne peut pas", async () => {
    ACTOR = await current(ids.sa, "SUPER_ADMIN");
    const ajout = await createStockHospital(form({ institutionId: ids.vierge }));
    expect(ajout.ok, ajout.error).toBe(true);
    expect((await prisma.stockAnnex.findUnique({ where: { institutionId: ids.vierge } }))?.name).toBe(`${TAG} EPH Vierge`);
    // Ajouter deux fois n'en fait pas deux.
    const encore = await createStockHospital(form({ institutionId: ids.vierge }));
    expect(encore.ok).toBe(true);
    expect(await prisma.stockAnnex.count({ where: { institutionId: ids.vierge } })).toBe(1);

    // Un nom absent de l'annuaire est refusé en nommant le remède — pas créé « à côté ».
    const inconnu = await createStockHospital(form({ name: `${TAG} Clinique Fantôme` }));
    expect(inconnu.ok).toBe(false);
    expect(inconnu.error).toMatch(/annuaire des établissements/);
    expect(await prisma.stockAnnex.count({ where: { name: `${TAG} Clinique Fantôme` } })).toBe(0);

    // Rattacher le lieu hérité à un établissement : le nom suit l'annuaire, l'historique reste.
    const nouvel = await prisma.medicalInstitution.create({ data: { name: `${TAG} EPH Rattaché`, wilaya: "Béjaïa" } });
    const lien = await createStockHospital(form({ annexId: ids.lieuHerite, institutionId: nouvel.id }));
    expect(lien.ok, lien.error).toBe(true);
    const lieu = await prisma.stockAnnex.findUnique({ where: { id: ids.lieuHerite }, select: { name: true, institutionId: true } });
    expect(lieu).toEqual({ name: `${TAG} EPH Rattaché`, institutionId: nouvel.id });
    expect(await prisma.stockSnapshot.count({ where: { annexId: ids.lieuHerite } })).toBe(1);

    ACTOR = await current(ids.amel, "MEDICAL_DELEGATE");
    const refus = await createStockHospital(form({ institutionId: ids.constantine }));
    expect(refus.ok).toBe(false);
  });
});
