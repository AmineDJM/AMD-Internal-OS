import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission, replanifierMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { decider } from "@/lib/missions/approval/gate";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { vueMission } from "@/lib/missions/view/workspace";
import { recordEvent } from "@/lib/events/ledger";
import type { ArtifactSink } from "@/lib/missions/artifacts/build";
import { controlerClasseur } from "@/lib/missions/artifacts/verify";
import { parserSpec } from "@/lib/missions/artifacts/spec";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DE BOUT EN BOUT — une PHRASE de la personne devient un programme qui s'exécute.
 *
 * ── CE QUI TOURNE POUR DE VRAI ICI ──────────────────────────────────────────────────────
 *
 * Le point d'entrée est `lancerMission`, celui-là même que l'outil `run_mission` appelle quand
 * Adam décide de déléguer. En dessous : le résolveur de capacités, la composition du contexte,
 * le schéma strict, la RECONSTRUCTION du plan, le compilateur, l'écriture en base, l'accord, le
 * moteur, l'éventail, l'exécution des capacités par le chemin canonique (RBAC, intent, reçu,
 * idempotence), le contrôle qualité arithmétique, le juge d'objectif et la fabrique d'artefacts.
 *
 * ── CE QUI EST SUBSTITUÉ, ET CE QUE ÇA COÛTE EN HONNÊTETÉ ──────────────────────────────
 *
 * La traversée du réseau vers le fournisseur de modèle, et rien d'autre. Le substitut VÉRIFIE
 * chacune de ses réponses contre le schéma réellement demandé, avec le code de production : une
 * réponse qu'un fournisseur en mode strict n'aurait pas pu produire fait ÉCHOUER le banc.
 *
 * Ce que ce banc ne prouve donc PAS : qu'un vrai modèle produirait CE plan-là. Cette question
 * n'a de réponse qu'avec une clé de fournisseur — `scripts/openai-live.ts`. Tant qu'elle n'en a
 * pas, l'état honnête du produit est « chaîne prouvée, modèle NON PROUVÉ EN LIGNE ».
 *
 * ── POURQUOI CINQ SALARIÉS ET NON TRENTE-TROIS ─────────────────────────────────────────
 *
 * Parce que la structure est identique et que le temps ne l'est pas. Le banc de charge (§46)
 * vit dans `evals/bench.test.ts` et compte, lui, des centaines d'étapes. Ici on vérifie le
 * CHEMIN ; là-bas on vérifie le VOLUME.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__e2e${Date.now()}`;
const SALARIES = ["Alla Atmani", "Redouane Belkacem", "Radia Cherif", "Yacine Daoud", "Khaled Embarek"];

let pdg: CurrentUser;
let companyId = "";

/** Le fichier produit reste EN MÉMOIRE : le banc vérifie l'octet, pas le rangement au Drive. */
class DepotMemoire implements ArtifactSink {
  readonly fichiers: { fileName: string; data: Buffer; mime: string }[] = [];
  async deposer(input: { fileName: string; mime: string; data: Buffer }) {
    this.fichiers.push({ fileName: input.fileName, data: input.data, mime: input.mime });
    return { nodeId: `mem-${this.fichiers.length}` };
  }
}

suite("BOUT EN BOUT — d'une phrase à une mission terminée", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({
      data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) },
      select: { id: true },
    });
    companyId = c.id;

    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = {
      id: u.id, name: u.name, email: u.email, role: u.role,
      access: (await getAccess(u.id, u.role)) as EffectiveAccess,
      mustChangePassword: false,
    };

    // DE VRAIS SALARIÉS, avec de VRAIS comptes : `send_message` résout le destinataire par son
    // nom et écrit dans la vraie table de messagerie. Sans comptes, la résolution échouerait et
    // le banc mesurerait la résolution de noms, pas l'exécution de la mission.
    for (const [i, nom] of SALARIES.entries()) {
      const compte = await prisma.user.create({
        data: { name: nom, email: `${TAG}${i}@amd.dz`, passwordHash: "x", role: "SALES_USER" },
        select: { id: true },
      });
      await prisma.employee.create({
        data: {
          fullName: nom, email: `${TAG}${i}@amd.dz`, position: "Délégué",
          // UN DÉPARTEMENT PROPRE À CE BANC. `directory_list` lit TOUS les salariés actifs de la
          // base — y compris ceux qu'ont laissés d'autres suites. Sans ce périmètre, le banc
          // mesurerait la propreté de la base de test au lieu du comportement du runtime.
          department: `${TAG}-${i < 2 ? "Regulatory" : "Ventes"}`,
          isActive: true, companyId, userId: compte.id,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  /**
   * LE PLAN QUE LE PLANIFICATEUR REND — en forme BRUTE, celle que le fournisseur produit.
   *
   * Il n'est pas typé `MissionPlan` : c'est un objet conforme au JSON Schema, que le code doit
   * reconstruire. Les `null` explicites, les listes de champs et les valeurs d'énumérés sont
   * exactement ce qu'impose le mode strict.
   */
  const planBrut = (avecArtefact: boolean) => (planScripte({
    goal: "Écrire individuellement à chaque salarié actif sur la messagerie ERP, puis attendre les contrats de Redouane.",
    reasoningComplexity: "B",
    executionScale: "M",
    acceptanceCriteria: [
      "Chaque salarié actif a reçu SON message, jamais un message groupé.",
      "Aucun salarié n'a reçu deux messages.",
      ...(avecArtefact ? ["Un récapitulatif est produit et contrôlé."] : []),
    ],
    workstreams: [
      { id: "voeux", title: "Messages individuels", outcome: "Chaque salarié a reçu son message." },
      { id: "contrats", title: "Contrats RH", outcome: "Les contrats manquants sont reçus." },
    ],
    steps: [
      {
        key: "liste:salaries", title: "Lister les salariés actifs", workstream: "voeux",
        nodeType: "CAPABILITY", capability: "directory_list",
        inputs: [
          { key: "department", kind: "TEXT", value: TAG },
          { key: "limit", kind: "NUMBER", value: "50" },
        ],
        dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [],
        completionCondition: "La liste des salariés actifs est chargée.",
        reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
      },
      {
        key: "accord:envois", title: "Votre accord pour écrire à tout le monde", workstream: "voeux",
        nodeType: "APPROVAL", capability: null, inputs: [],
        dependsOn: ["liste:salaries"], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [],
        completionCondition: "L'accord est donné.",
        reasoningRequirement: "NONE", approvalRequirement: "NORMAL", maxAttempts: null,
      },
      {
        key: "message", title: "Message individuel", workstream: "voeux",
        nodeType: "CAPABILITY", capability: "send_message",
        inputs: [
          { key: "recipientName", kind: "TEXT", value: "{{salarie.nom}}" },
          { key: "body", kind: "TEXT", value: "Bonne année {{salarie.nom}} — service {{salarie.departement}}." },
        ],
        dependsOn: ["accord:envois"],
        forEachFrom: "liste:salaries", forEachPath: "salaries", forEachAs: "salarie",
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [],
        completionCondition: "Chaque salarié a son propre message.",
        reasoningRequirement: "NONE", approvalRequirement: "NORMAL", maxAttempts: null,
      },
      {
        key: "attente:contrats", title: "Attendre les contrats de Redouane", workstream: "contrats",
        nodeType: "WAIT_EVENT", capability: null, inputs: [],
        dependsOn: ["message"], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: "DOCUMENT_RECEIVED", waitFrom: "Redouane Belkacem", waitEntity: null,
        waitAsk: null, waitWithinDays: 5,
        outputFields: [],
        completionCondition: "Les contrats sont arrivés.",
        reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
      },
      ...(avecArtefact
        ? [{
            key: "recap", title: "Récapitulatif des envois", workstream: "voeux",
            nodeType: "ARTIFACT", capability: null,
            inputs: [{ key: "format", kind: "TEXT", value: "XLSX" }],
            dependsOn: ["attente:contrats"], forEachFrom: null, forEachPath: null, forEachAs: null,
            waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
            outputFields: [],
            completionCondition: "Le classeur existe et s'ouvre.",
            reasoningRequirement: "LIGHT", approvalRequirement: "NONE", maxAttempts: null,
          }]
        : []),
      {
        key: "controle", title: "Contrôle final", workstream: "voeux",
        nodeType: "QA", capability: null, inputs: [],
        dependsOn: avecArtefact ? ["recap"] : ["attente:contrats"],
        forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [],
        completionCondition: "Autant de messages que de salariés, un destinataire chacun.",
        reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
      },
    ],
    expectedArtifacts: avecArtefact
      ? [{ key: "recap", format: "XLSX", title: "Récapitulatif des envois", fromStep: "recap" }]
      : [],
    approvalStrategy: "BUNDLE",
    completionCriteria: "Un message abouti par salarié actif de la liste.",
    gaps: [],
    rationale: "Lire d'abord la liste, demander un seul accord, puis déployer un message par personne.",
  }));

  /**
   * LE VERDICT DU JUGE — et la vérification que le juge a VU ce qu'on lui demande de citer.
   *
   * Les preuves sont extraites du compte rendu REÇU, pas écrites d'avance. Si le runtime
   * n'envoyait au juge que le résumé arithmétique — ce qu'il faisait — il n'y aurait aucune clé
   * à extraire, la liste serait vide, `normaliser` ramènerait tout à NON_DÉMONTRÉ, et la mission
   * ne conclurait pas. Le banc tomberait, comme il doit.
   */
  const verdictSatisfait = (criteres: string[]) => (req: { prompt: string }) => {
    const clesVues = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
    return {
      satisfied: true,
      confidence: 0.9,
      criteria: criteres.map((c) => ({
        criterion: c, status: "SATISFAIT", evidenceRefs: clesVues.slice(0, 3),
      })),
      missing: [],
      contradictions: [],
      suggestedRecovery: null,
    };
  };

  it("§42/§50 — une PHRASE devient un DAG exécuté : accord, éventail, attente, contrôle, objectif", async () => {
    const criteres = planBrut(false).acceptanceCriteria;
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: planBrut(false) })),
      pour("mission.judge", (req) => ({ ok: true, data: verdictSatisfait(criteres)(req) })),
    ]);

    // ── LE POINT D'ENTRÉE RÉEL : une phrase, rien d'autre ────────────────────────────
    const r = await lancerMission(
      pdg,
      "Pour tous les salariés actifs, envoie individuellement à chacun un message de bonne année sur la messagerie ERP. Ne les mets jamais en copie.",
      { reasoner: cerveau, contexte: { contraintes: ["Jamais de copie : un message par personne."] } },
    );
    if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);

    // LE PLANIFICATEUR A ÉTÉ APPELÉ POUR DE VRAI, avec un contexte composé et un schéma strict.
    const demande = cerveau.demandes.find((d) => d.purpose === "mission.plan");
    expect(demande, "le planificateur n'a pas été appelé").toBeDefined();
    expect(demande!.prompt).toContain("CAPACITÉS DISPONIBLES");
    expect(demande!.prompt).toContain("Jamais de copie");
    expect(demande!.system).toContain("Un destinataire par étape d'envoi");
    // §3 : une FRACTION du catalogue, pas le catalogue.
    expect(r.metriques.plannerCapabilitiesExposed).toBeLessThan(r.metriques.capacitesAutorisees);
    expect(r.metriques.plannerContextTokens).toBeGreaterThan(0);
    expect(r.metriques.plannerSchemaTokens).toBeGreaterThan(0);

    // ── L'ACCORD BLOQUE : rien n'est parti ────────────────────────────────────────────
    expect(r.approbation, "une mission qui écrit à tout le monde doit demander un accord").not.toBeNull();
    let etat = await chargerEtat(r.missionId);
    expect(etat!.status).toBe("AWAITING_APPROVAL");
    expect(await messagesEnvoyes()).toBe(0);

    // ── L'HUMAIN ACCORDE, ET SEULEMENT ALORS ─────────────────────────────────────────
    expect(await decider(r.approbation!.id, "GRANTED", pdg.id)).toBe(true);
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    etat = await chargerEtat(r.missionId);
    const filles = etat!.steps.filter((s) => s.key.startsWith("message#"));
    expect(filles).toHaveLength(SALARIES.length);
    expect(filles.every((f) => f.status === "DONE"), "toutes les itérations doivent aboutir").toBe(true);

    // UN DESTINATAIRE PAR MESSAGE, ET AUCUN EN DOUBLE — la cardinalité, vérifiée en base.
    //
    // La messagerie de l'ERP passe par des CONVERSATIONS : un envoi individuel crée une
    // conversation DIRECTE à deux membres. Compter les conversations à deux membres et leurs
    // destinataires distincts est donc la mesure exacte de « chacun a reçu SON message ».
    const convs = await prisma.conversation.findMany({
      where: { createdById: pdg.id, type: "DIRECT" },
      select: { members: { select: { userId: true } }, messages: { select: { body: true } } },
    });
    expect(convs).toHaveLength(SALARIES.length);
    const destinataires = convs.flatMap((c) => c.members.map((m) => m.userId).filter((id) => id !== pdg.id));
    expect(new Set(destinataires).size, "chaque salarié doit avoir SON fil, et un seul").toBe(SALARIES.length);
    for (const c of convs) {
      expect(c.members, "un envoi individuel n'a JAMAIS trois membres").toHaveLength(2);
      expect(c.messages.length).toBe(1);
    }
    // La personnalisation vient des DONNÉES lues, pas d'une invention.
    const corps = convs.flatMap((c) => c.messages.map((m) => m.body));
    expect(corps.some((b) => b.includes("Alla Atmani") && b.includes("Regulatory"))).toBe(true);

    // LES CLÉS D'IDEMPOTENCE EXISTENT : c'est ce qui rend une reprise sûre.
    expect(filles.every((f) => Boolean(f.idempotencyKey)), "chaque envoi doit porter sa clé").toBe(true);
    const intents = await prisma.assistantActionIntent.findMany({
      where: { missionId: r.missionId },
      select: { status: true, idempotencyKey: true },
    });
    expect(intents).toHaveLength(SALARIES.length);
    expect(intents.every((i) => i.status === "EXECUTED" && Boolean(i.idempotencyKey))).toBe(true);

    // ── LA MISSION ATTEND UN ÉVÉNEMENT, ET NE CONCLUT PAS ────────────────────────────
    etat = await chargerEtat(r.missionId);
    expect(etat!.status).toBe("WAITING_EVENT");
    expect(etat!.steps.find((s) => s.key === "controle")!.status).not.toBe("DONE");

    // ── L'ÉVÉNEMENT ARRIVE — par le REGISTRE CANONIQUE, pas par un appel privé ───────
    // LE FAIT PASSE PAR LE REGISTRE CANONIQUE, avec sa VRAIE forme. Un objet approximatif
    // « accepté » par un `as never` produirait un événement de type `undefined` : la mission
    // ne se réveillerait pas, et le banc mesurerait un réveil qui n'a pas eu lieu.
    const fait = {
      type: "DOCUMENT_RECEIVED",
      sourceDomain: "DRIVE" as const,
      payload: { from: "Redouane Belkacem", documents: ["CDI-2026-014"] },
      missionId: r.missionId,
    };
    await recordEvent(fait);

    // ── §69 : LE MÊME WEBHOOK, DEUX FOIS ────────────────────────────────────────────
    //
    // Un fournisseur qui n'a pas reçu notre 200 renvoie. C'est la situation NORMALE, pas
    // l'exception, et elle doit être sans effet.
    //
    // DEUX GARDES INDÉPENDANTES le tiennent, et chacune suffit à elle seule : la file des
    // attentes ne rend que les étapes `WAITING`, et la mise à jour est conditionnée au même
    // état (`updateMany` puis `count !== 1`). C'est mesuré : retirer l'une OU l'autre laisse ce
    // cas vert, retirer les DEUX le fait passer à deux réveils. La redondance est voulue — le
    // second passage arrive par le réseau, à un instant qu'on ne choisit pas, et une course
    // entre deux webhooks simultanés ne serait arrêtée que par la condition en base.
    await recordEvent(fait);

    const reveils = await prisma.missionEvent.count({
      where: { missionId: r.missionId, kind: "EVENT_WAKE" },
    });
    expect(reveils, "un même fait reçu deux fois ne réveille qu'UNE fois").toBe(1);

    await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    etat = await chargerEtat(r.missionId);

    // ── LE CONTRÔLE PASSE, LE JUGE TRANCHE, LA MISSION CONCLUT ──────────────────────
    expect(etat!.steps.find((s) => s.key === "attente:contrats")!.status).toBe("DONE");
    expect(etat!.steps.find((s) => s.key === "controle")!.status).toBe("DONE");
    expect(etat!.status).toBe("COMPLETED");

    const mission = await prisma.mission.findUnique({
      where: { id: r.missionId },
      select: { qaPassed: true, goalSatisfied: true, goalVerdict: true },
    });
    expect(mission!.qaPassed).toBe(true);
    expect(mission!.goalSatisfied).toBe(true);

    // ── L'ÉCRAN DIT LA VÉRITÉ, SANS UN SEUL APPEL DE MODÈLE ─────────────────────────
    const avant = cerveau.demandes.length;
    const vue = await vueMission(r.missionId, pdg.id);
    expect(cerveau.demandes.length, "« où en es-tu ? » ne doit coûter aucun appel de modèle").toBe(avant);
    expect(vue!.avancement.faites).toBeGreaterThanOrEqual(SALARIES.length);
    expect(vue!.avancement.echouees).toBe(0);
    expect(vue!.enAttenteDeVous, "une mission terminée n'attend plus rien de personne").toBeNull();
    expect(vue!.etapes.every((e) => e.etat === "fait")).toBe(true);
  }, 300_000);

  it("§68 — le juge REFUSE : tout a tourné, la mission ne conclut PAS", async () => {
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: planBrut(false) })),
      pour("mission.judge", () => ({
        ok: true,
        data: {
          satisfied: true, // le modèle dit OUI, avec une confiance élevée…
          confidence: 0.95,
          // …sur TOUS les critères, et sans citer LA MOINDRE PREUVE.
          //
          // Les deux critères sont couverts À DESSEIN : s'il en manquait un, `normaliser`
          // l'ajouterait en NON_DÉMONTRÉ et le refus viendrait de LÀ — le test passerait au
          // vert en ne prouvant rien sur la règle de preuve. Une première version de ce banc
          // faisait exactement cela, et la sabotage de la règle ne la faisait pas tomber.
          criteria: planBrut(false).acceptanceCriteria.map((c) => ({
            criterion: c, status: "SATISFAIT", evidenceRefs: [],
          })),
          missing: [], contradictions: [], suggestedRecovery: null,
        },
      })),
    ]);

    const r = await lancerMission(pdg, "Envoie un message individuel à chaque salarié actif.", { reasoner: cerveau });
    if (!r.ok) throw new Error(r.error);
    await decider(r.approbation!.id, "GRANTED", pdg.id);
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    await recordEvent({
      type: "DOCUMENT_RECEIVED", sourceDomain: "DRIVE",
      payload: { from: "Redouane Belkacem" }, missionId: r.missionId,
    });
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    const etat = await chargerEtat(r.missionId);
    const mission = await prisma.mission.findUnique({
      where: { id: r.missionId }, select: { goalSatisfied: true, goalVerdict: true },
    });

    // TOUT A TOURNÉ — et la mission n'est PAS terminée. C'est l'invariant §10 de la doctrine.
    expect(etat!.steps.filter((s) => s.key.startsWith("message#")).every((s) => s.status === "DONE")).toBe(true);
    expect(etat!.status).not.toBe("COMPLETED");
    expect(mission!.goalSatisfied).toBe(false);
    expect(mission!.goalVerdict ?? "").toMatch(/sans preuve|NON atteint/i);
  }, 300_000);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * L'ÉCHEC D'UN PLAN ABANDONNÉ NE BLOQUE PAS LES SUIVANTS
   *
   * ── LE RUN QUI A PRODUIT CE TEST ─────────────────────────────────────────────────────
   *
   * Render, scénario RECOURS. Le plan v1 déploie un éventail sur la sortie d'une recherche qui
   * a répondu en TEXTE : l'étape échoue, tentatives épuisées. Le plan v2 contourne — Legal,
   * courriers, contenu des documents — et ses neuf étapes aboutissent. La mission revient
   * pourtant BLOCKED, replanifie deux fois de plus, et le juge d'objectif n'est JAMAIS atteint :
   * `QA / objectif — / —` dans le rapport.
   *
   * La cause tenait en une ligne : `chargerEtat` relit TOUTES les étapes, quelle que soit la
   * version de plan qui les a écrites, et `deduireEtat` comptait comme un échec courant une
   * étape qu'aucun plan ne portait plus. Trois plans successifs mouraient d'une erreur du
   * premier.
   *
   * ── CE QUE CE TEST VÉRIFIE, ET CE QU'IL REFUSE DE VÉRIFIER ───────────────────────────
   *
   * Il part de `lancerMission`, pas d'un état injecté à la main (§14). L'échec du plan v1 est
   * PROVOQUÉ par un vrai défaut — un éventail sur une sortie sans liste — et non écrit en base.
   * Et il vérifie les DEUX côtés : la mission conclut, ET l'étape en échec est toujours là,
   * avec son statut et son motif. Une correction qui effacerait l'échec passerait le premier
   * test et échouerait au second — c'est exactement ce qu'on veut interdire.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("§39 — un plan qui CONTOURNE un échec précédent atteint le juge, et l'échec reste au dossier", async () => {
    const CRITERE = "Le bilan est produit à partir de ce qui a pu être lu.";

    // ── PLAN v1 : un éventail sur une sortie qui n'a pas de liste ⇒ échec structurel ──
    const planV1 = planScripte({
      goal: "Retrouver le document le plus récent qui engage l'entreprise.",
      reasoningComplexity: "B",
      executionScale: "S",
      acceptanceCriteria: [CRITERE],
      workstreams: [],
      steps: [
        {
          key: "recherche", title: "Chercher les documents", workstream: null,
          nodeType: "WORKER", dependsOn: [],
          // Le worker rend une PHRASE. C'est le défaut réel : « Aucun fichier… » est une
          // réponse humainement juste et machinalement inexploitable.
          outputFields: [{ name: "constat", type: "string", description: "Ce que la recherche a donné." }],
          completionCondition: "La recherche a été menée.",
          reasoningRequirement: "NONE", maxAttempts: 1,
        },
        {
          key: "lecture", title: "Lire chaque document trouvé", workstream: null,
          nodeType: "CAPABILITY", capability: "directory_lookup",
          inputs: [{ key: "name", kind: "TEXT", value: "{{doc}}" }],
          dependsOn: ["recherche"],
          // L'ÉVENTAIL PORTE SUR UN CHEMIN QUI N'EXISTE PAS dans la sortie amont.
          forEach: { from: "recherche", path: "documents", as: "doc" },
          completionCondition: "Chaque document est lu.",
          approvalRequirement: "NONE", maxAttempts: 1,
        },
      ],
      expectedArtifacts: [], approvalStrategy: "BUNDLE",
      completionCriteria: "Le document le plus récent est nommé.", gaps: [],
      rationale: "Chercher, puis lire ce qui a été trouvé.",
    });

    // ── PLAN v2 : il ne reprend NI « recherche » NI « lecture » — il contourne ────────
    const planV2 = planScripte({
      goal: "Retrouver le document le plus récent qui engage l'entreprise.",
      reasoningComplexity: "B",
      executionScale: "S",
      acceptanceCriteria: [CRITERE],
      workstreams: [],
      // Le v2 CONTOURNE « recherche » et « lecture » — c'est ce qu'on teste — mais il va tout de
      // même chercher AILLEURS : le compilateur refuse un plan fait uniquement de travaux de
      // modèle, qui ne pourrait répondre que de mémoire. C'est aussi la bonne conduite ici.
      steps: [{
        key: "ailleurs", title: "Chercher la pièce dans l'annuaire", workstream: null,
        nodeType: "CAPABILITY", capability: "directory_lookup",
        inputs: [{ key: "name", kind: "TEXT", value: "Personne Inexistante" }],
        dependsOn: [],
        completionCondition: "L'annuaire a été consulté.",
        approvalRequirement: "NONE", maxAttempts: 1,
      }, {
        key: "bilan", title: "Restituer ce qui a pu être établi", workstream: null,
        nodeType: "WORKER", dependsOn: ["ailleurs"],
        outputFields: [{ name: "bilan", type: "string", description: "Ce qui a pu être établi." }],
        completionCondition: "Le bilan est écrit.",
        reasoningRequirement: "LIGHT", maxAttempts: 1,
      }],
      expectedArtifacts: [], approvalStrategy: "BUNDLE",
      completionCriteria: "Le bilan existe.", gaps: [],
      rationale: "La lecture n'a rien donné : on restitue ce qui est établi.",
    });

    const cerveau = new RaisonneurScripte([
      pour("mission.plan", (_req, appel) => ({ ok: true, data: appel === 1 ? planV1 : planV2 })),
      // Chaque worker a SON schéma strict : rendre les deux champs à tous ferait échouer le banc
      // sur « champ inattendu », et l'on mesurerait le décor au lieu du défaut visé.
      pour("mission.worker", (req) => ({
        ok: true,
        data: req.schemaName.includes("bilan")
          ? { bilan: "Rien de probant n'a pu être établi." }
          : { constat: "Aucun fichier ne correspond." },
      })),
      pour("mission.judge", (req) => ({ ok: true, data: verdictSatisfait([CRITERE])(req) })),
    ]);

    const r = await lancerMission(pdg, "Retrouve le document le plus récent qui engage l'entreprise.", { reasoner: cerveau });
    if (!r.ok) throw new Error(r.error);
    // Le moteur avance par TOURS : la lecture ne devient prête qu'une fois la recherche finie.
    // On le pousse jusqu'à ce qu'il n'ait plus rien à faire, comme le ferait l'ordonnanceur.
    for (let i = 0; i < 4; i++) await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    // L'ÉCHEC A BIEN EU LIEU — sinon le test ne prouverait rien de ce qu'il annonce.
    const avant = await chargerEtat(r.missionId);
    const echouee = avant!.steps.find((s) => s.key === "lecture");
    expect(echouee?.status, "l'éventail sur une sortie sans liste doit échouer").toBe("FAILED");

    // ── LE REPLAN, PAR LE CHEMIN CANONIQUE ───────────────────────────────────────────
    const reprise = await replanifierMission(pdg, r.missionId, { reasoner: cerveau });
    expect(reprise.replanifie, reprise.raison).toBe(true);
    for (let i = 0; i < 3; i++) await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    const apres = await chargerEtat(r.missionId);
    const mission = await prisma.mission.findUnique({
      where: { id: r.missionId }, select: { status: true, goalSatisfied: true },
    });

    // 1. LA MISSION CONCLUT. Avant ce lot, elle restait BLOCKED sans jamais voir le juge.
    expect(mission!.goalSatisfied, "le juge doit avoir été atteint et avoir tranché").toBe(true);
    expect(mission!.status).toBe("COMPLETED");

    // 2. L'ÉCHEC EST TOUJOURS AU DOSSIER — statut et motif intacts. C'est le contre-poids :
    //    une correction qui « nettoierait » l'historique passerait le point 1 et raterait celui-ci.
    const trace = apres!.steps.find((s) => s.key === "lecture");
    expect(trace?.status, "l'étape contournée garde son échec").toBe("FAILED");
    expect(trace?.error ?? "", "et son motif").not.toBe("");
    expect(trace?.contournee, "mais elle est marquée contournée").toBe(true);
  }, 300_000);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LES DEUX CRITÈRES QU'AUCUNE PROSE NE POUVAIT DÉMONTRER
   *
   * ── LES REFUS QUI ONT PRODUIT CE BANC ────────────────────────────────────────────────
   *
   * Render, deux scénarios, deux refus du juge sur des énoncés que la mission avait pourtant
   * honorés :
   *
   *   RECOURS         « Aucun message n'est envoyé et aucune donnée n'est modifiée »
   *                   → critère SANS PREUVE. La mission tournait sous plafond ANALYZE et
   *                     n'avait exécuté que des lectures. Le runtime le savait. Le juge, non.
   *
   *   PREUVE_ABSENCE  « établir qu'il n'existe rien sur cette molécule »
   *                   → la recherche à zéro résultat n'était pas citable comme preuve.
   *
   * Les deux missions ont ensuite brûlé des replanifications à faire RÉÉCRIRE EN PROSE, par un
   * modèle, un fait que le code détenait déjà.
   *
   * ── CE QUE CE BANC VÉRIFIE, ET POURQUOI IL PART DE `lancerMission` ───────────────────
   *
   * Il n'inspecte pas `compteRendu` en isolation — cela prouverait que la fonction sait écrire
   * une phrase, pas que le fait ARRIVE au juge. La chaîne complète est longue : le reçu est
   * fabriqué au moment de l'appel, écrit en base, relu par `chargerEtat`, porté par
   * `EtapeObservee`, rendu par `compteRendu`, puis mis dans le prompt. Rompre n'importe lequel
   * de ces six maillons rendrait la primitive muette sans rien casser d'autre — c'est le
   * scénario §14 exact. Le juge scripté LIT donc ce qu'il a réellement reçu.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("§20 — le juge REÇOIT l'attestation d'effets et les preuves négatives, depuis le vrai point d'entrée", async () => {
    const CRITERES = [
      "Aucun message n'est envoyé et aucune donnée n'est modifiée.",
      "L'absence d'élément sur le sujet est établie, sources consultées à l'appui.",
    ];

    const plan = planScripte({
      goal: "Vérifier s'il existe quoi que ce soit sur un sujet, sans rien modifier.",
      reasoningComplexity: "B", executionScale: "S",
      acceptanceCriteria: CRITERES, workstreams: [],
      steps: [{
        key: "recherche:annuaire", title: "Chercher dans l'annuaire", workstream: null,
        nodeType: "CAPABILITY", capability: "directory_lookup",
        // Un nom qui n'existe pas : la lecture aboutit et ne rend rien. C'est exactement la
        // situation de « Zorbamyxine-K7 » — un VIDE mesuré, pas un échec.
        inputs: [{ key: "name", kind: "TEXT", value: `${TAG}-personne-inexistante` }],
        dependsOn: [], forEach: null,
        completionCondition: "La recherche a été menée.",
        approvalRequirement: "NONE", maxAttempts: 1,
      }],
      expectedArtifacts: [], approvalStrategy: "BUNDLE",
      completionCriteria: "La recherche a été menée et rien n'a été modifié.",
      gaps: [], rationale: "Une lecture, et rien d'autre.",
    });

    /** Ce que le juge a REÇU. C'est là-dessus que porte tout le banc. */
    let vuParLeJuge = "";
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan })),
      pour("mission.judge", (req) => {
        vuParLeJuge = req.prompt;
        return { ok: true, data: verdictSatisfait(CRITERES)(req) };
      }),
    ]);

    const r = await lancerMission(
      pdg,
      "Vérifie s'il existe quoi que ce soit sur ce sujet. Ne contacte personne et ne modifie rien.",
      { reasoner: cerveau, lectureSeule: true },
    );
    if (!r.ok) throw new Error(r.error);
    for (let i = 0; i < 3; i++) await avancerMission(pdg, r.missionId, { reasoner: cerveau, lectureSeule: true });

    // ── 1. L'ATTESTATION D'EFFETS EST ARRIVÉE, avec le plafond ────────────────────────
    //
    // Sans elle, « aucune donnée n'est modifiée » ne peut être que CRU. Avec elle, il est
    // constaté — et le plafond distingue « rien écrit » de « rien permis ».
    expect(vuParLeJuge, "le juge doit avoir été appelé").not.toBe("");
    expect(vuParLeJuge).toContain("EFFETS RÉELLEMENT PRODUITS");
    expect(vuParLeJuge).toContain("AUCUNE écriture");
    // Le plafond rendu est l'effet le plus FORT que le catalogue laissait passer — `READ` ici,
    // parce qu'aucune capacité d'effet ANALYZE n'est ouverte sous lecture seule à cet acteur.
    // C'est plus restrictif que le plafond configuré, donc l'attestation est plus forte, pas
    // plus faible : on ne se donne jamais un mérite qu'on n'a pas.
    expect(vuParLeJuge).toMatch(/plafond de la mission : (READ|ANALYZE)/);

    // ── 2. LA PREUVE NÉGATIVE EST ARRIVÉE, avec sa requête ────────────────────────────
    //
    // La requête est ce qui rend le zéro opposable : « rien trouvé » sans dire quoi ne prouve
    // rien du tout.
    expect(vuParLeJuge).toContain("PREUVES NÉGATIVES");
    expect(vuParLeJuge).toContain("0 résultat");
    expect(vuParLeJuge).toContain(`${TAG}-personne-inexistante`);

    // ── 3. ET LE REÇU A SURVÉCU À LA BASE ─────────────────────────────────────────────
    const etat = await chargerEtat(r.missionId);
    const etape = etat!.steps.find((s) => s.key === "recherche:annuaire");
    expect(etape?.recu?.issue, "le reçu structuré doit être persisté et relu").toBe("VIDE");
    expect(etape?.recu?.resultCount).toBe(0);
    expect(etape?.recu?.effect).toBe("READ");
  }, 300_000);

  it("§21/§22 — un ARTEFACT est fabriqué, CONTRÔLÉ, puis rangé ; et il prouve l'achèvement", async () => {
    const criteres = planBrut(true).acceptanceCriteria;
    const depot = new DepotMemoire();
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: planBrut(true) })),
      pour("mission.judge", (req) => ({ ok: true, data: verdictSatisfait(criteres)(req) })),
      pour("mission.artifact", () => ({
        ok: true,
        data: {
          key: "recap", title: "Récapitulatif des envois", fileName: "Recap envois", format: "XLSX",
          summary: [{
            heading: "Synthèse",
            paragraphs: [`${SALARIES.length} messages individuels envoyés, un par salarié.`],
            bullets: ["Aucun envoi groupé", "Aucun doublon"],
          }],
          sheets: [{
            name: "Envois",
            columns: [
              { header: "Salarié", key: "salarie", type: "text" },
              { header: "Service", key: "service", type: "text" },
              { header: "Messages", key: "messages", type: "number" },
            ],
            rows: SALARIES.map((nom, i) => ({ values: [nom, i < 2 ? "Regulatory" : "Ventes", "1"] })),
            computed: [{ header: "Part", key: "part", calcul: "SHARE", args: ["messages"] }],
            totals: [{ column: "messages", agregat: "SUM" }],
            note: "Source : journal des envois de la mission.",
          }],
          charts: [{ sheet: "Envois", kind: "bar", title: "Messages par salarié", categories: "salarie", series: ["messages"] }],
          sources: ["Messagerie ERP"],
        },
      })),
    ]);

    const r = await lancerMission(pdg, "Écris à chaque salarié et fais-moi un récapitulatif Excel.", {
      reasoner: cerveau, sink: depot,
    });
    if (!r.ok) throw new Error(r.error);
    await decider(r.approbation!.id, "GRANTED", pdg.id);
    await avancerMission(pdg, r.missionId, { reasoner: cerveau, sink: depot });
    await recordEvent({
      type: "DOCUMENT_RECEIVED", sourceDomain: "DRIVE",
      payload: { from: "Redouane Belkacem" }, missionId: r.missionId,
    });
    await avancerMission(pdg, r.missionId, { reasoner: cerveau, sink: depot });

    // LE FICHIER EXISTE, IL EST RANGÉ, ET IL EST MARQUÉ VÉRIFIÉ.
    const artefact = await prisma.missionArtifact.findFirst({ where: { missionId: r.missionId } });
    expect(artefact, "aucun artefact enregistré").not.toBeNull();
    expect(artefact!.status).toBe("VERIFIED");
    expect(artefact!.byteSize).toBeGreaterThan(1000);
    expect(artefact!.driveNodeId).not.toBeNull();
    expect(depot.fichiers).toHaveLength(1);
    expect(depot.fichiers[0].fileName).toMatch(/\.xlsx$/);

    // ET IL S'OUVRE VRAIMENT : on RELIT les octets déposés, on ne croit pas le producteur.
    const spec = parserSpec(artefact!.spec as Record<string, unknown>);
    if ("error" in spec) throw new Error(spec.error);
    const controle = await controlerClasseur(depot.fichiers[0].data, spec);
    expect(controle.ok, controle.points.filter((p) => !p.ok).map((p) => p.detail).join(" ; ")).toBe(true);
    expect(controle.points.some((p) => p.nom === "graphiques" && p.ok)).toBe(true);
    expect(controle.points.some((p) => p.nom === "formules" && p.ok)).toBe(true);

    const etat = await chargerEtat(r.missionId);
    expect(etat!.status).toBe("COMPLETED");
  }, 300_000);

  it("§102 — une réponse IMPOSSIBLE du modèle fait échouer le banc, elle ne le fait pas passer", async () => {
    const cerveau = new RaisonneurScripte([
      // `reasoningComplexity: "Z"` n'existe pas dans l'énuméré du schéma. Un fournisseur en mode
      // strict ne peut PAS le produire. Si le banc l'acceptait, tous les scénarios ci-dessus ne
      // vaudraient rien : on pourrait faire réussir n'importe quoi en écrivant n'importe quoi.
      pour("mission.plan", () => ({ ok: true, data: { ...planBrut(false), reasoningComplexity: "Z" } })),
    ]);

    await expect(
      lancerMission(pdg, "Écris à chaque salarié.", { reasoner: cerveau }),
    ).rejects.toThrow(/IMPOSSIBLE|hors des valeurs permises/);
  }, 120_000);
});

/** Combien de messages ce compte a-t-il réellement envoyés — lu en base, jamais compté à part. */
async function messagesEnvoyes(): Promise<number> {
  return prisma.message.count({ where: { sender: { email: { startsWith: TAG } } } });
}

