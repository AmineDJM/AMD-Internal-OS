/**
 * Compilateur de mission — PASSE 3 : chaque étape, une par une, et le contexte explicite que
 * partagent les passes (ce qui était les variables locales de `compile`).
 */
import { type CompileIssue, type MissionPlan, NODE_TYPES, type NodeType, PLAN_LIMITS } from "@/lib/missions/planner/contract";
import { EFFECT_RANK, type Effect } from "@/lib/missions/registry/capability-meta";
import { effetDuNoeud } from "@/lib/missions/registry/node-effect";
import type { CapabilityCatalog, MissionActor } from "@/lib/missions/ports";
import { messageRefus, refusPourActeur } from "@/lib/missions/policy/guard";
import { lireAttente } from "@/lib/missions/events/match";
import { decrireEntrees, estGabarit, verifierEntree } from "@/lib/missions/registry/input-contract";
import { referencesDe, resoudreReference } from "@/lib/missions/runtime/interpolate";
import { direRefus, verdictChemin, type SortieEtape } from "@/lib/missions/compiler/sorties";
import { verdictEmpreinte } from "@/lib/mutations/empreinte";
import type { CompiledStep, OptionsCompilation } from "@/lib/missions/compiler/compile/types";
import { CAPACITES_LISTE, FORMES, issue, nbDestinataires, specDe } from "@/lib/missions/compiler/compile/outils";

/**
 * CE QUE LES PASSES LISENT ET ÉCRIVENT — les variables de `compile`, rendues explicites. Les tableaux
 * (`issues`, `warnings`, `compiled`) sont ceux de `compile` : une passe y ajoute, elle ne les remplace pas.
 */
export interface ContexteCompilation {
  /** Le plan tel que le modèle l'a écrit (son objectif fait foi pour l'empreinte, §118.3). */
  planBrut: MissionPlan;
  /** Le plan assaini, réparé, converti (passe 0) — celui qui est compilé. */
  plan: MissionPlan;
  catalog: CapabilityCatalog;
  actor: MissionActor;
  opts: OptionsCompilation;
  /** Les clés ACQUISES d'un plan précédent, terminées, dont le résultat est en base. */
  acquises: ReadonlySet<string>;
  issues: CompileIssue[];
  warnings: CompileIssue[];
  /** Les clés valides du plan (passe 2). */
  vues: Set<string>;
  sortieDe: (cle: string) => SortieEtape | null;
  /** Les étapes compilées, dans l'ordre du plan (passe 3). */
  compiled: CompiledStep[];
}

/**
 * PASSE 3 — UNE ÉTAPE : sa forme, sa capacité et le droit de l'acteur, son contrat d'entrée, son effet
 * sous le plafond, son empreinte, l'éventail, les références, la condition, la cardinalité. L'étape
 * compilée s'ajoute à `ctx.compiled` ; une étape de type inconnu n'y entre pas.
 */
export function compilerEtape(s: MissionPlan["steps"][number], ctx: ContexteCompilation): void {
  const { planBrut, plan, catalog, actor, opts, acquises, issues, warnings, vues, sortieDe, compiled } = ctx;
  const nodeType: NodeType = s.nodeType ?? (s.capability ? "CAPABILITY" : "WORKER");
  if (!NODE_TYPES.includes(nodeType)) {
    issues.push(issue("INVALID_SHAPE", s.key, `type de nœud inconnu : ${String(nodeType)}.`));
    return;
  }

  // L'ENTRÉE, COPIÉE : les réparations de forme (casse d'une énumération, nombre en texte)
  // s'appliquent à cette copie, jamais au plan reçu — et c'est elle qui est compilée.
  const entree: Record<string, unknown> = { ...(s.input ?? {}) };

  const forme = FORMES[nodeType];
  if (forme.capacite === "requise" && !s.capability) {
    issues.push(issue("INVALID_SHAPE", s.key, `un nœud ${nodeType} doit nommer une capacité.`));
  }
  if (forme.capacite === "interdite" && s.capability) {
    issues.push(issue("INVALID_SHAPE", s.key,
      `un nœud ${nodeType} n'appelle pas de capacité (« ${s.capability} » a été déclarée).`));
  }
  if (forme.attente === "requise") {
    const w = s.waitFor;
    // UN SEUL DÉCODEUR fait foi : `lireAttente` — la même relecture que celle du routeur de
    // réveil. Un WAIT_EVENT est décrit s'il attend un ÉVÉNEMENT, un MOMENT (`until` —
    // WAIT_FOR_TIME), ou une composition de branches. Valider ici avec une AUTRE règle que
    // celle du réveil fabriquerait des attentes compilables que rien ne réveille jamais.
    const decrite = nodeType === "WAIT_EVENT" ? lireAttente(w) !== null : Boolean(w?.ask);
    if (!decrite) {
      issues.push(issue("INVALID_SHAPE", s.key,
        nodeType === "WAIT_EVENT"
          ? "une attente doit dire QUEL événement (event), QUEL moment (until, ISO 8601) ou "
            + "quelles branches (anyOf/allOf) — sinon rien ne la réveillera jamais."
          : "une attente humaine doit dire ce qu'on demande, sinon personne ne sait quoi fournir."));
    }
    // Une échéance illisible réveillerait… jamais. Refusée à la compilation, pas découverte
    // dans trois jours quand personne ne comprend pourquoi la mission dort encore.
    const untils = [w?.until, ...(w?.anyOf ?? []).map((b) => b.until), ...(w?.allOf ?? []).map((b) => b.until)]
      .filter((u): u is string => typeof u === "string" && u.trim() !== "");
    for (const u of untils) {
      // UNE ÉCHÉANCE PEUT VENIR DES DONNÉES : `{{analyse.dateEcheance}}` se résout à l'exécution
      // (runtime/interpolate.ts), et le moteur refuse alors une date illisible. Refuser ici la
      // référence elle-même interdisait « attends l'échéance que tu viens de lire » — mesuré.
      if (!estGabarit(u) && !Number.isFinite(Date.parse(u))) {
        issues.push(issue("INVALID_SHAPE", s.key,
          `l'échéance « ${u} » n'est pas une date ISO 8601 lisible — cette attente ne se réveillerait jamais.`));
      }
    }
  }
  if (forme.attente === "interdite" && s.waitFor) {
    issues.push(issue("INVALID_SHAPE", s.key, `un nœud ${nodeType} n'attend rien.`));
  }

  /**
   * ── La capacité : existe-t-elle, et l'acteur y a-t-il droit ? ─────────────────────
   *
   * LE DÉFAUT VIENT DE LA TABLE DES TYPES DE NŒUD, et c'est une correction. Il valait
   * `ANALYZE` en dur, ce qui recouvrait par hasard le cas WORKER et surestimait tous les
   * autres — une attente d'événement se voyait attribuer l'effet d'un appel de modèle. Pire :
   * `WAIT_EVENT` et `WAIT_INPUT` n'apparaissaient dans AUCUNE des branches ci-dessous, si bien
   * qu'un plafond `READ` les refusait. La table `EFFET_NOEUD` est exhaustive par le TYPE :
   * ajouter un type de nœud sans lui donner d'effet ne compile plus.
   */
  let effect: Effect = effetDuNoeud(nodeType);
  let idempotent = true;
  let batchable = true;
  let confirmation: "POLICY_ENGINE" | "ALWAYS" | "NEVER" = "NEVER";

  if (s.capability) {
    if (!catalog.has(s.capability)) {
      issues.push(issue("UNKNOWN_CAPABILITY", s.key,
        `la capacité « ${s.capability} » n'existe pas au registre. Un plan ne peut pas inventer un `
        + `outil : il faut décomposer autrement, ou déclarer un manque.`));
    } else if (!catalog.allowed(s.capability, actor)) {
      issues.push(issue("FORBIDDEN_CAPABILITY", s.key,
        `${actor.label} n'a pas le droit d'appeler « ${s.capability} ». Une mission ne contourne `
        + `pas les droits : elle passe par les mêmes.`));
    } else {
      const m = catalog.meta(s.capability);

      // ── §29 : L'INTERDIT STRUCTUREL, VÉRIFIÉ MÊME QUAND LE CATALOGUE DIT OUI ────────
      //
      // L'ordre compte. Si l'on ne regardait la politique qu'après le droit, il suffirait
      // qu'un compte soit trop largement doté pour qu'Adam puisse modifier ses propres
      // permissions. Ici, aucun droit ne lève l'interdit : le refus est de compilation.
      const refus = refusPourActeur(s.capability, m.effect, actor);
      if (refus) {
        issues.push(issue("FORBIDDEN_CAPABILITY", s.key, messageRefus(refus)));
      }

      effect = m.effect;
      idempotent = m.idempotent;
      batchable = m.batchable;
      confirmation = m.confirmation;

      /**
       * ── LE CONTRAT D'ENTRÉE — refusé ICI, pas découvert à l'exécution ─────────────
       *
       * Sept des onze échecs d'écriture du banc m5 étaient des clés que l'outil ne lit pas
       * (`message` pour `body`, `schedule` pour `quand`, `paymentReference` pour `reference`).
       * Chacun arrivait APRÈS l'accord du dirigeant et coûtait une replanification. Le
       * contrat vient du schéma de l'outil (registry/input-contract.ts) ; le message nomme les
       * clés admises, pour que la correction soit une lecture et non une seconde devinette.
       * Une faute de FORME (« approve » → APPROVE, « 50 » → 50) se répare en code et se dit.
       */
      const contrat = catalog.entrees?.(s.capability) ?? null;
      if (contrat) {
        const v = verifierEntree(entree, contrat);
        for (const r of v.reparations) {
          entree[r.champ] = r.vers;
          warnings.push(issue("INVALID_SHAPE", s.key,
            `« ${r.champ} » : ${JSON.stringify(r.de)} lu comme ${JSON.stringify(r.vers)} (forme corrigée).`));
        }
        const liste = (cles: string[]) => cles.map((c) => `« ${c} »`).join(", ");
        if (v.inconnues.length > 0) {
          issues.push(issue("INVALID_INPUT", s.key,
            `« ${s.capability} » ne lit pas ${liste(v.inconnues)}. Ses ${decrireEntrees(contrat)}.`));
        }
        if (v.manquantes.length > 0) {
          issues.push(issue("INVALID_INPUT", s.key,
            `« ${s.capability} » exige ${liste(v.manquantes)}. Ses ${decrireEntrees(contrat)}.`));
        }
        for (const inv of v.invalides) {
          issues.push(issue("INVALID_INPUT", s.key, `« ${s.capability} », champ « ${inv.champ} » : ${inv.raison}.`));
        }
      }
      if (!m.declared) {
        warnings.push(issue("INVALID_SHAPE", s.key,
          `« ${s.capability} » n'a pas de métadonnée déclarée : elle est traitée au plus prudent `
          + `(${m.effect}, non rejouable, sous confirmation).`));
      }
    }
  }

  /**
   * ── LE PLAFOND D'EFFET S'APPLIQUE À L'ÉTAPE, PAS SEULEMENT À LA CAPACITÉ ───────────
   *
   * LE FAUX VERT QUE CE BLOC FERME. Un run Render a lancé les trois scénarios en lecture
   * seule, et le rapport a affiché `READ_ONLY_EXECUTION PASS` — pendant que deux missions
   * écrivaient de vrais fichiers XLSX dans le Drive de production :
   *
   *     ARTIFACT · « Vérification Zorbamyxine-K7 » (XLSX, 12 Ko) fabriqué et contrôlé.
   *
   * Le plafond `ANALYZE` était bien posé, mais il ne filtrait QUE LE CATALOGUE, donc que les
   * étapes portant une `capability`. Un nœud ARTIFACT n'en porte pas : il produit un fichier
   * sans passer par le catalogue, et personne ne comparait son effet au plafond. Le plan
   * compilait en annonçant lui-même « effet maximal PREPARE », au-dessus du plafond, et le
   * compilateur l'acceptait — il CALCULAIT `maxEffect` sans jamais s'en servir.
   *
   * Le contrôle porte donc désormais sur l'EFFET de l'étape, quelle que soit sa nature. C'est
   * la seule formulation qui ne laisse pas de porte : un effet est un effet, qu'il vienne
   * d'une capacité déclarée ou d'un nœud qui fabrique.
   *
   * CONSÉQUENCE MESURÉE, ET ELLE EST BONNE. Les fichiers laissés par les runs précédents
   * étaient retrouvés par le run suivant : « il n'existe rien sur cette molécule » devenait
   * faux à cause du banc lui-même. Fermer le trou assainit le scénario par la même occasion.
   */
  if (opts.effetMax && EFFECT_RANK[effect] > EFFECT_RANK[opts.effetMax]) {
    issues.push(issue("FORBIDDEN_EFFECT", s.key,
      `« ${s.title} » porte l'effet ${effect}, au-dessus du plafond ${opts.effetMax} de cette `
      + `mission. Un nœud ${nodeType} produit un effet même sans capacité déclarée : le plafond `
      + `porte sur ce qui SORT, pas sur la façon dont l'étape est écrite.`));
  }

  /**
   * ── L'EMPREINTE D'UNE ÉTAPE NE DÉPASSE PAS CELLE DE L'OBJECTIF (§118.3) ───────────
   *
   * Le compilateur refuse déjà une CARDINALITÉ fausse — « 33 destinataires dans une étape au
   * lieu de 33 étapes ». La faute symétrique est une PROFONDEUR fausse, et elle a été mesurée
   * dans la conversation : « retire l'adresse e-mail d'Allaeddine » a produit une proposition
   * de SUPPRESSION de la personne. Un champ demandé, un enregistrement détruit.
   *
   * Ici, la comparaison se fait contre l'objectif que le plan énonce LUI-MÊME. C'est ce qui la
   * rend sûre : si le modèle a compris « supprimer l'employé », son objectif le dit et l'étape
   * passe. Elle ne se déclenche que quand le plan se contredit — l'objectif parle d'un champ,
   * l'étape détruit la ligne. `mutations/empreinte.ts` reste muet sur tout ce qu'il ne lit pas
   * à coup sûr, et un muet n'interdit rien.
   */
  if (s.capability) {
    const emp = verdictEmpreinte(planBrut.objective ?? "", s.capability, s.title);
    if (!emp.ok) {
      issues.push(issue("FORBIDDEN_EFFECT", s.key,
        `« ${s.title} » : ${emp.refus} Vise le champ, pas la ligne — ou dis dans « gaps » qu'aucune `
        + `capacité ne sait le faire à cette échelle.`));
    }
  }

  // ── L'ÉVENTAIL ────────────────────────────────────────────────────────────────────
  const dependsOn = [...new Set(s.dependsOn ?? [])];
  if (s.forEach) {
    if (!s.forEach.from || !s.forEach.path || !s.forEach.as) {
      issues.push(issue("INVALID_SHAPE", s.key,
        "un éventail doit dire d'où vient la collection, où la lire et sous quel nom l'injecter."));
    } else if (!vues.has(s.forEach.from)) {
      issues.push(issue("UNKNOWN_FANOUT_SOURCE", s.key,
        `l'éventail lit « ${s.forEach.from} », qui n'est pas une étape du plan.`));
    } else if (!batchable && s.capability) {
      issues.push(issue("NOT_BATCHABLE", s.key,
        `« ${s.capability} » n'est pas déclarée répétable : la déployer en éventail exécuterait `
        + `N fois un appel dont on ne sait pas s'il supporte d'être répété.`));
    }
    // LA DÉPENDANCE IMPLICITE. Lire la sortie d'une étape, c'est en dépendre — l'écrire à la
    // main serait un oubli de plus à chaque replan, et l'oubli produirait une lecture de vide.
    if (s.forEach.from && !dependsOn.includes(s.forEach.from)) dependsOn.push(s.forEach.from);
  }

  /**
   * ── LES RÉFÉRENCES `{{etape.chemin}}` : des dépendances implicites, et vérifiées ──────
   *
   * Le planificateur compose ses étapes en lisant la sortie des précédentes — c'est la forme
   * promise par son schéma depuis toujours, et le moteur la résout désormais (runtime/
   * interpolate.ts). Trois choses se décident ICI : lire une étape, c'est en dépendre (sinon la
   * lecture précède l'écriture et lit du vide) ; une référence vers une étape qui n'existe pas
   * est une faute de plan, refusée avec les clés connues ; et le CHAMP lui-même est refusé
   * quand le compilateur sait qu'il n'existera pas (`compiler/sorties.ts`). Ce dernier
   * contrôle est arrivé tard : le moteur savait déjà nommer les champs rendus, mais il le
   * faisait à l'exécution, après l'accord du dirigeant, en tuant la mission.
   */
  const alias = s.forEach?.as ? new Set([s.forEach.as]) : new Set<string>();
  const clesConnues = [...vues, ...acquises];
  for (const ref of [...referencesDe(entree), ...referencesDe(s.waitFor ?? null)]) {
    const premier = ref.split(".")[0];
    if (alias.has(premier)) continue;
    const r = resoudreReference(ref, clesConnues);
    if (!r) {
      issues.push(issue("INVALID_INPUT", s.key,
        `« {{${ref}}} » désigne une étape « ${premier} » qui n'existe pas dans le plan. Une référence `
        + `s'écrit {{cle_etape.chemin}} avec la clé EXACTE d'une étape amont (clés du plan : `
        + `${[...vues].slice(0, 12).join(", ")}).`));
      continue;
    }
    if (r.cle === s.key) {
      issues.push(issue("INVALID_SHAPE", s.key, "une étape ne peut pas lire sa propre sortie."));
      continue;
    }
    /**
     * ── LE CHAMP, PAS SEULEMENT LA CLÉ (§54) ────────────────────────────────────────
     *
     * Ce contrôle refuse UNIQUEMENT ce que le compilateur SAIT faux : un worker rend
     * exactement les champs de son schéma, une jonction rend son compteur, une capacité
     * rend ce qu'elle a été observée rendre. Une ignorance ne refuse rien — `verdictChemin`
     * rend `null` dans ce cas, et c'est la propriété qui empêche d'échanger un défaut
     * mesuré contre un refus à tort sur toutes les capacités neuves.
     */
    const sortieAmont = sortieDe(r.cle);
    if (sortieAmont && r.chemin) {
      const mort = verdictChemin(sortieAmont, r.chemin);
      if (mort) {
        issues.push(issue("INVALID_INPUT", s.key, direRefus(r.cle, ref, mort)));
        continue;
      }
    }
    if (!dependsOn.includes(r.cle)) dependsOn.push(r.cle);
  }

  /**
   * ── L'ENTITÉ D'UNE ATTENTE NE SE LIT PAS DANS UNE RECHERCHE (§37) ──────────────────────
   *
   * Mesuré au banc : « attends la signature du contrat Mouffok » donnait
   * `entity: "CONTRACT:{{recherche.resultats.0.reference}}"` — une recherche rend une LISTE, sans
   * identifiant sûr à cet endroit ; l'attente échouait à la résolution, la mission se bloquait,
   * et la replanification contournait la tâche. Le refus est ICI, avec la correction : un
   * identifiant CONNU, ou `subject`/`from` pour cibler sans identifiant. Lire l'identifiant d'une
   * étape qui CRÉE ou LIT un dossier précis (`inspect_record`, `create_*`) reste permis.
   */
  if (nodeType === "WAIT_EVENT" && s.waitFor) {
    const w = s.waitFor;
    const entites = [w.entity, ...(w.anyOf ?? []).map((b) => b.entity), ...(w.allOf ?? []).map((b) => b.entity)]
      .filter((e): e is string => typeof e === "string" && estGabarit(e));
    for (const e of entites) {
      for (const ref of referencesDe({ e })) {
        const r = resoudreReference(ref, clesConnues);
        const source = r ? plan.steps.find((x) => x.key === r.cle) : undefined;
        if (source?.capability && CAPACITES_LISTE.test(source.capability)) {
          issues.push(issue("INVALID_INPUT", s.key,
            `l'entité de l'attente « ${e} » se lit dans « ${source.key} » (${source.capability}), qui rend une LISTE sans `
            + "identifiant sûr : l'attente échouerait à l'exécution. Donner un TYPE:id déjà connu du contexte, ou laisser "
            + "l'entité vide et cibler l'attente par `subject` (fragment du titre ou de l'objet attendu) et `from`."));
        }
      }
    }
  }

  // ── LA CONDITION ──────────────────────────────────────────────────────────────────
  //
  // Observer l'issue d'une étape, c'est en dépendre : la dépendance est implicite, comme
  // pour l'éventail. Le reste est de la cohérence de FORME, refusée ici plutôt que découverte
  // à l'exécution par une étape qui ne partirait jamais sans dire pourquoi.
  if (s.when) {
    const w = s.when;
    const amontConnu = vues.has(w.step) || acquises.has(w.step);
    if (!w.step || !amontConnu) {
      issues.push(issue("INVALID_SHAPE", s.key,
        `la condition observe « ${w.step} », qui n'est pas une étape du plan.`));
    } else {
      if (w.step === s.key) {
        issues.push(issue("INVALID_SHAPE", s.key, "une étape ne peut pas conditionner son propre départ."));
      }
      const amont = plan.steps.find((x) => x.key === w.step);
      const typeAmont = amont ? (amont.nodeType ?? (amont.capability ? "CAPABILITY" : "WORKER")) : null;
      if ((w.outcome === "EVENT" || w.outcome === "TIMEOUT") && typeAmont && typeAmont !== "WAIT_EVENT") {
        /**
         * ── LE REFUS NOMME L'ISSUE JUSTE (§118.19) ────────────────────────────────────
         *
         * MESURÉ, mission `ambigue-042` : le plan branchait `outcome: EVENT` derrière un
         * WAIT_INPUT. Le refus disait la faute et pas le remède ; le planificateur a refait
         * le même plan, et la mission est morte. EVENT et TIMEOUT sont les deux issues d'une
         * attente d'ÉVÉNEMENT — celle qui peut se régler par un fait OU par le temps. Une
         * question posée à quelqu'un (WAIT_INPUT) n'a pas ces deux sorties : elle aboutit,
         * ou pas. Le refus donne donc l'issue à écrire, en toutes lettres.
         */
        const juste = typeAmont === "WAIT_INPUT"
          ? `une question à quelqu'un aboutit ou n'aboutit pas : écris outcome: "DONE" (la réponse est là) ou "SKIPPED"`
          : `pour un nœud ${typeAmont}, les issues possibles sont "DONE", "FAILED" et "SKIPPED"`;
        issues.push(issue("INVALID_SHAPE", s.key,
          `l'issue ${w.outcome} n'a de sens qu'après une attente d'événement (WAIT_EVENT, qui peut se régler par un fait ou par le temps) ; `
          + `« ${w.step} » est un nœud ${typeAmont} — ${juste}.`));
      }
      if (w.op && !w.path) {
        issues.push(issue("INVALID_SHAPE", s.key, `l'opérateur « ${w.op} » exige un champ (path) de la sortie amont.`));
      }
      if (w.op && !["exists", "empty"].includes(w.op) && (w.value === undefined || w.value === "")) {
        issues.push(issue("INVALID_SHAPE", s.key, `l'opérateur « ${w.op} » exige une valeur de comparaison.`));
      }
      if (w.path && !w.op) {
        issues.push(issue("INVALID_SHAPE", s.key, "un champ (path) sans opérateur ne teste rien — préciser op (exists, eq, gt…)."));
      }
      if (!w.outcome && !w.op) {
        issues.push(issue("INVALID_SHAPE", s.key, "une condition doit attendre une issue (outcome) ou tester la sortie (path/op)."));
      }
      if (!dependsOn.includes(w.step)) dependsOn.push(w.step);
    }
  }

  if (dependsOn.length > PLAN_LIMITS.depsPerStep) {
    issues.push(issue("LIMIT_EXCEEDED", s.key,
      `${dependsOn.length} dépendances dépassent la limite de ${PLAN_LIMITS.depsPerStep}. `
      + `Une jonction (JOIN) exprime la même chose sans rendre le graphe illisible.`));
  }
  for (const d of dependsOn) {
    // Une clé ACQUISE est une étape d'un plan antérieur, terminée, dont le résultat est en
    // base. Le moteur la résout ; le compilateur n'a aucune raison de la refuser.
    if (!vues.has(d) && !acquises.has(d)) {
      issues.push(issue("UNKNOWN_DEPENDENCY", s.key, `dépend de « ${d} », qui n'existe pas dans le plan.`));
    }
  }

  // ── LA CARDINALITÉ (§26) ──────────────────────────────────────────────────────────
  //
  // La règle est simple, et c'est sa simplicité qui la rend sûre : une étape qui COMMUNIQUE
  // et qui n'est PAS un éventail ne peut avoir qu'un destinataire. Vouloir écrire à trente-
  // trois personnes se déclare avec `forEach` — ce qui produit trente-trois envois séparés,
  // trente-trois clés d'idempotence, trente-trois reçus.
  const input = entree;
  if (EFFECT_RANK[effect] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE) {
    const n = nbDestinataires(input);
    if (n > 1 && !s.forEach) {
      issues.push(issue("CARDINALITY", s.key,
        `${n} destinataires dans une seule étape « ${s.capability ?? nodeType} ». Un envoi individuel `
        + `par personne se déclare avec un éventail (forEach), jamais avec une liste : sinon les `
        + `${n} personnes se voient mutuellement, et un seul échec emporte les ${n} envois.`));
    }
    if (n > 1 && s.forEach) {
      issues.push(issue("CARDINALITY", s.key,
        `l'étape est déjà déployée en éventail et porte pourtant ${n} destinataires : chaque `
        + `itération enverrait à tout le monde.`));
    }
  }

  compiled.push({
    key: s.key,
    title: s.title || s.key,
    workstream: s.workstream ?? null,
    nodeType,
    capability: s.capability ?? null,
    input,
    dependsOn,
    effect,
    idempotent,
    // UNE ÉCRITURE NON REJOUABLE EXIGE UNE CLÉ. C'est la seule chose qui empêche un crash à
    // l'étape 73 de renvoyer les soixante-douze e-mails précédents (§15).
    needsIdempotencyKey: !idempotent && EFFECT_RANK[effect] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE,
    needsApproval: confirmation === "ALWAYS"
      || (confirmation === "POLICY_ENGINE" && EFFECT_RANK[effect] >= EFFECT_RANK.INTERNAL_REVERSIBLE_WRITE),
    maxAttempts: Math.min(Math.max(s.maxAttempts ?? 3, 1), 10),
    modelRole: nodeType === "WORKER" ? (s.modelRole ?? "standard") : null,
    forEach: s.forEach ?? null,
    waitFor: s.waitFor ?? null,
    spec: specDe(s),
    wave: 0,
  });
}
