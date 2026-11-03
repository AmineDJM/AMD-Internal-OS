import { describe, expect, it } from "vitest";
import { travailleurCloud } from "@/lib/missions/equipe/travailleurs";
import { fauxPortsDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { ConsigneDev } from "@/lib/missions/chantiers/ports-moteur";
import { planDeChantier } from "@/lib/missions/equipe/conduite";
import { lirePlanProgramme, type TacheProgramme } from "@/lib/missions/equipe/programme";
import { ordonnancer, sessionsHeureMax } from "@/lib/missions/equipe/ordonnanceur";
import { lirePlanChantier } from "@/lib/missions/chantiers/plan";

/**
 * O2 (décision 0059 § 2) — LE PORT TRAVAILLEUR, SESSIONS CLOUD SEULEMENT (Direction, 02-03/11 : « Abonnement, garde les
 * sessions cloud seulement ») : un message va à la MÊME session ; état et arrêt sont refusés et DITS (aucune API sur
 * l'abonnement) ; un plan qui demande autre chose est refusé ; le quota horaire des Routines borne les lancements.
 */

const consigne: ConsigneDev = {
  depot: { proprietaire: "aminedjm", nom: "amd-internal-os" }, branche: "claude/prog-x-a", brancheBase: "main", objectif: "Faire a",
  perimetre: ["src/lib/a/**"], criteres: ["npm test -- a passe"], commandesVerif: ["npm test -- a"], chantierId: "ch1",
};

describe("travailleur — sessions cloud Claude Code, rien d'autre", () => {
  it("lancer, puis envoyer à la MÊME session (relais) ; état et arrêt refusés et dits", async () => {
    const ports = fauxPortsDev();
    const vus: unknown[] = [];
    const relancer = ports.agent.relancer.bind(ports.agent);
    ports.agent.relancer = async (c, cle) => { vus.push({ session: c.session, sans: c.sansNouvelleSession, probleme: c.probleme }); return relancer(c, cle); };
    const t = travailleurCloud(ports.agent);
    expect(await t.lancer(consigne, "k1")).toMatchObject({ ok: true, valeur: { moyen: "routine" } });
    await t.envoyer(consigne, "session-1", "corrige", "k2");
    expect(vus).toEqual([{ session: "session-1", sans: true, probleme: "corrige" }]);
    expect(await t.etat("session-1")).toMatchObject({ ok: false, erreur: expect.stringMatching(/GitHub fait foi/) });
    expect(await t.arreter("session-1")).toMatchObject({ ok: false, erreur: expect.stringMatching(/aucune API n'arrête une session/) });
  });

  it("un plan qui demande un autre travailleur (API facturée à l'usage) est REFUSÉ", () => {
    const r = lirePlanProgramme({ titre: "P", objectif: "o", depot: { proprietaire: "a", nom: "b" }, travailleur: "managed-agents", taches: [{ cle: "a", objectif: "x", perimetre: ["src/a/**"], criteres: ["npm test passe sans échec"], commandesVerif: ["npm test"] }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fautes.join(" ")).toMatch(/sessions cloud Claude Code \(abonnement\)/);
  });

  it("le QUOTA HORAIRE des sessions cloud borne les départs (25 par défaut, jamais plus de 90) et ne bloque pas le programme", () => {
    expect(sessionsHeureMax({} as NodeJS.ProcessEnv)).toBe(25);
    expect(sessionsHeureMax({ EQUIPE_SESSIONS_HEURE_MAX: "500" } as unknown as NodeJS.ProcessEnv)).toBe(90);
    const t = (cle: string): TacheProgramme => ({ cle, titre: cle, objectif: cle, perimetre: [`src/${cle}/**`], ressources: [], criteres: ["c vérifiable ici"], commandesVerif: ["npm test"], dependances: [], migrations: false, taille: "M" });
    const d = ordonnancer({ taches: [t("a"), t("b"), t("c")], concurrence: 3 }, {}, { lancementsRestants: 9, usdRestant: 9, sessionsHeureRestantes: 2 });
    expect(d.lancer).toEqual(["a", "b"]);
    expect(d.attentes.c).toMatch(/quota horaire/);
    const vide = ordonnancer({ taches: [t("a")], concurrence: 3 }, {}, { lancementsRestants: 9, usdRestant: 9, sessionsHeureRestantes: 0 });
    expect(vide.fin).toBeNull();
  });
});

describe("un programme ne DÉPLOIE jamais et ne FUSIONNE jamais seul", () => {
  it("le chantier d'une tâche n'a ni service, ni étape de fusion, ni déploiement ; ses ressources sont réservées", () => {
    const p = lirePlanProgramme({ titre: "P", objectif: "o", depot: { proprietaire: "a", nom: "b" }, taches: [{ cle: "a", objectif: "x", perimetre: ["prisma/**"], ressources: ["SCHEMA"], criteres: ["npm test passe sans échec"], commandesVerif: ["npm test"] }] });
    if (!p.ok) throw new Error(p.fautes.join(" "));
    const c = lirePlanChantier(planDeChantier(p.plan, p.plan.taches[0]!, "claude/prog-x-a", "prog1"));
    if (!c.ok) throw new Error(c.fautes.join(" "));
    expect(c.plan.services).toEqual([]);
    expect(c.plan.etapes.map((e) => e.type)).toEqual(["DEV_LANCER", "DEV_ATTENDRE", "DEV_VERIFIER", "DEV_CORRIGER", "RAPPORT"]);
    expect(c.plan.brancheBase).toBe("main");
    expect(c.plan.ressources).toEqual(["SCHEMA"]);
    expect(c.plan.perimetre).toEqual(expect.arrayContaining(["prisma/**", "prisma/schema.prisma", "prisma/migrations/**"]));
  });
});
