import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createConsultingContract } from "@/lib/actions/consulting-actions";
import { createAdProOtherRequest } from "./actions-autres";
import { createCongressRequest } from "./actions-congres";
import { getAdProCreateData } from "./infra/requetes/demandes";
import { getCongressDetail } from "./infra/requetes/congres";
import { AD_PRO_KINDS } from "./domaine/unified";
import { natureDesigneMedecins, natureDesigneMedecinsEtProduits } from "./domaine/create-fields";
import { AVAILABLE_PRODUCT_STATUSES } from "./domaine/pickers";
import { CHAMPS_MEDECINS, CHAMPS_PRODUITS, MULTI_SEP } from "./domaine/pickers";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adproref__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PRATICIEN, LE PRODUIT ET LA GAMME ARRIVENT EN BASE — par les VRAIES actions.
 *
 * Le formulaire propose ; c'est l'action qui écrit, et c'est elle qu'Adam poste aussi par le
 * chemin générique. Un banc qui se contenterait de vérifier la liste de champs confirmerait que
 * le menu existe et ne dirait RIEN de ce qui atterrit dans la colonne (§118.14, §118.49).
 *
 * LE DÉFAUT LE PLUS GRAVE QUE CE BANC FERME n'est pas l'absence de champ : le consulting et
 * « autre demande » posaient déjà un menu « Business Unit » OBLIGATOIRE, et ni le modèle ni
 * l'action ne l'avaient — le choix imposé au demandeur était JETÉ. Un champ requis sans effet
 * est pire qu'un champ absent : il fait croire que la dépense est rattachée (§118.140).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — praticiens, produits et gamme écrits par les vraies actions", () => {
  let demandeurId = "", gammeId = "";

  beforeAll(async () => {
    /*
     * L'ACTEUR EST UN VRAI RÔLE DU MÉTIER, ET SON RÔLE EST CELUI DE LA BASE.
     *
     * Mesuré en écrivant ce banc : `getAccess(id, roleHint)` résout le rôle EN DIRECT depuis la
     * base (`userRow?.role ?? roleHint`) — l'indice passé en argument ne sert que de repli. Un
     * décor qui crée un délégué médical et passe « SUPER_ADMIN » obtient donc l'accès du
     * DÉLÉGUÉ, et le délégué n'a aucun droit sur le consulting : mes trois premiers cas se sont
     * fait refuser « Création réservée aux personnes habilitées » et j'ai d'abord cherché le
     * défaut dans le produit (§118.92 — qu'est-ce que le juge a réellement mesuré ?).
     *
     * On prend donc Direction Marketing, qui gère les SEPT natures du pôle : c'est l'acteur
     * réaliste de ces créations, et il n'a PAS la vue globale — une garde éprouvée avec un
     * Super Admin ne peut pas tomber (§118.104).
     */
    const dem = await prisma.user.create({
      data: { name: `${TAG}dem`, email: `${TAG}dem@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" },
    });
    demandeurId = dem.id;
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Onco`, isActive: true } });
    gammeId = bu.id;
    // UN MÉDECIN ET UN PRODUIT BIEN À NOUS : sans eux, le cas du chargeur ci-dessous
    // comparerait des listes VIDES et serait vrai quelle que soit la porte (§118.117).
    await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Test`, specialty: "Cardiologie" } });
    await prisma.regulatoryProduct.create({
      data: {
        reference: `${TAG}REF1`, dci: `${TAG}Molecule`, brandName: `${TAG}Nivolex`,
        status: AVAILABLE_PRODUCT_STATUSES[0] as never,
      },
    });
    ACTOR = await actorFor(demandeurId, "PRODUCT_MANAGER");
  });

  afterAll(async () => {
    await prisma.consultingTask.deleteMany({ where: { contract: { title: { startsWith: TAG } } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: demandeurId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: demandeurId } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("CONSULTING : deux praticiens, deux produits, une gamme — tout arrive en base", async () => {
    const fd = new FormData();
    fd.set("title", `${TAG}Accompagnement`);
    fd.set("counterparty", "Cabinet Reg&Co");
    fd.set("businessUnitId", gammeId);
    fd.append(CHAMPS_MEDECINS.coches, "Dr Amel Haddad");
    fd.append(CHAMPS_MEDECINS.coches, "Dr Karim Bensalem");
    fd.append(CHAMPS_PRODUITS.coches, "Nivolex (nivolumab)");
    fd.append(CHAMPS_PRODUITS.coches, "Trastuzex (trastuzumab)");
    const r = await createConsultingContract(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const c = await prisma.consultingContract.findFirstOrThrow({ where: { title: { startsWith: TAG } } });
    // Ce qui le ferait tomber : rendre `businessUnitId` à l'action sans l'écrire — c'est
    // EXACTEMENT l'état d'avant ce lot, et il était invisible.
    expect(c.businessUnitId).toBe(gammeId);
    expect(c.doctor).toBe(`Dr Amel Haddad${MULTI_SEP}Dr Karim Bensalem`);
    expect(c.product).toBe(`Nivolex (nivolumab)${MULTI_SEP}Trastuzex (trastuzumab)`);
  });

  it("CONSULTING : les deux champs sont FACULTATIFS — une demande sans praticien passe", async () => {
    // « On doit POUVOIR sélectionner » n'est pas « on doit sélectionner ». Un accompagnement
    // réglementaire n'a pas de praticien, et le refuser serait un refus à tort (§118.27).
    const fd = new FormData();
    fd.set("title", `${TAG}SansPraticien`);
    fd.set("counterparty", "Cabinet Juridis");
    const r = await createConsultingContract(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const c = await prisma.consultingContract.findFirstOrThrow({ where: { title: `${TAG}SansPraticien` } });
    // `null` et non une chaîne vide : la colonne reste VIDE, pas « renseignée avec rien ».
    expect(c.doctor).toBeNull();
    expect(c.product).toBeNull();
  });

  it("AUTRE DEMANDE : praticien, produit et gamme écrits", async () => {
    const fd = new FormData();
    fd.set("title", `${TAG}DépensePromo`);
    fd.set("description", "Une dépense de promotion qui n'entre dans aucune case.");
    fd.set("businessUnitId", gammeId);
    fd.append(CHAMPS_MEDECINS.coches, "Dr Amel Haddad");
    // Le REPLI en saisie libre : aucun produit coché, mais un nom tapé — il passe tel quel,
    // sinon une demande légitime attendrait qu'on peuple le référentiel.
    fd.set(CHAMPS_PRODUITS.libre, "Produit hors référentiel");
    const r = await createAdProOtherRequest(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const a = await prisma.adProOtherRequest.findFirstOrThrow({ where: { title: { startsWith: TAG } } });
    expect(a.businessUnitId).toBe(gammeId);
    expect(a.doctor).toBe("Dr Amel Haddad");
    expect(a.product).toBe("Produit hors référentiel");
  });

  /*
   * LES PRISES EN CHARGE, DÉCISION DE LA DIRECTION DU 04/10/2026 : ni spécialité ni produits promus
   * (ni pays au national), l'événement daté par son DÉBUT et sa FIN, et les médecins deviennent les
   * PROFESSIONNELS PROPOSÉS — une ligne `CareBeneficiary` chacun, la même liste que la fiche.
   */
  const docDuBanc = async () => (await prisma.medicalDoctor.findFirstOrThrow({ where: { name: `${TAG}Dr Test` } })).id;

  it("PRISE EN CHARGE INTERNATIONALE : la gamme est écrite, les médecins deviennent des PROPOSITIONS, ni produit ni spécialité", async () => {
    const fd = new FormData();
    fd.set("type", "INTL");
    fd.set("name", `${TAG}ECCMID`);
    fd.set("businessUnitId", gammeId);
    fd.set("startDate", "2026-11-02");
    fd.set("endDate", "2026-11-05");
    // FORGÉS : le formulaire ne les porte plus — l'action ne doit pas les écrire (§118.152c).
    fd.set("specialty", "Infectiologie");
    fd.append(CHAMPS_PRODUITS.coches, "Nivolex (nivolumab)");
    fd.append("invitedDoctorIds", await docDuBanc());
    const r = await createCongressRequest(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const c = await prisma.congressInternational.findFirstOrThrow({
      where: { name: `${TAG}ECCMID` }, include: { careBeneficiaries: true },
    });
    expect(c.products).toBeNull();
    expect(c.specialty).toBeNull();
    expect(c.businessUnitId).toBe(gammeId);
    expect(c.endDate?.toISOString().slice(0, 10)).toBe("2026-11-05");
    // LA SOURCE UNIQUE : la ligne de la fiche, en PROPOSITION ; la colonne d'avant n'est plus écrite.
    expect(c.careBeneficiaries.map((b) => [b.doctorId, b.status])).toEqual([[await docDuBanc(), "PROPOSED"]]);
    expect(c.invitedDoctorIds).toEqual([]);
  });

  it("CE QUI MANQUE SE NOMME EN UNE FOIS, une fin avant le début est refusée, un professionnel inconnu aussi", async () => {
    const base = () => { const fd = new FormData(); fd.set("type", "NATIONAL"); fd.set("businessUnitId", gammeId); return fd; };
    const vide = await createCongressRequest(undefined, base());
    expect(vide.ok === false && vide.error).toBe("À renseigner : le nom de l'événement, la date de début, la date de fin.");
    const sansFin = base(); sansFin.set("name", `${TAG}SansFin`); sansFin.set("date", "2026-11-02");
    const r1 = await createCongressRequest(undefined, sansFin);
    expect(r1.ok === false && r1.error).toBe("À renseigner : la date de fin.");
    const aLEnvers = base(); aLEnvers.set("name", `${TAG}Envers`); aLEnvers.set("date", "2026-11-05"); aLEnvers.set("endDate", "2026-11-02");
    const r2 = await createCongressRequest(undefined, aLEnvers);
    expect(r2.ok === false && r2.error).toBe("La date de fin ne peut pas précéder la date de début.");
    const inconnu = base(); inconnu.set("name", `${TAG}Inconnu`); inconnu.set("date", "2026-11-02"); inconnu.set("endDate", "2026-11-03");
    inconnu.append("invitedDoctorIds", "doc-inexistant");
    const r3 = await createCongressRequest(undefined, inconnu);
    expect(r3.ok).toBe(false);
    // Aucun des quatre refus n'a créé de demande.
    expect(await prisma.congressNational.count({ where: { name: { in: [`${TAG}SansFin`, `${TAG}Envers`, `${TAG}Inconnu`] } } })).toBe(0);
  });

  it("LE CHARGEUR sert les référentiels aux SIX natures, et à aucune autre", async () => {
    /*
     * LE DÉFAUT QUE J'AI MOI-MÊME LAISSÉ AU LOT PRÉCÉDENT, mesuré ici par le VRAI chargeur.
     *
     * `getAdProCreateData(id, ["EVENT"])` rendait **0 médecin, 0 produit, 0 spécialité** : les
     * trois menus que la Direction venait d'exiger retombaient en saisie libre sur l'écran
     * Events et sur la fiche d'un événement, en silence, alors qu'ils marchaient depuis le
     * panneau d'Ad & Pro — qui, lui, passe aussi SPONSORING. Une porte gardée à côté d'une porte
     * ouverte (§118.71, §118.108).
     *
     * Ce qui le ferait tomber : revenir à une liste de natures écrite à la main dans le
     * chargeur. La sixième y serait oubliée, comme l'événement l'a été.
     */
    for (const k of AD_PRO_KINDS) {
      const d = await getAdProCreateData(demandeurId, [k.kind]);
      // Les PRISES EN CHARGE ont des médecins (les professionnels proposés) et plus de produit.
      expect(d.doctors.some((x) => x.name.startsWith(TAG)), `${k.kind} : médecins`).toBe(natureDesigneMedecins(k.kind));
      expect(d.products.some((x) => (x.brandName ?? "").startsWith(TAG)), `${k.kind} : produits`).toBe(natureDesigneMedecinsEtProduits(k.kind));
    }
    // LA PRÉMISSE : sans elle, « 0 partout » rendrait chaque comparaison vraie pour la mauvaise
    // raison, et le matériel promotionnel passerait pour correctement exclu.
    const promo = AD_PRO_KINDS.filter((k) => !natureDesigneMedecins(k.kind));
    expect(promo.map((k) => k.kind)).toEqual(["PROMO_MATERIAL"]);
  });

  it("PRISE EN CHARGE NATIONALE : ni pays, ni spécialité, ni produits — et la fiche rend le début ET la fin", async () => {
    const fd = new FormData();
    fd.set("type", "NATIONAL");
    fd.set("name", `${TAG}JNCardio`);
    fd.set("businessUnitId", gammeId);
    fd.set("date", "2026-12-01");
    fd.set("endDate", "2026-12-03");
    fd.set("country", "Tunisie");
    fd.set("specialty", "Cardiologie");
    fd.append(CHAMPS_PRODUITS.coches, "Trastuzex (trastuzumab)");
    const r = await createCongressRequest(undefined, fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const c = await prisma.congressNational.findFirstOrThrow({ where: { name: `${TAG}JNCardio` } });
    expect([c.country, c.specialty, c.promotedProducts]).toEqual([null, null, null]);
    expect(c.businessUnitId).toBe(gammeId);
    const acteur = { id: demandeurId, role: "PRODUCT_MANAGER", access: (ACTOR as NonNullable<typeof ACTOR>).access } as never;
    const vue = await getCongressDetail("NATIONAL", acteur, c.id);
    expect([vue?.date?.slice(0, 10), vue?.endDate?.slice(0, 10)]).toEqual(["2026-12-01", "2026-12-03"]);
  });
});
