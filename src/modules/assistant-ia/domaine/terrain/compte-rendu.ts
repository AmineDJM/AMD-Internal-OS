/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPTE RENDU DICTÉ (lot J13, décision 0025) — les RÈGLES, sans un seul import (navigateur compris).
 *
 * Un délégué sort d'un cabinet et parle : « Dr Benali, CHU Oran, intéressé par Cardiovex, veut des
 * échantillons ». La transcription (français, arabe dialectal, ou les deux mêlés) part au modèle avec
 * `CONSIGNE_STRUCTURATION` ; il rend un JSON que `lireCompteRendu` relit SANS LUI FAIRE CONFIANCE :
 * champs bornés, listes plafonnées, natures fermées, quantités entières positives. Rien de ce qu'il rend
 * n'est écrit : c'est la matière des cartes que la personne confirme (ou corrige) à l'écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NATURES_DEMANDE = ["ECHANTILLONS", "DOCUMENTATION", "MATERIEL", "VISITE", "AUTRE"] as const;
export type NatureDemande = (typeof NATURES_DEMANDE)[number];

export const LIBELLE_NATURE: Record<NatureDemande, string> = {
  ECHANTILLONS: "Échantillons",
  DOCUMENTATION: "Documentation scientifique",
  MATERIEL: "Matériel promotionnel",
  VISITE: "Nouvelle visite",
  AUTRE: "Autre demande",
};

export interface DemandeDictee {
  nature: NatureDemande;
  produit: string | null;
  quantite: number | null;
  detail: string;
}

export interface CompteRenduStructure {
  medecin: string | null;
  etablissement: string | null;
  specialite: string | null;
  produits: string[];
  interet: string | null;
  objections: string | null;
  demandes: DemandeDictee[];
  /** « Je repasse demain » : la tournée du lendemain se propose, elle ne se modifie pas seule. */
  revoirDemain: boolean;
  synthese: string;
  /** Ce que le modèle n'a pas pu trancher (« nom du produit incertain ») — dit sur la carte. */
  aConfirmer: string[];
}

export type LangueDictee = "fr" | "ar" | "mixte" | "inconnue";

export const BORNES_CR = { champ: 160, synthese: 1_500, produits: 8, demandes: 6, aConfirmer: 5, quantite: 10_000 } as const;

export const CONSIGNE_STRUCTURATION = [
  "Tu reçois la transcription automatique d'un compte rendu de visite médicale dicté par un délégué d'un laboratoire algérien.",
  "Elle peut être en français, en arabe (darija algérienne ou arabe standard) ou un mélange des deux ; un nom propre peut y être écorché.",
  "Rends UNIQUEMENT un objet JSON, sans texte autour, de la forme :",
  '{"medecin":string|null,"etablissement":string|null,"specialite":string|null,"produits":string[],"interet":string|null,',
  '"objections":string|null,"demandes":[{"nature":"ECHANTILLONS"|"DOCUMENTATION"|"MATERIEL"|"VISITE"|"AUTRE","produit":string|null,"quantite":number|null,"detail":string}],',
  '"revoirDemain":boolean,"synthese":string,"aConfirmer":string[]}',
  "Règles : écris les noms propres (médecin, établissement, produit) en caractères LATINS, comme dans un annuaire français",
  "(« الدكتور بن علي » → « Benali », « وهران » → « Oran ») ; n'invente rien — un champ non dit vaut null ;",
  "« synthese » est le compte rendu rédigé en FRANÇAIS, à la troisième personne, fidèle à ce qui est dit, sans ajout ;",
  "« revoirDemain » n'est vrai que si le délégué dit qu'il revoit ce médecin demain ;",
  "mets dans « aConfirmer » chaque élément que la transcription laisse incertain.",
].join("\n");

const chaine = (v: unknown, max: number = BORNES_CR.champ): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t || /^(null|inconnu|non pr[ée]cis[ée]|n\/a|-)$/i.test(t)) return null;
  return t.slice(0, max);
};

const liste = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => chaine(x)).filter((x): x is string => !!x))].slice(0, max) : [];

const quantite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), BORNES_CR.quantite) : null;
};

/** Le premier objet JSON équilibré d'un texte (le modèle l'entoure parfois de « ```json »). */
export function extraireObjetJson(texte: string): unknown {
  const debut = texte.indexOf("{");
  if (debut < 0) return null;
  let profondeur = 0;
  let dansChaine = false;
  for (let i = debut; i < texte.length; i += 1) {
    const c = texte[i];
    if (dansChaine) {
      if (c === "\\") i += 1;
      else if (c === '"') dansChaine = false;
    } else if (c === '"') dansChaine = true;
    else if (c === "{") profondeur += 1;
    else if (c === "}" && --profondeur === 0) {
      try { return JSON.parse(texte.slice(debut, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Relit la réponse du modèle — `null` si elle n'a pas la forme d'un compte rendu (la carte le dira). */
export function lireCompteRendu(texteModele: string): CompteRenduStructure | null {
  const o = extraireObjetJson(texteModele);
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const synthese = chaine(r.synthese, BORNES_CR.synthese);
  if (!synthese) return null;
  const demandes: DemandeDictee[] = Array.isArray(r.demandes)
    ? r.demandes.flatMap((d): DemandeDictee[] => {
        if (!d || typeof d !== "object") return [];
        const x = d as Record<string, unknown>;
        const nature = (NATURES_DEMANDE as readonly string[]).includes(String(x.nature)) ? (x.nature as NatureDemande) : "AUTRE";
        const detail = chaine(x.detail) ?? LIBELLE_NATURE[nature];
        return [{ nature, produit: chaine(x.produit), quantite: quantite(x.quantite), detail }];
      }).slice(0, BORNES_CR.demandes)
    : [];
  return {
    medecin: chaine(r.medecin),
    etablissement: chaine(r.etablissement),
    specialite: chaine(r.specialite),
    produits: liste(r.produits, BORNES_CR.produits),
    interet: chaine(r.interet, 400),
    objections: chaine(r.objections, 400),
    demandes,
    revoirDemain: r.revoirDemain === true,
    synthese,
    aConfirmer: liste(r.aConfirmer, BORNES_CR.aConfirmer),
  };
}

/**
 * LA LANGUE DU VOCAL — lue sur l'écriture de la transcription, pas devinée par le moteur seul (tous ne la
 * rendent pas). Arabe et latin mêlés (au-delà de 15 % chacun) : « mixte », le cas ordinaire du terrain.
 */
export function langueDictee(texte: string, langueMoteur?: string | null): LangueDictee {
  const arabes = (texte.match(/[؀-ۿ]/g) ?? []).length;
  const latines = (texte.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  const total = arabes + latines;
  if (total === 0) {
    const m = (langueMoteur ?? "").toLowerCase();
    return m.startsWith("ar") ? "ar" : m.startsWith("fr") ? "fr" : "inconnue";
  }
  const partArabe = arabes / total;
  if (partArabe > 0.15 && partArabe < 0.85) return "mixte";
  return partArabe >= 0.85 ? "ar" : "fr";
}

export const LIBELLE_LANGUE: Record<LangueDictee, string> = {
  fr: "français", ar: "arabe", mixte: "arabe et français mêlés", inconnue: "langue non reconnue",
};

/**
 * L'INDICE DE VOCABULAIRE remis au moteur de transcription : les noms que ce délégué prononce (son panel,
 * ses produits, ses établissements). Mesuré (banc J13) : il fait passer les entités entendues de 10 à 11
 * sur 12. Borné à 800 caractères — le moteur n'en lit pas plus ; les plus probables d'abord.
 */
export function indiceVocabulaire(medecins: string[], produits: string[], etablissements: string[], max = 800): string {
  const termes: string[] = [];
  const vus = new Set<string>();
  let longueur = 0;
  for (const t of [...produits, ...medecins, ...etablissements]) {
    const n = t.replace(/\s+/g, " ").trim();
    const k = n.toLowerCase();
    if (!n || vus.has(k)) continue;
    if (longueur + n.length + 2 > max) break;
    vus.add(k);
    termes.push(n);
    longueur += n.length + 2;
  }
  return termes.join(", ");
}

/**
 * L'ERREUR D'UN FOURNISSEUR, DITE À UN DÉLÉGUÉ — jamais le corps HTTP brut (une clé masquée, du JSON) : la cause en
 * une phrase, et ce qui reste possible. Le détail technique reste aux journaux du serveur.
 */
export function phraseErreurFournisseur(brut: string, quoi: "transcription" | "lecture"): string {
  const ce = quoi === "transcription" ? "La transcription" : "La lecture de la photo";
  const garde = quoi === "transcription" ? "le vocal est gardé ; écrivez le compte rendu ou réessayez plus tard." : "la photo est gardée au Drive.";
  if (/401|403|invalid_api_key|cl[ée] .*(absente|non configur)/i.test(brut)) return `${ce} est indisponible (accès au fournisseur refusé) : ${garde}`;
  if (/quota|429|d[ée]bit/i.test(brut)) return `${ce} est momentanément saturée : ${garde}`;
  if (/coup[ée]|interrupteur|d[ée]sactiv/i.test(brut)) return `${ce} est désactivée par l'administrateur : ${garde}`;
  if (/plafond/i.test(brut)) return brut.slice(0, 200);
  return `${ce} a échoué : ${garde}`;
}
