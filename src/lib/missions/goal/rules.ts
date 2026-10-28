import type { EtapeObservee } from "@/lib/missions/goal/evaluate";
import { effetDuNoeud } from "@/lib/missions/registry/node-effect";
import { EFFECT_RANK, type Effect } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES — les critères d'acceptation que le CODE vérifie, reçus en main (chantier latence).
 *
 * ── LE COÛT QUE CE MODULE SUPPRIME ───────────────────────────────────────────────────────
 *
 * Un run réel a payé 8,9 s et 1 983 jetons pour qu'un juge LLM vérifie « les recherches ont
 * été exécutées avec la chaîne exacte X » et « aucune écriture n'a eu lieu » — deux énoncés
 * que les REÇUS STRUCTURÉS prouvent mieux qu'aucune prose : la requête partie et l'effet
 * déclaré y sont écrits par l'exécutant, pas affirmés par un modèle. Demander à un modèle de
 * relire un fait que le code détient est exactement ce que §5 interdit (models decide WHAT,
 * code does HOW).
 *
 * ── CE QUE CE MODULE N'EST PAS ───────────────────────────────────────────────────────────
 *
 * Ce n'est PAS la disparition du juge : c'est le juge devenu ARITHMÉTIQUE là où les critères
 * le sont. Un critère sémantique (« la synthèse répond à la question ») garde son juge LLM —
 * qui ne reçoit plus QUE ces critères-là. Et la doctrine ne bouge pas d'un cran : une mission
 * dont aucun critère n'est vérifiable ne conclut toujours pas ; l'arithmétique garde le
 * dernier mot dans le sens NÉGATIF (un seul FAIL refuse, sans appel) ; le sens POSITIF exige
 * que CHAQUE critère ait son vérificateur — règle prouvée ou juge sémantique, jamais
 * « toutes les étapes ont tourné ».
 *
 * ── LA GRAMMAIRE, STRICTE — le décodeur ne devine jamais ────────────────────────────────
 *
 * Un critère est une RÈGLE s'il commence par `[REGLE:CODE]` ou `[REGLE:CODE:args]`, avec un
 * CODE du registre ci-dessous. Tout le reste — y compris un `[REGLE:...]` au code inconnu —
 * est SÉMANTIQUE et va au juge : une règle mal orthographiée coûte un appel de juge, jamais
 * une conclusion fausse (doctrine `commands/nl.ts` : attraper ce qu'on comprend mal est pire
 * que ne rien attraper).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type VerificationRegle = {
  /** Le critère tel qu'il figure au plan — c'est lui que le verdict cite. */
  critere: string;
  code: string;
  verdict: "PASS" | "FAIL";
  /** La preuve (PASS) ou le manquement (FAIL), nommés — jamais « vérifié » tout court. */
  preuve: string;
};

export interface Partition {
  regles: VerificationRegle[];
  /** Les critères que seul un juge sémantique peut évaluer. */
  semantiques: string[];
}

const GRAMMAIRE = /^\[REGLE:([A-Z_]+)(?::([^\]]*))?\]\s*(.*)$/s;

const LECTURES: ReadonlySet<Effect> = new Set(["READ", "ANALYZE"] as Effect[]);

/** Le terme cité dans le texte du critère — la référence des règles à requête. */
const termeDuCritere = (texte: string): string | null => {
  const m = texte.match(/«\s*([^«»]+?)\s*»/);
  return m ? m[1].trim() : null;
};

type Verificateur = (args: string, texte: string, steps: readonly EtapeObservee[]) => Omit<VerificationRegle, "critere" | "code">;

/**
 * L'ARGUMENT de SORTIE_STRUCTUREE — `cle:champ1,champ2` — se découpe au DERNIER deux-points,
 * jamais au premier : les clés d'étapes des plans de modèle en CONTIENNENT
 * (« analyse:priorisation »), et un run Render a produit un FAUX refus déterministe
 * (« étape « analyse » absente ») sur une mission dont le travail était fait — la grammaire
 * tronquait la clé au premier « : ». Les champs, eux, ne portent jamais de deux-points.
 */
export function argsSortieStructuree(args: string): { cle: string; champs: string[] } {
  const idx = args.lastIndexOf(":");
  const cle = (idx === -1 ? "" : args.slice(0, idx)).trim();
  const champs = (idx === -1 ? "" : args.slice(idx + 1)).split(",").map((s) => s.trim()).filter(Boolean);
  return { cle, champs };
}

/**
 * LE REGISTRE DES CODES. Chaque vérificateur rend sa PREUVE en français : le verdict final
 * les cite telles quelles, et c'est ce qui rend un refus déterministe aussi lisible qu'un
 * refus de juge — étape nommée, fait constaté, rien d'autre.
 */
const REGLES: Record<string, Verificateur> = {
  /**
   * Chaque étape citée (clés en args) est DONE et son reçu porte la requête attendue —
   * le terme « cité » dans le texte du critère. C'est l'énoncé qu'un run Render a vu un juge
   * refuser « faute de preuve » alors que la preuve existait, structurée, dans les reçus.
   */
  RECHERCHES_AVEC_REQUETE: (args, texte, steps) => {
    /**
     * « EXÉCUTÉ = PRÉVU », jamais « chaque requête contient le terme du critère ».
     *
     * La première version comparait chaque reçu au terme cité dans le TEXTE du critère.
     * Un run Render a montré ce que ça punit : une comparaison A/B dont la branche B cherche
     * légitimement B (refusée parce que son reçu ne portait pas A), un recours par synonymes
     * (« convention » refusé parce qu'il ne porte pas « contrat »), un historique dont une
     * branche cherche le produit du dossier. La référence JUSTE est la requête PRÉVUE AU PLAN
     * pour CHAQUE étape (`input.query`) : la règle prouve que la recherche voulue est bien
     * partie, telle quelle — la pertinence de la stratégie reste l'affaire du plan et du juge.
     * Le terme cité « … » du texte reste le REPLI quand une étape n'a pas de requête au plan.
     */
    const terme = termeDuCritere(texte);
    const cles = args.split(",").map((s) => s.trim()).filter(Boolean);
    if (cles.length === 0) return { verdict: "FAIL", preuve: "le critère ne cite aucune étape" };
    const manques: string[] = [];

    /** La requête PRÉVUE AU PLAN d'une étape — jamais un gabarit `{{…}}` non résolu. */
    const prevueDe = (s: EtapeObservee): string | null => {
      const q = s.input && typeof s.input === "object" ? (s.input as Record<string, unknown>).query : undefined;
      if (typeof q !== "string" || q.trim() === "" || q.includes("{{")) return null;
      return q.trim();
    };

    const verifier = (s: EtapeObservee): void => {
      if (s.status !== "DONE") { manques.push(`${s.key} : ${s.status}`); return; }
      /**
       * UN ÉVENTAIL DÉPLOYÉ ne porte pas de reçu : ses FILLES appellent, et chacune porte la
       * requête RÉSOLUE de son itération. La preuve se lit donc sur elles — le parent ne dit
       * que le déploiement (`{expanded, keys}`, écrit par le moteur, jamais par un modèle).
       * Un éventail VIDE (0 élément) est une preuve d'absence, pas un manquement.
       */
      const r = s.result && typeof s.result === "object" && !Array.isArray(s.result)
        ? (s.result as Record<string, unknown>) : null;
      if (r && typeof r.expanded === "number" && Array.isArray(r.keys)) {
        for (const k of r.keys as string[]) {
          const fille = steps.find((x) => x.key === k);
          if (!fille) { manques.push(`${k} : itération absente`); continue; }
          verifier(fille);
        }
        return;
      }
      const attendu = prevueDe(s) ?? terme;
      if (!attendu) { manques.push(`${s.key} : ni requête prévue au plan ni terme cité « » — rien à vérifier`); return; }
      const requete = s.recu?.query ?? null;
      if (!requete || !requete.toLowerCase().includes(attendu.toLowerCase())) {
        manques.push(`${s.key} : le reçu ne porte pas la requête prévue « ${attendu} » (requête exécutée : ${requete ?? "absente"})`);
      }
    };

    for (const cle of cles) {
      const s = steps.find((x) => x.key === cle);
      if (!s) { manques.push(`${cle} : étape absente`); continue; }
      verifier(s);
    }
    return manques.length === 0
      ? { verdict: "PASS", preuve: `${cles.length} recherche(s) DONE, chaque reçu porte la requête PRÉVUE au plan (${cles.join(", ")})` }
      : { verdict: "FAIL", preuve: manques.join(" ; ") };
  },

  /**
   * Aucun effet au-delà d'ANALYZE : chaque reçu présent le déclare, et les étapes SANS reçu
   * sont jugées par l'effet STRUCTUREL de leur type de nœud (la même table que le compilateur
   * — jamais une copie). Un reçu manquant sur une CAPABILITY aboutie est un FAIL, pas un
   * bénéfice du doute : §78, l'absence de mesure n'est pas une mesure.
   */
  AUCUNE_ECRITURE: (_args, _texte, steps) => {
    const ecritures: string[] = [];
    for (const s of steps) {
      if (s.recu) {
        if (!LECTURES.has(s.recu.effect)) ecritures.push(`${s.key} : effet ${s.recu.effect} au reçu`);
        continue;
      }
      if (s.nodeType === "CAPABILITY" && s.status === "DONE") {
        /**
         * DEUX ABOUTISSEMENTS SANS APPEL, écrits par le MOTEUR (jamais par un modèle) :
         * le parent d'un ÉVENTAIL déployé (`{expanded, keys, source}` — ce sont ses filles
         * qui appellent et portent les reçus) et une étape DÉDUPLIQUÉE (`{deduplique: true}`
         * — le reçu vit sur l'étape jumelle). Un run Render les comptait « capacité aboutie
         * SANS reçu » et refusait des missions dont chaque appel réel ÉTAIT reçu en main.
         */
        const r = s.result && typeof s.result === "object" && !Array.isArray(s.result)
          ? (s.result as Record<string, unknown>) : null;
        const sansAppel = r !== null && (typeof r.expanded === "number" || r.deduplique === true);
        if (!sansAppel) ecritures.push(`${s.key} : capacité aboutie SANS reçu — effet invérifiable`);
        continue;
      }
      const structurel = effetDuNoeud(s.nodeType, null);
      if (EFFECT_RANK[structurel] > EFFECT_RANK.ANALYZE) {
        ecritures.push(`${s.key} : nœud ${s.nodeType} d'effet structurel ${structurel}`);
      }
    }
    return ecritures.length === 0
      ? { verdict: "PASS", preuve: `${steps.length} étape(s), aucun effet au-delà d'ANALYZE (reçus et types de nœud)` }
      : { verdict: "FAIL", preuve: ecritures.join(" ; ") };
  },

  /**
   * L'étape citée a rendu une SORTIE STRUCTURÉE portant chaque champ requis, non vide.
   * C'est le schéma imposé au worker qui rend cette vérification possible — la qualité de la
   * prose reste l'affaire d'un juge sémantique quand le plan en demande un ; la PRÉSENCE
   * d'une conclusion qui tranche, elle, se vérifie ici.
   */
  SORTIE_STRUCTUREE: (args, _texte, steps) => {
    const { cle, champs } = argsSortieStructuree(args);
    if (!cle || champs.length === 0) return { verdict: "FAIL", preuve: "règle incomplète : étape ou champs absents" };
    const s = steps.find((x) => x.key === cle);
    if (!s) return { verdict: "FAIL", preuve: `étape « ${cle} » absente` };
    if (s.status !== "DONE") return { verdict: "FAIL", preuve: `étape « ${cle} » : ${s.status}` };
    const r = s.result;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return { verdict: "FAIL", preuve: `étape « ${cle} » : pas de sortie structurée` };
    }
    const objet = r as Record<string, unknown>;
    const manquants = champs.filter((c) => {
      const v = objet[c];
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    });
    return manquants.length === 0
      ? { verdict: "PASS", preuve: `« ${cle} » DONE, sortie structurée complète (${champs.join(", ")})` }
      : { verdict: "FAIL", preuve: `« ${cle} » : champ(s) manquant(s) ou vide(s) : ${manquants.join(", ")}` };
  },
};

/** Ce que le compilateur sait du plan — ce qu'il faut pour RÉPARER une règle au lieu de refuser. */
export interface ContexteReglesPlan {
  /** Les clés citables : celles du plan, plus les ACQUISES des plans antérieurs (elles existent, terminées, en base). */
  clesEtapes: ReadonlySet<string>;
  /** Les étapes du plan dont l'entrée porte une vraie requête (`input.query`, pas un gabarit `{{…}}`). */
  clesAvecRequete: ReadonlySet<string>;
  /** Les étapes capables d'une sortie structurée (WORKER à schéma), avec les champs de leur schéma. */
  sortiesStructurees: readonly { cle: string; champs: readonly string[] }[];
}

export interface ReparationRegles {
  criteres: string[];
  /** Chaque réparation ou déclassement, nommé en français — les warnings de compilation les portent. */
  notes: string[];
}

/** Comparaison de clés insensible aux accents et à la casse — la faute typique d'un modèle. */
const clePourComparer = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * LE CANDIDAT UNIQUE — la doctrine de `collection.ts` (CORRIGEE) appliquée aux règles : une
 * réparation n'est permise que si UNE SEULE clé du plan peut être celle que le modèle visait.
 * Deux candidats plausibles = zéro réparation : corriger au hasard fabriquerait une preuve.
 */
function candidatUnique(cle: string, cles: ReadonlySet<string>): string | null {
  const n = clePourComparer(cle);
  const exacts = [...cles].filter((k) => clePourComparer(k) === n);
  if (exacts.length === 1) return exacts[0];
  if (exacts.length > 1) return null;
  const partiels = [...cles].filter((k) => {
    const kn = clePourComparer(k);
    return kn.includes(n) || n.includes(kn);
  });
  return partiels.length === 1 ? partiels[0] : null;
}

/** Déclasse un critère-règle en critère SÉMANTIQUE : l'étiquette tombe, la phrase reste, le juge la lit. */
function declasser(critere: string, secours: string): string {
  const m = critere.match(GRAMMAIRE);
  const texte = m ? (m[3] ?? "").trim() : "";
  return texte !== "" ? texte : secours;
}

/**
 * RÉPARE les références des règles À LA COMPILATION — jamais un refus pour une faute de FORME.
 *
 * Deux runs Render ont payé le prix des deux politiques précédentes. Sans contrôle : une règle
 * citant une étape fantôme laissait la mission tourner ENTIÈREMENT puis tombait en FAUX refus
 * déterministe à la FIN — travail fait, mission bloquée. Avec refus de compilation : le même
 * plan mourait AVANT DE NAÎTRE (« étape « synthese » absente ») alors qu'une seule étape du
 * plan pouvait être visée — la retouche du planificateur a reproduit la faute, et la mission
 * n'a jamais été créée. Le taux de création de mission est un invariant : une faute de forme
 * dans un CRITÈRE ne condamne jamais un plan dont les ÉTAPES compilent.
 *
 * La politique est celle du décodeur (« ne jamais deviner, réparer à candidat UNIQUE ») :
 *   — cible unique reconnaissable → la règle est RÉPARÉE, et la réparation est DITE ;
 *   — cible introuvable ou ambiguë → la règle est DÉCLASSÉE en critère sémantique : le juge
 *     évalue la phrase, la mission vit, et l'on perd seulement l'arithmétique — jamais l'issue.
 * Un code INCONNU ne bouge pas : c'est déjà un critère sémantique, il ira au juge.
 */
export function reparerReglesDacceptation(
  criteres: readonly string[],
  plan: ContexteReglesPlan,
): ReparationRegles {
  const sortie: string[] = [];
  const notes: string[] = [];
  for (const critere of criteres) {
    const m = critere.match(GRAMMAIRE);
    if (!m || !REGLES[m[1]]) { sortie.push(critere); continue; }
    const code = m[1];
    const args = m[2] ?? "";
    const texte = (m[3] ?? "").trim();

    if (code === "RECHERCHES_AVEC_REQUETE") {
      const citees = args.split(",").map((s) => s.trim()).filter(Boolean);
      const gardees: string[] = [];
      const changements: string[] = [];
      for (const cle of citees) {
        if (plan.clesEtapes.has(cle)) { gardees.push(cle); continue; }
        const cand = candidatUnique(cle, plan.clesEtapes);
        if (cand) { gardees.push(cand); changements.push(`« ${cle} » → « ${cand} »`); }
        else changements.push(`« ${cle} » écartée (aucune étape du plan ne correspond sans ambiguïté)`);
      }
      const verifiable = gardees.length > 0
        && (termeDuCritere(texte) !== null || gardees.every((c) => plan.clesAvecRequete.has(c)));
      if (!verifiable) {
        sortie.push(declasser(critere, "les recherches prévues au plan ont été exécutées."));
        notes.push(`[REGLE:${code}] déclassée en critère sémantique : ${gardees.length === 0
          ? "aucune étape citée n'existe dans le plan"
          : "ni requête prévue au plan sur chaque étape citée, ni terme cité entre « »"} — le juge évaluera la phrase.`);
        continue;
      }
      if (changements.length > 0) {
        sortie.push(`[REGLE:${code}:${gardees.join(",")}] ${texte}`.trim());
        notes.push(`[REGLE:${code}] réparée : ${changements.join(" ; ")}.`);
      } else {
        sortie.push(critere);
      }
      continue;
    }

    if (code === "SORTIE_STRUCTUREE") {
      const { cle, champs } = argsSortieStructuree(args);
      const secours = champs.length > 0
        ? `la mission rend la sortie structurée attendue (${champs.join(", ")}).`
        : "la mission rend la sortie structurée attendue.";
      if (!cle || champs.length === 0) {
        sortie.push(declasser(critere, secours));
        notes.push(`[REGLE:${code}] déclassée en critère sémantique : forme « cléEtape:champ1,champ2 » incomplète.`);
        continue;
      }
      if (plan.clesEtapes.has(cle)) { sortie.push(critere); continue; }
      let cand = candidatUnique(cle, plan.clesEtapes);
      if (!cand) {
        // Le nom ne mène nulle part — mais si UNE SEULE étape du plan est CAPABLE de porter
        // tous les champs exigés (un WORKER dont le schéma les déclare), c'est elle.
        const porteurs = plan.sortiesStructurees.filter((s) => champs.every((c) => s.champs.includes(c)));
        if (porteurs.length === 1) cand = porteurs[0].cle;
      }
      if (cand) {
        sortie.push(`[REGLE:${code}:${cand}:${champs.join(",")}] ${texte}`.trim());
        notes.push(`[REGLE:${code}] réparée : « ${cle} » → « ${cand} » (cible unique reconnaissable).`);
      } else {
        sortie.push(declasser(critere, secours));
        notes.push(`[REGLE:${code}] déclassée en critère sémantique : l'étape « ${cle} » n'existe pas et aucune cible unique ne se reconnaît.`);
      }
      continue;
    }

    sortie.push(critere);
  }
  return { criteres: sortie, notes };
}

/**
 * RÉÉCRIT les clés d'étapes CITÉES PAR LES RÈGLES quand l'assainissement des clés les a
 * renommées — sinon l'assainissement CRÉERAIT la référence fantôme qu'il prétend éviter.
 * Seuls les arguments de la grammaire bougent ; le texte français reste intact.
 */
export function reecrireClesDansRegles(
  criteres: readonly string[],
  renommages: ReadonlyMap<string, string>,
): string[] {
  if (renommages.size === 0) return [...criteres];
  return criteres.map((critere) => {
    const m = critere.match(GRAMMAIRE);
    if (!m || !REGLES[m[1]]) return critere;
    const code = m[1];
    const args = m[2] ?? "";
    const texte = (m[3] ?? "").trim();
    if (code === "RECHERCHES_AVEC_REQUETE") {
      const cles = args.split(",").map((s) => s.trim()).filter(Boolean)
        .map((c) => renommages.get(c) ?? c);
      return `[REGLE:${code}:${cles.join(",")}] ${texte}`.trim();
    }
    if (code === "SORTIE_STRUCTUREE") {
      const { cle, champs } = argsSortieStructuree(args);
      if (!cle) return critere;
      const nouvelle = renommages.get(cle) ?? cle;
      return `[REGLE:${code}:${nouvelle}:${champs.join(",")}] ${texte}`.trim();
    }
    return critere;
  });
}

/**
 * PARTITIONNE les critères : règles vérifiées sur-le-champ, sémantiques rendus au juge.
 * Pure — steps observés en entrée, verdicts en sortie, aucun appel de rien.
 */
export function partitionnerCriteres(
  criteres: readonly string[],
  steps: readonly EtapeObservee[],
): Partition {
  const regles: VerificationRegle[] = [];
  const semantiques: string[] = [];
  for (const critere of criteres) {
    const m = critere.match(GRAMMAIRE);
    const verificateur = m ? REGLES[m[1]] : undefined;
    if (!m || !verificateur) {
      semantiques.push(critere);
      continue;
    }
    const { verdict, preuve } = verificateur(m[2] ?? "", m[3] ?? critere, steps);
    regles.push({ critere, code: m[1], verdict, preuve });
  }
  return { regles, semantiques };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI SURVIT À UNE REPLANIFICATION — la barre, pas la tuyauterie.
 *
 * ── POURQUOI CE FILTRE EXISTE ───────────────────────────────────────────────────────────
 *
 * Les critères d'acceptation sont écrits par le PLANIFICATEUR. Sur une replanification, c'est
 * donc le même modèle, sur le même objectif, qui réécrit la barre à laquelle il vient d'être
 * recalé — et rien ne l'empêchait d'en écrire une plus basse, puis de conclure COMPLETED
 * dessus. Il faut donc reporter les exigences du plan précédent.
 *
 * ── MAIS TOUT NE SE REPORTE PAS, ET LE CONFONDRE CASSE TOUT ─────────────────────────────
 *
 * Une RÈGLE porte des clés d'étape : `[REGLE:RECHERCHES_AVEC_REQUETE:recherche-drive,…]`. Ces
 * clés appartiennent au plan qui les a produites. Reportée telle quelle dans un plan qui ne
 * contient plus ces étapes, la règle devient INSATISFIABLE PAR CONSTRUCTION — la mission est
 * condamnée avant d'avoir commencé. Mesuré : un report naïf faisait passer une mission de
 * COMPLETED à BLOCKED, et le scénario anti-triche le voyait comme une divergence de verdict.
 *
 * La distinction est donc celle-ci :
 *
 *   • un critère SÉMANTIQUE (« l'absence est démontrée, sources citées ») dit CE QU'ON VEUT.
 *     Il ne connaît aucune étape, il survit toujours ;
 *   • une RÈGLE qui NOMME des étapes dit COMMENT on le vérifiera dans CE plan-là. Elle ne
 *     survit que si l'une au moins des étapes qu'elle nomme est encore là ;
 *   • une règle SANS argument (`[REGLE:AUCUNE_ECRITURE]`) ne nomme rien : c'est une exigence
 *     sur la mission entière, elle survit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function criteresQuiSurvivent(
  anciens: readonly string[],
  clesDuPlan: ReadonlySet<string>,
): string[] {
  const gardes: string[] = [];
  for (const c of anciens) {
    const m = c.match(GRAMMAIRE);
    if (!m) { gardes.push(c); continue; }          // sémantique : la barre elle-même.
    const args = (m[2] ?? "").trim();
    if (args === "") { gardes.push(c); continue; } // règle sans cible : porte sur la mission.
    const nommees = args.split(/[:,]/).map((x) => x.trim()).filter(Boolean);
    if (nommees.some((k) => clesDuPlan.has(k))) gardes.push(c);
  }
  return gardes;
}
