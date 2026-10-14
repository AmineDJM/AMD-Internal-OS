import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { createRegulatoryProduct, updateRegulatoryProduct, updateRegulatoryStatus } from "@/lib/actions/regulatory-actions";
import { createPromoProduct, updatePromoProduct } from "@/lib/actions/sales-planning-actions";
import {
  ajouterAliasProduitCanonique, rattacherDossierCanonique, renommerProduitCanonique, retirerAliasProduitCanonique,
  verifierProduitsDesDossiers,
} from "@/lib/actions/produit-canonique-actions";
import { canAccessEntity } from "@/lib/entity-access";
import { chargerProduitCanonique } from "@/lib/queries/produits-canoniques";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { getCatalogReconciliation } from "@/lib/queries/product-catalog";
import { productRangeScope } from "@/lib/company";
import { linkProductToDossierFor, unlinkProductFromDossierFor } from "./link";
import { assurerProduitsDesDossiers, ensureProduitDuDossier } from "./canonique";
import { ensureProduct } from "./resolve";
import { identityKey, nomCanonique } from "./identity";
import { PREFIXE_CLE_DOSSIER } from "./produit-du-dossier";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRODUIT = DOSSIER — depuis les VRAIS points d'entrée (§118.178 ; Direction, 08/10 : « un seul
 * catalogue de produits »).
 *
 * Le module pur (`produit-du-dossier.test.ts`) prouve la règle. Il ne dit rien de la question qui
 * compte : quand une personne crée ou corrige un dossier, ajoute un produit à une BU, rattache un
 * produit du planning — chaque dossier a-t-il SON produit, et le même partout ?
 * On part donc des actions que les écrans poussent, et l'on relit la base.
 *
 * Les molécules portent un préfixe propre à ce passage : leurs clés d'identité n'existent nulle
 * part ailleurs, et un banc voisin qui tourne en même temps ne peut ni les trouver ni les fusionner.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const TAG = `ZZCANON${Date.now()}`;
const mol = (nom: string) => `${TAG}${nom}`;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  // Un dossier du suivi se crée avec sa CTD initiale (Direction, 06/10) : le formulaire dit combien de fichiers.
  f.set("ctdFichiers", "1");
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

suite("produit = dossier, branché aux portes qui créent et corrigent les dossiers", () => {
  let companyId = "";
  let adminId = "";
  let assistId = "";
  let opsId = "";
  let SA: CurrentUser;
  const dossiers: string[] = [];
  const promos: string[] = [];
  const bds: string[] = [];

  /** Un dossier COMPLET par défaut ; chaque cas retire ou change ce qu'il éprouve. */
  const identite = (dci: string, extra: Record<string, string> = {}) => ({
    companyId, dci, dosage: "500", dosageUnit: "MG", pharmaceuticalForm: "COMPRIME_PELLICULE", packaging: "B/30",
    confirmDuplicate: "1", ...extra,
  });

  async function creer(values: Record<string, string>) {
    ACTOR = SA;
    const r = await createRegulatoryProduct(undefined, fd(values));
    expect(r.ok, r.error).toBe(true);
    dossiers.push(r.id!);
    return r;
  }
  const lire = (id: string) => prisma.regulatoryProduct.findUniqueOrThrow({
    where: { id }, select: { productId: true, reference: true, canonicalProduct: { select: { id: true, code: true, identityKey: true, canonicalName: true, lifecycle: true } } },
  });

  beforeAll(async () => {
    const c = await prisma.company.findFirst({ where: { isActive: true }, select: { id: true } });
    companyId = c?.id ?? (await prisma.company.create({ data: { name: `${TAG} Entité`, shortName: TAG, isActive: true }, select: { id: true } })).id;
    const [a, b, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} admin`, email: `${TAG}a@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} assistante`, email: `${TAG}b@t.dz`, role: "REGULATORY_ASSISTANT", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} ops`, email: `${TAG}c@t.dz`, role: "OPERATIONS_DIRECTOR", passwordHash: "x" }, select: { id: true } }),
    ]);
    adminId = a.id; assistId = b.id; opsId = o.id;
    SA = await actorFor(adminId, "SUPER_ADMIN");
  });

  afterAll(async () => {
    const produits = (await prisma.regulatoryProduct.findMany({ where: { id: { in: dossiers } }, select: { productId: true } }))
      .map((d) => d.productId).filter((x): x is string => Boolean(x));
    const parTag = (await prisma.product.findMany({ where: { dci: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
    await prisma.promoProduct.deleteMany({ where: { id: { in: promos } } }).catch(() => {});
    await prisma.bdProduct.deleteMany({ where: { id: { in: bds } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: [...new Set([...produits, ...parTag])] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, assistId, opsId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [adminId, assistId, opsId] } } }).catch(() => {});
  });

  it("un dossier COMPLET reçoit son produit à sa création — clé, nom distinctif, historique", async () => {
    const r = await creer(identite(mol("ALPHA")));
    const d = await lire(r.id!);
    expect(d.productId).not.toBeNull();
    expect(d.canonicalProduct!.identityKey).toBe(identityKey({ dci: mol("ALPHA"), dosage: "500", dosageUnit: "MG", form: "COMPRIME_PELLICULE", packaging: "B/30" }));
    expect(d.canonicalProduct!.canonicalName).toBe(nomCanonique({ dci: mol("ALPHA"), dosage: "500", dosageUnit: "MG", form: "COMPRIME_PELLICULE", packaging: "B/30" }));
    expect(r.message).toMatch(new RegExp(`Produit ${d.canonicalProduct!.code} créé`));
    expect(r.message).not.toMatch(/canonique/);
    const trace = await prisma.auditLog.count({ where: { entityType: "PRODUCT", entityId: d.productId!, action: "CREATE" } });
    expect(trace).toBe(1);
  });

  it("un second dossier de la MÊME identité reçoit SON produit — le catalogue ne fusionne plus deux dossiers", async () => {
    const a = await creer(identite(mol("BETA")));
    const b = await creer(identite(mol("BETA"), { brandName: "Bêtamarque" }));
    const [da, db] = await Promise.all([lire(a.id!), lire(b.id!)]);
    expect(db.productId).not.toBeNull();
    expect(db.productId).not.toBe(da.productId);
    // La clé d'identité est au premier ; le second porte la même, suffixée de SON dossier.
    expect(da.canonicalProduct!.identityKey).toBe(identityKey({ dci: mol("BETA"), dosage: "500", dosageUnit: "MG", form: "COMPRIME_PELLICULE", packaging: "B/30" }));
    expect(db.canonicalProduct!.identityKey).toBe(`${da.canonicalProduct!.identityKey}#${b.id}`);
    expect(b.message).toMatch(/Produit .* créé/);
  });

  it("le cas réel : 120 ml et 300 ml sont deux produits", async () => {
    const a = await creer(identite(mol("LEVE"), { dosage: "100", dosageUnit: "MG_ML", pharmaceuticalForm: "SOLUTION_BUVABLE", packaging: "B/1 120 ML" }));
    const b = await creer(identite(mol("LEVE"), { dosage: "100", dosageUnit: "MG_ML", pharmaceuticalForm: "SOLUTION_BUVABLE", packaging: "B/1 300 ML" }));
    const [da, db] = await Promise.all([lire(a.id!), lire(b.id!)]);
    expect(da.productId).not.toBeNull();
    expect(db.productId).not.toBeNull();
    expect(db.productId).not.toBe(da.productId);
  });

  it("un dossier INCOMPLET EST un produit — clé propre au dossier, et la phrase dit ce qui reste à compléter", async () => {
    const r = await creer(identite(mol("GAMMA"), { packaging: "" }));
    const d = await lire(r.id!);
    expect(d.productId).not.toBeNull();
    expect(d.canonicalProduct!.identityKey).toBe(`${PREFIXE_CLE_DOSSIER}${r.id}`);
    expect(r.message).toMatch(/Conditionnement à compléter/);
  });

  it("deux dossiers INCOMPLETS de même identité ne se confondent jamais", async () => {
    const a = await creer(identite(mol("GAMMABIS"), { packaging: "" }));
    const b = await creer(identite(mol("GAMMABIS"), { packaging: "" }));
    const [da, db] = await Promise.all([lire(a.id!), lire(b.id!)]);
    expect(da.productId).not.toBeNull();
    expect(db.productId).not.toBeNull();
    expect(db.productId).not.toBe(da.productId);
  });

  it("le compléter met à jour LE MÊME produit — depuis la modification du dossier", async () => {
    const r = await creer(identite(mol("DELTA"), { packaging: "" }));
    const avant = await lire(r.id!);
    expect(avant.productId).not.toBeNull();
    ACTOR = SA;
    const u = await updateRegulatoryProduct(undefined, fd({ id: r.id!, ...identite(mol("DELTA")) }));
    expect(u.ok, u.error).toBe(true);
    const apres = await lire(r.id!);
    expect(apres.productId).toBe(avant.productId);
    expect(apres.canonicalProduct!.identityKey).toBe(identityKey({ dci: mol("DELTA"), dosage: "500", dosageUnit: "MG", form: "COMPRIME_PELLICULE", packaging: "B/30" }));
    expect(apres.canonicalProduct!.canonicalName).toContain("B/30");
    // Le message de modification reste réservé aux réserves : il ne garde pas la fenêtre ouverte.
    expect(u.message).toBeUndefined();
  });

  it("une coquille corrigée sur le SEUL dossier d'un produit corrige le produit sur place", async () => {
    const r = await creer(identite(mol("EPSI")));
    const avant = await lire(r.id!);
    ACTOR = SA;
    await updateRegulatoryProduct(undefined, fd({ id: r.id!, ...identite(mol("EPSI"), { dosage: "250" }) }));
    const apres = await lire(r.id!);
    expect(apres.productId).toBe(avant.productId); // le MÊME produit…
    expect(apres.canonicalProduct!.identityKey).not.toBe(avant.canonicalProduct!.identityKey); // …corrigé
    expect(apres.canonicalProduct!.identityKey).toBe(identityKey({ dci: mol("EPSI"), dosage: "250", dosageUnit: "MG", form: "COMPRIME_PELLICULE", packaging: "B/30" }));
    // Son nom était automatique : il suit la correction.
    expect(apres.canonicalProduct!.canonicalName).toContain("250 mg");
    expect(await prisma.auditLog.count({ where: { entityType: "PRODUCT", entityId: avant.productId!, summary: { contains: "mis à jour" } } })).toBe(1);
  });

  it("un produit PARTAGÉ (ancien catalogue) n'est pas corrigé sous les pieds de l'autre dossier : le dossier qui s'en écarte reçoit le sien", async () => {
    const a = await creer(identite(mol("ZETA")));
    const b = await creer(identite(mol("ZETA")));
    const commun = (await lire(a.id!)).productId!;
    // L'état laissé par l'ancien catalogue : deux dossiers sur UN produit.
    await prisma.regulatoryProduct.update({ where: { id: b.id! }, data: { productId: commun } });
    // Rejoué sans changement d'identité, il ne scinde rien d'office.
    expect((await ensureProduitDuDossier(b.id!)).etat).toBe("PARTAGE");
    expect((await lire(b.id!)).productId).toBe(commun);
    ACTOR = SA;
    await updateRegulatoryProduct(undefined, fd({ id: b.id!, ...identite(mol("ZETA"), { packaging: "B/60" }) }));
    expect((await lire(a.id!)).productId).toBe(commun); // a n'a pas bougé
    const nb = await lire(b.id!);
    expect(nb.productId).not.toBe(commun);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: commun }, select: { packaging: true } })).packaging).toBe("B/30");
  });

  it("une identité devenue INCOMPLÈTE ne défait pas un lien juste", async () => {
    const r = await creer(identite(mol("ETA")));
    const lien = (await lire(r.id!)).productId;
    ACTOR = SA;
    await updateRegulatoryProduct(undefined, fd({ id: r.id!, ...identite(mol("ETA"), { packaging: "" }) }));
    expect((await lire(r.id!)).productId).toBe(lien);
  });

  it("un produit de BU ajouté depuis son dossier porte le produit du dossier — même si le dossier n'en avait pas encore", async () => {
    const r = await creer(identite(mol("THETA")));
    // Le dossier perd son lien (état d'un dossier d'avant ce lot) : l'ajout à la BU doit le rattacher.
    await prisma.regulatoryProduct.update({ where: { id: r.id! }, data: { productId: null } });
    ACTOR = SA;
    const p = await createPromoProduct(fd({ regulatoryProductId: r.id! }));
    expect(p.ok, p.error).toBe(true);
    const promo = await prisma.promoProduct.findFirstOrThrow({ where: { regulatoryProductId: r.id! }, select: { id: true, productId: true } });
    promos.push(promo.id);
    const d = await lire(r.id!);
    expect(d.productId).not.toBeNull();
    expect(promo.productId).toBe(d.productId);
  });

  it("un dossier du PIPELINE, deviné par son identifiant, n'entre pas au catalogue promotionnel", async () => {
    const r = await creer(identite(mol("IOTA"), { lock: "1" }));
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: r.id! }, select: { isLocked: true } })).isLocked).toBe(true);
    ACTOR = SA;
    const p = await createPromoProduct(fd({ regulatoryProductId: r.id! }));
    expect(p.ok).toBe(false);
    expect(await prisma.promoProduct.count({ where: { regulatoryProductId: r.id! } })).toBe(0);
  });

  it("« Rattacher un produit existant » ne change que la BU — code, référent et canal restent", async () => {
    ACTOR = SA;
    const promo = await prisma.promoProduct.create({
      data: { name: `${TAG} existant`, code: "CODE-X", channel: "HOSPITAL", managerId: adminId },
      select: { id: true },
    });
    promos.push(promo.id);
    const u = await updatePromoProduct(fd({ id: promo.id, businessUnitId: "" }));
    expect(u.ok, u.error).toBe(true);
    const apres = await prisma.promoProduct.findUniqueOrThrow({ where: { id: promo.id }, select: { code: true, channel: true, managerId: true } });
    expect(apres).toEqual({ code: "CODE-X", channel: "HOSPITAL", managerId: adminId });
  });

  it("les profils HÉRITIERS suivent le dossier ; celui qu'une personne a lié ailleurs reste", async () => {
    const r = await creer(identite(mol("KAPPA")));
    const ancien = (await lire(r.id!)).productId!;
    const autre = await ensureProduct({ dci: mol("KAPPAAUTRE"), dosage: "1", dosageUnit: "MG", form: "GELULE", packaging: "B/10" });
    const [heritier, choisi] = await Promise.all([
      prisma.promoProduct.create({ data: { name: `${TAG} héritier`, regulatoryProductId: r.id!, productId: ancien }, select: { id: true } }),
      prisma.promoProduct.create({ data: { name: `${TAG} choisi`, regulatoryProductId: r.id!, productId: autre!.id }, select: { id: true } }),
    ]);
    promos.push(heritier.id, choisi.id);
    // Le produit est PARTAGÉ (un second dossier, état de l'ancien catalogue) : la correction donne au
    // dossier son propre produit au lieu de corriger celui de l'autre.
    const second = await creer(identite(mol("KAPPA")));
    await prisma.regulatoryProduct.update({ where: { id: second.id! }, data: { productId: ancien } });
    ACTOR = SA;
    await updateRegulatoryProduct(undefined, fd({ id: r.id!, ...identite(mol("KAPPA"), { packaging: "B/90" }) }));
    const nouveau = (await lire(r.id!)).productId!;
    expect(nouveau).not.toBe(ancien);
    const [h, c] = await Promise.all([
      prisma.promoProduct.findUniqueOrThrow({ where: { id: heritier.id }, select: { productId: true } }),
      prisma.promoProduct.findUniqueOrThrow({ where: { id: choisi.id }, select: { productId: true } }),
    ]);
    expect(h.productId).toBe(nouveau);
    expect(c.productId).toBe(autre!.id);
  });

  it("rattacher un produit du planning à son dossier lui donne le produit ; le défaire le lui retire", async () => {
    const r = await creer(identite(mol("LAMBDA")));
    const promo = await prisma.promoProduct.create({ data: { name: `${TAG} orphelin` }, select: { id: true } });
    promos.push(promo.id);
    const l = await linkProductToDossierFor(SA, { kind: "PROMO", id: promo.id, regulatoryProductId: r.id! });
    expect(l.ok, l.error).toBe(true);
    const produit = (await lire(r.id!)).productId;
    expect((await prisma.promoProduct.findUniqueOrThrow({ where: { id: promo.id }, select: { productId: true } })).productId).toBe(produit);
    const u = await unlinkProductFromDossierFor(SA, { kind: "PROMO", id: promo.id });
    expect(u.ok, u.error).toBe(true);
    expect((await prisma.promoProduct.findUniqueOrThrow({ where: { id: promo.id }, select: { productId: true } })).productId).toBeNull();
  });

  it("une décision OBTENUE enregistre le produit — par le seul écrivain du niveau de process", async () => {
    const r = await creer(identite(mol("MU")));
    expect((await lire(r.id!)).canonicalProduct!.lifecycle).toBe("STUDY");
    ACTOR = SA;
    const u = await updateRegulatoryStatus(fd({ id: r.id!, status: "DECISION_OBTAINED" }));
    expect(u.ok, u.error).toBe(true);
    // Prémisse : le niveau a bien été déduit jusqu'à la décision.
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: r.id! }, select: { status: true } })).status).toBe("DECISION_OBTAINED");
    expect((await lire(r.id!)).canonicalProduct!.lifecycle).toBe("REGISTERED");
  });

  it("une clé écrite par l'ANCIENNE fonction est retrouvée, pas dupliquée", async () => {
    const tuple = { dci: mol("NU"), dosage: "5", dosageUnit: "MG", form: "GELULE", packaging: "B/20" };
    const vieux = await prisma.product.create({
      data: { code: `${TAG}-OLD`, canonicalName: `${TAG} vieux`, identityKey: `${TAG}|ancienne-forme`, ...tuple },
      select: { id: true },
    });
    const p = await ensureProduct(tuple);
    expect(p!.id).toBe(vieux.id);
    expect(p!.created).toBe(false);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: vieux.id }, select: { identityKey: true } })).identityKey).toBe(identityKey(tuple));
  });

  it("concurrence : six identités distinctes à la fois → six produits, six codes, aucune erreur", async () => {
    const r = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => ensureProduct({ dci: mol(`PARA${i}`), dosage: String(i), dosageUnit: "MG", form: "GELULE", packaging: "B/30" })));
    expect(new Set(r.map((x) => x!.code)).size).toBe(6);
    expect(r.every((x) => x!.created)).toBe(true);
  });

  it("concurrence : trois dossiers de même identité, assurés deux fois chacun à la fois → TROIS produits, un par dossier, aucun orphelin", async () => {
    const ids = await Promise.all([1, 2, 3].map(() => prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-C${Math.random().toString(36).slice(2, 8)}`, dci: mol("OMICRON"), dosage: "10", dosageUnit: "MG", pharmaceuticalForm: "COMPRIME", packaging: "B/14", companyId },
      select: { id: true },
    })));
    dossiers.push(...ids.map((d) => d.id));
    await Promise.all([...ids, ...ids].map((d) => ensureProduitDuDossier(d.id)));
    const liens = await prisma.regulatoryProduct.findMany({ where: { id: { in: ids.map((d) => d.id) } }, select: { productId: true } });
    expect(liens.every((l) => l.productId !== null)).toBe(true);
    expect(new Set(liens.map((l) => l.productId)).size).toBe(3);
    expect(await prisma.product.count({ where: { dci: mol("OMICRON") } })).toBe(3);
  });

  it("concurrence : des dossiers créés à la même seconde reçoivent chacun leur référence", async () => {
    ACTOR = SA;
    const r = await Promise.all([1, 2, 3, 4].map((i) => createRegulatoryProduct(undefined, fd(identite(mol(`SIMUL${i}`))))));
    for (const x of r) { expect(x.ok, x.error).toBe(true); dossiers.push(x.id!); }
    const refs = await prisma.regulatoryProduct.findMany({ where: { id: { in: r.map((x) => x.id!) } }, select: { reference: true } });
    expect(new Set(refs.map((x) => x.reference)).size).toBe(4);
  });

  it("le catalogue montre un produit par ses DOSSIERS : celui d'un dossier verrouillé reste invisible", async () => {
    const libre = await creer(identite(mol("PI"), { responsibleId: assistId }));
    const verrou = await creer(identite(mol("RHO"), { lock: "1" }));
    const [pLibre, pVerrou] = await Promise.all([lire(libre.id!), lire(verrou.id!)]);
    const assist = await actorFor(assistId, "REGULATORY_ASSISTANT");
    // Prémisse : l'assistante voit le dossier qui la nomme, pas le dossier verrouillé.
    const vus = await prisma.regulatoryProduct.findMany({ where: { AND: [await regulatoryVisibleWhere(assist), { id: { in: [libre.id!, verrou.id!] } }] }, select: { id: true } });
    expect(vus.map((v) => v.id)).toEqual([libre.id!]);

    // Un dossier créé verrouillé n'entre au catalogue qu'à l'ouverture du cadenas ; on lui pose un produit
    // (état d'avant ce lot) pour éprouver la clause de visibilité.
    expect(pVerrou.productId).toBeNull();
    const pVerrouId = (await ensureProduct({ dci: mol("RHO"), dosage: "500", dosageUnit: "MG", form: "COMPRIME_PELLICULE", packaging: "B/30" }))!.id;
    await prisma.regulatoryProduct.update({ where: { id: verrou.id! }, data: { productId: pVerrouId } });
    Object.assign(pVerrou, { productId: pVerrouId });
    expect(await chargerProduitCanonique(assist, pLibre.productId!)).not.toBeNull();
    expect(await chargerProduitCanonique(assist, pVerrou.productId!)).toBeNull();
    expect(await canAccessEntity(assist, "PRODUCT", pVerrou.productId!, "VIEW")).toBe(false);
    expect(await canAccessEntity(assist, "PRODUCT", pLibre.productId!, "VIEW")).toBe(true);
    // Le témoin : le Super Admin, lui, le voit — sans ce cas, une clause qui ne rendrait rien passerait.
    expect(await chargerProduitCanonique(SA, pVerrou.productId!)).not.toBeNull();
  });

  it("le rapprochement des catalogues propose les dossiers de L'ÉCRAN — une gamme ne fait plus perdre portée ni verrou", async () => {
    // L'assistante réglementaire a une GAMME : c'est la seule situation où l'étalement fautif
    // (`...scopeRegulatory(user), AND: [gamme]`) écrasait la portée par ligne et le verrou.
    const gamme = await prisma.productRange.create({ data: { name: `${TAG} gamme`, companyId }, select: { id: true } });
    await prisma.userProductRange.create({ data: { userId: assistId, rangeId: gamme.id } });
    try {
      const nomme = await creer(identite(mol("RAMEAUA"), { responsibleId: assistId }));
      const verrou = await creer(identite(mol("RAMEAUB"), { lock: "1" }));
      const ailleurs = await creer(identite(mol("RAMEAUC")));
      const ids = [nomme.id!, verrou.id!, ailleurs.id!];
      await prisma.regulatoryProduct.updateMany({ where: { id: { in: ids } }, data: { rangeId: gamme.id } });
      const assist = await actorFor(assistId, "REGULATORY_ASSISTANT");
      // Prémisse : la gamme s'applique bien à elle, et l'écran ne lui montre que le dossier qui la nomme.
      expect(await productRangeScope(assistId)).not.toBeNull();
      const ecran = await prisma.regulatoryProduct.findMany({ where: { AND: [await regulatoryVisibleWhere(assist), { id: { in: ids } }] }, select: { id: true } });
      expect(ecran.map((d) => d.id)).toEqual([nomme.id!]);
      // Le rapprochement : exactement ce que l'écran montre, ni plus ni moins.
      const propose = (await getCatalogReconciliation(assist)).dossiers.map((d) => d.id).filter((id) => ids.includes(id));
      expect(propose).toEqual([nomme.id!]);
    } finally {
      await prisma.userProductRange.deleteMany({ where: { rangeId: gamme.id } });
      await prisma.regulatoryProduct.updateMany({ where: { rangeId: gamme.id }, data: { rangeId: null } });
      await prisma.productRange.delete({ where: { id: gamme.id } });
    }
  });

  it("nommer et aliaser : le réglementaire le fait, la lecture seule non — et un alias ne se vole pas", async () => {
    const r = await creer(identite(mol("SIGMA")));
    const produit = (await lire(r.id!)).productId!;
    const ops = await actorFor(opsId, "OPERATIONS_DIRECTOR");
    expect(userCan(ops, "REGULATORY", "VIEW")).toBe(true); // prémisse : il lit…
    expect(userCan(ops, "REGULATORY", "UPDATE")).toBe(false); // …sans écrire
    ACTOR = ops;
    expect((await renommerProduitCanonique(fd({ id: produit, canonicalName: "Nom pirate" }))).ok).toBe(false);
    ACTOR = SA;
    expect((await renommerProduitCanonique(fd({ id: produit, canonicalName: `${TAG} Sigmax 500` }))).ok).toBe(true);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: produit }, select: { canonicalName: true } })).canonicalName).toBe(`${TAG} Sigmax 500`);

    expect((await ajouterAliasProduitCanonique(fd({ id: produit, label: `${TAG}Sigmax` }))).ok).toBe(true);
    const autre = await creer(identite(mol("TAU")));
    const produitAutre = (await lire(autre.id!)).productId!;
    const vol = await ajouterAliasProduitCanonique(fd({ id: produitAutre, label: `${TAG}sigmax` }));
    expect(vol.ok).toBe(false);
    expect(vol.error).toMatch(/désigne déjà le produit/);
    const alias = await prisma.productAlias.findFirstOrThrow({ where: { productId: produit }, select: { id: true } });
    expect((await retirerAliasProduitCanonique(fd({ aliasId: alias.id }))).ok).toBe(true);
    expect(await prisma.productAlias.count({ where: { productId: produit } })).toBe(0);
  });

  it("le passage du démarrage : chaque dossier d'avant reçoit SON produit, un produit partagé est listé, et rejoué il ne fait plus rien", async () => {
    // Quatre dossiers « d'avant » : deux complets de même identité, un incomplet, un verrouillé — créés sans l'action.
    const base = { companyId, dosage: "20", dosageUnit: "MG", pharmaceuticalForm: "GELULE" };
    const crees = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-H1`, dci: mol("UPSI"), packaging: "B/28", ...base }, select: { id: true } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-H2`, dci: mol("UPSI"), packaging: "B/28", ...base }, select: { id: true } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-H3`, dci: mol("PHI"), ...base }, select: { id: true } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}-H4`, dci: mol("PSI"), packaging: "B/7", isLocked: true, ...base }, select: { id: true } }),
    ]);
    const ids = crees.map((c) => c.id);
    dossiers.push(...ids);
    // Un produit de BU attaché au dossier incomplet, sans produit : il doit hériter du produit du dossier.
    const promo = await prisma.promoProduct.create({ data: { name: `${TAG} promu incomplet`, regulatoryProductId: ids[2] }, select: { id: true } });
    promos.push(promo.id);
    const perimetre = { dossierIds: ids };

    const app = await assurerProduitsDesDossiers({ acteurId: adminId, perimetre });
    expect(app.dossiers).toBe(3); // le verrouillé attend l'ouverture du cadenas
    expect(app.crees).toBe(3);
    expect(app.aCompleter).toBe(1);
    expect(app.profilsSuivis).toBe(1);
    const liens = await prisma.regulatoryProduct.findMany({ where: { id: { in: ids } }, select: { productId: true }, orderBy: { reference: "asc" } });
    expect(liens[0].productId).not.toBeNull();
    expect(liens[1].productId).not.toBeNull();
    expect(liens[1].productId).not.toBe(liens[0].productId); // même identité, deux produits
    expect(liens[2].productId).not.toBeNull(); // incomplet : un produit quand même
    expect(liens[3].productId).toBeNull(); // verrouillé
    expect((await prisma.promoProduct.findUniqueOrThrow({ where: { id: promo.id }, select: { productId: true } })).productId).toBe(liens[2].productId);

    const encore = await assurerProduitsDesDossiers({ acteurId: adminId, perimetre });
    expect(encore.crees + encore.misAJour + encore.separes).toBe(0);
    expect(encore.deja).toBe(3);

    // Un produit partagé (état de l'ancien catalogue) est NOMMÉ au bilan, et pas scindé.
    await prisma.regulatoryProduct.update({ where: { id: ids[1] }, data: { productId: liens[0].productId } });
    const partage = await assurerProduitsDesDossiers({ acteurId: adminId, perimetre });
    expect(partage.produitsPartages.map((p) => p.id)).toContain(liens[0].productId);
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: ids[1] }, select: { productId: true } })).productId).toBe(liens[0].productId);
  });

  it("le geste global est réservé au Super Admin ; donner son produit à UN dossier demande de pouvoir le modifier", async () => {
    ACTOR = await actorFor(opsId, "OPERATIONS_DIRECTOR");
    expect((await verifierProduitsDesDossiers()).ok).toBe(false);
    const r = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-G1`, dci: mol("CHI"), dosage: "1", dosageUnit: "MG", pharmaceuticalForm: "GELULE", packaging: "B/7", companyId },
      select: { id: true },
    });
    dossiers.push(r.id);
    expect((await rattacherDossierCanonique(fd({ id: r.id }))).ok).toBe(false);
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: r.id }, select: { productId: true } })).productId).toBeNull();
    ACTOR = SA;
    const ok = await rattacherDossierCanonique(fd({ id: r.id }));
    expect(ok.ok, ok.error).toBe(true);
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: r.id }, select: { productId: true } })).productId).not.toBeNull();
  });

  it("une modification qui ne porte PAS les dates cibles les garde — envoyée vide, elle les efface (§118.185, I15)", async () => {
    // Le formulaire de modification n'a pas de « date cible de dépôt » : elle se règle par la
    // supervision. Chaque enregistrement l'effaçait — le champ absent était lu comme vide.
    const r = await creer(identite(mol("IOTA"), { targetDate: "2027-03-01", targetSubmissionDate: "2027-01-15" }));
    const dates = () => prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: r.id! }, select: { targetDate: true, targetSubmissionDate: true } });
    const avant = await dates();
    expect(avant.targetDate, "prémisse : la date cible est posée à la création").not.toBeNull();
    expect(avant.targetSubmissionDate, "prémisse : la date de dépôt est posée à la création").not.toBeNull();
    ACTOR = SA;
    const u = await updateRegulatoryProduct(undefined, fd({ id: r.id!, ...identite(mol("IOTA"), { comments: "corrigé" }) }));
    expect(u.ok, u.error).toBe(true);
    const apres = await dates();
    expect(apres.targetDate?.toISOString()).toBe(avant.targetDate?.toISOString());
    expect(apres.targetSubmissionDate?.toISOString()).toBe(avant.targetSubmissionDate?.toISOString());
    // Le témoin : un champ ENVOYÉ vide efface — sans lui, une garde qui ne touche jamais aux dates passerait.
    const v = await updateRegulatoryProduct(undefined, fd({ id: r.id!, ...identite(mol("IOTA")), targetSubmissionDate: "" }));
    expect(v.ok, v.error).toBe(true);
    const vide = await dates();
    expect(vide.targetSubmissionDate).toBeNull();
    expect(vide.targetDate?.toISOString()).toBe(avant.targetDate?.toISOString());
  });
});
