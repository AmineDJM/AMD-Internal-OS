import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import {
  addAdProItem, ajouterVoyageur, modifierVoyageur, ajouterDevisVoyageur, validerDevisVoyageur,
  demanderBCBilletterie, retirerDevisDuPoste,
} from "@/lib/actions/ad-pro-item-actions";
import { loadAdProItems } from "@/lib/queries/ad-pro-items";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__voydevis__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};
/**
 * Des octets PROPRES À CHAQUE PIÈCE : deux devis distincts n'ont jamais le même fichier. Le même fichier redéposé est la
 * MÊME pièce, que `ajouterDevisVoyageur` ne duplique plus (banc `bc-meme-piece-flow.test.ts`).
 */
const pdf = (nom: string) => new File([new TextEncoder().encode(`%PDF-1 ${nom}`)], nom, { type: "application/pdf" });

/**
 * ENTRELACEMENT FORCÉ (§118.164e) : la transaction du banc verrouille les lignes visées ; les gestes
 * partent, se bloquent sur ces lignes, et ne sont relâchés qu'une fois TOUS bloqués — sans quoi deux
 * gestes « simultanés » se succéderaient parfois et le cas passerait sans la garde (§118.65).
 */
async function sousBarriere<T>(ids: string[], gestes: () => Promise<T>[], attendus: number): Promise<T[]> {
  let resultats: Promise<T[]> | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT id FROM "AdProVoyageurDevis" WHERE id = ANY($1::text[]) FOR UPDATE`, ids);
    const moi = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    resultats = Promise.all(gestes());
    const debut = Date.now();
    for (;;) {
      const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `WITH RECURSIVE ch(pid) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a, ch WHERE ch.pid = ANY(pg_blocking_pids(a.pid)))
         SELECT count(*)::bigint AS n FROM ch WHERE pid <> $1::int`, moi[0]!.pid,
      );
      if (Number(r[0]!.n) >= attendus) break;
      if (Date.now() - debut > 20_000) throw new Error(`barrière : ${r[0]!.n} geste(s) bloqué(s) sur ${attendus}`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }, { timeout: 30_000 });
  return resultats!;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VOYAGEURS D'UNE BILLETTERIE, PAR LES VRAIES ACTIONS (§118.205) — trajet, mode, le devis de
 * l'agence pour chacun, la proposition retenue, puis le BC du poste d'après elle.
 *
 * L'acteur est le demandeur, un National Sales SANS vue globale (§118.104). Le DÉCOR pose l'état que
 * la prévalidation de la demande puis l'accord de la Direction Marketing auraient fixé (tenue
 * prévalidée, poste accordé, montant, budget) : ce banc éprouve la suite, pas la validation — qui a
 * ses propres bancs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Billetterie — trajet, transport, devis par voyageur, BC", () => {
  let nsId = "", asstId = "", kamId = "", catId = "", spoId = "", posteId = "";
  let amel = "", yacine = "";
  let devisA = "", devisB = "", devisY = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    const [ns, asst, kam] = await Promise.all([mk("ns", "NATIONAL_SALES"), mk("asst", "DIRECTION_ASSISTANT"), mk("kam", "MEDICAL_DELEGATE")]);
    nsId = ns.id; asstId = asst.id; kamId = kam.id;
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Ad&Pro`, modules: ["SPONSORING"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 5_000_000,
        categories: { create: [{ name: `${TAG}Sponsoring`, module: "SPONSORING", allocated: 5_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0]!.id;

    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const f = new FormData();
    f.set("institution", `${TAG}Société de cardiologie`);
    f.set("doctorHorsAnnuaire", "Dr Amel Haddad");
    f.append("productIds", `${TAG}Nivolex`);
    f.set("city", "Alger"); f.set("specialty", "Cardiologie"); f.set("type", "Congrès");
    f.set("amountRequested", "300000"); f.set("amountProposed", "200000");
    f.set("nature", "DIRECT"); f.set("strategicImportance", "HIGH");
    f.append("files", pdf(`${TAG}demande.pdf`));
    const s = await createSponsoring(undefined, f);
    if (!s.ok) throw new Error(s.error);
    spoId = s.id!;
    // DÉCOR : la tenue est PRÉVALIDÉE par la Direction Marketing (27/10/2026) — aucun poste ne s'ajoute avant.
    await prisma.sponsoringRequest.update({ where: { id: spoId }, data: { status: "PRE_VALIDATED" } });
    const add = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Billets Paris`, kind: "TICKETING", amountEstimated: "100000" }));
    if (!add.ok) throw new Error(add.error);
    posteId = add.id!;
    // DÉCOR : la Direction Marketing a accepté le poste (un seul temps, 27/10/2026) — 100 000 DZD, budget choisi.
    await prisma.adProItem.update({
      where: { id: posteId },
      data: { status: "APPROVED", amountGranted: 100_000, budgetCategoryId: catId, opsDecidedAt: new Date() },
    });
  }, 60_000);

  afterAll(async () => {
    const legaux = await prisma.legalDocument.findMany({ where: { OR: [{ sourceId: spoId }, { title: { contains: TAG } }] }, select: { id: true } }).catch(() => []);
    const lids = legaux.map((l) => l.id);
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: posteId } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: [spoId, posteId, ...lids] } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: posteId } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: lids } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: spoId } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: spoId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [spoId, posteId] } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
  }, 60_000);

  const voyageurVu = async (id: string) => {
    const rows = await loadAdProItems("SPONSORING", spoId);
    const v = rows.find((r) => r.id === posteId)?.voyageurs.find((x) => x.id === id);
    expect(v, "le voyageur doit être lu par le chargeur de l'écran").toBeDefined();
    return v!;
  };
  const deposer = async (voyageurId: string, nom: string, montant: string) => {
    const f = fd({ voyageurId, montant, reference: `${TAG}${nom}` });
    f.append("attachment", pdf(`${TAG}${nom}.pdf`));
    const r = await ajouterDevisVoyageur(undefined, f);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    return r.id!;
  };
  const retenus = (voyageurId: string) => prisma.adProVoyageurDevis.count({ where: { voyageurId, retenuLe: { not: null } } });

  it("prémisses : le demandeur n'a pas la vue globale ; le KAM ne voit pas cette demande", async () => {
    expect(hasGlobalView("NATIONAL_SALES")).toBe(false);
    const kam = await acteur(kamId, "MEDICAL_DELEGATE");
    expect(await canAccessEntity(kam, "SPONSORING", spoId, "VIEW")).toBe(false);
  });

  it("ALLER SIMPLE : la date de retour envoyée est vidée ; le mode de transport s'enregistre", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await ajouterVoyageur(undefined, fd({
      itemId: posteId, nom: "Dr Amel Haddad", trajet: "ALLER_SIMPLE", transport: "TRAIN", dateDepart: "2026-11-12", dateRetour: "2026-11-15",
      villeDepart: "Alger", villeArrivee: "Oran",
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    amel = r.id!;
    const v = await voyageurVu(amel);
    expect(v).toMatchObject({ trajet: "ALLER_SIMPLE", transport: "TRAIN", dateRetour: null, dateDepart: "2026-11-12" });
    const y = await ajouterVoyageur(undefined, fd({ itemId: posteId, nom: "Dr Yacine Ouali" }));
    yacine = y.ok ? y.id! : "";
    expect(await voyageurVu(yacine)).toMatchObject({ trajet: "ALLER_RETOUR", transport: null });
  });

  it("modifier : passer en aller-retour garde la date ; un formulaire partiel « aller simple » vide le retour et rien d'autre (§118.152c)", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r1 = await modifierVoyageur(undefined, fd({ id: amel, trajet: "ALLER_RETOUR", dateRetour: "2026-11-15" }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    expect(await voyageurVu(amel)).toMatchObject({ trajet: "ALLER_RETOUR", dateRetour: "2026-11-15", transport: "TRAIN", villeArrivee: "Oran" });
    const r2 = await modifierVoyageur(undefined, fd({ id: amel, trajet: "ALLER_SIMPLE" }));
    expect(r2.ok).toBe(true);
    expect(await voyageurVu(amel)).toMatchObject({ trajet: "ALLER_SIMPLE", dateRetour: null, transport: "TRAIN", villeDepart: "Alger" });
    const r3 = await modifierVoyageur(undefined, fd({ id: amel, transport: "FUSEE" }));
    expect(r3.ok).toBe(false);
    expect((await voyageurVu(amel)).transport).toBe("TRAIN");
  });

  it("NOM ET PRÉNOM séparés, PLUSIEURS DESTINATIONS : les étapes se lisent, se corrigent, et rien d'autre ne bouge", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const etapes = [
      { de: "Alger", vers: "Paris", date: "2026-11-12" },
      { de: "Paris", vers: "Alger", date: "2026-11-15" },
      { de: "Alger", vers: "Dubaï", date: "2026-12-01" },
    ];
    const r = await ajouterVoyageur(undefined, fd({
      itemId: posteId, prenom: "Karim", nom: "Benali", trajet: "MULTI_DESTINATIONS", transport: "AVION", segments: JSON.stringify(etapes),
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const karim = r.id!;
    expect(await voyageurVu(karim)).toMatchObject({
      prenom: "Karim", nom: "Benali", trajet: "MULTI_DESTINATIONS", segments: etapes,
      villeDepart: "Alger", villeArrivee: "Dubaï", dateDepart: "2026-11-12", dateRetour: "2026-12-01",
    });
    // Une étape ajoutée : un formulaire qui ne porte QUE les étapes ne touche ni le nom, ni le prénom, ni le mode.
    const plus = [...etapes, { de: "Dubaï", vers: "Alger", date: "2026-12-05" }];
    const m = await modifierVoyageur(undefined, fd({ id: karim, segments: JSON.stringify(plus) }));
    expect(m.ok, m.ok ? "" : m.error).toBe(true);
    expect(await voyageurVu(karim)).toMatchObject({ prenom: "Karim", nom: "Benali", transport: "AVION", segments: plus, dateRetour: "2026-12-05" });
    // Une étape qui précède la précédente est REFUSÉE : rien n'est écrit.
    const inv = await modifierVoyageur(undefined, fd({ id: karim, segments: JSON.stringify([etapes[1], etapes[0]]) }));
    expect(inv.ok).toBe(false);
    expect((await voyageurVu(karim)).segments).toEqual(plus);
    // Revenir à un aller-retour VIDE les étapes (jamais d'étapes fantômes derrière un autre trajet).
    const ar = await modifierVoyageur(undefined, fd({ id: karim, trajet: "ALLER_RETOUR", villeDepart: "Alger", villeArrivee: "Paris", dateDepart: "2026-11-12", dateRetour: "2026-11-15" }));
    expect(ar.ok, ar.ok ? "" : ar.error).toBe(true);
    expect(await voyageurVu(karim)).toMatchObject({ trajet: "ALLER_RETOUR", segments: [], dateRetour: "2026-11-15" });
    await prisma.adProVoyageur.delete({ where: { id: karim } });
  });

  it("DOCUMENTS d'un voyageur : le passeport (pièce d'identité) et les autres se lisent à part, tous désignés par lui", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const base = { entityType: "AD_PRO_ITEM" as const, entityId: posteId, stepKey: amel, fileKey: `${TAG}k`, uploadedById: nsId };
    await prisma.document.createMany({
      data: [
        { ...base, name: `${TAG}passeport.pdf`, category: "ID_DOCUMENT" },
        { ...base, name: `${TAG}visa.pdf`, category: "OTHER" },
        { ...base, name: `${TAG}assurance.pdf`, category: "SUPPORTING_DOC" },
      ],
    });
    const v = await voyageurVu(amel);
    expect(v.passeports.map((d) => d.name)).toEqual([`${TAG}passeport.pdf`]);
    expect(v.autresDocuments.map((d) => d.name).sort()).toEqual([`${TAG}assurance.pdf`, `${TAG}visa.pdf`]);
    // Sans pièce d'identité, un visa seul ne vaut PAS passeport.
    await prisma.document.deleteMany({ where: { entityId: posteId, category: "ID_DOCUMENT", name: { startsWith: TAG } } });
    const sans = await voyageurVu(amel);
    expect(sans.passeports).toEqual([]);
    expect(sans.autresDocuments).toHaveLength(2);
    await prisma.document.deleteMany({ where: { entityId: posteId, name: { startsWith: TAG } } });
  });

  it("le devis d'un voyageur EST un devis du poste — sans fichier, rien n'est écrit", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const avant = await prisma.adProItemPiece.count({ where: { itemId: posteId } });
    const sans = await ajouterDevisVoyageur(undefined, fd({ voyageurId: amel, montant: "60000" }));
    expect(sans.ok).toBe(false);
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteId } })).toBe(avant);
    devisA = await deposer(amel, "devisA", "60000");
    devisB = await deposer(amel, "devisB", "70000");
    devisY = await deposer(yacine, "devisY", "50000");
    const piece = await prisma.adProItemPiece.findUniqueOrThrow({ where: { itemId_legalDocumentId: { itemId: posteId, legalDocumentId: devisA } }, include: { voyageur: true } });
    expect(piece.nature).toBe("DEVIS");
    expect(piece.voyageur?.voyageurId).toBe(amel);
    const rows = await loadAdProItems("SPONSORING", spoId);
    const poste = rows.find((r) => r.id === posteId)!;
    expect(poste.pieces.devis.map((d) => d.id)).toEqual(expect.arrayContaining([devisA, devisB, devisY]));
    expect((await voyageurVu(amel)).devis.map((d) => d.id)).toEqual([devisA, devisB]);
  });

  it("pas de BC sans devis retenu — la porte du poste n'est même pas appelée", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await demanderBCBilletterie(fd({ id: posteId, assistantId: asstId }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Validez d'abord le devis/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteId } })).orderStage).toBe("NONE");
  });

  it("un tiers qui ne voit pas la demande ne retient rien ; un devis d'un AUTRE voyageur non plus", async () => {
    ACTOR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await validerDevisVoyageur(fd({ voyageurId: amel, devisId: devisA }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Voyageur introuvable.");
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const autre = await validerDevisVoyageur(fd({ voyageurId: amel, devisId: devisY }));
    expect(autre.ok).toBe(false);
    expect(await retenus(amel)).toBe(0);
  });

  it("DEUX VALIDATIONS CROISÉES de deux devis du même voyageur n'en posent qu'une (l'index de la base)", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const ids = await prisma.adProVoyageurDevis.findMany({ where: { voyageurId: amel }, select: { id: true } });
    const r = await sousBarriere(ids.map((x) => x.id), () => [
      validerDevisVoyageur(fd({ voyageurId: amel, devisId: devisA })),
      validerDevisVoyageur(fd({ voyageurId: amel, devisId: devisB })),
    ], 2);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.find((x) => !x.ok)?.error ?? "").toMatch(/vient d'être retenu|vient de changer/);
    expect(await retenus(amel)).toBe(1);
  });

  it("DEUX VALIDATIONS CROISÉES du MÊME devis : une seule écriture (la condition « encore libre »)", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const lien = await prisma.adProVoyageurDevis.findFirstOrThrow({ where: { voyageurId: yacine } });
    const r = await sousBarriere([lien.id], () => [
      validerDevisVoyageur(fd({ voyageurId: yacine, devisId: devisY })),
      validerDevisVoyageur(fd({ voyageurId: yacine, devisId: devisY })),
    ], 2);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(await retenus(yacine)).toBe(1);
  });

  it("changer de devis REMPLACE le choix ; le retenu affiché, l'autre écarté", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await validerDevisVoyageur(fd({ voyageurId: amel, devisId: devisB }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const v = await voyageurVu(amel);
    expect(v.devis.filter((d) => d.retenu).map((d) => d.id)).toEqual([devisB]);
    expect(await retenus(amel)).toBe(1);
    // 70 000 + 50 000 > 100 000 accordés : la phrase le DIT, l'accord ne bouge pas.
    expect(r.ok && r.message?.replace(/\s/g, " ")).toMatch(/au-delà des 100 000 DZD accordés/);
  });

  it("retirer un devis du poste emporte son lien voyageur (aucun orphelin)", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await retirerDevisDuPoste(undefined, fd({ id: posteId, pieceId: devisA }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await voyageurVu(amel)).devis.map((d) => d.id)).toEqual([devisB]);
  });

  it("le BC part d'après les devis RETENUS, par la porte du poste ; le montant accordé ne change pas ; le choix se fige", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await demanderBCBilletterie(fd({ id: posteId, assistantId: asstId }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: posteId } });
    expect(poste.orderStage).not.toBe("NONE");
    expect(Number(poste.amountGranted)).toBe(100_000);
    expect(poste.orderNote).toMatch(/Devis retenus \(2\/2 voyageur\(s\)\)/);
    expect(poste.orderNote).toMatch(/Dr Amel Haddad — __voydevis__devisB/);
    expect(r.ok && r.message?.replace(/\s/g, " ")).toMatch(/au-delà/);
    const apres = await validerDevisVoyageur(fd({ voyageurId: yacine, devisId: devisY }));
    expect(apres.ok).toBe(false); // le BC est demandé : le choix ne bouge plus d'ici
    const changer = await deposer(amel, "devisC", "10000");
    const r2 = await validerDevisVoyageur(fd({ voyageurId: amel, devisId: changer }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/déjà demandé/);
    expect((await voyageurVu(amel)).devis.filter((d) => d.retenu).map((d) => d.id)).toEqual([devisB]);
  });
});
