import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { recordFieldChanges } from "@/lib/audit";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANNULATION PAR LE VRAI CHEMIN (mandat 6 §48).
 *
 * Rien n'est injecté : l'histoire est écrite par `recordFieldChanges`, la fonction que les
 * cinq cents écritures de l'ERP appellent déjà, et l'annulation est demandée par
 * `executePowerTool`, le dispatcher qu'Adam appelle en production.
 *
 * Le test central est celui du CONFLIT, et il est écrit contre une VRAIE base : Adam met le
 * dossier à AWAITING_ANPP, une personne le passe à BLOCKED, on demande l'annulation. Le
 * système doit refuser, nommer la personne, et LAISSER BLOCKED. Un système qui remettrait
 * IN_PREPARATION serait techniquement correct et professionnellement catastrophique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `ANN${Date.now().toString(36).toUpperCase()}`;
let pdg: CurrentUser;
let lecteur: CurrentUser;
let yassine: CurrentUser;
let direction: CurrentUser;
let dossierId = "";
let tacheId = "";
let paiementId = "";

const appel = async (u: CurrentUser, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const brut = await executePowerTool("annuler_changements", input, u);
  expect(brut, `outil non branché : ${JSON.stringify(input)}`).not.toBeNull();
  return JSON.parse(brut!) as Record<string, unknown>;
};

const creerUser = async (nom: string, role: "SUPER_ADMIN" | "VIEWER" | "DIRECTION"): Promise<CurrentUser> => {
  const x = await prisma.user.create({
    data: { name: `${TAG} ${nom}`, email: `${TAG.toLowerCase()}${nom.toLowerCase()}@amd.dz`, passwordHash: "x", role },
    select: { id: true, name: true, email: true, role: true },
  });
  return { id: x.id, name: x.name, email: x.email, role: x.role, access: (await getAccess(x.id, x.role)) as EffectiveAccess, mustChangePassword: false };
};

const hier = new Date(Date.now() - 86_400_000);
const avantHier = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

suite("annulation — défaire ce qu'Adam a fait, sans effacer ce qu'un humain a fait depuis", () => {
  beforeAll(async () => {
    pdg = await creerUser("PDG", "SUPER_ADMIN");
    yassine = await creerUser("Yassine", "SUPER_ADMIN");
    lecteur = await creerUser("Lecteur", "VIEWER");
    direction = await creerUser("Direction", "DIRECTION");

    const d = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-001`, dci: `${TAG} molécule`, brandName: `${TAG} marque`, status: "AWAITING_ANPP", priority: "HIGH" },
      select: { id: true },
    });
    dossierId = d.id;

    const t = await prisma.task.create({
      data: { title: `${TAG} relire le dossier`, status: "IN_PROGRESS", priority: "HIGH", createdById: pdg.id },
      select: { id: true },
    });
    tacheId = t.id;

    const pay = await prisma.paymentRequest.create({
      data: { reference: `${TAG}-PAY`, title: `${TAG} règlement Hetero`, amount: 100_000, payee: "Hetero Labs", requesterId: pdg.id },
      select: { id: true },
    });
    paiementId = pay.id;

    // ── L'HISTOIRE, ÉCRITE PAR LE VRAI CHEMIN ──────────────────────────────────────────
    // Adam a fait trois choses hier : deux modifications de champ et un e-mail.
    await recordFieldChanges(
      { actorId: pdg.id, module: "Regulatory (Adam)", entityType: "REGULATORY_PRODUCT", entityId: dossierId, summary: "Adam a fait avancer le dossier" },
      { status: "IN_PREPARATION", priority: "MEDIUM" },
      { status: "AWAITING_ANPP", priority: "HIGH" },
      ["status", "priority"],
    );
    await recordFieldChanges(
      { actorId: pdg.id, module: "Workspace (Adam)", entityType: "TASK", entityId: tacheId, summary: "Adam a relevé la priorité de la tâche" },
      { priority: "LOW" }, { priority: "HIGH" }, ["priority"],
    );
    await recordFieldChanges(
      { actorId: pdg.id, module: "Validations (Adam)", entityType: "PAYMENT_REQUEST", entityId: paiementId, summary: "Adam a reformulé l'intitulé" },
      { title: "ancien intitulé" }, { title: `${TAG} règlement Hetero` }, ["title"],
    );
    await prisma.auditLog.create({
      data: {
        actorId: pdg.id, action: "UPDATE", module: "Regulatory (Adam)", entityType: "REGULATORY_PRODUCT",
        entityId: dossierId, summary: "e-mail envoyé au partenaire Hetero Labs", createdAt: hier,
      },
    });
    // On recule les lignes dans le temps : l'annulation porte sur « hier ».
    await prisma.auditLog.updateMany({ where: { entityId: { in: [dossierId, tacheId, paiementId] } }, data: { createdAt: hier } });
  }, 90_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [dossierId, tacheId, paiementId] } } });
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } });
    // Un banc voisin, en parallèle, peut avoir désigné l'un de NOS Super Admin comme valideur d'une
    // étape : on retire ces étapes avant les comptes, sinon la clé étrangère refuse la suppression.
    const nous = (await prisma.user.findMany({ where: { email: { startsWith: TAG.toLowerCase() } }, select: { id: true } })).map((u) => u.id);
    await prisma.validationStep.deleteMany({ where: { validatorId: { in: nous } } });
    await prisma.user.deleteMany({ where: { id: { in: nous } } });
  });

  it("« voir » n'écrit RIEN, et sépare ce qui se défait de ce qui ne se défait pas", async () => {
    const avant = await prisma.regulatoryProduct.findUnique({ where: { id: dossierId }, select: { status: true } });

    const r = await appel(pdg, { question: "voir", entite: "REGULATORY_PRODUCT", enregistrement: dossierId, depuis: avantHier });
    expect(r.erreur, JSON.stringify(r)).toBeUndefined();

    const aDefaire = r.a_defaire as Array<Record<string, unknown>>;
    const bloques = r.ne_peut_pas_etre_defait as Array<Record<string, unknown>>;
    expect(aDefaire.length, JSON.stringify(r)).toBeGreaterThanOrEqual(2); // status + priority
    expect(bloques.length, JSON.stringify(r)).toBeGreaterThanOrEqual(1);  // l'e-mail

    // L'e-mail est nommé, avec sa compensation — c'est ce que la personne doit apprendre.
    const mail = bloques.find((b) => String(b.nature) === "MESSAGE_ENVOYE");
    expect(mail, JSON.stringify(bloques)).toBeTruthy();
    expect(String(mail!.a_la_place)).toMatch(/rectificatif/i);

    // Et la base n'a pas bougé d'un octet.
    const apres = await prisma.regulatoryProduct.findUnique({ where: { id: dossierId }, select: { status: true } });
    expect(apres!.status).toBe(avant!.status);
  }, 60_000);

  it("LE TEST QUI COMPTE : un champ qu'une personne a changé depuis n'est pas écrasé, et on la nomme", async () => {
    // Yassine passe le dossier à BLOCKED — après Adam, et pour une vraie raison.
    await prisma.regulatoryProduct.update({ where: { id: dossierId }, data: { status: "BLOCKED" } });
    await recordFieldChanges(
      { actorId: yassine.id, module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: dossierId, summary: "échantillon refusé" },
      { status: "AWAITING_ANPP" }, { status: "BLOCKED" }, ["status"],
    );

    const vu = await appel(pdg, { question: "voir", entite: "REGULATORY_PRODUCT", enregistrement: dossierId, depuis: avantHier });
    const bloques = vu.ne_peut_pas_etre_defait as Array<Record<string, unknown>>;
    const conflit = bloques.find((b) => String(b.motif) === "MODIFIE_DEPUIS");
    expect(conflit, JSON.stringify(bloques)).toBeTruthy();
    expect(String(conflit!.pourquoi)).toContain("Yassine");
    expect(String(conflit!.pourquoi)).toContain("BLOCKED");

    // Le statut n'est plus proposé à l'annulation ; la priorité, que personne n'a touchée, l'est.
    const aDefaire = (vu.a_defaire as Array<Record<string, unknown>>).map((g) => String(g.quoi));
    expect(aDefaire.some((q) => q.includes("status"))).toBe(false);
    expect(aDefaire.some((q) => q.includes("priority"))).toBe(true);

    // On applique : la priorité revient, le statut de Yassine SURVIT.
    const fait = await appel(pdg, { question: "appliquer", entite: "REGULATORY_PRODUCT", enregistrement: dossierId, depuis: avantHier });
    expect(fait.erreur, JSON.stringify(fait)).toBeUndefined();

    const etat = await prisma.regulatoryProduct.findUnique({ where: { id: dossierId }, select: { status: true, priority: true } });
    expect(etat!.status, "le travail de Yassine a été écrasé").toBe("BLOCKED");
    expect(etat!.priority).toBe("MEDIUM");

    // Et la phrase de conclusion ne dit PAS « annulé ».
    expect(String(fait.resultat)).toMatch(/PAS une annulation complète/i);
    consignerMesure("jamais_ecraser_un_humain", { n: 1, ok: etat!.status === "BLOCKED" ? 1 : 0 },
      "platform/in-process/annulation/annulation.test.ts",
      "BLOCKED posé par Yassine survit à l'annulation ; le refus le nomme, lui et sa date");
  }, 60_000);

  it("l'annulation est elle-même journalisée — l'histoire s'allonge, elle ne se réécrit pas", async () => {
    const lignes = await prisma.auditLog.findMany({
      where: { entityId: dossierId, module: { contains: "annulation" } },
      select: { field: true, oldValue: true, newValue: true, actorId: true },
    });
    expect(lignes.length, "aucune trace de l'annulation").toBeGreaterThanOrEqual(1);
    const l = lignes.find((x) => x.field === "priority")!;
    expect(l.oldValue).toBe("HIGH");
    expect(l.newValue).toBe("MEDIUM");
    expect(l.actorId).toBe(pdg.id);

    // ET LA LIGNE D'ORIGINE EST TOUJOURS LÀ : on n'efface jamais une ligne d'audit.
    const origine = await prisma.auditLog.findFirst({
      where: { entityId: dossierId, field: "priority", oldValue: "MEDIUM", newValue: "HIGH" },
      select: { id: true },
    });
    expect(origine, "la ligne d'origine a disparu — l'audit a été réécrit").toBeTruthy();
    consignerMesure("annulation_journalisee", { n: 2, ok: (lignes.length > 0 ? 1 : 0) + (origine ? 1 : 0) },
      "platform/in-process/annulation/annulation.test.ts",
      "l'annulation s'inscrit au journal ET la ligne d'origine survit");
  }, 60_000);

  it("l'outil n'a AUCUN droit propre : il hérite exactement de ceux du module", async () => {
    // ── LA PREMIÈRE PORTE : le module lui-même ────────────────────────────────────────
    // Un VIEWER n'a rien du tout sur REGULATORY. L'aperçu est refusé AVANT toute lecture
    // d'historique — donc sans même révéler qu'il s'est passé quelque chose sur le dossier.
    const vu = await appel(lecteur, { question: "voir", entite: "REGULATORY_PRODUCT", enregistrement: dossierId, depuis: avantHier });
    expect(String(vu.erreur ?? "")).toMatch(/acc[èe]s au module/i);
    expect(JSON.stringify(vu)).not.toContain("AWAITING_ANPP");

    // ── LA SECONDE PORTE : le droit d'ÉCRIRE, distinct du droit de voir ───────────────
    // DIRECTION voit les validations sans pouvoir les modifier. Le plan lui est donc montré —
    // c'est une lecture, elle y a droit — et l'application seule est refusée.
    const apercu = await appel(direction, { question: "voir", entite: "PAYMENT_REQUEST", enregistrement: paiementId, depuis: avantHier });
    expect(apercu.erreur, JSON.stringify(apercu)).toBeUndefined();
    expect((apercu.a_defaire as unknown[]).length).toBeGreaterThanOrEqual(1);

    const ecrit = await appel(direction, { question: "appliquer", entite: "PAYMENT_REQUEST", enregistrement: paiementId, depuis: avantHier });
    expect(String(ecrit.erreur ?? "")).toMatch(/pas y écrire|MODIFIER/i);
    const pay = await prisma.paymentRequest.findUnique({ where: { id: paiementId }, select: { title: true } });
    expect(pay!.title).toBe(`${TAG} règlement Hetero`);

    // ── ET LA CONTREPARTIE, QUI EST LE POINT ─────────────────────────────────────────
    // Un VIEWER PEUT défaire un changement de tâche, parce qu'un VIEWER peut RÉELLEMENT
    // modifier une tâche (WORKSPACE : VIEW + UPDATE + CREATE). L'outil ne restreint pas plus
    // que l'écran, et ne restreint pas moins : il ne connaît pas de droit à lui.
    await prisma.task.update({ where: { id: tacheId }, data: { priority: "HIGH" } });
    const parLeLecteur = await appel(lecteur, { question: "appliquer", entite: "TASK", enregistrement: tacheId, depuis: avantHier });
    expect(parLeLecteur.erreur, JSON.stringify(parLeLecteur)).toBeUndefined();
    expect(parLeLecteur.defaits).toBe(1);
    const t = await prisma.task.findUnique({ where: { id: tacheId }, select: { priority: true } });
    expect(t!.priority).toBe("LOW");
    consignerMesure("annulation_sans_droit_propre", { n: 3, ok: 3 },
      "platform/in-process/annulation/annulation.test.ts",
      "VIEW refusé sur Regulatory, UPDATE refusé à la DIRECTION sur une validation, et un VIEWER défait bien une tâche qu'il peut modifier");
  }, 60_000);

  it("`changements` borne l'application à ce qui a été montré", async () => {
    // On repart d'un état connu : ce test ne doit rien devoir au précédent.
    await prisma.task.update({ where: { id: tacheId }, data: { priority: "HIGH" } });
    const vu = await appel(pdg, { question: "voir", entite: "TASK", enregistrement: tacheId, depuis: avantHier });
    const ids = (vu.a_defaire as Array<Record<string, unknown>>).map((g) => String(g.id));
    expect(ids.length).toBeGreaterThanOrEqual(1);

    // On n'en retient AUCUN : rien ne doit bouger, et le compte doit le dire.
    const rien = await appel(pdg, { question: "appliquer", entite: "TASK", enregistrement: tacheId, depuis: avantHier, changements: [] });
    expect(rien.defaits).toBe(0);
    const t1 = await prisma.task.findUnique({ where: { id: tacheId }, select: { priority: true } });
    expect(t1!.priority).toBe("HIGH");

    // Puis on retient le bon : il s'applique.
    const fait = await appel(pdg, { question: "appliquer", entite: "TASK", enregistrement: tacheId, depuis: avantHier, changements: ids });
    expect(fait.defaits).toBe(1);
    const t2 = await prisma.task.findUnique({ where: { id: tacheId }, select: { priority: true } });
    expect(t2!.priority).toBe("LOW");
  }, 60_000);

  it("un type d'entité qu'on ne sait pas défaire est refusé en le disant, pas ignoré", async () => {
    const r = await appel(pdg, { question: "voir", entite: "EMPLOYEE", enregistrement: "peu-importe", depuis: avantHier });
    expect(String(r.erreur ?? "")).toMatch(/n'est pas de ceux/i);
  }, 60_000);

  // ── L'AUTORISATION DU CENTRE NE SE « DÉFAIT » PAS (§118.148) ─────────────────────────────
  // « Tous les paiements passent par le centre de paiements. » Le centre vient de ROUVRIR un
  // ordre (montant relevé → AWAITING). « Annule ce qu'Adam a modifié sur cet ordre » remettait
  // `APPROVED` : une autorisation rendue par un outil de rangement, avec pour seule garde le
  // droit d'écrire sur les Finances. L'acteur est ici Super Admin — il SIÈGE au centre — et le
  // refus tient quand même : ce n'est pas une question de droit, c'est un geste qui ne se rejoue
  // pas en dehors du centre, où l'on voit ce qu'on autorise.
  it("remettre « Autorisé » sur un ordre que le centre a rouvert est REFUSÉ, et l'ordre reste en attente", async () => {
    const ordre = await prisma.expenseOrder.create({
      data: { reference: `${TAG}-OD`, label: `${TAG} stand SAHO`, amount: 900_000, centralStatus: "AWAITING", requestedById: pdg.id },
      select: { id: true },
    });
    try {
      await recordFieldChanges(
        { actorId: pdg.id, module: "Finances (Adam)", entityType: "EXPENSE_ORDER", entityId: ordre.id, summary: "Adam a relevé le montant — l'ordre retourne au centre" },
        { centralStatus: "APPROVED" }, { centralStatus: "AWAITING" }, ["centralStatus"],
      );
      await prisma.auditLog.updateMany({ where: { entityId: ordre.id }, data: { createdAt: hier } });

      const r = await appel(pdg, { question: "appliquer", entite: "EXPENSE_ORDER", enregistrement: ordre.id, depuis: avantHier });
      expect(r.defaits ?? 0, JSON.stringify(r)).toBe(0);
      const apres = await prisma.expenseOrder.findUnique({ where: { id: ordre.id }, select: { centralStatus: true } });
      expect(apres!.centralStatus, "l'autorisation se donne au centre, jamais par une annulation").toBe("AWAITING");
    } finally {
      await prisma.auditLog.deleteMany({ where: { entityId: ordre.id } });
      await prisma.expenseOrder.delete({ where: { id: ordre.id } }).catch(() => {});
    }
  }, 60_000);
});
