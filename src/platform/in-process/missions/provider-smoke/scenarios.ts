/**
 * Smoke fournisseur — LES SCÉNARIOS : jeton unique de banc, préconditions d'absence (rien de ce
 * que le scénario créerait n'existe déjà) et catalogue des scénarios joués.
 */
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

export type Genre = "SATISFIABLE" | "PREUVE_ABSENCE" | "RECOURS";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LE JETON UNIQUE — ce qui empêche un run d'être contaminé par le précédent.
 *
 * ── LE DÉFAUT MESURÉ, ET IL SE NOURRISSAIT DE LUI-MÊME ─────────────────────────────────
 *
 * Le scénario PREUVE_ABSENCE portait un nom FIXE : « Zorbamyxine-K7 ». Deux runs ont écrit,
 * malgré le plafond de lecture, `Rapport_de_verification_Zorbamyxine-K7.xlsx` dans le Drive de
 * production. Le run suivant a cherché la molécule, TROUVÉ ces fichiers, et conclu qu'il
 * existait bien quelque chose à son sujet. Le banc mesurait donc sa propre trace.
 *
 * On ne supprime pas les fichiers de production pour autant : ils appartiennent au Drive de
 * l'entreprise, et un banc qui efface des fichiers pour se donner raison est pire que le défaut
 * qu'il corrige. On rend le scénario UNIQUE À CHAQUE RUN — ce qui, en prime, garde la trace des
 * anciens runs visible et diagnosticable.
 *
 * ── PAS `crypto`, ET C'EST UN CHOIX ────────────────────────────────────────────────────
 *
 * L'unicité demandée ici est celle d'un identifiant de banc, pas d'un secret : deux runs
 * successifs ne doivent pas se croiser. `Date.now()` en base 36 s'en charge à lui seul ; le
 * suffixe aléatoire couvre le cas de deux runs lancés dans la même milliseconde.
 */
export function jetonUnique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/**
 * CE QUE LA BASE DOIT CONTENIR — OU NE PAS CONTENIR — POUR QUE LE SCÉNARIO MESURE QUELQUE CHOSE.
 *
 * Une preuve d'absence dont la vérité terrain ne couvre qu'UNE source alors que l'énoncé en cite
 * quatre ne prouve rien : elle affirme « il n'y a pas de produit » là où la mission ira aussi
 * chercher un dossier, un marché et un document. Chaque source de l'énoncé est donc comptée.
 */
export interface Precondition {
  /** Ce scénario exige-t-il une vérité terrain vérifiable avant lancement ? */
  requise: boolean;
  /** `null` quand elle n'est pas requise — jamais `true` par défaut (§78). */
  satisfaite: boolean | null;
  /** Le compte MESURÉ de chaque source citée par l'énoncé. */
  sources: { source: string; compte: number }[];
  details: string;
}

export interface Scenario {
  /** Le trio historique porte les genres de `Genre` ; le Deep Smoke en apporte d'autres. */
  genre: string;
  /** La demande, en français, telle qu'une personne l'écrirait. Jamais un plan. */
  demande: string;
  /** Ce que la base garantit AVANT d'interroger le modèle — la vérité terrain. */
  verite: string;
  titre: string;
  /** Le jeton qui rend CE scénario propre à CE run, quand il en porte un. */
  jeton?: string;
  /** Vérifie la vérité terrain juste avant de lancer. Absente ⇒ rien à vérifier. */
  verifier?: () => Promise<Precondition>;
}

/**
 * LA PRÉCONDITION DE LA PREUVE D'ABSENCE — les quatre sources que l'énoncé nomme.
 *
 * L'énoncé demande « produit, dossier réglementaire, marché, document ». On compte donc les
 * quatre, et pas seulement `RegulatoryProduct` comme le faisait la vérité terrain d'origine.
 * Une seule source non nulle rend le scénario INVALIDE — pas la mission fausse : le BANC.
 */
export async function preconditionAbsence(jeton: string): Promise<Precondition> {
  const contient = { contains: jeton, mode: "insensitive" as const };
  const sources: { source: string; compte: number }[] = [
    {
      source: "RegulatoryProduct (dci / nom commercial / référence)",
      compte: await prisma.regulatoryProduct.count({
        where: { OR: [{ dci: contient }, { brandName: contient }, { reference: contient }] },
      }).catch(sansBloquer("provider-smoke.preconditionAbsence.regulatoryProduct", -1)),
    },
    {
      source: "RegulatoryDossier (titre / référence)",
      compte: await prisma.regulatoryDossier.count({
        where: { OR: [{ title: contient }, { reference: contient }] },
      }).catch(sansBloquer("provider-smoke.preconditionAbsence.regulatoryDossier", -1)),
    },
    {
      source: "DriveNode (nom de fichier ou de dossier)",
      compte: await prisma.driveNode.count({ where: { name: contient, isTrashed: false } }).catch(sansBloquer("provider-smoke.preconditionAbsence.driveNode", -1)),
    },
    {
      source: "Document (pièce jointe)",
      compte: await prisma.document.count({ where: { name: contient } }).catch(sansBloquer("provider-smoke.preconditionAbsence.document", -1)),
    },
  ];

  // -1 SIGNIFIE « NON MESURÉ », et ce n'est pas zéro (§78). Une source qu'on n'a pas pu compter
  // ne peut pas servir à affirmer une absence : la précondition tombe, et elle dit pourquoi.
  const nonMesurees = sources.filter((s) => s.compte < 0);
  const nonVides = sources.filter((s) => s.compte > 0);
  const satisfaite = nonMesurees.length === 0 && nonVides.length === 0;

  return {
    requise: true,
    satisfaite,
    sources,
    details: satisfaite
      ? `« ${jeton} » est absent des ${sources.length} sources que l'énoncé cite (toutes comptées à 0).`
      : [
        nonVides.length > 0
          ? `la base contient déjà « ${jeton} » : ${nonVides.map((s) => `${s.source} = ${s.compte}`).join(", ")}`
          : "",
        nonMesurees.length > 0
          ? `source(s) non mesurable(s) : ${nonMesurees.map((s) => s.source).join(", ")}`
          : "",
      ].filter(Boolean).join(" ; "),
  };
}

/**
 * CONSTRUIT LES TROIS DEMANDES À PARTIR DE CE QUI EXISTE (§ « satisfiable sans mensonge »).
 *
 * Aucune n'est écrite en dur. La vérité terrain est établie D'ABORD ; l'énoncé s'y adapte. Un
 * énoncé qui exigerait trois éléments là où il n'y en a qu'un mesurerait son propre présupposé.
 */
export async function scenarios(jeton: string = jetonUnique()): Promise<Scenario[]> {
  const out: Scenario[] = [];

  // ── A — SATISFIABLE ────────────────────────────────────────────────────────────────────
  //
  // On compte d'abord. La demande porte ensuite sur CE nombre : « les N dossiers en cours »
  // est vrai quel que soit N, y compris zéro — et à zéro le scénario devient B, honnêtement.
  const enCours = await prisma.regulatoryDossier.count({
    where: { status: { notIn: ["ARCHIVED", "ERROR"] } },
  }).catch(sansBloquer("provider-smoke.scenarios.regulatoryDossier", 0));
  const taches = await prisma.task.count({
    where: { status: { in: ["TODO", "IN_PROGRESS"] } },
  }).catch(sansBloquer("provider-smoke.scenarios.task", 0));

  if (enCours > 0) {
    out.push({
      genre: "SATISFIABLE",
      titre: `Dossiers réglementaires en cours (${enCours} en base)`,
      verite: `RegulatoryDossier WHERE status NOT IN (ARCHIVED,CANCELLED) = ${enCours}`,
      demande:
        "Fais le point sur les dossiers réglementaires en cours : liste-les avec leur statut, "
        + "et dis-moi lequel demande le plus d'attention et pourquoi. "
        + "Si une information manque pour trancher, dis-le explicitement. "
        + "Ne contacte personne et ne modifie rien.",
    });
  } else if (taches > 0) {
    out.push({
      genre: "SATISFIABLE",
      titre: `Tâches ouvertes (${taches} en base)`,
      verite: `Task WHERE status IN (TODO,IN_PROGRESS) = ${taches}`,
      demande:
        "Fais le point sur les tâches ouvertes : liste-les avec leur échéance, et dis-moi "
        + "laquelle demande le plus d'attention et pourquoi. Ne contacte personne et ne modifie rien.",
    });
  }

  // ── B — PREUVE D'ABSENCE ───────────────────────────────────────────────────────────────
  //
  // Le LIVRABLE est la démonstration d'absence, et l'énoncé le dit. Sans cela, le juge aurait
  // raison de refuser : on lui aurait demandé de conclure sur une chose introuvable.
  //
  // ── LE NOM PORTE LE JETON DU RUN, ET C'EST CE QUI REND LE SCÉNARIO HERMÉTIQUE ─────────
  //
  // « Zorbamyxine-K7 » était FIXE. Deux runs ont laissé des classeurs à ce nom dans le Drive de
  // production ; le troisième les a trouvés et a conclu que la molécule existait. Un suffixe
  // unique par run rend impossible qu'un run mesure la trace d'un autre — sans rien effacer.
  const molecule = `Zorbamyxine-K7-${jeton}`;
  out.push({
    genre: "PREUVE_ABSENCE",
    titre: `Une molécule qui n'existe pas — prouver l'absence (${molecule})`,
    jeton: molecule,
    verite: `« ${molecule} » absent de RegulatoryProduct, RegulatoryDossier, DriveNode et Document `
      + "(les QUATRE sources citées par l'énoncé, comptées avant l'appel)",
    verifier: () => preconditionAbsence(molecule),
    demande:
      `Vérifie si nous avons quoi que ce soit sur la molécule « ${molecule} » : produit, `
      + "dossier réglementaire, marché, document. L'objectif de cette mission est de TRANCHER "
      + "la question : soit tu trouves des éléments et tu les présentes, soit tu établis, "
      + "sources consultées à l'appui, qu'il n'existe rien à ce sujet — cette conclusion négative "
      + "documentée EST le résultat attendu et suffit à considérer la mission accomplie. "
      + "Ne contacte personne, ne modifie rien, et ne produis aucun fichier.",
  });

  // ── C — RECOURS ────────────────────────────────────────────────────────────────────────
  //
  // La demande vise délibérément une information dont la source la plus évidente est la moins
  // fournie. On ne SCRIPTE pas le recours — on crée les conditions et l'on regarde le journal
  // pour savoir s'il a réellement eu lieu. S'il n'a pas lieu, le rapport le dit.
  out.push({
    genre: "RECOURS",
    titre: "Une première piste insuffisante, une seconde à trouver",
    verite: "aucune vérité imposée — on observe si le moteur change de source (MissionEvent STEP_RECOVERY)",
    demande:
      "Retrouve le document contractuel le plus récent qui engage l'entreprise. Commence par le "
      + "Drive ; si tu n'y trouves pas de quoi conclure, va chercher dans les autres sources "
      + "disponibles avant de répondre. Dis-moi d'où vient l'information. "
      + "Ne contacte personne et ne modifie rien.",
  });

  return out;
}
