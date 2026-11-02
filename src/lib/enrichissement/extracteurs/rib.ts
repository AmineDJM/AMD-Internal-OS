/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RELEVÉ D'IDENTITÉ BANCAIRE (ou postal) → FAITS — la banque, le titulaire, le compte (§3-E).
 *
 * Un RIB est une pièce LOCALE (`NATURES_LOCALES`) : il se lit sur ce serveur, par des règles,
 * et le compte est un fait SENSIBLE — il va au coffre, jamais en clair dans une fiche, jamais à
 * un modèle ; même sa preuve est masquée (`fait` du socle commun).
 *
 *   • LE COMPTE — un RIB algérien de 20 chiffres (groupé « 004 00364 4000030946 07 » ou non,
 *     en ligne ou en tableau « Code banque | Code agence | N° de compte | Clé ») ou un IBAN.
 *     Il n'est proposé que si sa CLÉ se vérifie : un compte faux n'est pas « à confirmer », il
 *     n'est pas proposé — une personne qui confirmerait d'un coup d'œil un chiffre abîmé ferait
 *     virer l'argent ailleurs.
 *   • LA BANQUE — sous son étiquette (« Banque », « Domiciliation »), sinon le nom d'une banque
 *     de la place reconnu dans l'en-tête.
 *   • LE TITULAIRE — sous son étiquette (« Titulaire », « Intitulé du compte », « Au nom de »).
 *     Une société → faits `organisation.*` ; une personne (civilité : « M. », « Mme », « Dr ») →
 *     `personne.rib` et le nom imprimé ; non tranché → l'appelant le dit (`titulaire`), sinon
 *     lu comme une organisation à confiance réduite, et la note le dit.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, ResultatExtraction } from "@/lib/enrichissement/types";
import {
  CONFIANCE, comptesDans, estPersonne, fait, lignesDe, nettoyer, normaliserRaisonSociale, normaliserTexte, ribValide, sansDoublons,
  valeurEtiquetee, type CompteLu, type LigneDeTexte,
} from "@/lib/enrichissement/extracteurs/commun-organisations";

export const MOTEUR_RIB = "regles-rib/1";

export interface EntreeRib {
  texte: string;
  /** Qui est le titulaire, quand l'appelant le sait (pièce déposée sur une fiche Personne ou Organisation). */
  titulaire?: "PERSONNE" | "ORGANISATION";
}

const SUJET = "titulaire";

/** Les banques de la place, telles qu'un en-tête les imprime — pour nommer la banque sans étiquette. */
const BANQUES: { nom: string; re: RegExp }[] = [
  { nom: "Banque Nationale d'Algérie (BNA)", re: /banque\s+nationale\s+d'?\s?algerie|(?<![a-z])b\.?n\.?a\.?(?![a-z])/ },
  { nom: "Banque Extérieure d'Algérie (BEA)", re: /banque\s+exterieure\s+d'?\s?algerie|(?<![a-z])b\.?e\.?a\.?(?![a-z])/ },
  { nom: "Crédit Populaire d'Algérie (CPA)", re: /credit\s+populaire\s+d'?\s?algerie|(?<![a-z])c\.?p\.?a\.?(?![a-z])/ },
  { nom: "Banque de l'Agriculture et du Développement Rural (BADR)", re: /banque\s+de\s+l'?\s?agriculture|(?<![a-z])badr(?![a-z])/ },
  { nom: "Banque de Développement Local (BDL)", re: /banque\s+de\s+developpement\s+local|(?<![a-z])b\.?d\.?l\.?(?![a-z])/ },
  { nom: "CNEP-Banque", re: /(?<![a-z])cnep(?![a-z])|caisse\s+nationale\s+d'?\s?epargne/ },
  { nom: "Algérie Poste (CCP)", re: /algerie\s+poste|(?<![a-z])c\.?c\.?p\.?(?![a-z])|releve\s+d'?\s?identite\s+postale/ },
  { nom: "Société Générale Algérie", re: /societe\s+generale\s+algerie/ },
  { nom: "BNP Paribas El Djazaïr", re: /bnp\s+paribas/ },
  { nom: "Natixis Algérie", re: /natixis/ },
  { nom: "AGB — Gulf Bank Algeria", re: /gulf\s+bank|(?<![a-z])agb(?![a-z])/ },
  { nom: "Al Baraka Bank Algérie", re: /al\s+baraka/ },
  { nom: "Al Salam Bank Algeria", re: /al\s+salam\s+bank/ },
  { nom: "Trust Bank Algeria", re: /trust\s+bank/ },
  { nom: "The Housing Bank for Trade and Finance", re: /housing\s+bank/ },
  { nom: "Fransabank El Djazaïr", re: /fransabank/ },
  { nom: "Arab Banking Corporation (ABC)", re: /arab\s+banking\s+corporation|(?<![a-z])banque\s+abc(?![a-z])/ },
  { nom: "Arab Bank", re: /(?<![a-z])arab\s+bank(?![a-z])/ },
  { nom: "Citibank Algérie", re: /citibank/ },
  { nom: "Calyon / Crédit Agricole CIB Algérie", re: /calyon|credit\s+agricole/ },
  { nom: "HSBC Algérie", re: /(?<![a-z])hsbc(?![a-z])/ },
];

const RE_TITULAIRE = /^(?:titulaire(?:\s+du\s+compte)?|intitule(?:\s+du\s+compte)?|nom\s+du\s+titulaire|au\s+nom\s+de|beneficiaire|nom\s+(?:et\s+prenoms?|ou\s+raison\s+sociale)|raison\s+sociale)\s*:?\s*/;
const RE_BANQUE = /^(?:banque|etablissement(?:\s+bancaire)?|domiciliation(?:\s+bancaire)?|nom\s+de\s+la\s+banque)\s*:?\s*/;
const RE_AGENCE = /^(?:agence|guichet)\s*:?\s*/;

/**
 * UN RIB EN TABLEAU : « Code banque | Code agence | N° de compte | Clé RIB » sur une ligne, les
 * valeurs sur la suivante (« 004  00364  4000030946  07 ») — ce que `comptesDans` lit déjà, les
 * vingt chiffres se suivant. Restent les tableaux dont la clé est sur sa propre ligne : on recolle.
 */
function compteEnTableau(lignes: readonly LigneDeTexte[]): CompteLu | null {
  for (let i = 0; i < lignes.length; i++) {
    if (!/code\s+banque/.test(lignes[i].pli) || !/cle/.test(lignes[i].pli)) continue;
    const suite = lignes.slice(i + 1, i + 5).map((l) => l.texte.replace(/\D/g, "")).join("");
    if (suite.length >= 20) {
      const v = suite.slice(0, 20);
      return { type: "RIB", valeur: v, valide: ribValide(v), ligne: lignes[i + 1] };
    }
  }
  return null;
}

export function extraireRib(e: EntreeRib): ResultatExtraction {
  const lignes = lignesDe(e.texte);
  const notes: string[] = [];
  const faits: (FaitExtrait | null)[] = [];

  // ── LE TITULAIRE : qui est-il ? ───────────────────────────────────────────────────────
  const titulaire = valeurEtiquetee(lignes, RE_TITULAIRE);
  const nomTitulaire = titulaire ? nettoyer(titulaire.valeur.replace(/\s*(?:\||\s{3,}).*$/, "")) : "";
  const personne = e.titulaire ? e.titulaire === "PERSONNE" : estPersonne(nomTitulaire);
  const typeSujet: "PERSONNE" | "ORGANISATION" = personne === true ? "PERSONNE" : "ORGANISATION";
  const tranche = e.titulaire !== undefined || personne !== null;
  if (!titulaire) notes.push("Le titulaire du compte ne se lit pas (aucune étiquette « Titulaire », « Intitulé », « Au nom de ») : à rattacher à la main.");
  else if (!tranche) notes.push("Le titulaire n'est reconnu ni comme une personne (civilité) ni comme une société (forme, mot « société ») : lu comme une organisation, à vérifier.");
  const confianceSujet = tranche ? 1 : 0.6;
  const sujet = { sujetRef: SUJET, role: "TITULAIRE" as const };

  if (titulaire && nomTitulaire) {
    if (typeSujet === "ORGANISATION") {
      faits.push(fait({ ...sujet, attribut: "organisation.raisonSociale", valeur: nomTitulaire, valeurNormalisee: normaliserRaisonSociale(nomTitulaire) ?? nomTitulaire, confiance: CONFIANCE.ETIQUETTE * confianceSujet, page: titulaire.ligne.page, extrait: titulaire.extrait }));
    } else {
      // Le nom imprimé d'un seul tenant (« M. BENALI Karim ») : nom et prénoms ne se séparent pas sans deviner.
      const sansCivilite = nomTitulaire.replace(/^(?:m\.|mr\.?|mme\.?|mlle\.?|melle|dr\.?|pr\.?|monsieur|madame|mademoiselle|docteur|professeur)\s+/i, "");
      faits.push(fait({ ...sujet, attribut: "personne.nom", valeur: sansCivilite, valeurNormalisee: normaliserTexte(sansCivilite) ?? sansCivilite, confiance: CONFIANCE.MODELE, page: titulaire.ligne.page, extrait: titulaire.extrait }));
      notes.push("Titulaire personne : le nom est proposé tel qu'imprimé (nom et prénoms non séparés), à confirmer.");
    }
  }

  // ── LA BANQUE ────────────────────────────────────────────────────────────────────────
  let banque: { valeur: string; page: number | null; extrait: string; confiance: number } | null = null;
  const etiquetee = valeurEtiquetee(lignes, RE_BANQUE);
  if (etiquetee) {
    banque = { valeur: etiquetee.valeur, page: etiquetee.ligne.page, extrait: etiquetee.extrait, confiance: CONFIANCE.ETIQUETTE };
  } else {
    for (const l of lignes.slice(0, 15)) {
      const b = BANQUES.find((x) => x.re.test(l.pli) && (x.nom.length > 12 || l.texte === l.texte.toUpperCase() || /banque|bank/.test(l.pli)));
      if (b) { banque = { valeur: b.nom, page: l.page, extrait: l.texte, confiance: CONFIANCE.DEDUITE }; break; }
    }
  }
  const agence = valeurEtiquetee(lignes, RE_AGENCE);
  if (banque) {
    const valeur = agence && !banque.valeur.toLowerCase().includes(agence.valeur.toLowerCase()) ? `${banque.valeur} — agence ${agence.valeur}` : banque.valeur;
    if (typeSujet === "ORGANISATION") {
      faits.push(fait({ ...sujet, attribut: "organisation.banque", valeur, valeurNormalisee: normaliserTexte(banque.valeur) ?? banque.valeur, confiance: banque.confiance * confianceSujet, page: banque.page, extrait: banque.extrait }));
    } else {
      notes.push(`Banque lue (${banque.valeur}) : le catalogue n'a pas d'attribut « banque » pour une personne — non proposée.`);
    }
  } else {
    notes.push("La banque ne se lit pas (ni étiquette « Banque » ni nom de banque reconnu).");
  }

  // ── LE COMPTE — sensible, vérifié ────────────────────────────────────────────────────
  const comptes = comptesDans(lignes);
  const tableau = compteEnTableau(lignes);
  if (tableau && !comptes.some((c) => c.valeur === tableau.valeur)) comptes.push(tableau);
  // Un RIB est la pièce du compte : un vingt-chiffres sans étiquette y est aussi un compte.
  if (comptes.length === 0) comptes.push(...comptesDans(lignes, { toutes: true }));
  const valides = comptes.filter((c) => c.valide);
  for (const c of comptes.filter((x) => !x.valide)) {
    notes.push(`${c.type} lu (${c.valeur.length} caractères) mais sa clé de contrôle est fausse : non proposé — à saisir depuis le papier.`);
  }
  const attributCompte = typeSujet === "PERSONNE" ? "personne.rib" : "organisation.rib";
  for (const c of valides) {
    faits.push(fait({ ...sujet, attribut: attributCompte, valeur: c.valeur, valeurNormalisee: c.valeur, confiance: CONFIANCE.VERIFIE * confianceSujet, page: c.ligne.page, extrait: c.ligne.texte }));
  }
  if (comptes.length === 0) notes.push("Aucun RIB (20 chiffres) ni IBAN ne se lit sur la pièce.");

  return { nature: "RIB", moteur: MOTEUR_RIB, local: true, faits: sansDoublons(faits), notes };
}
