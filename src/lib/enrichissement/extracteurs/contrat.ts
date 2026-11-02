/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONTRAT, CONVENTION → FAITS — les PARTIES, et ce que le contrat dit de lui-même (§3-E).
 *
 * Un contrat algérien présente ses parties dans une formule constante :
 *
 *     ENTRE LES SOUSSIGNÉS :
 *     La société X, SARL au capital de 1 000 000,00 DA, dont le siège social est situé au …,
 *     immatriculée au registre du commerce sous le n° …, NIF …, représentée par M. … en sa
 *     qualité de Gérant, ci-après dénommée « le Prestataire », d'une part,
 *     ET : …, d'autre part.
 *
 * Chaque partie devient un sujet (`partie-1`, `partie-2`, rôle PARTIE) et ses faits du catalogue :
 * raison sociale, forme juridique, capital, siège, RC / NIF / NIS / AI, représentant légal. Une
 * partie PERSONNE (« Monsieur … », « Dr … ») n'est pas lue ici — c'est le lot des extracteurs de
 * personnes ; la note le dit.
 *
 * Les dates (signature, prise d'effet, fin), la durée, l'objet et le montant ne sont PAS des
 * attributs du catalogue : ils ne font pas de faits. Ils sont rendus à côté, dans `contrat`, avec
 * leur preuve — pour la fiche du document, ses échéances, son engagement. Quand l'appelant a déjà
 * la synthèse du modèle (`synthese-legale.ts`, une pièce qui pouvait sortir), elle COMPLÈTE ce
 * que les règles n'ont pas lu : jamais elle ne remplace une valeur imprimée.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, NaturePiece, ResultatExtraction } from "@/lib/enrichissement/types";
import type { SyntheseLegale } from "@/lib/pieces-lues/synthese-legale";
import {
  ATTRIBUT_IDENTIFIANT, CONFIANCE, datesDans, estPersonne, extraitDe, fait, formeJuridiqueDans, identifiantsDans, lignesDe, montantDans,
  montantNormalise, nettoyer, normaliserAdresse, normaliserNif, normaliserRaisonSociale, normaliserRc, normaliserTexte, plier, sansDoublons,
  type LigneDeTexte, type MontantLu,
} from "@/lib/enrichissement/extracteurs/commun-organisations";

export const MOTEUR_CONTRAT = "regles-contrat/1";

export type NatureContrat = Extract<NaturePiece, "CONTRAT" | "CONVENTION">;

export interface EntreeContrat {
  texte: string;
  nature?: NatureContrat;
  /** La synthèse du modèle, si la pièce a pu lui être montrée — elle complète, ne remplace pas. */
  synthese?: SyntheseLegale | null;
}

/** Une valeur du contrat avec sa preuve — ce qui n'est pas un fait du catalogue. */
export interface ElementDuContrat<T> {
  valeur: T;
  page: number | null;
  extrait: string;
  /** « regles » : lu sur le texte ; « modele » : venu de la synthèse. */
  source: "regles" | "modele";
}

export interface ElementsContrat {
  objet: ElementDuContrat<string> | null;
  /** ISO `AAAA-MM-JJ`. */
  dateSignature: ElementDuContrat<string> | null;
  dateDebut: ElementDuContrat<string> | null;
  dateFin: ElementDuContrat<string> | null;
  duree: ElementDuContrat<{ nombre: number; unite: "JOUR" | "MOIS" | "AN" }> | null;
  montant: ElementDuContrat<MontantLu & { taxes: "HT" | "TTC" | null }> | null;
  /** Le rôle que le contrat donne à chaque partie (« le Prestataire »), par `sujetRef`. */
  qualites: Record<string, string>;
}

export interface ExtractionContrat extends ResultatExtraction {
  contrat: ElementsContrat;
}

// ─────────────────────────────── Les parties ───────────────────────────────

const RE_ENTRE = /^\s*(?:entre(?:\s+les\s+soussigne(?:e)?s)?|il\s+a\s+ete\s+convenu\s+entre)\s*:?\s*/;
const RE_ET = /^\s*et(?:\s*:|\s*$|\s+(?=l[ae']|le\s|la\s|l'|m\.|mme|monsieur|madame|la\s+societe|l'entreprise|l'etablissement))/;
const RE_FIN_PARTIE = /d'?\s?(?:une|autre)\s+part/;
const RE_FIN_PARTIES = /(?:il\s+a\s+ete\s+(?:convenu|arrete)|ont\s+convenu|preambule|article\s+(?:1|premier|un)\b|objet\s+du\s+contrat|etant\s+prealablement\s+expose)/;

interface Partie { texte: string; lignes: LigneDeTexte[] }

function partiesDe(lignes: readonly LigneDeTexte[]): Partie[] {
  const i0 = lignes.findIndex((l) => RE_ENTRE.test(l.pli));
  if (i0 < 0) return [];
  const parties: Partie[] = [];
  let courante: LigneDeTexte[] = [];
  const clore = () => {
    const t = courante.map((l) => l.texte).join(" ").replace(/\s+/g, " ").trim();
    if (t.replace(/[^A-Za-z]/g, "").length >= 3) parties.push({ texte: t, lignes: courante });
    courante = [];
  };
  for (let i = i0; i < lignes.length && parties.length < 4; i++) {
    const l = lignes[i];
    let pli = l.pli;
    let texte = l.texte;
    if (i === i0) {
      const m = RE_ENTRE.exec(pli);
      const n = m ? m[0].length : 0;
      pli = pli.slice(n); texte = texte.slice(n);
    }
    if (i > i0 && RE_FIN_PARTIES.test(pli) && !RE_FIN_PARTIE.test(pli)) break;
    const et = RE_ET.exec(pli);
    if (et && i > i0) {
      clore();
      pli = pli.slice(et[0].length); texte = texte.slice(et[0].length);
    }
    if (!pli.trim()) continue;
    const fin = RE_FIN_PARTIE.exec(pli);
    if (fin) {
      const avant = texte.slice(0, fin.index);
      if (avant.trim()) courante.push({ ...l, texte: avant, pli: pli.slice(0, fin.index) });
      clore();
      if (/autre\s+part/.test(fin[0])) break;
      continue;
    }
    courante.push({ ...l, texte, pli });
  }
  clore();
  return parties;
}

/** Ce qui ouvre la désignation d'une partie et n'en fait pas partie (sur le pli). */
const RE_ARTICLE = /^\s*(?:(?:la|le|l')\s*(?:societe|entreprise|etablissement|ste|agence|laboratoire|association|groupe|cabinet|clinique)?\s*(?:denommee|denomme|dite)?\s*:?\s*)?/;
/** Ce qui suit le nom dans la formule : la forme, le capital, le siège, l'immatriculation… (sur le pli). */
const RE_APRES_NOM = /,|\s+(?:au\s+capital|dont\s+le\s+siege|sise?\s|domicilie|immatricul|inscrite?|represent|agissant|ci-?\s?apres|n\.?\s?i\.?\s?f|r\.?\s?c\.?\s)/;
/** Ce qui clôt un élément de la formule (sur le pli). */
const RE_FIN_ELEMENT = /,\s*(?:immatricul|inscrite?|represent|ci-?\s?apres|titulaire|n\.?\s?i\.?\s?f|r\.?\s?c\.?\s|n\.?\s?i\.?\s?s|article|au\s+capital|prise?\s+en|dont\s+le\s+siege)|;|\s+d'?\s?(?:une|autre)\s+part|\.\s+[a-z]/;

function nomDePartie(texte: string): string | null {
  const pli = plier(texte);
  const debut = RE_ARTICLE.exec(pli)?.[0].length ?? 0;
  const coupe = RE_APRES_NOM.exec(pli.slice(debut));
  const nom = nettoyer(coupe ? texte.slice(debut, debut + coupe.index) : texte.slice(debut, debut + 120));
  const propre = nom.replace(/^["«\s]+|["»\s]+$/g, "");
  return propre.length >= 2 ? propre : null;
}

/** Le passage qui suit un marqueur, jusqu'au prochain élément de la formule. */
function passageApres(texte: string, re: RegExp): { valeur: string; extrait: string } | null {
  const pli = plier(texte);
  const m = re.exec(pli);
  if (!m) return null;
  const debut = (m.index ?? 0) + m[0].length;
  const fin = RE_FIN_ELEMENT.exec(pli.slice(debut));
  const valeur = nettoyer(fin ? texte.slice(debut, debut + fin.index) : texte.slice(debut, debut + 160));
  return valeur ? { valeur, extrait: extraitDe(texte.slice(Math.max(0, (m.index ?? 0)), debut + valeur.length + 2)) } : null;
}

const RE_SIEGE = /(?:dont\s+le\s+siege(?:\s+social)?\s+est\s+(?:situe|sis|fixe|etabli)\s*(?:au|a\s+l'adresse|a|:)?|siege\s+social\s*:|sise?\s+(?:au|a|:)|domicilie(?:e)?\s+(?:au|a)|demeurant\s+(?:au|a))\s*/;
const RE_REPRESENTANT = /(?:representee?\s+(?:legalement\s+)?par|prise?\s+en\s+la\s+personne\s+de)\s*/;
const RE_QUALITE_PARTIE = /ci-?\s?apres\s+(?:denommee?|designee?|appelee?)\s*:?\s*"?\s*((?:l[ae']\s*)?[a-z' -]{3,40}?)\s*"?(?:,|\.|$|\s+d'|\s+ou\s)/;

// ─────────────────────────────── Les éléments du contrat ───────────────────────────────

const UNITES: Record<string, "JOUR" | "MOIS" | "AN"> = { jour: "JOUR", jours: "JOUR", mois: "MOIS", an: "AN", ans: "AN", annee: "AN", annees: "AN" };
const NOMBRES: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, quinze: 15, dix_huit: 18, vingt: 20, trente: 30, soixante: 60, quatre_vingt_dix: 90 };

function elementsDe(lignes: readonly LigneDeTexte[]): ElementsContrat {
  const el: ElementsContrat = { objet: null, dateSignature: null, dateDebut: null, dateFin: null, duree: null, montant: null, qualites: {} };
  const regle = <T>(valeur: T, l: LigneDeTexte): ElementDuContrat<T> => ({ valeur, page: l.page, extrait: extraitDe(l.texte), source: "regles" });
  for (const l of lignes) {
    const p = l.pli;
    if (!el.objet) {
      const m = /(?:a|ont)\s+pour\s+objet\s*(?:de\s+|d')?\s*:?\s*/.exec(p) ?? /^\s*objet(?:\s+du\s+(?:contrat|marche)|\s+de\s+la\s+convention)?\s*:\s*/.exec(p);
      if (m) {
        const v = nettoyer(l.texte.slice((m.index ?? 0) + m[0].length).split(/\.\s/)[0]);
        if (v.length >= 5) el.objet = regle(v.slice(0, 240), l);
      }
    }
    const dates = datesDans(p);
    if (dates.length > 0) {
      if (!el.dateSignature && /fait\s+(?:en\s+\w+\s+exemplaires\s+)?a\s+[a-z' -]+,?\s*le|signe\s+le|date\s+de\s+signature/.test(p)) el.dateSignature = regle(dates[dates.length - 1].iso, l);
      const effet = /(?:prend(?:ra)?\s+effet|entre(?:ra)?\s+en\s+vigueur|a\s+compter\s+du|a\s+partir\s+du|date\s+d'?\s?effet|prise\s+d'?\s?effet)/.exec(p);
      if (!el.dateDebut && effet) {
        const d = dates.find((x) => x.debut >= (effet.index ?? 0)) ?? dates[0];
        el.dateDebut = regle(d.iso, l);
      }
      const fin = /(?:jusqu'?\s?au|expire(?:ra)?\s+le|prend(?:ra)?\s+fin\s+le|date\s+(?:de\s+fin|d'?\s?expiration|d'?\s?echeance))/.exec(p);
      if (!el.dateFin && fin) {
        const d = dates.find((x) => x.debut >= (fin.index ?? 0));
        if (d) el.dateFin = regle(d.iso, l);
      }
      // « pour la période du 01/01/2027 au 31/12/2027 »
      if (!el.dateDebut && !el.dateFin && dates.length >= 2 && /(?:periode|valable|duree)?[^.]*du\s/.test(p) && /\sau\s/.test(p) && dates[0].iso < dates[1].iso) {
        el.dateDebut = regle(dates[0].iso, l);
        el.dateFin = regle(dates[1].iso, l);
      }
    }
    if (!el.duree) {
      const m = /(?:pour\s+une\s+)?(?:duree|periode)\s+(?:ferme\s+)?(?:de\s+|d')\s*(?:([a-z_ -]+?)\s*)?(?:\(\s*(\d{1,3})\s*\)\s*|(\d{1,3})\s+)(jours?|mois|ans?|annees?)(?![a-z])/.exec(p);
      if (m) {
        const n = Number(m[2] ?? m[3]) || NOMBRES[(m[1] ?? "").trim().replace(/[\s-]+/g, "_")] || 0;
        if (n > 0) el.duree = regle({ nombre: n, unite: UNITES[m[4]] }, l);
      }
    }
    if (!el.montant) {
      const m = /(?:montant|prix|cout|valeur|remuneration|honoraires|enveloppe)(?:\s+(?:global|total|forfaitaire|annuel|mensuel|de\s+la\s+convention|du\s+contrat|du\s+marche))*\s*(?:(?:est|sont)\s+(?:fixe|arrete|evalue)e?s?\s+a|s'?\s?eleve(?:nt)?\s+a|de|:|=)\s*/.exec(p)
        ?? /pour\s+un\s+montant\s+(?:global\s+|total\s+)?(?:de\s+)?/.exec(p);
      if (m) {
        const passage = l.texte.slice((m.index ?? 0) + m[0].length);
        const lu = montantDans(passage.slice(0, 80));
        if (lu && lu.valeur >= 100) {
          const apres = plier(passage.slice(0, 120));
          const taxes = /(?<![a-z])(?:h\.?\s?t\.?|hors\s+taxes?)(?![a-z])/.test(apres) ? "HT" : /(?<![a-z])(?:t\.?\s?t\.?\s?c\.?|toutes\s+taxes)(?![a-z])/.test(apres) ? "TTC" : null;
          el.montant = regle({ ...lu, taxes }, l);
        }
      }
    }
  }
  return el;
}

// ─────────────────────────────── L'extracteur ───────────────────────────────

export function extraireContrat(e: EntreeContrat): ExtractionContrat {
  const lignes = lignesDe(e.texte);
  const notes: string[] = [];
  const faits: (FaitExtrait | null)[] = [];
  const nature: NaturePiece = e.nature ?? (/(?<![a-z])convention(?![a-z])/.test(lignes.slice(0, 15).map((l) => l.pli).join(" ")) ? "CONVENTION" : "CONTRAT");
  const contrat = elementsDe(lignes);

  const parties = partiesDe(lignes);
  if (parties.length === 0) notes.push("La formule « Entre les soussignés … et … » ne se lit pas : les parties ne sont pas proposées par les règles.");
  let rang = 0;
  for (const partie of parties) {
    const nom = nomDePartie(partie.texte);
    const premiere = partie.lignes[0];
    const page = premiere?.page ?? null;
    if (!nom) continue;
    if (estPersonne(nom) === true || /^(?:monsieur|madame|mademoiselle|m\.|mme|dr|docteur|pr|professeur)\s/i.test(nettoyer(partie.texte))) {
      notes.push("Une partie est une personne : elle relève des extracteurs de personnes, aucun fait d'organisation n'en est tiré.");
      continue;
    }
    rang++;
    const sujet = { sujetRef: `partie-${rang}`, role: "PARTIE" as const };
    const qualite = RE_QUALITE_PARTIE.exec(plier(partie.texte));
    if (qualite) {
      const debut = qualite.index + qualite[0].indexOf(qualite[1]);
      contrat.qualites[sujet.sujetRef] = nettoyer(partie.texte.slice(debut, debut + qualite[1].length));
    }
    faits.push(fait({ ...sujet, attribut: "organisation.raisonSociale", valeur: nom, valeurNormalisee: normaliserRaisonSociale(nom) ?? nom, confiance: CONFIANCE.PHRASE, page, extrait: partie.texte }));
    const forme = formeJuridiqueDans(partie.texte.slice(0, 200));
    if (forme) faits.push(fait({ ...sujet, attribut: "organisation.formeJuridique", valeur: forme, valeurNormalisee: normaliserTexte(forme) ?? forme, confiance: CONFIANCE.PHRASE, page, extrait: partie.texte }));
    const capital = passageApres(partie.texte, /au\s+capital(?:\s+social)?\s+de\s*/);
    const montantCapital = capital ? montantDans(capital.valeur) : null;
    if (capital && montantCapital) faits.push(fait({ ...sujet, attribut: "organisation.capital", valeur: montantCapital.brut, valeurNormalisee: montantNormalise({ valeur: montantCapital.valeur, devise: montantCapital.devise ?? "DZD" }), confiance: CONFIANCE.PHRASE, page, extrait: capital.extrait }));
    const siege = passageApres(partie.texte, RE_SIEGE);
    const siegeNorm = siege ? normaliserAdresse(siege.valeur) : null;
    if (siege && siegeNorm) faits.push(fait({ ...sujet, attribut: "organisation.adresse", valeur: siege.valeur, valeurNormalisee: siegeNorm, confiance: CONFIANCE.PHRASE, page, extrait: siege.extrait }));
    const rep = passageApres(partie.texte, RE_REPRESENTANT);
    if (rep) {
      // « M. Karim BOUZID en sa qualité de Gérant » → « M. Karim BOUZID (Gérant) ».
      const q = /\s*,?\s*(?:(?:agissant\s+)?en\s+(?:sa\s+)?qualite\s+de|en\s+tant\s+que)\s+/.exec(plier(rep.valeur));
      const personne = nettoyer(q ? rep.valeur.slice(0, q.index) : rep.valeur);
      const fonction = q ? nettoyer(rep.valeur.slice(q.index + q[0].length)) : "";
      const valeur = fonction ? `${personne} (${fonction})` : personne;
      if (personne) faits.push(fait({ ...sujet, attribut: "organisation.representant", valeur, valeurNormalisee: normaliserTexte(personne) ?? personne, confiance: CONFIANCE.PHRASE, page, extrait: rep.extrait }));
    }
    const ids = identifiantsDans(partie.lignes);
    for (const id of ids) {
      faits.push(fait({ ...sujet, attribut: ATTRIBUT_IDENTIFIANT[id.champ], valeur: id.brut, valeurNormalisee: id.valeur, confiance: CONFIANCE.VERIFIE, page: id.ligne.page, extrait: id.ligne.texte }));
    }
  }

  // ── LA SYNTHÈSE DU MODÈLE complète ce que les règles n'ont pas lu ─────────────────────
  const s = e.synthese;
  if (s) {
    const modele = <T>(v: { valeur: T; extrait: string }): ElementDuContrat<T> => ({ valeur: v.valeur, page: null, extrait: v.extrait, source: "modele" });
    if (!contrat.dateDebut && s.dateDebut) contrat.dateDebut = modele(s.dateDebut);
    if (!contrat.dateFin && s.dateFin) contrat.dateFin = modele(s.dateFin);
    if (!contrat.duree && s.duree) contrat.duree = modele(s.duree);
    const c = s.contrepartie;
    const cle = normaliserRaisonSociale(c.nom);
    const dejaLue = cle !== null && faits.some((f) => f?.attribut === "organisation.raisonSociale" && f.valeurNormalisee === cle);
    if (c.nom && !dejaLue && estPersonne(c.nom) !== true) {
      rang++;
      const sujet = { sujetRef: `partie-${rang}`, role: "PARTIE" as const, page: null };
      const extrait = `Contrepartie lue par le modèle : ${c.nom}`;
      faits.push(fait({ ...sujet, attribut: "organisation.raisonSociale", valeur: c.nom, valeurNormalisee: cle ?? c.nom, confiance: CONFIANCE.MODELE, extrait }));
      const nif = normaliserNif(c.nif);
      if (nif) faits.push(fait({ ...sujet, attribut: "organisation.nif", valeur: nif, valeurNormalisee: nif, confiance: CONFIANCE.MODELE, extrait }));
      const rc = normaliserRc(c.rc);
      if (rc) faits.push(fait({ ...sujet, attribut: "organisation.rc", valeur: c.rc ?? rc, valeurNormalisee: rc, confiance: CONFIANCE.MODELE, extrait }));
      const adresse = normaliserAdresse(c.adresse);
      if (c.adresse && adresse) faits.push(fait({ ...sujet, attribut: "organisation.adresse", valeur: c.adresse, valeurNormalisee: adresse, confiance: CONFIANCE.MODELE, extrait }));
      notes.push("Une partie vient de la synthèse du modèle (absente de la formule lue par les règles) : à confirmer.");
    }
  }

  if (!contrat.dateDebut && !contrat.dateSignature) notes.push("Ni date de signature ni date de prise d'effet ne se lisent.");
  if (!contrat.montant) notes.push("Aucun montant du contrat ne se lit (« montant de … », « pour un montant de … »).");
  const local = !s;
  return { nature, moteur: s ? `${MOTEUR_CONTRAT}+synthese-legale` : MOTEUR_CONTRAT, local, faits: sansDoublons(faits), notes, contrat };
}
