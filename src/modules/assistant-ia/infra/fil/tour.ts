import type { CurrentUser } from "@/lib/session";
import { compileContext } from "../contexte";
import { accesAssistantIa, getRoleConfig, resoudreConsignesRole, Revelateur } from "../role-config";
import { consigneFamilles, type AccesIa } from "../../domaine/acces-regles";
import { consigneGestesFermes, outilsV1, type MemoireProposee, type PropositionPreparee } from "../outils-v1";
import { consigneTravaux, outilTravailPour } from "../travaux";
import { selectionDuTour, type SelectionDuTour } from "../selection";
import { CONSIGNE_SELECTION, OUTIL_TROUVER } from "../../domaine/selection-outils";
import { historiqueDansEnveloppe } from "../../domaine/assembleur";
import { sectionResume } from "../../domaine/fil/resume";
import { roleDuTour } from "@/platform/ia/modeles-roles";
import { CONSIGNE_ATELIER } from "../atelier/outils";
import { outilConversationsPassees } from "../conversations/outil";
import { DELAI_MODELE_MS, IA_NON_CONFIGUREE } from "../modele";
import { modelesEffectifs } from "../generer";
import { composantsEnBlocs, IaCoupee, lireReponseModele, piecesDuMessage, repondreAvecSecours } from "../repondre";
import { auNomDe, lireReglagesAssistantIa, PlafondIaAtteint } from "../consommation";
import { retirerCaduquesAvantLeTour } from "@/platform/ia/intentions/action-intents";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import type { VueSimulation } from "../../domaine/simulation";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { lirePieces, type DependancesLecture } from "../lecture/pieces";
import { ProvenanceDuTour } from "../provenance";
import { JeuxDuTour } from "../analyse/outils";
import { noteChiffresNonSources } from "../../domaine/analyse/chiffres";
import { outilsDAnalyseVoulus } from "../../domaine/analyse/intention";
import { avecTrace } from "../qualite/traces";
import { chargerModelesRoles } from "../qualite/modeles";
import type { LecturePiece } from "../../domaine/lecture/regles";
import {
  censurerTexte, CoffretDuTour, CONSIGNE_JETONS, masquerReperesPartiels, sansValeursRevelees,
} from "../../domaine/filtre-confidentialite";

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
  /** J7 : le diff réel de la simulation (capacités simulables) — ou « non simulable », dit. */
  simulation?: VueSimulation;
  fields?: { label: string; value: string }[];
  status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
  resultLink?: string;
  resultMessage?: string;
}

export type ResultatDuTour =
  | {
    ok: true; content: string; blocs: WorkspaceBlock[]; memoireProposee: MemoireProposee | null; outilsAppeles: string[]; intent: IntentionDuTour | null;
    /** « Mes notes » (décision 0026) : les modifications de notes PROPOSÉES pendant le tour — la carte de la conversation. */
    notesProposees: string[];
  }
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
  /** J4 : le résumé roulant des échanges plus anciens que `historique` (le fil le garde). */
  resume?: string | null;
  /** J14 : la trace rejouable du tour — la réponse (et le message) auxquels elle se rattache. Absente : pas de trace. */
  trace?: { tourId: string; messageId?: string | null };
  /** Décision 0027 : conversation PRIVÉE — ni mémoire lue, ni mémoire proposée, ni conversations passées. */
  prive?: boolean;
  /** Décision 0027 : la section du DOSSIER de la conversation (consignes, documents encore ouvrables). */
  sectionDossier?: string | null;
}

/** Ce qu'une conversation privée dit au modèle (dans la partie variable : le préfixe stable ne bouge pas). */
export const CONSIGNE_PRIVEE = "### CONVERSATION PRIVÉE\nL'utilisateur a ouvert une conversation privée : tu n'as pas sa mémoire, tu ne proposes RIEN à retenir et tu ne cherches pas dans ses autres conversations. Elle sera supprimée dans 30 jours.";

/** Les appels de modèle du tour — et ceux que ses outils déclenchent — sont imputés à la personne. */
export function jouerTour(user: CurrentUser, d: DemandeDuTour): Promise<ResultatDuTour & { message: string }> {
  const jouer = () => auNomDe(user.id, () => tourAuNomDe(user, d), d.conversation ?? null);
  return d.trace ? avecTrace(d.trace, user.id, jouer) : jouer();
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

  // J4 : le modèle du geste — effort de raisonnement bas pour une question, plus haut pour une analyse.
  await chargerModelesRoles();
  const modeles = modelesEffectifs(roleDuTour({ texte: texteSaisi, pieces: pieces.length }));
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
  const propositions: PropositionPreparee[] = [];
  const sorties: string[] = [];
  const memoires: MemoireProposee[] = [];
  const notesProposees: string[] = [];
  // K1 (décision 0031) : les jeux de données que le tour a lus, et les analyses CALCULÉES par le code (posées sous la réponse).
  const blocsCalcules: WorkspaceBlock[] = [];
  const analyse = { jeux: new JeuxDuTour(), blocs: blocsCalcules, pieces: pieces.map((p) => ({ id: p.id, nom: p.nom })), question: texteSaisi };
  // LE COFFRET DU TOUR (décision 0012) : les valeurs sensibles lues par les outils y restent ; le modèle n'en a que les repères.
  const coffret = new CoffretDuTour();
  let outils;
  let selection: SelectionDuTour;
  try {
    acces = await accesAssistantIa(user);
    config = await getRoleConfig(user.role);
    // J2 : « lancer_un_travail » — une demande qui dépasse un tour devient un travail (plan à approuver).
    // J6 : avec les CAPACITÉS de l'ERP (registre dérivé du contrat) — enregistrées toutes, seules les actives partent.
    // J14 : ce que le tour lit d'un tiers, face à ce que la personne a écrit — une carte dit ses valeurs d'origine tierce.
    const provenance = new ProvenanceDuTour([texteSaisi, ...saisie.historique.filter((h) => h.role === "user").map((h) => h.content)], message);
    outils = [...outilsV1(user, propositions, sorties, memoires, coffret, acces, { capacites: true, provenance, notesProposees, analyse }), outilTravailPour(user)];
    // Décision 0027 : la mémoire est commune à toutes les conversations — sauf une conversation PRIVÉE, qui ne la lit
    // ni ne l'écrit (pas de carte « Retenir », pas de recherche dans les conversations passées).
    outils = d.prive ? outils.filter((o) => o.def.name !== "proposer_memoire") : [...outils, outilConversationsPassees(user, d.conversation ?? null)];
    // J4 : les outils choisis à la demande — le socle, la présélection par la demande, et `trouver_outil`.
    const precedente = [...saisie.historique].reverse().find((h) => h.role === "user")?.content ?? "";
    selection = selectionDuTour(outils, user, message, config, precedente, outilsDAnalyseVoulus(texteSaisi, analyse.pieces));
    outils.push(selection.outil);
    // LE PRÉFIXE STABLE (J4) : identité, règles, présentation, consignes générales, puis la personne ; la partie
    // variable du tour (indice de travail long, résumé de la conversation, heure) ferme la consigne.
    const sauf = (xs: (string | null | undefined)[]) => xs.filter((c): c is string => !!c);
    instructions = (await compileContext({
      user, consignesRole: resoudreConsignesRole(config),
      consignesGenerales: sauf([CONSIGNE_JETONS, CONSIGNE_SELECTION, CONSIGNE_ATELIER, d.consigne]),
      consignesPersonne: sauf([consigneFamilles(acces), consigneGestesFermes(user)]),
      outilsActifs: selection.initiaux, question: texteSaisi, sansMemoire: d.prive === true,
      sectionsDuTour: sauf([consigneTravaux(texteSaisi), d.sectionDossier, d.prive ? CONSIGNE_PRIVEE : null, sectionResume(d.resume)]),
    })).systemPrompt;
  } catch (e) {
    // ÉCHEC FERMÉ (Q17) : sans contexte, l'agent ne sait pas qui lui parle — il ne répond pas.
    console.error("[assistant] contexte indisponible", e);
    return { ok: false, error: "Service momentanément indisponible. Réessayez dans un instant.", message };
  }
  const libelles = new Map(outils.map((o) => [o.def.name, o.label]));
  try {
    const r = await repondreAvecSecours({
      // L'historique dans son ENVELOPPE (J4) : les échanges les plus récents, le reste est au résumé roulant.
      user, message, historique: historiqueDansEnveloppe(saisie.historique), instructions,
      origine: d.conversation ? "fil" : "conversation", conversation: d.conversation ?? null,
      outils, modeles, delaiMs: d.delaiMs ?? DELAI_MODELE_MS, config,
      actifs: selection.actifs, cleCache: `assistant-ia:${user.id}`,
      propositionsFaites: () => propositions.length,
      maxEtapes: d.maxEtapes,
      // En flux, un repère n'est pas encore jugé : il s'affiche « ••• » jusqu'à la réponse finale.
      surTexte: d.surTexte ? (brut) => d.surTexte!(masquerReperesPartiels(brut)) : undefined,
      // `trouver_outil` est de la cuisine du tour : la personne ne lit que ce qui a été CONSULTÉ.
      surOutil: d.surOutil ? (nom) => { if (nom !== OUTIL_TROUVER) d.surOutil!(libelles.get(nom) ?? nom); } : undefined,
    });
    if (r.echecs.length) console.warn("[assistant] modèles abandonnés", r.echecs);
    // J4 : ce que la présélection n'avait pas vu — le banc et l'exploitation y lisent où affiner les mots des outils.
    if (selection.trouves().length) console.info("[assistant] outils trouvés en cours de tour", selection.trouves());
    // R5 : le modèle a choisi ses composants ; seuls ceux que les outils du tour prouvent restent.
    const ui = composantsEnBlocs(lireReponseModele(r.texte), { sorties, question: message, contexte: instructions });
    if (ui.retires.length) console.warn("[assistant] composants retirés", ui.retires);
    // K1 : après une analyse, un chiffre du MESSAGE que rien ne prouve est dit sous la réponse (et compté par le banc).
    const note = blocsCalcules.length ? noteChiffresNonSources(ui.message, [...sorties, message]) : null;
    if (note) console.warn("[assistant] chiffres non sourcés", note.chiffres);
    const p = propositions[0];
    // LA RÉVÉLATION, AVANT D'AFFICHER ET DE STOCKER : chaque repère devient la valeur pour qui a le droit de
    // la voir (politique du coffre, journal), « [confidentiel] » sinon.
    const revelateur = new Revelateur(coffret, user, acces);
    return {
      ok: true,
      message,
      content: await revelateur.texte([ui.message || "Je n'ai pas de réponse à afficher.", note?.texte].filter(Boolean).join("\n\n")),
      blocs: await revelateur.objet([...ui.blocs, ...blocsCalcules]),
      memoireProposee: d.prive ? null : memoires[0] ?? null,
      notesProposees: [...notesProposees],
      // Ce que la personne lit : « Annuaire consulté », jamais « directory_lookup ».
      outilsAppeles: [...new Set(r.outilsAppeles.filter((n) => n !== OUTIL_TROUVER).map((n) => libelles.get(n) ?? n))],
      intent: p ? {
        id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields,
        ...(p.proposition.warnings?.length ? { warnings: p.proposition.warnings } : {}),
        ...(p.proposition.confirmText ? { confirmText: p.proposition.confirmText } : {}),
        ...(p.proposition.libelleBouton ? { libelleBouton: p.proposition.libelleBouton } : {}),
        ...(p.proposition.simulation ? { simulation: p.proposition.simulation } : {}),
        ...(p.proposition.formulaire ? { formulaire: p.proposition.formulaire } : {}),
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
