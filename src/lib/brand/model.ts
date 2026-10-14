/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DE MARQUE D'UNE SOCIÉTÉ — le vocabulaire PUR (mandat 4 §26).
 *
 * Ce qu'une société DIT d'elle-même sur chaque pièce qu'elle émet, et que la fabrique applique
 * d'elle-même : ses couleurs, ses polices, son logo, ses coordonnées telles qu'elle veut les
 * voir imprimées, ses mentions légales, qui signe quoi. Le profil documentaire (préfixes, TVA,
 * validité, papier en-tête) en est la fondation ; la marque en est la charte.
 *
 * ── CE QUE CE MODULE GARANTIT ────────────────────────────────────────────────────────────
 *
 *   1. AUCUN IMPORT. Il peut être lu par un composant d'écran comme par le pont : la frontière
 *      client / serveur ne le connaît pas (CLAUDE.md, « Module not found: Can't resolve 'fs' »).
 *   2. UNE ENTRÉE INCONNUE NE PASSE PAS EN SILENCE. `validerMarque` relit chaque champ, garde ce
 *      qui est valide, et NOMME ce qu'il refuse (« couleur d'accent « bleu » : hexadécimal
 *      attendu »). Un lot partiellement valide applique ce qu'il peut et dit le reste.
 *   3. LE CONTRASTE SE CALCULE. Une couleur de titre trop claire sur blanc, un texte blanc sur
 *      un accent pâle : WCAG 2 (4,5:1 pour du texte) — l'alerte est rendue, pas la faute cachée.
 *   4. LES MENTIONS SE COMPOSENT depuis l'identité LÉGALE (carte Legal) : forme juridique, capital,
 *      RC, NIF, AI, NIS, siège, coordonnées — puis les mentions libres. Le registre n'invente pas
 *      une identité, il choisit comment elle se présente.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPES_PIECE = ["DEVIS", "BON_DE_COMMANDE", "FACTURE", "LETTRE", "RAPPORT"] as const;
export type TypePiece = (typeof TYPES_PIECE)[number];
export const LIBELLE_TYPE_PIECE: Record<TypePiece, string> = {
  DEVIS: "devis", BON_DE_COMMANDE: "bons de commande", FACTURE: "factures", LETTRE: "lettres", RAPPORT: "rapports et dossiers",
};

/** Les polices que Word, Excel et PowerPoint rendent partout sans substitution surprenante. */
export const POLICES_SURES = [
  "Calibri", "Aptos", "Arial", "Helvetica", "Segoe UI", "Verdana", "Trebuchet MS", "Cambria", "Georgia", "Garamond", "Times New Roman", "Century Gothic",
] as const;

export interface SignatureMarque { nom: string; qualite: string | null }

export interface Marque {
  version: 1;
  couleurs: {
    /** La couleur de marque (titres, en-têtes de tableau). Hexadécimal sans dièse, six caractères. */
    accent: string | null;
    /** Une seconde couleur (rappels, filets) — optionnelle. */
    secondaire: string | null;
  };
  polices: { titres: string | null; texte: string | null };
  /** Le logo, un fichier image du Drive (PNG ou JPEG) — appliqué dans l'en-tête des pièces sans papier en-tête. */
  logo: { blobId: string; nom: string; mime: string; taille: number; largeurCm: number } | null;
  /** Les coordonnées telles que la société veut les IMPRIMER — vides = celles de la carte Legal. */
  coordonnees: { adresse: string | null; telephone: string | null; email: string | null; siteWeb: string | null };
  /** Les mentions libres de pied de page (« Toute réclamation sous 8 jours », agrément, etc.). */
  mentionsLegales: string[];
  signatures: { defaut: SignatureMarque | null; parType: Partial<Record<TypePiece, SignatureMarque>> };
  misAJourLe: string | null;
}

export const MARQUE_VIDE: Marque = {
  version: 1,
  couleurs: { accent: null, secondaire: null },
  polices: { titres: null, texte: null },
  logo: null,
  coordonnees: { adresse: null, telephone: null, email: null, siteWeb: null },
  mentionsLegales: [],
  signatures: { defaut: null, parType: {} },
  misAJourLe: null,
};

const MENTIONS_MAX = 8;
const MENTION_LONGUEUR_MAX = 240;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const texte = (v: unknown, max = 160): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
/** Le premier argument DÉFINI — `null` compte comme une valeur (il efface), seul `undefined` est « absent ». */
const premierDefini = (...vs: unknown[]): unknown => vs.find((v) => v !== undefined);

/** « #0b6e4f », « 0B6E4F », « #abc » → « 0B6E4F » ; le reste → null. */
export function normaliserHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(s)) return s.split("").map((c) => c + c).join("").toUpperCase();
  return null;
}

/** La luminance relative (WCAG 2), depuis un hexadécimal à six caractères. */
export function luminance(hex: string): number {
  const c = (hex.replace(/^#/, "").match(/.{2}/g) ?? ["00", "00", "00"]).map((h) => Number.parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Le rapport de contraste WCAG entre deux couleurs (1 = identiques, 21 = noir sur blanc). */
export function contraste(hexA: string, hexB: string): number {
  const a = luminance(hexA); const b = luminance(hexB);
  const [clair, sombre] = a > b ? [a, b] : [b, a];
  return Math.round(((clair + 0.05) / (sombre + 0.05)) * 100) / 100;
}

/** Blanc ou noir : celui qui se lit le mieux SUR cette couleur. */
export function texteSur(hex: string): "FFFFFF" | "000000" {
  return contraste(hex, "FFFFFF") >= contraste(hex, "000000") ? "FFFFFF" : "000000";
}

function signatureDe(v: unknown): SignatureMarque | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const nom = texte(v.nom, 80);
  if (!nom) return null;
  return { nom, qualite: texte(v.qualite ?? v.titre ?? v.fonction, 80) };
}

export interface VerdictMarque { marque: Marque; refus: string[]; champsModifies: string[] }

/**
 * VALIDER une modification — un objet PARTIEL, appliqué par-dessus la marque existante. Chaque
 * champ invalide est refusé et NOMMÉ ; les autres passent. `logo` ne se règle pas ici : il
 * arrive par le dépôt d'un fichier (le pont), jamais par une chaîne tapée.
 */
export function validerMarque(existante: Marque, brut: unknown): VerdictMarque {
  const refus: string[] = [];
  const champs: string[] = [];
  const m: Marque = {
    ...existante,
    couleurs: { ...existante.couleurs }, polices: { ...existante.polices }, coordonnees: { ...existante.coordonnees },
    mentionsLegales: [...existante.mentionsLegales], signatures: { defaut: existante.signatures.defaut, parType: { ...existante.signatures.parType } },
  };
  if (!isObj(brut)) return { marque: m, refus: ["modification illisible : un objet est attendu"], champsModifies: [] };

  const couleurs = isObj(brut.couleurs) ? brut.couleurs : {};
  for (const [cle, source] of [["accent", premierDefini(couleurs.accent, brut.couleurAccent, brut.accent)], ["secondaire", premierDefini(couleurs.secondaire, brut.couleurSecondaire)]] as const) {
    if (source === undefined) continue;
    if (source === null || source === "") { m.couleurs[cle] = null; champs.push(`couleur ${cle}`); continue; }
    const h = normaliserHex(source);
    if (!h) refus.push(`couleur ${cle} « ${String(source)} » : hexadécimal attendu (ex. #0B6E4F)`);
    else { m.couleurs[cle] = h; champs.push(`couleur ${cle}`); }
  }

  const polices = isObj(brut.polices) ? brut.polices : {};
  for (const [cle, source] of [["titres", premierDefini(polices.titres, brut.policeTitres)], ["texte", premierDefini(polices.texte, brut.policeTexte, brut.police)]] as const) {
    if (source === undefined) continue;
    if (source === null || source === "") { m.polices[cle] = null; champs.push(`police des ${cle}`); continue; }
    const p = texte(source, 40);
    if (!p || !/^[A-Za-z][A-Za-z0-9 .'-]{1,39}$/.test(p)) refus.push(`police des ${cle} « ${String(source)} » : un nom de police est attendu (${POLICES_SURES.slice(0, 4).join(", ")}…)`);
    else {
      const sure = POLICES_SURES.find((s) => s.toLowerCase() === p.toLowerCase());
      m.polices[cle] = sure ?? p;
      champs.push(`police des ${cle}`);
      if (!sure) refus.push(`police des ${cle} « ${p} » acceptée, mais absente des polices sûres : Word la remplacera sur un poste qui ne l'a pas`);
    }
  }

  const coord = isObj(brut.coordonnees) ? brut.coordonnees : {};
  const lectures: [keyof Marque["coordonnees"], unknown, number][] = [
    ["adresse", premierDefini(coord.adresse, brut.adresse), 200], ["telephone", premierDefini(coord.telephone, brut.telephone), 40],
    ["email", premierDefini(coord.email, brut.email), 120], ["siteWeb", premierDefini(coord.siteWeb, brut.siteWeb, brut.site), 120],
  ];
  for (const [cle, source, max] of lectures) {
    if (source === undefined) continue;
    if (source === null || source === "") { m.coordonnees[cle] = null; champs.push(cle); continue; }
    const t = texte(source, max);
    if (!t) { refus.push(`${cle} : texte attendu`); continue; }
    if (cle === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { refus.push(`e-mail « ${t} » invalide`); continue; }
    if (cle === "siteWeb" && !/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) { refus.push(`site web « ${t} » invalide`); continue; }
    m.coordonnees[cle] = t; champs.push(cle);
  }

  if (brut.mentionsLegales !== undefined || brut.mentions !== undefined) {
    const source = premierDefini(brut.mentionsLegales, brut.mentions);
    const liste = Array.isArray(source) ? source : typeof source === "string" ? source.split(/\r?\n/) : null;
    if (liste === null && source !== null) refus.push("mentions légales : une liste de textes est attendue");
    else {
      const propres = (liste ?? []).map((x) => texte(x, MENTION_LONGUEUR_MAX)).filter((x): x is string => x !== null);
      if (propres.length > MENTIONS_MAX) refus.push(`${propres.length} mentions : ${MENTIONS_MAX} au plus — les ${propres.length - MENTIONS_MAX} dernières sont ignorées`);
      m.mentionsLegales = propres.slice(0, MENTIONS_MAX);
      champs.push("mentions légales");
    }
  }

  const sig = isObj(brut.signatures) ? brut.signatures : {};
  const defaut = premierDefini(sig.defaut, brut.signataire);
  if (defaut !== undefined) {
    const s = signatureDe(defaut);
    if (s === undefined) refus.push("signataire par défaut : { nom, qualite } attendu");
    else { m.signatures.defaut = s; champs.push("signataire par défaut"); }
  }
  const parType = isObj(sig.parType) ? sig.parType : isObj(brut.signatairesParType) ? brut.signatairesParType : {};
  for (const [type, v] of Object.entries(parType)) {
    const t = type.toUpperCase().replace(/\s+/g, "_") as TypePiece;
    if (!TYPES_PIECE.includes(t)) { refus.push(`type de pièce « ${type} » inconnu (${TYPES_PIECE.join(", ")})`); continue; }
    const s = signatureDe(v);
    if (s === undefined) { refus.push(`signataire des ${LIBELLE_TYPE_PIECE[t]} : { nom, qualite } attendu`); continue; }
    if (s === null) delete m.signatures.parType[t]; else m.signatures.parType[t] = s;
    champs.push(`signataire des ${LIBELLE_TYPE_PIECE[t]}`);
  }

  if (champs.length) m.misAJourLe = new Date().toISOString();
  return { marque: m, refus, champsModifies: [...new Set(champs)] };
}

/** LIRE une marque depuis un JSON quelconque (`settings.marque`) — tolérant : ce qui ne se lit pas revient à vide. */
export function lireMarque(settings: unknown): Marque {
  const brut = isObj(settings) && isObj(settings.marque) ? settings.marque : null;
  if (!brut) return MARQUE_VIDE;
  const { marque } = validerMarque(MARQUE_VIDE, brut);
  const logo = isObj(brut.logo) && typeof brut.logo.blobId === "string" && typeof brut.logo.nom === "string"
    ? { blobId: brut.logo.blobId, nom: brut.logo.nom, mime: typeof brut.logo.mime === "string" ? brut.logo.mime : "image/png", taille: typeof brut.logo.taille === "number" ? brut.logo.taille : 0, largeurCm: typeof brut.logo.largeurCm === "number" && brut.logo.largeurCm > 0 ? Math.min(8, brut.logo.largeurCm) : 4 }
    : null;
  return { ...marque, logo, misAJourLe: typeof brut.misAJourLe === "string" ? brut.misAJourLe : null };
}

export interface Charte {
  /** L'accent effectif : celui de la marque, sinon le bleu canard de la maison — jamais la pastille de l'écran. */
  accent: string;
  secondaire: string | null;
  texteSurAccent: "FFFFFF" | "000000";
  policeTitres: string;
  policeTexte: string;
  /** D'où vient l'accent — pour que la pièce puisse le dire. */
  origineAccent: "marque" | "defaut";
  alertes: string[];
}

/**
 * LE BLEU CANARD DE LA MAISON — R 8, V 112, B 132 (décision de la Direction, 10/2026 : « remplacer le rouge par
 * l'une des couleurs de notre charte »). Il est l'accent des pièces émises tant que la marque de la société n'en
 * règle pas un autre (Administration › Marque). La PASTILLE de l'entité, elle, colore les écrans (sélecteur,
 * pastilles) : une couleur d'interface n'est pas une couleur de charte, et une pastille rouge ne doit pas peindre
 * un bon de commande. Pour la rendre à la pièce : `accentMarque ?? accentSociete ?? ACCENT_DEFAUT`.
 */
export const ACCENT_DEFAUT = "087084";
export const POLICE_DEFAUT = "Calibri";

/** LA CHARTE EFFECTIVE d'une société : marque > bleu canard de la maison, avec les alertes de contraste. */
export function charteDe(marque: Marque): Charte {
  const accentMarque = marque.couleurs.accent;
  const accent = accentMarque ?? ACCENT_DEFAUT;
  const alertes: string[] = [];
  const surBlanc = contraste(accent, "FFFFFF");
  if (surBlanc < 3) alertes.push(`accent ${accent} trop clair sur fond blanc (contraste ${surBlanc}:1, 3:1 au moins pour un titre) : les titres seront peu lisibles`);
  const texteSurAccent = texteSur(accent);
  const surAccent = contraste(accent, texteSurAccent);
  if (surAccent < 4.5) alertes.push(`texte ${texteSurAccent === "FFFFFF" ? "blanc" : "noir"} sur l'accent ${accent} : contraste ${surAccent}:1 (4,5:1 recommandé) dans les en-têtes de tableau`);
  return {
    accent, secondaire: marque.couleurs.secondaire, texteSurAccent,
    policeTitres: marque.polices.titres ?? marque.polices.texte ?? POLICE_DEFAUT,
    policeTexte: marque.polices.texte ?? POLICE_DEFAUT,
    origineAccent: accentMarque ? "marque" : "defaut",
    alertes,
  };
}

/** L'identité LÉGALE telle que la fabrique la connaît (la carte Legal, projetée). */
export interface IdentiteImprimable {
  nom: string; formeJuridique?: string | null; capital?: string | null; adresse?: string | null;
  rc?: string | null; nif?: string | null; ai?: string | null; nis?: string | null; telephone?: string | null; email?: string | null;
}

/** Les coordonnées qu'UNE pièce imprime à la place de celles de la société (même forme que `CoordonneesEmetteur`). */
export interface CoordonneesPiece { adresse?: string | null; telephone?: string | null; email?: string | null }

/**
 * LES MENTIONS DE PIED : les coordonnées choisies pour la pièce, sinon par la marque, sinon la carte Legal, puis les
 * mentions libres. L'identité légale chiffrée (RC, NIF, AI, NIS) et la raison sociale sont déjà
 * composées par la fabrique commerciale — ici on n'ajoute que ce que la marque DÉCIDE.
 */
export function mentionsDe(marque: Marque, identite: IdentiteImprimable, piece?: CoordonneesPiece | null): string[] {
  const c = marque.coordonnees;
  // LES COORDONNÉES CHOISIES POUR LA PIÈCE (Direction, 10/2026) : une clé présente gouverne — vide, rien ne s'imprime.
  // Elles ne retombent JAMAIS sur une valeur d'ailleurs : seule la carte de la société émettrice sert de défaut.
  const choix = (cle: keyof CoordonneesPiece, defaut: string | null): string | null =>
    piece && Object.prototype.hasOwnProperty.call(piece, cle) ? ((piece[cle] ?? "").trim() || null) : defaut;
  const telephone = choix("telephone", c.telephone ?? identite.telephone ?? null);
  const email = choix("email", c.email ?? identite.email ?? null);
  // L'adresse de la pièce s'imprime dans son corps (« Siège Social ») : choisie, le pied ne la répète pas.
  const adresse = piece && Object.prototype.hasOwnProperty.call(piece, "adresse") ? null : c.adresse && c.adresse !== identite.adresse ? c.adresse : null;
  const coordonnees = [
    adresse,
    telephone ? `Tél. ${telephone}` : null,
    email,
    c.siteWeb ? c.siteWeb.replace(/^https?:\/\//i, "") : null,
  ].filter((x): x is string => Boolean(x));
  const lignes: string[] = [];
  if (coordonnees.length) lignes.push(coordonnees.join(" — "));
  lignes.push(...marque.mentionsLegales);
  return lignes;
}

/** QUI SIGNE cette pièce : le signataire du type, sinon celui par défaut, sinon celui du profil (ou personne). */
export function signatairePour(marque: Marque, type: TypePiece, repli: SignatureMarque | null): SignatureMarque | null {
  return marque.signatures.parType[type] ?? marque.signatures.defaut ?? repli;
}

/** Un résumé lisible — ce qu'Adam dit quand on lui demande « notre charte ? ». */
export function resumerMarque(marque: Marque, charte: Charte): string {
  const parts: string[] = [];
  parts.push(`accent ${charte.accent} (${charte.origineAccent === "marque" ? "registre de marque" : "bleu canard de la maison"})`);
  if (charte.secondaire) parts.push(`secondaire ${charte.secondaire}`);
  parts.push(`polices ${charte.policeTitres}${charte.policeTexte !== charte.policeTitres ? ` / ${charte.policeTexte}` : ""}`);
  parts.push(marque.logo ? `logo « ${marque.logo.nom} » (${marque.logo.largeurCm} cm)` : "aucun logo déposé");
  if (marque.mentionsLegales.length) parts.push(`${marque.mentionsLegales.length} mention(s) de pied`);
  const sig = marque.signatures.defaut ? `signataire ${marque.signatures.defaut.nom}` : "aucun signataire par défaut";
  const parType = Object.entries(marque.signatures.parType).map(([t, s]) => `${LIBELLE_TYPE_PIECE[t as TypePiece]} : ${s.nom}`);
  parts.push(parType.length ? `${sig} (${parType.join(", ")})` : sig);
  if (charte.alertes.length) parts.push(`⚠ ${charte.alertes.join(" ; ")}`);
  return parts.join(" · ");
}
