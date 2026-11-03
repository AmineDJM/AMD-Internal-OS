import { adamOuvert, CONSIGNE_ADAM_SA } from "../adam/outils-adam";
import type { CurrentUser } from "@/lib/session";
import { compileContext, CONSIGNE_MEMOIRE_A_LA_CARTE } from "../contexte";
import { profilDeLaPersonne } from "../profil-personne";
import { memoireAutoActive } from "../memoire";
import { OUTILS_NOTES } from "../notes/outils";
import { accesAssistantIa, getRoleConfig, GESTE_MODELE_EN_CLAIR, resoudreConsignesRole, Revelateur } from "../role-config";
import { consigneFamilles, enVueExacteIa, refusAssistantVueExacte, type AccesIa } from "../../domaine/acces-regles";
import { consigneGestesFermes, outilsV1, type MemoireProposee, type PropositionPreparee } from "../outils-v1";
import { consigneTravaux, outilsSousMissionsDuTour } from "../travaux";
import { outilsChantierPour } from "../chantiers";
import { selectionDuTour, type SelectionDuTour } from "../selection";
import { CONSIGNE_SELECTION, OUTIL_TROUVER } from "../../domaine/selection-outils";
import { historiqueDansEnveloppe } from "../../domaine/assembleur";
import { sectionResume } from "../../domaine/fil/resume";
import { roleDuTour } from "@/platform/ia/modeles-roles";
import { CONSIGNE_ATELIER } from "../atelier/outils";
import { outilConversationsPassees } from "../conversations/outil";
import { outilAttendrePieces } from "../canaux/outil";
import { DELAI_MODELE_MS, IA_NON_CONFIGUREE } from "../modele";
import { modelesEffectifs } from "../generer";
import { composantsEnBlocs, IaCoupee, lireReponseModele, piecesDuMessage, repondreAvecSecours } from "../repondre";
import { auNomDe, lireReglagesAssistantIa, PlafondIaAtteint } from "../consommation";
import { retirerCaduquesAvantLeTour, retirerCarteAnnuleeAvantLeTour } from "@/platform/ia/intentions/action-intents";
import { carteOraleEnAttente } from "../voix/carte-orale";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import type { VueSimulation } from "../../domaine/simulation";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "@/lib/ai-settings";
import { lirePieces, type DependancesLecture } from "../lecture/pieces";
import { ProvenanceDuTour } from "../provenance";
import { JeuxDuTour } from "../analyse/outils";
import { noteChiffresNonSources } from "../../domaine/analyse/chiffres";
import { CONSIGNE_BOITE_ADAM, canalAdamOuvert, taireCanalAdam } from "../../domaine/mails/canal";
import { CONSIGNE_FOND, CONSIGNE_MISSIONS, demandeDeFond, ETAPES_DE_FOND, noteActionsNonVerifiees, OUTILS_DE_FOND, outilsPilotageVoulus } from "../../domaine/missions/pilotage";
import { outilsMissions } from "../missions/pilotage";
import { outilsAnnulation } from "../annulation-directe";
import { outilsMails } from "../mails/boites";
import type { PowerTool } from "@/platform/ia/outil";
import { outilsDAnalyseVoulus } from "../../domaine/analyse/intention";
import { avecTrace } from "../qualite/traces";
import { chargerModelesRoles } from "../qualite/modeles";
import type { LecturePiece } from "../../domaine/lecture/regles";
import {
  censurerTexte, CoffretDuTour, CONSIGNE_EN_CLAIR, CONSIGNE_JETONS, masquerReperesPartiels, sansValeursRevelees,
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
  /** P1 (décision 0047) : l'aperçu réel des mails préparés (rendu du gabarit). */
  apercus?: { titre: string; html: string }[];
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
    /** K3 (décision 0033) : les sous-missions lancées pendant ce tour (la carte qui se met à jour). */
    travaux: string[];
  }
  /** F2 (MG-10) : `transitoire` — le modèle n'a pas répondu (délai, réseau) : le fil REPREND la demande, une fois. */
  | { ok: false; error: string; transitoire?: boolean };

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
  /**
   * P1 bis (décision 0047, banc d'audit Q1 MI-02) : le tour POSE UNE MISSION au lieu de faire le travail — demandé
   * (« en tâche de fond ») ou décidé par le serveur quand un tour a atteint son plafond de jetons.
   */
  modeFond?: boolean;
  /** K6 (décision 0036) : les PIÈCES ATTENDUES (WhatsApp, mail) — absente tant qu'aucune attente n'est ouverte. */
  sectionAttentes?: string | null;
}

/** Ce qu'une conversation privée dit au modèle (dans la partie variable : le préfixe stable ne bouge pas). */
export const CONSIGNE_PRIVEE = "### CONVERSATION PRIVÉE\nL'utilisateur a ouvert une conversation privée : tu n'as pas sa mémoire, RIEN de ce qu'il dit ici n'est retenu (dis-le s'il te demande de retenir) et tu ne cherches pas dans ses autres conversations. Elle sera supprimée dans 30 jours.";

/** Les appels de modèle du tour — et ceux que ses outils déclenchent — sont imputés à la personne. */
export function jouerTour(user: CurrentUser, d: DemandeDuTour): Promise<ResultatDuTour & { message: string }> {
  // S1 (décision 0048) : ÉCHEC FERMÉ — un tour ne se joue jamais sous une Vue exacte, quel que soit l'appelant : le corps
  // d'une action y porte le Super Admin réel (`visualise`), un rendu la personne vue (`impersonatedBy`). Ni l'un ni l'autre.
  if (enVueExacteIa(user)) {
    return Promise.resolve({ ok: false, error: refusAssistantVueExacte(user.visualise?.name ?? (user.impersonatedBy ? user.name : null)), message: d.texte ?? "" });
  }
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
  /** Décision 0034 : mode « en clair » — les réponses de l'assistant repartent telles qu'il les a écrites. */
  enClair = false,
): { texte: string; historique: DemandeDuTour["historique"]; masques: number } {
  // LES RÉPONSES DE L'ASSISTANT, TOUJOURS (décision 0012) : une valeur qu'il a RÉVÉLÉE à la personne (salaire,
  // IBAN) ne repart pas au modèle par l'historique — elle redevient « [confidentiel] », réglage ou pas.
  // EN CLAIR (décision 0034) : ce que le modèle a lui-même écrit (des valeurs qu'il a reçues pour cette personne, droits
  // jugés) lui revient tel quel ; une valeur révélée à l'écran du temps des repères (bornée) reste masquée.
  const reponses = historique.map((e) => (e.role !== "assistant" ? e
    : { ...e, content: enClair ? sansValeursRevelees(e.content) : censurerTexte(sansValeursRevelees(e.content)).texte }));
  if (!actif) return { texte, historique: reponses, masques: 0 };
  const t = censurerTexte(texte);
  let masques = t.occurrences;
  const h = reponses.map((e) => {
    // Le filtre de la SAISIE vise ce que la personne écrit ; en clair, les réponses de l'assistant n'y repassent pas.
    if (enClair && e.role === "assistant") return e;
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
  // Décision 0034 : les valeurs sensibles vont au modèle EN CLAIR pour qui a le droit de les voir (défaut), ou en repères.
  const enClair = reglages.valeursSensibles === "EN_CLAIR";
  const saisie = filtrerSaisie((d.texte ?? "").trim(), d.historique, reglages.censurerSaisie, enClair);
  const texteSaisi = saisie.texte;
  // P1 bis (MI-02) : « en tâche de fond », ou la bascule décidée par le serveur — le tour pose une mission.
  const fond = d.modeFond === true || demandeDeFond(texteSaisi);
  // P1 bis : le canal d'Adam n'existe que pour le Super Admin — pour tout autre, la réponse ne le nomme jamais (garde serveur).
  const sortieDuCanal = (t: string) => (canalAdamOuvert(user) ? t : taireCanalAdam(t));
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
  // Décision 0035 : à l'oral, la carte en cours de conversation (complétée, corrigée) n'est pas caduque — et l'en-tête de
  // la délégation (qui la nomme) ne compte pas comme « en reparler ».
  // F2 (AN-ANNULER-03) : « annule cette demande » face à une carte qui attend — le serveur la retire lui-même, et le dit.
  const annulee = await retirerCarteAnnuleeAvantLeTour(user.id, texteSaisi.replace(/^\[[^\]]*\]\s*/, ""));
  const noteAnnulee = annulee
    ? `CARTE RETIRÉE : la personne vient d'annuler la carte « ${annulee.title} », qui attendait sa confirmation ; le serveur l'a RETIRÉE — rien n'a été créé ni envoyé. Dis-le en une phrase ; ne lui demande pas de la fermer.`
    : null;
  if (reglages.retirerCartesCaduques) {
    const orale = texteSaisi.startsWith("[Conversation vocale") ? await carteOraleEnAttente(user) : null;
    await retirerCaduquesAvantLeTour(user.id, texteSaisi.replace(/^\[Conversation vocale[^\]]*\]\s*/, ""), orale ? [orale.id] : []);
  }

  let instructions: string;
  let config;
  // LES ACCÈS RÉGLÉS PAR LA DIRECTION (décision 0012), relus à chaque tour : un réglage changé vaut dès maintenant.
  let acces: AccesIa;
  const propositions: PropositionPreparee[] = [];
  const sorties: string[] = [];
  const memoires: MemoireProposee[] = [];
  const notesProposees: string[] = [];
  // K2 (décision 0032) : les images et vidéos générées pendant le tour — des blocs de la réponse, construits par le serveur.
  const visuels: WorkspaceBlock[] = [];
  // K1 (décision 0031) : les jeux de données que le tour a lus, et les analyses CALCULÉES par le code (posées sous la réponse).
  const blocsCalcules: WorkspaceBlock[] = [];
  const analyse = { jeux: new JeuxDuTour(), blocs: blocsCalcules, pieces: pieces.map((p) => ({ id: p.id, nom: p.nom })), question: texteSaisi };
  const travauxLances: string[] = [];
  // LE COFFRET DU TOUR (décision 0012) : les valeurs sensibles lues par les outils y restent ; le modèle n'en a que les
  // repères — sauf en mode « en clair » (décision 0034), où celles que la personne a le droit de voir lui sont rendues.
  const coffret = new CoffretDuTour();
  /**
   * LA VUE EXACTE NE LIT PAS LA VIE PRIVÉE DE LA PERSONNE REGARDÉE (lot Q1, décision 0050 ; §118.153). Le Super Admin voit
   * l'écran du compte, pas sa mémoire, ses notes ni ses conversations passées : mesuré par le banc d'audit, le tour en Vue
   * exacte chargeait la mémoire du compte regardé (santé déclarée comprise) dans le contexte du modèle.
   */
  const vueExacte = Boolean(user.impersonatedBy);
  let outils: PowerTool[] | undefined;
  let selection: SelectionDuTour;
  // P1 : les pilotages de mission REFUSÉS pendant le tour — la garde de vérité ne les compte pas comme preuves.
  const pilotagesEchoues = new Set<string>();
  try {
    acces = await accesAssistantIa(user);
    config = await getRoleConfig(user.role);
    // M1 (décision 0045) : mémoire automatique (défaut) — retenue d'office après le tour ; coupée, la carte « Retenir ».
    const memoireAuto = d.prive || vueExacte ? false : await memoireAutoActive(user.id);
    // MODE « EN CLAIR » (décision 0034) : la sortie d'un outil rend au modèle les valeurs que la personne a le droit de
    // voir — le MÊME juge que l'affichage (politique du coffre, familles de la console), chaque valeur au journal.
    const auModele = enClair ? new Revelateur(coffret, user, acces, GESTE_MODELE_EN_CLAIR) : null;
    // J2 : « lancer_un_travail » — une demande qui dépasse un tour devient un travail (plan à approuver).
    // J6 : avec les CAPACITÉS de l'ERP (registre dérivé du contrat) — enregistrées toutes, seules les actives partent.
    // J14 : ce que le tour lit d'un tiers, face à ce que la personne a écrit — une carte dit ses valeurs d'origine tierce.
    const provenance = new ProvenanceDuTour([texteSaisi, ...saisie.historique.filter((h) => h.role === "user").map((h) => h.content)], message);
    outils = [...outilsV1(user, propositions, sorties, memoires, coffret, acces, {
      capacites: true, provenance, notesProposees, visuels, analyse, ...(auModele ? { revelerAuModele: (s: string) => auModele.enClair(s) } : {}),
    }), ...outilsSousMissionsDuTour(user, travauxLances, "fin-du-tour"), ...outilsChantierPour(user, travauxLances)];
    // P1 (décision 0047) : lire et piloter SES missions (fusion par carte, `fusionner_missions`), lire ses boîtes mail et
    // envoyer par l'une d'elles (carte « Envoyer », fenêtre d'annulation) — l'écrit a enfin les gestes de l'écran et de la voix.
    const tousLesOutils = (): PowerTool[] => outils ?? [];
    // Leurs sorties PROUVENT ce que la réponse montre (un tableau des missions lues) — comme celles des autres lectures.
    const prouvees = (xs: PowerTool[]): PowerTool[] => xs.map((o) => ({ ...o, run: async (e, u) => { const r = await o.run(e, u); sorties.push(r); return r; } }));
    outils.push(...prouvees([...outilsMissions(user, pilotagesEchoues), ...outilsAnnulation(user, pilotagesEchoues), ...outilsMails(user, (nom) => tousLesOutils().find((o) => o.def.name === nom), propositions)]));
    // Décision 0027 : la mémoire est commune à toutes les conversations — sauf une conversation PRIVÉE, qui ne la lit
    // ni ne l'écrit (pas de carte « Retenir », pas de recherche dans les conversations passées).
    // M1 : la mémoire automatique retient seule — la carte « Retenir » ne sert que si la personne l'a coupée.
    if (d.prive || vueExacte || memoireAuto) outils = outils.filter((o) => o.def.name !== "proposer_memoire");
    if (vueExacte) outils = outils.filter((o) => !(OUTILS_NOTES as readonly string[]).includes(o.def.name));
    if (!d.prive && !vueExacte) outils = [...outils, outilConversationsPassees(user, d.conversation ?? null)];
    // K6 (décision 0036) : « je t'envoie la lettre par WhatsApp » — l'attente de pièces (fiche de la sélection, pas socle).
    outils.push(outilAttendrePieces(user, d.conversation ?? null, d.vocal || texteSaisi.startsWith("[Conversation vocale]") ? "VOIX" : "ECRIT"));
    // J4 : les outils choisis à la demande — le socle, la présélection par la demande, et `trouver_outil`.
    const precedente = [...saisie.historique].reverse().find((h) => h.role === "user")?.content ?? "";
    // P1 bis (MI-02) : une demande DE FOND ne se joue pas dans le tour — seuls les outils qui POSENT la mission sont offerts.
    if (fond) outils = outils.filter((o) => OUTILS_DE_FOND.includes(o.def.name));
    selection = selectionDuTour(outils, user, message, config, precedente, fond ? [...OUTILS_DE_FOND] : [...outilsPilotageVoulus(texteSaisi), ...outilsDAnalyseVoulus(texteSaisi, analyse.pieces)]);
    outils.push(selection.outil);
    // LE PRÉFIXE STABLE (J4) : identité, règles, présentation, consignes générales, puis la personne ; la partie
    // variable du tour (indice de travail long, résumé de la conversation, heure) ferme la consigne.
    const sauf = (xs: (string | null | undefined)[]) => xs.filter((c): c is string => !!c);
    // S1 (décision 0048) : à qui il parle — le profil construit par le serveur (compte de la session, fiche LIÉE, avenants).
    const { section: profil } = await profilDeLaPersonne(user, acces);
    instructions = (await compileContext({
      user, profil, consignesRole: resoudreConsignesRole(config),
      consignesGenerales: sauf([enClair ? CONSIGNE_EN_CLAIR : CONSIGNE_JETONS, CONSIGNE_SELECTION, CONSIGNE_ATELIER, CONSIGNE_MISSIONS, canalAdamOuvert(user) ? CONSIGNE_BOITE_ADAM : null, adamOuvert(user) ? CONSIGNE_ADAM_SA : null, d.consigne, fond ? CONSIGNE_FOND : null]),
      consignesPersonne: sauf([consigneFamilles(acces), consigneGestesFermes(user), !d.prive && !memoireAuto ? CONSIGNE_MEMOIRE_A_LA_CARTE : null]),
      outilsActifs: selection.initiaux, question: texteSaisi, sansMemoire: d.prive === true || vueExacte, valeursEnClair: enClair,
      sectionsDuTour: sauf([noteAnnulee, consigneTravaux(texteSaisi), d.sectionDossier, d.prive ? CONSIGNE_PRIVEE : null, d.sectionAttentes, sectionResume(d.resume)]),
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
      maxEtapes: fond ? Math.min(d.maxEtapes ?? ETAPES_DE_FOND, ETAPES_DE_FOND) : d.maxEtapes,
      // En flux, un repère n'est pas encore jugé : il s'affiche « ••• » jusqu'à la réponse finale.
      surTexte: d.surTexte ? (brut) => d.surTexte!(sortieDuCanal(masquerReperesPartiels(brut))) : undefined,
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
    // P1 (décision 0047) — LA GARDE DE VÉRITÉ : « j'ai fusionné », « c'est envoyé », « j'ai pris en compte la mission
    // fusionnée » sans l'outil réussi qui le prouve dans ce tour → une note « non vérifié » sous la réponse.
    const preuves = r.outilsAppeles.filter((n) => !pilotagesEchoues.has(n));
    const nonVerifie = noteActionsNonVerifiees(ui.message, preuves, propositions.length > 0);
    if (nonVerifie) console.warn("[assistant] actions non vérifiées", nonVerifie.familles);
    const p = propositions[0];
    // LA RÉVÉLATION, AVANT D'AFFICHER ET DE STOCKER : chaque repère devient la valeur pour qui a le droit de
    // la voir (politique du coffre, journal), « [confidentiel] » sinon.
    const revelateur = new Revelateur(coffret, user, acces);
    return {
      ok: true,
      message,
      content: sortieDuCanal(await revelateur.texte([ui.message || "Je n'ai pas de réponse à afficher.", note?.texte, nonVerifie?.texte].filter(Boolean).join("\n\n"))),
      blocs: [...visuels, ...(JSON.parse(sortieDuCanal(JSON.stringify(await revelateur.objet([...ui.blocs, ...blocsCalcules])))) as typeof ui.blocs)],
      memoireProposee: d.prive || vueExacte ? null : memoires[0] ?? null,
      notesProposees: [...notesProposees],
      travaux: [...travauxLances],
      // Ce que la personne lit : « Annuaire consulté », jamais « directory_lookup ».
      outilsAppeles: [...new Set(r.outilsAppeles.filter((n) => n !== OUTIL_TROUVER).map((n) => libelles.get(n) ?? n))],
      intent: p ? {
        id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields,
        ...(p.proposition.warnings?.length ? { warnings: p.proposition.warnings } : {}),
        ...(p.proposition.confirmText ? { confirmText: p.proposition.confirmText } : {}),
        ...(p.proposition.libelleBouton ? { libelleBouton: p.proposition.libelleBouton } : {}),
        ...(p.proposition.apercus?.length ? { apercus: p.proposition.apercus } : {}),
        ...(p.proposition.simulation ? { simulation: p.proposition.simulation } : {}),
        ...(p.proposition.formulaire ? { formulaire: p.proposition.formulaire } : {}),
        status: "PROPOSED",
      } : null,
    };
  } catch (e) {
    // P1 bis (MI-02) : LE PLAFOND D'UN TOUR atteint ne s'arrête plus sur un refus — le travail BASCULE en mission (une fois) :
    // un tour court pose le plan, la mission lit et rédige en arrière-plan. Le plafond du JOUR, lui, reste un arrêt.
    if (e instanceof PlafondIaAtteint && !d.modeFond && /plafond d'un tour/.test(e.message)) {
      console.warn("[assistant] plafond d'un tour atteint : bascule en mission");
      const r = await tourAuNomDe(user, { ...d, modeFond: true });
      return r.ok ? { ...r, content: `Cette demande dépassait ce qu'un tour peut faire : je l'ai confiée à une mission en arrière-plan.\n\n${r.content}` } : r;
    }
    if (e instanceof IaCoupee || e instanceof PlafondIaAtteint) return { ok: false, error: e.message, message };
    console.error("[assistant] aucun modèle n'a répondu", e);
    // Le fournisseur REFUSE faute de crédit (31/10/2026 : « insufficient_quota ») : le dire, sinon la personne réessaie
    // en vain — « réessayez » ne peut rien contre un compte à recharger.
    if (/insufficient_quota|credit_balance_exhausted|no credits remaining|exceeded your current quota/i.test(String((e as Error)?.message ?? e))) {
      return { ok: false, error: "L'assistant est indisponible : le crédit du compte OpenAI est épuisé. L'administrateur doit le recharger (platform.openai.com › Billing).", message };
    }
    // F2 (banc réel, MG-10) : un message HONNÊTE — ce qui s'est passé (délai dépassé, ou modèle muet) ; le fil reprend.
    return { ok: false, error: messageDEchec(e), message, transitoire: true };
  }
}

/** Ce que la personne lit quand le modèle n'a pas répondu : la cause, dite simplement. */
export function messageDEchec(e: unknown): string {
  const m = /délai dépassé \((\d+) ms\)/.exec(String((e as Error)?.message ?? e));
  if (m) return `L'assistant n'a pas pu terminer : la réponse a dépassé le délai (${Math.round(Number(m[1]) / 60_000) || 1} min) et a été interrompue. Aucune action n'a été confirmée.`;
  return "L'assistant n'a pas pu répondre : le modèle n'a pas répondu (incident passager). Aucune action n'a été confirmée.";
}

// La révélation vit avec les accès (`role-config.ts`) : la carte et la confirmation la consultent aussi.
export { Revelateur };
