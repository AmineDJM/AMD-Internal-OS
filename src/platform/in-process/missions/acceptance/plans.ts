/**
 * Acceptance du Run 4 — LES PLANS ET LEUR PRIX : §15 formes de plans influentes, §16 spéculation,
 * §25 anti-triche (la paraphrase rend le même verdict), §17 coût exact ou inconnu.
 */
import { prisma } from "@/lib/prisma";
import { RaisonneurScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { RaisonneurInstrumente } from "@/platform/in-process/missions/provider-waterfall";
import { lancerMission } from "@/platform/in-process/missions/runtime";
import { jouer } from "@/platform/in-process/missions/provider-smoke";
import { verdictProfond } from "@/platform/in-process/missions/deep-smoke";
import { etatPorte } from "@/lib/models/throttle";
import { costOf } from "@/lib/models/contract";
import { bindingFor } from "@/lib/models/registry";
import { sansBloquer } from "@/lib/journal";
import { type ContexteAcceptance, attendre, conduire, controle, jugePour, lecture, planDe, ralenti } from "./banc";

export async function scenariosPlans(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, PREFIXE, acteur, missionsCreees, jouerScenario, lancer } = ctx;
  /* ═══════════════ §15 — LES FORMES DE PLANS : observées, validées, INFLUENTES ═══════════════ */

  await jouerScenario("PAT-1", "PLAN_PATTERNS", "3 réussites par le vrai moteur → VALIDATED → la 4ᵉ planification reçoit l'indication", false, async () => {
    const criteres = ["les deux lectures sont faites"];
    const forme = planDe("Deux lectures et un contrôle", "S", criteres, [
      {
        key: "chercher", title: "Chercher la personne", nodeType: "CAPABILITY", capability: "directory_lookup",
        inputs: [{ key: "name", kind: "TEXT", value: "Karim" }],
        completionCondition: "la recherche est faite",
      },
      lecture("lister", ["chercher"], 3),
      controle(["lister"]),
    ]);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const { missionId, cerveau } = await lancer(`Vérifie l'annuaire, passe nº ${n}.`, forme, criteres, { titre: `forme ${n}` });
      const statut = await conduire(acteur, missionId, cerveau);
      attendre(statut === "COMPLETED", `la mission ${n} de la forme finit en ${statut}`);
      ids.push(missionId);
    }
    const ligne = await prisma.missionPlanPattern.findFirst({
      where: { dernierMissionId: { in: ids } },
      select: { signature: true, statut: true, succes: true },
    });
    attendre(ligne, "aucune forme enregistrée après trois réussites — le moteur n'apprend pas");
    attendre(ligne.statut === "VALIDATED" && ligne.succes >= 3,
      `après 3 réussites distinctes la forme est ${ligne.statut} (${ligne.succes}) au lieu de VALIDATED`);

    // LA 4ᵉ PLANIFICATION — la forme est poussée en tête du classement (le classement par
    // succès est un orderBy trivial ; ce qu'on éprouve est le CHEMIN : base → composeur →
    // prompt du planner), puis on lit le prompt que le planner a RÉELLEMENT reçu.
    await prisma.missionPlanPattern.update({ where: { signature: ligne.signature }, data: { succes: 999_999 } });
    const { missionId: m4, cerveau: cerveau4 } = await lancer("Vérifie l'annuaire, passe de contrôle.", forme, criteres, { titre: "forme 4" });
    const demandePlan = cerveau4.demandes.find((d) => d.purpose === "mission.plan");
    attendre(demandePlan, "la 4ᵉ mission n'a pas appelé le planner");
    attendre(demandePlan.prompt.includes("indication SEULEMENT"),
      "le prompt du planner ne PORTE pas l'encadrement des formes — l'influence n'arrive pas au modèle");
    attendre(demandePlan.prompt.includes("CAPABILITY(directory_lookup)"),
      "la forme validée n'apparaît pas dans le prompt de la 4ᵉ planification");
    const journal = await prisma.missionEvent.findFirst({
      where: { missionId: m4, kind: "CREATED" }, select: { detail: true },
    });
    const proposees = ((journal?.detail ?? {}) as Record<string, unknown>).formesProposees;
    attendre(typeof proposees === "number" && proposees >= 1,
      "le journal CREATED ne compte pas les formes proposées — l'influence n'est pas auditable");
    await prisma.missionPlanPattern.delete({ where: { signature: ligne.signature } }).catch(sansBloquer("acceptance.executerAcceptance.missionPlanPattern"));
    return {
      mesures: { reussites: ligne.succes, statutForme: "VALIDATED", formesProposeesA4e: proposees },
      preuve: "3 missions réelles → forme VALIDATED en base ; la 4ᵉ planification reçoit l'indication (« indication SEULEMENT », jamais une autorité) et le journal CREATED en compte la proposition.",
    };
  });

  /* ═══════════════ §16 — SPÉCULATION : utile mesurée, inutile sans contamination ═══════════════ */

  const OBJECTIF_SPEC = "Organise une mise en regard inhabituelle des périmètres de Sarah et de Karim, sous trois angles distincts, et dis lequel des deux appelle une vigilance.";
  const planSpec = planDe("Mise en regard", "S", ["la mise en regard est faite"], [
    {
      key: "chercher", title: "Chercher", nodeType: "CAPABILITY", capability: "directory_lookup",
      inputs: [{ key: "name", kind: "TEXT", value: "Sarah" }], completionCondition: "fait",
    },
    controle(["chercher"]),
  ]);

  await jouerScenario("SPEC-1", "SPECULATIVE", "spéculation UTILE : finie pendant la latence du modèle, comptée au plan", false, async () => {
    const cerveau = ralenti(new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: planSpec })), jugePour(["la mise en regard est faite"]),
    ]), 250);
    const r = await lancerMission(acteur, OBJECTIF_SPEC, {
      lectureSeule: true, demarrer: false, reasoner: cerveau, titre: `${PREFIXE} spéculation utile`,
    });
    attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
    missionsCreees.add(r.missionId);
    attendre(r.metriques.voie === "MODELE", `la voie ${r.metriques.voie} court-circuite le modèle — la spéculation n'a pas lieu d'être ici`);
    const spec = r.metriques.speculation;
    attendre(spec && spec.terminee === true && spec.lectures >= 1,
      `la spéculation n'a pas fini pendant les 250 ms du modèle (${JSON.stringify(spec)})`);
    return {
      mesures: { ...spec, latenceModeleMs: 250 },
      preuve: `pendant les 250 ms du modèle, ${spec.lectures} lecture(s) d'annuaire spéculative(s) TERMINÉE(S) (${spec.ms} ms) — le cache est chaud quand la première étape lit pour de vrai.`,
    };
  });

  await jouerScenario("SPEC-2", "SPECULATIVE", "spéculation INUTILE : abandonnée sans retenir ni contaminer le plan", false, async () => {
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: planSpec })), jugePour(["la mise en regard est faite"]),
    ]);
    const debut = Date.now();
    const r = await lancerMission(acteur, OBJECTIF_SPEC, {
      lectureSeule: true, demarrer: false, reasoner: cerveau, titre: `${PREFIXE} spéculation abandonnée`,
    });
    const duree = Date.now() - debut;
    attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
    missionsCreees.add(r.missionId);
    const spec = r.metriques.speculation;
    attendre(spec && spec.terminee === false && spec.lectures === 0,
      `avec un modèle instantané, la spéculation devrait être ABANDONNÉE (${JSON.stringify(spec)})`);
    attendre(r.etapes === 2, "l'abandon de la spéculation a modifié le plan — contamination");
    return {
      mesures: { ...spec, dureeLancementMs: duree },
      preuve: `modèle instantané → spéculation abandonnée (course, pas jointure) : plan identique, lancement en ${duree} ms, zéro échec, zéro contamination.`,
    };
  });

  /* ═══════════════ §25 — ANTI-TRICHE : la paraphrase rend le MÊME verdict ═══════════════ */

  await jouerScenario("CHEAT-1", "ANTI_CHEAT", "paraphrase + jeton inédit → même forme de verdict ; le faux succès reste un DÉFAUT", false, async () => {
    const criteres = ["l'absence est démontrée sources citées"];
    const planAbsence = planDe("Démontrer une absence", "S", criteres, [lecture("verifier", [], 3), controle(["verifier"])]);
    const scripts = () => new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planAbsence })), jugePour(criteres)]);
    const joue = async (demande: string) => {
      const instrument = new RaisonneurInstrumente(scripts(), Date.now());
      const { r } = await jouer(acteur, {
        genre: "ACC_CHEAT", titre: "paraphrase", demande,
        verite: "le jeton est fabriqué : l'absence est structurelle.",
      }, instrument, Date.now());
      if (r.missionId) missionsCreees.add(r.missionId);
      return r;
    };
    // La FORMULATION HISTORIQUE du smoke, puis une paraphrase qu'aucun test n'a jamais vue —
    // avec des jetons différents. Un code qui reconnaîtrait la string de fixture divergerait.
    const a = await joue(`Vérifie si nous avons quoi que ce soit sur la molécule « Zorbamyxine-K7-${TAG}A » : produit, dossier réglementaire, marché, document. Conclus en citant chaque source vérifiée.`);
    const b = await joue(`Assure-toi qu'aucune trace du composé « Quintozerbal-Q9-${TAG}B » n'existe chez nous — produits, dossiers, marchés, documents — et prouve cette absence en citant tes vérifications.`);
    const va = verdictProfond(a);
    const vb = verdictProfond(b);
    attendre(va.verdict === vb.verdict && a.statutFinal === b.statutFinal,
      `la paraphrase change le verdict (${va.verdict}/${a.statutFinal} vs ${vb.verdict}/${b.statutFinal}) — un chemin reconnaît une string ; `
      + `raisons : A « ${va.raison} » / B « ${vb.raison} »`);
    attendre(va.verdict !== "DEFAUT", `le scénario de référence lui-même est en DÉFAUT : ${va.raison}`);

    // Le garde anti-FAUX-SUCCÈS ne s'est pas assoupli : COMPLETED sans objectif = DÉFAUT.
    const sabotage = verdictProfond({ ...a, statutFinal: "COMPLETED", stable: true, goalSatisfied: null });
    attendre(sabotage.verdict === "DEFAUT", "COMPLETED sans objectif jugé atteint devrait être un DÉFAUT — le garde a été assoupli");
    return {
      mesures: { verdictReference: va.verdict, verdictParaphrase: vb.verdict },
      preuve: `formulation historique et paraphrase inédite : même verdict (${va.verdict}), même état (${a.statutFinal}) — aucun branchement sur une string de test ; et COMPLETED sans objectif reste classé DÉFAUT.`,
    };
  });

  /* ═══════════════ §17 — LE COÛT : exact ou INCONNU, jamais partiel ═══════════════ */

  await jouerScenario("COST-1", "COST_ACCOUNTING", "le coût est exact quand les tarifs existent, INCONNU sinon — jamais un partiel déguisé", false, async () => {
    const complet = costOf({ priceInPerM: 5, priceOutPerM: 15, priceCachedInPerM: 0.5 }, 1_000_000, 1_000_000, 500_000);
    attendre(complet === 17.75, `coût exact faux : ${complet} au lieu de 17.75 (remise cache comprise)`);
    const sansRemise = costOf({ priceInPerM: 5, priceOutPerM: 15 }, 1_000_000, 1_000_000, 500_000);
    attendre(sansRemise === 20, `sans tarif cache vérifié, le plein tarif s'applique (${sansRemise} au lieu de 20) — pas de remise inventée`);
    attendre(costOf({ priceInPerM: null, priceOutPerM: 15 }, 1_000, 1_000) === null,
      "un tarif manquant doit rendre null, jamais un total partiel");
    const porte = etatPorte();
    const binding = bindingFor("worker");
    return {
      mesures: {
        tarifsWorkerConfigures: binding.priceInPerM != null && binding.priceOutPerM != null,
        coutCumuleUsd: porte.conso.appelsSansPrix > 0 ? null : Math.round(porte.conso.coutUsd * 10_000) / 10_000,
        appelsSansPrix: porte.conso.appelsSansPrix,
        appelsComptes: porte.conso.appels,
      },
      preuve: `costOf : exact avec remise cache vérifiée (17.75), plein tarif sans elle (20), null dès qu'un tarif manque ; cumul du run : ${porte.conso.appelsSansPrix > 0 ? `INCONNU (${porte.conso.appelsSansPrix} appel(s) sans tarif — dit, pas maquillé)` : `$${porte.conso.coutUsd.toFixed(4)} sur ${porte.conso.appels} appel(s)`}.`,
    };
  });
}
