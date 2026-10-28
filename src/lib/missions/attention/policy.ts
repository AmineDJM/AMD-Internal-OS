import type { NiveauSignal, SignalAttention } from "@/lib/missions/ports";

/** Deux minutes : au-delà, la personne a pu quitter la conversation, et une fin de mission redevient une information. */
export const DANS_LA_FOULEE_MS = 2 * 60 * 1000;

/** Le niveau d'un signal — la table. */
export function classer(s: SignalAttention): NiveauSignal {
  switch (s.kind) {
    case "MISSION_COMPLETED": {
      const livrables = s.bilan?.livrables?.length ?? 0;
      // TERMINÉE DANS LA FOULÉE DE LA DEMANDE, sans livrable ni effet externe : la personne est
      // encore là, et la conversation vient de le lui dire. « Surveille cet appel d'offres et
      // préviens-moi seulement s'il y a un problème » posait la surveillance en cinq secondes —
      // puis poussait « Mission terminée » sur le téléphone. La ligne au journal suffit ; ce qui
      // est parti à l'extérieur, ou un fichier qui attend, mérite toujours l'information.
      if (livrables === 0 && !s.bilan?.effetsExternes && typeof s.dureeMs === "number" && s.dureeMs < DANS_LA_FOULEE_MS) return "JOURNAL";
      // Une mission sans aucun effet ni livrable (une lecture qui s'est faite toute seule) ne
      // vaut pas une interruption : la ligne au centre de notifications suffit.
      return (s.bilan?.effets?.length ?? 0) + livrables > 0 || (s.bilan?.total ?? 0) >= 3 ? "INFO" : "JOURNAL";
    }
    case "MISSION_PARTIAL": return "INFO";
    case "MISSION_BLOCKED": return "ATTENTION";
    case "MISSION_FAILED": return "ATTENTION";
    case "PLANNING_FAILED": return "ATTENTION";
    case "BUDGET_HOLD": return "ATTENTION";
    case "APPROVAL_REQUIRED":
      return s.niveauApprobation === "NORMAL" ? "ATTENTION" : "ARBITRAGE";
    case "PLAN_CHANGED": return "ARBITRAGE";
    // Une QUESTION est un arbitrage — sauf quand l'émetteur dit lui-même que c'est une simple
    // information (une réponse arrivée après la relance : à lire, pas à trancher séance tenante).
    case "QUESTION": return s.niveauSuggere === "INFO" ? "INFO" : "ARBITRAGE";
    case "WAIT_OVERDUE":
      // Tant qu'Adam relance lui-même, le dirigeant n'a rien à faire : JOURNAL. Quand l'échelle
      // de relances est épuisée (trois), c'est à lui de trancher.
      return (s.attente?.relances ?? 0) >= 3 ? "ATTENTION" : "JOURNAL";
    // ── LA SURVEILLANCE : « préviens-moi seulement s'il y a un problème » ────────────────
    // L'émetteur connaît la gravité (un statut qui change est une information, une échéance
    // dépassée une attention) ; sans indication, un problème vaut ATTENTION. Un problème
    // résolu ne dérange personne (journal) ; une cible terminée s'annonce une fois (info).
    case "WATCH_ALERT": return s.niveauSuggere && s.niveauSuggere !== "JOURNAL" ? s.niveauSuggere : "ATTENTION";
    case "WATCH_RESOLVED": return "JOURNAL";
    case "WATCH_ENDED": return "INFO";
  }
}

// ─────────────────────────────── L'OMNICANAL (mandat 5 §37) ───────────────────────────────

/** Les canaux qu'une personne peut préférer : l'ERP seul, l'e-mail, ou un connecteur de messagerie. */
export const CANAUX_PREFERABLES = ["notification", "email", "slack", "teams", "whatsapp", "sms"] as const;
export type CanalPrefere = (typeof CANAUX_PREFERABLES)[number];
export const CANAUX_CONNECTEURS: ReadonlySet<string> = new Set(["slack", "teams", "whatsapp", "sms"]);

export interface HeuresSilence { de: number; a: number }

/**
 * CE QUI GOUVERNE LES CANAUX, au-delà du niveau : le canal préféré (règle enseignée), la
 * disponibilité (heures de silence, connecteurs réellement branchés), la confidentialité.
 * Tout est facultatif : sans préférence, la table du niveau s'applique telle quelle.
 */
export interface PreferencesCanaux {
  /** Le canal préféré, appris par Teach Adam (clé `canalPrefere`) ; « slack:#direction » porte aussi la destination. */
  canalPrefere?: string | null;
  /** Les heures de silence [de, a) en heure locale — pas de push ni de message hors ARBITRAGE. */
  heuresSilence?: HeuresSilence | null;
  /** L'heure locale courante (0–23), pour juger le silence. */
  heure?: number | null;
  /** Les connecteurs de messagerie configurés ET ouverts à la personne. */
  connecteurs?: readonly string[];
  /** Le contenu ne doit pas quitter l'ERP : les canaux externes portent un corps neutre. */
  confidentiel?: boolean;
}

export interface Canaux {
  notification: boolean;
  push: boolean;
  insistant: boolean;
  email: boolean;
  /** Le connecteur de messagerie à employer (slack, teams, whatsapp, sms) — `null` sinon. */
  connecteur: string | null;
  /** Les canaux externes portent un corps neutre (confidentialité). */
  corpsNeutre: boolean;
  /** Un push ou un message a été RETENU par les heures de silence — dit au journal, jamais perdu au centre de notifications. */
  differe: boolean;
  /** Le canal préféré n'est pas branché : la table du niveau s'applique, et le journal le dit. */
  canalIndisponible: string | null;
}

const ALIAS_CANAL: Record<string, CanalPrefere> = {
  notification: "notification", notifications: "notification", notif: "notification", erp: "notification", application: "notification", app: "notification", push: "notification",
  email: "email", mail: "email", "e-mail": "email", courriel: "email", mel: "email",
  slack: "slack", teams: "teams", "microsoft teams": "teams", whatsapp: "whatsapp", wa: "whatsapp", sms: "sms", texto: "sms",
};

/** « Slack », « e-mail », « slack:#direction » → le canal canonique et, s'il y est, le destinataire. */
export function lireCanal(valeur: unknown): { canal: CanalPrefere; destinataire: string | null } | null {
  if (typeof valeur !== "string") {
    if (valeur && typeof valeur === "object" && typeof (valeur as { canal?: unknown }).canal === "string") {
      const c = lireCanal((valeur as { canal: string }).canal);
      const d = (valeur as { destinataire?: unknown }).destinataire;
      return c ? { canal: c.canal, destinataire: typeof d === "string" && d.trim() ? d.trim() : c.destinataire } : null;
    }
    return null;
  }
  const brut = valeur.trim().toLowerCase();
  if (!brut) return null;
  const [tete, ...reste] = brut.split(":");
  const canal = ALIAS_CANAL[tete!.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
  if (!canal) return null;
  const destinataire = reste.join(":").trim();
  return { canal, destinataire: destinataire || null };
}

/** « 22h-7h », « de 22 h à 7 h », « 22:00-07:00 », { de: 22, a: 7 } → des heures entières, ou `null`. */
export function lireHeuresSilence(valeur: unknown): HeuresSilence | null {
  const borne = (n: number): number | null => (Number.isInteger(n) && n >= 0 && n <= 24 ? n % 24 : null);
  if (valeur && typeof valeur === "object") {
    const o = valeur as { de?: unknown; a?: unknown; debut?: unknown; fin?: unknown };
    const de = borne(Number(o.de ?? o.debut)); const a = borne(Number(o.a ?? o.fin));
    return de !== null && a !== null && de !== a ? { de, a } : null;
  }
  if (typeof valeur !== "string") return null;
  const m = /(\d{1,2})\s*(?:h|:)?\s*(?:\d{2})?\s*(?:h)?\s*(?:-|–|a|à|et|jusqu'a|jusqu'à|→)\s*(\d{1,2})\s*(?:h|:)?/i.exec(valeur.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  if (!m) return null;
  const de = borne(Number(m[1])); const a = borne(Number(m[2]));
  return de !== null && a !== null && de !== a ? { de, a } : null;
}

/** Vrai quand l'heure est dans la plage — y compris une plage qui passe minuit (22 → 7). */
export function dansLeSilence(heure: number, plage: HeuresSilence): boolean {
  const h = ((Math.floor(heure) % 24) + 24) % 24;
  return plage.de < plage.a ? h >= plage.de && h < plage.a : h >= plage.de || h < plage.a;
}

/**
 * Les canaux d'un niveau. L'e-mail ne part qu'à partir d'ATTENTION : il est le canal le plus cher à lire.
 *
 * Puis les PRÉFÉRENCES corrigent la table, dans cet ordre :
 *   1. le canal préféré — « e-mail » l'obtient dès INFO ; « notification » ferme l'e-mail (l'ERP
 *      suffit) ; un connecteur BRANCHÉ remplace l'e-mail dès INFO (l'ARBITRAGE garde l'e-mail en
 *      plus : une décision mérite deux traces) ; un connecteur NON branché laisse la table et le dit ;
 *   2. les heures de silence — hors ARBITRAGE, ni push ni message : la ligne reste au centre de
 *      notifications et l'e-mail (asynchrone) part ; le retrait est dit (`differe`) ;
 *   3. la confidentialité — tout ce qui sort de l'ERP porte un corps neutre.
 * L'ARBITRAGE ne se laisse ni taire ni déplacer : c'est ce que seule la personne débloque.
 */
export function canauxPour(niveau: NiveauSignal, prefs: PreferencesCanaux = {}): Canaux {
  const table = ((): Pick<Canaux, "notification" | "push" | "insistant" | "email"> => {
    switch (niveau) {
      case "SILENCE": return { notification: false, push: false, insistant: false, email: false };
      case "JOURNAL": return { notification: true, push: false, insistant: false, email: false };
      case "INFO": return { notification: true, push: true, insistant: false, email: false };
      // ATTENTION pousse et écrit, mais n'INSISTE pas : une notification qui reste sur l'écran
      // jusqu'à un geste est réservée à ce que seule sa décision débloque.
      case "ATTENTION": return { notification: true, push: true, insistant: false, email: true };
      case "ARBITRAGE": return { notification: true, push: true, insistant: true, email: true };
    }
  })();
  const c: Canaux = { ...table, connecteur: null, corpsNeutre: false, differe: false, canalIndisponible: null };
  if (niveau === "SILENCE" || niveau === "JOURNAL") return c;

  const pref = lireCanal(prefs.canalPrefere ?? null);
  if (pref?.canal === "email") c.email = true;
  else if (pref?.canal === "notification") c.email = false;
  else if (pref && CANAUX_CONNECTEURS.has(pref.canal)) {
    if ((prefs.connecteurs ?? []).includes(pref.canal)) {
      c.connecteur = pref.canal;
      if (niveau !== "ARBITRAGE") c.email = false;
    } else c.canalIndisponible = pref.canal;
  }

  if (niveau !== "ARBITRAGE" && prefs.heuresSilence && typeof prefs.heure === "number" && dansLeSilence(prefs.heure, prefs.heuresSilence)) {
    if (c.push || c.connecteur) c.differe = true;
    c.push = false;
    c.connecteur = null;
  }

  if (prefs.confidentiel && (c.email || c.connecteur)) c.corpsNeutre = true;
  return c;
}

/** Le corps qu'un canal EXTERNE reçoit quand le contenu ne doit pas quitter l'ERP. */
export function corpsNeutrePour(niveau: NiveauSignal, lien: string): string {
  const quoi = niveau === "ARBITRAGE" ? "une décision vous attend" : niveau === "ATTENTION" ? "une mission requiert votre attention" : "une mission a du nouveau";
  return `Adam : ${quoi}. Le détail est confidentiel et reste dans l'ERP — ouvrir ${lien}.`;
}

/** LA CLÉ DE DÉDOUBLONNAGE : le même fait ne se dit qu'une fois par version de plan et par étape. */
export function cleDe(s: SignalAttention): string {
  const v = s.planVersion ?? 0;
  const etape = s.stepKey ?? "-";
  return `${s.kind}:${s.missionId}:v${v}:${etape}`;
}

/** Le temps de silence entre deux signaux de MÊME clé. Une décision ne se répète pas seule ; une info non plus. */
export function cadenceMs(niveau: NiveauSignal): number {
  switch (niveau) {
    case "SILENCE": return 0;
    case "JOURNAL": return 24 * 3600_000;
    case "INFO": return 24 * 3600_000;
    case "ATTENTION": return 6 * 3600_000;
    case "ARBITRAGE": return Number.POSITIVE_INFINITY; // une fois — la décision attend, on ne la redemande pas
  }
}

/** Au-delà de ce nombre de signaux INFO/ATTENTION par 24 h pour une personne, on rétrograde en JOURNAL. */
export const PLAFOND_QUOTIDIEN = 15;

const borne = (t: string, n: number): string => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);
const phrase = (t: string | null | undefined): string => (t ?? "").replace(/\s+/g, " ").trim();

/** LE MESSAGE — composé, pas rédigé : quatre blocs au plus, 700 caractères au plus. */
export function composerMessage(s: SignalAttention): { titre: string; corps: string } {
  const b = s.bilan;
  const faits = b ? `${b.faites}/${b.total} étapes faites${b.echouees ? `, ${b.echouees} en échec` : ""}` : "";
  const effets = b?.effets?.length ? ` Actions : ${b.effets.slice(0, 4).join(" ; ")}.` : "";
  const livrables = b?.livrables?.length ? ` Livrables : ${b.livrables.slice(0, 3).join(", ")}.` : "";
  const surveiller = b?.aSurveiller?.length ? ` À surveiller : ${b.aSurveiller.slice(0, 3).join(" ; ")}.` : "";
  const raison = phrase(s.raison);
  switch (s.kind) {
    case "MISSION_COMPLETED":
      return { titre: `Mission terminée — ${s.titre}`, corps: borne(`Résultat : ${raison || "objectif atteint."}${effets}${livrables}${surveiller}`, 700) };
    case "MISSION_PARTIAL":
      return { titre: `Mission partiellement faite — ${s.titre}`, corps: borne(`Résultat : ${raison || "une partie de l'objectif reste ouverte."} Contexte : ${faits}.${effets}${surveiller}`, 700) };
    case "MISSION_BLOCKED":
      return {
        titre: `Bloqué — ${s.titre}`,
        corps: borne(`Problème : ${raison || "la mission ne peut plus avancer seule."} Contexte : ${faits}.${effets} Recommandation : ${phrase(s.decision) || "préciser la demande ou replanifier depuis l'écran de la mission"}.`, 700),
      };
    case "MISSION_FAILED":
      return { titre: `Échec — ${s.titre}`, corps: borne(`Problème : ${raison || "la mission a échoué."} Contexte : ${faits}. Décision demandée : relancer, reformuler ou abandonner.`, 700) };
    case "PLANNING_FAILED":
      return { titre: `Je n'ai pas pu planifier — ${s.titre}`, corps: borne(`Problème : ${raison || "aucun plan exécutable."} Décision demandée : reformuler la demande ou me donner l'élément manquant.`, 700) };
    case "BUDGET_HOLD":
      return { titre: `Plafond atteint — ${s.titre}`, corps: borne(`Problème : ${raison || "le budget de modèle de la mission est épuisé."} Décision demandée : relever le plafond ou arrêter la mission.`, 700) };
    case "APPROVAL_REQUIRED":
      return { titre: `Votre accord — ${s.titre}`, corps: borne(`Périmètre : ${raison || "des effets qui exigent votre accord."} Décision demandée : approuver ou refuser depuis l'écran de la mission.`, 700) };
    case "PLAN_CHANGED":
      return { titre: `Le plan a changé — ${s.titre}`, corps: borne(`Contexte : ${raison || "de nouvelles étapes ne sont pas couvertes par votre accord."} Décision demandée : approuver la partie modifiée, et elle seule.`, 700) };
    case "QUESTION":
      return s.niveauSuggere === "INFO"
        ? { titre: `Réponse après relance — ${s.titre}`, corps: borne(`${raison || "Une réponse est arrivée après la relance."} ${phrase(s.decision) ? `À décider : ${phrase(s.decision)}` : ""}`.trim(), 700) }
        : { titre: `Une précision — ${s.titre}`, corps: borne(`${raison || "Une information manque."} ${phrase(s.decision) ? `Décision demandée : ${phrase(s.decision)}` : ""}`.trim(), 700) };
    case "WATCH_ALERT":
      return {
        titre: `Surveillance — ${s.titre}`,
        corps: borne(`Problème : ${raison || "un signal de surveillance s'est déclenché."} ${phrase(s.decision) ? `Recommandation : ${phrase(s.decision)}` : ""}`.trim(), 700),
      };
    case "WATCH_RESOLVED":
      return { titre: `Surveillance — ${s.titre}`, corps: borne(`Revenu à la normale : ${raison || "le problème signalé n'est plus observé."}`, 700) };
    case "WATCH_ENDED":
      return { titre: `Surveillance terminée — ${s.titre}`, corps: borne(`Résultat : ${raison || "la cible surveillée est arrivée à son terme."} Je cesse de la surveiller.`, 700) };
    case "WAIT_OVERDUE": {
      const a = s.attente;
      return {
        titre: `Sans réponse — ${s.titre}`,
        corps: borne(`Problème : ${raison || "une attente a dépassé son échéance"}${a ? ` (${a.jours} jour(s), ${a.relances} relance(s) déjà faites)` : ""}. ${phrase(s.decision) ? `Décision demandée : ${phrase(s.decision)}` : "Recommandation : relancer par un autre canal ou escalader."}`, 700),
      };
    }
  }
}

export type { NiveauSignal };
