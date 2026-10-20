import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  createRegulatoryProduct, checkDciDuplicate, requestRegulatoryDossierAccess,
} from "./regulatory-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__dciDoublon__";

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

/**
 * « CETTE DCI EXISTE DÉJÀ » — depuis le VRAI point d'entrée, celui du formulaire.
 *
 * ── LE DÉFAUT QU'ON FERME ───────────────────────────────────────────────────────────────────
 *
 * Rien n'empêchait d'ouvrir un second dossier sur une molécule déjà suivie. Deux dossiers pour
 * un même produit, ce ne sont pas deux lignes en trop : ce sont deux historiques réglementaires
 * parallèles, deux séries d'étapes ANPP, deux interlocuteurs — et l'un des deux finit par vivre
 * sa vie sans que personne ne le sache.
 *
 * ── CE QUE CE FICHIER TIENT, ET QUE LE MODULE PUR NE PEUT PAS TENIR ─────────────────────────
 *
 * `dci-duplicate.test.ts` prouve que le message est juste À PARTIR D'UN ÉTAT DONNÉ. Il ne dit
 * rien de la question qui compte : ce que voit réellement la personne qui saisit. C'est ici que
 * se vérifie le seul point vraiment coûteux à rater — un dossier VERROUILLÉ au pipeline doit se
 * COMPTER sans jamais se NOMMER. Un test monté sur un état injecté à la main répondrait « la
 * fonction sait lire un objet », pas « le serveur ne fuit pas ».
 *
 * On part donc de `createRegulatoryProduct`, `checkDciDuplicate` et
 * `requestRegulatoryDossierAccess` — les trois portes que le formulaire pousse.
 */
suite("Une DCI déjà présente est signalée avant la création", () => {
  let adminId = "";
  let assistId = "";
  let companyId = "";
  const crees: string[] = [];

  const DCI_LIBRE = `${TAG}-ATORVASTATINE`;
  const DCI_VERROU = `${TAG}-METFORMINE`;
  const DCI_ASSOC = `${TAG}-AMOXICILLINE + ${TAG}-ACIDE CLAVULANIQUE`;

  const creer = async (extra: Record<string, string>) => {
    const r = await createRegulatoryProduct(undefined, fd({ companyId, ...extra }));
    if (r.ok && r.id) crees.push(r.id);
    return r;
  };

  // CHAQUE DOSSIER EST UN PRODUIT (88c1a130) : créer un dossier inscrit sa molécule au catalogue canonique. Ces produits
  // portent la DCI du banc ; restés d'un passage précédent, ils feraient dire « existe déjà dans le référentiel » à la DCI
  // neuve du premier cas. Purgés avant ET après, par leur DCI marquée.
  const purgerProduitsDuBanc = () => prisma.product.deleteMany({ where: { dci: { startsWith: TAG, mode: "insensitive" } } });

  beforeAll(async () => {
    await purgerProduitsDuBanc();
    const c = await prisma.company.findFirst({ where: { isActive: true }, select: { id: true } });
    companyId = c?.id ?? (await prisma.company.create({
      data: { name: `${TAG} Entité`, shortName: TAG, isActive: true },
      select: { id: true },
    })).id;

    const [a, b] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} admin`, email: `${TAG}a@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} assistante`, email: `${TAG}b@t.dz`, role: "REGULATORY_ASSISTANT", passwordHash: "x" }, select: { id: true } }),
    ]);
    adminId = a.id; assistId = b.id;

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    // Un dossier ORDINAIRE, et un dossier au PIPELINE (verrouillé) : les deux cas que
    // l'avertissement doit distinguer.
    const libre = await creer({ dci: DCI_LIBRE, brandName: "Advastine", dosage: "20", pharmaceuticalForm: "TABLET", confirmDuplicate: "1" });
    expect(libre.ok, libre.error).toBe(true);
    const verrou = await creer({ dci: DCI_VERROU, lock: "1", confirmDuplicate: "1" });
    expect(verrou.ok, verrou.error).toBe(true);
    const verrouille = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: verrou.id! }, select: { isLocked: true } });
    expect(verrouille.isLocked, "le dossier du pipeline doit naître verrouillé").toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (crees.length) {
      await prisma.regulatoryStep.deleteMany({ where: { productId: { in: crees } } }).catch(() => {});
      await prisma.regulatoryProduct.deleteMany({ where: { id: { in: crees } } }).catch(() => {});
    }
    await purgerProduitsDuBanc();
    await prisma.notification.deleteMany({ where: { body: { contains: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, assistId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { shortName: TAG } }).catch(() => {});
  }, 120_000);

  it("UNE DCI NEUVE PASSE SANS UN MOT — un avertissement sur tout ne se lit plus", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    expect((await checkDciDuplicate(`${TAG}-RIEN-DE-TEL`)).notice).toBeNull();
    const r = await creer({ dci: `${TAG}-RIEN-DE-TEL` });
    expect(r.ok, r.error).toBe(true);
  });

  it("LA CRÉATION EST RETENUE quand la DCI existe — et le message NOMME le dossier à vérifier", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await creer({ dci: DCI_LIBRE.toLowerCase() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("porte déjà");
    expect(r.error).toMatch(/REG-\d{4}-/);
    expect(r.error).toContain("Advastine");
    expect(r.error).toMatch(/dosage.+forme.+différent/);
  });

  it("…mais elle PASSE dès que la personne a vérifié — on avertit, on n'interdit pas", async () => {
    // Une même DCI porte légitimement plusieurs dossiers (autre dosage, autre forme, autre
    // partenaire). Interdire ferait saisir le second sous une DCI mal orthographiée : plus
    // rapprochable du premier, donc pire que le doublon.
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await creer({ dci: DCI_LIBRE, dosage: "40", confirmDuplicate: "1" });
    expect(r.ok, r.error).toBe(true);
  });

  it("UNE ASSOCIATION EST LA MÊME DANS LES DEUX SENS — sinon le doublon cherché passe", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const premier = await creer({ dci: DCI_ASSOC, confirmDuplicate: "1" });
    expect(premier.ok, premier.error).toBe(true);
    const inverse = `${TAG}-ACIDE CLAVULANIQUE + ${TAG}-AMOXICILLINE`;
    const second = await creer({ dci: inverse });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("porte déjà");
  });

  it("LE DOSSIER VERROUILLÉ SE COMPTE MAIS NE SE NOMME PAS — c'est tout l'enjeu", async () => {
    // L'assistante n'a pas accès au pipeline : elle doit apprendre qu'un dossier existe SANS
    // apprendre lequel. Le contraire ferait de l'avertissement une fuite du portefeuille à
    // l'étude — exactement ce que le verrou protège.
    ACTOR = await actorFor(assistId, "REGULATORY_ASSISTANT");
    const { notice, canRequestAccess } = await checkDciDuplicate(DCI_VERROU);
    expect(notice).not.toBeNull();
    expect(notice!).toContain("ne vous est pas visible");
    expect(notice!).not.toMatch(/REG-\d{4}-/);
    expect(canRequestAccess).toBe(true);
  });

  it("…et le Super Admin, lui, LE VOIT nommé : c'est la portée qui parle, pas une règle à part", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const { notice, canRequestAccess } = await checkDciDuplicate(DCI_VERROU);
    expect(notice!).toMatch(/REG-\d{4}-/);
    expect(notice!).not.toContain("ne vous est pas visible");
    expect(canRequestAccess).toBe(false);
  });

  it("LA DEMANDE D'ACCÈS PART, et prévient la supervision Regulatory", async () => {
    ACTOR = await actorFor(assistId, "REGULATORY_ASSISTANT");
    const r = await requestRegulatoryDossierAccess(DCI_VERROU);
    expect(r.ok, r.error).toBe(true);
    const notif = await prisma.notification.findFirst({
      where: { userId: adminId, title: { contains: "Demande d'accès" } },
      orderBy: { createdAt: "desc" },
      select: { link: true, body: true },
    });
    // Elle conduit là où l'accès se règle, et ne nomme aucun dossier caché.
    expect(notif?.link).toBe("/admin/access");
    expect(notif?.body).not.toMatch(/REG-\d{4}-/);
  });

  it("ON NE DEMANDE PAS UN ACCÈS QU'ON A DÉJÀ — sinon le bouton devient une sonnette", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await requestRegulatoryDossierAccess(DCI_VERROU);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà visible/);
  });
});
