import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import { missionsAFaireAvancer } from "@/lib/missions/events/router";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BATTEMENT VOIT-IL LA MISSION QUI A BESOIN D'UN NOUVEAU PLAN ?
 *
 * ── LE DÉFAUT, ET IL RENDAIT TOUTE LA REPLANIFICATION MORTE POUR UNE FAMILLE ENTIÈRE ────
 *
 * `missionsAFaireAvancer` exigeait « au moins une étape PENDING ou FAILED ». C'est juste pour
 * une mission qui a du travail devant elle. Ce ne l'est pas pour le cas CENTRAL de la famille
 * COMPOSITION : le plan a oublié la primitive CALCUL ou DOCUMENT, toutes les étapes ont abouti,
 * le contrôle qualité est vert, et le JUGE refuse. Cette mission ne porte aucune étape PENDING
 * ni FAILED. Elle n'était donc jamais candidate, jamais conduite, jamais replanifiée — alors
 * que `replanifierMission` prévoit explicitement ce cas sous le nom `objectifManque`, et que
 * `PLANS_MAX = 4` laissait croire à trois corrections qui n'avaient aucun chemin pour arriver.
 *
 * Le test part de la BASE, comme le battement : on écrit des missions réelles et on demande à
 * la requête de production lesquelles elle rend. Un test qui appellerait `replanifierMission`
 * à la main ne dirait rien du défaut — le défaut était précisément que personne ne l'appelait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const siBase = dbOk ? describe : describe.skip;

const MARQUE = `battement-replan-${Math.random().toString(36).slice(2, 10)}`;
const creees: string[] = [];

/** Le propriétaire est À CE BANC : un compte emprunté part avec son banc, et ses missions en cascade (`Mission.owner`). */
const comptes = comptesDeBanc("__battreplan_");
let proprietaireDuBanc: Promise<string> | null = null;
const proprietaire = (): Promise<string> => (proprietaireDuBanc ??= comptes.creer("proprietaire").then((u) => u.id));

async function missionAvec(opts: {
  statut: string; planVersion?: number; replanBloque?: boolean; etapes: { statut: string }[];
}): Promise<string> {
  const m = await prisma.mission.create({
    data: {
      kind: "RUNTIME", title: MARQUE, objective: MARQUE, goalRaw: MARQUE,
      ownerId: await proprietaire(), status: opts.statut as never, planVersion: opts.planVersion ?? 1,
      replanBloque: opts.replanBloque ?? false,
      acceptance: [] as never,
    },
    select: { id: true },
  });
  creees.push(m.id);
  for (const [i, e] of opts.etapes.entries()) {
    await prisma.missionStep.create({
      data: {
        missionId: m.id, key: `e${i}`, title: `étape ${i}`, nodeType: "CAPABILITY",
        capability: "directory_list", status: e.statut, attempt: 3, maxAttempts: 3,
      },
    });
  }
  return m.id;
}

siBase("la requête du battement atteint ce qui doit être replanifié", () => {
  afterAll(async () => {
    if (creees.length > 0) await prisma.mission.deleteMany({ where: { id: { in: creees } } }).catch(() => {});
    await comptes.retirer();
  });

  it("LE CAS CENTRAL : toutes les étapes abouties, mission BLOCKED — elle est candidate", async () => {
    const id = await missionAvec({ statut: "BLOCKED", etapes: [{ statut: "DONE" }, { statut: "DONE" }] });
    const candidates = await missionsAFaireAvancer(500);
    expect(candidates, "la mission BLOCKED dont tout a abouti n'est pas vue par le battement").toContain(id);
  });

  it("PARTIAL avec une étape épuisée est candidate — le cas le plus fréquent de la famille", async () => {
    const id = await missionAvec({ statut: "PARTIAL", etapes: [{ statut: "DONE" }, { statut: "FAILED" }] });
    expect(await missionsAFaireAvancer(500)).toContain(id);
  });

  it("LE TEST QUI COMPTE : le refus RÉPÉTÉ arrête la boucle, il ne la déguise pas", async () => {
    // Sans cette borne DANS la requête, une mission définitivement bloquée redeviendrait
    // candidate à chaque battement pour se faire refuser un plan de plus — un travail nul,
    // répété toutes les minutes, sur chaque mission morte du produit.
    const bloquee = await missionAvec({ statut: "BLOCKED", replanBloque: true, etapes: [{ statut: "DONE" }] });
    expect(await missionsAFaireAvancer(500)).not.toContain(bloquee);
  });

  /**
   * LA FIN DU PLAFOND GLOBAL (§118.42), tenue par la requête RÉELLE.
   *
   * Une mission longue compile un sous-plan par jalon : sa `planVersion` monte avec le nombre de
   * jalons franchis, pas avec le nombre d'erreurs. Sous l'ancien `planVersion < PLANS_MAX`, une
   * mission de huit jalons cessait d'être candidate au cinquième — pour avoir AVANCÉ.
   */
  it("une planVersion élevée ne disqualifie plus : c'est le PROGRÈS qui compte, pas le compteur", async () => {
    const longue = await missionAvec({ statut: "BLOCKED", planVersion: 9, etapes: [{ statut: "DONE" }] });
    expect(await missionsAFaireAvancer(500)).toContain(longue);
  });

  it("une mission terminée ou suspendue n'est jamais candidate — la borne d'origine tient", async () => {
    const finie = await missionAvec({ statut: "COMPLETED", etapes: [{ statut: "DONE" }] });
    const suspendue = await missionAvec({ statut: "PAUSED", etapes: [{ statut: "PENDING" }] });
    const candidates = await missionsAFaireAvancer(500);
    expect(candidates).not.toContain(finie);
    expect(candidates).not.toContain(suspendue);
  });

  it("mesure consignée — les états replanifiables sont tous atteints", async () => {
    const cas: [string, string, { statut: string }[], boolean][] = [
      ["BLOCKED tout abouti", "BLOCKED", [{ statut: "DONE" }], true],
      ["PARTIAL étape morte", "PARTIAL", [{ statut: "DONE" }, { statut: "FAILED" }], true],
      ["FAILED tout abouti", "FAILED", [{ statut: "DONE" }], true],
      ["RUNNING en attente", "RUNNING", [{ statut: "PENDING" }], true],
      ["COMPLETED", "COMPLETED", [{ statut: "DONE" }], false],
      ["CANCELLED", "CANCELLED", [{ statut: "DONE" }], false],
      ["PAUSED", "PAUSED", [{ statut: "PENDING" }], false],
    ];
    const ids: [string, string, boolean][] = [];
    for (const [nom, statut, etapes, attendu] of cas) {
      ids.push([nom, await missionAvec({ statut, etapes }), attendu]);
    }
    const candidates = new Set(await missionsAFaireAvancer(1000));
    const justes = ids.filter(([, id, attendu]) => candidates.has(id) === attendu);
    consignerMesure("mission_replanifiable_atteinte", { n: ids.length, ok: justes.length },
      "platform/in-process/missions/battement-replan.test.ts",
      "états de mission que la requête du battement classe correctement candidate / non candidate");
    expect(ids.filter(([, id, a]) => candidates.has(id) !== a).map(([n]) => n)).toEqual([]);
  });
});
