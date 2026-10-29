import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { executePowerTool, powerToolsFor } from "@/lib/assistant/power-tools";
import { assistantToolsFor } from "@/lib/assistant";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import { refusPourActeur } from "@/lib/missions/policy/guard";
import { domainesDe, shortlistNames } from "@/lib/assistant/context/tool-shortlist";
import { catalogueDe } from "@/platform/in-process/missions/catalog";
import { enseigner } from "@/platform/ia/teach/store";
import {
  __configurerPourTests, connecteursMessagerie, creerMicroSkill, listerSkills, prechargerCapacitesDynamiques, preparerAppelMission, promouvoirSkill, supprimerSkill,
} from "./index";

/**
 * LE RUNTIME DES SKILLS (§36), depuis les VRAIS points d'entrée : `powerToolsFor` / `assistantToolsFor`
 * (ce que la conversation envoie au modèle), `executePowerTool` (ce qui s'exécute), `catalogueDe` (ce
 * que le planificateur voit), `shortlistNames` (la liste courte), `refusPourActeur` (l'interdit de
 * l'agent). Un connecteur est découvert sans une ligne dans le cœur ; un micro-outil n'existe qu'après
 * la porte de qualité ; promouvoir est un geste de personne ; un skill qui écrit rend un aperçu.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__skl${Date.now().toString(36)}`;
let pdg: CurrentUser;
let lecteur: CurrentUser;
const appels: { url: string; methode: string; corps: unknown; auth: string | null; contentType?: string | null }[] = [];

const fauxFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const brut = init?.body ? String(init.body) : null;
  let corps: unknown = null;
  if (brut) { try { corps = JSON.parse(brut); } catch { corps = brut; } }
  appels.push({ url, methode: init?.method ?? "GET", corps, auth: headers.get("authorization"), contentType: headers.get("content-type") });
  if (url.includes("PO-404")) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  if (url.includes("/A_PurchaseOrder(")) return new Response(JSON.stringify({ d: { PurchaseOrder: "4500001234", Supplier: "KWALITY", DocumentCurrency: "DZD" } }), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/A_PurchaseOrder")) return new Response(JSON.stringify({ d: { PurchaseOrder: "4500009999" } }), { status: 201, headers: { "content-type": "application/json" } });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

async function utilisateur(role: "SUPER_ADMIN" | "VIEWER", suffixe: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${suffixe}`, email: `${TAG}${suffixe}@amd.dz`, passwordHash: "x", role }, select: { id: true, name: true, email: true, role: true } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
}

suite("le runtime des skills — découverte, droit, exécution, cycle des micro-outils", () => {
  beforeAll(async () => {
    pdg = await utilisateur("SUPER_ADMIN", "pdg");
    lecteur = await utilisateur("VIEWER", "lecteur");
    __configurerPourTests({ config: { SAP_BASE_URL: "https://sap.demo.test", SAP_TOKEN: "jeton-de-test" }, fetchImpl: fauxFetch });
  }, 60_000);

  afterAll(async () => {
    __configurerPourTests({ config: null, fetchImpl: null });
    await prisma.adamSkill.deleteMany({ where: { ownerId: { in: [pdg.id, lecteur.id] } } }).catch(() => {});
    await prisma.adamRule.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [pdg.id, lecteur.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("les connecteurs déclarés sont DÉCOUVERTS par la conversation, le planificateur et la liste courte — sous le droit de leur manifeste", async () => {
    await prechargerCapacitesDynamiques(pdg);
    const noms = powerToolsFor(pdg).map((t) => t.name);
    expect(noms).toEqual(expect.arrayContaining(["sap_lire_commande_achat", "sap_creer_commande_achat", "docusign_envoyer_pour_signature", "iqvia_ventes_molecule", "pch_appels_d_offres"]));
    expect(assistantToolsFor(pdg).map((t) => t.name)).toContain("sap_lire_commande_achat");
    // Le planificateur voit la capacité avec la MÉTA du manifeste — pas une dérivation par préfixe.
    const catalogue = catalogueDe(pdg);
    expect(catalogue.has("sap_creer_commande_achat")).toBe(true);
    expect(capabilityMeta("sap_creer_commande_achat")).toMatchObject({ effect: "FINANCIAL_COMMITMENT", primitive: "ACTION", confirmation: "POLICY_ENGINE", declared: true });
    expect(capabilityMeta("sap_lire_commande_achat")).toMatchObject({ effect: "READ", primitive: "INFORMATION", idempotent: true });
    expect(catalogue.brief({ userId: pdg.id, label: pdg.name, isAgent: true }, { domains: ["finance"] }).some((b) => b.id === "sap_lire_commande_achat")).toBe(true);
    // La liste courte du domaine FINANCE l'inclut ; celle de MAIL non.
    expect(domainesDe("sap_lire_commande_achat")).toEqual(["FINANCE"]);
    expect(shortlistNames({ route: "HYBRID_RETRIEVAL", domain: "FINANCE", secondaires: [] })).toContain("sap_lire_commande_achat");
    expect(shortlistNames({ route: "HYBRID_RETRIEVAL", domain: "MAIL", secondaires: [] })).not.toContain("sap_lire_commande_achat");

    // Un compte sans le module Finances ne voit pas le connecteur SAP, et son exécution est refusée.
    await prechargerCapacitesDynamiques(lecteur);
    expect(powerToolsFor(lecteur).map((t) => t.name)).not.toContain("sap_lire_commande_achat");
    expect(await executePowerTool("sap_lire_commande_achat", { numero: "4500001234" }, lecteur)).toMatch(/ne vous est pas ouvert/);
  }, 60_000);

  it("HTTP déclaratif : gabarits encodés, authentification par configuration, résultat extrait ; un 404 est dit ; un connecteur non configuré nomme sa ressource", async () => {
    appels.length = 0;
    const ok = JSON.parse((await executePowerTool("sap_lire_commande_achat", { numero: "4500001234" }, pdg))!);
    expect(ok.ok).toBe(true);
    expect(ok.resultat).toMatchObject({ PurchaseOrder: "4500001234", Supplier: "KWALITY" });
    expect(ok.source).toMatch(/connecteur sap/);
    expect(ok._provenance).toBeTruthy();
    expect(appels[0]).toMatchObject({ methode: "GET", auth: "Bearer jeton-de-test" });
    expect(appels[0]?.url).toBe("https://sap.demo.test/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder('4500001234')");
    // Une entrée ne réécrit jamais l'URL : elle est encodée.
    await executePowerTool("sap_lire_commande_achat", { numero: "../../admin?x=1" }, pdg);
    expect(appels[1]?.url).toContain("A_PurchaseOrder('..%2F..%2Fadmin%3Fx%3D1')");
    const ko = JSON.parse((await executePowerTool("sap_lire_commande_achat", { numero: "PO-404" }, pdg))!);
    expect(ko.ok).toBe(false);
    expect(ko.statut).toBe(404);
    // DocuSign n'est pas configuré ici : la limite est une RESSOURCE nommée, pas « pas prévu ».
    const nonConfigure = JSON.parse((await executePowerTool("docusign_statut_enveloppe", { envelopeId: "abc" }, pdg))!);
    expect(nonConfigure).toMatchObject({ ok: false, limite: "RESSOURCE" });
    expect(nonConfigure.erreur).toMatch(/DOCUSIGN_BASE_URL.*non configurée/);
  }, 60_000);

  it("un skill qui ENGAGE rend un aperçu (sans en-tête ni secret) et n'exécute qu'avec confirmer: true ; le runner de mission pose l'accord lui-même", async () => {
    appels.length = 0;
    const entree = { fournisseur: "KWALITY", organisationAchat: "1000", societe: "ADV", devise: "DZD", lignes: [{ article: "CARTON", quantite: 10, prixUnitaire: 120 }] };
    const apercu = JSON.parse((await executePowerTool("sap_creer_commande_achat", entree, pdg))!);
    expect(apercu.confirmationRequise).toBe(true);
    expect(apercu.apercu.requete).toMatchObject({ methode: "POST", chemin: "/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder" });
    expect(JSON.stringify(apercu)).not.toMatch(/jeton-de-test|Authorization/);
    expect(appels).toHaveLength(0); // rien n'est parti
    const fait = JSON.parse((await executePowerTool("sap_creer_commande_achat", { ...entree, confirmer: true }, pdg))!);
    expect(fait.ok).toBe(true);
    expect(appels).toHaveLength(1);
    expect(appels[0]?.corps).toMatchObject({ Supplier: "KWALITY", to_PurchaseOrderItem: [{ article: "CARTON", quantite: 10, prixUnitaire: 120 }] });
    const audit = await prisma.auditLog.count({ where: { actorId: pdg.id, action: "EXPORT", summary: { contains: "Skill « Créer une commande d'achat SAP »" } } });
    expect(audit).toBeGreaterThanOrEqual(1);
    // Dans une mission, l'accord vient de la porte d'approbation : le runner ajoute `confirmer`, le modèle ne le peut pas.
    expect(preparerAppelMission(pdg.id, "sap_creer_commande_achat", entree)).toMatchObject({ confirmer: true });
    expect(preparerAppelMission(pdg.id, "sap_lire_commande_achat", { numero: "1" })).toEqual({ numero: "1" });
  }, 60_000);

  it("le débit déclaré est compté : la quatrième création SAP dans la minute est refusée", async () => {
    const entree = { fournisseur: "K", organisationAchat: "1000", societe: "ADV", lignes: [], confirmer: true };
    const resultats: { ok: boolean; limite?: string }[] = [];
    for (let i = 0; i < 4; i++) resultats.push(JSON.parse((await executePowerTool("sap_creer_commande_achat", entree, pdg))!));
    expect(resultats.filter((r) => r.limite === "DEBIT").length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("micro-outil : refusé sans exemple, refusé si la porte échoue, créé TEMPORAIRE quand tout tient, exécutable aussitôt, compté", async () => {
    const sansExemple = await creerMicroSkill(pdg, { nom: "tva 19", description: "Applique la TVA à 19 %.", code: "return { ttc: data.montant * 1.19 };" });
    expect(sansExemple.ok).toBe(false);
    if (!sansExemple.ok) expect(sansExemple.motif).toMatch(/exemple/);
    const faux = await creerMicroSkill(pdg, { nom: "tva 19", description: "Applique la TVA à 19 %.", code: "return { ttc: data.montant * 1.09 };", exemple: { montant: 100_000 }, attentes: [{ chemin: "ttc", op: "egal", valeur: 119_000, libelle: "TTC de 100 000" }] });
    expect(faux.ok).toBe(false);
    if (!faux.ok) { expect(faux.motif).toMatch(/porte de qualité \(tests\)/); expect(await prisma.adamSkill.count({ where: { ownerId: pdg.id } })).toBe(0); }
    const bon = await creerMicroSkill(pdg, {
      nom: "tva 19", description: "Applique la TVA à 19 % à un montant HT.", code: "return { ht: data.montant, tva: lib.round(data.montant * 0.19, 2), ttc: lib.round(data.montant * 1.19, 2) };",
      entrees: { type: "object", properties: { montant: { type: "number" } }, required: ["montant"] },
      exemple: { montant: 100_000 }, attentes: [{ chemin: "ttc", op: "egal", valeur: 119_000 }], schema: { forme: "objet", cles: ["ht", "tva", "ttc"] },
    });
    expect(bon.ok).toBe(true);
    if (!bon.ok) return;
    expect(bon).toMatchObject({ outil: "skill_tva_19", statut: "TEMP", version: 1 });
    expect(bon.expireLe).toBeTruthy();
    // L'outil est là au tour suivant, dans la liste envoyée au modèle et à l'exécution.
    await prechargerCapacitesDynamiques(pdg);
    expect(powerToolsFor(pdg).map((t) => t.name)).toContain("skill_tva_19");
    const r = JSON.parse((await executePowerTool("skill_tva_19", { montant: 125_000 }, pdg))!);
    expect(r.ok).toBe(true);
    expect(r.resultat).toEqual({ ht: 125_000, tva: 23_750, ttc: 148_750 });
    // La forme promise vaut à chaque appel ; les attentes de l'exemple, elles, ne sont pas rejouées.
    await new Promise((res) => setTimeout(res, 50));
    const row = await prisma.adamSkill.findUnique({ where: { ownerId_slug: { ownerId: pdg.id, slug: "tva_19" } } });
    expect(row?.usageCount).toBeGreaterThanOrEqual(1);
    // Un autre compte ne le voit pas : il est TEMPORAIRE et à son créateur.
    await prechargerCapacitesDynamiques(lecteur);
    expect(powerToolsFor(lecteur).map((t) => t.name)).not.toContain("skill_tva_19");
    expect(await executePowerTool("skill_tva_19", { montant: 1 }, lecteur)).toBeNull();
    expect(capabilityMeta("skill_tva_19")).toMatchObject({ effect: "ANALYZE", primitive: "CALCUL" });
  }, 90_000);

  it("promouvoir est un geste de PERSONNE : périmètre gardé, agent exclu à la compilation ; jeter retire l'outil", async () => {
    expect(refusPourActeur("promote_skill", "INTERNAL_REVERSIBLE_WRITE", { userId: pdg.id, label: "agent", isAgent: true })).not.toBeNull();
    expect(refusPourActeur("drop_skill", "INTERNAL_REVERSIBLE_WRITE", { userId: pdg.id, label: "agent", isAgent: true })).not.toBeNull();
    expect(refusPourActeur("create_skill", "INTERNAL_REVERSIBLE_WRITE", { userId: pdg.id, label: "agent", isAgent: true })).toBeNull();
    expect(refusPourActeur("promote_skill", "INTERNAL_REVERSIBLE_WRITE", { userId: pdg.id, label: pdg.name, isAgent: false })).toBeNull();
    const parLecteur = await promouvoirSkill(lecteur, { nom: "tva 19", scope: "PERSON" });
    expect(parLecteur.ok).toBe(false); // pas le sien
    const perso = await promouvoirSkill(pdg, { nom: "skill_tva_19", scope: "PERSON" });
    expect(perso).toMatchObject({ ok: true, scope: "PERSON" });
    const row = await prisma.adamSkill.findUnique({ where: { ownerId_slug: { ownerId: pdg.id, slug: "tva_19" } } });
    expect(row).toMatchObject({ status: "PROMOTED", expiresAt: null, promotedById: pdg.id });
    const liste = await listerSkills(pdg);
    expect(liste.find((s) => s.outil === "skill_tva_19")).toMatchObject({ source: "adam", statut: "PROMOTED", confirmation: false });
    expect(liste.filter((s) => s.source === "plugin").length).toBeGreaterThanOrEqual(5);
    const jete = await supprimerSkill(pdg, { nom: "tva 19" });
    expect(jete.ok).toBe(true);
    await prechargerCapacitesDynamiques(pdg);
    expect(powerToolsFor(pdg).map((t) => t.name)).not.toContain("skill_tva_19");
  }, 60_000);

  it("un playbook enseigné (règle WORKFLOW à part structurée) devient un outil qui compose des lectures — une écriture y est refusée", async () => {
    const r = await enseigner(pdg, {
      statement: `${TAG} Le point annuaire : lister le service puis compter.`, title: `${TAG} point annuaire`, kind: "WORKFLOW", scope: "PERSON",
      params: { playbook: { id: "point_annuaire", description: "Liste l'annuaire du service demandé.", entrees: { type: "object", properties: { service: { type: "string" } } }, etapes: [{ alias: "annuaire", outil: "directory_list", args: { department: "{{entree.service}}", limit: 5 } }], sortie: { service: "{{entree.service}}", annuaire: "{{etapes.annuaire}}" } } },
    });
    if (!r.ok) throw new Error(r.motif);
    await prechargerCapacitesDynamiques(pdg);
    expect(powerToolsFor(pdg).map((t) => t.name)).toContain("playbook_point_annuaire");
    const out = JSON.parse((await executePowerTool("playbook_point_annuaire", { service: "Direction" }, pdg))!);
    expect(out.ok).toBe(true);
    expect(out.resultat.service).toBe("Direction");
    expect(out.etapes).toHaveLength(1);
    expect(out.etapes[0]).toMatchObject({ alias: "annuaire", outil: "directory_list" });
    expect(capabilityMeta("playbook_point_annuaire")).toMatchObject({ effect: "READ", primitive: "ORCHESTRATION" });
    const ecriture = await enseigner(pdg, {
      statement: `${TAG} Créer une tâche à chaque fois.`, title: `${TAG} playbook qui écrit`, kind: "WORKFLOW", scope: "PERSON",
      params: { playbook: { id: "ecrit", etapes: [{ alias: "t", outil: "create_task", args: { title: "x" } }] } },
    });
    if (!ecriture.ok) throw new Error(ecriture.motif);
    await prechargerCapacitesDynamiques(pdg);
    const refus = await executePowerTool("playbook_ecrit", {}, pdg);
    expect(refus === null || /n'est pas une lecture|une écriture passe par la proposition/.test(refus)).toBe(true);
  }, 90_000);
  it("la création NOMME le geste suivant : appeler l'outil, pas refaire son calcul de tête", async () => {
    /**
     * MESURÉ sur la campagne live (`defi-skill-micro-outil`) : Adam crée l'outil, la porte le
     * valide, il est exposé DANS LE TOUR — et Adam applique ensuite la règle de tête. La réponse
     * était juste ; la consigne du tour dit « JAMAIS de tête, même pour une multiplication », et
     * un outil qu'on vient de bâtir sans l'appeler est une capacité sans appelant (§118.14).
     *
     * CE QUI LE FERAIT TOMBER : retirer la phrase. Le retour redirait le nom, l'échéance et le
     * rapport de porte — et rien de ce qu'il faut FAIRE (§118.19).
     */
    const r = await creerMicroSkill(pdg, {
      nom: "tva geste",
      description: "TVA 19 % et TTC d'un montant HT.",
      code: "return { tva: data.ht * 0.19, ttc: data.ht * 1.19 };",
      exemple: { ht: 100000 },
      attentes: [{ chemin: "ttc", op: "egal", valeur: 119000 }],
    });
    expect(r.ok, `la porte doit exposer l'outil : ${JSON.stringify(r).slice(0, 200)}`).toBe(true);
    if (!r.ok) return;
    expect(r.prochain, "le nom exact de l'outil à appeler").toContain(r.outil);
    expect(r.prochain, "et l'interdiction de refaire le calcul soi-même").toMatch(/de t[êe]te/i);
  }, 30_000);
});

suite("les connecteurs de messagerie (§37) — un même geste sous quatre noms, configurés ou dits non configurés", () => {
  let dir: CurrentUser;
  beforeAll(async () => {
    dir = await utilisateur("SUPER_ADMIN", "dir");
    __configurerPourTests({ config: { SLACK_BASE_URL: "https://slack.demo.test/api", SLACK_BOT_TOKEN: "xoxb-test", SMS_BASE_URL: "https://sms.demo.test", SMS_ACCOUNT_SID: "AC123", SMS_AUTH_TOKEN: "tok", SMS_FROM: "+21300000000" }, fetchImpl: fauxFetch });
  }, 60_000);
  afterAll(async () => {
    __configurerPourTests({ config: null, fetchImpl: null });
    await prisma.auditLog.deleteMany({ where: { actorId: dir.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: dir.id } }).catch(() => {});
  }, 60_000);

  it("seuls Slack et SMS sont branchés : les deux autres existent, non configurés — une limite de ressource, pas un « pas prévu »", async () => {
    await prechargerCapacitesDynamiques(dir);
    expect((await connecteursMessagerie(dir)).sort()).toEqual(["slack", "sms"]);
    const outils = powerToolsFor(dir).map((t) => t.name);
    for (const n of ["slack_envoyer_message", "teams_envoyer_message", "whatsapp_envoyer_message", "sms_envoyer_message"]) expect(outils).toContain(n);
    const teams = JSON.parse((await executePowerTool("teams_envoyer_message", { texte: "bonjour", confirmer: true }, dir)) ?? "{}") as { ok: boolean; limite?: string; erreur?: string };
    expect(teams.ok).toBe(false);
    expect(teams.limite).toBe("RESSOURCE");
    expect(teams.erreur).toMatch(/TEAMS_WEBHOOK_URL/);
  }, 60_000);

  it("Slack : aperçu sans `confirmer`, envoi JSON bearer avec ; SMS : authentification basique et corps de formulaire", async () => {
    appels.length = 0;
    const apercu = JSON.parse((await executePowerTool("slack_envoyer_message", { destinataire: "#direction", texte: "Le contrat est signé." }, dir)) ?? "{}") as { confirmationRequise?: boolean };
    expect(apercu.confirmationRequise).toBe(true);
    expect(appels).toHaveLength(0);
    const envoi = JSON.parse((await executePowerTool("slack_envoyer_message", { destinataire: "#direction", texte: "Le contrat est signé.", confirmer: true }, dir)) ?? "{}") as { ok: boolean };
    expect(envoi.ok).toBe(true);
    expect(appels).toHaveLength(1);
    expect(appels[0]).toMatchObject({ url: "https://slack.demo.test/api/chat.postMessage", methode: "POST", auth: "Bearer xoxb-test", corps: { channel: "#direction", text: "Le contrat est signé." } });
    expect(appels[0]!.contentType).toBe("application/json");

    appels.length = 0;
    const sms = JSON.parse((await executePowerTool("sms_envoyer_message", { destinataire: "+213661000000", texte: "Adam : une décision vous attend.", confirmer: true }, dir)) ?? "{}") as { ok: boolean };
    expect(sms.ok).toBe(true);
    expect(appels[0]!.url).toBe("https://sms.demo.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(appels[0]!.auth).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
    expect(appels[0]!.contentType).toBe("application/x-www-form-urlencoded");
    const forme = new URLSearchParams(String(appels[0]!.corps));
    expect(forme.get("To")).toBe("+213661000000");
    expect(forme.get("From")).toBe("+21300000000");
    expect(forme.get("Body")).toBe("Adam : une décision vous attend.");
  }, 60_000);
});
