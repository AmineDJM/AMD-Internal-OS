/**
 * Acceptance du Run 4 — LA ROBUSTESSE : §9 CRASH (le worker meurt, un autre reprend, zéro double
 * effet) et §10-11 MASSIF (120 unités réelles, progression exacte, interactif servi).
 */
import { prisma } from "@/lib/prisma";
import { RaisonneurScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { RaisonneurInstrumente } from "@/platform/in-process/missions/provider-waterfall";
import { avancerMission } from "@/platform/in-process/missions/runtime";
import { prendreBail, rendreBail } from "@/platform/in-process/missions/sweep";
import { jouer, type Scenario } from "@/platform/in-process/missions/provider-smoke";
import { verdictProfond } from "@/platform/in-process/missions/deep-smoke";
import { vueMission } from "@/lib/missions/view/workspace";
import { type ContexteAcceptance, attendre, conduire, controle, type EtapeLibre, jugePour, lecture, planDe } from "./banc";

export async function scenariosRobustesse(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, acteur, missionsCreees, jouerScenario, lancer } = ctx;
  /* ═══════════════ §9 — CRASH : le worker meurt, un autre reprend, zéro double effet ═══════════════ */

  await jouerScenario("CRASH-1", "CRASH_RESTART", "arrêt en plein vol → bail fantôme expiré → reprise → reçus INTACTS, zéro rejeu", false, async () => {
    const criteres = ["les huit lectures sont faites"];
    const chaine: EtapeLibre[] = [];
    for (let i = 1; i <= 8; i++) chaine.push(lecture(`lire${i}`, i === 1 ? [] : [`lire${i - 1}`], 2));
    const plan = planDe("Huit lectures en chaîne", "M", criteres, [...chaine, controle(["lire8"])]);
    const { missionId, cerveau } = await lancer("Enchaîne huit lectures d'annuaire puis conclus.", plan, criteres, { titre: "crash" });

    // LE PREMIER WORKER — coupé en plein vol (maxTours court : le processus « meurt »).
    await avancerMission(acteur, missionId, { reasoner: cerveau, lectureSeule: true, maxTours: 3 });
    const avant = await prisma.missionStep.findMany({
      where: { missionId, status: "DONE" },
      select: { key: true, receipt: true, completedAt: true, attempt: true },
    });
    attendre(avant.length > 0 && avant.length < 8, `la coupure devait laisser un chantier partiel (${avant.length}/8 faites)`);

    // LE BAIL DU MORT : une autre instance le tenait, elle ne le rendra jamais — il EXPIRE.
    await prisma.mission.update({
      where: { id: missionId },
      data: { leaseOwner: `worker-mort-${TAG}`, leaseUntil: new Date(Date.now() - 1_000) },
    });
    attendre(await prendreBail(missionId), "le bail expiré d'un worker mort n'a pas pu être repris");
    const statut = await conduire(acteur, missionId, cerveau);
    await rendreBail(missionId);
    attendre(statut === "COMPLETED", `après reprise, la mission finit en ${statut}`);

    // LES REÇUS D'AVANT LA PANNE SONT INTACTS — étape par étape, à l'octet du reçu près.
    const apres = await prisma.missionStep.findMany({
      where: { missionId, key: { in: avant.map((s) => s.key) } },
      select: { key: true, receipt: true, completedAt: true, attempt: true },
    });
    for (const s of avant) {
      const relu = apres.find((x) => x.key === s.key);
      attendre(relu, `l'étape ${s.key} a disparu à la reprise`);
      attendre(relu.receipt === s.receipt && relu.completedAt?.getTime() === s.completedAt?.getTime(),
        `l'étape ${s.key} a été REJOUÉE après la panne (reçu ou horodatage modifié) — double effet`);
    }
    const toutes = await prisma.missionStep.findMany({ where: { missionId }, select: { status: true, attempt: true } });
    attendre(toutes.every((s) => s.status === "DONE" || s.status === "CANCELLED" ? s.attempt <= 1 : true),
      "au moins une étape aboutie compte plus d'une tentative — un rejeu s'est produit");
    return {
      mesures: { faitesAvantPanne: avant.length, etapes: 9 },
      preuve: `${avant.length}/8 faites avant la coupure ; bail du worker mort expiré puis repris ; reprise conclue COMPLETED ; reçus et horodatages d'avant-panne IDENTIQUES — zéro double effet, zéro rejeu.`,
    };
  });

  /* ═══════════════ §10-11 — MASSIF : 120 unités RÉELLES + progression EXACTE ═══════════════ */

  await jouerScenario("MASS-1", "MASSIVE", "éventail de 120 unités par le MÊME harnais que les 54 + interactif servi + progression comptée", false, async () => {
    const departement = `DEP-${TAG}`;
    await prisma.employee.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        fullName: `${TAG} Salarié ${String(i + 1).padStart(3, "0")}`,
        email: `${TAG}.s${i + 1}@amd-acceptance.dz`,
        department: departement, position: "Essai", isActive: true,
      })),
    });
    const criteres = ["chaque salarié du département a son point individuel"];
    const plan = planDe("Un point par salarié du département", "L", criteres, [
      {
        key: "liste", title: "Lister le département", nodeType: "CAPABILITY", capability: "directory_list",
        inputs: [
          { key: "department", kind: "TEXT", value: departement },
          { key: "limit", kind: "NUMBER", value: "200" },
        ],
        completionCondition: "la liste des salariés est chargée",
      },
      {
        key: "point", title: "Point individuel", nodeType: "CAPABILITY", capability: "directory_lookup",
        inputs: [{ key: "name", kind: "TEXT", value: "{{salarie.nom}}" }],
        dependsOn: ["liste"],
        forEachFrom: "liste", forEachPath: "salaries", forEachAs: "salarie",
        completionCondition: "le point du salarié est fait",
      },
      controle(["point"]),
    ]);
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan })), jugePour(criteres)]);
    const instrument = new RaisonneurInstrumente(cerveau, Date.now());
    const sc: Scenario = {
      genre: "ACC_MASSIF", titre: "éventail 120",
      demande: `Pour chacun des salariés du département ${departement}, fais un point individuel, puis conclus.`,
      verite: "120 salariés créés et COMPTÉS avant lancement.",
    };

    // LE MÊME HARNAIS que les 54 missions historiques (plafond ANALYZE, garde d'artefacts,
    // conduite à l'état stable) — pendant qu'un client interactif interroge le système.
    const pMission = jouer(acteur, sc, instrument, Date.now());
    const latences: number[] = [];
    // Une CHAÎNE plutôt qu'un objet : l'affectation vit dans la sonde (fermeture), et le
    // narrowing de TypeScript ne suit pas les fermetures — la preuve reste lisible telle quelle.
    let echantillonPartiel: string | null = null;
    let missionVue: string | null = null;
    const sonde = (async () => {
      for (let i = 0; i < 600; i++) {
        const ti = Date.now();
        await prisma.mission.count({ where: { ownerId: acteur.id } });
        if (!missionVue) {
          missionVue = (await prisma.mission.findFirst({
            where: { ownerId: acteur.id, title: { contains: "Diagnostic" } },
            orderBy: { createdAt: "desc" }, select: { id: true },
          }))?.id ?? null;
        } else {
          const vue = await vueMission(missionVue, acteur.id);
          if (vue && vue.avancement.faites > 0 && vue.avancement.faites < vue.avancement.total) {
            echantillonPartiel = `${vue.avancement.faites}/${vue.avancement.total}`;
          }
        }
        latences.push(Date.now() - ti);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const { r } = await pMission;
    await Promise.race([sonde, new Promise((res) => setTimeout(res, 100))]);
    if (r.missionId) missionsCreees.add(r.missionId);
    const verdict = verdictProfond(r);
    attendre(verdict.verdict === "SUCCES", `l'éventail massif n'est pas un SUCCÈS : ${verdict.raison}`);
    attendre(r.etapesTerminees >= 122, `${r.etapesTerminees} étapes terminées — l'éventail n'a pas déployé ses 120 unités`);

    // §11 — LA PROGRESSION est l'état RÉEL, comptée deux fois : la vue contre la base.
    attendre(r.missionId, "aucune mission massive");
    const vueFinale = await vueMission(r.missionId, acteur.id);
    const filles = await prisma.missionStep.count({ where: { missionId: r.missionId, key: { contains: "#" } } });
    const reellesDone = await prisma.missionStep.count({
      where: { missionId: r.missionId, status: "DONE", NOT: { key: "point" } },
    });
    attendre(vueFinale && vueFinale.avancement.faites === reellesDone,
      `la progression affichée (${vueFinale?.avancement.faites}) diffère du compte en base (${reellesDone}) — une estimation, pas un état`);
    const p50 = [...latences].sort((a, b) => a - b)[Math.floor(latences.length / 2)] ?? null;
    attendre(p50 !== null && p50 < 2_000, `l'interactif a ramé pendant le massif (P50 ${p50} ms)`);
    return {
      mesures: {
        unites: filles, etapesTerminees: r.etapesTerminees, dureeMs: r.cascade?.totalMs ?? null,
        latenceInteractiveP50Ms: p50, progressionPartielleObservee: echantillonPartiel,
        progressionFinale: vueFinale?.avancement ?? null,
      },
      preuve: `éventail ${filles} filles réelles conclu en ${(((r.cascade?.totalMs ?? 0)) / 1000).toFixed(1)}s par le harnais des 54 ; interactif P50 ${p50} ms pendant ; progression = compte exact (vue ${vueFinale?.avancement.faites} = base ${reellesDone}${echantillonPartiel ? ` ; échantillon en vol ${echantillonPartiel}` : ""}).`,
    };
  });
}
