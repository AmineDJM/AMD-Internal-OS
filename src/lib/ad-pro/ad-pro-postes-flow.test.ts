import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import {
  addAdProItem, repartirPoste, submitAdProItem, decideAdProItem, requestAdProItemOrder,
  ajouterVoyageur, modifierVoyageur, retirerVoyageur, demanderReservation, retirerReservation,
} from "@/lib/actions/ad-pro-item-actions";
import { supprimerDemandeAdPro, apercuDeSuppression, restoreDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { createLegalDocument, updateLegalDocument } from "@/lib/actions/legal-actions";
import { peutSupprimerUneDemandeAdPro } from "@/lib/queries/ad-pro-suppression";
import { loadAdProItems, contextePostes } from "@/lib/queries/ad-pro-items";
import { getInvolvementThreads } from "@/lib/queries/involvement";
import { persistUploadedDocument } from "@/lib/documents";
import { REFUS_INDIRECT_NON_REPARTI } from "@/lib/ad-pro-items";
import { REFUS_SUPPRESSION_AD_PRO } from "@/lib/ad-pro/suppression";
import { MULTI_SEP } from "@/lib/ad-pro/pickers";
import {
  prochainPas, faitsDuPoste, grouperParRepartition, type CleGeste, type RegardPoste,
} from "@/lib/ad-pro/poste-etapes";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu — ses comptes
// restent, et le suivant tombe sur une contrainte d'unicité dont la cause est invisible (§118.136).
const TAG = "__postesimples__";
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

const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], nom, { type: "application/pdf" });

/** Le formulaire de création d'un sponsoring tel que l'écran l'envoie — médecins compris. */
function formulaire(institution: string, nature: "DIRECT" | "INDIRECT", medecins: { coches: string[]; horsAnnuaire?: string }): FormData {
  const f = new FormData();
  f.set("institution", institution);
  for (const m of medecins.coches) f.append("doctorIds", m);
  if (medecins.horsAnnuaire !== undefined) f.set("doctorHorsAnnuaire", medecins.horsAnnuaire);
  f.append("productIds", `${TAG}Nivolex`);
  f.set("city", "Alger");
  f.set("specialty", "Cardiologie");
  f.set("type", "Congrès");
  f.set("amountRequested", "1200000");
  f.set("amountProposed", "1000000");
  f.set("nature", nature);
  f.set("strategicImportance", "HIGH");
  f.append("files", pdf("demande.pdf"));
  return f;
}

/** Ce que l'écran calcule pour la personne qui regarde — deux regards, ceux du banc. */
const REGARD_DEMANDEUR: RegardPoste = { canEdit: true, canAllocate: false, canViserBC: false, canEmettre: false, fige: false, operationDecidee: false };
const REGARD_DIRECTION: RegardPoste = { canEdit: true, canAllocate: true, canViserBC: false, canEmettre: true, fige: false, operationDecidee: false };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES POSTES D'UNE DEMANDE AD & PRO, SIMPLIFIÉS — par les VRAIS points d'entrée (§118.175).
 *
 * « Ici c'est trop complexe : plus simple, plus séparé, plus lisible. Le sponsoring indirect se
 * répartit — 400 000 d'imprimerie, 600 000 d'hôtellerie. Le médecin absent de l'annuaire se coche
 * « non présent » et s'écrit à la main. La billetterie porte ses voyageurs, et la réservation part
 * à l'assistante de direction dans un sujet. Le directeur des opérations et la directrice
 * marketing suppriment les demandes. Un devis, c'est son titre et sa pièce jointe » (Direction,
 * 01/10).
 *
 * Chaque geste passe par l'action de l'écran : un banc qui poserait l'état à la main confirmerait la
 * règle et ne dirait rien de ce qu'une personne obtient en cliquant (§118.14, §118.49). Et chaque
 * acteur est NOMMÉ dans son cas : hérité du cas précédent, il changerait avec l'ordre (§118.151f).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — postes simplifiés : répartition, gestes, voyageurs, suppression, devis", () => {
  let nsId = "", dirId = "", asstId = "", asst2Id = "", saId = "", pmChefId = "", pmSubId = "", kamId = "", odId = "";
  let catId = "";
  let spoA = "", spoB = "", posteOrigine = "", hotellerie = "", billetterie = "", associationB = "";
  let amel = "", yacine = "", sujetId = "";
  const sponsorings: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    // DEUX ASSISTANTES DE DIRECTION : c'est le cas où la règle a une décision à prendre — une seule
    // serait responsable d'office, et le banc ne pourrait pas distinguer « la seule » de « la
    // première trouvée » (§118.34). D'autres bancs en créent en même temps : deux est un PLANCHER.
    const [ns, dir, asst, asst2, sa, pmChef, pmSub, kam, od] = await Promise.all([
      mk("ns", "NATIONAL_SALES"), mk("dir", "DIRECTION"), mk("asst", "DIRECTION_ASSISTANT"), mk("asst2", "DIRECTION_ASSISTANT"),
      mk("sa", "SUPER_ADMIN"), mk("pmchef", "PRODUCT_MANAGER"), mk("pmsub", "PRODUCT_MANAGER"), mk("kam", "MEDICAL_DELEGATE"),
      mk("od", "OPERATIONS_DIRECTOR"),
    ]);
    nsId = ns.id; dirId = dir.id; asstId = asst.id; asst2Id = asst2.id; saId = sa.id; pmChefId = pmChef.id; pmSubId = pmSub.id; kamId = kam.id; odId = od.id;
    // L'ORGANIGRAMME : la cheffe de la Direction Marketing, et une chargée de marketing qui lui
    // rapporte. C'est lui — pas le rôle — qui dit qui est la directrice (§118.164c).
    const chef = await prisma.employee.create({ data: { fullName: `${TAG}Cheffe marketing`, userId: pmChef.id } });
    await prisma.employee.create({ data: { fullName: `${TAG}Chargée marketing`, userId: pmSub.id, managerId: chef.id } });
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Ad&Pro`, modules: ["SPONSORING"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 5_000_000,
        categories: { create: [{ name: `${TAG}Sponsoring`, module: "SPONSORING", allocated: 5_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0].id;
  });

  afterAll(async () => {
    const ids = sponsorings;
    const sujets = await prisma.dossier.findMany({ where: { OR: [{ sourceId: { in: ids } }, { title: { contains: TAG } }] }, select: { id: true } }).catch(() => []);
    await prisma.dossierMessage.deleteMany({ where: { dossierId: { in: sujets.map((s) => s.id) } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: { in: sujets.map((s) => s.id) } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { name: { startsWith: TAG } }] } }).catch(() => {});
    const postes = await prisma.adProItem.findMany({ where: { sponsoringId: { in: ids } }, select: { id: true } }).catch(() => []);
    await prisma.document.deleteMany({ where: { entityId: { in: postes.map((p) => p.id) } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes.map((p) => p.id) } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    const legaux = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    await prisma.document.deleteMany({ where: { entityId: { in: legaux.map((l) => l.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux.map((l) => l.id) } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
  }, 60_000);

  /** Les lignes du chargeur de l'écran, et la ligne d'un poste. */
  async function ligne(parentId: string, id: string) {
    const rows = await loadAdProItems("SPONSORING", parentId);
    const r = rows.find((x) => x.id === id);
    expect(r, `le poste ${id} doit être lu par le chargeur de l'écran`).toBeDefined();
    return r!;
  }

  // ── LE MÉDECIN ABSENT DE L'ANNUAIRE ───────────────────────────────────────────────────

  it("MÉDECIN « NON PRÉSENT » : les noms écrits à la main s'AJOUTENT aux cochés, sans doublon", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await createSponsoring(undefined, formulaire(`${TAG}Société de cardiologie`, "INDIRECT", {
      coches: ["Dr Karim Annuaire"], horsAnnuaire: "Dr Yacine Ouali\nDr Karim Annuaire",
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    spoA = r.ok ? r.id! : "";
    sponsorings.push(spoA);
    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoA } });
    expect(spo.doctor).toBe(`Dr Karim Annuaire${MULTI_SEP}Dr Yacine Ouali`);
  });

  it("MÉDECIN « NON PRÉSENT » seul : il suffit — aucune case n'est exigée quand le nom est écrit", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await createSponsoring(undefined, formulaire(`${TAG}Association d'oncologie`, "DIRECT", { coches: [], horsAnnuaire: "Dr Yacine Ouali" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    spoB = r.ok ? r.id! : "";
    sponsorings.push(spoB);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoB } })).doctor).toBe("Dr Yacine Ouali");
    // L'AUTRE MOITIÉ : sans nom NI case, la demande reste incomplète, et le refus le nomme.
    const vide = await createSponsoring(undefined, formulaire(`${TAG}Sans médecin`, "DIRECT", { coches: [], horsAnnuaire: "  " }));
    expect(vide.ok).toBe(false);
    expect(vide.ok === false ? vide.error : "").toMatch(/le ou les médecins concernés/);
  });

  /**
   * FORCER UN ENTRELACEMENT (§118.65). Lancés « en même temps » sans barrière, deux dépôts se
   * succèdent parfois — le second relit APRÈS que le premier a écrit — et le cas passerait sans le
   * filet qu'il prétend éprouver. La barrière tient un verrou qui bloque les ÉCRITURES de la table
   * sans bloquer ses lectures, lance les gestes, attend que `attendus` sessions soient bloquées à
   * l'insertion, puis relâche.
   */
  async function sousBarriere<T>(table: string, lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined); // l'erreur se lit plus bas, pas en rejet orphelin
      const debut = Date.now();
      for (;;) {
        // Dans une transaction, Postgres FIGE la vue des sessions au premier accès (§118.164e).
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock' AND query ILIKE '%${table}%'`,
        );
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const vues = await tx.$queryRaw<{ etat: string | null; attente: string | null; requete: string }[]>`
            SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
            FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          throw new Error(`les gestes n'ont pas atteint la barrière (${n} en attente sur ${attendus}) — ${JSON.stringify(vues)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  it("DEUX DÉPÔTS À LA MÊME SECONDE : deux références, aucune erreur — la référence se recalcule sous collision", async () => {
    // Les deux dépôts lisent le MÊME maximum, calculent la MÊME référence et attendent tous deux à
    // l'insertion. Relâchés, l'un passe ; l'autre heurte l'unicité et, avec le filet
    // (`createWithRetry`), recalcule. Sans lui, le second échouait sur une erreur brute — trouvé par
    // la suite elle-même : ce banc et celui de la clôture déposent des sponsorings en parallèle.
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const [r1, r2] = await sousBarriere("SponsoringRequest", () => [
      createSponsoring(undefined, formulaire(`${TAG}Dépôt simultané A`, "DIRECT", { coches: [], horsAnnuaire: "Dr Simultané A" })),
      createSponsoring(undefined, formulaire(`${TAG}Dépôt simultané B`, "DIRECT", { coches: [], horsAnnuaire: "Dr Simultané B" })),
    ]);
    const ids = [r1, r2].map((r) => (r.ok ? r.id! : ""));
    sponsorings.push(...ids.filter(Boolean));
    expect([r1.ok, r2.ok], JSON.stringify([r1, r2])).toEqual([true, true]);
    const refs = await prisma.sponsoringRequest.findMany({ where: { id: { in: ids } }, select: { reference: true } });
    expect(new Set(refs.map((x) => x.reference)).size, "deux dépôts, deux références").toBe(2);
  }, 60_000);

  // ── LE SPONSORING INDIRECT, RÉPARTI PAR NATURE ────────────────────────────────────────

  it("INDIRECT non réparti : il ne se soumet pas, ne s'accorde pas, et le seul geste offert est « Répartir par nature »", async () => {
    const postes = await prisma.adProItem.findMany({ where: { sponsoringId: spoA } });
    expect(postes, "la demande naît avec son poste").toHaveLength(1);
    expect(postes[0].kind).toBe("INDIRECT_SUPPORT");
    posteOrigine = postes[0].id;

    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const sub = await submitAdProItem(undefined, fd({ id: posteOrigine }));
    expect(sub.ok === false ? sub.error : "soumis").toBe(REFUS_INDIRECT_NON_REPARTI);
    // Ni la Direction des opérations ni la Direction Marketing ne l'accordent (§118.204) — l'action
    // refuse AVANT d'écrire, donc le statut n'a pas bougé.
    for (const [id, role] of [[dirId, "DIRECTION"], [pmChefId, "PRODUCT_MANAGER"]] as const) {
      ACTOR = await acteur(id, role);
      const dec = await decideAdProItem(undefined, fd({ id: posteOrigine, decision: "APPROVED", budgetCategoryId: catId }));
      expect(dec.ok, `${role} ne doit pas accorder un sponsoring indirect non réparti`).toBe(false);
    }
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteOrigine } })).status).toBe("DRAFT");
    // LE CAS RÉEL où la garde de la répartition est seule à parler : un sponsoring indirect d'AVANT,
    // en attente du second temps (la migration de §118.204 réputé fait le premier temps des postes
    // déjà soumis). DÉCOR, nommé : c'est cet état hérité qu'on éprouve, pas son histoire.
    const herite = await prisma.adProItem.create({ data: {
      sponsoringId: spoA, kind: "INDIRECT_SUPPORT", label: `${TAG}Indirect hérité`, status: "PENDING",
      amountEstimated: 100_000, opsDecidedAt: new Date(), position: 49,
    } });
    ACTOR = await acteur(pmChefId, "PRODUCT_MANAGER");
    const dec = await decideAdProItem(undefined, fd({ id: herite.id, decision: "APPROVED", budgetCategoryId: catId }));
    expect(dec.ok === false ? dec.error : "accordé").toBe(REFUS_INDIRECT_NON_REPARTI);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: herite.id } })).status).toBe("PENDING");
    await prisma.adProItem.delete({ where: { id: herite.id } });

    const pas = prochainPas(faitsDuPoste(await ligne(spoA, posteOrigine)), REGARD_DEMANDEUR);
    expect(pas.geste?.cle).toBe("REPARTIR");
  });

  it("RÉPARTIR : une saisie fautive ne change RIEN, et le refus nomme chaque ligne", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await repartirPoste(undefined, fd({
      id: posteOrigine,
      repartition: JSON.stringify([{ kind: "PRINTING", montant: "", precision: "", payeA: "" }, { kind: "", montant: 600000, precision: "", payeA: "" }]),
    }));
    expect(r.ok).toBe(false);
    const e = r.ok === false ? r.error ?? "" : "";
    expect(e).toMatch(/ligne 1 : le montant/);
    expect(e).toMatch(/ligne 2 : choisissez la nature/);
    const postes = await prisma.adProItem.findMany({ where: { sponsoringId: spoA } });
    expect(postes.map((p) => p.kind)).toEqual(["INDIRECT_SUPPORT"]);
  });

  it("RÉPARTIR : chaque nature devient un poste, le premier GARDE l'identifiant d'origine, et l'écart se DIT", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await repartirPoste(undefined, fd({
      id: posteOrigine,
      repartition: JSON.stringify([
        { kind: "PRINTING", montant: 400000, precision: "Affiches et kakémonos", payeA: "Imprimerie du Centre" },
        { kind: "ACCOMMODATION", montant: 500000, precision: "", payeA: "" },
      ]),
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    // 400 000 + 500 000 = 900 000 contre 1 000 000 au poste d'origine : l'écart n'est pas refusé
    // (le demandeur ajuste en répartissant), il est DIT — le taire laisserait croire que rien n'a bougé.
    expect(r.ok ? r.message : "").toContain(`Le poste d'origine portait ${(1_000_000).toLocaleString("fr-FR")} DZD.`);

    const postes = await prisma.adProItem.findMany({ where: { sponsoringId: spoA }, orderBy: { position: "asc" } });
    expect(postes.map((p) => p.kind)).toEqual(["PRINTING", "ACCOMMODATION"]);
    const [imprimerie, hotel] = postes;
    expect(imprimerie.id, "le poste d'origine devient la première nature — ses pièces et son historique restent").toBe(posteOrigine);
    expect(imprimerie.label).toBe("Imprimerie — Affiches et kakémonos");
    expect(Number(imprimerie.amountEstimated)).toBe(400_000);
    expect(imprimerie.supplier).toBe("Imprimerie du Centre");
    expect(Number(hotel.amountEstimated)).toBe(500_000);
    expect(hotel.notes).toMatch(/Réparti depuis/);
    expect(postes.every((p) => p.repartitionId === posteOrigine), "les natures se relient par la première").toBe(true);
    hotellerie = hotel.id;

    // L'ÉCRAN les regroupe d'un seul tenant : c'est la clé que la répartition pose.
    const groupes = grouperParRepartition(await loadAdProItems("SPONSORING", spoA));
    expect(groupes.find((g) => g.repartitionId === posteOrigine)?.items.map((i) => i.id)).toEqual([posteOrigine, hotellerie]);

    // Une nature n'est plus un sponsoring indirect : elle ne se répartit pas une seconde fois.
    const encore = await repartirPoste(undefined, fd({ id: posteOrigine, repartition: JSON.stringify([{ kind: "TICKETING", montant: 1000, precision: "", payeA: "" }]) }));
    expect(encore.ok === false ? encore.error : "réparti").toMatch(/Seul un sponsoring indirect se répartit/);
  });

  it("AJOUTER un sponsoring indirect : il naît RÉPARTI — sans répartition, le refus le dit", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const sans = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoA, label: `${TAG}Prise en charge`, kind: "INDIRECT_SUPPORT" }));
    expect(sans.ok).toBe(false);
    const avec = await addAdProItem(undefined, fd({
      parent: "SPONSORING", parentId: spoA, label: `${TAG}Prise en charge`, kind: "INDIRECT_SUPPORT",
      repartition: JSON.stringify([{ kind: "TICKETING", montant: 150000, precision: "", payeA: "" }]),
    }));
    expect(avec.ok, avec.ok === false ? avec.error : "").toBe(true);
    const cree = await prisma.adProItem.findUniqueOrThrow({ where: { id: avec.ok ? avec.id! : "" } });
    expect(cree.kind, "aucun poste « sponsoring indirect » d'un seul tenant n'est créé").toBe("TICKETING");
    expect(cree.repartitionId).toBe(cree.id);
    expect(await prisma.adProItem.count({ where: { sponsoringId: spoA, kind: "INDIRECT_SUPPORT" } })).toBe(0);
  });

  it("UN SPONSORING INDIRECT D'AVANT : soumis, il ne se répartit plus ; renvoyé avec un BC demandé, non plus", async () => {
    // DÉCOR, nommé : des postes « sponsoring indirect » d'avant cette règle — soumis, ou renvoyés en
    // révision après qu'un bon de commande a été demandé (un chemin réel : la décision change tant
    // que le BC n'est pas émis). Ce banc mesure les gardes de la répartition, pas leur histoire.
    const soumis = await prisma.adProItem.create({ data: { sponsoringId: spoA, kind: "INDIRECT_SUPPORT", label: `${TAG}Indirect soumis`, status: "PENDING", amountEstimated: 100_000, position: 50 } });
    const avecBC = await prisma.adProItem.create({ data: { sponsoringId: spoA, kind: "INDIRECT_SUPPORT", label: `${TAG}Indirect avec BC`, status: "REVISION", amountEstimated: 100_000, amountGranted: 100_000, orderStage: "REQUESTED", position: 51 } });
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const rep = JSON.stringify([{ kind: "PRINTING", montant: 100000, precision: "", payeA: "" }]);
    const a = await repartirPoste(undefined, fd({ id: soumis.id, repartition: rep }));
    expect(a.ok === false ? a.error : "réparti").toMatch(/déjà soumis ou accordé/);
    const b = await repartirPoste(undefined, fd({ id: avecBC.id, repartition: rep }));
    expect(b.ok === false ? b.error : "réparti").toMatch(/bon de commande ou un ordre de dépense est déjà parti/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: soumis.id } })).kind, "rien n'a bougé").toBe("INDIRECT_SUPPORT");
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: avecBC.id } })).kind).toBe("INDIRECT_SUPPORT");
    await prisma.adProItem.deleteMany({ where: { id: { in: [soumis.id, avecBC.id] } } });
  });

  it("UN SPONSORING INDIRECT REFUSÉ, puis réparti : la première nature repart en BROUILLON — et l'historique reste", async () => {
    // « Refusé » sur l'imprimerie dirait que la Direction a refusé une imprimerie dont elle n'a
    // jamais entendu parler : la décision portait sur le sponsoring d'un seul tenant.
    const refuse = await prisma.adProItem.create({
      data: {
        sponsoringId: spoA, kind: "INDIRECT_SUPPORT", label: `${TAG}Indirect refusé`, status: "REJECTED", amountEstimated: 200_000,
        decisionNote: "Trop cher d'un seul tenant", decidedAt: new Date(), decidedById: dirId, position: 52,
        decisions: { create: { decision: "REJECTED", note: "Trop cher d'un seul tenant", amount: 200_000, byId: dirId } },
      },
    });
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await repartirPoste(undefined, fd({ id: refuse.id, repartition: JSON.stringify([{ kind: "DINNER", montant: 80000, precision: "", payeA: "" }]) }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const apres = await prisma.adProItem.findUniqueOrThrow({ where: { id: refuse.id }, include: { decisions: true } });
    expect(apres.kind).toBe("DINNER");
    expect(apres.status).toBe("DRAFT");
    expect(apres.decisionNote).toBeNull();
    expect(apres.decidedById).toBeNull();
    expect(apres.decisions.map((d) => d.decision), "la décision passée reste lisible dans l'historique").toEqual(["REJECTED"]);
    await prisma.adProItem.delete({ where: { id: refuse.id } });
  });

  // ── UN GESTE PROPOSÉ EST UN GESTE ACCEPTÉ ─────────────────────────────────────────────

  it("LA CHAÎNE : chaque geste que l'écran propose est ACCEPTÉ par la vraie action, jusqu'au bon de commande", async () => {
    /*
     * Le module des étapes promet : « chaque geste rendu ici est un geste que l'action serveur
     * ACCEPTERA dans cet état ». Ce cas le tient, état par état, sur le chargeur de l'écran et la
     * même traduction des faits que la carte (`faitsDuPoste`). Ce qui le ferait tomber : un geste
     * offert dans un état où l'action refuse — le bouton qui ne marche pas (§118.83).
     */
    const rejouer: Record<CleGeste, (() => Promise<{ ok: boolean; error?: string }>) | null> = {
      SOUMETTRE: async () => { ACTOR = await acteur(nsId, "NATIONAL_SALES"); return submitAdProItem(undefined, fd({ id: hotellerie })); },
      VALIDER_OPS: async () => { ACTOR = await acteur(dirId, "DIRECTION"); return decideAdProItem(undefined, fd({ id: hotellerie, decision: "APPROVED" })); },
      DECIDER: async () => {
        ACTOR = await acteur(pmChefId, "PRODUCT_MANAGER");
        return decideAdProItem(undefined, fd({ id: hotellerie, decision: "APPROVED", amountGranted: "450000", budgetCategoryId: catId }));
      },
      DEMANDER_BC: async () => {
        ACTOR = await acteur(nsId, "NATIONAL_SALES");
        return requestAdProItemOrder(undefined, fd({ id: hotellerie, note: "Hôtel Sofitel — 12 chambres, 3 nuits.", assistantId: asstId }));
      },
      REPARTIR: null, CHIFFRER: null, MONTANT: null, BUDGET: null, GENERER_BC: null, VISER_BC: null, VERIFIER_BC: null, DEMANDER_PAIEMENT: null,
    };
    // Le regard de chacun est celui que le SERVEUR calcule pour l'écran (`contextePostes`) — recomposé
    // ici à la main, il pourrait proposer un geste que l'écran ne propose pas (§118.120).
    const regardDe = async (id: string, role: SessionUser["role"], base: RegardPoste): Promise<RegardPoste> => {
      const ctx = await contextePostes(await acteur(id, role), "SPONSORING", spoA);
      return { ...base, validation: ctx.validation };
    };
    const regards = [
      await regardDe(nsId, "NATIONAL_SALES", REGARD_DEMANDEUR),
      await regardDe(dirId, "DIRECTION", REGARD_DIRECTION),
      await regardDe(pmChefId, "PRODUCT_MANAGER", REGARD_DIRECTION),
    ];
    const suivis: CleGeste[] = [];
    for (let tour = 0; tour < 8; tour += 1) {
      const faits = faitsDuPoste(await ligne(spoA, hotellerie));
      const geste = regards.map((r) => prochainPas(faits, r).geste?.cle ?? null).find(Boolean) ?? null;
      if (!geste || !rejouer[geste]) break;
      const r = await rejouer[geste]!();
      expect(r.ok, `le geste « ${geste} » est proposé et l'action le refuse : ${r.error ?? ""}`).toBe(true);
      suivis.push(geste);
    }
    expect(suivis).toEqual(["SOUMETTRE", "VALIDER_OPS", "DECIDER", "DEMANDER_BC"]);
    // Le BC est demandé : au centre (au-dessus du seuil), et chez l'assistante. L'écran DIT qui on
    // attend — jamais un geste du demandeur.
    const row = await ligne(spoA, hotellerie);
    expect(["REQUESTED", "DIRECTION_OK"]).toContain(row.orderStage);
    expect(row.budgetCategoryId, "le budget est choisi AU second temps, pas dans un geste à part").toBe(catId);
    expect(row.demandeBC?.etat).toBe("CHEZ_ASSISTANTE");
    const fin = prochainPas(faitsDuPoste(row), REGARD_DEMANDEUR);
    expect(fin.geste).toBeNull();
    expect(fin.attente).toMatch(/centre de validation|assistante de direction/);
    // Le message du demandeur est GARDÉ pour l'assistante, à côté de la note de la Direction.
    expect(row.orderNote).toBe("Hôtel Sofitel — 12 chambres, 3 nuits.");
  });

  // ── LA BILLETTERIE : SES VOYAGEURS, ET LA RÉSERVATION ─────────────────────────────────

  it("VOYAGEURS : seul un poste « billetterie » en porte, un NOM suffit, et une date fausse est refusée", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    associationB = (await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spoB } })).id;
    const ailleurs = await ajouterVoyageur(undefined, fd({ itemId: associationB, nom: "Dr Amel Haddad" }));
    expect(ailleurs.ok === false ? ailleurs.error : "ajouté").toMatch(/Seul un poste « billetterie »/);

    const add = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoB, label: `${TAG}Billets Paris`, kind: "TICKETING", amountEstimated: "300000" }));
    expect(add.ok, add.ok === false ? add.error : "").toBe(true);
    billetterie = add.ok ? add.id! : "";

    const nomSeul = await ajouterVoyageur(undefined, fd({ itemId: billetterie, nom: "Dr Amel Haddad" }));
    expect(nomSeul.ok, nomSeul.ok === false ? nomSeul.error : "").toBe(true);
    amel = nomSeul.ok ? nomSeul.id! : "";

    const inverse = await ajouterVoyageur(undefined, fd({ itemId: billetterie, nom: "Dr X", dateDepart: "2026-11-07", dateRetour: "2026-11-03" }));
    expect(inverse.ok === false ? inverse.error : "ajouté").toMatch(/retour précède la date de départ/);
    const illisible = await ajouterVoyageur(undefined, fd({ itemId: billetterie, nom: "Dr X", dateDepart: "2026-02-31" }));
    expect(illisible.ok === false ? illisible.error : "ajouté").toMatch(/date de départ lisible/);

    const complet = await ajouterVoyageur(undefined, fd({
      itemId: billetterie, nom: "Dr Yacine Ouali", villeDepart: "Alger", villeArrivee: "Paris",
      dateDepart: "2026-11-03", dateRetour: "2026-11-07", notes: "Vol du matin",
    }));
    expect(complet.ok, complet.ok === false ? complet.error : "").toBe(true);
    yacine = complet.ok ? complet.id! : "";
    expect(await prisma.adProVoyageur.count({ where: { itemId: billetterie } }), "les deux refus n'ont rien écrit").toBe(2);

    // LE PASSEPORT : une pièce du POSTE désignée par le voyageur — le même écrivain que le téléverseur.
    const doc = await persistUploadedDocument(nsId, {
      entityType: "AD_PRO_ITEM", entityId: billetterie, category: "ID_DOCUMENT", confidentiality: "INTERNAL",
      stepKey: yacine, file: pdf(`${TAG}passeport-ouali.pdf`), maxUploadMb: 20,
    });
    expect(doc.ok, doc.error).toBe(true);
    // UN AUTRE DOCUMENT (un visa) pour Amel : il se joint à sa fiche, mais ne vaut PAS passeport — la ligne de
    // l'assistante dit encore « manque : passeport », et le visa figure parmi les liens qu'elle ouvre.
    const visa = await persistUploadedDocument(nsId, {
      entityType: "AD_PRO_ITEM", entityId: billetterie, category: "OTHER", confidentiality: "INTERNAL",
      stepKey: amel, file: pdf(`${TAG}visa-haddad.pdf`), maxUploadMb: 20,
    });
    expect(visa.ok, visa.error).toBe(true);

    // L'ÉCRAN les lit : les voyageurs, leur passeport, et les noms que la demande porte déjà —
    // y compris celui écrit « hors annuaire » à la création.
    const row = await ligne(spoB, billetterie);
    expect(row.voyageurs.map((v) => v.nom)).toEqual(["Dr Amel Haddad", "Dr Yacine Ouali"]);
    expect(row.voyageurs.find((v) => v.id === yacine)?.passeports).toHaveLength(1);
    expect(row.voyageurs.find((v) => v.id === amel)?.passeports).toHaveLength(0);
    expect(row.nomsSuggeres).toContain("Dr Yacine Ouali");
  });

  it("RÉSERVATION : un sujet pour l'assistante de direction, lié à la DEMANDE, qui dit ce qui manque", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await demanderReservation(fd({ id: billetterie }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    sujetId = r.ok ? r.id! : "";
    const sujet = await prisma.dossier.findUniqueOrThrow({ where: { id: sujetId } });
    expect(sujet.category).toBe("Billets");
    expect(sujet.priority).toBe("HIGH");
    expect(sujet.sourceType).toBe("SPONSORING");
    expect(sujet.sourceId).toBe(spoB);
    expect(sujet.title).toMatch(/^Réservation billets — /);
    // PLUSIEURS ASSISTANTES : toutes participantes, AUCUNE responsable désignée — en choisir une
    // serait choisir à la place d'un humain (§118.34). Ce banc en crée deux : la règle a donc
    // TOUJOURS une décision à prendre ici, quoi que fassent les bancs voisins.
    expect(sujet.assignedToId, "aucune assistante n'est désignée à la place d'un humain").toBeNull();
    expect(sujet.participantIds).toEqual(expect.arrayContaining([asstId, asst2Id]));
    expect(sujet.createdById).toBe(nsId);
    // Ce qu'elle lit : chaque voyageur, ce qu'on sait, ce qui MANQUE, et l'état du poste.
    const d = sujet.description ?? "";
    expect(d).toContain("Dr Amel Haddad — trajet à confirmer — aller à confirmer, retour à confirmer (manque : date de départ, trajet, mode de transport, passeport)");
    expect(d).toContain("Dr Yacine Ouali — Alger → Paris — aller 03/11/2026, retour 07/11/2026 — passeport joint (manque : mode de transport) — Vol du matin");
    expect(d).toMatch(/Poste pas encore accordé/);
    expect(d, "le visa d'Amel est un lien de plus, pas son passeport").toContain(`Dr Amel Haddad — ${TAG}visa-haddad.pdf — /api/documents/`);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: billetterie } })).reservationDossierId).toBe(sujetId);
    // PRÉVENUE — le lien CAUSAL, pas un compte global (§118.92).
    expect(await prisma.notification.count({ where: { userId: asstId, link: `/dossiers/${sujetId}` } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: asst2Id, link: `/dossiers/${sujetId}` } })).toBe(1);
    // Et le sujet REMONTE en bas de la fiche de la demande, par le lecteur de l'écran.
    const fil = (await getInvolvementThreads("SPONSORING", spoB)).find((f) => f.dossierId === sujetId);
    expect(fil, "le sujet de réservation sur la fiche de la demande").toBeDefined();
    expect(fil!.members.map((m) => m.id), "l'assistante peut y écrire").toContain(asstId);
  });

  it("FLEXIBILITÉ : une date changée s'écrit dans le sujet, et le formulaire partiel n'efface rien", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    // Un formulaire qui ne porte QUE la date : le trajet et les précisions de Yacine restent (§118.152c).
    const r = await modifierVoyageur(undefined, fd({ id: yacine, dateDepart: "2026-11-04" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(r.ok ? r.message : "").toMatch(/L'assistante est prévenue/);
    const v = await prisma.adProVoyageur.findUniqueOrThrow({ where: { id: yacine } });
    expect(v.villeDepart).toBe("Alger");
    expect(v.villeArrivee).toBe("Paris");
    expect(v.notes).toBe("Vol du matin");
    expect(v.dateRetour?.toISOString().slice(0, 10)).toBe("2026-11-07");
    const msgs = await prisma.dossierMessage.findMany({ where: { dossierId: sujetId }, orderBy: { createdAt: "asc" } });
    expect(msgs.at(-1)?.body).toContain("voyageur modifié — Dr Yacine Ouali : aller : 03/11/2026 → 04/11/2026");

    // À l'identique : rien n'est écrit, personne n'est dérangé.
    const meme = await modifierVoyageur(undefined, fd({ id: yacine, dateDepart: "2026-11-04" }));
    expect(meme.ok ? meme.message : "").toBe("Rien n'a changé.");
    expect(await prisma.dossierMessage.count({ where: { dossierId: sujetId } })).toBe(msgs.length);
  });

  it("UNE SECONDE DEMANDE écrit dans le MÊME sujet — deux sujets pour les mêmes billets se contrediraient", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const avant = await prisma.dossier.count({ where: { sourceType: "SPONSORING", sourceId: spoB } });
    const r = await demanderReservation(fd({ id: billetterie }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(r.ok ? r.id : "").toBe(sujetId);
    expect(await prisma.dossier.count({ where: { sourceType: "SPONSORING", sourceId: spoB } })).toBe(avant);
    const dernier = await prisma.dossierMessage.findFirstOrThrow({ where: { dossierId: sujetId }, orderBy: { createdAt: "desc" } });
    expect(dernier.body).toMatch(/^Demande de réservation mise à jour\./);
    expect(dernier.body, "la liste À JOUR : la date décalée").toContain("aller 04/11/2026");
  });

  it("RETIRER un voyageur le dit dans le sujet — et son passeport RESTE parmi les pièces du poste", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await retirerVoyageur(fd({ id: yacine }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(await prisma.adProVoyageur.findUnique({ where: { id: yacine } })).toBeNull();
    expect(await prisma.document.count({ where: { entityType: "AD_PRO_ITEM", entityId: billetterie, stepKey: yacine } }), "une pièce jointe ne s'efface pas en silence").toBe(1);
    const dernier = await prisma.dossierMessage.findFirstOrThrow({ where: { dossierId: sujetId }, orderBy: { createdAt: "desc" } });
    expect(dernier.body).toContain("voyageur retiré : Dr Yacine Ouali.");
  });

  it("RETIRER LA DEMANDE DE RÉSERVATION (constat 37) : motif exigé, le sujet se clôt, l'assistante le lit — et une nouvelle demande rouvre un sujet", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const sansMotif = await retirerReservation(fd({ id: billetterie }));
    expect(sansMotif.ok === false ? sansMotif.error : "retiré").toMatch(/Dites pourquoi/);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: sujetId } })).status, "un refus ne touche à rien").not.toBe("ARCHIVED");
    const avis = await prisma.notification.count({ where: { userId: asstId, link: `/dossiers/${sujetId}` } });
    const r = await retirerReservation(fd({ id: billetterie, motif: "Le congrès passe en visio." }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: sujetId } })).status, "le sujet est clos").toBe("ARCHIVED");
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: billetterie } })).reservationDossierId, "le poste lâche son sujet").toBeNull();
    const dernier = await prisma.dossierMessage.findFirstOrThrow({ where: { dossierId: sujetId }, orderBy: { createdAt: "desc" } });
    expect(dernier.body).toMatch(/Demande de réservation RETIRÉE .* Le congrès passe en visio\./);
    expect(await prisma.notification.count({ where: { userId: asstId, link: `/dossiers/${sujetId}` } }), "l'assistante est prévenue par le sujet").toBe(avis + 1);
    expect(await prisma.adProVoyageur.count({ where: { itemId: billetterie } }), "les voyageurs restent").toBeGreaterThan(0);
    const encore = await retirerReservation(fd({ id: billetterie, motif: "x" }));
    expect(encore.ok === false ? encore.error : "retiré").toMatch(/Aucune demande de réservation/);
    // Une NOUVELLE demande ouvre un nouveau sujet — l'ancien, clos, ne se rouvre pas en silence.
    const nouvelle = await demanderReservation(fd({ id: billetterie }));
    expect(nouvelle.ok, nouvelle.ok === false ? nouvelle.error : "").toBe(true);
    expect(nouvelle.ok ? nouvelle.id : sujetId).not.toBe(sujetId);
    sujetId = nouvelle.ok ? nouvelle.id! : sujetId;
  });

  it("RETIRER LA RÉSERVATION : traitée (sujet clos) elle ne se retire plus — AVANT le motif ; et une clôture pendant le retrait gagne (course forcée)", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    // LA COURSE : l'assistante clôt le sujet pendant que le retrait attend sa ligne.
    let geste!: Promise<Awaited<ReturnType<typeof retirerReservation>>>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Dossier" WHERE id = ${sujetId} FOR UPDATE`;
      geste = retirerReservation(fd({ id: billetterie, motif: "Course." }));
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
        if (n >= 1) break;
        if (Date.now() - debut > 15_000) throw new Error("le retrait n'a pas atteint la barrière");
        await new Promise((res) => setTimeout(res, 25));
      }
      await tx.dossier.update({ where: { id: sujetId }, data: { status: "DONE" } });
    }, { timeout: 30_000 });
    const r = await geste;
    expect(r.ok === false ? r.error : "retiré").toMatch(/vient de changer/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: billetterie } })).reservationDossierId, "tout ou rien : le poste garde son sujet").toBe(sujetId);
    expect((await prisma.dossier.findUniqueOrThrow({ where: { id: sujetId } })).status).toBe("DONE");
    // Désormais TRAITÉE : le refus vient avant le motif, et le nomme.
    const traitee = await retirerReservation(fd({ id: billetterie }));
    expect(traitee.ok === false ? traitee.error : "retiré").toMatch(/La réservation est traitée/);
  });

  it("UN POSTE REFUSÉ ne se réserve pas", async () => {
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    expect((await submitAdProItem(undefined, fd({ id: billetterie }))).ok).toBe(true);
    ACTOR = await acteur(dirId, "DIRECTION");
    expect((await decideAdProItem(undefined, fd({ id: billetterie, decision: "REJECTED", note: "Pas de billets cette année" }))).ok).toBe(true);
    ACTOR = await acteur(nsId, "NATIONAL_SALES");
    const r = await demanderReservation(fd({ id: billetterie }));
    expect(r.ok === false ? r.error : "réservé").toMatch(/refusé par la Direction/);
  });

  // ── LA SUPPRESSION D'UNE DEMANDE AD & PRO ─────────────────────────────────────────────

  it("QUI SUPPRIME : Super Admin, directeur des opérations, directrice marketing — jamais l'auteur, ni une chargée de marketing", async () => {
    const sa = await acteur(saId, "SUPER_ADMIN");
    const dir = await acteur(dirId, "DIRECTION");
    const chef = await acteur(pmChefId, "PRODUCT_MANAGER");
    const sub = await acteur(pmSubId, "PRODUCT_MANAGER");
    const ns = await acteur(nsId, "NATIONAL_SALES");
    const kam = await acteur(kamId, "MEDICAL_DELEGATE");
    const od = await acteur(odId, "OPERATIONS_DIRECTOR");

    expect(await peutSupprimerUneDemandeAdPro(sa, "SPONSORING", spoB)).toBe(true);
    expect(await peutSupprimerUneDemandeAdPro(dir, "SPONSORING", spoB)).toBe(true);
    // LA PRÉMISSE des deux cas suivants : la chargée de marketing VOIT la demande. Sans elle, son
    // refus viendrait de la ligne, pas de la règle — et le cas ne mesurerait rien (§118.104).
    expect(await canAccessEntity(sub, "SPONSORING", spoB, "VIEW")).toBe(true);
    expect(await peutSupprimerUneDemandeAdPro(chef, "SPONSORING", spoB), "la cheffe, lue sur l'organigramme").toBe(true);
    expect(await peutSupprimerUneDemandeAdPro(sub, "SPONSORING", spoB), "une chargée qui rapporte à la cheffe n'est pas la directrice").toBe(false);
    expect(await canAccessEntity(ns, "SPONSORING", spoB, "VIEW")).toBe(true);
    expect(await peutSupprimerUneDemandeAdPro(ns, "SPONSORING", spoB), "l'auteur range, il ne supprime pas").toBe(false);
    expect(await peutSupprimerUneDemandeAdPro(kam, "SPONSORING", spoB)).toBe(false);
    // Le Directeur des Opérations passe la RÈGLE, mais il n'a pas le module Sponsoring : c'est alors
    // la LIGNE qui décide — on ne supprime pas ce qu'on ne voit pas. Si un jour il le reçoit, la
    // prémisse tombe ici, en le disant, au lieu que le cas cesse en silence de garder la ligne.
    expect(await canAccessEntity(od, "SPONSORING", spoB, "VIEW"), "prémisse : il ne voit pas les sponsorings").toBe(false);
    expect(await peutSupprimerUneDemandeAdPro(od, "SPONSORING", spoB)).toBe(false);
  });

  it("UNE SEULE PORTE : l'aperçu s'ouvre exactement pour qui l'action accepte", async () => {
    for (const [id, role] of [[dirId, "DIRECTION"], [pmSubId, "PRODUCT_MANAGER"], [nsId, "NATIONAL_SALES"]] as const) {
      const u = await acteur(id, role);
      ACTOR = u;
      const a = await apercuDeSuppression(fd({ kind: "SPONSORING", id: spoB }));
      expect("erreur" in a ? "fermé" : "ouvert", `${role} : l'aperçu et l'action disent la même chose`)
        .toBe((await peutSupprimerUneDemandeAdPro(u, "SPONSORING", spoB)) ? "ouvert" : "fermé");
    }
  });

  it("SUPPRIMER : refusé à la chargée de marketing, accepté pour le directeur des opérations — et RÉVERSIBLE, voyageurs et sujet compris", async () => {
    ACTOR = await acteur(pmSubId, "PRODUCT_MANAGER");
    const non = await supprimerDemandeAdPro(fd({ kind: "SPONSORING", id: spoB }));
    expect(non.ok === false ? non.error : "supprimé").toBe(REFUS_SUPPRESSION_AD_PRO);
    expect(await prisma.sponsoringRequest.findUnique({ where: { id: spoB } })).not.toBeNull();

    ACTOR = await acteur(dirId, "DIRECTION");
    const oui = await supprimerDemandeAdPro(fd({ kind: "SPONSORING", id: spoB }));
    expect(oui.ok, oui.ok === false ? oui.error : "").toBe(true);
    expect(await prisma.sponsoringRequest.findUnique({ where: { id: spoB } })).toBeNull();
    expect(await prisma.adProVoyageur.findUnique({ where: { id: amel } }), "les voyageurs partent avec leur poste").toBeNull();
    expect(await prisma.dossier.findUnique({ where: { id: sujetId } }), "le sujet de réservation part avec la demande").toBeNull();
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "SPONSORING", sourceId: spoB, restoredAt: null } });
    expect(rec.deletedById).toBe(dirId);

    // Le Super Admin défait : tout revient, ensemble.
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    const back = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(back.ok, back.ok === false ? back.error : "").toBe(true);
    expect(await prisma.sponsoringRequest.findUnique({ where: { id: spoB } })).not.toBeNull();
    expect((await prisma.adProVoyageur.findUnique({ where: { id: amel } }))?.nom).toBe("Dr Amel Haddad");
    expect(await prisma.dossier.findUnique({ where: { id: sujetId } })).not.toBeNull();
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: billetterie } })).reservationDossierId).toBe(sujetId);
  }, 60_000);

  it("UN CONTRAT DE CONSULTING PASSÉ AUX RH n'est plus une demande Ad & Pro : seul le Super Admin le supprime", async () => {
    const dir = await acteur(dirId, "DIRECTION");
    const sa = await acteur(saId, "SUPER_ADMIN");
    const rh = await prisma.consultingContract.create({ data: { reference: `${RUN}C1`, title: `${TAG}Consultant RH`, counterparty: "Atakor", pole: "RH" } });
    const adpro = await prisma.consultingContract.create({ data: { reference: `${RUN}C2`, title: `${TAG}Consultant médical`, counterparty: "Atakor", pole: "AD_PRO" } });
    // La prémisse : la Direction VOIT les deux — le refus du premier vient du pôle, pas de la ligne.
    expect(await canAccessEntity(dir, "CONSULTING_CONTRACT", rh.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(dir, "CONSULTING_CONTRACT", adpro.id, "VIEW")).toBe(true);
    expect(await peutSupprimerUneDemandeAdPro(dir, "CONSULTING_CONTRACT", rh.id)).toBe(false);
    expect(await peutSupprimerUneDemandeAdPro(dir, "CONSULTING_CONTRACT", adpro.id)).toBe(true);
    expect(await peutSupprimerUneDemandeAdPro(sa, "CONSULTING_CONTRACT", rh.id)).toBe(true);
  });

  // ── LE DÉPÔT D'UN DEVIS ───────────────────────────────────────────────────────────────

  it("DEVIS : le titre et la pièce jointe suffisent — sans pièce, refusé ; un CONTRAT exige toujours sa partie", async () => {
    ACTOR = await acteur(saId, "SUPER_ADMIN");
    expect(userCan(ACTOR, "LEGAL", "CREATE")).toBe(true);
    const sansPiece = await createLegalDocument(undefined, fd({ kind: "QUOTE", title: `${TAG}Devis traiteur` }));
    expect(sansPiece.ok === false ? sansPiece.error : "créé").toMatch(/Un devis s'enregistre avec sa pièce jointe/);

    const avec = fd({ kind: "QUOTE", title: `${TAG}Devis traiteur` });
    avec.append("attachment", pdf("devis-traiteur.pdf"));
    const r = await createLegalDocument(undefined, avec);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const devis = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" } });
    expect(devis.kind).toBe("QUOTE");
    expect(devis.counterpartyIds, "aucun fournisseur exigé : il se lit sur le PDF").toEqual([]);
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: devis.id } })).toBe(1);

    // La modification d'un devis n'exige pas non plus de partie.
    const maj = await updateLegalDocument(fd({ id: devis.id, kind: "QUOTE", title: `${TAG}Devis traiteur (révisé)` }));
    expect(maj.ok, maj.ok === false ? maj.error : "").toBe(true);

    // L'AUTRE MOITIÉ : un contrat sans partie reste refusé — la règle s'est assouplie pour le devis
    // et pour lui seul.
    const contrat = fd({ kind: "CONTRACT", title: `${TAG}Contrat sans partie` });
    contrat.append("attachment", pdf("contrat.pdf"));
    const c = await createLegalDocument(undefined, contrat);
    expect(c.ok === false ? c.error : "créé").toMatch(/Choisissez au moins une partie/);
  });
});
