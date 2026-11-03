/**
 * LA BOÎTE DE DÉCISION, SUR UNE VRAIE BASE — chaque genre de carte naît d'une ligne réelle,
 * chaque option porte un geste valide vers cette ligne, et la composition tient dans le budget
 * du mandat (P95 < 1,5 s) — mesuré, pas supposé.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { composerInbox } from "@/platform/in-process/inbox/compose";
import { estGesteValide } from "@/lib/assistant/inbox/model";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__inbox__${Date.now()}`;
const JOUR = 86_400_000;
let pdg: CurrentUser;
let demandeur: { id: string };
let stepId = "";
let notifId = "";
let engagementId = "";
let decisionId = "";
let approvalId = "";
let missionAttenteId = "";
let constatHumainId = "";
let constatProposeId = "";

async function utilisateur(suffixe: string, role: "DIRECTION" | "SALES_USER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${suffixe}`, email: `${TAG}${suffixe}@t.dz`, passwordHash: "x", role } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access: await getAccess(u.id, u.role), mustChangePassword: false };
}

suite("la boîte de décision — composée depuis les files réelles", () => {
  beforeAll(async () => {
    pdg = await utilisateur("pdg", "DIRECTION");
    demandeur = await utilisateur("demandeur", "SALES_USER");
    const req = await prisma.validationRequest.create({
      data: {
        reference: `${TAG}-VAL-1`, module: "Finances", objectType: "EXPENSE", title: `${TAG} Avance sur frais — mission Oran`,
        description: "Déplacement de deux jours, hôtel et carburant.", amount: 120_000, priority: "HIGH", requesterId: demandeur.id,
        mode: "PARALLEL", status: "PENDING", deadline: new Date(Date.now() - JOUR),
        steps: { create: [{ order: 1, validatorId: pdg.id, status: "PENDING" }] },
      },
      include: { steps: true },
    });
    stepId = req.steps[0].id;
    notifId = (await prisma.notification.create({ data: { userId: pdg.id, title: `${TAG} Rapport chaîne du froid déposé`, body: "Le rapport de Rouiba est dans le Drive.", link: "/drive", popup: true } })).id;
    engagementId = (await prisma.executiveCommitment.create({ data: { ownerId: pdg.id, who: `${TAG} Khaled`, toWhom: "le PDG", what: "régler la facture Hikma", dueAt: new Date(Date.now() - 3 * JOUR), status: "OPEN" } })).id;
    decisionId = (await prisma.executiveDecision.create({ data: { ownerId: pdg.id, title: `${TAG} Externaliser l'étiquetage`, decision: "Oui, six mois d'essai", expectedOutcome: "Délai divisé par deux", status: "DECIDED", reviewDate: new Date(Date.now() - JOUR) } })).id;
    const mission = await prisma.mission.create({ data: { ownerId: pdg.id, title: `${TAG} Relancer les 6 responsables`, objective: "Obtenir la confirmation des congés de décembre de chaque responsable.", status: "AWAITING_APPROVAL" } });
    approvalId = (await prisma.missionApproval.create({ data: { missionId: mission.id, scope: "notify:6", summary: "6 notifications internes, une par responsable de département.", scopeHash: `${TAG}-h`, stepKeys: ["n1", "n2", "n3", "n4", "n5", "n6"], level: "NORMAL", status: "PENDING" } })).id;
    const attente = await prisma.mission.create({ data: { ownerId: pdg.id, title: `${TAG} Préparer l'offre PCH`, objective: "Déposer une offre complète avant l'ouverture des plis.", status: "WAITING_INPUT" } });
    missionAttenteId = attente.id;
    await prisma.missionStep.create({ data: { missionId: attente.id, key: "q1", title: "Quel prix plancher pour le lot 3 ?", status: "WAITING", input: { question: "Quel prix plancher retenir pour le lot 3 (Trastuzumab) ?" } } });
    // LA QUALITÉ DES DONNÉES (§23) : un constat critique à décision humaine (Finances) et un constat haut avec
    // correction proposée (Legal) — deux genres de cartes, et rien pour qui ne voit pas ces modules.
    constatHumainId = (await prisma.dataQualityFinding.create({ data: {
      regle: "doublon_factures", famille: "DOUBLON", criticite: "CRITIQUE", confiance: 0.95, resolution: "HUMAIN", entite: "LegalDocument", entiteId: `${TAG}-f2`,
      module: "FINANCES", titre: `${TAG} Facture FAC-77 enregistrée 2 fois`, detail: "Deux factures portent la référence FAC-77 (Hetero Labs). Risque : payer deux fois.",
      signature: `${TAG}|doublon_factures|f2`, href: "/legal/x", montant: 125000, status: "OPEN",
    } })).id;
    constatProposeId = (await prisma.dataQualityFinding.create({ data: {
      // CRITIQUE et confiance maximale : la file « qualité » de la boîte ne garde que les cinq constats les plus
      // graves, les plus sûrs, les plus récents — sur une base de test que d'autres suites peuplent de constats
      // HAUTE, un constat HAUTE à 0,9 sortait du cinq de tête et la carte manquait. Mesuré.
      regle: "contrat_actif_echu", famille: "STATUT_IMPOSSIBLE", criticite: "CRITIQUE", confiance: 0.99, resolution: "PROPOSE", entite: "LegalDocument", entiteId: `${TAG}-c1`,
      module: "LEGAL", titre: `${TAG} Contrat Kwality : ACTIF mais échu depuis 30 j`, detail: "Terme passé, statut encore ACTIF.",
      signature: `${TAG}|contrat_actif_echu|c1`, href: "/legal/y", status: "OPEN",
      correction: { entite: "LegalDocument", entiteId: `${TAG}-c1`, champ: "status", avant: "ACTIVE", apres: "EXPIRED", description: "Passer le contrat Kwality en EXPIRÉ." },
    } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.missionStep.deleteMany({ where: { mission: { title: { startsWith: TAG } } } }).catch(() => {});
    await prisma.missionApproval.deleteMany({ where: { mission: { title: { startsWith: TAG } } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.executiveDecision.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.executiveCommitment.deleteMany({ where: { who: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.dataQualityFinding.deleteMany({ where: { titre: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("chaque file donne sa carte, avec le bon genre, la bonne urgence et des gestes VALIDES vers des lignes réelles", async () => {
    const vue = await composerInbox(pdg);
    const par = (prefixe: string) => vue.cartes.find((c) => c.id === prefixe);
    const val = par(`val:${stepId}`);
    expect(val, JSON.stringify(vue.cartes.map((c) => c.id))).toBeDefined();
    expect(val!.genre).toBe("APPROVE");
    expect(val!.urgence).toBe("CRITIQUE"); // échéance dépassée
    expect(val!.impact).toMatch(/120/);
    expect(val!.options.map((o) => o.id)).toEqual(["approuver", "modifier", "refuser"]);
    expect(val!.options.find((o) => o.id === "refuser")?.saisie?.obligatoire).toBe(true);

    const notif = par(`notif:${notifId}`);
    expect(notif?.genre).toBe("FYI");
    expect(notif?.urgence).toBe("HAUTE"); // marquée importante (popup)
    expect(notif?.options.map((o) => o.id)).toEqual(["vu", "ouvrir"]);

    const eng = par(`eng:${engagementId}`);
    expect(eng?.genre).toBe("REVIEW");
    expect(eng?.urgence).toBe("CRITIQUE");
    expect(eng?.recommandation?.optionId).toBe("relancer");

    const dec = par(`dec:${decisionId}`);
    expect(dec?.genre).toBe("REVIEW");

    const accord = par(`accord:${approvalId}`);
    expect(accord?.genre).toBe("APPROVE");
    expect(accord?.recommandation?.optionId).toBe("accorder");
    expect(accord?.impact).toBe("6 étapes");

    const attente = par(`attente:${missionAttenteId}`);
    expect(attente?.genre).toBe("CHOOSE");
    expect(attente?.contexte).toMatch(/prix plancher/);
    expect(attente?.options[0]).toMatchObject({ id: "repondre", geste: { kind: "mission.element", missionId: missionAttenteId, stepKey: "q1" } });

    // Les constats de qualité (§23) : REVIEW pour une décision, CHOOSE quand une correction est proposée et recommandée.
    const humain = par(`qualite:${constatHumainId}`);
    expect(humain?.genre).toBe("REVIEW");
    expect(humain?.urgence).toBe("CRITIQUE");
    expect(humain?.impact).toMatch(/125/);
    expect(humain?.options.map((o) => o.id)).toEqual(["ouvrir", "ignorer"]);
    expect(humain?.options.find((o) => o.id === "ignorer")?.saisie?.obligatoire).toBe(true);
    const propose = par(`qualite:${constatProposeId}`);
    expect(propose?.genre).toBe("CHOOSE");
    expect(propose?.urgence).toBe("CRITIQUE");
    expect(propose?.recommandation?.optionId).toBe("corriger");
    expect(propose?.options[0]).toMatchObject({ id: "corriger", geste: { kind: "qualite.corriger", constatId: constatProposeId } });

    for (const c of vue.cartes) for (const o of c.options) expect(estGesteValide(o.geste), `${c.id}/${o.id}`).toBe(true);
    // L'ordre : la validation critique qui bloque quelqu'un passe devant l'engagement critique.
    const ids = vue.cartes.map((c) => c.id);
    expect(ids.indexOf(`val:${stepId}`)).toBeLessThan(ids.indexOf(`eng:${engagementId}`));
    expect(ids.indexOf(`eng:${engagementId}`)).toBeLessThan(ids.indexOf(`notif:${notifId}`));
    expect(vue.compte.APPROVE).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("un compte sans droits de validation ni file ne voit que ce qui lui appartient — jamais la carte d'un autre", async () => {
    const autre = await utilisateur("autre", "SALES_USER");
    const vue = await composerInbox(autre);
    expect(vue.cartes.some((c) => c.id === `val:${stepId}` || c.id === `notif:${notifId}` || c.id === `accord:${approvalId}`)).toBe(false);
    // Ni les constats de qualité des modules qu'il ne voit pas.
    expect(vue.cartes.some((c) => c.id.startsWith("qualite:") && (c.id.endsWith(constatHumainId) || c.id.endsWith(constatProposeId)))).toBe(false);
  }, 60_000);

  it("se compose en moins de 1,5 s au P95 (20 mesures sur la base locale)", async () => {
    const durees: number[] = [];
    for (let i = 0; i < 20; i++) durees.push((await composerInbox(pdg)).ms);
    const tri = [...durees].sort((a, b) => a - b);
    const p50 = tri[Math.floor(tri.length * 0.5)];
    const p95 = tri[Math.min(tri.length - 1, Math.ceil(tri.length * 0.95) - 1)];
    console.log(`[inbox] composition P50 ${p50} ms · P95 ${p95} ms · max ${tri[tri.length - 1]} ms`);
    expect(p95).toBeLessThan(1_500);
  }, 120_000);
});
