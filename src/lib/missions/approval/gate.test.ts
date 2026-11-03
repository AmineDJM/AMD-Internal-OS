import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { approbationsEnAttente, decider, demanderApprobation, porteApprobation, prevenir } from "./gate";
import { perimetre } from "./scope";
import { avancer } from "@/lib/missions/runtime/engine";
import { chargerEtat, materialiser } from "@/lib/missions/runtime/store";
import { compile, type CompiledMission } from "@/lib/missions/compiler/compile";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * §32-33 — UN ACCORD, TRENTE-TROIS ENVOIS, ET AUCUN AVANT.
 *
 * La propriété testée ici est celle dont dépend la confiance : entre le moment où Adam propose
 * et le moment où le PDG accepte, RIEN ne part. Et une fois qu'il a accepté, on ne le
 * redérange pas trente-deux fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mappr__${Date.now()}`;
let ownerId = "";
let actor: MissionActor;

const CONNUES = ["directory_list", "inspect_record", "send_message", "send_email"];
const catalogue: CapabilityCatalog = {
  has: (n) => CONNUES.includes(n),
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => [],
};

function traceur() {
  const appels: CapabilityCall[] = [];
  return {
    appels,
    runner: {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        const employes = Array.from({ length: 33 }, (_, i) => ({ id: `emp-${i}`, prenom: `P${i}` }));
        return { ok: true, output: call.stepKey === "liste" ? { employes } : { ok: true } };
      },
    },
  };
}

function compiler(steps: PlannedStep[], objectif = "objectif"): CompiledMission {
  const plan: MissionPlan = { objective: objectif, acceptance: ["fait"], complexity: "B", scale: "M", steps };
  const r = compile(plan, catalogue, actor);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code} ${i.message}`).join(" | "));
  return r.mission;
}

/** La mission du §28 : lister, faire approuver, puis envoyer à chacun. */
const PLAN_VOEUX: PlannedStep[] = [
  { key: "liste", title: "Lister l'effectif", capability: "directory_list" },
  { key: "porte", title: "Votre accord", nodeType: "APPROVAL", dependsOn: ["liste"] },
  {
    key: "voeux", title: "Vœux", capability: "send_message", dependsOn: ["porte"],
    forEach: { from: "liste", path: "employes", as: "e" },
    input: { to: "{{e.id}}", corps: "Bonne année {{e.prenom}}" },
  },
];

suite("Mission Runtime — la porte d'approbation", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    ownerId = u.id;
    actor = { userId: u.id, label: "le PDG", isAgent: false };
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: ownerId } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("RIEN NE PART avant l'accord — puis UN accord suffit pour les 33", async () => {
    const m = compiler(PLAN_VOEUX, "vœux de bonne année");
    const p = perimetre(m)!;
    const id = await materialiser(m, { ownerId, title: "Vœux 2026", goalRaw: "souhaite la bonne année à tout le monde" });

    // ── PREMIER TOUR : la liste est lue, la porte s'arrête ─────────────────────────────
    const t = traceur();
    const r1 = await avancer(id, actor, {
      runner: t.runner,
      handlers: { APPROVAL: porteApprobation(p, "Vœux 2026") },
    });
    expect(r1.status).toBe("AWAITING_APPROVAL");
    expect(t.appels.filter((a) => a.capability === "send_message")).toHaveLength(0);

    // La demande existe, une seule fois, et le PDG a été prévenu.
    const attente = await approbationsEnAttente(ownerId);
    const laNotre = attente.filter((a) => a.missionId === id);
    expect(laNotre).toHaveLength(1);
    expect(laNotre[0].level).toBe("NORMAL");
    // La porte figure dans le périmètre autant que l'acte : c'est elle que l'accord débloque.
    expect(laNotre[0].stepKeys).toEqual(["porte", "voeux"]);

    const notifs = await prisma.notification.findMany({
      where: { userId: ownerId, type: "VALIDATION_REQUIRED" },
    });
    expect(notifs.length).toBeGreaterThanOrEqual(1);

    // ── DEUXIÈME TOUR SANS ACCORD : toujours rien ─────────────────────────────────────
    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner, handlers: { APPROVAL: porteApprobation(p, "Vœux 2026") } });
    expect(t2.appels.filter((a) => a.capability === "send_message")).toHaveLength(0);
    // Et la demande n'a PAS été dupliquée — sinon le PDG recevrait une alerte par tour.
    expect((await approbationsEnAttente(ownerId)).filter((a) => a.missionId === id)).toHaveLength(1);

    // ── L'ACCORD ──────────────────────────────────────────────────────────────────────
    expect(await decider(laNotre[0].id, "GRANTED", ownerId)).toBe(true);

    const t3 = traceur();
    await avancer(id, actor, { runner: t3.runner, handlers: { APPROVAL: porteApprobation(p, "Vœux 2026") } });
    const envois = t3.appels.filter((a) => a.capability === "send_message");
    expect(envois).toHaveLength(33);
    expect(new Set(envois.map((a) => a.input.to)).size).toBe(33);

    // UN SEUL ACCORD POUR LES TRENTE-TROIS : le PDG n'a été sollicité qu'une fois.
    const total = await prisma.missionApproval.count({ where: { missionId: id } });
    expect(total).toBe(1);
  }, 90_000);

  it("un refus arrête la branche DÉFINITIVEMENT, sans réessayer", async () => {
    const m = compiler([
      { key: "porte", title: "Accord", nodeType: "APPROVAL" },
      { key: "envoi", title: "Envoi", capability: "send_email", input: { to: "a@x.dz" }, dependsOn: ["porte"] },
    ], "refus");
    const p = perimetre(m)!;
    const id = await materialiser(m, { ownerId, title: "Refusée", goalRaw: "refus" });

    const t = traceur();
    await avancer(id, actor, { runner: t.runner, handlers: { APPROVAL: porteApprobation(p, "Refusée") } });
    const demande = (await approbationsEnAttente(ownerId)).find((a) => a.missionId === id)!;
    expect(await decider(demande.id, "REFUSED", ownerId)).toBe(true);

    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner, handlers: { APPROVAL: porteApprobation(p, "Refusée") } });
    expect(t2.appels).toHaveLength(0);

    const etat = await chargerEtat(id);
    const porte = etat!.steps.find((s) => s.key === "porte")!;
    expect(porte.status).toBe("FAILED");
    expect(porte.errorKind).toBe("APPROVAL_REFUSED");
    // NON REJOUABLE : réessayer trois fois, c'est harceler quelqu'un qui a déjà dit non.
    expect(porte.attempt).toBe(porte.maxAttempts);
  }, 60_000);

  it("une décision ne se prend qu'UNE fois", async () => {
    const m = compiler([
      { key: "porte", title: "Accord", nodeType: "APPROVAL" },
      { key: "e", title: "E", capability: "send_message", input: { to: "x" }, dependsOn: ["porte"] },
    ], "double décision");
    const p = perimetre(m)!;
    const id = await materialiser(m, { ownerId, title: "Double", goalRaw: "double" });
    const demandeId = await demanderApprobation(id, p, ownerId, "Double");

    expect(await decider(demandeId, "GRANTED", ownerId)).toBe(true);
    expect(await decider(demandeId, "REFUSED", ownerId)).toBe(false);

    const a = await prisma.missionApproval.findUnique({ where: { id: demandeId }, select: { status: true } });
    expect(a!.status).toBe("GRANTED");
  }, 60_000);

  it("§33 — un périmètre MODIFIÉ périme la demande en attente et en ouvre une neuve", async () => {
    const initial = compiler([
      { key: "e", title: "E", capability: "send_email", input: { to: "alla@x.dz", corps: "Prime" } },
    ], "changement de périmètre");
    const id = await materialiser(initial, { ownerId, title: "Périmètre", goalRaw: "périmètre" });
    const premiere = await demanderApprobation(id, perimetre(initial)!, ownerId, "Périmètre");

    // Le corps change : ce n'est plus la même mission derrière le même plan.
    const modifie = compiler([
      { key: "e", title: "E", capability: "send_email", input: { to: "alla@x.dz", corps: "Gel des salaires" } },
    ], "changement de périmètre");
    const seconde = await demanderApprobation(id, perimetre(modifie)!, ownerId, "Périmètre");

    expect(seconde).not.toBe(premiere);
    const anciennes = await prisma.missionApproval.findUnique({ where: { id: premiere }, select: { status: true } });
    // L'ANCIENNE EST PÉRIMÉE : la laisser en attente offrirait d'autoriser un plan qui n'existe
    // plus, et laisserait croire au PDG qu'il a débloqué la mission.
    expect(anciennes!.status).toBe("SUPERSEDED");
    expect((await approbationsEnAttente(ownerId)).filter((a) => a.missionId === id)).toHaveLength(1);
  }, 60_000);

  it("un périmètre INCHANGÉ retrouve la demande existante au lieu d'en créer une seconde", async () => {
    const m = compiler([
      { key: "e", title: "E", capability: "send_message", input: { to: "p1" } },
    ], "périmètre stable");
    const id = await materialiser(m, { ownerId, title: "Stable", goalRaw: "stable" });
    const a = await demanderApprobation(id, perimetre(m)!, ownerId, "Stable");
    const b = await demanderApprobation(id, perimetre(m)!, ownerId, "Stable");
    expect(b).toBe(a);
    expect(await prisma.missionApproval.count({ where: { missionId: id } })).toBe(1);
  }, 60_000);

  it("§35 — Adam prévient de lui-même, par le système de notifications DÉJÀ en place", async () => {
    const m = compiler([{ key: "a", title: "A", capability: "directory_list" }], "notification");
    const id = await materialiser(m, { ownerId, title: "Notif", goalRaw: "notif" });

    await prevenir({
      missionId: id, ownerId, niveau: "IMPORTANT",
      titre: "Le contrat de Redouane n'est toujours pas arrivé",
      message: "Cinq jours se sont écoulés depuis la demande.",
    });

    const n = await prisma.notification.findFirst({
      where: { userId: ownerId, title: { contains: "Redouane" } },
      orderBy: { createdAt: "desc" },
    });
    expect(n).not.toBeNull();
    expect(n!.type).toBe("GENERIC");
    expect(n!.link).toBe(`/missions/${id}`);

    // Le fait est aussi dans le journal de la mission : l'écran et la trace disent la même chose.
    const evt = await prisma.missionEvent.findFirst({ where: { missionId: id, kind: "NOTIFIED" } });
    expect(evt).not.toBeNull();
  }, 60_000);
});
