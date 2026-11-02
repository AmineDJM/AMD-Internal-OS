/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REGISTRE DU COMMERCE, CARTE D'IMMATRICULATION FISCALE, ATTESTATION NIF → FAITS (§3-E, étape 3).
 *
 * Trois pièces officielles qui disent QUI EST une société : ses identifiants (RC, NIF, NIS,
 * article d'imposition), sa raison sociale, sa forme juridique, son capital, son siège et son
 * représentant légal. Le sujet est le TITULAIRE de la pièce (`sujetRef: "titulaire"`).
 *
 * Tout se lit par des RÈGLES, sur le texte (natif ou OCR local) — rien ne sort du serveur :
 *   • chaque valeur vient d'une ÉTIQUETTE imprimée (« Raison sociale », « Forme juridique »,
 *     « Capital social », « Siège social », « Gérant »…), sur sa ligne ou la suivante ;
 *   • les identifiants passent par les normalisations communes (NIF 15 à 20 chiffres, RC en
 *     lettres et chiffres…) — une forme fausse n'est pas proposée ;
 *   • l'autorité qui délivre la pièce (CNRC, direction des impôts) n'est jamais prise pour le
 *     titulaire : ses lignes sont écartées ;
 *   • deux valeurs différentes pour le même identifiant : aucune n'est proposée, la note le dit.
 *
 * Une pièce officielle porte bien ce qu'elle dit : une valeur sous son étiquette y vaut
 * `CONFIANCE.ETIQUETTE`, un identifiant de forme vérifiée `CONFIANCE.VERIFIE`.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, NaturePiece, ResultatExtraction } from "@/lib/enrichissement/types";
import {
  ATTRIBUT_IDENTIFIANT, CONFIANCE, fait, formeJuridiqueDans, identifiantsDans, lignesDe, montantDans, montantNormalise, nettoyer,
  normaliserAdresse, normaliserRaisonSociale, normaliserTexte, sansDoublons, valeurEtiquetee,
  type ChampIdentifiant, type LigneDeTexte,
} from "@/lib/enrichissement/extracteurs/commun-organisations";

export const MOTEUR_REGISTRE = "regles-registre-commerce/1";

export type NatureRegistre = Extract<NaturePiece, "REGISTRE_COMMERCE" | "ATTESTATION_NIF" | "CARTE_IMMATRICULATION_FISCALE">;

export interface EntreeRegistre {
  texte: string;
  /** La nature, quand le classement l'a dite ; sinon reconnue au titre. */
  nature?: NatureRegistre;
}

const SUJET = "titulaire";

/** Les lignes de l'AUTORITÉ qui délivre la pièce — jamais le titulaire. */
const RE_AUTORITE = /(?:centre\s+national\s+du\s+registre|c\.?\s?n\.?\s?r\.?\s?c\.?(?![a-z])|direction\s+(?:generale\s+)?des\s+impots|ministere|republique\s+algerienne|antenne\s+locale|inspection\s+des\s+impots|le\s+(?:directeur|prepose|chef)|cachet|signature)/;

/** La nature au titre de la pièce. */
export function natureRegistre(texte: string): NatureRegistre | null {
  const p = lignesDe(texte).slice(0, 40).map((l) => l.pli).join("\n");
  if (/carte\s+d'?\s?(?:immatriculation\s+)?fiscale|carte\s+nif/.test(p)) return "CARTE_IMMATRICULATION_FISCALE";
  if (/attestation\s+(?:d'?\s?)?(?:immatriculation\s+fiscale|identification\s+fiscale|n\.?\s?i\.?\s?f)|attestation\s+de\s+(?:situation\s+fiscale|nif)/.test(p)) return "ATTESTATION_NIF";
  if (/registre\s+du\s+commerce|extrait\s+du\s+registre|c\.?\s?n\.?\s?r\.?\s?c/.test(p)) return "REGISTRE_COMMERCE";
  return null;
}

const ETIQUETTES = {
  raisonSociale: /^(?:nom\s+(?:et\s+prenoms?\s+)?ou\s+raison\s+sociale|raison\s+sociale|denomination(?:\s+sociale)?|designation\s+de\s+l'?\s?entreprise|nom\s+de\s+l'?\s?entreprise|nom\s+ou\s+denomination)\s*:?\s*/,
  nomCommercial: /^(?:nom\s+commercial|enseigne(?:\s+commerciale)?|sigle)\s*:?\s*/,
  formeJuridique: /^(?:forme\s+juridique|statut\s+juridique|nature\s+juridique)\s*:?\s*/,
  capital: /^(?:capital(?:\s+social)?|montant\s+du\s+capital)\s*:?\s*/,
  siege: /^(?:siege\s+social|siege|adresse\s+du\s+siege(?:\s+social)?|adresse\s+de\s+l'?\s?etablissement(?:\s+principal)?|adresse\s+du\s+principal\s+etablissement|adresse|domicile\s+fiscal)\s*:?\s*/,
  representant: /^(?:representant\s+legal|nom\s+et\s+prenoms?\s+du\s+(?:gerant|representant(?:\s+legal)?)|gerant(?:\s+statutaire)?|president(?:\s+directeur\s+general)?|p\.?\s?d\.?\s?g\.?|directeur\s+general|represente\s+par)\s*:?\s*/,
  immatriculation: /^(?:n[°o]\s*(?:d'?\s?)?immatriculation|numero\s+d'?\s?immatriculation|immatriculation)\s*:?\s*/,
};

export function extraireRegistre(e: EntreeRegistre): ResultatExtraction {
  const lignes = lignesDe(e.texte);
  const notes: string[] = [];
  const faits: (FaitExtrait | null)[] = [];
  const nature: NaturePiece = e.nature ?? natureRegistre(e.texte) ?? "REGISTRE_COMMERCE";
  if (!e.nature && !natureRegistre(e.texte)) notes.push("Le titre de la pièce ne dit ni registre du commerce ni carte fiscale : lue comme un extrait du registre du commerce.");

  const autorite = (l: LigneDeTexte) => RE_AUTORITE.test(l.pli);
  const utiles = lignes.filter((l) => !autorite(l));
  const lire = (re: RegExp) => valeurEtiquetee(lignes, re, { exclure: autorite });
  const titulaire = { sujetRef: SUJET, role: "TITULAIRE" as const };

  // ── LA RAISON SOCIALE, LE NOM COMMERCIAL, LA FORME ────────────────────────────────────
  const raison = lire(ETIQUETTES.raisonSociale);
  if (raison) {
    faits.push(fait({ ...titulaire, attribut: "organisation.raisonSociale", valeur: raison.valeur, valeurNormalisee: normaliserRaisonSociale(raison.valeur) ?? raison.valeur, confiance: CONFIANCE.ETIQUETTE, page: raison.ligne.page, extrait: raison.extrait }));
  } else {
    notes.push("Aucune étiquette « Raison sociale » ou « Dénomination » : la raison sociale n'est pas proposée.");
  }
  const commercial = lire(ETIQUETTES.nomCommercial);
  if (commercial) faits.push(fait({ ...titulaire, attribut: "organisation.nomCommercial", valeur: commercial.valeur, valeurNormalisee: normaliserRaisonSociale(commercial.valeur) ?? commercial.valeur, confiance: CONFIANCE.ETIQUETTE, page: commercial.ligne.page, extrait: commercial.extrait }));

  const forme = lire(ETIQUETTES.formeJuridique);
  const formeLue = forme ? formeJuridiqueDans(forme.valeur) ?? nettoyer(forme.valeur) : null;
  if (forme && formeLue) {
    faits.push(fait({ ...titulaire, attribut: "organisation.formeJuridique", valeur: formeLue, valeurNormalisee: normaliserTexte(formeLue) ?? formeLue, confiance: CONFIANCE.ETIQUETTE, page: forme.ligne.page, extrait: forme.extrait }));
  } else if (raison) {
    // Sans étiquette, la forme se lit dans la raison sociale (« ATLAS MÉDICAL SARL ») — une déduction.
    const deduite = formeJuridiqueDans(raison.valeur);
    if (deduite) faits.push(fait({ ...titulaire, attribut: "organisation.formeJuridique", valeur: deduite, valeurNormalisee: normaliserTexte(deduite) ?? deduite, confiance: CONFIANCE.DEDUITE, page: raison.ligne.page, extrait: raison.extrait }));
  }

  // ── LE CAPITAL ───────────────────────────────────────────────────────────────────────
  const capital = lire(ETIQUETTES.capital);
  if (capital) {
    const m = montantDans(capital.valeur);
    if (m) faits.push(fait({ ...titulaire, attribut: "organisation.capital", valeur: m.brut, valeurNormalisee: montantNormalise({ valeur: m.valeur, devise: m.devise ?? "DZD" }), confiance: CONFIANCE.ETIQUETTE, page: capital.ligne.page, extrait: capital.extrait }));
    else notes.push(`Capital social illisible (« ${capital.valeur} ») : non proposé.`);
  }

  // ── LE SIÈGE ET LE REPRÉSENTANT ─────────────────────────────────────────────────────
  const siege = lire(ETIQUETTES.siege);
  if (siege) {
    const n = normaliserAdresse(siege.valeur);
    if (n) faits.push(fait({ ...titulaire, attribut: "organisation.adresse", valeur: siege.valeur, valeurNormalisee: n, confiance: CONFIANCE.ETIQUETTE, page: siege.ligne.page, extrait: siege.extrait }));
  }
  const representant = lire(ETIQUETTES.representant);
  if (representant) {
    const v = representant.valeur.replace(/\s*,?\s*n[ée]e?\s+le\s+.*$/i, "").trim();
    faits.push(fait({ ...titulaire, attribut: "organisation.representant", valeur: v, valeurNormalisee: normaliserTexte(v) ?? v, confiance: CONFIANCE.ETIQUETTE, page: representant.ligne.page, extrait: representant.extrait }));
  }

  // ── LES IDENTIFIANTS ─────────────────────────────────────────────────────────────────
  const ids = identifiantsDans(utiles);
  // Sur un extrait du registre, le n° d'immatriculation EST le RC.
  if (nature === "REGISTRE_COMMERCE" && !ids.some((x) => x.champ === "RC")) {
    const imm = lire(ETIQUETTES.immatriculation);
    if (imm) {
      const [rc] = identifiantsDans([{ ...imm.ligne, texte: `RC ${imm.valeur}`, pli: `rc ${imm.valeur.toLowerCase()}` }]);
      if (rc) ids.push({ ...rc, ligne: imm.ligne });
    }
  }
  const parChamp = new Map<ChampIdentifiant, typeof ids>();
  for (const id of ids) parChamp.set(id.champ, [...(parChamp.get(id.champ) ?? []), id]);
  for (const [champ, lus] of parChamp) {
    if (lus.length > 1) {
      notes.push(`${lus.length} ${champ} différents sur la pièce (${lus.map((x) => x.brut).join(", ")}) : aucun n'est proposé.`);
      continue;
    }
    const [id] = lus;
    faits.push(fait({ ...titulaire, attribut: ATTRIBUT_IDENTIFIANT[champ], valeur: id.brut, valeurNormalisee: id.valeur, confiance: CONFIANCE.VERIFIE, page: id.ligne.page, extrait: id.ligne.texte }));
  }
  const attendu: ChampIdentifiant = nature === "REGISTRE_COMMERCE" ? "RC" : "NIF";
  if (!parChamp.has(attendu)) notes.push(`Le ${attendu} attendu sur cette pièce ne se lit pas (ou sa forme n'est pas reconnue).`);

  return { nature, moteur: MOTEUR_REGISTRE, local: true, faits: sansDoublons(faits), notes };
}
