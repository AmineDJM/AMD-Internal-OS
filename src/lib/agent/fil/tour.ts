import type { CurrentUser } from "@/lib/session";
import { compileContext } from "@/lib/agent/contexte";
import { accesAssistantIa, getRoleConfig, resoudreConsignesRole, Revelateur } from "@/lib/agent/role-config";
import { consigneFamilles, type AccesIa } from "@/lib/agent/acces-regles";
import { consigneGestesFermes, outilsV1, type MemoireProposee, type PropositionPreparee } from "@/lib/agent/outils-v1";
import { consigneTravaux, outilTravailPour } from "@/lib/agent/travaux";
import { DELAI_MODELE_MS, IA_NON_CONFIGUREE } from "@/lib/agent/modele";
import { modelesEffectifs } from "@/lib/agent/generer";
import { composantsEnBlocs, IaCoupee, lireReponseModele, piecesDuMessage, repondreAvecSecours } from "@/lib/agent/repondre";
import { auNomDe, lireReglagesAssistantIa, PlafondIaAtteint } from "@/lib/agent/consommation";
import { retirerCaduquesAvantLeTour } from "@/lib/assistant/action-intents";
import type { WorkspaceBlock } from "@/lib/assistant/workspace/protocol";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { lirePieces, type DependancesLecture } from "@/lib/agent/lecture/pieces";
import type { LecturePiece } from "@/lib/agent/lecture/regles";
import {
  censurerTexte, CoffretDuTour, CONSIGNE_JETONS, masquerReperesPartiels, sansValeursRevelees,
} from "@/lib/agent/filtre-confidentialite";

/**
 * UN TOUR DE L'ASSISTANT IA — la même règle, qu'il soit joué dans la requête (ancienne action de l'écran)
 * ou EN ARRIÈRE-PLAN, dans le fil gardé (`fil/service.ts`).
 *
 * Les pièces sont revérifiées ici, puis LUES (`lecture/pieces.ts` : texte, OCR local, vision,
 * transcription — coffre refusé, données sensibles masquées, limites dites), le contexte compilé sous les droits de la personne,
 * l'UI générative filtrée par ce que les outils du tour prouvent. Une écriture n'est qu'une CARTE :
 * rien ne s'exécute sans le geste de confirmation.
 */
export interface IntentionDuTour {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  warnings?: string[];
  confirmText?: string;
  libelleBouton?: string;
  fields?: { label: string; value: string }[];
  status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
  resultLink?: string;
  resultMessage?: string;
}

export type ResultatDuTour =
  | { ok: true; content: string; blocs: WorkspaceBlock[]; memoireProposee: MemoireProposee | null; outilsAppeles: string[]; intent: IntentionDuTour | null }
  | { ok: false; error: string };

export interface DemandeDuTour {
  texte: string;
  pieces: unknown;
  historique: { role: "user" | "assistant"; content: string }[];
  /** Arrière-plan : la requête ne tient plus le tour, il peut durer (tâches longues, à étapes). */
  delaiMs?: number;
  maxEtapes?: number;
  /** Le texte lu jusqu'ici (brut du modèle) — pour l'afficher pendant qu'il s'écrit. */
  surTexte?: (brut: string) => void;
  /** Un outil appelé — dit par son libellé (« Annuaire consulté »), jamais par son nom technique. */
  surOutil?: (libelle: string) => void;
  /** Consigne ajoutée au contexte du tour (le fil s'en sert pour les tâches longues). */
  consigne?: string;
  /** Le fil (conversation) auquel appartient le tour — pour le journal de consommation. */
  conversation?: string | null;
  /** Le message a été DIT (vocal transcrit) : le modèle le sait, une transcription peut écorcher un nom. */
  vocal?: boolean;
  /** Ce que la lecture des pièces a donné — le fil le garde et l'écran le montre sous le message. */
  surLecture?: (lectures: LecturePiece[]) => Promise<void> | void;
  /** RÉSERVÉ AUX BANCS : les gestes de lecture (Drive, OCR, vision, transcription) remplacés. */
  lecture?: DependancesLecture;
}

/** Les appels de modèle du tour — et ceux que ses outils déclenchent — sont imputés à la personne. */
export function jouerTour(user: CurrentUser, d: DemandeDuTour): Promise<ResultatDuTour & { message: string }> {
  return auNomDe(user.id, () => tourAuNomDe(user, d), d.conversation ?? null);
}

/**
 * LE FILTRE SUR CE QUE LA PERSONNE ÉCRIT (IA-ASSISTANT-09, décision de Direction — option prudente par
 * défaut, réglage `censurerSaisie`) : le message saisi et l'historique passent `censurerTexte` avant
 * le modèle, comme le faisait l'ancienne couche de contexte. Un IBAN collé dans un e-mail ne part pas
 * chez MiMo — et ne repart pas à chaque tour suivant par l'historique. Le revers, assumé : la personne
 * ne peut plus dicter volontairement une coordonnée bancaire à l'assistant (Q12 à confirmer).
 */
export function filtrerSaisie(
  texte: string,
  historique: DemandeDuTour["historique"],
  actif: boolean,
): { texte: string; historique: DemandeDuTour["historique"]; masques: number } {
  // LES RÉPONSES DE L'ASSISTANT, TOUJOURS (décision 0012) : une valeur qu'il a RÉVÉLÉE à la personne (salaire,
  // IBAN) ne repart pas au modèle par l'historique — elle redevient « [confidentiel] », réglage ou pas.
  const reponses = historique.map((e) => (e.role === "assistant" ? { ...e, content: censurerTexte(sansValeursRevelees(e.content)).texte } : e));
  if (!actif) return { texte, historique: reponses, masques: 0 };
  const t = censurerTexte(texte);
  let masques = t.occurrences;
  const h = reponses.map((e) => {
    const c = censurerTexte(e.content);
    masques += c.occurrences;
    return { ...e, content: c.texte };
  });
  return { texte: t.texte, historique: h, masques };
}

async function tourAuNomDe(user: CurrentUser, d: DemandeDuTour): Promise<ResultatDuTour & { message: string }> {
  const reglages = await lireReglagesAssistantIa();
  // LES PIÈCES DU MESSAGE : revérifiées (la personne les VOIT), puis LUES — après les portes qui
  // peuvent refuser sans rien dépenser (message vide, aucun modèle, interrupteur coupé).
  const pieces = await piecesDuMessage(user, d.pieces);
  const saisie = filtrerSaisie((d.texte ?? "").trim(), d.historique, reglages.censurerSaisie);
  const texteSaisi = saisie.texte;
  const dit = d.vocal && texteSaisi ? `[Message vocal, transcrit automatiquement — un nom propre peut y être écorché]\n${texteSaisi}` : texteSaisi;
  if (!dit && !pieces.length) return { ok: false, error: "Message vide.", message: dit };

  const modeles = modelesEffectifs();
  if (modeles.length === 0) return { ok: false, error: IA_NON_CONFIGUREE, message: dit };
  if (pieces.length && (await interrupteurIaCoupe())) return { ok: false, error: REFUS_IA_COUPEE, message: dit };

  const lues = pieces.length ? await lirePieces(user, pieces, texteSaisi, d.lecture) : null;
  if (lues) await d.surLecture?.(lues.lectures);
  const message = lues ? `${dit || "(pièces jointes sans texte)"}\n\n${lues.pourModele}` : dit;

  // LES CARTES DONT LA PERSONNE VIENT DE REPARLER N'ONT PLUS COURS (IA-ASSISTANT-10, décision de Direction
  // — option prudente par défaut, réglage `retirerCartesCaduques`) : le remède qu'Adam applique depuis
  // le défaut mesuré en banc (« non, finalement Amel, lundi » → la carte « Raihana, vendredi » restait
  // cliquable). Une carte retirée se redemande ; une mauvaise action exécutée ne se reprend pas.
  if (reglages.retirerCartesCaduques) await retirerCaduquesAvantLeTour(user.id, texteSaisi);

  let instructions: string;
  let config;
  // LES ACCÈS RÉGLÉS PAR LA DIRECTION (décision 0012), relus à chaque tour : un réglage changé vaut dès maintenant.
  let acces: AccesIa;
  try {
    acces = await accesAssistantIa(user);
    config = await getRoleConfig(user.role);
    instructions = (await compileContext({ user, consignesRole: resoudreConsignesRole(config) })).systemPrompt;
    if (d.consigne) instructions = `${instructions}\n\n${d.consigne}`;
    instructions = `${instructions}\n\n${CONSIGNE_JETONS}`;
    for (const c of [consigneFamilles(acces), consigneGestesFermes(user), consigneTravaux(texteSaisi)]) if (c) instructions = `${instructions}\n\n${c}`;
  } catch (e) {
    // ÉCHEC FERMÉ (Q17) : sans contexte, l'agent ne sait pas qui lui parle — il ne répond pas.
    console.error("[assistant] contexte indisponible", e);
    return { ok: false, error: "Service momentanément indisponible. Réessayez dans un instant.", message };
  }

  const propositions: PropositionPreparee[] = [];
  const sorties: string[] = [];
  const memoires: MemoireProposee[] = [];
  // LE COFFRET DU TOUR (décision 0012) : les valeurs sensibles lues par les outils y restent ; le modèle n'en a que les repères.
  const coffret = new CoffretDuTour();
  // J2 : « lancer_un_travail » — une demande qui dépasse un tour devient un travail (plan à approuver).
  const outils = [...outilsV1(user, propositions, sorties, memoires, coffret, acces), outilTravailPour(user)];
  const libelles = new Map(outils.map((o) => [o.def.name, o.label]));
  try {
    const r = await repondreAvecSecours({
      user, message, historique: saisie.historique, instructions,
      origine: d.conversation ? "fil" : "conversation", conversation: d.conversation ?? null,
      outils, modeles, delaiMs: d.delaiMs ?? DELAI_MODELE_MS, config,
      propositionsFaites: () => propositions.length,
      maxEtapes: d.maxEtapes,
      // En flux, un repère n'est pas encore jugé : il s'affiche « ••• » jusqu'à la réponse finale.
      surTexte: d.surTexte ? (brut) => d.surTexte!(masquerReperesPartiels(brut)) : undefined,
      surOutil: d.surOutil ? (nom) => d.surOutil!(libelles.get(nom) ?? nom) : undefined,
    });
    if (r.echecs.length) console.warn("[assistant] modèles abandonnés", r.echecs);
    // R5 : le modèle a choisi ses composants ; seuls ceux que les outils du tour prouvent restent.
    const ui = composantsEnBlocs(lireReponseModele(r.texte), { sorties, question: message, contexte: instructions });
    if (ui.retires.length) console.warn("[assistant] composants retirés", ui.retires);
    const p = propositions[0];
    // LA RÉVÉLATION, AVANT D'AFFICHER ET DE STOCKER : chaque repère devient la valeur pour qui a le droit de
    // la voir (politique du coffre, journal), « [confidentiel] » sinon.
    const revelateur = new Revelateur(coffret, user, acces);
    return {
      ok: true,
      message,
      content: await revelateur.texte(ui.message || "Je n'ai pas de réponse à afficher."),
      blocs: await revelateur.objet(ui.blocs),
      memoireProposee: memoires[0] ?? null,
      // Ce que la personne lit : « Annuaire consulté », jamais « directory_lookup ».
      outilsAppeles: [...new Set(r.outilsAppeles.map((n) => libelles.get(n) ?? n))],
      intent: p ? {
        id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields,
        ...(p.proposition.warnings?.length ? { warnings: p.proposition.warnings } : {}),
        ...(p.proposition.confirmText ? { confirmText: p.proposition.confirmText } : {}),
        ...(p.proposition.libelleBouton ? { libelleBouton: p.proposition.libelleBouton } : {}),
        status: "PROPOSED",
      } : null,
    };
  } catch (e) {
    if (e instanceof IaCoupee || e instanceof PlafondIaAtteint) return { ok: false, error: e.message, message };
    console.error("[assistant] aucun modèle n'a répondu", e);
    return { ok: false, error: "L'assistant n'a pas pu répondre. Réessayez dans un instant.", message };
  }
}

// La révélation vit avec les accès (`role-config.ts`) : la carte et la confirmation la consultent aussi.
export { Revelateur };
