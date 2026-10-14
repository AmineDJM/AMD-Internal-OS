import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createSector, updateSector, deleteSector } from "@/lib/actions/sales-planning-actions";
// ⚠ ORDRE D'IMPORT IMPORTANT (documenté dans `assistant/capability-audit.test.ts`) :
// `ops/index.ts` et `lib/assistant.ts` forment un cycle d'INITIALISATION. Charger `assistant`
// d'abord — comme le fait l'application — donne l'ordre qui résout ; l'inverser fait échouer la
// SUITE ENTIÈRE sur « DOMAIN_TOOL_DEFS is not iterable ».
import "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__secteur__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

/** L'op telle que le runtime l'appelle : `{ meta, impl }` dans le catalogue. */
const op = (nom: string) => {
  const entree = DOMAIN_TOOLS.planning_operation.ops[nom];
  if (!entree) throw new Error(`op planning_operation/${nom} absente du catalogue`);
  return entree.impl;
};
type ActeurOp = Parameters<ReturnType<typeof op>["propose"]>[1];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SECTEURS — le territoire nommé d'une BU, et ce qui le rend VIVANT.
 *
 * Le banc part des VRAIS points d'entrée : les server actions de l'écran, et les ops telles que
 * le runtime les appelle. Un test qui partirait d'un état injecté à la main ne répondrait pas à
 * la question qui compte — « si quelqu'un utilise le produit maintenant, ce composant peut-il
 * être déclenché et produire un effet utile ? » (§118.14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Secteurs de la force de vente — écran et conversation, mêmes actions", () => {
  let adminId = "", kam1 = "", kam2 = "", buId = "", autreBuId = "";
  let chu = "", eph = "", clinique = "";

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [admin, a, b] = await Promise.all([mk("admin", "SUPER_ADMIN"), mk("Amel Kam", "MEDICAL_DELEGATE"), mk("Bilal Kam", "MEDICAL_DELEGATE")]);
    adminId = admin.id; kam1 = a.id; kam2 = b.id;

    const [bu, autre] = await Promise.all([
      prisma.businessUnit.create({ data: { name: `${TAG}Oncologie` } }),
      prisma.businessUnit.create({ data: { name: `${TAG}Cardiologie` } }),
    ]);
    buId = bu.id; autreBuId = autre.id;
    // Les KAM qu'on affecte aux secteurs sont des KAM de la BU — l'écran ne propose que ceux-là, et l'action
    // refuse les autres (§118.184 — S15).
    await prisma.salesRepProfile.createMany({ data: [{ repId: kam1, businessUnitId: buId }, { repId: kam2, businessUnitId: buId }] });

    const [i1, i2, i3] = await Promise.all([
      prisma.medicalInstitution.create({ data: { name: `${TAG}CHU Constantine`, type: "CHU", city: "Constantine" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG}EPH Annaba`, type: "EPH", city: "Annaba" } }),
      prisma.medicalInstitution.create({ data: { name: `${TAG}Clinique Oran`, type: "CLINIQUE_PRIVEE", city: "Oran" } }),
    ]);
    chu = i1.id; eph = i2.id; clinique = i3.id;

    ACTEUR = { id: admin.id, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(admin.id, "SUPER_ADMIN") } as unknown as SessionUser;
  });

  afterAll(async () => {
    await prisma.salesSector.deleteMany({ where: { businessUnit: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { businessUnit: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  // ── L'ÉCRAN ───────────────────────────────────────────────────────────────────────────────
  it("créer un secteur écrit les TROIS parts d'un coup — nom, établissements, KAM", async () => {
    const r = await createSector(fd({
      businessUnitId: buId, name: `${TAG}Est`, city: "Constantine",
      institutionIds: [chu, eph], repIds: [kam1],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const sec = await prisma.salesSector.findFirstOrThrow({
      where: { businessUnitId: buId, name: `${TAG}Est` },
      include: { institutions: true, reps: true },
    });
    expect(sec.city).toBe("Constantine");
    expect(sec.institutions.map((x) => x.institutionId).sort()).toEqual([chu, eph].sort());
    expect(sec.reps.map((x) => x.repId)).toEqual([kam1]);
  });

  it("LES LISTES SONT REMPLACÉES, pas fusionnées — décocher RETIRE", async () => {
    // Ce qui le ferait tomber : un `createMany` sans le `deleteMany` en face. Un secteur ne
    // pourrait alors que GRANDIR, et retirer un hôpital d'un territoire serait impossible depuis
    // l'écran — sans le moindre message.
    const sec = await prisma.salesSector.findFirstOrThrow({ where: { businessUnitId: buId, name: `${TAG}Est` } });
    const r = await updateSector(fd({
      id: sec.id, name: `${TAG}Est`, institutionIds: [clinique], repIds: [kam1, kam2],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const relu = await prisma.salesSector.findUniqueOrThrow({ where: { id: sec.id }, include: { institutions: true, reps: true } });
    expect(relu.institutions.map((x) => x.institutionId)).toEqual([clinique]);
    expect(relu.reps.map((x) => x.repId).sort()).toEqual([kam1, kam2].sort());
  });

  it("une sélection VIDE retire TOUT — décocher jusqu'au dernier est un geste légitime", async () => {
    // Ce qui le ferait tomber : borner le `deleteMany` aux seules lignes citées (un `in` au lieu
    // d'un `notIn`), ou sauter le retrait quand la liste est vide. Un décochage complet serait
    // alors SANS EFFET — un geste sans conséquence, en silence.
    //
    // Mesuré en passant, contre ce que j'avais écrit : `notIn: []` sous Prisma supprime bien la
    // ligne (un `NOT IN` vide est vrai partout), donc aucune sentinelle n'est nécessaire.
    const sec = await prisma.salesSector.findFirstOrThrow({ where: { businessUnitId: buId, name: `${TAG}Est` } });
    const r = await updateSector(fd({ id: sec.id, name: `${TAG}Est` }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const relu = await prisma.salesSector.findUniqueOrThrow({ where: { id: sec.id }, include: { institutions: true, reps: true } });
    expect(relu.institutions).toEqual([]);
    expect(relu.reps).toEqual([]);
  });

  it("DEUX secteurs du même nom dans la même BU : refus qui NOMME le doublon", async () => {
    const r = await createSector(fd({ businessUnitId: buId, name: `${TAG}est` }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("existe déjà");
  });

  it("le MÊME nom dans une AUTRE BU est légitime — « Est » existe pour chaque gamme", async () => {
    const r = await createSector(fd({ businessUnitId: autreBuId, name: `${TAG}Est` }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
  });

  it("un établissement disparu entre l'ouverture de l'écran et l'enregistrement : refus LISIBLE", async () => {
    // Sans cette lecture, Prisma renverrait une violation de clé étrangère — une erreur
    // technique là où la vérité est « cet hôpital n'existe plus ».
    const r = await createSector(fd({
      businessUnitId: buId, name: `${TAG}Fantome`, institutionIds: ["cuid-qui-nexiste-pas"],
    }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("n'existent plus dans l'annuaire");
    expect(await prisma.salesSector.count({ where: { name: `${TAG}Fantome` } }), "rien n'a été créé").toBe(0);
  });

  it("supprimer un secteur ne touche NI l'annuaire NI les comptes", async () => {
    const sec = await prisma.salesSector.findFirstOrThrow({ where: { businessUnitId: autreBuId, name: `${TAG}Est` } });
    await updateSector(fd({ id: sec.id, name: `${TAG}Est`, institutionIds: [chu], repIds: [kam2] }));
    const r = await deleteSector(fd({ id: sec.id }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(await prisma.salesSector.count({ where: { id: sec.id } })).toBe(0);
    expect(await prisma.medicalInstitution.count({ where: { id: chu } }), "l'hôpital reste à l'annuaire").toBe(1);
    expect(await prisma.user.count({ where: { id: kam2 } }), "le compte du KAM reste").toBe(1);
  });

  it("un acteur SANS le droit d'écrire sur la force de vente est refusé", async () => {
    const avant = ACTEUR;
    ACTEUR = { id: kam1, role: "MEDICAL_DELEGATE", secondaryRole: null, access: await getAccess(kam1, "MEDICAL_DELEGATE") } as unknown as SessionUser;
    const r = await createSector(fd({ businessUnitId: buId, name: `${TAG}Interdit` }));
    expect(r.ok).toBe(false);
    expect(await prisma.salesSector.count({ where: { name: `${TAG}Interdit` } })).toBe(0);
    ACTEUR = avant;
  });

  // ── LA CONVERSATION — les MÊMES actions, par les ops déclarées ─────────────────────────────
  it("l'op crée un secteur depuis des NOMS d'hôpitaux — jamais des identifiants dictés", async () => {
    // C'est la raison MESURÉE de déclarer cette op plutôt que de laisser faire le chemin
    // générique : `institutionIds` est une clé de formulaire et non un champ de relation, donc
    // la dérivation ne lui attache aucun modèle et personne ne peut la DÉSIGNER (§118.85).
    const acteur = { id: adminId, role: "SUPER_ADMIN", access: await getAccess(adminId, "SUPER_ADMIN") } as unknown as ActeurOp;
    const p = await op("create_sector").propose({
      target: `${TAG}Oncologie`, name: `${TAG}Oranais`, location: "Oran",
      institutions: `${TAG}Clinique Oran, ${TAG}EPH Annaba`, person: `${TAG}Bilal Kam`,
    }, acteur);
    expect("error" in p ? p.error : "", "la proposition doit aboutir").toBe("");
    if ("error" in p) return;
    const r = await op("create_sector").execute(p.args, acteur);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const sec = await prisma.salesSector.findFirstOrThrow({
      where: { businessUnitId: buId, name: `${TAG}Oranais` }, include: { institutions: true, reps: true },
    });
    // LES DEUX hôpitaux sont arrivés : la liste jointe par des virgules est recoupée en
    // plusieurs entrées du formulaire, ce que `getAll` relit exactement.
    expect(sec.institutions.map((x) => x.institutionId).sort()).toEqual([clinique, eph].sort());
    expect(sec.reps.map((x) => x.repId)).toEqual([kam2]);
  });

  it("un nom d'hôpital introuvable se DIT avec le geste — jamais deviné", async () => {
    const acteur = { id: adminId, role: "SUPER_ADMIN", access: await getAccess(adminId, "SUPER_ADMIN") } as unknown as ActeurOp;
    const p = await op("create_sector").propose({
      target: `${TAG}Oncologie`, name: `${TAG}Sud`, institutions: "Hôpital de Tamanrasset",
    }, acteur);
    expect("error" in p).toBe(true);
    if (!("error" in p)) return;
    expect(p.error).toContain("aucun établissement actif");
    // §118.30 : le refus nomme le REMÈDE, pas seulement la faute.
    expect(p.error).toContain("Établissements");
  });

  it("MODIFIER SANS CITER les listes les REJOUE — renommer n'efface pas le territoire", async () => {
    // Le défaut que cette FUSION empêche, et il est mesurable : l'action REMPLACE les deux
    // listes (c'est ce qui fait que décocher retire). Sans relire l'existant, « renomme le
    // secteur » sortirait un secteur VIDE — empreinte réelle très supérieure à l'empreinte
    // demandée (§118.16).
    const acteur = { id: adminId, role: "SUPER_ADMIN", access: await getAccess(adminId, "SUPER_ADMIN") } as unknown as ActeurOp;
    const p = await op("update_sector").propose({ name: `${TAG}Oranais`, newName: `${TAG}Ouest` }, acteur);
    expect("error" in p ? p.error : "").toBe("");
    if ("error" in p) return;
    const r = await op("update_sector").execute(p.args, acteur);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const sec = await prisma.salesSector.findFirstOrThrow({
      where: { businessUnitId: buId, name: `${TAG}Ouest` }, include: { institutions: true, reps: true },
    });
    expect(sec.institutions.length, "les établissements sont PRÉSERVÉS").toBe(2);
    expect(sec.reps.length, "les KAM sont PRÉSERVÉS").toBe(1);
  });

  it("la carte de suppression DIT combien de KAM perdent leur territoire", async () => {
    const acteur = { id: adminId, role: "SUPER_ADMIN", access: await getAccess(adminId, "SUPER_ADMIN") } as unknown as ActeurOp;
    const p = await op("delete_sector").propose({ name: `${TAG}Ouest` }, acteur);
    expect("error" in p ? p.error : "").toBe("");
    if ("error" in p) return;
    // La CONSÉQUENCE, pas la ligne supprimée — c'est elle qu'on lit avant de confirmer.
    expect((p.warnings ?? []).join(" ")).toContain("1 KAM perdent ce territoire");
  });

  it("un secteur SANS établissement n'est pas REFUSÉ — il est AVERTI", async () => {
    // Découper d'abord et remplir ensuite est un geste légitime : refuser coûterait une capacité
    // réelle contre un défaut qui se DIT très bien (§118.27). Mais le silence, lui, produirait un
    // KAM au panel vide sans qu'une ligne l'explique.
    const acteur = { id: adminId, role: "SUPER_ADMIN", access: await getAccess(adminId, "SUPER_ADMIN") } as unknown as ActeurOp;
    const p = await op("create_sector").propose({ target: `${TAG}Oncologie`, name: `${TAG}Nord` }, acteur);
    expect("error" in p ? p.error : "").toBe("");
    if ("error" in p) return;
    expect((p.warnings ?? []).join(" ")).toContain("sans territoire");
  });
});
