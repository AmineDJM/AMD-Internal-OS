/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PILOTER SES MISSIONS À L'ÉCRIT ET À L'ORAL (lot P1, décision 0047) — règles PURES, zéro import.
 *
 * Constat de la Direction (02/11) : l'assistant lançait une TROISIÈME mission au lieu de fusionner, affirmait « je prends
 * en compte la mission unique que tu as déjà fusionnée » sans rien avoir lu, puis lui demandait les titres de ses propres
 * missions ; et le tableau montrait trois missions « En cours · 0 % » pendant des heures. Ce fichier dit, sans base ni
 * session :
 *
 *   • le DIAGNOSTIC HONNÊTE d'une mission : « en attente du worker (aucun battement depuis 12 min) », « attend ton
 *     approbation », « plafond », « bloquée : … », « l'étape « Synthèse » réessaie : crédit OpenAI épuisé » — jamais
 *     « En cours · 0 % » indéfiniment ;
 *   • la DÉSIGNATION d'une mission par son identifiant ou par son nom (désambiguïsation : jamais demander à la personne
 *     un titre qu'on peut lire) ;
 *   • la GARDE DE VÉRITÉ : une réponse qui affirme une action faite ou un état vérifié sans l'outil réussi qui le prouve
 *     dans le tour est reprise (comme `noteChiffresNonSources` pour les chiffres) ;
 *   • la présélection des outils de missions (les mots d'une demande qui parle de ses missions).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ");

// ─────────────────────────────── 1. Le diagnostic d'une mission ───────────────────────────────

/** Ce que le diagnostic lit d'une mission (le tableau K3 le porte déjà). */
export interface MissionDiagnostiquee {
  etat: string;
  /** Le motif de pause du moteur (plafond, arrêt, fusion), s'il y en a un. */
  motifPause?: string | null;
  attente: string | null;
  etapes: readonly { titre: string; etat: string; erreur: string | null }[];
  /** Dernière écriture de la mission ou d'une étape (ISO). */
  majLe: string;
}

/** Qui conduit les travaux : le dernier passage EFFECTIF du balayage (pas un passage « ignoré »), et le worker. */
export interface EtatDesExecutants {
  /** Dernière fois qu'un exécutant a réellement conduit les travaux (`travaux.balayage` OK ou ÉCHEC), ISO ; null : jamais. */
  dernierPassage: string | null;
  /** Dernière tâche prise par le service worker (ISO) ; null : jamais vu. */
  workerVu: string | null;
}

export type CodeDiagnostic =
  | "A_APPROUVER" | "ATTENTE_EXECUTANT" | "PLAFOND" | "BLOQUEE" | "REESSAIE" | "EN_PAUSE" | "ARRETEE" | "ATTENTE" | "EN_COURS" | "FINIE";

export interface Diagnostic { code: CodeDiagnostic; phrase: string }

/** Au-delà, un exécutant qui n'a pas conduit les travaux est « absent » (le battement passe chaque minute). */
export const SILENCE_EXECUTANT_MS = 3 * 60_000;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const depuis = (iso: string | null, maintenant: number) => (iso ? maintenant - new Date(iso).getTime() : Infinity);

/** Un message d'erreur du fournisseur dit en français — le crédit épuisé surtout (31/10, puis 01/11 au soir). */
export function erreurLisible(erreur: string): string {
  const e = erreur.trim();
  if (/insufficient_quota|exceeded your current quota|credit_balance|no credits remaining/i.test(e)) return "crédit du compte OpenAI épuisé (à recharger : platform.openai.com › Billing)";
  if (/incorrect api key|invalid_api_key|401/i.test(e)) return "clé du fournisseur d'IA refusée (OPENAI_API_KEY)";
  if (/^aucune réponse$/i.test(e)) return "le modèle n'a rien rendu";
  return e.length > 160 ? `${e.slice(0, 157)}…` : e;
}

/** Les exécutants conduisent-ils les travaux ? `null` : oui ; sinon la phrase qui dit depuis quand personne ne bat. */
export function silenceDesExecutants(ex: EtatDesExecutants, maintenant: number): string | null {
  const d = depuis(ex.dernierPassage, maintenant);
  if (d <= SILENCE_EXECUTANT_MS) return null;
  return ex.dernierPassage === null
    ? "aucun exécutant des tâches de fond n'a encore conduit de mission (worker absent)"
    : `aucun battement du worker depuis ${minutes(d)} min`;
}

/**
 * LE DIAGNOSTIC — ce que la mission attend vraiment. L'ordre compte : une mission prête qu'aucun exécutant ne conduit
 * ne dit pas « en cours » ; une étape qui réessaie dit son erreur ; une attente dit ce qu'elle attend.
 */
export function diagnostiquerMission(m: MissionDiagnostiquee, ex: EtatDesExecutants, maintenant: number): Diagnostic {
  const echec = m.etapes.find((e) => e.etat === "ECHEC" && e.erreur);
  switch (m.etat) {
    case "A_APPROUVER": return { code: "A_APPROUVER", phrase: "attend ton approbation (plan proposé, rien ne tourne avant)" };
    case "BUDGET_HOLD": return { code: "PLAFOND", phrase: `plafond atteint${m.motifPause ? ` : ${m.motifPause.replace(/^BUDGET_HOLD\s*—?\s*/, "")}` : ""} — elle reprendra seule quand il le permettra` };
    case "ARRETE": return { code: "ARRETEE", phrase: m.motifPause?.includes("fusionnée") ? `${m.motifPause.replace(/^ARRETE\s*—\s*/, "")} (« reprendre » la relance)` : "arrêtée à ta demande (« reprendre » la relance)" };
    case "EN_PAUSE": return { code: "EN_PAUSE", phrase: `en pause${m.motifPause ? ` (${m.motifPause})` : ""}` };
    case "BLOQUE":
    case "ECHEC": return { code: "BLOQUEE", phrase: `bloquée : ${echec ? `l'étape « ${echec.titre} » a échoué — ${erreurLisible(echec.erreur!)}` : "une étape n'a pas pu aboutir"}` };
    case "TERMINE":
    case "ANNULE": return { code: "FINIE", phrase: m.etat === "TERMINE" ? "terminée" : "annulée" };
    default: break;
  }
  // VIVANTE (EN_COURS, EN_ATTENTE) — qui la conduit ?
  const silence = silenceDesExecutants(ex, maintenant);
  const reessaie = echec ?? m.etapes.find((e) => e.etat === "EN_COURS" && e.erreur);
  if (reessaie) return { code: "REESSAIE", phrase: `l'étape « ${reessaie.titre} » réessaie : ${erreurLisible(reessaie.erreur!)}` };
  if (m.attente && m.etat === "EN_ATTENTE") return { code: "ATTENTE", phrase: m.attente };
  if (silence) return { code: "ATTENTE_EXECUTANT", phrase: `en attente du worker (${silence}) — elle n'avance pas tant qu'aucun exécutant ne tourne` };
  const enCours = m.etapes.find((e) => e.etat === "EN_COURS");
  return { code: "EN_COURS", phrase: enCours ? `en cours : ${enCours.titre}` : "prête : la prochaine étape part au prochain battement (moins d'une minute)" };
}

// ─────────────────────────────── 2. Désigner une mission ───────────────────────────────

const MOTS_NEUTRES = new Set(["mission", "missions", "travail", "travaux", "tache", "taches", "pause", "reprends", "reprendre", "arrete", "arreter", "stoppe", "celle", "cette", "celle-ci", "fusionne", "fusionner", "renomme", "renommer", "suivi", "avec", "dans"]);

/**
 * LES MISSIONS VISÉES par un identifiant ou un nom — un identifiant exact gagne ; sinon les titres qui portent le plus de
 * mots de la désignation (≥ 3 lettres). Plusieurs à égalité : AMBIGU (la réponse les NOMME, elle ne demande pas un titre).
 */
export function designerMission<T extends { id: string; titre: string }>(candidats: readonly T[], designation: string): { vises: T[]; ambigu: boolean } {
  const d = designation.trim();
  if (!d) return { vises: [...candidats], ambigu: candidats.length > 1 };
  const parId = candidats.find((c) => c.id === d);
  if (parId) return { vises: [parId], ambigu: false };
  const exact = candidats.filter((c) => plier(c.titre).trim() === plier(d).trim());
  if (exact.length === 1) return { vises: exact, ambigu: false };
  // Trois lettres suffisent : les sigles comptent (« AMD », « CTD »).
  const mots = plier(d).split(/[^a-z0-9]+/).filter((m) => m.length >= 3 && !MOTS_NEUTRES.has(m) && !["les", "des", "une", "aux", "pour", "sur"].includes(m));
  if (!mots.length) return { vises: [...candidats], ambigu: candidats.length > 1 };
  const notes = candidats.map((c) => ({ c, n: mots.filter((m) => plier(c.titre).includes(m)).length })).filter((x) => x.n > 0);
  if (!notes.length) return { vises: [], ambigu: false };
  const max = Math.max(...notes.map((x) => x.n));
  const vises = notes.filter((x) => x.n === max).map((x) => x.c);
  return { vises, ambigu: vises.length > 1 };
}

// ─────────────────────────────── 3. La garde de vérité ───────────────────────────────

/**
 * LES AFFIRMATIONS D'ACTION — chaque famille, et les outils dont la RÉUSSITE dans le tour la prouve. Une affirmation sans
 * aucun de ces outils réussi est reprise. Le nom d'un outil de capacité (`microsoft-mail__sendMessage`) se reconnaît par
 * motif (`/mail.*send|sendmail/i`).
 */
interface Affirmation { famille: string; motif: RegExp; preuves: RegExp }

const AFFIRMATIONS: readonly Affirmation[] = [
  { famille: "fusion", motif: /\b(j ai|je les ai|c est|elles sont|ont ete|a ete|sont)\s+(bien\s+)?(fusionn\w*|regroup\w*|merg\w*)|\bmissions? (unique )?(que tu as|deja) fusionn\w*|\bla mission (unique|fusionnee)\b/, preuves: /^(fusionner_missions|mes_missions|piloter_mission)$/ },
  { famille: "mission", motif: /\b(j ai|je l ai|je les ai)\s+(bien\s+)?(arrete|stoppe|mis en pause|relance|repris|renomme|annule)\w*|\b(mission|missions) (est|sont) (bien )?(arretee|en pause|reprise|annulee|renommee)s?\b/, preuves: /^(piloter_mission|fusionner_missions)$/ },
  { famille: "envoi", motif: /\b(c est|mails?|messages?|courriels?|e-mails?|emails?)\s+((est|sont|a ete|ont ete)\s+)?(bien\s+)?(envoye|parti)e?s?\b|\bj ai (bien )?envoye\b|\best parti\b|\bc est envoye\b/, preuves: /^(envoyer_mail|send_message)$|mail.*send|send.*mail|sendmessage|sendmailaction/i },
  { famille: "enregistrement", motif: /\b(c est|brouillons?|documents?|cartes?)\s+((est|sont|a ete|ont ete)\s+)?(bien\s+)?(enregistre|sauvegarde)e?s?\b|\bj ai (bien )?(enregistre|sauvegarde)\b/, preuves: /savedraft|enregistrer|^envoyer_mail$|^(ajouter|modifier|cocher|deplacer|supprimer)_note$|^creer_page$/i },
  { famille: "verification", motif: /\b(je prends|j ai pris) en compte (la|les|ta|tes) (mission|missions)\b|\bj ai (bien )?verifie\b|\bje confirme que (la|les|ta|tes) (mission|missions)\b/, preuves: /^(mes_missions|piloter_mission|fusionner_missions)$/ },
];

/** Ce que la note dit — une phrase, sous la réponse ; le banc compte les reprises (`[assistant] actions non vérifiées`). */
export const NOTE_NON_VERIFIE = "⚠️ Non vérifié : je n'ai fait aucune action ni lecture qui le prouve dans ce tour — rien n'a été exécuté. Demande-moi de le faire (ou de vérifier) et je le ferai réellement.";

/**
 * LA GARDE — les familles affirmées sans preuve. `outilsReussis` : les NOMS techniques des outils appelés avec succès
 * pendant le tour (pas les libellés). Une carte de confirmation affichée prouve qu'une action est PRÉPARÉE, pas faite :
 * « c'est envoyé » sur une carte reste repris.
 */
export function actionsNonVerifiees(message: string, outilsReussis: readonly string[], carteAffichee = false): string[] {
  const t = plier(message);
  return AFFIRMATIONS.filter((a) => {
    if (!a.motif.test(t)) return false;
    // Une carte affichée n'est pas une action faite : « c'est envoyé » ou « c'est enregistré » sur une carte est faux.
    if (carteAffichee && (a.famille === "envoi" || a.famille === "enregistrement")) return true;
    return !outilsReussis.some((o) => a.preuves.test(o));
  }).map((a) => a.famille);
}

/** La note à poser sous la réponse, ou null — `noteChiffresNonSources` pour les actions. */
export function noteActionsNonVerifiees(message: string, outilsReussis: readonly string[], carteAffichee = false): { familles: string[]; texte: string } | null {
  const familles = actionsNonVerifiees(message, outilsReussis, carteAffichee);
  return familles.length ? { familles, texte: NOTE_NON_VERIFIE } : null;
}

// ─────────────────────────────── 4. La présélection et la consigne ───────────────────────────────

const MISSIONS = /\b(missions?|taches? de fond|travaux|travail en cours|en cours|fusionn\w*|merg\w*|regroup\w*|arrete\w*|stoppe\w*|reprend\w*|met\w* en pause|renomm\w*|0 ?%|n avance\w* pas|bloque\w*)\b/;
const MAIL = /\b(mails?|e-?mails?|courriels?|gmail|outlook|boite|boites|envoie\w*|envoyer|brouillons?)\b/;

/** Les outils à mettre EN TÊTE de la présélection quand la demande parle de ses missions ou de ses mails. */
export function outilsPilotageVoulus(demande: string): string[] {
  const q = plier(demande);
  return [
    ...(MISSIONS.test(q) ? ["mes_missions", "piloter_mission", "fusionner_missions"] : []),
    ...(MAIL.test(q) ? ["mes_boites_mail", "envoyer_mail"] : []),
  ];
}

export const CONSIGNE_MISSIONS = [
  "### TES MISSIONS ET TES MAILS — VÉRITÉ D'ABORD",
  "- Tes missions (tâches de fond), tu les LIS avec `mes_missions` : titre, état, étapes, coût, ce qui bloque. Ne demande JAMAIS à la personne le titre ou l'état d'une mission : lis-les. « Je vois 3 missions » → appelle `mes_missions` et réponds avec ce que tu lis.",
  "- Pause, reprise, arrêt, renommage : `piloter_mission` (par identifiant ou par nom). « Fusionne-les », « mets-les dans un seul tableau » : `fusionner_missions` — JAMAIS une nouvelle mission de plus par `lancer_un_travail` quand des missions sur le même sujet existent.",
  "- Une mission qui n'avance pas : dis EXACTEMENT ce que `mes_missions` rapporte (« en attente du worker », « attend ton approbation », « plafond », « bloquée : … ») — jamais « elle tourne ».",
  "- Mails : ta boîte, c'est le Gmail d'ADAM ; `mes_boites_mail` lit son état réel (réponds à « as-tu accès à ta boîte / à Gmail ? » en le LISANT). « Envoie un mail à Redouane et Nesrine avec leur planning » → `envoyer_mail` TOUT DE SUITE, sans question : destinataires par leurs noms (l'annuaire les résout), objet, ton et signature choisis par toi, contenu tiré de la conversation, un mail par personne quand il lui est propre, en CONTENU STRUCTURÉ (salutation au prénom, paragraphes courts, tableau pour un planning, **échéances en gras**). Une question SEULEMENT si un destinataire est introuvable ou ambigu. La personne corrige sur la carte. Microsoft ou SMTP de la personne seulement si elle le demande ; brouillon seulement sur demande.",
  "- N'écris JAMAIS « c'est fait », « j'ai fusionné », « c'est envoyé », « c'est enregistré », « j'ai pris en compte » sans l'outil réussi qui le prouve dans CE tour. Une carte affichée n'est pas une action faite : dis qu'elle attend sa confirmation.",
].join("\n");
