/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN D'ANNULATION (mandat 6 §48) — pur : il ne lit rien, il n'écrit rien, il ORDONNE.
 *
 * ── LE DÉFAUT QUE CE MODULE EXISTE POUR EMPÊCHER ────────────────────────────────────────
 *
 * Adam met le dossier à AWAITING_ANPP lundi. Mardi, Yassine le passe à BLOCKED parce que
 * l'échantillon est refusé. Mercredi, on demande « annule ce qu'Adam a fait lundi ».
 *
 * L'annulation naïve réécrit l'ancienne valeur d'Adam — IN_PREPARATION — et efface le travail
 * de Yassine sans que personne ne le voie. Le dossier repart dans un état que plus aucune
 * personne vivante n'a voulu, et la trace dira qu'on a « annulé », ce qui est vrai et
 * catastrophique.
 *
 * D'où l'invariant, et c'est le seul qui compte dans ce fichier :
 *
 *   ON NE DÉFAIT UN CHANGEMENT QUE SI LA VALEUR ACTUELLE EST ENCORE CELLE QU'IL A ÉCRITE.
 *
 * Sinon, le geste est REFUSÉ, nommément, avec qui a changé quoi depuis. C'est le même principe
 * que la sauvegarde atomique de Live Office (§104.8 : sérialiser → RELIRE → écrire seulement si
 * la relecture passe), appliqué à un champ d'ERP au lieu d'un fichier.
 *
 * ── L'ORDRE, ET POURQUOI IL EST INVERSE ─────────────────────────────────────────────────
 *
 * Les gestes se défont du plus RÉCENT au plus ancien. Si Adam a écrit A → B puis B → C,
 * défaire dans l'ordre du journal donnerait C → B (bon) puis... B → A appliqué à un champ qui
 * vaut B : correct par chance. Mais si les deux gestes portent sur des champs liés par une
 * règle de validation, l'ordre direct viole l'invariant à mi-chemin. L'ordre inverse rejoue
 * l'histoire à l'envers, ce qui est la seule façon de repasser par des états qui ont existé.
 * (Même raison que §104.4 : les suppressions se font en ordre DÉCROISSANT.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { classerGeste, natureDe, type NatureGeste, type Reversibilite } from "@/lib/annulation/reversibilite";

/** Un changement passé, tel que le journal le porte. Aucune notion de Prisma ici. */
export interface Changement {
  id: string;
  /** Qui l'a fait — `null` pour un geste système. */
  auteurId: string | null;
  auteurNom: string | null;
  /** Vrai quand c'est Adam qui a agi : c'est le périmètre par défaut d'une annulation. */
  parAdam: boolean;
  quand: Date;
  action: string;
  module: string;
  entite: string | null;
  entiteId: string | null;
  champ: string | null;
  avant: string | null;
  apres: string | null;
  resume: string | null;
}

/** Ce que vaut le champ MAINTENANT — lu par le pont, jamais deviné ici. */
export interface EtatActuel {
  entite: string;
  entiteId: string;
  champ: string;
  valeur: string | null;
}

export const REFUS = [
  /** Quelqu'un a changé la valeur depuis : la défaire écraserait son travail. */
  "MODIFIE_DEPUIS",
  /** La valeur actuelle n'a pas pu être lue — sans elle, on ne compare rien, donc on n'écrit rien. */
  "ETAT_INCONNU",
  /** Le geste n'est pas de ceux qui se retirent. */
  "NON_REVERSIBLE",
  /** Un autre module sait faire, et c'est lui qu'il faut appeler. */
  "A_DELEGUER",
  /** Le journal ne dit pas quoi réécrire (pas d'ancienne valeur, pas de cible). */
  "JOURNAL_INCOMPLET",
] as const;
export type MotifRefus = (typeof REFUS)[number];

export interface Geste {
  changementId: string;
  nature: NatureGeste;
  entite: string;
  entiteId: string;
  champ: string;
  /** Ce qu'on va écrire — l'ancienne valeur du changement. */
  valeurCible: string | null;
  /** Ce qu'on exige de trouver AVANT d'écrire. L'écriture est conditionnée à cette égalité. */
  valeurAttendue: string | null;
  /** La phrase à montrer à la personne AVANT qu'elle valide. */
  libelle: string;
  quand: Date;
}

export interface Ecarte {
  changementId: string;
  nature: NatureGeste;
  motif: MotifRefus;
  reversibilite: Reversibilite;
  /** La phrase exacte, avec les noms : « Yassine a mis BLOCKED le 3 septembre ». */
  explication: string;
  /** Ce qu'on peut faire à la place, quand quelque chose est possible. */
  compensation: string | null;
  delegueA: string | null;
}

export interface PlanAnnulation {
  gestes: Geste[];
  ecartes: Ecarte[];
  /**
   * LA PHRASE D'EN-TÊTE, calculée et non rédigée par un modèle : elle doit dire la vérité
   * arithmétique du lot. « 4 sur 7 » est l'information ; « annulé » serait un mensonge.
   */
  resume: string;
  /** VRAI seulement si TOUT est défaisable. Sert à interdire un « c'est annulé » abusif. */
  complet: boolean;
}

const jourFr = (d: Date): string => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

/**
 * COMPOSE LE PLAN.
 *
 * `etats` porte la valeur ACTUELLE de chaque champ visé ; un champ absent de cette liste est
 * traité comme INCONNU — jamais comme « probablement inchangé ». L'ignorance ne donne pas le
 * droit d'écrire : c'est la version §48 de « seul TROUVÉ autorise à agir » (§118.9).
 */
export function composer(
  changements: readonly Changement[],
  etats: readonly EtatActuel[],
  posterieurs: readonly Changement[] = [],
  /** Qui avait écrit (« Adam », « l'assistant ») — pour la phrase d'un changement survenu depuis. */
  agent = "Adam",
): PlanAnnulation {
  const cle = (e: string, i: string, c: string) => `${e}|${i}|${c}`;
  const actuel = new Map(etats.map((e) => [cle(e.entite, e.entiteId, e.champ), e.valeur]));

  // QUI A TOUCHÉ QUOI DEPUIS — indexé une fois, pour nommer l'auteur du conflit.
  const depuis = new Map<string, Changement[]>();
  for (const p of posterieurs) {
    if (!p.entite || !p.entiteId || !p.champ) continue;
    const k = cle(p.entite, p.entiteId, p.champ);
    depuis.set(k, [...(depuis.get(k) ?? []), p]);
  }

  const gestes: Geste[] = [];
  const ecartes: Ecarte[] = [];

  // DU PLUS RÉCENT AU PLUS ANCIEN — voir l'en-tête du fichier.
  const ordonnes = [...changements].sort((a, b) => b.quand.getTime() - a.quand.getTime());

  for (const c of ordonnes) {
    const nature = natureDe({ action: c.action, module: c.module, resume: c.resume, champ: c.champ });
    const v = classerGeste(nature);

    if (v.reversibilite === "DELEGUEE") {
      ecartes.push({
        changementId: c.id, nature, motif: "A_DELEGUER", reversibilite: v.reversibilite,
        explication: `${c.resume ?? c.module} — ${v.raison}`,
        compensation: v.compensation, delegueA: v.delegueA,
      });
      continue;
    }
    if (v.reversibilite === "IRREVERSIBLE" || v.reversibilite === "PAR_COMPENSATION") {
      ecartes.push({
        changementId: c.id, nature, motif: "NON_REVERSIBLE", reversibilite: v.reversibilite,
        explication: `${c.resume ?? c.module} — ${v.raison}`,
        compensation: v.compensation, delegueA: null,
      });
      continue;
    }

    // ── RÉVERSIBLE : reste à savoir si c'est encore SÛR ────────────────────────────────
    if (!c.entite || !c.entiteId || !c.champ || c.avant === undefined) {
      ecartes.push({
        changementId: c.id, nature, motif: "JOURNAL_INCOMPLET", reversibilite: v.reversibilite,
        explication: `le journal ne dit pas quel champ de quel enregistrement remettre (${c.resume ?? c.module})`,
        compensation: "retrouver l'enregistrement à la main, puis corriger depuis son écran",
        delegueA: null,
      });
      continue;
    }

    const k = cle(c.entite, c.entiteId, c.champ);
    if (!actuel.has(k)) {
      ecartes.push({
        changementId: c.id, nature, motif: "ETAT_INCONNU", reversibilite: v.reversibilite,
        explication: `la valeur actuelle de « ${c.champ} » n'a pas pu être lue : sans elle, écrire serait un pari`,
        compensation: null, delegueA: null,
      });
      continue;
    }

    const maintenant = actuel.get(k) ?? null;
    if (maintenant !== c.apres) {
      const auteurs = (depuis.get(k) ?? [])
        .filter((p) => p.quand > c.quand)
        .map((p) => `${p.auteurNom ?? "quelqu'un"} l'a mis à « ${p.apres ?? "vide"} » le ${jourFr(p.quand)}`);
      ecartes.push({
        changementId: c.id, nature, motif: "MODIFIE_DEPUIS", reversibilite: v.reversibilite,
        explication: auteurs.length
          ? `« ${c.champ} » a changé depuis : ${auteurs.join(" ; ")}. Le remettre à « ${c.avant ?? "vide"} » effacerait ce travail.`
          : `« ${c.champ} » vaut « ${maintenant ?? "vide"} » alors ${/^[aeiouyéh]/i.test(agent) ? "qu'" : "que "}${agent} y avait laissé « ${c.apres ?? "vide"} » : quelque chose a changé entre-temps.`,
        compensation: "reprendre la valeur voulue à la main, en connaissance du changement",
        delegueA: null,
      });
      continue;
    }

    gestes.push({
      changementId: c.id, nature,
      entite: c.entite, entiteId: c.entiteId, champ: c.champ,
      valeurCible: c.avant, valeurAttendue: c.apres,
      libelle: `${c.entite} ${c.entiteId.slice(0, 8)} · « ${c.champ} » : « ${c.apres ?? "vide"} » → « ${c.avant ?? "vide"} »`,
      quand: c.quand,
    });
  }

  const n = changements.length;
  const complet = n > 0 && ecartes.length === 0;
  const resume = n === 0
    ? "Aucun changement à défaire sur ce périmètre."
    : complet
      ? `${gestes.length} changement(s) sur ${n} peuvent être défaits — la totalité.`
      : `${gestes.length} changement(s) sur ${n} peuvent être défaits. ${ecartes.length} ne le peuvent pas, et chacun dit pourquoi.`;

  return { gestes, ecartes, resume, complet };
}

/**
 * LE COMPTE RENDU D'APPLICATION.
 *
 * Il est arithmétique, comme le contrôle qualité des missions (§118.10) : « tout a tourné »
 * n'est pas « tout est défait ». Un geste qui échoue à l'écriture — parce que la valeur a
 * changé entre la composition du plan et son application, ce qui arrive — sort ici, et le
 * résumé le compte.
 */
export interface CompteRendu {
  defaits: number;
  echoues: { changementId: string; pourquoi: string }[];
  ecartes: number;
  resume: string;
}

export function conclure(plan: PlanAnnulation, echoues: readonly { changementId: string; pourquoi: string }[]): CompteRendu {
  const defaits = plan.gestes.length - echoues.length;
  const parts = [`${defaits} changement(s) défait(s)`];
  if (echoues.length) parts.push(`${echoues.length} refusé(s) à l'écriture (la valeur avait encore changé)`);
  if (plan.ecartes.length) parts.push(`${plan.ecartes.length} non défaisable(s)`);
  return {
    defaits,
    echoues: [...echoues],
    ecartes: plan.ecartes.length,
    resume: `${parts.join(", ")}. ${plan.ecartes.length || echoues.length ? "Ce n'est PAS une annulation complète." : "Le périmètre demandé est revenu à son état antérieur."}`,
  };
}
