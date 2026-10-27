/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PROGRAMME DE CONGRÈS → FAITS — l'ORGANISATEUR (une société savante), et l'événement (§3-E).
 *
 * Un programme scientifique dit QUI organise (« organisé par la Société Algérienne de
 * Cardiologie », « sous l'égide de … ») et QUAND et OÙ l'événement a lieu. L'organisateur devient
 * un sujet (`organisateur-1`, `organisateur-2` en co-organisation, rôle ORGANISATEUR) : raison
 * sociale, sigle (`organisation.nomCommercial`), site web, e-mail et téléphone de son secrétariat.
 *
 * L'intitulé, les dates et le lieu ne sont PAS des attributs du catalogue : ils sont rendus à
 * côté (`evenement`), avec leur preuve — de quoi relier le programme à un événement de l'ERP.
 *
 * Ce qui n'est JAMAIS pris pour l'organisateur : les laboratoires partenaires ou sponsors, et
 * l'agence de l'organisation logistique (hébergement, transport) — un programme les imprime tous,
 * seul l'organisateur scientifique est le sujet. Les coordonnées ne se rattachent à lui que sur
 * une ligne de contact (« Secrétariat », « Contact », « Site ») qui ne nomme pas une agence.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, ResultatExtraction } from "@/lib/enrichissement/types";
import {
  CONFIANCE, extraitDe, fait, lignesDe, nettoyer, normaliserEmail, normaliserRaisonSociale, normaliserSiteWeb, normaliserTelephone,
  normaliserTexte, periodeDans, plier, sansDoublons, type LigneDeTexte,
} from "@/lib/enrichissement/extracteurs/commun-organisations";

export const MOTEUR_PROGRAMME = "regles-programme-congres/1";

export interface EntreeProgramme {
  texte: string;
}

export interface ElementDeLEvenement<T> {
  valeur: T;
  page: number | null;
  extrait: string;
}

export interface Evenement {
  intitule: ElementDeLEvenement<string> | null;
  /** ISO `AAAA-MM-JJ`. */
  dateDebut: ElementDeLEvenement<string> | null;
  dateFin: ElementDeLEvenement<string> | null;
  lieu: ElementDeLEvenement<string> | null;
}

export interface ExtractionProgramme extends ResultatExtraction {
  evenement: Evenement;
}

const RE_EVENEMENT = /(?<![a-z])(?:congres|journees?|symposium|seminaire|colloque|workshop|conference|rencontres?|forum|assises|ecole\s+d'?\s?ete|masterclass|cours\s+superieur|sommet|summit|meeting)(?![a-z])/;
/** Une société savante, telle qu'elle se nomme. */
const RE_SOCIETE_SAVANTE = /^(?:la\s+|l')?(?:societe|association|college|federation|academie|groupe(?:ment)?|club|ordre|syndicat|union|alliance|reseau|fondation|ligue)\s+(?:algerienne|nationale|maghrebine|africaine|arabe|internationale|francophone|mediterraneenne|des|de|du|d')/;
const RE_ORGANISE_PAR = /(?:organise(?:e|es|s)?\s+par|sous\s+l'?\s?egide\s+de|a\s+l'?\s?initiative\s+de|a\s+l'?\s?invitation\s+de|sous\s+le\s+patronage\s+de)\s*:?\s*/;
const RE_COORGANISATION = /\s+(?:en\s+(?:collaboration|partenariat|association)\s+avec|avec\s+la\s+participation\s+de|conjointement\s+avec)\s+|\s+et\s+(?=(?:la|le|l')\s*(?:societe|association|college|federation|academie|groupe|club|ordre|union)\s)/;
/** Ce qui n'est pas l'organisateur scientifique. */
const RE_PAS_ORGANISATEUR = /(?<![a-z])(?:sponsor|partenaires?|laboratoires?|labo|pharma(?:ceutiques?|ceuticals?)?|agence|organisation\s+logistique|logistique|hebergement|transport|voyages?|tourisme|events?|evenementiel\w*|communication|traiteur)(?![a-z])/;
const RE_CONTACT = /(?<![a-z])(?:secretariat|contact|renseignements|informations?|inscriptions?|site(?:\s+web|\s+internet)?|web|e-?mail|courriel|tel|telephone)(?![a-z])/;
const RE_LIEU = /^(?:lieu|adresse|venue|salle)\s*:\s*/;
const RE_LIEU_TYPE = /(?<![a-z])(?:hotel|centre\s+(?:international\s+)?de(?:s)?\s+conferences?|c\.?\s?i\.?\s?c\.?(?![a-z])|palais\s+(?:des\s+congres|de\s+la\s+culture|des\s+expositions)|auditorium|amphitheatre|faculte|universite|chu(?![a-z])|cercle\s+national|safex)(?![a-z])/;

/** Une ligne d'organisateur : le nom seul, sans la formule. Le sigle entre parenthèses est rendu à part. */
function organisateursDe(passage: string): { nom: string; sigle: string | null }[] {
  return passage.split(new RegExp(RE_COORGANISATION.source, "i")).map((morceau) => {
    const brut = nettoyer(morceau.replace(/^(?:la|le|l')\s*/i, "").replace(/[.,;]\s*(?:du|le|les)\s+\d.*$/i, ""));
    const sigle = /\(\s*([A-Z][A-Za-z0-9&.-]{1,14})\s*\)/.exec(brut)?.[1] ?? null;
    const nom = nettoyer(brut.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+[-–—]\s+.*$/, ""));
    return { nom: nom.slice(0, 160), sigle };
  }).filter((o) => o.nom.length >= 4 && !RE_PAS_ORGANISATEUR.test(plier(o.nom)));
}

export function extraireProgrammeCongres(e: EntreeProgramme): ExtractionProgramme {
  const lignes = lignesDe(e.texte);
  const notes: string[] = [];
  const faits: (FaitExtrait | null)[] = [];
  const evenement: Evenement = { intitule: null, dateDebut: null, dateFin: null, lieu: null };
  const element = <T>(valeur: T, l: LigneDeTexte, extrait?: string): ElementDeLEvenement<T> => ({ valeur, page: l.page, extrait: extraitDe(extrait ?? l.texte) });

  // ── L'INTITULÉ : la première ligne courte qui nomme un événement (le congrès d'abord) ─
  const titres = lignes.slice(0, 40).filter((l) => RE_EVENEMENT.test(l.pli) && l.texte.trim().length <= 160 && !RE_ORGANISE_PAR.test(l.pli));
  const titre = titres.find((l) => /congres/.test(l.pli)) ?? titres[0] ?? null;
  if (titre) evenement.intitule = element(nettoyer(titre.texte), titre);
  else notes.push("L'intitulé de l'événement (congrès, journées, symposium…) ne se lit pas dans l'en-tête.");

  // ── L'ORGANISATEUR ───────────────────────────────────────────────────────────────────
  let trouves: { nom: string; sigle: string | null; ligne: LigneDeTexte; extrait: string; confiance: number }[] = [];
  for (let i = 0; i < lignes.length && trouves.length === 0; i++) {
    const l = lignes[i];
    const m = RE_ORGANISE_PAR.exec(l.pli);
    if (!m) continue;
    let passage = l.texte.slice((m.index ?? 0) + m[0].length);
    let extrait = l.texte;
    if (!nettoyer(passage) && lignes[i + 1]) { passage = lignes[i + 1].texte; extrait = `${l.texte} ${lignes[i + 1].texte}`; }
    trouves = organisateursDe(passage).map((o) => ({ ...o, ligne: l, extrait, confiance: CONFIANCE.PHRASE }));
  }
  if (trouves.length === 0) {
    // Sans formule, une société savante nommée en tête du programme (son logo, son en-tête).
    const l = lignes.slice(0, 25).find((x) => RE_SOCIETE_SAVANTE.test(x.pli.trim()) && x.texte.trim().length <= 160 && !RE_PAS_ORGANISATEUR.test(x.pli));
    if (l) trouves = organisateursDe(l.texte).map((o) => ({ ...o, ligne: l, extrait: l.texte, confiance: CONFIANCE.DEDUITE }));
  }
  if (trouves.length === 0) notes.push("L'organisateur ne se lit pas (ni « organisé par », ni « sous l'égide de », ni société savante en tête).");

  trouves.forEach((o, k) => {
    const sujet = { sujetRef: `organisateur-${k + 1}`, role: "ORGANISATEUR" as const, page: o.ligne.page, extrait: o.extrait };
    faits.push(fait({ ...sujet, attribut: "organisation.raisonSociale", valeur: o.nom, valeurNormalisee: normaliserRaisonSociale(o.nom) ?? o.nom, confiance: o.confiance }));
    if (o.sigle) faits.push(fait({ ...sujet, attribut: "organisation.nomCommercial", valeur: o.sigle, valeurNormalisee: normaliserTexte(o.sigle) ?? o.sigle, confiance: o.confiance }));
  });

  // ── LES COORDONNÉES DU SECRÉTARIAT — seulement avec un seul organisateur ─────────────
  if (trouves.length === 1) {
    const sujet = { sujetRef: "organisateur-1", role: "ORGANISATEUR" as const };
    const contacts = lignes.filter((l) => RE_CONTACT.test(l.pli) && !RE_PAS_ORGANISATEUR.test(l.pli));
    let site: string | null = null;
    let email: string | null = null;
    let tel: string | null = null;
    for (const l of contacts) {
      const w = /(?:https?:\/\/|www\.)[^\s,;]+/i.exec(l.texte);
      if (w && !site) {
        const n = normaliserSiteWeb(w[0]);
        if (n) { site = n; faits.push(fait({ ...sujet, attribut: "organisation.siteWeb", valeur: w[0].replace(/[.)]+$/, ""), valeurNormalisee: n, confiance: CONFIANCE.DEDUITE, page: l.page, extrait: l.texte })); }
      }
      const m = normaliserEmail(l.texte);
      if (m && !email) { email = m; faits.push(fait({ ...sujet, attribut: "organisation.email", valeur: m, valeurNormalisee: m, confiance: CONFIANCE.DEDUITE, page: l.page, extrait: l.texte })); }
      const t = /(?:\+|00)?\d[\d\s().-]{7,}\d/.exec(l.texte.replace(/(?:https?:\/\/|www\.)\S+/gi, ""));
      const tn = t ? normaliserTelephone(t[0]) : null;
      if (t && tn && !tel) { tel = tn; faits.push(fait({ ...sujet, attribut: "organisation.telephone", valeur: nettoyer(t[0]), valeurNormalisee: tn, confiance: CONFIANCE.DEDUITE, page: l.page, extrait: l.texte })); }
    }
  } else if (trouves.length > 1) {
    notes.push("Plusieurs organisateurs : les coordonnées du secrétariat ne sont rattachées à aucun d'eux.");
  }

  // ── LES DATES ET LE LIEU ─────────────────────────────────────────────────────────────
  // Une date de programme se lit en tête ; une date limite (inscriptions, résumés) n'est pas celle de l'événement.
  const periode = periodeDans(lignes.slice(0, 60), { exclure: (l) => /(?:date\s+limite|avant\s+le|deadline|soumission|resumes?|abstracts?|inscriptions?\s+(?:avant|jusqu))/.test(l.pli) });
  if (periode) {
    evenement.dateDebut = element(periode.debut, periode.ligne);
    evenement.dateFin = element(periode.fin, periode.ligne);
  } else {
    notes.push("Les dates de l'événement ne se lisent pas dans l'en-tête du programme.");
  }
  const lieuEtiquete = lignes.find((l) => RE_LIEU.test(l.pli));
  if (lieuEtiquete) {
    const m = RE_LIEU.exec(lieuEtiquete.pli);
    const v = nettoyer(lieuEtiquete.texte.slice(m ? m[0].length : 0));
    if (v) evenement.lieu = element(v, lieuEtiquete);
  }
  if (!evenement.lieu) {
    const l = lignes.slice(0, 60).find((x) => RE_LIEU_TYPE.test(x.pli) && x.texte.trim().length <= 160 && !RE_ORGANISE_PAR.test(x.pli));
    if (l) {
      const m = RE_LIEU_TYPE.exec(l.pli);
      evenement.lieu = element(nettoyer(l.texte.slice(m?.index ?? 0)).replace(/^(?:a|à)\s+l'/i, ""), l);
    } else {
      notes.push("Le lieu de l'événement ne se lit pas.");
    }
  }

  return { nature: "PROGRAMME_CONGRES", moteur: MOTEUR_PROGRAMME, local: true, faits: sansDoublons(faits), notes, evenement };
}
