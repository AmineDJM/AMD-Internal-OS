import { plier } from "@/lib/utils";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CLAUSES D'UN CONTRAT — lues par le code, jamais devinées (mandat 4 §27, Legal).
 *
 * Un contrat de distribution, de prestation ou de bail dit toujours les mêmes choses aux mêmes
 * endroits : combien de temps il dure, s'il se renouvelle tout seul et avec quel préavis, si
 * quelqu'un a l'exclusivité, ce qui arrive en cas de retard (pénalités), comment on en sort
 * (résiliation), quand on paie, combien de temps on se tait (confidentialité), quel droit
 * s'applique. Ce module reconnaît ces clauses dans le TEXTE français d'un contrat, en tire les
 * VALEURS (mois, jours, pourcentages, plafonds) et les OBLIGATIONS datées qui en découlent :
 * « dénoncer avant le 30/09 sinon reconduction d'un an », « l'exclusivité expire le … ».
 *
 * ── CE QU'IL GARANTIT ────────────────────────────────────────────────────────────────────
 *
 *   1. PUR : du texte entre, des clauses sortent. Ni base, ni modèle, ni réseau — testable sur
 *      des extraits, et le résultat est le même à chaque lecture.
 *   2. CHAQUE CLAUSE PORTE SON EXTRAIT ET SA CONFIANCE. Une valeur lue à côté de son mot-clé
 *      (« préavis de trois (3) mois ») est SÛRE ; un mot-clé sans valeur est SIGNALÉ ; ce que le
 *      texte ne dit pas n'est pas inventé — une clause absente est absente.
 *   3. LES OBLIGATIONS ONT UNE DATE quand le contrat en a une (`endDate`) : la date de
 *      dénonciation = fin − préavis ; sans date, l'obligation est dite « à dater ».
 *   4. LA COMPARAISON DE DEUX VERSIONS est une différence de VALEURS, pas de mots : durée 12 → 24
 *      mois, pénalité 0,5 % → 1 %, exclusivité apparue ou disparue. C'est ce qu'un avenant change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TYPES_CLAUSE = [
  "DUREE", "RENOUVELLEMENT", "PREAVIS", "EXCLUSIVITE", "PENALITE", "RESILIATION", "PAIEMENT", "CONFIDENTIALITE", "NON_CONCURRENCE", "GARANTIE", "DROIT_APPLICABLE", "RESPONSABILITE",
] as const;
export type TypeClause = (typeof TYPES_CLAUSE)[number];

export const LIBELLE_CLAUSE: Record<TypeClause, string> = {
  DUREE: "durée", RENOUVELLEMENT: "renouvellement", PREAVIS: "préavis", EXCLUSIVITE: "exclusivité", PENALITE: "pénalités",
  RESILIATION: "résiliation", PAIEMENT: "paiement", CONFIDENTIALITE: "confidentialité", NON_CONCURRENCE: "non-concurrence",
  GARANTIE: "garantie", DROIT_APPLICABLE: "droit applicable", RESPONSABILITE: "responsabilité",
};

export type Confiance = "SURE" | "PROBABLE" | "A_VERIFIER";

export interface Clause {
  type: TypeClause;
  /** La phrase (ou les deux) où la clause a été lue — la PREUVE. */
  extrait: string;
  /** Position du début de l'extrait dans le texte, pour y retourner. */
  position: number;
  confiance: Confiance;
  valeurs: {
    /** Durée en mois (durée du contrat, période de renouvellement, préavis converti…). */
    mois?: number;
    /** Délai en jours (préavis, paiement). */
    jours?: number;
    /** Un taux (pénalité, intérêt) en fraction : 0,005 = 0,5 %. */
    taux?: number;
    /** « par jour de retard », « par semaine ». */
    periodeTaux?: "jour" | "semaine" | "mois";
    /** Plafond des pénalités en fraction du contrat (0,1 = 10 %). */
    plafond?: number;
    /** Reconduction tacite oui/non. */
    tacite?: boolean;
    /** Exclusivité : le territoire ou l'objet, s'il est dit. */
    territoire?: string;
    /** Droit applicable / juridiction, s'il est dit. */
    droit?: string;
  };
  /** Ce qui manque pour que la clause soit opposable (« préavis sans durée »). */
  alerte?: string;
}

export interface Obligation {
  cle: string;
  type: TypeClause;
  libelle: string;
  /** ISO `AAAA-MM-JJ`, ou null quand le contrat n'a pas de date de fin. */
  echeance: string | null;
  /** Ce qui se passe si l'on ne fait rien. */
  sinon: string;
  clause: Clause;
}

// ─────────────────────────── Lecture des nombres français ───────────────────────────

const MOTS_NOMBRE: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, quinze: 15, dix_huit: 18, vingt: 20,
  vingt_quatre: 24, trente: 30, trente_six: 36, quarante_cinq: 45, quarante_huit: 48, soixante: 60, quatre_vingt_dix: 90, cent_vingt: 120,
};
const NOMBRE_RE = "(\\d{1,4}(?:[.,]\\d+)?|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|dix[- ]huit|vingt[- ]quatre|vingt|trente[- ]six|trente|quarante[- ]cinq|quarante[- ]huit|soixante|quatre[- ]vingt[- ]dix|cent[- ]vingt)";

function lireNombre(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[- ]/g, "_");
  if (/^\d/.test(t)) { const n = Number(t.replace(",", ".")); return Number.isFinite(n) ? n : null; }
  return MOTS_NOMBRE[t] ?? null;
}

/** « trois (3) mois », « 12 mois », « deux (2) ans », « 30 jours », « quatre-vingt-dix jours » → { mois } ou { jours }. */
function lireDuree(s: string): { mois?: number; jours?: number } | null {
  const m = new RegExp(`${NOMBRE_RE}\\s*(?:\\(\\s*\\d+\\s*\\))?\\s*(ans?|années?|mois|semaines?|jours?)\\b`, "i").exec(s);
  if (!m) return null;
  const n = lireNombre(m[1]);
  if (n === null) return null;
  const u = m[2].toLowerCase();
  if (u.startsWith("an")) return { mois: n * 12 };
  if (u.startsWith("mois")) return { mois: n };
  if (u.startsWith("semaine")) return { jours: n * 7 };
  return { jours: n };
}

/** « 0,5 % », « 1 pour cent », « 10%  » → fraction. */
function lireTaux(s: string): number | null {
  const m = /(\d{1,3}(?:[.,]\d+)?)\s*(?:%|pour\s*cent|p\.\s*100)/i.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n / 100 : null;
}

// ─────────────────────────── Découpage en phrases ───────────────────────────

interface Phrase { texte: string; plie: string; position: number }

function phrasesDe(texte: string): Phrase[] {
  // Un retour à la ligne SIMPLE est une coupure de mise en page (un contrat est justifié sur
  // 80 colonnes), pas une fin de phrase ; un paragraphe vide, si.
  const propre = texte.replace(/\r/g, "").replace(/\n\s*\n/g, ". ").replace(/\n/g, " ").replace(/[ \t\u00a0\u202f]+/g, " ");
  const out: Phrase[] = [];
  const re = /[^.;!?]+[.;!?]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(propre)) !== null) {
    const t = m[0].trim();
    if (t.length < 12) continue;
    out.push({ texte: t, plie: plier(t), position: m.index });
  }
  return out;
}

/** Un TITRE (« Article 9 — Pénalités », « CONTRAT DE DISTRIBUTION EXCLUSIVE ») annonce, il ne stipule pas : jamais une ancre. */
function estTitre(p: Phrase): boolean {
  if (p.texte.length > 90) return false;
  if (/^(article|art\.|titre|chapitre|section|annexe)\s*\d+/i.test(p.texte)) return true;
  const lettres = p.texte.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return lettres.length >= 8 && lettres === lettres.toUpperCase();
}

/** L'ancre et les deux phrases qui suivent, bornées : la valeur d'une clause suit souvent son mot-clé d'une phrase. */
const fenetre = (ps: Phrase[], i: number): string => [ps[i]?.texte, ps[i + 1]?.texte, ps[i + 2]?.texte].filter(Boolean).join(" ").slice(0, 700);

/** La durée qui SUIT le mot-clé (« préavis de six (6) mois »), plutôt que la première venue (« périodes de douze (12) mois »). */
function lireDureeApres(f: string, motCle: RegExp): { mois?: number; jours?: number } | null {
  const fp = plier(f);
  const m = motCle.exec(fp);
  if (m) {
    const apres = lireDuree(f.slice(m.index));
    if (apres) return apres;
  }
  return lireDuree(f);
}

// ─────────────────────────── Les détecteurs ───────────────────────────

const MOTS: Record<TypeClause, RegExp> = {
  DUREE: /\b(duree du (present )?contrat|conclu pour une duree|entre en vigueur|prend effet|pour une periode de|duree de (\w+ )?(\d+|un|une|deux|trois|quatre|cinq|six|douze|vingt|trente))\b/,
  RENOUVELLEMENT: /\b(reconduction|reconduit|renouvel(le|lement|able|e)|prorog(e|ation)|tacite)\b/,
  PREAVIS: /\b(preavis|moyennant un delai de|notifi(er|cation) .{0,40} avant|denonc(er|iation))\b/,
  EXCLUSIVITE: /\b(exclusivite|exclusif|exclusive|distributeur exclusif|a titre exclusif|seul distributeur)\b/,
  PENALITE: /\b(penalite|penalites|astreinte|indemnite de retard|interets? de retard|majoration de retard)\b/,
  RESILIATION: /\b(resili(er|ation|e)|mettre fin au (present )?contrat|rupture anticipee|denonce de plein droit)\b/,
  PAIEMENT: /\b(paiement|payable|reglement|regle(e|s)? (a|sous|dans)|echeance de paiement|facture(s)? (est|sont|seront) (payee|reglee|payables))\b/,
  CONFIDENTIALITE: /\b(confidentialite|confidentiel|confidentielles?|secret des affaires|non[- ]divulgation)\b/,
  NON_CONCURRENCE: /\b(non[- ]concurrence|ne pas concurrencer|s'interdit de (commercialiser|distribuer|representer))\b/,
  GARANTIE: /\b(garantie|garantit|garanti(e|es|s)? (contre|pendant|pour))\b/,
  DROIT_APPLICABLE: /\b(droit applicable|regi par (le|la) (droit|loi)|loi algerienne|loi francaise|tribunaux? (de|d')|juridiction competente|arbitrage|chambre de commerce internationale|cci)\b/,
  RESPONSABILITE: /\b(responsabilite (de|du|est limitee|ne saurait)|limitation de responsabilite|plafond de responsabilite|force majeure)\b/,
};

const MOT_CLE_DUREE: Partial<Record<TypeClause, RegExp>> = {
  DUREE: /\b(duree|periode de|conclu pour)\b/, RENOUVELLEMENT: /\b(reconduit|reconduction|renouvel|prorog)/, PREAVIS: /\b(preavis|moyennant un delai de|delai de|avant)\b/,
  PAIEMENT: /\b(payables?|paiement|reglement|regle)/, CONFIDENTIALITE: /\b(confidenti|pendant)/, RESILIATION: /\b(delai de|preavis|moyennant)/,
  NON_CONCURRENCE: /\b(pendant|durant|pour une duree)/, GARANTIE: /\b(garanti|pendant|durant)/, EXCLUSIVITE: /\b(pendant|pour une duree|durant)/,
};

function detecter(type: TypeClause, ps: Phrase[], i: number): Clause | null {
  const p = ps[i];
  if (estTitre(p) || !MOTS[type].test(p.plie)) return null;
  const f = fenetre(ps, i);
  const fp = plier(f);
  const base = { type, extrait: p.texte.length > 320 ? `${p.texte.slice(0, 317)}…` : p.texte, position: p.position };
  const duree = MOT_CLE_DUREE[type] ? lireDureeApres(f, MOT_CLE_DUREE[type]!) : lireDuree(f);
  switch (type) {
    case "DUREE": {
      if (!duree) return { ...base, confiance: "A_VERIFIER", valeurs: {}, alerte: "durée mentionnée sans valeur lisible" };
      return { ...base, confiance: "SURE", valeurs: duree };
    }
    case "RENOUVELLEMENT": {
      const tacite = /\btacite/.test(fp) || /\bsauf denonciation\b/.test(fp) || /\bautomatiquement\b/.test(fp);
      const exclu = /\b(ne (se )?renouvelle pas|sans reconduction|ne (sera|pourra) pas (etre )?(reconduit|renouvele)|aucune reconduction)\b/.test(fp);
      if (exclu) return { ...base, confiance: "SURE", valeurs: { tacite: false } };
      return { ...base, confiance: duree ? "SURE" : "PROBABLE", valeurs: { tacite, ...(duree ?? {}) }, ...(tacite && !duree ? { alerte: "reconduction tacite sans période lisible" } : {}) };
    }
    case "PREAVIS": {
      if (!duree) return { ...base, confiance: "A_VERIFIER", valeurs: {}, alerte: "préavis mentionné sans durée lisible" };
      return { ...base, confiance: "SURE", valeurs: duree };
    }
    case "EXCLUSIVITE": {
      const neg = /\b(non exclusi(f|ve)|sans exclusivite|a titre non exclusif|aucune exclusivite)\b/.test(fp);
      if (neg) return { ...base, confiance: "SURE", valeurs: {}, alerte: "clause d'absence d'exclusivité" };
      const terr = /\b(?:sur le territoire|pour le territoire|en|dans)\s+(?:de\s+|du\s+|d')?((?:l')?[a-z][a-z\-']{2,}(?: [a-z][a-z\-']{2,}){0,3})/.exec(fp);
      const territoire = terr?.[1] && !/\b(le|la|les|cas|mesure|cadre|limite|conditions?)\b/.test(terr[1]) ? terr[1] : undefined;
      return { ...base, confiance: territoire ? "SURE" : "PROBABLE", valeurs: { ...(territoire ? { territoire } : {}), ...(duree ?? {}) } };
    }
    case "PENALITE": {
      const taux = lireTaux(f);
      const periode: Clause["valeurs"]["periodeTaux"] = /\bpar jour\b|\bjournalier/.test(fp) ? "jour" : /\bpar semaine\b/.test(fp) ? "semaine" : /\bpar mois\b|\bmensuel/.test(fp) ? "mois" : undefined;
      const plafondM = /\b(?:plafonn|dans la limite de|limite(?:e|es)? a|sans (?:pouvoir )?(?:exceder|depasser))\D{0,40}?(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(fp);
      const plafond = plafondM ? Number(plafondM[1].replace(",", ".")) / 100 : undefined;
      if (taux === null) return { ...base, confiance: "A_VERIFIER", valeurs: { ...(plafond !== undefined ? { plafond } : {}) }, alerte: "pénalités mentionnées sans taux lisible" };
      return { ...base, confiance: "SURE", valeurs: { taux, ...(periode ? { periodeTaux: periode } : {}), ...(plafond !== undefined ? { plafond } : {}) } };
    }
    case "RESILIATION": return { ...base, confiance: duree ? "SURE" : "PROBABLE", valeurs: duree ?? {} };
    case "PAIEMENT": {
      if (!duree) return { ...base, confiance: "PROBABLE", valeurs: {} };
      return { ...base, confiance: "SURE", valeurs: duree };
    }
    case "CONFIDENTIALITE": return { ...base, confiance: duree ? "SURE" : "PROBABLE", valeurs: duree ?? {} };
    case "NON_CONCURRENCE": return { ...base, confiance: duree ? "SURE" : "PROBABLE", valeurs: duree ?? {} };
    case "GARANTIE": return { ...base, confiance: duree ? "SURE" : "PROBABLE", valeurs: duree ?? {} };
    case "DROIT_APPLICABLE": {
      const d = /\b(droit|loi)\s+(algerien(?:ne)?|francais(?:e)?|suisse|anglais(?:e)?|tunisien(?:ne)?|marocain(?:e)?)\b/.exec(fp) ?? /\btribunaux?\s+(?:de|d')\s*([a-z\-']{3,})/.exec(fp) ?? /\b(arbitrage|chambre de commerce internationale|cci)\b/.exec(fp);
      return { ...base, confiance: d ? "SURE" : "PROBABLE", valeurs: d ? { droit: d[0] } : {} };
    }
    case "RESPONSABILITE": {
      const taux = lireTaux(f);
      return { ...base, confiance: taux !== null ? "SURE" : "PROBABLE", valeurs: taux !== null ? { plafond: taux } : {} };
    }
  }
}

/** EXTRAIRE les clauses d'un texte de contrat — une par type au plus (la plus SÛRE, sinon la première). */
export function extraireClauses(texte: string): Clause[] {
  const ps = phrasesDe(texte ?? "");
  const parType = new Map<TypeClause, Clause>();
  const rang: Record<Confiance, number> = { SURE: 0, PROBABLE: 1, A_VERIFIER: 2 };
  for (let i = 0; i < ps.length; i++) {
    for (const type of TYPES_CLAUSE) {
      const c = detecter(type, ps, i);
      if (!c) continue;
      const deja = parType.get(type);
      if (!deja || rang[c.confiance] < rang[deja.confiance]) parType.set(type, c);
    }
  }
  return TYPES_CLAUSE.map((t) => parType.get(t)).filter((c): c is Clause => Boolean(c));
}

// ─────────────────────────── Les obligations datées ───────────────────────────

const iso = (d: Date): string => d.toISOString().slice(0, 10);
/** Reculer de N mois en restant dans le mois cible : 31 mars − 6 mois = 30 septembre, pas le 1er octobre. */
function moins(d: Date, v: { mois?: number; jours?: number }): Date {
  const r = new Date(d.getTime());
  if (v.mois) {
    const jour = r.getUTCDate();
    r.setUTCDate(1);
    r.setUTCMonth(r.getUTCMonth() - v.mois);
    const dernier = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
    r.setUTCDate(Math.min(jour, dernier));
  }
  if (v.jours) r.setUTCDate(r.getUTCDate() - v.jours);
  return r;
}

/**
 * LES OBLIGATIONS qui découlent des clauses, DATÉES quand le contrat a une fin :
 *   · dénonciation avant fin − préavis (sinon reconduction tacite pour la période lue) ;
 *   · fin de l'exclusivité ou du contrat (renouveler ou laisser expirer) ;
 *   · fin de la confidentialité / non-concurrence après la fin du contrat.
 */
export function obligationsDe(clauses: readonly Clause[], contrat: { endDate?: Date | string | null; titre?: string | null }): Obligation[] {
  const fin = contrat.endDate ? new Date(contrat.endDate) : null;
  const finOk = fin && !Number.isNaN(fin.getTime()) ? fin : null;
  const par = (t: TypeClause) => clauses.find((c) => c.type === t);
  const out: Obligation[] = [];
  const renouv = par("RENOUVELLEMENT");
  const preavis = par("PREAVIS");
  if (renouv && renouv.valeurs.tacite !== false) {
    const delai = preavis?.valeurs.mois || preavis?.valeurs.jours ? { mois: preavis?.valeurs.mois, jours: preavis?.valeurs.jours } : null;
    const periode = renouv.valeurs.mois ? `${renouv.valeurs.mois} mois` : "une nouvelle période";
    out.push({
      cle: "denonciation", type: "RENOUVELLEMENT",
      libelle: delai ? `Dénoncer le contrat au plus tard ${delai.mois ? `${delai.mois} mois` : `${delai.jours} jours`} avant son terme` : "Dénoncer le contrat avant son terme (préavis non lu : à vérifier dans le texte)",
      echeance: finOk ? iso(delai ? moins(finOk, delai) : finOk) : null,
      sinon: `reconduction tacite pour ${periode}`,
      clause: renouv,
    });
  }
  const excl = par("EXCLUSIVITE");
  if (excl && !excl.alerte) {
    out.push({ cle: "exclusivite", type: "EXCLUSIVITE", libelle: `Décider du sort de l'exclusivité${excl.valeurs.territoire ? ` (${excl.valeurs.territoire})` : ""} avant le terme`, echeance: finOk ? iso(finOk) : null, sinon: "l'exclusivité tombe avec le contrat, ou se reconduit avec lui", clause: excl });
  }
  if (finOk && !renouv) {
    const duree = par("DUREE");
    if (duree) out.push({ cle: "terme", type: "DUREE", libelle: "Renouveler, renégocier ou laisser expirer au terme", echeance: iso(finOk), sinon: "le contrat expire", clause: duree });
  }
  for (const t of ["CONFIDENTIALITE", "NON_CONCURRENCE"] as const) {
    const c = par(t);
    if (c && (c.valeurs.mois || c.valeurs.jours) && finOk) {
      const apres = new Date(finOk.getTime());
      if (c.valeurs.mois) apres.setUTCMonth(apres.getUTCMonth() + c.valeurs.mois);
      if (c.valeurs.jours) apres.setUTCDate(apres.getUTCDate() + c.valeurs.jours);
      out.push({ cle: t.toLowerCase(), type: t, libelle: `${LIBELLE_CLAUSE[t]} : obligation qui court jusqu'au ${iso(apres)} (après le terme)`, echeance: iso(apres), sinon: "manquement contractuel", clause: c });
    }
  }
  return out;
}

// ─────────────────────────── Comparer deux versions ───────────────────────────

export interface Changement { type: TypeClause; avant: string | null; apres: string | null; sens: "AJOUTEE" | "RETIREE" | "MODIFIEE" }

function resumerValeurs(c: Clause): string {
  const v = c.valeurs;
  const parts: string[] = [];
  if (v.mois !== undefined) parts.push(`${v.mois} mois`);
  if (v.jours !== undefined) parts.push(`${v.jours} jours`);
  if (v.taux !== undefined) parts.push(`${Math.round(v.taux * 10000) / 100} %${v.periodeTaux ? ` par ${v.periodeTaux}` : ""}`);
  if (v.plafond !== undefined) parts.push(`plafond ${Math.round(v.plafond * 10000) / 100} %`);
  if (v.tacite !== undefined) parts.push(v.tacite ? "tacite" : "non tacite");
  if (v.territoire) parts.push(v.territoire);
  if (v.droit) parts.push(v.droit);
  if (c.alerte) parts.push(`(${c.alerte})`);
  return parts.length ? parts.join(", ") : "présente";
}

/** Ce qu'une nouvelle version CHANGE : clause ajoutée, retirée, ou dont les valeurs diffèrent. */
export function comparerClauses(anciennes: readonly Clause[], nouvelles: readonly Clause[]): Changement[] {
  const out: Changement[] = [];
  for (const t of TYPES_CLAUSE) {
    const a = anciennes.find((c) => c.type === t); const n = nouvelles.find((c) => c.type === t);
    if (!a && !n) continue;
    if (!a && n) { out.push({ type: t, avant: null, apres: resumerValeurs(n), sens: "AJOUTEE" }); continue; }
    if (a && !n) { out.push({ type: t, avant: resumerValeurs(a), apres: null, sens: "RETIREE" }); continue; }
    const ra = resumerValeurs(a!); const rn = resumerValeurs(n!);
    if (ra !== rn) out.push({ type: t, avant: ra, apres: rn, sens: "MODIFIEE" });
  }
  return out;
}

/** Les RISQUES qu'un juriste lirait d'un coup d'œil — déterministes, chacun nommant sa clause. */
export function risquesDe(clauses: readonly Clause[]): { gravite: "HAUTE" | "MOYENNE"; message: string; type: TypeClause }[] {
  const out: { gravite: "HAUTE" | "MOYENNE"; message: string; type: TypeClause }[] = [];
  const par = (t: TypeClause) => clauses.find((c) => c.type === t);
  const renouv = par("RENOUVELLEMENT"); const preavis = par("PREAVIS"); const pen = par("PENALITE"); const excl = par("EXCLUSIVITE"); const droit = par("DROIT_APPLICABLE"); const resp = par("RESPONSABILITE");
  if (renouv?.valeurs.tacite && !preavis) out.push({ gravite: "HAUTE", type: "RENOUVELLEMENT", message: "reconduction tacite sans préavis lisible : le contrat peut se reconduire sans que personne n'ait décidé" });
  if (renouv?.valeurs.tacite && preavis && (preavis.valeurs.mois ?? 0) >= 6) out.push({ gravite: "MOYENNE", type: "PREAVIS", message: `préavis long (${preavis.valeurs.mois} mois) : la fenêtre de dénonciation arrive tôt` });
  if (pen?.valeurs.taux !== undefined && pen.valeurs.plafond === undefined) out.push({ gravite: "HAUTE", type: "PENALITE", message: "pénalités de retard sans plafond lisible" });
  if (pen?.valeurs.taux !== undefined && pen.valeurs.periodeTaux === "jour" && pen.valeurs.taux >= 0.005) out.push({ gravite: "MOYENNE", type: "PENALITE", message: `pénalité journalière élevée (${Math.round(pen.valeurs.taux * 10000) / 100} % par jour)` });
  if (excl && !excl.alerte && !excl.valeurs.territoire) out.push({ gravite: "MOYENNE", type: "EXCLUSIVITE", message: "exclusivité sans territoire ni objet lisible" });
  if (!droit) out.push({ gravite: "MOYENNE", type: "DROIT_APPLICABLE", message: "aucun droit applicable ni juridiction lus" });
  if (droit?.valeurs.droit && !/algerien/i.test(droit.valeurs.droit) && !/alger/i.test(droit.valeurs.droit)) out.push({ gravite: "MOYENNE", type: "DROIT_APPLICABLE", message: `droit ou juridiction hors Algérie (${droit.valeurs.droit})` });
  if (!resp) out.push({ gravite: "MOYENNE", type: "RESPONSABILITE", message: "aucune limitation de responsabilité lue" });
  return out;
}
