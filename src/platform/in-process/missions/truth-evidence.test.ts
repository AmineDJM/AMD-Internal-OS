import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission, replanifierMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import { EFFET_NOEUD, effetDuNoeud } from "@/lib/missions/registry/node-effect";
import { verifierContrat } from "@/lib/missions/registry/result-contract";
import { ERROR_KINDS } from "@/lib/missions/recovery/strategy";
import { ECHECS_CAPACITE, resultatIndisponible } from "@/platform/ia/lectures/capability-failure";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { executeReadTool } from "@/lib/assistant";
import { preconditionAbsence, jetonUnique, verdictLectureSeule } from "@/platform/in-process/missions/provider-smoke";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * VÉRITÉ, PREUVE, ET INTÉGRITÉ DU BANC — les dix non-régressions du lot.
 *
 * ── CE QUE CE FICHIER EXISTE POUR EMPÊCHER ──────────────────────────────────────────────
 *
 * Trois défauts observés sur des runs réels, tous de la même famille : **le système annonçait
 * une garantie qu'il ne tenait pas**, et rien ne tombait.
 *
 *   1. `read_document` rendait « Pièce introuvable ou sans fichier » et l'étape passait DONE.
 *      Le juge d'objectif recevait, comme preuve de lecture, une phrase disant qu'il n'y avait
 *      pas eu de lecture.
 *   2. `list_artifacts` retrouvait un livrable, `read_document` n'arrivait pas à le relire —
 *      parce que l'identité publiée (`artifact_id`) n'était acceptée par aucune porte de
 *      lecture, et que le `driveNodeId` n'existait que dans une chaîne d'URL.
 *   3. `READ_ONLY_EXECUTION PASS` s'affichait pendant que des classeurs XLSX partaient dans le
 *      Drive de production — et le run SUIVANT les trouvait, concluant que la molécule
 *      « inexistante » existait.
 *
 * ── POURQUOI ON PART DU VRAI POINT D'ENTRÉE (§14) ───────────────────────────────────────
 *
 * Les tests de garde partent de `lancerMission` / `replanifierMission` / `executeReadTool` —
 * jamais d'un état injecté à la main. Un test qui commence par écrire une étape en base ne
 * répond pas à la question « quelqu'un qui utilise Adam normalement peut-il déclencher cela ? ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__truth${Date.now()}`;
let pdg: CurrentUser;

/** Le squelette d'un plan : seules les étapes changent d'un cas à l'autre. */
const plan = (steps: Record<string, unknown>[], but = "Établir ce qui existe sur un sujet donné.") => planScripte({
  goal: but,
  reasoningComplexity: "B",
  executionScale: "S",
  acceptanceCriteria: ["Ce qui a pu être établi est dit, avec ses sources."],
  workstreams: [],
  steps,
  expectedArtifacts: [], approvalStrategy: "BUNDLE",
  completionCriteria: "La question est tranchée.", gaps: [],
  rationale: "Chercher, puis restituer.",
});

const LECTURE = {
  key: "lecture", title: "Consulter l'annuaire", workstream: null,
  nodeType: "CAPABILITY", capability: "directory_lookup",
  inputs: [{ key: "name", kind: "TEXT", value: "Personne Inexistante" }],
  dependsOn: [],
  completionCondition: "L'annuaire a été consulté.",
  approvalRequirement: "NONE", maxAttempts: 1,
};

const FABRIQUE = {
  key: "fichier", title: "Produire le rapport", workstream: null,
  nodeType: "ARTIFACT", dependsOn: [],
  completionCondition: "Le fichier est déposé.",
  approvalRequirement: "NONE", maxAttempts: 1,
};

suite("VÉRITÉ & PREUVE — les dix non-régressions du lot truth/evidence", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = {
      id: u.id, name: u.name, email: u.email, role: u.role,
      access: (await getAccess(u.id, u.role)) as EffectiveAccess,
      mustChangePassword: false,
    };
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.assistantArtifact.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // A à D — LE PLAFOND D'EFFET PORTE SUR L'ÉTAPE, PAS SUR LA CAPACITÉ
  // ═══════════════════════════════════════════════════════════════════════════════════════

  it("A — sous plafond ANALYZE, un nœud ARTIFACT ne peut même plus être GÉNÉRÉ", async () => {
    /**
     * ── LA GARDE A CHANGÉ D'ÉTAGE, ET C'EST UNE AMÉLIORATION MESURÉE ──────────────────
     *
     * Ce test attendait un refus du COMPILATEUR (FORBIDDEN_EFFECT). Un run réel a montré le
     * coût de cette garde tardive : deux appels de planification payés pour un plan
     * structurellement impossible, et une mission morte BLOCKED. Le plafond filtre désormais le
     * SCHÉMA : la variante ARTIFACT disparaît du `anyOf`, et un fournisseur en mode strict ne
     * peut plus produire l'étape. Le raisonneur scripté applique la même règle — il REFUSE
     * d'émettre une réponse qu'aucun fournisseur strict n'aurait pu rendre.
     *
     * Le compilateur garde son contrôle (compile.test.ts, « le plafond d'effet porte sur
     * l'ÉTAPE ») : il couvre les plans qui n'arrivent pas par ce schéma.
     */
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan([LECTURE, FABRIQUE]) })),
    ]);

    await expect(
      lancerMission(pdg, "Vérifie ce qu'on a sur ce sujet et fais-m'en un rapport.", {
        lectureSeule: true, demarrer: false, reasoner: cerveau,
      }),
      "le schéma sous plafond doit rendre l'étape ARTIFACT IMPOSSIBLE à générer",
    ).rejects.toThrow(/IMPOSSIBLE/);
  }, 120_000);

  it("A' — le schéma sous plafond retire EXACTEMENT les variantes au-dessus, et elles seules", async () => {
    const { schemaPlanPour } = await import("@/lib/missions/planner/schema");
    const types = (schema: Record<string, unknown>): string[] => {
      const props = (schema as { properties: { steps: { items: { anyOf: { properties: { nodeType: { const?: string; enum?: string[] } } }[] } } } }).properties;
      return props.steps.items.anyOf.flatMap((v) => v.properties.nodeType.const
        ? [v.properties.nodeType.const]
        : v.properties.nodeType.enum ?? []);
    };
    // Sans plafond : les huit types sont là.
    expect(types(schemaPlanPour(null))).toContain("ARTIFACT");
    // Sous ANALYZE : l'ARTIFACT (PREPARE) disparaît, le WORKER (ANALYZE) reste.
    const analyze = types(schemaPlanPour("ANALYZE"));
    expect(analyze).not.toContain("ARTIFACT");
    expect(analyze).toContain("WORKER");
    expect(analyze).toContain("CAPABILITY");
    // Sous READ : le WORKER tombe aussi — il appelle un modèle, c'est de l'ANALYZE.
    const read = types(schemaPlanPour("READ"));
    expect(read).not.toContain("WORKER");
    expect(read).toContain("CAPABILITY");
  });

  it("B — le MÊME plan, sans plafond, compile : c'est bien le plafond qui refuse, pas la forme", async () => {
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan([LECTURE, FABRIQUE]) })),
    ]);

    const r = await lancerMission(pdg, "Vérifie ce qu'on a sur ce sujet et fais-m'en un rapport.", {
      demarrer: false, reasoner: cerveau,
    });

    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  }, 120_000);

  it("C — une REPLANIFICATION ne regagne pas le droit d'écrire : le plafond suit la mission", async () => {
    /**
     * ── LE TROU QUE CE TEST FERME ────────────────────────────────────────────────────
     *
     * Le plafond était posé au LANCEMENT. Une mission bloquée qui replanifie repasse par un
     * SECOND appel au compilateur — et si `effetMax` ne voyage pas jusque-là, le plan v2
     * retrouve exactement les droits que le plan v1 s'était vu refuser. Une garde qui ne tient
     * qu'à la première compilation n'est pas une garde : c'est un ralentisseur.
     */
    const v1 = plan([{
      key: "impossible", title: "Lire un document introuvable", workstream: null,
      nodeType: "CAPABILITY", capability: "read_document",
      inputs: [{ key: "driveNodeId", kind: "TEXT", value: `${TAG}-node-qui-nexiste-pas` }],
      dependsOn: [],
      completionCondition: "Le document est lu.",
      approvalRequirement: "NONE", maxAttempts: 1,
    }]);
    const v2 = plan([FABRIQUE]);

    const cerveau = new RaisonneurScripte([
      pour("mission.plan", (_req, appel) => ({ ok: true, data: appel === 1 ? v1 : v2 })),
      pour("mission.judge", () => ({ ok: true, data: { satisfait: false, manquants: ["rien n'a pu être lu"], verdict: "Rien n'a pu être établi." } })),
    ]);

    const r = await lancerMission(pdg, "Lis ce document et fais-m'en un rapport.", {
      lectureSeule: true, reasoner: cerveau,
    });
    if (!r.ok) throw new Error(r.error);
    for (let i = 0; i < 3; i++) await avancerMission(pdg, r.missionId, { lectureSeule: true, reasoner: cerveau });

    /**
     * ── L'INVARIANT, PAS LA COUCHE ──────────────────────────────────────────────────────
     *
     * Deux gardes couvrent le replan : le SCHÉMA filtré (le raisonneur ne peut pas produire
     * l'étape — le banc lève « IMPOSSIBLE ») et le COMPILATEUR (FORBIDDEN_EFFECT, testé
     * unitairement dans compile.test.ts). Ce test-ci vérifie ce qui compte quel que soit
     * l'étage qui parle : après la tentative, AUCUN plan v2 portant un ARTIFACT n'existe en
     * base — le plafond a survécu au replan.
     */
    const tentative = await replanifierMission(pdg, r.missionId, { lectureSeule: true, reasoner: cerveau })
      .catch((e: unknown) => ({ replanifie: false as const, raison: e instanceof Error ? e.message : String(e) }));
    expect(tentative.replanifie, "le plan v2 fabrique un fichier : il ne doit JAMAIS être matérialisé").toBe(false);
    expect(tentative.raison ?? "").toMatch(/IMPOSSIBLE|plafond|FORBIDDEN_EFFECT|effet/i);

    const artefactsEnBase = await prisma.missionStep.count({
      where: { missionId: r.missionId, nodeType: "ARTIFACT" },
    });
    expect(artefactsEnBase, "aucune étape ARTIFACT ne doit exister dans une mission plafonnée").toBe(0);
  }, 180_000);

  it("C' — un replan refusé est RENVOYÉ au planificateur, et un plan qui ne fait rien est refusé", async () => {
    /**
     * ── DEUX DÉFAUTS DU MÊME RUN, UN SEUL CHEMIN ───────────────────────────────────────
     *
     * Run Render, scénario RECOURS : le replan v2 était UN SEUL nœud JOIN — un plan qui ne
     * produit rien, compilé, exécuté en zéro milliseconde, et le juge a relu le même dossier
     * pour rendre le même refus. Et quand un plan était refusé par le compilateur, le refus
     * n'était jamais RENVOYÉ au planner — `lancerMission` fait ce second essai depuis toujours,
     * la replanification non.
     *
     * Ici : v1 échoue (lecture introuvable) → replan. Le planner propose d'abord un JOIN seul
     * (appel 2) — refusé, AUCUNE étape ne produit quoi que ce soit — puis, NOURRI DU REFUS,
     * un WORKER qui établit le constat (appel 3) — accepté. Trois appels de plan comptés sur
     * l'instrument : ni deux (le refus aurait été jeté), ni un.
     */
    // Le v3 CHERCHE avant de conclure : le compilateur refuse un plan fait uniquement de travaux
    // de modèle (il ne pourrait répondre que de mémoire). C'est aussi le bon comportement métier
    // ici — la pièce demandée est introuvable, on regarde ailleurs AVANT d'établir le constat.
    const planV3 = plan([{ ...LECTURE, key: "ailleurs", title: "Chercher la pièce ailleurs" }, {
      key: "constat", title: "Établir le constat de ce qui a pu être lu", workstream: null,
      nodeType: "WORKER", dependsOn: ["ailleurs"],
      outputFields: [{ name: "constat", type: "string", description: "Ce qui a pu être établi." }],
      completionCondition: "Le constat est écrit.",
      reasoningRequirement: "LIGHT", maxAttempts: 1,
    }]);
    const joinSeul = plan([{
      key: "cloture", title: "Clôturer la restitution déjà réalisée", workstream: null,
      nodeType: "JOIN", dependsOn: [],
      completionCondition: "La restitution est close.",
    }]);
    const v1 = plan([{
      key: "lire", title: "Lire un document introuvable", workstream: null,
      nodeType: "CAPABILITY", capability: "read_document",
      inputs: [{ key: "driveNodeId", kind: "TEXT", value: `${TAG}-noeud-inexistant` }],
      dependsOn: [],
      completionCondition: "Le document est lu.",
      approvalRequirement: "NONE", maxAttempts: 1,
    }]);

    const cerveau = new RaisonneurScripte([
      pour("mission.plan", (_req, appel) => ({ ok: true, data: appel === 1 ? v1 : appel === 2 ? joinSeul : planV3 })),
      pour("mission.judge", () => ({ ok: true, data: { satisfait: false, manquants: ["rien n'a pu être lu"], verdict: "Rien d'établi." } })),
    ]);

    const r = await lancerMission(pdg, "Lis ce document et dis-moi ce qu'il contient.", { reasoner: cerveau });
    if (!r.ok) throw new Error(r.error);
    for (let i = 0; i < 3; i++) await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    const reprise = await replanifierMission(pdg, r.missionId, { reasoner: cerveau });
    expect(reprise.replanifie,
      `le second essai nourri du refus doit aboutir : ${reprise.replanifie ? "" : reprise.raison}`).toBe(true);
    expect(cerveau.appelsPour("mission.plan"),
      "3 appels : v1, JOIN seul refusé (plan sans étape productive), v3 corrigé").toBe(3);

    // Le plan matérialisé est bien le v3 — pas le JOIN qui ne faisait rien.
    const etapes = await prisma.missionStep.findMany({
      where: { missionId: r.missionId, supersededAt: null },
      select: { key: true, nodeType: true },
    });
    expect(etapes.some((e) => e.key === "constat" && e.nodeType === "WORKER")).toBe(true);
    expect(etapes.some((e) => e.key === "cloture")).toBe(false);
  }, 180_000);

  it("D — chaque type de nœud a un effet EXPLICITE : aucune porte « if (!capability) »", () => {
    // EXHAUSTIVITÉ PAR LE TYPE : ajouter un NodeType sans effet ne compile pas. Ce test-ci
    // vérifie les VALEURS, que le compilateur ne peut pas juger.
    expect(EFFET_NOEUD.ARTIFACT, "un ARTIFACT fabrique un fichier — c'est un effet").toBe("PREPARE");
    expect(EFFET_NOEUD.WORKER).toBe("ANALYZE");
    for (const structurel of ["JOIN", "QA", "APPROVAL", "WAIT_EVENT", "WAIT_INPUT"] as const) {
      expect(EFFET_NOEUD[structurel], `${structurel} ne produit rien d'observable`).toBe("READ");
    }
    // UN TYPE INCONNU N'EST PAS INOFFENSIF. Une ligne insérée en base à la main, un plan d'une
    // version antérieure : ne pas savoir ce qu'une étape produit ne la rend pas anodine.
    expect(effetDuNoeud("TYPE_QUI_NEXISTE_PAS")).toBe("EXTERNAL_COMMUNICATION");
    // Une capacité l'emporte toujours sur la table : c'est le REGISTRE qui sait.
    expect(effetDuNoeud("CAPABILITY", "DESTRUCTIVE")).toBe("DESTRUCTIVE");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // E & F — LE SUCCÈS SÉMANTIQUE, ET L'IDENTITÉ D'UN LIVRABLE
  // ═══════════════════════════════════════════════════════════════════════════════════════

  it("E — `read_document` sur une référence invalide n'est PAS DONE : l'étape échoue", async () => {
    /**
     * LE DÉFAUT EXACT, TEL QU'IL S'EST PRODUIT : le handler ne lève pas, rend une phrase, et
     * l'exécutant la range comme un résultat. Ici on part du VRAI point d'entrée et l'on vérifie
     * l'état RÉEL de l'étape en base.
     */
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({
        ok: true,
        data: plan([{
          key: "lire", title: "Lire le document", workstream: null,
          nodeType: "CAPABILITY", capability: "read_document",
          inputs: [{ key: "driveNodeId", kind: "TEXT", value: `${TAG}-inexistant` }],
          dependsOn: [],
          completionCondition: "Le document est lu.",
          approvalRequirement: "NONE", maxAttempts: 1,
        }]),
      })),
      pour("mission.judge", () => ({ ok: true, data: { satisfait: false, manquants: ["le document n'a pas pu être lu"], verdict: "Lecture impossible." } })),
    ]);

    const r = await lancerMission(pdg, "Lis ce document et dis-moi ce qu'il contient.", {
      lectureSeule: true, reasoner: cerveau,
    });
    if (!r.ok) throw new Error(r.error);
    for (let i = 0; i < 3; i++) await avancerMission(pdg, r.missionId, { lectureSeule: true, reasoner: cerveau });

    const etat = await chargerEtat(r.missionId);
    const etape = etat!.steps.find((s) => s.key === "lire");
    expect(etape?.status, "une lecture qui n'a rien lu ne peut pas être DONE").not.toBe("DONE");
    expect(etape?.status).toBe("FAILED");
    // LA CAUSE EST CELLE QUE LA CAPACITÉ A DÉCLARÉE — pas un « CAPABILITY_FAILURE » générique
    // obtenu en devinant : c'est elle qui choisit le barreau de recours.
    expect(etape?.errorKind).toBe("MISSING_DOCUMENT");
  }, 180_000);

  it("F — un livrable créé est RETROUVÉ puis RELU par son identité stable (créer → lister → lire)", async () => {
    const titre = `${TAG} Synthèse de vérification`;
    const cree = await executePowerTool("draft_deliverable", {
      title: titre,
      format: "DOCX",
      sections: [{ heading: "Synthèse", paragraphs: ["Le contenu vérifiable de cette synthèse."] }],
      sources: ["ERP — banc de non-régression"],
    }, pdg);
    const artefact = JSON.parse(cree!) as { artifact_id: string; fichiers: { driveNodeId: string }[] };

    // 1. CELUI QUI CRÉE PUBLIE L'IDENTITÉ. Sans cela, l'étape qui vient de fabriquer le document
    //    ne peut pas dire lequel elle a fabriqué.
    expect(artefact.artifact_id, "draft_deliverable doit publier l'artifact_id").toBeTruthy();
    expect(artefact.fichiers[0]?.driveNodeId, "le driveNodeId doit être un CHAMP, pas un fragment d'URL").toBeTruthy();

    // 2. LE REGISTRE REND LA MÊME IDENTITÉ.
    const liste = JSON.parse((await executePowerTool("list_artifacts", { query: TAG }, pdg))!) as {
      count: number;
      livrables: { artifact_id: string; fichiers: { driveNodeId: string }[] }[];
    };
    const trouve = liste.livrables.find((l) => l.artifact_id === artefact.artifact_id);
    expect(trouve, "list_artifacts doit retrouver EXACTEMENT l'artefact créé").toBeTruthy();
    expect(trouve!.fichiers[0]?.driveNodeId).toBe(artefact.fichiers[0]?.driveNodeId);

    // 3. LA LECTURE ACCEPTE CETTE IDENTITÉ — c'est le maillon qui manquait, et son absence
    //    faisait tomber l'identifiant dans `documentId`, où il ne correspondait à rien.
    const lu = await executeReadTool("read_document", { artifactId: artefact.artifact_id }, pdg);
    const contenu = JSON.parse(lu) as { texte?: string; echec?: string };
    expect(contenu.echec, `la lecture par artifactId ne doit pas échouer : ${lu.slice(0, 200)}`).toBeUndefined();
    expect(contenu.texte ?? "").toContain("contenu vérifiable");
  }, 180_000);

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // G à I — L'INTÉGRITÉ DU BANC : hermétique, détecteur de pollution, sans trace
  // ═══════════════════════════════════════════════════════════════════════════════════════

  it("G — la PREUVE D'ABSENCE part d'une base vierge, sur les QUATRE sources que l'énoncé cite", async () => {
    const p = await preconditionAbsence(`Zorbamyxine-K7-${jetonUnique()}`);
    expect(p.satisfaite, p.details).toBe(true);
    // QUATRE SOURCES, PAS UNE. « Ne teste jamais une absence avec une vérité terrain qui ne
    // couvre qu'une seule source alors que le prompt en demande plusieurs. »
    expect(p.sources.length).toBeGreaterThanOrEqual(4);
    expect(p.sources.every((s) => s.compte === 0), "toutes doivent être comptées à 0").toBe(true);
  }, 60_000);

  it("H — le banc DÉTECTE une précondition polluée et déclare SETUP_FAILED, sans rien effacer", async () => {
    const jeton = `Zorbamyxine-K7-${jetonUnique()}`;
    // On simule EXACTEMENT ce qu'un run précédent laissait derrière lui : un fichier au nom de
    // la molécule. On ne supprime aucun fichier de production — c'est le banc qui doit s'adapter.
    const pollution = await prisma.driveNode.create({
      data: { name: `${TAG} Rapport ${jeton}.xlsx`, type: "FILE", ownerId: pdg.id },
      select: { id: true },
    });
    try {
      const p = await preconditionAbsence(jeton);
      expect(p.satisfaite, "un Drive qui contient déjà la molécule invalide le scénario").toBe(false);
      expect(p.details).toContain("DriveNode");
      // LE COMPTE EST NOMMÉ : un « faux » sans le chiffre ne se diagnostique pas.
      expect(p.sources.find((s) => s.source.startsWith("DriveNode"))?.compte).toBe(1);
    } finally {
      await prisma.driveNode.delete({ where: { id: pollution.id } }).catch(() => {});
    }
  }, 60_000);

  it("I — une mission en LECTURE SEULE ne laisse AUCUN artefact derrière elle", async () => {
    const avant = await prisma.assistantArtifact.count({ where: { ownerId: pdg.id } });

    const cerveau = new RaisonneurScripte([
      // Le plan TENTE de fabriquer un fichier — c'est précisément ce que le run réel a fait.
      // Le schéma filtré rend l'étape impossible à générer : le lancement lève, et c'est bien —
      // l'invariant mesuré ici est MATÉRIEL : le compte d'artefacts en base ne bouge pas.
      pour("mission.plan", () => ({ ok: true, data: plan([LECTURE, FABRIQUE]) })),
    ]);
    const r = await lancerMission(pdg, `Vérifie si nous avons quoi que ce soit sur ${jetonUnique()} et documente-le.`, {
      lectureSeule: true, reasoner: cerveau,
    }).catch(() => ({ ok: false as const, error: "génération refusée par le schéma plafonné" }));
    if (r.ok) for (let i = 0; i < 3; i++) await avancerMission(pdg, r.missionId, { lectureSeule: true, reasoner: cerveau });

    const apres = await prisma.assistantArtifact.count({ where: { ownerId: pdg.id } });
    expect(apres, "sous plafond de lecture, le compte d'artefacts ne bouge pas").toBe(avant);
  }, 180_000);

  it("J — READ_ONLY_EXECUTION passe au ROUGE dès qu'un effet réel ou un artefact est observé", () => {
    const propre = { aTourne: true, effetExecute: "READ" as const, artefactsCrees: [] };
    expect(verdictLectureSeule(propre).etat).toBe("PASS");
    expect(verdictLectureSeule({ ...propre, effetExecute: "ANALYZE" }).etat).toBe("PASS");

    // UN EFFET RÉEL — PREPARE est déjà au-dessus du plafond : le fichier est fabriqué.
    expect(verdictLectureSeule({ ...propre, effetExecute: "PREPARE" }).etat).toBe("FAIL");
    expect(verdictLectureSeule({ ...propre, effetExecute: "INTERNAL_REVERSIBLE_WRITE" }).etat).toBe("FAIL");

    // UNE TRACE MATÉRIELLE, même si le journal du moteur ne montre rien : c'est le MONDE qui
    // a raison contre l'instrumentation, et c'est le cas qu'on veut attraper.
    const pollue = verdictLectureSeule({ ...propre, artefactsCrees: ["id|Rapport Zorbamyxine"] });
    expect(pollue.etat).toBe("FAIL");
    expect(pollue.raison).toContain("ARTEFACT");

    // NON MESURÉ N'EST PAS INOFFENSIF (§78).
    expect(verdictLectureSeule({ ...propre, effetExecute: null }).etat).toBe("FAIL");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SABOTAGES — chacun nomme la ligne qui, RETIRÉE, rouvre exactement un des trous ci-dessus.
 *
 * Un test qui passe ne prouve pas qu'une garde existe : il prouve que le cas testé ne se produit
 * pas aujourd'hui. Ces assertions-ci portent sur la GARDE elle-même, pour qu'un futur nettoyage
 * qui la supprime fasse tomber la suite en nommant ce qu'il vient de casser.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("SABOTAGES — ce qui retomberait si une garde disparaissait", () => {
  it("SABOTAGE 1 — retirer le contrat de `read_document` rouvre le faux DONE", () => {
    expect(
      capabilityMeta("read_document").contrat,
      "sans contrat CONTENU, une lecture qui ne lit rien redevient un succès",
    ).toBe("CONTENU");
    // Et le contrôle doit RÉELLEMENT refuser une réponse sans contenu.
    expect(verifierContrat("CONTENU", { nom: "x.pdf" }, true).etat).toBe("INCOMPATIBLE_RESULT");
  });

  it("SABOTAGE 2 — retirer la distinction structure/phrase rouvre le même trou par l'autre côté", () => {
    // LA PHRASE NUE, emballée par le transport en `{ texte }` : indiscernable d'un vrai contenu
    // SANS le drapeau `structure`. C'est ce drapeau qui porte toute la garde.
    const phrase = { texte: "Pièce introuvable ou sans fichier." };
    expect(verifierContrat("CONTENU", phrase, false).etat, "une phrase n'honore pas un contrat CONTENU").toBe("INCOMPATIBLE_RESULT");
    // Sans le drapeau, la même valeur passe — et c'est exactement l'état d'avant le lot.
    expect(verifierContrat("CONTENU", phrase, true).etat).toBe("SUCCESS");
    // On ne LIT jamais la phrase : une phrase sans le moindre mot-clé français est refusée pareil.
    expect(verifierContrat("CONTENU", { texte: "..." }, false).etat).toBe("INCOMPATIBLE_RESULT");
  });

  it("SABOTAGE 3 — dégrader l'effet d'un ARTIFACT ferait passer le test A", () => {
    expect(EFFET_NOEUD.ARTIFACT).not.toBe("READ");
    expect(EFFET_NOEUD.ARTIFACT).not.toBe("ANALYZE");
  });

  it("SABOTAGE 4 — ne plus regarder les artefacts créés ferait passer une exécution polluante", () => {
    const v = verdictLectureSeule({ aTourne: true, effetExecute: "READ", artefactsCrees: ["x|y"] });
    expect(v.etat, "un artefact créé suffit à faire tomber le verdict, à lui seul").toBe("FAIL");
  });

  it("SABOTAGE 5 — une cause d'échec inventée par une capacité ne doit pas exister", () => {
    // La liste locale d'Adam doit rester un SOUS-ENSEMBLE de la taxonomie §75 : sans cela, une
    // capacité déclarerait une cause qu'aucune échelle de recours ne sait traiter.
    for (const e of ECHECS_CAPACITE) {
      expect(ERROR_KINDS as readonly string[], `${e} doit exister dans la taxonomie du runtime`).toContain(e);
    }
    // Et la forme rendue reste lisible par un humain autant que par le runtime.
    const brut = JSON.parse(resultatIndisponible("MISSING_DOCUMENT", "Fichier introuvable dans le Drive."));
    expect(brut).toMatchObject({ echec: "MISSING_DOCUMENT", message: "Fichier introuvable dans le Drive." });
  });

  it("SABOTAGE 6 — une COLLECTION sans tableau dénombrable ne peut pas servir de preuve d'absence", () => {
    // Le cœur de `empty-result.ts` : zéro doit être MESURÉ, pas écrit en français.
    expect(verifierContrat("COLLECTION", { resultat: "personne introuvable" }, true).etat).toBe("INCOMPATIBLE_RESULT");
    expect(verifierContrat("COLLECTION", { items: [], count: 0, message: "Aucun." }, true).etat).toBe("SUCCESS");
    // Et une capacité SANS contrat déclaré n'est pas contrôlée — on ne vérifie pas une promesse
    // qui n'a pas été faite.
    expect(verifierContrat("LIBRE", { texte: "n'importe quoi" }, false).etat).toBe("SUCCESS");
  });
});
