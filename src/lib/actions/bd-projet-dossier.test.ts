import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { setRegulatoryClassification } from "./regulatory-actions";
import { setRegulatoryHiddenColumns } from "./settings-actions";
import { getAppSettings } from "@/lib/settings";
import { buildProposal, performAction, type AssistantActionPayload } from "@/lib/assistant";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bdprojet__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CLASSER UN DOSSIER PAR PROJET, ET RETIRER UNE COLONNE — par les VRAIS points d'entrée.
 *
 * Un test qui écrirait `bdProjectId` en base directement prouverait que Prisma fonctionne. On
 * part donc de l'action serveur que l'écran appelle, et l'on vérifie EN BASE ce qui a changé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Projet BD sur un dossier réglementaire", () => {
  let pdgId = "", produitId = "", projetId = "", autreProjetId = "";

  beforeAll(async () => {
    const pdg = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    });
    pdgId = pdg.id;
    const company = await prisma.company.create({ data: { name: `${TAG}co` } });
    const [p, projet, autre] = await Promise.all([
      prisma.regulatoryProduct.create({
        data: { reference: `${TAG}REG-1`, dci: "Nivolex", companyId: company.id, createdById: pdg.id },
        select: { id: true },
      }),
      prisma.bdProject.create({ data: { name: `${TAG}Oncologie 2027`, createdById: pdg.id }, select: { id: true } }),
      prisma.bdProject.create({ data: { name: `${TAG}Cardio 2028`, createdById: pdg.id }, select: { id: true } }),
    ]);
    produitId = p.id; projetId = projet.id; autreProjetId = autre.id;
  }, 120_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.bdProject.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.appSetting.updateMany({ where: { id: "global" }, data: { regulatoryHiddenColumns: [] } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  it("range un dossier dans un projet, puis l'en change", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    expect((await setRegulatoryClassification(fd({ id: produitId, bdProjectId: projetId }))).ok).toBe(true);
    let row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProjectId: true } });
    expect(row?.bdProjectId).toBe(projetId);

    expect((await setRegulatoryClassification(fd({ id: produitId, bdProjectId: autreProjetId }))).ok).toBe(true);
    row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProjectId: true } });
    expect(row?.bdProjectId).toBe(autreProjetId);
  });

  it("une valeur VIDE retire le classement — et ce n'est pas « ne pas y toucher »", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    await setRegulatoryClassification(fd({ id: produitId, bdProjectId: projetId }));
    expect((await setRegulatoryClassification(fd({ id: produitId, bdProjectId: "" }))).ok).toBe(true);
    const row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProjectId: true } });
    expect(row?.bdProjectId).toBeNull();
  });

  /**
   * ACCEPTER UN IDENTIFIANT INCONNU rangerait le dossier dans un projet que personne ne
   * retrouverait, et l'écran afficherait une case vide sans rien dire — un faux succès.
   */
  it("REFUSE un projet inconnu, et n'écrit rien", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    await setRegulatoryClassification(fd({ id: produitId, bdProjectId: projetId }));
    const r = await setRegulatoryClassification(fd({ id: produitId, bdProjectId: "projet-qui-nexiste-pas" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("inconnu");
    const row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProjectId: true } });
    expect(row?.bdProjectId).toBe(projetId);
  });

  it("ne touche PAS au projet quand la clé est absente — l'empreinte ne dépasse pas la demande", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    await setRegulatoryClassification(fd({ id: produitId, bdProjectId: projetId }));
    // On ne change que les segments : le projet doit survivre intact (§118.16).
    expect((await setRegulatoryClassification(fd({ id: produitId, segments: "" }))).ok).toBe(true);
    const row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProjectId: true } });
    expect(row?.bdProjectId).toBe(projetId);
  });
});

suite("Colonnes masquées du tableau Regulatory — le réglage de la maison", () => {
  let pdgId = "";

  beforeAll(async () => {
    const pdg = await prisma.user.create({
      data: { name: `${TAG}adm`, email: `${TAG}adm@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    });
    pdgId = pdg.id;
  }, 120_000);

  afterAll(async () => {
    await prisma.appSetting.updateMany({ where: { id: "global" }, data: { regulatoryHiddenColumns: [] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  const cols = (...keys: string[]) => {
    const f = new FormData();
    for (const k of keys) f.append("columns", k);
    return f;
  };

  it("enregistre les colonnes retirées, et `getAppSettings` les rend", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    expect((await setRegulatoryHiddenColumns(cols("therapeuticClass"))).ok).toBe(true);
    const row = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { regulatoryHiddenColumns: true } });
    expect(row?.regulatoryHiddenColumns).toEqual(["therapeuticClass"]);
    // ET LE LECTEUR LES REND : un réglage écrit que personne ne relit est une promesse d'écran.
    expect((await getAppSettings()).regulatoryHiddenColumns).toEqual(["therapeuticClass"]);
  });

  it("REFUSE une clé inconnue et la RÉFÉRENCE — le formulaire ne fait pas foi", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    expect((await setRegulatoryHiddenColumns(cols("colonneInventee"))).ok).toBe(false);
    const r = await setRegulatoryHiddenColumns(cols("reference"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("identifie la ligne");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « RANGE CE DOSSIER DANS LE PROJET ONCOLOGIE 2027 » — par le chemin d'Adam.
 *
 * L'op `set_classification` DÉCLARE couvrir `setRegulatoryClassification`. Ajouter un axe de
 * classement à l'action sans l'ajouter à l'op aurait rendu cette déclaration à moitié fausse :
 * la parité aurait affiché 100 % sur une capacité que la conversation ne sait pas atteindre
 * (§118.14). Ces essais partent donc de `buildProposal` — le vrai point d'entrée — et vérifient
 * EN BASE ce que la confirmation a écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Adam range un dossier dans un projet BD", () => {
  let pdgId = "", produitId = "", reference = "", projetNom = "", autreNom = "";

  beforeAll(async () => {
    const pdg = await prisma.user.create({
      data: { name: `${TAG}chief`, email: `${TAG}chief@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    });
    pdgId = pdg.id;
    const company = await prisma.company.create({ data: { name: `${TAG}coa` } });
    reference = `${TAG}REG-9`;
    projetNom = `${TAG}Oncologie 2027`;
    autreNom = `${TAG}Oncologie 2028`;
    const [p] = await Promise.all([
      prisma.regulatoryProduct.create({
        data: { reference, dci: "Trastuzex", companyId: company.id, createdById: pdg.id },
        select: { id: true },
      }),
      prisma.bdProject.create({ data: { name: projetNom, createdById: pdg.id } }),
      prisma.bdProject.create({ data: { name: autreNom, createdById: pdg.id } }),
    ]);
    produitId = p.id;
  }, 120_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.bdProject.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  it("propose puis ÉCRIT le classement — et le projet apparaît dans la carte de confirmation", async () => {
    const chief = await acteur(pdgId, "SUPER_ADMIN");
    ACTOR = chief;
    const p = await buildProposal("regulatory_operation", { op: "set_classification", reference, project: projetNom }, chief);
    expect("error" in p, "error" in p ? String((p as { error: string }).error) : "").toBe(false);
    if ("error" in p) return;
    // LA CARTE MONTRE LE NOM DU PROJET : on ne confirme pas un identifiant technique.
    expect(p.fields.some((f) => f.label === "Projet BD" && f.value === projetNom)).toBe(true);

    const r = await performAction(chief, p.payload as AssistantActionPayload);
    expect(r.ok, r.error).toBe(true);
    const row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProject: { select: { name: true } } } });
    expect(row?.bdProject?.name).toBe(projetNom);
  });

  /**
   * ON NE DEVINE JAMAIS. « Oncologie » correspond à DEUX projets : choisir le premier rangerait
   * le dossier dans le mauvais en annonçant que c'est fait (§118.34). Le refus les NOMME.
   */
  it("REFUSE un nom qui correspond à plusieurs projets, et les nomme", async () => {
    const chief = await acteur(pdgId, "SUPER_ADMIN");
    ACTOR = chief;
    const p = await buildProposal("regulatory_operation", { op: "set_classification", reference, project: `${TAG}Oncologie` }, chief);
    expect("error" in p).toBe(true);
    if ("error" in p) {
      expect(p.error).toContain("Plusieurs projets");
      expect(p.error).toContain(projetNom);
      expect(p.error).toContain(autreNom);
    }
  });

  it("REFUSE un projet inexistant, et dit où les projets se créent", async () => {
    const chief = await acteur(pdgId, "SUPER_ADMIN");
    ACTOR = chief;
    const p = await buildProposal("regulatory_operation", { op: "set_classification", reference, project: "Projet Fantôme" }, chief);
    expect("error" in p).toBe(true);
    if ("error" in p) expect(p.error).toContain("Business Development");
  });

  it("« aucun » RETIRE le classement — c'est un geste voulu, pas un « ne pas y toucher »", async () => {
    const chief = await acteur(pdgId, "SUPER_ADMIN");
    ACTOR = chief;
    const pose = await buildProposal("regulatory_operation", { op: "set_classification", reference, project: projetNom }, chief);
    if (!("error" in pose)) await performAction(chief, pose.payload as AssistantActionPayload);

    const p = await buildProposal("regulatory_operation", { op: "set_classification", reference, project: "aucun" }, chief);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    const r = await performAction(chief, p.payload as AssistantActionPayload);
    expect(r.ok, r.error).toBe(true);
    const row = await prisma.regulatoryProduct.findUnique({ where: { id: produitId }, select: { bdProjectId: true } });
    expect(row?.bdProjectId).toBeNull();
  });
});
