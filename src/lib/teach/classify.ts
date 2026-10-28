/**
 * LE CLASSEMENT D'UN ENSEIGNEMENT — de la phrase à la nature, quand le modèle ne l'a pas dite.
 *
 * Le modèle qui appelle l'outil donne normalement `kind`. Quand il ne le fait pas, on ne
 * range pas au hasard : des indices lexicaux, pesés, décident — et la confiance est rendue
 * avec le verdict, pour que l'outil puisse DIRE « classé comme standard documentaire (confiance
 * moyenne) » plutôt que de faire croire à une certitude. Le classement ne change jamais le
 * TEXTE de la règle : il ne décide que de la case.
 *
 * Module PUR.
 */

import type { Kind } from "@/lib/teach/model";
import { niveauDepuisTexte, parleDuBriefDeReunion } from "@/lib/meetings/niveau";
import { plier } from "@/lib/utils";

interface Indice { kind: Kind; motif: RegExp; poids: number; libelle: string }

/** Les mots d'un canal → sa forme canonique (celle que la porte d'attention lit). */
const CANAL_CANONIQUE: Record<string, string> = { slack: "slack", teams: "teams", whatsapp: "whatsapp", sms: "sms", texto: "sms", email: "email", "e-mail": "email", mail: "email", courriel: "email", notification: "notification", erp: "notification" };

/** L'ordre compte peu : les poids se cumulent par nature, la plus lourde l'emporte. */
const INDICES: Indice[] = [
  { kind: "EXCEPTION", motif: /\b(sauf|excepte|a l'exception|hormis|par exception|ne s'applique pas)\b/, poids: 5, libelle: "« sauf / à l'exception »" },
  { kind: "MAPPING", motif: /\b(quand je dis|quand on dit|s'appelle|se dit|correspond a|veut dire|c'est-a-dire|abrege|abreviation|alias)\b|\s=\s/, poids: 4, libelle: "une correspondance de termes" },
  { kind: "BUSINESS_DEFINITION", motif: /\b(signifie|designe|on entend par|se definit|definition|est defini|s'entend)\b/, poids: 4, libelle: "une définition" },
  { kind: "VALIDATION_RULE", motif: /\b(valid(e|ation|er)|approuv|accord (du|de la|prealable)|autoris|au-dessus de|au dela de|superieur a|seuil|plafond|obligatoire(ment)?|interdit|jamais sans|doit (etre|passer))\b/, poids: 4, libelle: "une condition de validation ou un seuil" },
  { kind: "DOCUMENT_STANDARD", motif: /\b(papier en-tete|en-tete|mise en page|police|logo|numerot\w*|prefixe|valables? \d+|validite|format (de|du|des|date)|modeles? de (devis|facture|lettre|rapport|courrier)|pied de page|mentions? (legales?|obligatoires?)|signature|commencent? par|tva par defaut|conditions de (paiement|reglement))\b/, poids: 4, libelle: "un standard de document" },
  { kind: "WORKFLOW", motif: /\b(d'abord|puis|ensuite|apres quoi|avant de|etape|circuit|process|procedure|workflow|enchain|a chaque fois que|quand .* (arrive|est recu|est signe)|des que)\b/, poids: 4, libelle: "un enchaînement d'étapes" },
  { kind: "COMPANY_RULE", motif: /\b(toujours|jamais|systematiquement|obligatoire|chez nous|dans la societe|dans l'entreprise|politique|regle|interdiction|tout le monde|chaque salarie|toutes les (factures|demandes|commandes))\b/, poids: 3, libelle: "une règle générale de la maison" },
  { kind: "CONVENTION", motif: /\b(on ecrit|on nomme|on note|on classe|on range|convention|nomenclature|libelle|en francais|en anglais|tutoie|vouvoie|format de date|dd\/mm)\b/, poids: 3, libelle: "une convention d'écriture ou de classement" },
  { kind: "PREFERENCE", motif: /\b(je prefere|je veux|j'aime|pour moi|me (donner|envoyer|presenter)|mes (syntheses|rapports|mails)|court|bref|detaille|en trois points|le matin|le soir)\b/, poids: 4, libelle: "une préférence personnelle" },
];

export interface Classement {
  kind: Kind;
  /** 0–1. Sous 0,5, l'outil le dit et invite à préciser. */
  confiance: number;
  indices: string[];
}

/** CLASSE une phrase. Sans aucun indice : PREFERENCE, confiance basse — jamais une règle de société par défaut. */
export function classerEnseignement(texte: string): Classement {
  const t = ` ${plier(texte).replace(/\s+/g, " ")} `;
  const scores = new Map<Kind, { poids: number; indices: string[] }>();
  for (const i of INDICES) {
    if (!i.motif.test(t)) continue;
    const s = scores.get(i.kind) ?? { poids: 0, indices: [] };
    s.poids += i.poids;
    s.indices.push(i.libelle);
    scores.set(i.kind, s);
  }
  if (scores.size === 0) return { kind: "PREFERENCE", confiance: 0.35, indices: [] };
  const classes = [...scores.entries()].sort((a, b) => b[1].poids - a[1].poids);
  const [kind, meilleur] = classes[0];
  const second = classes[1]?.[1].poids ?? 0;
  // L'écart au second décide de la confiance : un seul indice isolé (poids 2–3) reste moyen.
  const confiance = Math.max(0.4, Math.min(0.95, 0.5 + (meilleur.poids - second) * 0.1 + Math.min(meilleur.poids, 6) * 0.03));
  return { kind, confiance: Math.round(confiance * 100) / 100, indices: meilleur.indices };
}

/**
 * LES PARAMÈTRES QU'UN PROGRAMME PEUT APPLIQUER, extraits de la phrase quand ils y sont en
 * clair. Seules les clés que la fabrique de documents et les correspondances comprennent sont
 * produites ; tout le reste reste du texte. Une valeur devinée à tort serait appliquée à tort :
 * on n'extrait que ce qui est écrit noir sur blanc.
 */
export function extraireParametres(texte: string, kind: Kind): Record<string, unknown> | null {
  const t = plier(texte);
  // LES PARAMÈTRES DOCUMENTAIRES SE LISENT QUELLE QUE SOIT LA NATURE. « Règle pour toute la
  // société : nos devis sont valables 45 jours » est classée COMPANY_RULE par le modèle — à bon
  // droit, c'est une règle de société — et la fabrique doit quand même en tirer « 45 jours ».
  // Mesuré au banc des défis : la règle était enregistrée, et le devis sortait à 30 jours.
  if (kind !== "MAPPING" && kind !== "VALIDATION_RULE") {
    // LE NIVEAU DE BRIEF DE RÉUNION (§32) : « pour mes réunions, briefing de chef de cabinet ».
    if (parleDuBriefDeReunion(t)) {
      const niveau = niveauDepuisTexte(t);
      if (niveau) return { cle: "niveauReunion", valeur: niveau };
    }
    // LE CANAL PRÉFÉRÉ ET LES HEURES DE SILENCE (§37) : « préviens-moi par Slack », « pas de notification entre 22 h et 7 h ».
    const canal = /(?:previens|preveni|notifie|alerte|contacte|joins|ecris|envoie|prevenez|notifiez)[- ]?(?:moi|le|la|nous)?[^.]{0,40}?(?:par|sur|via|en)\s+(slack|teams|whatsapp|sms|texto|e-?mail|mail|courriel|notification)\b/.exec(t)
      ?? /\b(?:canal|notifications?)\b[^.]{0,30}?(?:prefere|par defaut|uniquement|seulement|:)\s*[«"']?\s*(slack|teams|whatsapp|sms|texto|e-?mail|mail|courriel|notification|erp)\b/.exec(t)
      ?? /\b(slack|teams|whatsapp|sms|texto|e-?mail|mail|courriel)\b[^.]{0,20}?\b(?:de preference|plutot|uniquement|seulement|par defaut)\b/.exec(t);
    if (canal) return { cle: "canalPrefere", valeur: CANAL_CANONIQUE[canal[1]!] ?? canal[1] };
    const silence = /(?:pas de|aucune?|jamais de|sans|plus de)\s+(?:notifications?|push|messages?|alertes?|relances?|sms|appels?)[^.]{0,40}?(?:entre|de|apres|a partir de)\s+(\d{1,2})\s*h?(?:\s?\d{2})?\s*(?:et|a|jusqu'a|-)\s*(\d{1,2})\s*h?/.exec(t)
      ?? /(?:silence|ne pas (?:me )?deranger|tranquille|heures? de silence)[^.]{0,30}?(?:entre|de)\s+(\d{1,2})\s*h?[^0-9]{1,12}(\d{1,2})\s*h?/.exec(t);
    if (silence) {
      const de = Number(silence[1]); const a = Number(silence[2]);
      if (de >= 0 && de <= 24 && a >= 0 && a <= 24 && de !== a) return { cle: "heuresSilence", valeur: { de: de % 24, a: a % 24 } };
    }
    const validite = /devis[^.]{0,60}?(?:valable|validite)[^0-9]{0,20}(\d{1,3})\s*jours?|validite[^0-9]{0,30}(\d{1,3})\s*jours?/.exec(t);
    if (validite) return { cle: "validiteDevis", valeur: Number(validite[1] ?? validite[2]), unite: "jours" };
    const prefixe = /(factures?|devis|bons? de commande)[^.]{0,40}?(?:commencent? par|prefixe|numerot\w* en)\s*[«"']?\s*([a-z0-9]{1,8})\b/.exec(t);
    if (prefixe) {
      const cle = prefixe[1].startsWith("fact") ? "prefixeFacture" : prefixe[1].startsWith("devis") ? "prefixeDevis" : "prefixeBonDeCommande";
      return { cle, valeur: prefixe[2].toUpperCase() };
    }
    const tva = /tva[^0-9]{0,20}(\d{1,2})\s*%/.exec(t);
    if (tva) return { cle: "tvaDefaut", valeur: Number(tva[1]) / 100 };
    const paiement = /(?:paiement|reglement)[^.]{0,20}?(?:a|sous|:)\s*(\d{1,3})\s*jours?([^.]{0,30})/.exec(t);
    if (paiement) return { cle: "conditionsPaiement", valeur: `${paiement[1]} jours${paiement[2] ? paiement[2].trim() ? ` ${paiement[2].trim()}` : "" : ""}`.trim() };
  }
  if (kind === "MAPPING") {
    const m = /(?:quand (?:je|on) dis|quand (?:je|on) parle de)\s+[«"']?([^»"',]{1,60}?)[»"']?\s*,?\s*(?:c'est|il s'agit de|ca veut dire|je veux dire|entends?)\s+[«"']?([^»"'.]{1,120}?)[»"']?\s*\.?$/.exec(t)
      ?? /^[«"']?([^»"'=]{1,60}?)[»"']?\s*=\s*[«"']?([^»"'.]{1,120}?)[»"']?\s*\.?$/.exec(t);
    if (m) return { de: m[1].trim(), vers: m[2].trim() };
  }
  if (kind === "VALIDATION_RULE") {
    const seuil = /(\d[\d\s.,]*)\s*(k ?dzd|m ?dzd|dzd|da|dinars?)\b/.exec(t);
    if (seuil) {
      const brut = Number(seuil[1].replace(/[\s.]/g, "").replace(",", "."));
      const mult = /^k/.test(seuil[2]) ? 1_000 : /^m/.test(seuil[2]) ? 1_000_000 : 1;
      if (Number.isFinite(brut)) return { seuil: brut * mult, devise: "DZD" };
    }
  }
  return null;
}
