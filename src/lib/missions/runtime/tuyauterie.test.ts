import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { avancer } from "./engine";
import { chargerEtat, materialiser } from "./store";
import { compile } from "@/lib/missions/compiler/compile";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TUYAUTERIE ENTRE ÉTAPES, PAR L'ENTRÉE RÉELLE DU MOTEUR.
 *
 * Le planificateur écrit `{{recherche:contrat.resultats.0.id}}` ; ce banc vérifie ce que la
 * capacité REÇOIT, ce que le reçu CONSERVE, et ce que le moteur fait quand la référence ne
 * mène nulle part — par `avancer`, sur la vraie base, jamais en appelant l'interpolateur seul.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__tuyau__${Date.now()}`;
let ownerId = "";
let actor: MissionActor;

const CONNUES = ["directory_list", "employee_360", "inspect_record", "send_message", "search_drive"];
const catalogue: CapabilityCatalog = {
  has: (n) => CONNUES.includes(n),
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => [],
};

function traceur(sortie: (call: CapabilityCall) => unknown) {
  const appels: CapabilityCall[] = [];
  return {
    appels,
    runner: {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        return { ok: true, output: sortie(call) };
      },
    },
  };
}

async function creerMission(steps: PlannedStep[], titre: string) {
  const plan: MissionPlan = { objective: titre, acceptance: ["le travail décrit est fait"], complexity: "B", scale: "S", steps };
  const r = compile(plan, catalogue, actor);
  if (!r.ok) throw new Error(`plan refusé : ${r.issues.map((i) => `${i.code} ${i.message}`).join(" | ")}`);
  return materialiser(r.mission, { ownerId, title: titre, goalRaw: titre });
}

suite("la tuyauterie {{cle_etape.chemin}} — résolue par le moteur", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    ownerId = u.id;
    actor = { userId: u.id, label: "le PDG", isAgent: false };
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la capacité reçoit la VALEUR lue en amont — clé avec deux-points, indice de liste, texte composé — et le reçu la conserve", async () => {
    const t = traceur((c) => (c.stepKey === "liste:equipe"
      ? { salaries: [{ id: "e-1", nom: "Nadia Belhadj", emails: ["nadia@amd.dz"] }], total: 1 }
      : { ok: true }));
    const id = await creerMission([
      { key: "liste:equipe", title: "Lister", capability: "directory_list", input: { department: "Regulatory" } },
      {
        key: "message", title: "Écrire", capability: "send_message",
        input: { recipientName: "{{liste:equipe.salaries.0.nom}}", body: "Bonjour {{liste:equipe.salaries.0.nom}} — vous êtes {{liste:equipe.total}} dans l'équipe.", limite: "{{liste:equipe.total}}" },
      },
    ], "tuyauterie simple");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees).toBe(0);
    const envoi = t.appels.find((a) => a.capability === "send_message")!;
    expect(envoi.input).toEqual({
      recipientName: "Nadia Belhadj",
      body: "Bonjour Nadia Belhadj — vous êtes 1 dans l'équipe.",
      // Une référence seule garde son type : le nombre reste un nombre.
      limite: 1,
    });
    const etat = await chargerEtat(id);
    const etape = etat!.steps.find((s) => s.key === "message")!;
    expect(etape.status).toBe("DONE");
    // L'entrée ÉCRITE reste celle du plan (c'est elle qui a été approuvée) ; le reçu porte ce qui est parti.
    expect(etape.input.recipientName).toBe("{{liste:equipe.salaries.0.nom}}");
    expect(etape.recu?.query ?? "").toContain("Nadia Belhadj");
  });

  it("une liste amont VIDE : l'étape est ignorée (rien à traiter), la suite continue", async () => {
    const t = traceur((c) => (c.stepKey === "recherche" ? { resultats: [], couverture: 0 } : { ok: true }));
    const id = await creerMission([
      { key: "recherche", title: "Chercher le contrat", capability: "search_drive", input: { query: "contrat Hetero" } },
      { key: "lecture", title: "Lire le contrat", capability: "inspect_record", input: { reference: "{{recherche.resultats.0.id}}" } },
      { key: "synthese", title: "Synthèse", nodeType: "JOIN", dependsOn: ["lecture"] },
    ], "liste vide");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees).toBe(0);
    expect(t.appels.map((a) => a.capability)).toEqual(["search_drive"]);
    const etat = await chargerEtat(id);
    const lecture = etat!.steps.find((s) => s.key === "lecture")!;
    expect(lecture.status).toBe("SKIPPED");
    expect(lecture.error).toContain("la liste rendue par l'étape « recherche » est vide");
    expect(etat!.steps.find((s) => s.key === "synthese")!.status).toBe("DONE");
  });

  it("un chemin qui n'existe pas dans la sortie amont : l'étape ÉCHOUE en nommant les champs disponibles, sans appeler la capacité", async () => {
    const t = traceur((c) => (c.stepKey === "recherche" ? { resultats: [{ id: "n-1" }], couverture: 1 } : { ok: true }));
    const id = await creerMission([
      { key: "recherche", title: "Chercher", capability: "search_drive", input: { query: "contrat" } },
      { key: "lecture", title: "Lire", capability: "inspect_record", input: { reference: "{{recherche.documents.0.id}}" } },
    ], "chemin absent");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees).toBe(1);
    expect(t.appels.map((a) => a.capability)).toEqual(["search_drive"]);
    const etat = await chargerEtat(id);
    const lecture = etat!.steps.find((s) => s.key === "lecture")!;
    expect(lecture.status).toBe("FAILED");
    expect(lecture.errorKind).toBe("INVALID_STEP");
    expect(lecture.error).toContain("ne rend pas « documents.0.id »");
    expect(lecture.error).toContain("champs disponibles : resultats, couverture");
    // Non rejouable : rejouer à l'identique relirait le même vide. Les tentatives sont épuisées d'un coup.
    expect(lecture.attempt).toBe(lecture.maxAttempts);
  });

  it("l'amont a répondu par une PHRASE : sa réponse ENTIÈRE remplace le champ demandé, et le journal le DIT", async () => {
    // LE DÉFAUT MESURÉ. Cinquante-quatre outils du dépôt peuvent répondre par une phrase quand
    // ils ne trouvent rien — dix-huit d'entre eux sont des capacités de mission. Le planificateur
    // écrit son champ d'après la forme APPRISE, celle des jours où la capacité trouvait quelque
    // chose ; le jour de la phrase, le chemin se perdait dans une chaîne, l'étape passait
    // INVALID_STEP non rejouable, et TOUTE sa descendance restait PENDING (§118.99).
    const t = traceur((c) => (c.stepKey === "budget"
      ? "Aucune enveloppe budgétaire ne vous est ouverte."
      : { ok: true }));
    const id = await creerMission([
      { key: "budget", title: "Lire le budget", capability: "inspect_record", input: { reference: "ENV-2026" } },
      {
        key: "message", title: "Rendre compte", capability: "send_message",
        input: { recipientName: "{{budget.totalDzd}}", body: "Le budget dit — {{budget.totalDzd}}" },
      },
    ], "phrase entière");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees, "une réponse honnête ne doit tuer aucune branche").toBe(0);
    // LA CAPACITÉ EST APPELÉE — c'est tout l'enjeu : avant, elle ne l'était pas.
    const envoi = t.appels.find((a) => a.capability === "send_message")!;
    expect(envoi.input.recipientName).toBe("Aucune enveloppe budgétaire ne vous est ouverte.");
    expect(envoi.input.body).toBe("Le budget dit — Aucune enveloppe budgétaire ne vous est ouverte.");
    const etat = await chargerEtat(id);
    expect(etat!.steps.find((s) => s.key === "message")!.status).toBe("DONE");
    // ET CE N'EST PAS SILENCIEUX (§118.52) : le plan a demandé un CHAMP et reçu une PHRASE ; le
    // compte rendu de la mission a besoin de ce fait pour expliquer pourquoi il parle d'absence.
    const journal = await prisma.missionEvent.findMany({ where: { missionId: id, kind: "REFERENCE_TRADUITE" }, select: { summary: true } });
    expect(journal, "une traduction se consigne, une par référence").toHaveLength(1);
    expect(journal[0].summary).toContain("a répondu par une PHRASE");
    expect(journal[0].summary).toContain("totalDzd");
  });

  it("un OBJET auquel il manque LE champ demandé reste une faute de plan — on ne substitue jamais l'objet entier", async () => {
    // LA MOITIÉ QUI COMPTE (§118.71) : traduire ici mettrait `{"resultats":[…]}` dans un
    // destinataire. Un objet A des champs ; en descendre le mauvais est une vraie erreur de
    // chemin, et le refus nomme les champs pour que la replanification corrige.
    const t = traceur((c) => (c.stepKey === "recherche" ? { resultats: [{ id: "n-1" }] } : { ok: true }));
    const id = await creerMission([
      { key: "recherche", title: "Chercher", capability: "search_drive", input: { query: "contrat" } },
      { key: "lecture", title: "Lire", capability: "inspect_record", input: { reference: "{{recherche.introuvable}}" } },
    ], "objet sans le champ");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees).toBe(1);
    const etat = await chargerEtat(id);
    const lecture = etat!.steps.find((s) => s.key === "lecture")!;
    expect(lecture.errorKind).toBe("INVALID_STEP");
    expect(lecture.error).toContain("champs disponibles : resultats");
  });

  it("une échéance d'attente LUE dans les données : l'attente devient concrète en base, et le balayage temporel peut la lire", async () => {
    const t = traceur((c) => (c.stepKey === "analyse" ? { dateEcheance: "2099-03-31", partenaire: "Hetero Labs" } : { ok: true }));
    const id = await creerMission([
      { key: "analyse", title: "Lire l'échéance", capability: "inspect_record", input: { reference: "CTR-1" } },
      { key: "attente", title: "Attendre l'échéance", nodeType: "WAIT_EVENT", waitFor: { until: "{{analyse.dateEcheance}}", from: "{{analyse.partenaire}}" } },
    ], "échéance dérivée");

    await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    const attente = etat!.steps.find((s) => s.key === "attente")!;
    expect(attente.status).toBe("WAITING");
    expect(attente.waitFor).toMatchObject({ until: "2099-03-31", from: "Hetero Labs" });
    expect(etat!.status).toBe("WAITING_EVENT");
  });

  it("une échéance dérivée illisible ne fait pas dormir la mission pour toujours : l'attente échoue avec la valeur", async () => {
    const t = traceur((c) => (c.stepKey === "analyse" ? { dateEcheance: "fin novembre" } : { ok: true }));
    const id = await creerMission([
      { key: "analyse", title: "Lire l'échéance", capability: "inspect_record", input: { reference: "CTR-2" } },
      { key: "attente", title: "Attendre l'échéance", nodeType: "WAIT_EVENT", waitFor: { until: "{{analyse.dateEcheance}}" } },
    ], "échéance illisible");

    const r = await avancer(id, actor, { runner: t.runner });
    expect(r.echouees).toBe(1);
    const etat = await chargerEtat(id);
    const attente = etat!.steps.find((s) => s.key === "attente")!;
    expect(attente.status).toBe("FAILED");
    expect(attente.error).toContain("« fin novembre »");
    expect(attente.error).toContain("n'est pas une date lisible");
  });
});
