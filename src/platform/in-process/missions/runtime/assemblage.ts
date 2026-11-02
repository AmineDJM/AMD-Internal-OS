/**
 * Composeur — L'ASSEMBLAGE : brancher sur le moteur les ports concrets (outils, modèles, Drive, QA,
 * fabrique, porte d'accord, juge) et le contrôle qualité arithmétique.
 */
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { CurrentUser } from "@/lib/session";
import { chargerEtat, journaliser } from "@/lib/missions/runtime/store";
import type { EngineDeps, StepContext, StepOutcome } from "@/lib/missions/runtime/engine";
import { executerWorker } from "@/lib/missions/runtime/worker";
import { executerArtefact } from "@/lib/missions/artifacts/build";
import { controleComplet } from "@/lib/missions/goal/qa";
import { ancetres } from "@/lib/missions/compiler/graph";
import { JugeReel } from "@/lib/missions/goal/judge";
import { porteApprobation } from "@/lib/missions/approval/gate";
import type { Reasoner } from "@/lib/missions/ports";
import type { ArtifactSink } from "@/lib/missions/artifacts/build";
import { catalogueDe } from "@/platform/in-process/missions/catalog";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { ExecutantReel } from "@/platform/in-process/missions/runner";
import { depotDrive } from "@/platform/in-process/missions/sink";
import { registreRecoursDe } from "@/platform/in-process/missions/recovery-registry";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";

export interface AssemblageMission {
  deps: EngineDeps;
  juge: JugeReel;
}

export interface OptionsAssemblage {
  complexite?: "A" | "B" | "C";
  /** Le raisonneur. Par défaut le VRAI, qui appelle la passerelle modèle. */
  reasoner?: Reasoner;
  /** Où déposer les livrables. Par défaut le Drive. */
  sink?: ArtifactSink;
  /**
   * LECTURE SEULE — le catalogue est plafonné à `ANALYZE` (§ `OptionsCatalogue.effetMax`).
   *
   * Aucune capacité qui écrit, communique, engage ou détruit n'entre dans la liste que le
   * planner voit et que le compilateur consulte. Ce n'est donc pas une consigne donnée au
   * modèle — qu'un document lu en cours de route pourrait contredire — mais l'ABSENCE de
   * l'outil. Le diagnostic fournisseur s'en sert pour prouver la chaîne sans rien toucher.
   *
   * PORTÉE : les TROIS chemins qui construisent un catalogue — `lancerMission` (planification),
   * `assembler` (exécution) et `replanifierMission` (nouveau plan).
   *
   * Le troisième a d'abord été laissé de côté, au motif que le diagnostic ne replanifiait pas.
   * Le premier run réel l'a démenti : une mission qui n'atteint pas son objectif passe par la
   * replanification canonique, et sans plafond ce nouveau plan repartirait du catalogue COMPLET.
   * Le trou n'était pas théorique — il s'ouvrait exactement là où la mission a le plus de
   * latitude. Une garantie qui s'arrête au premier plan n'est pas une garantie.
   */
  lectureSeule?: boolean;
  /**
   * LE LECTEUR DE L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — défaut : le VRAI, la ligne
   * `AppSetting.global`. Un banc l'injecte pour éprouver la suspension sans poser l'interrupteur
   * réel, partagé par tous les tests qui tournent en parallèle. La production ne le pose
   * JAMAIS ; un test de point d'appel le vérifie.
   */
  interrupteur?: LecteurInterrupteur;
}

/**
 * ASSEMBLE LE MOTEUR POUR UNE PERSONNE.
 *
 * L'acteur est l'AGENT (`isAgent: true`) et non la personne : c'est ce qui active l'interdit
 * structurel d'auto-escalade (`policy/guard.ts`). La personne reste l'initiatrice, et ses
 * droits restent la borne — l'agent ne peut jamais faire PLUS qu'elle, seulement moins.
 */
export function assembler(user: CurrentUser, opts: OptionsAssemblage = {}): AssemblageMission {
  const catalogue = catalogueDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {});
  const runner = new ExecutantReel(user);
  // LE RAISONNEUR EST INJECTABLE, et le défaut est le VRAI. Ce n'est pas une couture pour les
  // tests : c'est la seule dépendance du composeur qui traverse le réseau, donc la seule qu'un
  // banc d'essai puisse vouloir remplacer sans rien changer d'autre. Tout le reste — catalogue,
  // exécutant, dépôt, moteur, contrôle, juge — reste celui de la production, y compris sous test.
  const cerveau = opts.reasoner ?? raisonneur;
  const juge = new JugeReel(cerveau, opts.complexite ?? "B");

  const deps: EngineDeps = {
    runner,
    catalog: catalogue,
    juge,
    // L'INTERRUPTEUR GLOBAL — le moteur le relit à chaque tour ; absent, il lit le vrai.
    ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}),
    // CE QUI REND « ESSAIE AILLEURS » EXÉCUTABLE. Sans lui, le barreau `AUTRE_SOURCE` n'a
    // aucune capacité de remplacement à proposer et se saute — l'échelle descend alors vers ce
    // qui agit réellement, au lieu de rejouer le même appel sous un autre nom.
    registre: registreRecoursDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {}),
    // LA PORTE D'ATTENTION : c'est par elle que la conclusion, le blocage ou l'échec d'une
    // mission parviennent au dirigeant — niveau, cadence et canaux décidés par la politique.
    attention: porteAttentionPour(),
    handlers: {
      WORKER: (ctx) => executerWorker(ctx, { reasoner: cerveau }),
      QA: (ctx) => controleQualite(ctx),
      ARTIFACT: (ctx) => executerArtefact(ctx, { reasoner: cerveau, sink: opts.sink ?? depotDrive }),
      APPROVAL: porteApprobation(null, ""),
    },
  };
  return { deps, juge };
}

/**
 * LE NŒUD `QA` — arithmétique, bloquant, et qui NOMME ce qui cloche.
 *
 * Il rend `DONE` quand tout passe et `FAILED` sinon. Le `FAILED` est NON REJOUABLE à dessein :
 * relancer le contrôle sans avoir rien réparé donnerait le même résultat, et la mission
 * tournerait en rond en consommant ses tentatives. C'est la RÉPARATION des étapes manquantes
 * qui débloque, pas l'insistance sur le contrôle.
 */
async function controleQualite(ctx: StepContext): Promise<StepOutcome> {
  const etat = await chargerEtat(ctx.mission.id);
  if (!etat) return { status: "FAILED", error: "mission introuvable", errorKind: "INVALID_STEP", retryable: false };

  /**
   * LE NŒUD QA JUGE SES ANCÊTRES, PAS TOUTE LA MISSION.
   *
   * Il tourne AU MILIEU du graphe : ce qui vient après lui est PENDING par construction — y
   * compris les étapes qui dépendent de lui. Sans portée, il se reprochait son propre aval et
   * bloquait une mission dont tous les livrables étaient produits (mesuré : « 15/16 étapes
   * effectives abouties, 1 manquante » = « Informer Yacine », en aval du contrôle).
   *
   * Le contrôle de FIN de mission, lui, passe par `conclure` et regarde tout : c'est là que
   * « la mission est-elle finie ? » a un sens.
   */
  const portee = new Set([
    ...ancetres(etat.steps.map((s) => ({ key: s.key, dependsOn: s.dependsOn })), ctx.step.key),
    ctx.step.key,
  ]);
  const rapport = await controleComplet(etat, { portee });
  await journaliser(ctx.mission.id, "QA", rapport.resume, {
    stepKey: ctx.step.key,
    ok: rapport.ok,
    constats: rapport.constats.map((c) => ({ controle: c.controle, ok: c.ok, message: c.message })),
  });

  if (rapport.ok) return { status: "DONE", result: rapport };
  return {
    status: "FAILED",
    error: rapport.resume,
    errorKind: "QA_FAILED",
    retryable: false,
  };
}
