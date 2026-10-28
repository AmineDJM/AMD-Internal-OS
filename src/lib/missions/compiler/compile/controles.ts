/**
 * Compilateur de mission — LES CONTRÔLES DU PLAN ENTIER, après le graphe : un plan qui ne produit
 * rien, un plan qui ne touche aucune source, et plusieurs réponses humaines attendues qui ne disent
 * pas ce qu'elles attendent.
 */
import { issue } from "@/lib/missions/compiler/compile/outils";
import type { ContexteCompilation } from "@/lib/missions/compiler/compile/etape";

export function planSansProduction(ctx: ContexteCompilation): void {
  const { plan, issues, compiled } = ctx;
  /**
   * ── UN PLAN QUI NE FAIT RIEN N'EST PAS UN PLAN ──────────────────────────────────────
   *
   * Run Render, scénario RECOURS : le juge refuse l'objectif, la replanification tourne, et le
   * plan v2 est UN SEUL nœud JOIN — « clôturer la restitution déjà réalisée ». Un JOIN attend
   * ses dépendances ; sans dépendance, il est DONE à l'instant où il naît. Le plan a été
   * compilé, matérialisé, exécuté en zéro milliseconde, et le juge a relu exactement le même
   * dossier pour rendre exactement le même refus. Une version de plan et deux appels de modèle
   * consommés pour rien.
   *
   * Un plan doit contenir au moins une étape qui PRODUIT quelque chose — un appel, un travail
   * de modèle, un fichier, une attente d'information nouvelle. Les nœuds de structure (JOIN,
   * QA, APPROVAL) organisent ce que d'autres produisent ; seuls, ils n'organisent rien. Le
   * refus renvoie le planner vers la seule sortie utile : une étape qui apporte la preuve
   * manquante, ou aucun plan du tout — et « aucun plan » est une réponse honnête, que
   * l'appelant sait conclure.
   */
  const productives = new Set(["CAPABILITY", "WORKER", "ARTIFACT", "WAIT_EVENT", "WAIT_INPUT"]);
  if (compiled.length > 0 && !compiled.some((c) => productives.has(c.nodeType))) {
    issues.push(issue("INVALID_SHAPE", null,
      `aucune des ${compiled.length} étape(s) ne produit quoi que ce soit : uniquement des nœuds `
      + `de structure (JOIN/QA/APPROVAL). Un plan doit contenir au moins une étape qui apporte `
      + `une information ou un effet nouveau — sinon, ne rends AUCUN plan.`));
  }
}

export function planSansSource(ctx: ContexteCompilation): void {
  const { plan, issues, compiled } = ctx;
  /**
   * ── UN PLAN QUI NE TOUCHE AUCUNE SOURCE NE PEUT RIEN AFFIRMER ───────────────────────
   *
   * ── LE DÉFAUT, MESURÉ ─────────────────────────────────────────────────────────────
   *
   * Le garde ci-dessus exige qu'une étape PRODUISE quelque chose — et il compte `WORKER`
   * parmi les productives, à juste titre : un travail de modèle produit du texte. Mais un plan
   * fait UNIQUEMENT de `WORKER` ne produit que cela : du texte tiré de la mémoire du modèle.
   * Aucune source lue, aucun fichier écrit, aucune donnée de l'entreprise touchée.
   *
   * Au banc d'autonomie, cette forme revient sur des demandes qui portent explicitement sur la
   * société — « où en est-on du budget », « qui a fait avancer les dossiers ». Le plan compile,
   * s'exécute, et rend une réponse bien écrite sur une entreprise imaginaire. C'est le faux
   * succès le plus coûteux : il ne ressemble pas à une erreur.
   *
   * ── POURQUOI CETTE RÈGLE NE PEUT PAS REFUSER UN PLAN CORRECT ──────────────────────
   *
   * Elle n'exige pas de LECTURE (une mission peut légitimement n'écrire que), ni de capacité
   * (un nœud `ARTIFACT` produit un vrai fichier sans en porter). Elle refuse un seul cas :
   * QUE des étapes de raisonnement. Si la réponse ne demande ni source, ni pièce, ni effet,
   * ce n'est pas une mission — c'est une réponse de conversation, et le triage l'y renvoie.
   *
   * ── POURQUOI `MISSING_PRIMITIVE` NE SUFFIT PAS, ET C'EST MESURÉ ───────────────────
   *
   * La couverture des primitives (§56) semblait devoir attraper ce cas : un plan sans lecture
   * ne couvre pas INFORMATION. Elle ne le peut pas. `MARQUEURS.INFORMATION` est VIDE, sur
   * cette justification écrite dans `planner/primitives.ts` : « toute demande veut de
   * l'information, en faire une exigence n'apprendrait rien à personne ». Conséquence
   * mesurée sur dix demandes factuelles (« où en est-on du budget », « qui a fait avancer les
   * dossiers », « quels contrats arrivent à échéance ») : ZÉRO exigence INFORMATION, donc
   * zéro refus. La primitive jugée trop évidente pour être exigée est celle qu'on n'exige
   * jamais — et c'est par là que la mission répond de mémoire.
   *
   * Cette règle-ci ne lit pas la demande : elle regarde le PLAN. C'est ce qui la rend robuste
   * à un détecteur aveugle, et c'est pourquoi elle vit ici et non dans les marqueurs.
   *
   * Le refus repart au planificateur avec la seule issue utile : nommer la source.
   */
  if (compiled.length > 0 && compiled.every((c) => c.nodeType === "WORKER")) {
    issues.push(issue("INVALID_SHAPE", null,
      `les ${compiled.length} étape(s) du plan sont toutes des travaux de modèle : aucune ne lit `
      + `une source, n'appelle une capacité ni ne produit de pièce. Un plan de cette forme ne peut `
      + `répondre que de mémoire, donc inventer. Ajoute l'étape qui va CHERCHER la donnée — ou, si `
      + `aucune source disponible ne la porte, dis-le dans « gaps » plutôt que de conclure sans.`));
  }
}

export function attentesIndiscernables(ctx: ContexteCompilation): void {
  const { issues, compiled } = ctx;
  /**
   * ── PLUSIEURS RÉPONSES ATTENDUES : CHACUNE DOIT DIRE CE QU'ELLE ATTEND ───────────────
   *
   * MESURÉ sur le banc de la chaîne humaine, et c'est un faux succès du pire genre. Le plan
   * attendait deux retours :
   *
   *     attente:retour-nivolex     ← { event: MESSAGE_RECEIVED, from: "Amel Haddad"    }
   *     attente:retour-trastuzex   ← { event: MESSAGE_RECEIVED, from: "Raihana Cherif" }
   *
   * Raihana a répondu : « Nivolex : il manque le CPP légalisé. (Trastuzex NON TRAITÉ.) » —
   * et l'attente TRASTUZEX s'est réglée. Le message venait de la bonne personne ; il disait
   * exactement le contraire de ce qu'on attendait d'elle. La mission a compté une réponse
   * qu'elle n'a jamais reçue.
   *
   * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────
   *
   * Quand une mission attend PLUSIEURS réponses humaines, chacune doit porter un critère de
   * plus que l'expéditeur : le sujet attendu, l'entité concernée, le fil, ou la pièce exigée.
   * Sans cela, le premier message venu règle une branche au hasard parmi celles qu'il touche,
   * et « toutes les attentes sont levées » cesse de vouloir dire « tout est arrivé » (§118.10).
   *
   * ── POURQUOI SEULEMENT À PARTIR DE DEUX ─────────────────────────────────────────────
   *
   * Parce qu'une mission qui n'attend QU'UNE réponse ne peut pas se tromper de branche : le
   * risque existe (« je regarde ça demain » règle l'attente), mais il relève du jugement de
   * complétude, pas de la forme du plan. Refuser toute attente sans sujet interdirait le cas
   * légitime « préviens-moi dès qu'il répond », et une règle qu'on désactive ne protège rien.
   */
  const attentesHumaines = compiled.filter((c) => {
    const w = c.waitFor;
    if (!w || typeof w.from !== "string" || !w.from.trim()) return false;
    return !w.until; // une attente TEMPORELLE ne se règle pas sur un message
  });
  if (attentesHumaines.length >= 2) {
    for (const c of attentesHumaines) {
      const w = c.waitFor!;
      const discrimine = Boolean(w.subject || w.entity || w.threadId || w.attachment
        || (w.anyOf ?? []).some((b) => b.subject || b.entity || b.threadId || b.attachment)
        || (w.allOf ?? []).some((b) => b.subject || b.entity || b.threadId || b.attachment));
      if (discrimine) continue;
      issues.push(issue("INVALID_SHAPE", c.key,
        `cette mission attend ${attentesHumaines.length} réponses humaines, et « ${c.key} » n'attend `
        + `que « ${w.from} » — sans dire QUOI. N'importe quel message de cette personne la réglera, `
        + `y compris « je ne l'ai pas fait » : la mission compterait une réponse qu'elle n'a pas `
        + `reçue. Ajoute ce qui distingue CETTE attente — waitSubject (un fragment du sujet ou de `
        + `la référence attendue), waitEntity, waitThreadId ou waitAttachment.`));
    }
  }
}
