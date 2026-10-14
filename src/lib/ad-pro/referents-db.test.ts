import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { addBuMarketingReferent, removeBuMarketingReferent } from "@/lib/actions/sales-planning-actions";
import { createSponsoring } from "@/lib/actions/sponsoring-actions";
import { createEvent, submitEventForApproval } from "@/lib/actions/event-actions";
import { advanceWorkflowInstance } from "@/lib/workflow/engine";
import { referentAInscrire } from "@/lib/ad-pro/referent-de-la-gamme";
import { CHAMPS_MEDECINS, CHAMPS_PRODUITS } from "@/lib/ad-pro/pickers";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__refmkt__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * LE JUGE COMPTE PAR LE LIEN CAUSAL, jamais par destinataire seul (§118.36, §118.92).
 *
 * Les référents de ce banc portent le rôle Direction Marketing, et la suite tourne en parallèle
 * sur UNE base : toute notification PAR RÔLE émise au même instant par un autre fichier (une
 * pré-validation, un poste soumis…) atterrit chez eux. Compter « les notifications de dmId »
 * mesurait donc le voisinage — mesuré : 3 passages sur 3 verts seul, rouge dans la suite, sur
 * « expected 1 to be 0 ». Ce qui compte est une notification sur CETTE demande : le moteur pose
 * `link: /sponsoring/<id>` sur chacune.
 */
function notifsSurLaDemande(userId: string, demandeId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, link: { contains: demandeId } } });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÉFÉRENTS PAR GAMME, ÉPROUVÉS PAR LES VRAIS POINTS D'ENTRÉE.
 *
 * L'écran propose ; c'est l'action qui écrit, et c'est le MOTEUR qui prévient. Un banc qui se
 * contenterait de la décision pure confirmerait la règle et ne dirait RIEN de ce qui atteint la
 * base ni de qui reçoit la notification (§118.14, §118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — les référents Direction Marketing d'une gamme", () => {
  let dmId = "", dm2Id = "", sansRoleId = "", delegId = "", nsId = "", dgId = "", dirId = "", configId = "", gammeId = "";
  let perduId = "", temoinId = "", gamme2Id = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [dm, dm2, sans, deleg, ns] = await Promise.all([
      mk("dm", "PRODUCT_MANAGER"), mk("dm2", "PRODUCT_MANAGER"),
      mk("sans", "SALES_USER"), mk("deleg", "MEDICAL_DELEGATE"), mk("ns", "NATIONAL_SALES"),
    ]);
    dmId = dm.id; dm2Id = dm2.id; sansRoleId = sans.id; delegId = deleg.id; nsId = ns.id;
    // CELUI QUI CONFIGURE la force de vente porte `SALES_PLANNING:UPDATE`. Mesuré en écrivant ce
    // banc : le National Sales ne l'a qu'en LECTURE, et c'est juste — configurer les gammes
    // n'est pas les consulter. Un décor qui se trompe d'acteur mesure la permission, pas le
    // mécanisme (§118.92).
    configId = (await mk("cfg", "MEDICAL_PROMOTION_MANAGER")).id;
    dgId = (await mk("dg", "GENERAL_MANAGER")).id;
    // LA DIRECTION DES OPÉRATIONS tient l'étape `final`, que la route d'un National Sales
    // traverse (§118.142) : sans elle, l'étape Direction Marketing n'est jamais atteinte.
    dirId = (await mk("dir", "DIRECTION")).id;
    // LE CAS QUI COMPTE LE PLUS, et aucun sabotage ne pouvait le voir sans lui : une personne
    // DÉSIGNÉE puis RÉTROGRADÉE. C'est la situation pour laquelle §118.136 relit le rôle à
    // chaque affichage, et elle a sa propre gamme pour ne dépendre d'aucun cas précédent.
    perduId = (await mk("perdu", "PRODUCT_MANAGER")).id;
    // LE TÉMOIN : même rôle final que `perdu`, mais JAMAIS désigné. Sans lui, « `perdu` reçoit »
    // serait vrai par n'importe quelle notification de rôle, et ne mesurerait rien (§118.111).
    temoinId = (await mk("temoin", "SALES_USER")).id;
    gammeId = (await prisma.businessUnit.create({ data: { name: `${TAG}Onco`, isActive: true } })).id;
    gamme2Id = (await prisma.businessUnit.create({ data: { name: `${TAG}Cardio`, isActive: true } })).id;
    ACTOR = await actorFor(configId, "MEDICAL_PROMOTION_MANAGER");
  });

  afterAll(async () => {
    const ids = [dmId, dm2Id, sansRoleId, delegId, nsId, dgId, dirId, configId, perduId, temoinId];
    await prisma.businessUnitMarketingReferent.deleteMany({ where: { businessUnitId: { in: [gammeId, gamme2Id] } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    // Les instances se retrouvent par l'identifiant de leurs demandes — il faut donc les lire
    // AVANT de supprimer les demandes.
    const demandes = await prisma.sponsoringRequest.findMany({ where: { doctor: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    const evs = await prisma.event.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: evs.map((e) => e.id) } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { doctor: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("une personne SANS le rôle est REFUSÉE, et le refus nomme le geste qui le donne", async () => {
    // LA DÉSIGNATION CIBLE, ELLE N'ACCORDE PAS. Sans cette porte, un écran de configuration
    // COMMERCIALE fabriquerait une attente sans pouvoir : la personne est prévenue et ne peut
    // rien trancher (§118.30 — le refus nomme le remède).
    const fd = new FormData();
    fd.set("businessUnitId", gammeId);
    fd.set("userId", sansRoleId);
    const r = await addBuMarketingReferent(fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("Direction Marketing");
    expect(r.ok === false ? r.error : "", "le refus doit nommer OÙ attribuer le rôle").toContain("Administration");
    expect(await prisma.businessUnitMarketingReferent.count({ where: { businessUnitId: gammeId } })).toBe(0);
  });

  it("la désignation s'écrit, et un second clic ne la double pas", async () => {
    const fd = () => { const f = new FormData(); f.set("businessUnitId", gammeId); f.set("userId", dmId); return f; };
    expect((await addBuMarketingReferent(fd())).ok).toBe(true);
    // IDEMPOTENT et non en ÉCHEC : un double clic ne doit ni notifier deux fois ni faire croire
    // à une erreur.
    expect((await addBuMarketingReferent(fd())).ok).toBe(true);
    expect(await prisma.businessUnitMarketingReferent.count({ where: { businessUnitId: gammeId } })).toBe(1);
  });

  it("UN SEUL référent s'inscrit sur la demande ; DEUX n'en inscrivent aucun", async () => {
    // §118.34 par le vrai chemin : `productManagerId` avait sept lecteurs et aucun écrivain.
    expect(await referentAInscrire(gammeId)).toBe(dmId);
    const f = new FormData(); f.set("businessUnitId", gammeId); f.set("userId", dm2Id);
    expect((await addBuMarketingReferent(f)).ok).toBe(true);
    expect(await referentAInscrire(gammeId), "deux référents ne désignent personne").toBeNull();
    // …et une gamme inconnue ne désigne personne non plus, sans interroger la base pour rien.
    expect(await referentAInscrire(null)).toBeNull();
    expect(await referentAInscrire("")).toBeNull();
  });

  it("le retrait remet la gamme à un seul référent — donc à un nom inscriptible", async () => {
    const ligne = await prisma.businessUnitMarketingReferent.findUniqueOrThrow({
      where: { businessUnitId_userId: { businessUnitId: gammeId, userId: dm2Id } },
      select: { id: true },
    });
    const f = new FormData(); f.set("id", ligne.id);
    expect((await removeBuMarketingReferent(f)).ok).toBe(true);
    expect(await referentAInscrire(gammeId)).toBe(dmId);
    // Retirer deux fois n'est pas un échec : le geste est idempotent dans les deux sens.
    expect((await removeBuMarketingReferent(f)).ok).toBe(true);
  });

  it("LA GAMME QU'ON ÉCRIT EST CELLE DONT ON PREND LE RÉFÉRENT — même par la porte de SOUMISSION", async () => {
    /*
     * ═════════════════════════════════════════════════════════════════════════════════════
     * DEUX DÉFAUTS DE MON PROPRE LOT, TROUVÉS EN RELISANT LE DIFF DE L'ARTEFACT (§118.137).
     *
     * `submitEventForApproval` lisait la gamme dans le FORMULAIRE. Elle soumet un événement qui
     * EXISTE déjà, et son seul appelant (`funding-panel.tsx`) n'envoie que `id` : la lecture
     * rendait `""`, `referentAInscrire` rendait `null`, et AUCUN événement du parc ne recevait
     * jamais son référent. Le mécanisme était écrit, testé, et mort par sa porte réelle
     * (§118.14). La régénération de l'artefact l'a dit en une ligne — l'action a « gagné » un
     * champ `businessUnitId` qu'aucun écran ne remplit.
     *
     * Et chez le sponsoring, la gamme se lisait DEUX fois : la ligne recevait la gamme DÉDUITE du
     * demandeur (§118.108), le référent était cherché sur le formulaire. Les deux pouvaient
     * désigner des gammes différentes — inscrire l'arbitre de la gamme A sur une demande déposée
     * sous la gamme B (§104.7).
     *
     * CE QUE CE CAS TIENT : le référent vient de la gamme que la LIGNE porte, par les deux
     * portes. Il passe par `createEvent` puis `submitEventForApproval` avec le formulaire EXACT
     * de l'écran — `id` et rien d'autre.
     * ═════════════════════════════════════════════════════════════════════════════════════
     */
    // Une gamme neuve avec UN référent, pour ne dépendre d'aucun cas précédent.
    const g3 = await prisma.businessUnit.create({ data: { name: `${TAG}Neuro`, isActive: true } });
    ACTOR = await actorFor(configId, "MEDICAL_PROMOTION_MANAGER");
    const fdR = new FormData(); fdR.set("businessUnitId", g3.id); fdR.set("userId", dm2Id);
    expect((await addBuMarketingReferent(fdR)).ok).toBe(true);

    ACTOR = await actorFor(nsId, "NATIONAL_SALES");
    const fdE = new FormData();
    fdE.set("name", `${TAG}Journée Neuro`);
    fdE.set("businessUnitId", g3.id);
    fdE.set("type", "Congrès");
    fdE.set("specialty", "Neurologie");
    fdE.set("city", "Constantine");
    fdE.set("estimatedBudget", "300000");
    fdE.set("strategicImportance", "HIGH");
    // TOUS les champs que `champsManquants` exige (§118.142 : « quasi tout obligatoire »). Le
    // décor les porte parce que l'action REFUSE sans eux — et ce refus est juste : c'est le décor
    // qui doit se compléter, pas la garde s'assouplir.
    fdE.set("scope", "NATIONAL");
    fdE.set("format", "IN_PERSON");
    fdE.set("startDate", "2026-11-10");
    fdE.set("endDate", "2026-11-11");
    fdE.set("location", "Hôtel Panoramic");
    fdE.set("country", "Algérie");
    fdE.set("responsibleId", nsId);
    fdE.set("description", `${TAG}Journée de formation neurologie.`);
    fdE.set(CHAMPS_MEDECINS.libre, `${TAG}Dr Trois`);
    fdE.set(CHAMPS_PRODUITS.libre, `${TAG}Produit Trois`);
    const cree = await createEvent(fdE);
    expect(cree.ok, cree.ok === false ? cree.error : "").toBe(true);
    const evId = cree.ok ? cree.id! : "";
    // LA PRÉMISSE : la ligne porte bien la gamme. Sans elle, le zéro plus bas serait vrai pour
    // la mauvaise raison (§118.104).
    const avant = await prisma.event.findUniqueOrThrow({ where: { id: evId }, select: { businessUnitId: true, productManagerId: true } });
    expect(avant.businessUnitId, "la gamme est écrite à la création").toBe(g3.id);
    expect(avant.productManagerId, "rien n'est inscrit tant que la demande n'est pas soumise").toBeNull();

    // LE FORMULAIRE EXACT DE L'ÉCRAN : `id`, et rien d'autre. C'est ce qui rend le cas décisif —
    // avec un `businessUnitId` ajouté ici, il passerait au vert sur le défaut.
    const fdS = new FormData(); fdS.set("id", evId);
    const soumis = await submitEventForApproval(fdS);
    expect(soumis.ok, soumis.ok === false ? soumis.error : "").toBe(true);
    const apres = await prisma.event.findUniqueOrThrow({ where: { id: evId }, select: { productManagerId: true } });
    expect(apres.productManagerId,
      "le référent vient de la gamme de la LIGNE, que le formulaire de soumission ne porte pas").toBe(dm2Id);

    await prisma.businessUnitMarketingReferent.deleteMany({ where: { businessUnitId: g3.id } });
  });

  it("UN RÉFÉRENT QUI A PERDU LE RÔLE est encore PRÉVENU, et n'est plus INSCRIT", async () => {
    /*
     * ═════════════════════════════════════════════════════════════════════════════════════
     * LE CAS QUE TROIS SABOTAGES ONT NOMMÉ, et qu'aucune relecture n'aurait trouvé.
     *
     * Joués sur le lot, trois sabotages sont passés au VERT : `porteLeRole: true` en dur dans le
     * chargeur, la notification des référents retirée DU TOUT, et l'étape de montage ramenée à
     * « au moins un référent ». Les trois avaient la même cause, et ce n'était pas « le code est
     * bon » : c'était « je ne teste pas ce que je crois » (§118.111, §118.134). Mon décor ne
     * portait QUE des référents qui portent le rôle, or :
     *
     *   · `porteLeRole` y valait toujours vrai, donc le forcer ne changeait rien ;
     *   · les référents portaient TOUS le rôle, donc la notification par RÔLE les atteignait de
     *     toute façon — l'assertion était vraie par le mauvais chemin.
     *
     * La situation qui discrimine est celle pour laquelle §118.136 relit le rôle à CHAQUE
     * affichage : quelqu'un de désigné, puis MUTÉ. Elle arrive en production, et elle est la
     * seule où la notification NOMMÉE est le seul chemin possible.
     *
     * LE TÉMOIN fait le reste du travail : `temoin` porte le MÊME rôle final que `perdu` et n'est
     * PAS désigné. Si les deux recevaient, la mesure ne dirait rien sur la désignation.
     * ═════════════════════════════════════════════════════════════════════════════════════
     */
    // Désignation par le VRAI chemin, qui exige le rôle — c'est ainsi que la ligne naît.
    ACTOR = await actorFor(configId, "MEDICAL_PROMOTION_MANAGER");
    const fd0 = new FormData(); fd0.set("businessUnitId", gamme2Id); fd0.set("userId", perduId);
    expect((await addBuMarketingReferent(fd0)).ok).toBe(true);
    expect(await referentAInscrire(gamme2Id), "tant qu'il porte le rôle, il est inscriptible").toBe(perduId);

    // LA MUTATION. Rien ne supprime la désignation : c'est le rôle qui est relu.
    await prisma.user.update({ where: { id: perduId }, data: { role: "SALES_USER" } });
    expect(await referentAInscrire(gamme2Id),
      "muté, il ne peut plus trancher : on n'inscrit JAMAIS `productManagerId` au nom de quelqu'un sans le rôle").toBeNull();

    // …et il est POURTANT encore prévenu : la désignation cible la notification, pas le pouvoir.
    const fd = new FormData();
    fd.set("institution", `${TAG}Cardio Assoc`);
    fd.set("businessUnitId", gamme2Id);
    fd.set("type", "Congrès");
    fd.set("specialty", "Cardiologie");
    fd.set("city", "Oran");
    fd.set("amountRequested", "2000000");
    fd.set("amountProposed", "2000000");
    fd.set("nature", "DIRECT");
    fd.set("strategicImportance", "HIGH");
    fd.set(CHAMPS_MEDECINS.libre, `${TAG}Dr Deux`);
    fd.set(CHAMPS_PRODUITS.libre, `${TAG}Produit Deux`);
    fd.set("files", new File([new Uint8Array([1, 2, 3])], "demande.pdf", { type: "application/pdf" }));
    ACTOR = await actorFor(nsId, "NATIONAL_SALES");
    const cree = await createSponsoring(undefined, fd);
    expect(cree.ok, cree.ok === false ? cree.error : "").toBe(true);
    const id = cree.ok ? cree.id! : "";
    await prisma.notification.deleteMany({ where: { userId: { in: [perduId, temoinId] } } });

    for (const v of [
      { id: dgId, role: "GENERAL_MANAGER" as const, name: `${TAG}dg` },
      { id: dirId, role: "DIRECTION" as const, name: `${TAG}dir` },
    ]) {
      const av = await advanceWorkflowInstance({ viewer: v, entityType: "SPONSORING", entityId: id, action: "APPROVE", note: "OK" });
      expect(av.ok, av.ok === false ? av.error : "").toBe(true);
    }
    const inst = await prisma.workflowInstance.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: "SPONSORING", entityId: id } },
      select: { currentSlug: true },
    });
    expect(inst.currentSlug, "la prémisse : l'étape de la Direction Marketing est atteinte").toBe("marketing");

    expect(await notifsSurLaDemande(perduId, id),
      "désigné puis muté : il reste prévenu NOMMÉMENT — c'est le seul chemin, son rôle ne le porte plus").toBeGreaterThanOrEqual(1);
    expect(await notifsSurLaDemande(temoinId, id),
      "même rôle, JAMAIS désigné : rien. C'est ce zéro qui prouve que le premier vient de la désignation").toBe(0);
  });

  it("LE RÉFÉRENT EST PRÉVENU quand l'étape de la gamme est atteinte — le rôle aussi", async () => {
    /*
     * LA PROPRIÉTÉ QUI COMPTE, par le VRAI moteur : les référents s'AJOUTENT au rôle.
     *
     * Ce qui le ferait tomber : notifier les référents À LA PLACE du rôle (la direction du
     * département ne recevrait plus rien — « recevra ÉGALEMENT » tombe), ou ne pas les notifier
     * du tout (la désignation ne servirait à rien, §118.14).
     */
    /*
     * LE DÉCOR EST CONTRAINT PAR DEUX FAITS MESURÉS, et les nommer évite de croire qu'on
     * mesure autre chose (§118.92) :
     *
     *   · AUCUN rôle de KAM ne peut CRÉER un sponsoring (`SPONSORING:CREATE` appartient au
     *     Super Admin, à la Direction, au DG, au National Sales et à Direction Marketing) : le
     *     demandeur est donc le National Sales, qui entre sur la porte du DG (§118.142) ;
     *   · pour que le franchissement ATTEIGNE l'étape Direction Marketing, la porte du DG ne
     *     doit pas se franchir seule : le montant est donc AU-DESSUS du seuil. En dessous, elle
     *     se franchit à la création et l'étape est atteinte sans qu'aucune approbation ait lieu.
     */
    const fd = new FormData();
    fd.set("institution", `${TAG}Association`);
    fd.set("businessUnitId", gammeId);
    fd.set("type", "Congrès");
    fd.set("specialty", "Cardiologie");
    fd.set("city", "Alger");
    fd.set("amountRequested", "2000000");
    fd.set("amountProposed", "2000000");
    fd.set("nature", "DIRECT");
    fd.set("strategicImportance", "HIGH");
    fd.set(CHAMPS_MEDECINS.libre, `${TAG}Dr Test`);
    fd.set(CHAMPS_PRODUITS.libre, `${TAG}Produit`);
    // LA DEMANDE DU MÉDECIN EST OBLIGATOIRE depuis §118.108 : sans elle l'action refuse, et le
    // refus est JUSTE — le décor doit la joindre, pas la garde s'assouplir.
    fd.set("files", new File([new Uint8Array([1, 2, 3])], "demande.pdf", { type: "application/pdf" }));
    ACTOR = await actorFor(nsId, "NATIONAL_SALES");
    const cree = await createSponsoring(undefined, fd);
    expect(cree.ok, cree.ok === false ? cree.error : "").toBe(true);
    const id = cree.ok ? cree.id! : "";

    // LA DEMANDE PORTE LE NOM DE SON RÉFÉRENT : la gamme n'en a qu'un (cas précédent).
    const demande = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id }, select: { productManagerId: true } });
    expect(demande.productManagerId, "un seul référent ⇒ la demande est inscrite à son nom").toBe(dmId);

    /*
     * LA ROUTE D'UN NATIONAL SALES EST `dg` → `final` → `marketing` (§118.142) : il faut DEUX
     * approbations pour atteindre l'étape de la Direction Marketing. Le mesurer plutôt que le
     * supposer a d'ailleurs trouvé le vrai défaut du lot : la première version notifiait les
     * référents à CHAQUE étape atteinte, donc deux fois pour rien avant celle qui les concerne.
     */
    await prisma.notification.deleteMany({ where: { userId: { in: [dmId, dm2Id] } } });
    const avDg = await advanceWorkflowInstance({
      viewer: { id: dgId, role: "GENERAL_MANAGER", name: `${TAG}dg` },
      entityType: "SPONSORING", entityId: id, action: "APPROVE", note: "OK",
    });
    expect(avDg.ok, avDg.ok === false ? avDg.error : "").toBe(true);

    // L'ÉTAPE INTERMÉDIAIRE NE CONCERNE PAS LA GAMME : son `notifyRoles` ne nomme pas la
    // Direction Marketing, donc aucun référent ne doit être dérangé. Sans ce compte à ZÉRO, la
    // garde d'étape serait désarmée en ayant l'air armée (§118.17) — l'assertion finale serait
    // vraie par la notification de cette étape-ci.
    const apresFinal = await prisma.workflowInstance.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: "SPONSORING", entityId: id } },
      select: { currentSlug: true },
    });
    expect(apresFinal.currentSlug, "la route du National Sales passe par la Direction des opérations").toBe("final");
    expect(await notifsSurLaDemande(dmId, id),
      "l'étape Direction des opérations ne nomme pas le rôle marketing : le référent n'est pas dérangé").toBe(0);

    const av = await advanceWorkflowInstance({
      viewer: { id: dirId, role: "DIRECTION", name: `${TAG}dir` },
      entityType: "SPONSORING", entityId: id, action: "APPROVE", note: "OK",
    });
    expect(av.ok, av.ok === false ? av.error : "").toBe(true);
    // LA PRÉMISSE : l'étape atteinte est bien celle de la Direction Marketing. Sans elle, les
    // deux comptes ci-dessous seraient vrais pour la mauvaise raison (§118.104).
    const inst = await prisma.workflowInstance.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: "SPONSORING", entityId: id } },
      select: { currentSlug: true },
    });
    expect(inst.currentSlug, "le franchissement doit atteindre l'étape Direction Marketing").toBe("marketing");
    // LE RÉFÉRENT, NOMMÉMENT.
    expect(await notifsSurLaDemande(dmId, id),
      "le référent de la gamme doit être prévenu nommément").toBeGreaterThanOrEqual(1);
    // ET LE RÔLE : `dm2` n'est PLUS référent (retiré au cas précédent) et porte le rôle — il
    // reçoit donc par le RÔLE. C'est la moitié « recevra ÉGALEMENT » de la décision, et sans ce
    // second compte un remplacement du rôle par les référents passerait inaperçu.
    expect(await notifsSurLaDemande(dm2Id, id),
      "le rôle Direction Marketing reste prévenu (la direction du département)").toBeGreaterThanOrEqual(1);
  });
});
