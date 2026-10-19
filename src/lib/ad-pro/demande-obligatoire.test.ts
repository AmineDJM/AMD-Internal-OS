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
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import { businessUnitDuDemandeur } from "./business-unit-auto";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adproblig__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA DIRECTION A RENDU OBLIGATOIRE, LE SERVEUR LE TIENT — pas le formulaire.
 *
 * L'écran marque ces champs `required`, et ce n'est PAS la garde : un champ de formulaire se
 * forge, et l'écran n'est pas la seule porte (le chemin générique d'Adam poste la même action).
 * Ce banc part donc du VRAI point d'entrée — `createSponsoring` avec un vrai `FormData` — et non
 * d'un état injecté à la main (§118.14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Une demande de sponsoring INCOMPLÈTE est refusée par le serveur", () => {
  let kamId = "", buOncoId = "", buCardioId = "", nsId = "", autreId = "";

  const fichierScan = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "demande-medecin.pdf", { type: "application/pdf" });

  /** Un formulaire COMPLET — chaque cas en retire exactement une chose. */
  const complet = (): FormData => {
    const fd = new FormData();
    fd.set("institution", `${TAG}CHU Alger`);
    fd.append("doctorIds", "Dr Benali");
    fd.append("productIds", "Nivolex");
    fd.set("city", "Alger");
    fd.set("specialty", "Cardiologie");
    fd.set("type", "Congrès");
    fd.set("amountRequested", "120000");
    fd.set("amountProposed", "90000");
    // LA NATURE DU SPONSORING (§118.151) — elle décide le poste qui naît avec la demande.
    fd.set("nature", "DIRECT");
    fd.set("strategicImportance", "HIGH");
    fd.append("files", fichierScan());
    return fd;
  };

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, ns, autre] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("ns", "NATIONAL_SALES"), mk("autre", "DIRECTION_ASSISTANT")]);
    kamId = kam.id; nsId = ns.id; autreId = autre.id;
    const [onco, cardio] = await Promise.all([
      prisma.businessUnit.create({ data: { name: `${TAG}Oncologie`, isActive: true } }),
      prisma.businessUnit.create({ data: { name: `${TAG}Cardiologie`, isActive: true, supervisorId: ns.id } }),
    ]);
    buOncoId = onco.id; buCardioId = cardio.id;
    // LE KAM EST RATTACHÉ À SA GAMME par sa fiche force de vente — c'est le lien que le code lit.
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: onco.id } });
    // LE DROIT DE CRÉER — sans lui, l'action refuse AVANT toute lecture de champ, et le banc
    // mesurerait la porte RBAC au lieu de la garde des champs obligatoires.
    await Promise.all([kam.id, autre.id].map((userId) =>
      prisma.userAccess.create({ data: { userId, module: "SPONSORING", canView: true, canCreate: true } })));
    ACTEUR = { id: kam.id, role: "MEDICAL_DELEGATE", secondaryRole: null, access: await getAccess(kam.id, "MEDICAL_DELEGATE") } as unknown as SessionUser;
  });

  afterAll(async () => {
    const demandes = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } });
    const ids = demandes.map((d) => d.id);
    if (ids.length) {
      await prisma.document.deleteMany({ where: { entityType: "SPONSORING", entityId: { in: ids } } }).catch(() => {});
      await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
      await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
      await prisma.sponsoringRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    }
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: [kamId, nsId, autreId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("chaque champ RETIRÉ est NOMMÉ dans le refus — et tous en une fois, pas un par aller-retour", async () => {
    // §118.18 : un refus par champ ferait ressaisir six fois un formulaire de quinze champs.
    const fd = complet();
    fd.delete("city");
    fd.delete("specialty");
    fd.delete("amountRequested");
    const r = await createSponsoring(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("wilaya");
    expect(r.error).toContain("spécialité");
    // Le libellé que la Direction a nommé : un SPONSORING demandé, pas un « budget » (§118.151).
    expect(r.error).toContain("sponsoring demandé par le médecin");
  });

  it.each([
    ["doctorIds", "médecins"],
    ["productIds", "produits"],
    ["type", "le type"],
    ["amountProposed", "sponsoring suggéré par le délégué"],
    ["nature", "nature du sponsoring"],
    ["strategicImportance", "importance stratégique"],
  ])("sans « %s », la demande est refusée en nommant « %s »", async (champ, attendu) => {
    const fd = complet();
    fd.delete(champ);
    const r = await createSponsoring(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain(attendu);
  });

  it("SANS la demande du médecin : refus, avec la mention du bureau du secrétariat", async () => {
    const fd = complet();
    fd.delete("files");
    const r = await createSponsoring(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("scannée");
    expect(r.ok === false ? r.error : "").toContain("bureau du secrétariat");
  });

  it("une demande du médecin qui n'est NI un PDF NI un Word est refusée, en nommant le fichier", async () => {
    // L'`accept` du formulaire ne guide que le sélecteur de fichiers : il ne s'applique pas à un
    // envoi qui ne vient pas de cet écran.
    const fd = complet();
    fd.delete("files");
    fd.append("files", new File([new Uint8Array([1, 2, 3])], "photo-du-courrier.png", { type: "image/png" }));
    const r = await createSponsoring(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("photo-du-courrier.png");
  });

  it("un EXCEL se joint en « autres pièces » — mais ne remplace pas la demande du médecin", async () => {
    const excel = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])], "participants.xlsx");
    // Seul, à la place du scan : toujours refusé, la demande du médecin reste un PDF ou un Word.
    const seul = complet();
    seul.delete("files");
    seul.append("files", excel());
    const refus = await createSponsoring(undefined, seul);
    expect(refus.ok).toBe(false);
    expect(refus.ok === false ? refus.error : "").toContain("participants.xlsx");

    // À côté du scan : accepté, et rangé comme pièce justificative.
    const fd = complet();
    fd.append("annexes", excel());
    fd.append("annexes", new File([new Uint8Array([0x41, 0x3b, 0x42])], "liste.csv"));
    const r = await createSponsoring(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const docs = await prisma.document.findMany({ where: { entityType: "SPONSORING", entityId: r.ok ? r.id! : "" }, select: { name: true, category: true } });
    expect(docs).toEqual(expect.arrayContaining([
      { name: "demande-medecin.pdf", category: "REQUEST_LETTER" },
      { name: "participants.xlsx", category: "SUPPORTING_DOC" },
      { name: "liste.csv", category: "SUPPORTING_DOC" },
    ]));
  });

  it("un PROGRAMME en « autres pièces » est refusé, et la demande n'est PAS créée", async () => {
    const avant = await prisma.sponsoringRequest.count({ where: { institution: { startsWith: TAG } } });
    const fd = complet();
    fd.append("annexes", new File([new Uint8Array([0x4d, 0x5a, 0x90])], "outil.exe"));
    const r = await createSponsoring(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("outil.exe");
    expect(await prisma.sponsoringRequest.count({ where: { institution: { startsWith: TAG } } })).toBe(avant);
  });

  it("COMPLÈTE, elle passe — et la gamme du KAM est celle de sa fiche, PAS celle qu'il a postée", async () => {
    // LA GARDE QUI COMPTE. Le champ était un menu libre : un KAM de l'oncologie pouvait poster
    // la cardiologie et faire peser sa dépense sur le budget Ad&Pro d'une autre gamme. Le
    // pré-remplissage seul n'y changerait rien — un champ de formulaire se forge.
    const fd = complet();
    fd.set("businessUnitId", buCardioId); // ← la gamme d'une AUTRE équipe, forgée
    const r = await createSponsoring(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const cree = await prisma.sponsoringRequest.findFirstOrThrow({
      where: { institution: { startsWith: TAG } }, orderBy: { createdAt: "desc" },
    });
    expect(cree.businessUnitId, "la gamme se lit sur la PERSONNE, pas sur le formulaire").toBe(buOncoId);
    expect(cree.doctor).toBe("Dr Benali");
    expect(cree.product).toBe("Nivolex");
    expect(cree.status, "un KAM part de l'approbation préliminaire de son superviseur national").toBe("AWAITING_PRELIMINARY");
    expect(cree.nature).toBe("DIRECT");
    // LE POSTE NAÎT AVEC LA DEMANDE (§118.151) — un seul, dans la même écriture, et il porte ce
    // que la Direction a nommé : le sponsoring direct, chiffré à ce que SUGGÈRE le délégué, versé
    // à l'association, avec la demande du médecin dite dans ses précisions.
    const postes = await prisma.adProItem.findMany({ where: { sponsoringId: cree.id } });
    expect(postes, "une demande sans son poste est ce que la Direction ne veut plus voir").toHaveLength(1);
    expect(postes[0].kind).toBe("ASSOCIATION_SUPPORT");
    expect(Number(postes[0].amountEstimated)).toBe(90_000);
    expect(postes[0].supplier, "le sponsoring direct se verse à l'association").toBe(`${TAG}CHU Alger`);
    expect(postes[0].notes).toContain("120");
    expect(postes[0].status, "le poste se décide ensuite, comme tout poste").toBe("DRAFT");
    expect(postes[0].addedAfterDecision).toBe(false);
  });

  it("INDIRECT : le poste est une prise en charge, sans bénéficiaire deviné", async () => {
    // Un sponsoring indirect paie des prestataires que personne ne connaît encore : le
    // bénéficiaire reste VIDE plutôt que d'être rempli par l'association, qui ne recevra rien.
    ACTEUR = { id: kamId, role: "MEDICAL_DELEGATE", secondaryRole: null, access: await getAccess(kamId, "MEDICAL_DELEGATE") } as unknown as SessionUser;
    const fd = complet();
    fd.set("institution", `${TAG}Société indirecte`);
    fd.set("nature", "INDIRECT");
    const r = await createSponsoring(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const cree = await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: `${TAG}Société indirecte` }, include: { items: true } });
    expect(cree.nature).toBe("INDIRECT");
    expect(cree.items).toHaveLength(1);
    expect(cree.items[0].kind).toBe("INDIRECT_SUPPORT");
    expect(cree.items[0].supplier).toBeNull();
  });

  it("une nature INVENTÉE est refusée comme une nature absente — jamais un poste deviné", async () => {
    const fd = complet();
    fd.set("institution", `${TAG}Nature forgée`);
    fd.set("nature", "MIXTE");
    const r = await createSponsoring(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("nature du sponsoring");
    expect(await prisma.sponsoringRequest.count({ where: { institution: `${TAG}Nature forgée` } })).toBe(0);
  });

  it("un demandeur SANS gamme déductible garde la main : sa saisie est retenue", async () => {
    ACTEUR = { id: autreId, role: "DIRECTION_ASSISTANT", secondaryRole: null, access: await getAccess(autreId, "DIRECTION_ASSISTANT") } as unknown as SessionUser;
    const fd = complet();
    fd.set("institution", `${TAG}Assoc libre`);
    fd.set("businessUnitId", buCardioId);
    const r = await createSponsoring(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const cree = await prisma.sponsoringRequest.findFirstOrThrow({ where: { institution: `${TAG}Assoc libre` } });
    expect(cree.businessUnitId).toBe(buCardioId);
    expect(cree.status, "tout demandeur non-KAM part de l'arbitrage de Direction Marketing").toBe("PRELIMINARY_APPROVED");
  });
});

suite("La gamme d'une demande se DÉDUIT de son auteur — quand elle se déduit", () => {
  const TAG2 = "__adprobu__";
  let kamId = "", nsUneId = "", nsDeuxId = "", buId = "", bu2Id = "", bu3Id = "";

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG2}${s}`, email: `${TAG2}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, ns1, ns2] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("ns1", "NATIONAL_SALES"), mk("ns2", "NATIONAL_SALES")]);
    kamId = kam.id; nsUneId = ns1.id; nsDeuxId = ns2.id;
    const [b1, b2, b3] = await Promise.all([
      prisma.businessUnit.create({ data: { name: `${TAG2}Onco`, isActive: true } }),
      prisma.businessUnit.create({ data: { name: `${TAG2}Cardio`, isActive: true, supervisorId: ns1.id } }),
      prisma.businessUnit.create({ data: { name: `${TAG2}Neuro`, isActive: true, supervisorId: ns2.id } }),
    ]);
    buId = b1.id; bu2Id = b2.id; bu3Id = b3.id;
    // Le second superviseur en supervise DEUX — cas de l'ambiguïté.
    await prisma.businessUnit.update({ where: { id: b2.id }, data: { supervisorId: ns1.id } });
    await prisma.businessUnit.updateMany({ where: { id: { in: [b3.id] } }, data: { supervisorId: ns2.id } });
    await prisma.businessUnit.create({ data: { name: `${TAG2}Neuro2`, isActive: true, supervisorId: ns2.id } });
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: b1.id } });
  });

  afterAll(async () => {
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: [kamId, nsUneId, nsDeuxId] } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG2 } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG2 } } }).catch(() => {});
  });

  it("un KAM : sa gamme vient de sa FICHE force de vente, et la phrase le DIT", async () => {
    const d = await businessUnitDuDemandeur({ id: kamId, role: "MEDICAL_DELEGATE" });
    expect(d?.id).toBe(buId);
    expect(d?.raison).toContain("force de vente");
  });

  it("un superviseur national d'UNE seule gamme : c'est celle-là", async () => {
    const d = await businessUnitDuDemandeur({ id: nsUneId, role: "NATIONAL_SALES" });
    expect(d?.id).toBe(bu2Id);
    expect(d?.raison).toContain("superviseur national");
  });

  it("un superviseur de DEUX gammes n'en désigne AUCUNE — on ne choisit pas laquelle paiera", async () => {
    // Ce qui le ferait tomber : prendre la première. On choisirait à sa place la gamme dont le
    // budget est engagé, et l'erreur serait invisible — la demande passerait (§118.34).
    expect(await businessUnitDuDemandeur({ id: nsDeuxId, role: "NATIONAL_SALES" })).toBeNull();
    expect(bu3Id).not.toBe("");
  });

  it("un demandeur hors force de vente : rien à déduire, la saisie reste manuelle", async () => {
    expect(await businessUnitDuDemandeur({ id: kamId, role: "DIRECTION_ASSISTANT" })).toBeNull();
    expect(await businessUnitDuDemandeur({ id: "inexistant", role: "MEDICAL_DELEGATE" })).toBeNull();
  });
});
