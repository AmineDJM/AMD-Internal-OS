import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Reasoner } from "@/lib/missions/ports";
import type { StepContext, StepOutcome } from "@/lib/missions/runtime/engine";
import { journaliser } from "@/lib/missions/runtime/store";
import { nomFichier, parserSpec, type ArtefactSpec } from "@/lib/missions/artifacts/spec";
import { rendre } from "@/lib/missions/artifacts/render";
import {
  controlerClasseur, ouvrirEtControler, type ControleArtefact,
} from "@/lib/missions/artifacts/verify";
import { SCHEMA_ARTEFACT } from "@/lib/missions/artifacts/schema";
import { rolePourEtape } from "@/lib/missions/model/roles";
import { amontDeLEtape } from "@/lib/missions/runtime/worker";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉTAPE QUI FABRIQUE UN FICHIER (§22) — et la seule qui puisse servir de PREUVE.
 *
 * ── LA CHAÎNE COMPLÈTE, DANS L'ORDRE, ET AUCUN MAILLON N'EST FACULTATIF ─────────────────
 *
 *   spec → fabrication → CONTRÔLE → dépôt au Drive → enregistrement → aperçu dans l'écran
 *
 * Le contrôle est au milieu, et c'est délibéré : un fichier qui ne passe pas le contrôle n'est
 * PAS déposé. Déposer d'abord et contrôler ensuite laisserait dans le Drive de l'entreprise un
 * classeur cassé que quelqu'un finirait par envoyer.
 *
 * ── D'OÙ VIENT LA SPEC ──────────────────────────────────────────────────────────────────
 *
 * De deux endroits, et jamais d'ailleurs :
 *
 *   • les DONNÉES des étapes amont, quand elles portent déjà des lignes et des colonnes ;
 *   • un WORKER de mise en forme, quand il faut décider quelles colonnes et quel graphique.
 *
 * Dans les deux cas, ce sont les CHIFFRES des étapes amont qui remplissent les lignes. Un
 * modèle qui « écrirait les données » produirait un classeur plausible et faux — la faute la
 * plus coûteuse possible pour un fichier qu'on envoie à la direction.
 *
 * ── L'IDEMPOTENCE ───────────────────────────────────────────────────────────────────────
 *
 * `MissionArtifact` est unique sur (mission, clé). Une reprise REMPLACE le fichier au lieu d'en
 * empiler un second : trois reprises ne laissent pas trois « Analyse PCH.xlsx » dont personne ne
 * sait lequel fait foi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Où le fichier est rangé. Le seul point où le runtime touche au Drive — par un port. */
export interface ArtifactSink {
  deposer(input: {
    ownerId: string;
    fileName: string;
    mime: string;
    data: Buffer;
    /** Le dossier de destination, par son nom lisible. */
    folder: string;
    missionId: string;
  }): Promise<{ nodeId: string }>;
}

export interface ArtifactDeps {
  reasoner: Reasoner;
  sink?: ArtifactSink;
  /** Le dossier où déposer. Par défaut, celui des livrables de mission. */
  folder?: string;
}

export const DOSSIER_LIVRABLES = "Livrables de mission";

/** Combien de temps un livrable attend la base canonique d'un frère avant de composer la sienne. */
const ATTENTE_BASE_MS = 20_000;

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * LE GESTIONNAIRE D'ÉTAPE `ARTIFACT` — branché dans `StepHandlers.ARTIFACT`.
 */
export async function executerArtefact(ctx: StepContext, deps: ArtifactDeps): Promise<StepOutcome> {
  const { mission, step } = ctx;

  const spec = await composerSpec(ctx, deps);
  if ("error" in spec) {
    return { status: "FAILED", error: spec.error, errorKind: "ARTIFACT_SPEC_INVALID", retryable: spec.retryable };
  }

  // ── 1. FABRICATION ──────────────────────────────────────────────────────────────────
  let rendu;
  try {
    rendu = await rendre(spec);
  } catch (e) {
    return {
      status: "FAILED",
      error: `la fabrication du livrable a échoué : ${e instanceof Error ? e.message : "erreur"}`,
      errorKind: "ARTIFACT_BUILD_FAILED",
      retryable: true,
    };
  }

  const fichier = nomFichier(spec);
  const ligne = await prisma.missionArtifact.upsert({
    where: { missionId_key: { missionId: mission.id, key: spec.key } },
    create: {
      missionId: mission.id, stepId: step.id, key: spec.key, title: spec.title,
      format: spec.format, fileName: fichier, byteSize: rendu.buffer.length,
      sha256: sha(rendu.buffer), spec: spec as never, status: "BUILT", inputsHash: spec.inputsHash ?? null,
    },
    update: {
      stepId: step.id, title: spec.title, format: spec.format, fileName: fichier,
      byteSize: rendu.buffer.length, sha256: sha(rendu.buffer), spec: spec as never,
      status: "BUILT", driveNodeId: null, qaReport: undefined, inputsHash: spec.inputsHash ?? null,
    },
    select: { id: true },
  });

  /**
   * ── 2. CONTRÔLE — AVANT le dépôt, jamais après ─────────────────────────────────────
   *
   * DEUX contrôles pour un classeur, et ce n'est pas une redondance : `controlerClasseur`
   * confronte le fichier à la SPEC (les feuilles annoncées, le nombre de lignes, les totaux
   * recalculés depuis les données) ; `ouvrirEtControler` l'ouvre avec l'adaptateur et pose la
   * question du destinataire — s'ouvre-t-il, reste-t-il un « [à compléter] », une cellule en
   * `#REF!`. Aucun des deux ne voit ce que voit l'autre.
   */
  const controle = spec.format === "XLSX"
    ? fusionner(await controlerClasseur(rendu.buffer, spec), await ouvrirEtControler(rendu.buffer, spec.format, rendu.detail))
    : await ouvrirEtControler(rendu.buffer, spec.format, rendu.detail);

  if (!controle.ok) {
    await prisma.missionArtifact.update({
      where: { id: ligne.id },
      data: { status: "REJECTED", qaReport: { ...controle, detail: rendu.detail } as never },
    });
    const echecs = controle.points.filter((p) => !p.ok).map((p) => `${p.nom} : ${p.detail}`);
    return {
      status: "FAILED",
      error: `le livrable « ${spec.title} » n'a pas passé le contrôle — ${echecs.join(" ; ")}`,
      errorKind: "ARTIFACT_QA_FAILED",
      // REJOUABLE : le contrôle échoue souvent sur des données incomplètes en amont, qui
      // peuvent l'être moins au tour suivant. On ne DÉPOSE pas pour autant.
      retryable: true,
    };
  }

  // ── 3. DÉPÔT ────────────────────────────────────────────────────────────────────────
  let nodeId: string | null = null;
  if (deps.sink) {
    try {
      const r = await deps.sink.deposer({
        ownerId: mission.ownerId,
        fileName: fichier,
        mime: rendu.mime,
        data: rendu.buffer,
        folder: deps.folder ?? DOSSIER_LIVRABLES,
        missionId: mission.id,
      });
      nodeId = r.nodeId;
    } catch (e) {
      // LE DÉPÔT RATÉ N'EST PAS UNE FABRICATION RATÉE : le fichier existe, il est contrôlé, il
      // est enregistré. On échoue l'étape (le livrable n'est pas rangé), mais l'artefact reste
      // VERIFIED et une reprise ne le refabriquera pas pour rien.
      await prisma.missionArtifact.update({
        where: { id: ligne.id },
        data: { status: "VERIFIED", qaReport: { ...controle, detail: rendu.detail } as never },
      });
      return {
        status: "FAILED",
        error: `le livrable est fabriqué et contrôlé, mais son rangement au Drive a échoué : ${e instanceof Error ? e.message : "erreur"}`,
        errorKind: "ARTIFACT_STORE_FAILED",
        retryable: true,
      };
    }
  }

  await prisma.missionArtifact.update({
    where: { id: ligne.id },
    data: { status: "VERIFIED", driveNodeId: nodeId, qaReport: { ...controle, detail: rendu.detail } as never },
  });

  await journaliser(mission.id, "ARTIFACT",
    `Livrable « ${spec.title} » (${spec.format}, ${Math.round(rendu.buffer.length / 1024)} Ko) fabriqué et contrôlé.`,
    { key: spec.key, fileName: fichier, driveNodeId: nodeId, controles: controle.points.length });

  return {
    status: "DONE",
    receipt: ligne.id,
    result: {
      artifactId: ligne.id,
      key: spec.key,
      title: spec.title,
      format: spec.format,
      fileName: fichier,
      byteSize: rendu.buffer.length,
      driveNodeId: nodeId,
      controles: controle.points.length,
      ...rendu.detail,
    },
  };
}

type SpecOuErreur = ArtefactSpec | { error: string; retryable: boolean };

/**
 * COMPOSE LA SPEC — depuis l'entrée de l'étape, ou par un worker de mise en forme.
 *
 * Le chemin direct (l'entrée porte déjà `sheets`) existe pour les livrables dont la forme est
 * décidée par le plan : « exporte la liste des courriers non classés » n'a pas besoin qu'un
 * modèle décide des colonnes. Le chemin worker sert quand la mise en forme EST le travail —
 * « fais-moi l'analyse du marché », où choisir les colonnes est une décision.
 */
async function composerSpec(ctx: StepContext, deps: ArtifactDeps): Promise<SpecOuErreur> {
  const { mission, step } = ctx;
  const entree = step.input;

  if (Array.isArray(entree.sheets) || Array.isArray(entree.summary)) {
    const id = await identiteDuLivrable(mission, step, "XLSX");
    const s = parserSpec({ key: id.key, title: step.title, format: "XLSX", ...(id.fileName ? { fileName: id.fileName } : {}), ...entree });
    if ("error" in s) return { error: s.error, retryable: false };
    return s;
  }

  if (!deps.reasoner.configured()) {
    return {
      error: "aucune donnée de livrable dans l'étape et aucun fournisseur de modèle pour la composer",
      retryable: false,
    };
  }

  // LES DONNÉES VIENNENT DES ÉTAPES AMONT, et elles seules. Le worker de mise en forme reçoit
  // ces données et décide de la STRUCTURE ; il n'a rien d'autre à inventer. La lecture TRAVERSE
  // les jonctions (`amontDeLEtape`) : une jonction ne rend qu'un compteur, et un artefact qui
  // ne recevait que ce compteur produisait un classeur sans aucune feuille exploitable.
  const amont = amontDeLEtape(mission, step.dependsOn);
  if (Object.keys(amont).length === 0) {
    return {
      error: `l'étape « ${step.title} » doit produire un fichier mais ne dépend d'aucune étape qui produise des données`,
      retryable: false,
    };
  }

  const format = String(entree.format ?? step.spec?.artifactFormat ?? "XLSX").toUpperCase();
  const identite = await identiteDuLivrable(mission, step, format);

  // ── UNE BASE CANONIQUE PAR MISSION (#88, §118.65) ───────────────────────────────────
  //
  // Le classeur et le deck d'une même mission descendent des MÊMES étapes amont, et chacun
  // appelait le modèle de son côté. Deux appels, deux specs : l'un pouvait retenir douze lignes
  // et l'autre dix, l'un arrondir et l'autre non, les synthèses se contredire — et rien ne les
  // comparait, puisque chaque livrable est contrôlé SEUL. C'est « quatre fichiers qui
  // divergent » à l'intérieur d'une seule mission. Mesuré : 100 dans le classeur, 999 dans le
  // deck, les deux VERIFIED.
  //
  // ── POURQUOI ON RÉSERVE AVANT DE COMPOSER ───────────────────────────────────────────
  //
  // Une simple vérification « un frère a-t-il déjà composé ? » NE CONVERGE PAS : les deux
  // étapes deviennent prêtes au même battement, aucune ne voit la ligne de l'autre, et le test
  // passait une fois sur deux. Un test qui dépend de l'ordonnancement ne prouve rien.
  //
  // On RÉSERVE donc d'abord — une ligne PENDING, sans fichier, portant l'empreinte — et l'on
  // DÉSIGNE l'auteur de la base dans le MÊME geste, sous un verrou : voir `reserverEtDesigner`.
  // Une ligne réservée n'est jamais comptée comme un livrable produit : `goal/qa.ts` exige VERIFIED
  // et `byteSize > 0`, et une ligne REPRISE sur d'autres données repart à PENDING — ses octets sont
  // ceux de la version précédente.
  const empreinte = createHash("sha256").update(JSON.stringify(amont)).digest("hex");
  const auteur = await reserverEtDesigner({
    missionId: mission.id, stepId: step.id, cle: identite.key, titre: step.title,
    format, fileName: identite.fileName ?? "", empreinte,
  });
  if (auteur) {
    const repris = await attendreLaBase({ mission, step, cleAuteur: auteur, empreinte, format, identite });
    if (repris) return repris;
  }

  const res = await deps.reasoner.reason<Record<string, unknown>>({
    role: rolePourEtape(step.spec?.reasoningRequirement ?? "LIGHT"),
    schemaName: "artefact_spec",
    schema: SCHEMA_ARTEFACT,
    system:
      "Tu mets en forme un livrable d'entreprise à partir de DONNÉES déjà collectées.\n\n"
      + "RÈGLES\n"
      + "1. Toutes les valeurs des lignes viennent des données fournies. N'invente AUCUN chiffre, nom ou date.\n"
      + "2. Tu n'écris JAMAIS de formule Excel, et JAMAIS de ligne « TOTAL » dans `rows` : déclare `totals` et\n"
      + "   `computed`, le code écrira les formules justes. Une ligne de total écrite à la main est un chiffre\n"
      + "   mort — il ne se recalcule pas — et il sera comparé à la somme de tes lignes.\n"
      + "3. Les colonnes numériques portent le type `number`, `money` (DZD) ou `percent` — jamais `text`.\n"
      + "4. La synthèse commence par la réponse, pas par la méthode.\n"
      + "5. Écris en français.",
    prompt:
      `OBJECTIF DE LA MISSION : ${mission.objective}\n\n`
      + `LIVRABLE DEMANDÉ : ${step.title} (format ${format})\n`
      + (step.spec?.completionCondition ? `CE QUI FERA QU'IL EST BON : ${step.spec.completionCondition}\n` : "")
      + `\nDONNÉES DISPONIBLES :\n${JSON.stringify(amont).slice(0, 40_000)}`,
    maxOutputTokens: 12_000,
    purpose: "mission.artifact",
  });

  if (!res.ok || !res.data) {
    return { error: res.error ?? "la mise en forme du livrable n'a rien rendu d'exploitable", retryable: true };
  }

  const s = parserSpec({
    ...res.data,
    // L'IDENTITÉ D'UN LIVRABLE APPARTIENT AU CODE (§118.1), voir `cleDuLivrable`. Et un livrable
    // ACTUALISÉ est une nouvelle version du même fichier, jamais un second — voir `identiteDuLivrable`.
    key: identite.key,
    ...(identite.fileName ? { fileName: identite.fileName } : {}),
    format, inputsHash: empreinte,
  });
  if ("error" in s) return { error: s.error, retryable: true };

  // LA BASE EST PUBLIÉE DÈS QU'ELLE EXISTE, avant le rendu : c'est ce que les frères attendent.
  await prisma.missionArtifact.update({
    where: { missionId_key: { missionId: mission.id, key: s.key } },
    data: { spec: s as never, title: s.title, format: s.format, inputsHash: empreinte },
    select: { id: true },
  }).catch(sansBloquer("build.composerSpec.missionArtifact"));
  return s;
}

/** Une spec est une BASE pour des données si elle a été composée DEPUIS elles — et seulement alors. */
function estBasePour(spec: unknown, empreinte: string): spec is Record<string, unknown> {
  return !!spec && typeof spec === "object" && !Array.isArray(spec)
    && (spec as Record<string, unknown>).inputsHash === empreinte;
}

/** Ce que la désignation lit d'une ligne qui porte déjà ces données. */
export interface Porteur {
  key: string;
  format: string;
  spec: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * QUI COMPOSE LA BASE — règle PURE, appliquée sous le verrou de `reserverEtDesigner`.
 *
 * `porteurs` : les lignes qui portaient DÉJÀ ces données (même empreinte) AVANT la réservation de
 * `cle`. Rend `null` quand c'est à `cle` de composer, sinon la clé du livrable à reprendre.
 *
 *   1. LE FORMAT DOIT DIFFÉRER. Deux livrables de MÊME format sur les mêmes données sont deux
 *      découpages voulus (« un classeur par produit »), pas une duplication (§118.36) : ils ne
 *      se désignent jamais l'un l'autre, chacun compose le sien.
 *   2. UNE BASE DÉJÀ PUBLIÉE pour ces données fait foi — y compris pour une reprise de l'auteur :
 *      le suiveur l'a peut-être déjà rendue dans son format, et recomposer ferait deux contenus.
 *   3. SINON, LE PREMIER RÉSERVATAIRE COMPOSE, et qui le trouve en place le suit. « Premier » se lit
 *      sur `updatedAt` (la réservation le pose) et non sur `createdAt` : `createdAt` est posé par le
 *      client Prisma quand il construit la requête (mesuré : un paramètre de l'INSERT), et une
 *      ligne d'une version précédente, dont la clé est reprise, est « la plus ancienne » quel que
 *      soit l'ordre des réservations — c'est ce qui faisait deux auteurs.
 */
export function designerAuteur(porteurs: readonly Porteur[], cle: string, format: string, empreinte: string): string | null {
  const candidats = porteurs.filter((p) => p.key !== cle && p.format.toUpperCase() !== format.toUpperCase());
  const parCreation = [...candidats].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key));
  const base = parCreation.find((p) => estBasePour(p.spec, empreinte));
  if (base) return base.key;
  if (candidats.length === 0) return null;
  const parReservation = [...candidats].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.key.localeCompare(b.key));
  return parReservation[0].key;
}

/**
 * RÉSERVE LA PLACE DU LIVRABLE ET DÉSIGNE L'AUTEUR DE LA BASE — d'un seul geste, sous un verrou.
 *
 * ── LE DÉFAUT, MESURÉ PAR UN ENTRELACEMENT FORCÉ ────────────────────────────────────────
 *
 * Réserver (un `upsert`) puis désigner (« la ligne la plus ancienne ») étaient deux instructions
 * séparées. Deux frères pouvaient donc se désigner tous les deux : l'un lisait avant que la
 * réservation de l'autre soit visible et se croyait seul ; l'autre trouvait SA ligne « plus
 * ancienne » (une version précédente, ou un `createdAt` posé avant le commit) et se désignait
 * aussi. Deux appels de mise en forme, deux contenus — le défaut même de #88 — et
 * `canonique.test.ts` tombait sous la charge de la suite complète, trois fois en trois semaines.
 *
 * ── LE VERROU, ET POURQUOI CELUI-LÀ ─────────────────────────────────────────────────────
 *
 * Un verrou consultatif de TRANSACTION sur (mission, empreinte) : il ne sérialise que les
 * livrables d'une même mission bâtis sur les mêmes données — précisément ceux qui se disputent la
 * base — et rien d'autre. La lecture des porteurs et la réservation se font sous lui, et le commit
 * qui le relâche rend la réservation visible au suivant : chacun voit tous ceux qui l'ont précédé.
 * Une contrainte d'unicité (`INSERT … ON CONFLICT`) aurait demandé une colonne « auteur » au
 * schéma ; verrouiller la ligne de la mission aurait bloqué tout ce qui l'écrit ou s'y rattache
 * par clé étrangère (le journal, les transitions) le temps de la désignation. Une collision de
 * `hashtext` entre deux missions ne fait que sérialiser deux désignations : jamais un faux auteur.
 */
async function reserverEtDesigner(r: {
  missionId: string; stepId: string; cle: string; titre: string; format: string; fileName: string; empreinte: string;
}): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${r.missionId}), hashtext(${r.empreinte}))`;
    const porteurs = await tx.missionArtifact.findMany({
      where: { missionId: r.missionId, inputsHash: r.empreinte },
      select: { key: true, format: true, spec: true, createdAt: true, updatedAt: true },
    });
    // UNE LIGNE QUI CHANGE DE DONNÉES N'EST PLUS LE LIVRABLE QU'ELLE PORTAIT (vague « restes 2 »). La clé
    // d'un livrable se reprend d'une version à l'autre (`identiteDuLivrable`, #88) : la réservation ne changeait
    // que l'empreinte et laissait le statut VERIFIED et les octets de la version précédente. Si la
    // recomposition échouait ensuite pour de bon — le modèle en panne, un rendu impossible —, `goal/qa.ts`
    // comptait pour PRODUIT un fichier bâti sur les données d'AVANT : le faux succès parfait, sans une étape
    // verte de trop. Le statut repart donc à PENDING quand l'empreinte CHANGE — et seulement alors : sur les
    // MÊMES données, le livrable déjà vérifié reste le bon, et le reprendre ne le défait pas. L'écriture est
    // conditionnelle sur l'empreinte stockée (une empreinte absente compte pour une autre) : c'est la ligne
    // en base qui décide, jamais une lecture faite avant.
    await tx.missionArtifact.updateMany({
      where: { missionId: r.missionId, key: r.cle, OR: [{ inputsHash: null }, { inputsHash: { not: r.empreinte } }] },
      data: { status: "PENDING" },
    });
    await tx.missionArtifact.upsert({
      where: { missionId_key: { missionId: r.missionId, key: r.cle } },
      create: {
        missionId: r.missionId, stepId: r.stepId, key: r.cle, title: r.titre,
        format: r.format, fileName: r.fileName, status: "PENDING", inputsHash: r.empreinte,
      },
      update: { inputsHash: r.empreinte, stepId: r.stepId },
      select: { id: true },
    });
    return designerAuteur(porteurs, r.cle, r.format, r.empreinte);
  }, { maxWait: 15_000, timeout: 30_000 });
}

/**
 * ATTEND LA BASE CANONIQUE d'un livrable frère, puis la reprend dans CE format.
 *
 * L'attente est bornée et n'échoue jamais : si la base n'arrive pas — l'auteur a planté, ou il
 * met plus longtemps qu'un appel de modèle raisonnable — on rend `null` et l'appelant compose la
 * sienne. Bloquer une mission pour une COHÉRENCE serait payer plus cher que le défaut.
 */
async function attendreLaBase(args: {
  mission: StepContext["mission"];
  step: StepContext["step"];
  cleAuteur: string;
  empreinte: string;
  format: string;
  identite: { key: string; fileName?: string };
}): Promise<ArtefactSpec | null> {
  const { mission, step, cleAuteur, empreinte, format, identite } = args;
  const debut = Date.now();
  while (Date.now() - debut < ATTENTE_BASE_MS) {
    const auteur = await prisma.missionArtifact.findUnique({
      where: { missionId_key: { missionId: mission.id, key: cleAuteur } },
      select: { spec: true, format: true, fileName: true },
    });
    const brut = auteur?.spec;
    // UNE SPEC NON VIDE N'EST PAS UNE BASE : il faut qu'elle ait été composée DEPUIS ces données.
    // La ligne de l'auteur garde la spec de sa version précédente tant qu'il n'a pas publié la
    // nouvelle (la réservation ne touche pas à la spec) — la reprendre mettrait les chiffres
    // d'avant dans ce livrable, et `parserSpec` les re-tamponnerait de l'empreinte du jour.
    if (estBasePour(brut, empreinte)) {
      const s = parserSpec({
        ...(brut as Record<string, unknown>),
        key: identite.key,
        ...(identite.fileName ? { fileName: identite.fileName } : {}),
        format, inputsHash: empreinte,
      });
      // Une spec déjà validée se REPARSE sans surprise ; si elle ne passe plus, on ne bloque
      // pas le livrable — l'appelant compose la sienne.
      if ("error" in s) return null;
      // LA REPRISE EST DITE. Une économie silencieuse est indistinguable d'un bug le jour où
      // les deux fichiers devaient différer (§118.52).
      await journaliser(
        mission.id, "ARTIFACT_CANONIQUE",
        `Le livrable ${format} reprend le contenu du ${auteur!.format} « ${auteur!.fileName || cleAuteur} » : mêmes données amont, donc mêmes chiffres.`,
        { etape: step.key, format, depuis: auteur!.format, base: cleAuteur },
      ).catch(sansBloquer("build.attendreLaBase.journaliser"));
      return s;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN SEUL LIVRABLE PAR FORMAT ET PAR MISSION — versionné, jamais dédoublé (#88).
 *
 * ── LE DÉFAUT, LU DANS LE PLAN D'UN RUN RÉEL ────────────────────────────────────────────
 *
 * La chaîne humaine produit `artifact:excel-consolidation` (plan v1). Une réponse arrive après
 * coup, la mission REPLANIFIE, et le plan v2 écrit `artifact:excel-consolidation-maj`. Deux
 * clés, deux titres, donc deux noms de fichier : DEUX classeurs dans le Drive, sur le même
 * sujet, avec des chiffres différents. C'est exactement « quatre fichiers qui divergent » —
 * et la personne qui ouvre le mauvais lit des chiffres périmés sans le savoir.
 *
 * ── LA RÈGLE, ET SES DEUX GARDE-FOUS ────────────────────────────────────────────────────
 *
 * Un livrable actualisé est une nouvelle VERSION du même fichier. On reprend donc la clé ET le
 * nom de fichier du livrable existant : `depositBufferToDrive` versionne un fichier de même nom
 * dans le même dossier, la v1 reste ouvrable, et l'`upsert` sur `missionId_key` met à jour la
 * MÊME ligne du registre.
 *
 * Deux conditions, et elles suffisent à ne jamais fondre deux livrables distincts :
 *
 *   1. Le nouveau vient d'un plan PLUS RÉCENT. Deux classeurs voulus par la même personne
 *      (« un par produit ») sont planifiés dans le MÊME plan : ils gardent leurs deux clés.
 *   2. Le plan courant ne déclare qu'UN livrable de ce format. Si la replanification en veut
 *      deux, elle le dit, et on ne touche à rien.
 *
 * Sans l'une ou l'autre, on ne fait rien : ne pas fusionner coûte un fichier en trop ; fusionner
 * à tort ÉCRASE un livrable que personne ne réclamait — le sens de la prudence est clair.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function identiteDuLivrable(
  mission: { id: string; planMeta?: Record<string, unknown> },
  step: { id: string; key: string },
  format: string,
): Promise<{ key: string; fileName?: string }> {
  const cle = cleDuLivrable(mission, step);

  // Combien de livrables de CE format le plan courant annonce-t-il ? Deux ⇒ on ne fusionne pas.
  const liste = Array.isArray(mission.planMeta?.expectedArtifacts) ? mission.planMeta!.expectedArtifacts : [];
  const duFormat = (liste as unknown[]).filter((a) =>
    a && typeof a === "object" && !Array.isArray(a)
    && String((a as Record<string, unknown>).format ?? "").toUpperCase() === format.toUpperCase());
  if (duFormat.length > 1) return { key: cle };

  try {
    const courant = await prisma.missionStep.findUnique({ where: { id: step.id }, select: { planVersion: true } });
    if (!courant) return { key: cle };
    const anciens = await prisma.missionArtifact.findMany({
      where: { missionId: mission.id, format, key: { not: cle } },
      select: { key: true, fileName: true, step: { select: { planVersion: true } } },
      orderBy: { createdAt: "asc" },
    });
    const precedent = anciens.find((a) => (a.step?.planVersion ?? 0) < courant.planVersion);
    if (!precedent) return { key: cle };
    return { key: precedent.key, fileName: precedent.fileName ?? undefined };
  } catch {
    // Une lecture qui échoue ne doit pas empêcher de produire : on retombe sur la clé du plan.
    return { key: cle };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CLÉ D'UN LIVRABLE — décidée par le CODE, jamais par le modèle.
 *
 * ── LE DÉFAUT, MESURÉ SUR LA CHAÎNE HUMAINE LIVE ────────────────────────────────────────
 *
 * La clé s'écrivait `String(res.data.key || step.key)` : le modèle de mise en forme la
 * proposait. Une mission a produit DEUX livrables — un classeur et une présentation — sur le
 * même sujet. Les deux modèles ont dérivé leur clé du même titre :
 * `consolidation_nivolex_trastuzex`. L'`upsert` porte sur `missionId_key` : la seconde ligne a
 * ÉCRASÉ la première. Résultat en base : UNE ligne pour DEUX fichiers, au format du dernier
 * arrivé, et un PowerPoint de 74 Ko déposé dans le Drive dont le registre de la mission ne
 * savait plus rien. Aucune étape n'a échoué.
 *
 * Une clé est une IDENTITÉ de persistance : c'est une décision de COMMENT, pas de QUOI. Un
 * modèle qui la choisit peut, sans faute apparente, faire disparaître un livrable.
 *
 * ── ET ELLE DOIT ÊTRE CELLE QUE LE PLAN A ANNONCÉE ──────────────────────────────────────
 *
 * Le contrôle qualité compare les clés de `expectedArtifacts` aux lignes en base. Avec une clé
 * inventée, la comparaison échouait TOUJOURS — le contrôle ARTEFACTS ne pouvait pas passer,
 * même avec un seul livrable parfaitement produit. On prend donc la clé que le plan a liée à
 * CETTE étape (`fromStep`), et la clé d'étape sinon : unique par construction dans les deux cas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function cleDuLivrable(mission: { planMeta?: Record<string, unknown> }, step: { key: string }): string {
  const liste = Array.isArray(mission.planMeta?.expectedArtifacts) ? mission.planMeta!.expectedArtifacts : [];
  for (const a of liste as unknown[]) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const o = a as Record<string, unknown>;
    if (typeof o.fromStep === "string" && o.fromStep === step.key && typeof o.key === "string" && o.key.trim()) {
      return o.key;
    }
  }
  return step.key;
}

/**
 * LE CONTRÔLE DES FORMATS NON-CLASSEUR.
 *
 * Il est plus pauvre, et on le dit : on vérifie qu'un fichier existe, qu'il porte la SIGNATURE
 * de son format, et qu'il n'est pas ridiculement petit. On ne prétend pas relire un PPTX comme
 * on relit un classeur — le faire à moitié donnerait un faux sentiment de vérification.
 */

/**
 * RÉUNIT deux contrôles. Un point en échec chez l'un fait échouer l'ensemble : on ne compense
 * jamais un refus par une réussite ailleurs — c'est ainsi qu'un livrable faux passe.
 */
function fusionner(a: ControleArtefact, b: ControleArtefact): ControleArtefact {
  return {
    ok: a.ok && b.ok,
    points: [...a.points, ...b.points],
    nonVerifie: [...a.nonVerifie, ...b.nonVerifie],
    avertissements: [...(a.avertissements ?? []), ...(b.avertissements ?? [])],
  };
}
