import { prisma } from "@/lib/prisma";
import { MISSION_STATUS_LABEL } from "@/lib/comms/missions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRAN D'UNE MISSION — construit par le SERVEUR, jamais rédigé par un modèle (§43-47).
 *
 * ── POURQUOI CE FICHIER N'APPELLE AUCUN MODÈLE ───────────────────────────────────────────
 *
 * « Où tu en es ? » est une question dont la réponse est EN BASE. La faire passer par un modèle
 * coûterait une seconde et demie, quelques milliers de jetons, et introduirait le risque qu'il
 * décrive un état qu'il aurait mal lu — pour restituer ce que le serveur savait déjà
 * exactement. La conversation reste vivante précisément parce qu'on ne paie pas ce prix-là.
 *
 * ── LE BLOC SE REMPLACE, IL NE S'EMPILE PAS (§43) ────────────────────────────────────────
 *
 * `blockId` est STABLE — c'est l'identifiant de la mission. L'élagage du fil, déjà en place, ne
 * garde d'un même `blockId` que la dernière occurrence : la mission se met donc à jour SUR
 * PLACE, au lieu de laisser une traînée de douze cartes décrivant douze instants successifs.
 *
 * ── CE QUE CE FICHIER NE CONNAÎT PAS ─────────────────────────────────────────────────────
 *
 * Le type `WorkspaceBlock` vit chez Adam ; l'importer ici inverserait les couches. On rend donc
 * un objet JSON ordinaire, dont la forme est exactement celle que le lecteur d'Adam accepte.
 * La frontière tient, et le contrat est vérifié par un test.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'état d'une étape, traduit pour l'écran. Le vocabulaire est celui du bloc « mission ». */
const ETAT_AFFICHE: Record<string, "fait" | "en-cours" | "a-faire" | "echec"> = {
  DONE: "fait",
  RUNNING: "en-cours",
  READY: "en-cours",
  WAITING: "en-cours",
  PENDING: "a-faire",
  FAILED: "echec",
  // Une étape SAUTÉE n'est ni faite ni ratée. On l'affiche « à faire » plutôt que « fait » :
  // marquer accompli ce qui n'a pas eu lieu est le mensonge le plus coûteux d'un tableau de bord.
  SKIPPED: "a-faire",
  CANCELLED: "a-faire",
};

/** Ce que l'écran montre d'une étape en attente — sans jargon de moteur. */
function detailEtape(s: {
  status: string; nodeType: string; errorKind: string | null;
  error: string | null; receipt: string | null; attempt: number; maxAttempts: number;
}): string | null {
  if (s.status === "WAITING") {
    if (s.nodeType === "APPROVAL") return "attend votre accord";
    if (s.nodeType === "WAIT_INPUT") return "attend un élément de votre part";
    if (s.nodeType === "WAIT_EVENT") return "attend un événement";
    return "attend ses étapes filles";
  }
  if (s.status === "FAILED") {
    const reste = s.maxAttempts - s.attempt;
    return reste > 0 ? `échec, ${reste} tentative(s) restante(s)` : "échec définitif";
  }
  if (s.status === "DONE" && s.receipt) {
    // LE REÇU EST MONTRÉ (§47) : c'est ce qui rend l'affirmation « c'est parti » vérifiable.
    return s.receipt === "DEDUPLIQUE" ? "déjà fait — non refait" : `reçu ${s.receipt}`;
  }
  return null;
}

export interface VueMission {
  kind: "mission";
  blockId: string;
  title: string;
  subtitle: string;
  /**
   * L'ÉTAT BRUT. `subtitle` en donne la version lisible ; celui-ci sert à DÉCIDER — quels boutons
   * proposer, et lesquels n'ont aucun sens. Faire déduire « peut-on reprendre ? » d'une phrase
   * française reviendrait à programmer contre un libellé, qui changera.
   */
  statut: string;
  etapes: {
    id: string;
    label: string;
    etat: "fait" | "en-cours" | "a-faire" | "echec";
    detail?: string;
    erreur?: string;
  }[];
  /** Les sous-missions, résumées. Repliées par défaut à l'écran (§45). */
  sousMissions: { id: string; titre: string; etat: string; avancement: string }[];
  /** Ce que la mission attend de l'humain, s'il y a lieu. */
  enAttenteDeVous: string | null;
  /**
   * LA MÊME ATTENTE, SOUS FORME ACTIONNABLE. `enAttenteDeVous` est une phrase à lire ; ceci est
   * ce qu'il faut pour RÉPONDRE — la clé d'étape, sans laquelle l'écran affiche « fournissez le
   * contrat » et n'a aucun moyen de transmettre le contrat.
   */
  attente: { stepKey: string; nodeType: "APPROVAL" | "WAIT_INPUT"; titre: string } | null;
  /**
   * LES LIVRABLES, avec l'état de leur CONTRÔLE (§21).
   *
   * `VERIFIED` et `BUILT` ne disent pas la même chose : le premier a été rouvert, relu, ses
   * formules recalculées ; le second a seulement été écrit. Montrer les deux pareil ferait
   * télécharger un classeur cassé avec la même confiance qu'un classeur vérifié.
   */
  livrables: {
    key: string; titre: string; format: string; statut: string;
    fichier: string; octets: number; driveNodeId: string | null;
    /**
     * CE QUE LE FICHIER CONTIENT VRAIMENT — « 3 paragraphes non vides », « 5 diapositives ».
     * Le contrôle l'écrit à la fabrication ; sans cette ligne il restait dans `qaReport`, lu
     * par personne (§118.50 : une donnée que rien n'affiche est du code mort).
     */
    contenu: string | null;
    /** Ce qui a été vu sans bloquer : une numérotation d'articles qui saute, une diapo chargée. */
    avertissements: string[];
    /** Ce qu'on n'a PAS pu vérifier — dit, jamais compté comme réussi (§34). */
    nonVerifie: string[];
    /** Le format se rend-il dans le workspace ? Décide entre l'ouvrir et le montrer au Drive. */
    ouvrable: boolean;
  }[];
  avancement: { faites: number; total: number; echouees: number };
  /** Combien d'étapes le plan courant a contournées — dites, jamais tues. */
  contournees: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * L'HORIZON — vide pour une mission courte, et c'est la bonne réponse.
   *
   * Sans lui, l'écran d'une mission longue ment par omission : il montre les étapes du jalon
   * COURANT et rien d'autre, donc « 4 étapes sur 5 » sur une mission qui en a six semaines
   * devant elle. La personne lit « presque fini » et se trompe complètement.
   *
   * `part` porte l'avancement RÉEL — sur les jalons, pas sur les étapes du sous-plan en cours.
   * `resultat` est ce qu'on doit pouvoir constater : c'est lui, et pas le titre, que le contrôle
   * de fin compare au réel (§118.10), donc c'est lui que l'écran doit montrer.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  horizon: {
    jalons: {
      ordre: number; titre: string; resultat: string;
      statut: string; etat: "fait" | "en-cours" | "a-faire" | "echec";
      /** Le sous-plan de ce jalon est-il écrit ? Faux = il n'existe encore que comme intention. */
      compile: boolean;
      etapes: number;
    }[];
    /** Combien de jalons FRANCHIS (aboutis ou écartés) sur ceux qui comptent. */
    part: number;
    /**
     * `franchis` est le numérateur de `part` — le chiffre à afficher à côté de la jauge, sinon
     * l'écran montre « 1/4 » sous une barre à 50 %. `aboutis` reste à part : un jalon ÉCARTÉ
     * est derrière nous, il n'a pas été accompli, et confondre les deux serait exactement le
     * mensonge qu'on refuse pour une étape SKIPPED.
     */
    franchis: number;
    aboutis: number;
    ecartes: number;
    total: number;
    bloques: number;
  } | null;
  /** La pause, quand il y en a une — depuis quand, pourquoi, et ce qu'elle a interrompu. */
  pause: { depuis: string; motif: string | null; interrompue: string | null } | null;
}

/** L'état d'un jalon, dans le même vocabulaire que celui d'une étape. */
const ETAT_JALON: Record<string, "fait" | "en-cours" | "a-faire" | "echec"> = {
  DONE: "fait",
  ACTIVE: "en-cours",
  PENDING: "a-faire",
  // ÉCARTÉ n'est pas FAIT : marquer accompli ce qui n'a pas eu lieu est le mensonge le plus
  // coûteux d'un tableau de bord — la même règle que pour une étape SKIPPED, plus haut.
  SKIPPED: "a-faire",
  CANCELLED: "a-faire",
  BLOCKED: "echec",
};

/**
 * LE PROPRIÉTAIRE D'UNE MISSION — pour la vue du SUPER ADMIN seulement (Direction, 02/11/2026 : il garde la vue globale).
 * L'appelant décide du droit (`peutPiloterMissionsAdam`) ; un employé ne passe JAMAIS par ici — sa lecture reste
 * filtrée par SON identifiant dans chaque `where`, et la mission d'un autre lui rend la même page qu'une absente.
 */
export async function proprietaireDeMission(missionId: string): Promise<string | null> {
  const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { ownerId: true } });
  return m?.ownerId ?? null;
}

/**
 * L'ÉTAT COMPLET D'UNE MISSION, prêt à afficher.
 *
 * ── LE REGROUPEMENT DES ÉVENTAILS ────────────────────────────────────────────────────────
 *
 * Trente-trois étapes filles ne produisent PAS trente-trois lignes : elles sont repliées sous
 * leur modèle, avec un compte. Un écran qui déroule trente-trois lignes identiques n'est pas
 * plus honnête — il est seulement illisible, et l'information « 31 sur 33 » y disparaît.
 */
export async function vueMission(missionId: string, ownerId: string): Promise<VueMission | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId },
    select: {
      id: true, title: true, status: true, goalVerdict: true, planVersion: true,
      steps: {
        /**
         * CE QUE LE PLAN COURANT A CONTOURNÉ N'EST PAS « À FAIRE ».
         *
         * Une étape `supersededAt` appartient à un plan périmé : le nouveau plan a tourné
         * autour. L'afficher « à faire » est le miroir exact du mensonge qu'on refuse plus
         * haut pour SKIPPED — annoncer en attente ce que plus personne n'a l'intention de
         * faire — et elle fausse le dénominateur, donc le ratio que la personne lit. Le
         * contrôle qualité du moteur les écarte déjà ; l'écran doit dire la même chose.
         */
        where: { supersededAt: null },
        select: {
          key: true, title: true, status: true, nodeType: true, receipt: true,
          error: true, errorKind: true, attempt: true, maxAttempts: true,
        },
        orderBy: [{ createdAt: "asc" }, { key: "asc" }],
      },
      _count: { select: { steps: { where: { supersededAt: { not: null } } } } },
      subMissions: {
        select: {
          id: true, title: true, status: true,
          steps: { select: { status: true } },
        },
      },
      artifacts: {
        select: {
          key: true, title: true, format: true, status: true,
          fileName: true, byteSize: true, driveNodeId: true, qaReport: true,
        },
        orderBy: { createdAt: "asc" },
      },
      milestones2: {
        select: {
          id: true, ordre: true, titre: true, resultat: true, statut: true, planVersion: true,
          steps: { select: { id: true } },
        },
        orderBy: { ordre: "asc" },
      },
      pausedAt: true, pausedReason: true, pausedFrom: true,
    },
  });
  if (!m) return null;

  const filles = new Map<string, typeof m.steps>();
  const principales: typeof m.steps = [];
  for (const s of m.steps) {
    const i = s.key.indexOf("#");
    if (i > 0) {
      const parent = s.key.slice(0, i);
      if (!filles.has(parent)) filles.set(parent, []);
      filles.get(parent)!.push(s);
    } else {
      principales.push(s);
    }
  }

  const etapes: VueMission["etapes"] = principales.map((s) => {
    const enfants = filles.get(s.key) ?? [];
    const detail = enfants.length > 0
      ? `${enfants.filter((e) => e.status === "DONE").length}/${enfants.length} effectuées`
      : detailEtape(s);
    return {
      id: s.key,
      label: s.title,
      etat: ETAT_AFFICHE[s.status] ?? "a-faire",
      ...(detail ? { detail } : {}),
      ...(s.error ? { erreur: s.error } : {}),
    };
  });

  // L'avancement compte les ÉTAPES RÉELLES : les filles d'un éventail, pas leur modèle. Compter
  // le modèle pour un donnerait « 2/2 » sur une mission de trente-trois envois dont deux ont raté.
  const reelles = m.steps.filter((s) => !filles.has(s.key));
  const faites = reelles.filter((s) => s.status === "DONE").length;
  const echouees = reelles.filter((s) => s.status === "FAILED").length;

  const attente = m.steps.find((s) => s.status === "WAITING" && (s.nodeType === "APPROVAL" || s.nodeType === "WAIT_INPUT"));

  /**
   * L'HORIZON, QUAND IL Y EN A UN — et le SOUS-TITRE qui en découle.
   *
   * Une mission longue affichée « 4/5 étapes » ment : ce sont les étapes du jalon COURANT.
   * Quand l'horizon existe, c'est LUI qui donne l'avancement, et les étapes deviennent le
   * détail du jalon en cours. Sans ce basculement, la personne lit « presque fini » sur une
   * mission qui a six semaines devant elle — et ce n'est pas un défaut d'affichage : c'est une
   * décision prise sur un chiffre faux.
   */
  const comptes = m.milestones2.length > 0 ? m.milestones2 : null;
  const annules = comptes?.filter((j) => j.statut === "CANCELLED").length ?? 0;
  const denominateur = comptes ? Math.max(0, comptes.length - annules) : 0;
  const jalonsAboutis = comptes?.filter((j) => j.statut === "DONE").length ?? 0;
  const jalonsEcartes = comptes?.filter((j) => j.statut === "SKIPPED").length ?? 0;
  const horizon: VueMission["horizon"] = comptes
    ? {
        jalons: comptes.map((j) => ({
          ordre: j.ordre, titre: j.titre, resultat: j.resultat, statut: j.statut,
          etat: ETAT_JALON[j.statut] ?? "a-faire",
          compile: j.planVersion > 0,
          etapes: j.steps.length,
        })),
        part: denominateur === 0 ? 0 : (jalonsAboutis + jalonsEcartes) / denominateur,
        franchis: jalonsAboutis + jalonsEcartes,
        aboutis: jalonsAboutis,
        ecartes: jalonsEcartes,
        total: comptes.length,
        bloques: comptes.filter((j) => j.statut === "BLOCKED").length,
      }
    : null;

  const sousTitre = horizon
    ? `${MISSION_STATUS_LABEL[m.status]} — jalon ${Math.min(jalonsAboutis + jalonsEcartes + 1, horizon.total)}/${horizon.total}`
      + (horizon.bloques > 0 ? `, ${horizon.bloques} bloqué(s)` : "")
      + (reelles.length > 0 ? ` · ${faites}/${reelles.length} étapes du jalon en cours` : "")
    : `${MISSION_STATUS_LABEL[m.status]} — ${faites}/${reelles.length} étapes`
      + (echouees > 0 ? `, ${echouees} en échec` : "")
      + (m.planVersion > 1 ? ` (plan v${m.planVersion})` : "");

  return {
    kind: "mission",
    horizon,
    pause: m.pausedAt
      ? { depuis: m.pausedAt.toISOString(), motif: m.pausedReason, interrompue: m.pausedFrom }
      : null,
    // L'IDENTIFIANT DE LA MISSION FAIT L'IDENTITÉ DU BLOC : c'est ce qui la met à jour sur place.
    blockId: `mission:${m.id}`,
    title: m.title,
    statut: m.status,
    subtitle: sousTitre,
    etapes,
    sousMissions: m.subMissions.map((sm) => ({
      id: sm.id,
      titre: sm.title,
      etat: MISSION_STATUS_LABEL[sm.status],
      avancement: `${sm.steps.filter((x) => x.status === "DONE").length}/${sm.steps.length}`,
    })),
    enAttenteDeVous: attente
      ? (attente.nodeType === "APPROVAL" ? `« ${attente.title} » attend votre accord` : `« ${attente.title} » attend un élément de votre part`)
      : null,
    attente: attente
      ? {
          stepKey: attente.key,
          nodeType: attente.nodeType === "APPROVAL" ? "APPROVAL" : "WAIT_INPUT",
          titre: attente.title,
        }
      : null,
    livrables: m.artifacts.map((a) => {
      const r = lireRapport(a.qaReport);
      return {
        key: a.key, titre: a.title, format: a.format, statut: a.status,
        fichier: a.fileName, octets: a.byteSize, driveNodeId: a.driveNodeId,
        contenu: r.contenu, avertissements: r.avertissements, nonVerifie: r.nonVerifie,
        ouvrable: FORMATS_RENDUS.has(a.format),
      };
    }),
    avancement: { faites, total: reelles.length, echouees },
    contournees: m._count.steps,
  };
}

/**
 * LES MISSIONS EN COURS D'UNE PERSONNE — la réponse à « où tu en es ? ».
 *
 * Bornée à cinq : au-delà, ce n'est plus un état, c'est une liste. Et une liste ne répond pas à
 * la question posée, qui porte sur ce qui est en train de se passer MAINTENANT.
 */
export async function missionsEnCours(ownerId: string, limite = 5) {
  const rows = await prisma.mission.findMany({
    where: {
      ownerId, kind: "RUNTIME",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    select: {
      id: true, title: true, status: true, updatedAt: true,
      // Même règle que `vueMission` : ce que le plan courant a contourné ne compte pas.
      steps: { where: { supersededAt: null }, select: { status: true, key: true } },
      milestones2: { select: { statut: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: limite,
  });

  return rows.map((m) => {
    const modeles = new Set(
      m.steps.filter((s) => s.key.includes("#")).map((s) => s.key.slice(0, s.key.indexOf("#"))),
    );
    const reelles = m.steps.filter((s) => !modeles.has(s.key));

    /**
     * SUR UNE MISSION LONGUE, LE RATIO D'ÉTAPES EST UN MENSONGE (§118.51).
     *
     * « 5/5 » y désigne les étapes du jalon COURANT — les suivants n'en ont pas encore, par
     * construction. Adam répondrait « c'est fini » à « où tu en es ? » sur une mission qui a
     * six jalons devant elle. Quand la mission a un horizon, c'est LUI qui compte, et le
     * dénominateur dit lequel des deux on lit.
     */
    const vivants = m.milestones2.filter((j) => j.statut !== "CANCELLED");
    const franchis = vivants.filter((j) => j.statut === "DONE" || j.statut === "SKIPPED").length;
    const parJalons = m.milestones2.length > 0;

    return {
      id: m.id,
      titre: m.title,
      etat: MISSION_STATUS_LABEL[m.status],
      faites: parJalons ? franchis : reelles.filter((s) => s.status === "DONE").length,
      total: parJalons ? m.milestones2.length : reelles.length,
      /** Ce que le ratio COMPTE — sans quoi « 2/7 » ne dit pas s'il parle d'étapes ou de jalons. */
      unite: parJalons ? ("jalons" as const) : ("étapes" as const),
      depuis: m.updatedAt,
    };
  });
}


/** Les formats que le Live Office sait OUVRIR et dessiner — les autres se voient au Drive. */
const FORMATS_RENDUS = new Set(["DOCX", "XLSX", "PPTX", "PDF"]);

/**
 * LE RAPPORT DE CONTRÔLE, tel qu'un écran peut le lire.
 *
 * `qaReport` est un JSON écrit par la fabrique. On n'en tire que ce qu'une personne veut savoir :
 * ce que le fichier CONTIENT, ce qui a été vu sans bloquer, ce qu'on n'a pas su vérifier. Un
 * rapport illisible ou d'une ancienne forme ne casse pas l'écran — il rend simplement moins.
 */
function lireRapport(brut: unknown): { contenu: string | null; avertissements: string[]; nonVerifie: string[] } {
  const vide = { contenu: null, avertissements: [] as string[], nonVerifie: [] as string[] };
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return vide;
  const o = brut as Record<string, unknown>;
  const textes = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  const points = Array.isArray(o.points) ? o.points : [];
  const contenu = points.find((p) =>
    p && typeof p === "object" && (p as Record<string, unknown>).nom === "contenu");
  const detail = contenu && typeof (contenu as Record<string, unknown>).detail === "string"
    ? String((contenu as Record<string, unknown>).detail)
    : null;
  return {
    // Le détail porte le résumé du modèle PUIS le JSON technique : on ne montre que le premier.
    contenu: detail ? detail.split(" — {")[0] : null,
    avertissements: textes(o.avertissements),
    nonVerifie: textes(o.nonVerifie),
  };
}
