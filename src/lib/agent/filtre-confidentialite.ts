/**
 * FILTRE DE CONFIDENTIALITÉ STRICT — Jalon 3 (Décision Q14).
 *
 * Règle absolue de sécurité :
 * Aucune rémunération (salaire de base, net à payer, primes), aucune coordonnée bancaire
 * (RIB, IBAN, CCP) ni pièce d'identité (passeport, CNI, NIN) ne doit être transmise
 * dans le contexte d'un LLM externe (MiMo ou autre).
 *
 * Ce module est pur (aucun import lourd ou serveur) et vérifiable unitairement.
 */

export const MOTS_CLES_SENSIBLES = [
  "salary",
  "basesalary",
  "netsalary",
  "grosssalary",
  "salaire",
  "salairebase",
  "salairenet",
  "salairebrut",
  "remuneration",
  "tauxhoraire",
  "bulletindepaie",
  "emoluments",
  "rib",
  "iban",
  "bankaccount",
  "numerocompte",
  "numeroccp",
  "passport",
  "passeport",
  "idcard",
  "nationalid",
  "cni",
  "nin",
];

const MOTIF_REMPLACEMENT = "[CONFIDENTIEL]";

/**
 * Motifs regex détectant les données hautement sensibles dans les chaînes de texte :
 * 1. Coordonnées bancaires (IBAN algérien / international, RIB / CCP 20 chiffres)
 * 2. Numéros d'identité (NIN 18 chiffres, Passeport, CNI)
 * 3. Rémunérations (mentions explicites de salaires, émoluments, montants suivis de net/brut)
 */
const MOTIFS_TEXTUELS: Array<{ regex: RegExp; label: string }> = [
  // IBAN (DZ + 2 chiffres de contrôle + 20 caractères ou format international générique)
  {
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/gi,
    label: "IBAN",
  },
  // RIB / CCP algérien (20 chiffres, parfois groupés par espaces ou tirets)
  {
    regex: /\b\d{3}[-\s]?\d{3}[-\s]?\d{12}[-\s]?\d{2}\b/g,
    label: "RIB_20",
  },
  {
    regex: /\b(?:RIB|IBAN|CCP|Compte\s+bancaire)\s*[:#=]?\s*[0-9A-Z\s-]{10,30}\b/gi,
    label: "COMPTE_BANCAIRE",
  },
  // NIN algérien (Numéro d'Identification Nationale : 18 chiffres consécutifs)
  {
    regex: /\b\d{18}\b/g,
    label: "NIN_18",
  },
  // Pièces d'identité explicites (Passeport, CNI, NIN)
  {
    regex: /\b(?:Passeport|CNI|Carte\s+d['’]identit[ée]|NIN|Num[ée]ro\s+d['’]identification\s+nationale)\s*(?:N\s*°|n\s*°|num[ée]ro|[:#=])?\s*[A-Z0-9\s-]{6,25}\b/gi,
    label: "PIECE_IDENTITE",
  },
  // Rémunérations & salaires explicites (ex: "salaire net est de 180 000 DZD", "salaire: 200 000 DA")
  {
    regex: /\b(?:salaire(?:\s+(?:de\s+base|net|brut|mensuel))?|r[ée]mun[ée]ration|net\s+[àa]\s+payer|[ée]moluments?)\s*(?:est\s+de\s*|[:=]\s*)?[\d\s.,]+(?:\s*(?:DZD|DA|dinars?|EUR|€|USD|\$))?\b/gi,
    label: "SALAIRE_EXPLICITE",
  },
  // Montant associé à net/brut/salaire
  {
    regex: /\b[\d\s.,]{3,}(?:DZD|DA|dinars?|EUR|€|USD|\$)\s+(?:net|brut|de\s+base|en\s+salaire)\b/gi,
    label: "MONTANT_SALAIRE",
  },
];

export interface ResultatCensureTexte {
  texte: string;
  censure: boolean;
  occurrences: number;
}

/**
 * Censure les données sensibles dans un texte libre.
 */
export function censurerTexte(texte: string): ResultatCensureTexte {
  if (!texte || typeof texte !== "string") {
    return { texte: texte ?? "", censure: false, occurrences: 0 };
  }

  let modifie = texte;
  let totalOccurrences = 0;

  for (const { regex } of MOTIFS_TEXTUELS) {
    // Réinitialiser le lastIndex pour les regex globales
    regex.lastIndex = 0;
    const matches = modifie.match(regex);
    if (matches && matches.length > 0) {
      totalOccurrences += matches.length;
      modifie = modifie.replace(regex, MOTIF_REMPLACEMENT);
    }
  }

  return {
    texte: modifie,
    censure: totalOccurrences > 0,
    occurrences: totalOccurrences,
  };
}

/**
 * Censure récursivement un objet ou tableau structuré avant injection dans le contexte.
 */
export function censurerObjet<T>(donnees: T): { resultat: T; censure: boolean } {
  let aCensure = false;

  function nettoyer(valeur: unknown): unknown {
    if (valeur === null || valeur === undefined) return valeur;

    if (typeof valeur === "string") {
      const { texte, censure } = censurerTexte(valeur);
      if (censure) aCensure = true;
      return texte;
    }

    if (Array.isArray(valeur)) {
      return valeur.map(nettoyer);
    }

    if (typeof valeur === "object") {
      const resultat: Record<string, unknown> = {};
      for (const [cle, val] of Object.entries(valeur as Record<string, unknown>)) {
        const cleNormalisee = cle.toLowerCase().replace(/[-_]/g, "");
        if (MOTS_CLES_SENSIBLES.includes(cleNormalisee)) {
          resultat[cle] = MOTIF_REMPLACEMENT;
          aCensure = true;
        } else {
          resultat[cle] = nettoyer(val);
        }
      }
      return resultat;
    }

    return valeur;
  }

  const resultat = nettoyer(donnees) as T;
  return { resultat, censure: aCensure };
}
