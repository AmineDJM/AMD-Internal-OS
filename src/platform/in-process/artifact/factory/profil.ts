/**
 * Fabrique de documents — LA SOCIÉTÉ ET SON PROFIL : causes d'échec, réglages documentaires,
 * habillage, société émettrice, mentions obligatoires manquantes, lecture et définition du profil.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canManageLetterheads } from "@/lib/office/letterhead";
import { lireModelesParType, resoudrePapierEnTete } from "@/lib/direction-artistique/modeles";
import { getMyCompanies, moneyEntityOf, type CompanyLite } from "@/lib/company";
import { getBlob } from "@/lib/drive-storage";
import { recordAudit } from "@/lib/audit";
import { TAUX_TVA_ADMIS, TYPES_DOCUMENT, validerMotifNumero, validerDepart, PLURIEL_TYPE, type DepartsNumerotation, type PartieCommerciale, type TypeDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { charteDe, lireMarque, resumerMarque, type Charte, type Marque } from "@/lib/brand/model";
import { registreActif } from "@/lib/references/registre";
import { standardsDocumentaires } from "@/platform/in-process/teach/store";
import { controlerRibDePiece } from "@/modules/coffre/api";
import { sansBloquer } from "@/lib/journal";

/** Les causes d'échec que le runtime de missions sait classer (`capability-failure.ts`). */
type Echec = "NOT_FOUND" | "MISSING_PERMISSION" | "MISSING_INPUT" | "CAPABILITY_FAILURE";

export interface EchecFabrique {
  ok: false;
  echec: Echec;
  motif: string;
  bloquants?: string[];
  candidats?: { id: string; nom: string }[];
}

export const echec = (e: Echec, motif: string, extra: Partial<Omit<EchecFabrique, "ok" | "echec" | "motif">> = {}): EchecFabrique => ({ ok: false, echec: e, motif, ...extra });

// ─────────────────────────── La société et son profil ───────────────────────────

export interface ReglagesDocumentaires {
  quotePrefix: string;
  orderPrefix: string;
  invoicePrefix: string;
  /** Fraction (0,19). */
  vatRate: number;
  paymentTerms: string | null;
  quoteValidityDays: number;
  footerNote: string | null;
  letterheadId: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  /**
   * LE MOTIF DU NUMÉRO, par nature — « 001/FS/26 » pour les factures, « 012/DG/2026 » pour les
   * bons de commande : ce que les pièces réelles de la société portent. Vide = le défaut
   * `{prefixe}-{aaaa}-{n:4}`. Vit dans `settings.numerotation` du profil (extensible sans migration).
   */
  numerotation: Partial<Record<TypeDocumentCommercial, string>>;
  /**
   * LE PREMIER NUMÉRO DE LA SÉRIE, par nature puis par année (`settings.numerotationDepart`) : un PLANCHER du compteur
   * — « commencer à 032/DG/2026 » — qui ne le fait jamais reculer. Vide = la série commence à 1.
   */
  numerotationDepart: DepartsNumerotation;
  /**
   * LA SOCIÉTÉ TIENT LE REGISTRE COMMUN NNN/DG/AAAA (`settings.registreDG`, ou des BC déjà au motif /DG/) : ses bons de commande
   * — et toute nature au motif /DG/ — prennent leur numéro au compteur COMMUN de la société (`lib/references/registre.ts`).
   */
  registreDG?: boolean;
  /** Vrai si un profil a été enregistré ; faux = ce sont les défauts du code. */
  existe: boolean;
}

export interface ProfilDocumentaire {
  societe: { id: string; nom: string; couleur: string | null };
  /** L'identité légale, telle qu'elle figurera sur la pièce. */
  identite: PartieCommerciale;
  /** Les champs d'identité manquants pour une FACTURE — à renseigner dans la carte Legal. */
  identiteIncomplete: string[];
  reglages: ReglagesDocumentaires;
  papierEnTete: { id: string; nom: string } | null;
  /** Les règles Teach Adam (standards documentaires de la société) qui ont modifié les réglages, et comment. */
  reglesAppliquees: { id: string; cle: string; effet: string }[];
  /** LE REGISTRE DE MARQUE (§26) : ce que la société dit d'elle-même, et la charte effective qui en découle. */
  marque: Marque;
  charte: Charte;
  resumeMarque: string;
}

/** Ce que la fabrique pose SUR la pièce : le papier en-tête, ou à défaut la police et le logo de la marque. */
export interface Habillage {
  base: Buffer | null;
  police: string | null;
  logo: { octets: Buffer; png: boolean; largeurCm: number } | null;
}

const REGLAGES_DEFAUT: ReglagesDocumentaires = {
  quotePrefix: "DEV", orderPrefix: "BC", invoicePrefix: "FA", vatRate: 0.19, paymentTerms: null, quoteValidityDays: 30,
  footerNote: null, letterheadId: null, signatoryName: null, signatoryTitle: null, numerotation: {}, numerotationDepart: {}, existe: false,
};

/** Les motifs de numérotation lus dans `settings.numerotation` — seuls les motifs VALIDES comptent. */
function lireNumerotation(settings: Prisma.JsonValue | null | undefined): Partial<Record<TypeDocumentCommercial, string>> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const brut = (settings as Record<string, unknown>).numerotation;
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return {};
  const out: Partial<Record<TypeDocumentCommercial, string>> = {};
  for (const type of TYPES_DOCUMENT) {
    const v = (brut as Record<string, unknown>)[type];
    if (typeof v === "string" && v.trim() && !validerMotifNumero(v)) out[type] = v.trim();
  }
  return out;
}

/** Les départs de numérotation lus dans `settings.numerotationDepart` — seuls les entiers valides comptent. */
function lireNumerotationDepart(settings: Prisma.JsonValue | null | undefined): DepartsNumerotation {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const brut = (settings as Record<string, unknown>).numerotationDepart;
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return {};
  const out: DepartsNumerotation = {};
  for (const type of TYPES_DOCUMENT) {
    const parAnnee = (brut as Record<string, unknown>)[type];
    if (!parAnnee || typeof parAnnee !== "object" || Array.isArray(parAnnee)) continue;
    const valides: Record<string, number> = {};
    for (const [annee, n] of Object.entries(parAnnee as Record<string, unknown>)) {
      if (/^\d{4}$/.test(annee) && typeof n === "number" && !validerDepart(Number(annee), n)) valides[annee] = n;
    }
    if (Object.keys(valides).length) out[type] = valides;
  }
  return out;
}

const plier = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * QUELLE SOCIÉTÉ ? Nommée (identifiant, raison sociale ou nom court) parmi celles de la
 * personne ; sinon celle de la personne pour l'ARGENT (`moneyEntityOf` : sa fiche, pas son
 * écran). Plusieurs correspondances = on demande, on ne choisit pas.
 */
export async function resoudreSociete(userId: string, societe?: string | null): Promise<{ ok: true; societe: CompanyLite } | EchecFabrique> {
  const miennes = await getMyCompanies(userId);
  if (miennes.length === 0) return echec("MISSING_PERMISSION", "Aucune société du groupe ne vous est ouverte : impossible d'émettre une pièce.");
  const voulu = (societe ?? "").trim();
  if (!voulu) {
    const id = await moneyEntityOf(userId);
    const s = miennes.find((c) => c.id === id) ?? (miennes.length === 1 ? miennes[0] : null);
    if (!s) return echec("MISSING_INPUT", `Dites au nom de quelle société émettre la pièce : ${miennes.map((c) => c.name).join(", ")}.`, { candidats: miennes.map((c) => ({ id: c.id, nom: c.name })) });
    return { ok: true, societe: s };
  }
  const p = plier(voulu);
  const exacts = miennes.filter((c) => c.id === voulu || plier(c.name) === p || (c.shortName && plier(c.shortName) === p));
  const partiels = exacts.length ? exacts : miennes.filter((c) => plier(c.name).includes(p) || (c.shortName && plier(c.shortName).includes(p)));
  if (partiels.length === 1) return { ok: true, societe: partiels[0] };
  if (partiels.length > 1) return echec("MISSING_INPUT", `${partiels.length} sociétés correspondent à « ${voulu} » : laquelle ?`, { candidats: partiels.map((c) => ({ id: c.id, nom: c.name })) });
  return echec("NOT_FOUND", `Aucune société « ${voulu} » parmi celles qui vous sont ouvertes (${miennes.map((c) => c.name).join(", ")}).`);
}

const MENTIONS_FACTURE: { cle: keyof PartieCommerciale; libelle: string }[] = [
  { cle: "adresse", libelle: "siège social" }, { cle: "rc", libelle: "RC" }, { cle: "nif", libelle: "NIF" }, { cle: "ai", libelle: "article d'imposition" }, { cle: "nis", libelle: "NIS" },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PIÈCE QUI NE RESSEMBLE PAS À LA SOCIÉTÉ LE DIT — sinon elle passe pour la sienne.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * « Fais-moi un BC Adventum. » Le .docx sort valide : les totaux sont justes, la TVA est bonne,
 * le fichier s'ouvre. Et il est GÉNÉRIQUE — pas de logo, pas de papier en-tête, pas de RC ni de
 * NIF, une mise en page neutre. Rien dans la réponse ne le disait. C'est un faux succès de la
 * pire espèce : le livrable existe, il est techniquement correct, et il ne va pas à la banque.
 *
 * ── POURQUOI LE CODE LE SAVAIT DÉJÀ, ET SE TAISAIT ──────────────────────────────────────
 *
 * `profilDocumentaire` calcule `identiteIncomplete`, connaît `papierEnTete`, connaît la marque.
 * Ces trois faits étaient rendus dans le profil… et jamais recopiés dans `avertissements`. Seule
 * la FACTURE bloquait sur les mentions manquantes ; un devis et un bon de commande sortaient en
 * silence. Le contrôle existait, il ne parlait pas.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────
 *
 * Toute pièce émise sans les marques d'identité de la société porte un avertissement qui NOMME
 * ce qui manque ET où le renseigner. Ce n'est pas un refus : la pièce reste utile, et le PDG
 * décide. Mais il décide en le sachant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function manquesDIdentite(profil: ProfilDocumentaire): string[] {
  const out: string[] = [];
  if (profil.identiteIncomplete.length > 0) {
    out.push(
      `Cette pièce sort SANS ${profil.identiteIncomplete.join(", ")} de ${profil.societe.nom} : `
      + `renseignez la carte d'identité de la société (Legal → Sociétés) et les pièces suivantes les porteront.`,
    );
  }
  if (!profil.papierEnTete && !profil.marque.logo) {
    out.push(
      `Aucun papier en-tête ni logo n'est enregistré pour ${profil.societe.nom} : la mise en page est NEUTRE, `
      + `elle ne porte pas la charte de la société. Téléversez l'en-tête ou le logo (Transverse → Direction artistique) `
      + `pour que la pièce ressemble vraiment à ${profil.societe.nom}.`,
    );
  }
  if (!profil.reglages.existe) {
    out.push(
      `Aucun profil documentaire n'est défini pour ${profil.societe.nom} : préfixe de numérotation, TVA, conditions `
      + `de paiement et validité viennent des valeurs par défaut, pas de vos usages.`,
    );
  }
  return out;
}

/**
 * LE PROFIL DOCUMENTAIRE d'une société : identité légale, réglages, papier en-tête.
 *
 * `opts.papierEnTeteId` : un papier CHOISI pour cette pièce (le bouton des Finances propose la
 * bibliothèque de la société) à la place de celui que le profil désigne — jamais le papier d'une
 * autre société : écrire sur son en-tête, c'est l'engager.
 *
 * `opts.type` : la NATURE de la pièce à habiller. La Direction artistique (Transverse) désigne, par
 * entité, le modèle Word d'un bon de commande, d'un devis… (`settings.modelesParType`) : c'est là
 * que la fabrique va le chercher. Ordre : choisi > modèle de la nature > papier par défaut de
 * l'entité > premier papier de l'entité > commun au groupe (`resoudrePapierEnTete`).
 */
export async function profilDocumentaire(user: CurrentUser, societe?: string | null, opts: { papierEnTeteId?: string | null; type?: TypeDocumentCommercial | null } = {}): Promise<{ ok: true; profil: ProfilDocumentaire; papierOctets: Buffer | null; logo: Habillage["logo"]; habillage: Habillage } | EchecFabrique> {
  const r = await resoudreSociete(user.id, societe);
  if (!r.ok) return r;
  const s = r.societe;
  const [identite, profil, entetes] = await Promise.all([
    prisma.companyLegalIdentity.findUnique({ where: { companyId: s.id } }),
    prisma.companyDocumentProfile.findUnique({ where: { companyId: s.id } }),
    prisma.officeLetterhead.findMany({
      where: { kind: "word", isActive: true, OR: [{ companyId: s.id }, { companyId: null }] },
      select: { id: true, name: true, kind: true, companyId: true, isActive: true, blobId: true },
    }),
  ]);
  const reglages: ReglagesDocumentaires = profil
    ? {
      quotePrefix: profil.quotePrefix, orderPrefix: profil.orderPrefix, invoicePrefix: profil.invoicePrefix, vatRate: Number(profil.vatRate),
      paymentTerms: profil.paymentTerms, quoteValidityDays: profil.quoteValidityDays, footerNote: profil.footerNote, letterheadId: profil.letterheadId,
      signatoryName: profil.signatoryName, signatoryTitle: profil.signatoryTitle, numerotation: lireNumerotation(profil.settings), numerotationDepart: lireNumerotationDepart(profil.settings),
      registreDG: registreActif(profil.settings), existe: true,
    }
    // UNE COPIE, jamais la constante : les standards enseignés ci-dessous ÉCRIVENT dans `reglages`.
    // Sans copie, la première société qui appliquait « 60 jours » le laissait dans les défauts du
    // processus — et toute société sans profil héritait de 60 jours, règle supprimée ou non.
    // Trouvé par le banc des défis : « la fabrique applique encore 60 jours » sans aucune règle.
    : { ...REGLAGES_DEFAUT };
  // ── LES STANDARDS ENSEIGNÉS (Teach Adam, §119) ─────────────────────────────────────────
  //
  // « Nos factures commencent par FAC », « les devis sont valables 45 jours » : une règle de
  // périmètre SOCIÉTÉ, posée par la Direction, s'applique par-dessus le profil — c'est la plus
  // récente des deux volontés, et elle porte le nom de qui l'a dite. Chaque application est
  // rendue (`reglesAppliquees`) : la pièce dit d'où viennent ses réglages.
  const reglesAppliquees: ProfilDocumentaire["reglesAppliquees"] = [];
  const standards = await standardsDocumentaires(user.id, s.id).catch(sansBloquer("factory.profilDocumentaire.standardsDocumentaires", new Map<string, { valeur: unknown; regle: { id: string } }>()));
  const appliquer = (cle: string, f: (v: unknown) => string | null) => {
    const st = standards.get(cle);
    if (!st) return;
    const effet = f(st.valeur);
    if (effet) reglesAppliquees.push({ id: st.regle.id, cle, effet });
  };
  appliquer("validiteDevis", (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? ((reglages.quoteValidityDays = v), `validité des devis : ${v} jours`) : null));
  appliquer("prefixeFacture", (v) => (typeof v === "string" && /^[A-Za-z0-9]{1,8}$/.test(v) ? ((reglages.invoicePrefix = v.toUpperCase()), `préfixe des factures : ${v.toUpperCase()}`) : null));
  appliquer("prefixeDevis", (v) => (typeof v === "string" && /^[A-Za-z0-9]{1,8}$/.test(v) ? ((reglages.quotePrefix = v.toUpperCase()), `préfixe des devis : ${v.toUpperCase()}`) : null));
  appliquer("prefixeBonDeCommande", (v) => (typeof v === "string" && /^[A-Za-z0-9]{1,8}$/.test(v) ? ((reglages.orderPrefix = v.toUpperCase()), `préfixe des bons de commande : ${v.toUpperCase()}`) : null));
  appliquer("tvaDefaut", (v) => (typeof v === "number" && TAUX_TVA_ADMIS.some((t) => Math.abs(t - v) < 1e-9) ? ((reglages.vatRate = v), `TVA par défaut : ${Math.round(v * 100)} %`) : null));
  appliquer("conditionsPaiement", (v) => (typeof v === "string" && v.trim() ? ((reglages.paymentTerms = v.trim()), `conditions de paiement : ${v.trim()}`) : null));
  appliquer("mentionPied", (v) => (typeof v === "string" && v.trim() ? ((reglages.footerNote = v.trim()), "mention de pied de page") : null));
  // Le papier : celui CHOISI pour la pièce, sinon le modèle que la Direction artistique désigne pour
  // sa nature, sinon le papier par défaut de l'entité, sinon le premier de la société, sinon un
  // papier commun au groupe — jamais celui d'une autre société (`resoudrePapierEnTete`).
  const resolu = resoudrePapierEnTete(entetes, {
    societeId: s.id,
    choisi: opts.papierEnTeteId,
    parNature: opts.type ? lireModelesParType(profil?.settings)[opts.type] ?? null : null,
    defaut: reglages.letterheadId,
  });
  if (resolu.choisiIntrouvable) {
    // Seuls les en-têtes Word ACTIFS de cette société ou communs au groupe sont candidats :
    // « introuvable » couvre donc aussi « appartient à une autre société », sans le révéler.
    return echec("NOT_FOUND", "Ce papier en-tête n'existe pas, n'est plus actif, ou n'est pas un modèle Word de cette société.");
  }
  const papier = resolu.papier;
  const papierOctets = papier ? await getBlob(papier.blobId) : null;
  // LA MARQUE (§26) : lue dans `settings.marque` du profil ; la charte effective tranche marque >
  // bleu canard de la maison (la pastille de l'entité colore les écrans, pas les pièces). Le logo n'est chargé que s'il servira : sans papier en-tête.
  const marque = lireMarque(profil?.settings);
  const charte = charteDe(marque);
  let logo: Habillage["logo"] = null;
  if (marque.logo && !(papierOctets && papierOctets.length > 0)) {
    const octets = await getBlob(marque.logo.blobId).catch(sansBloquer("factory.profilDocumentaire.getBlob", null));
    if (octets && octets.length > 0) logo = { octets: Buffer.from(octets), png: marque.logo.mime === "image/png", largeurCm: marque.logo.largeurCm };
  }
  const partie: PartieCommerciale = {
    nom: identite?.legalName?.trim() || s.name,
    formeJuridique: identite?.legalForm ?? null,
    capital: identite?.shareCapital ?? null,
    adresse: identite?.headOffice ?? null,
    rc: identite?.rcNumber ?? null,
    nif: identite?.nif ?? null,
    ai: identite?.taxArticle ?? null,
    nis: identite?.nis ?? null,
    telephone: identite?.phone ?? null,
    email: identite?.email ?? null,
    banque: [identite?.bankName, identite?.bankAgency].filter(Boolean).join(" — ") || null,
    // LE COFFRE (refonte V2-E) : le RIB de la société, contrôlé et journalisé au nom de qui émet la pièce.
    rib: (await controlerRibDePiece(user, identite?.rib, `Pièce commerciale${opts.type ? ` (${opts.type})` : ""} — RIB de la société`)) ?? null,
  };
  const papierEffectif = papierOctets && papierOctets.length > 0 ? papierOctets : null;
  return {
    ok: true,
    papierOctets: papierEffectif,
    logo,
    habillage: { base: papierEffectif, police: charte.policeTexte, logo },
    profil: {
      // La couleur de la société telle que la fabrique l'applique EST l'accent de la charte.
      societe: { id: s.id, nom: s.name, couleur: charte.accent },
      identite: partie,
      identiteIncomplete: MENTIONS_FACTURE.filter((m) => !(partie[m.cle] as string | null)?.trim()).map((m) => m.libelle),
      reglages,
      papierEnTete: papier && papierOctets ? { id: papier.id, nom: papier.name } : null,
      reglesAppliquees,
      marque, charte, resumeMarque: resumerMarque(marque, charte),
    },
  };
}

export interface ModificationsProfil {
  quotePrefix?: string | null;
  orderPrefix?: string | null;
  invoicePrefix?: string | null;
  vatRate?: number | null;
  paymentTerms?: string | null;
  quoteValidityDays?: number | null;
  footerNote?: string | null;
  letterheadId?: string | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  /** Le motif du numéro par nature ; `null` efface (retour au défaut). Voir `MOTIF_NUMERO_DEFAUT`. */
  numerotation?: Partial<Record<TypeDocumentCommercial, string | null>>;
  /** Le premier numéro de l'année pour une nature : `{ annee: 2026, numero: 32 }` ; `numero: null` retire le départ de cette année. */
  numerotationDepart?: Partial<Record<TypeDocumentCommercial, { annee: number; numero: number | null }>>;
}

/** DÉFINIT (ou corrige) le profil documentaire d'une société — les tenants de la papeterie seulement. */
export async function definirProfilDocumentaire(
  user: CurrentUser, opts: { societe?: string | null } & ModificationsProfil,
): Promise<{ ok: true; profil: ProfilDocumentaire } | EchecFabrique> {
  if (!canManageLetterheads(user)) return echec("MISSING_PERMISSION", "Le profil documentaire d'une société se règle par ceux qui tiennent sa papeterie (assistante de direction, Super Admin).");
  const r = await resoudreSociete(user.id, opts.societe);
  if (!r.ok) return r;
  const s = r.societe;
  const data: Prisma.CompanyDocumentProfileUncheckedUpdateInput = { updatedById: user.id };
  for (const cle of ["quotePrefix", "orderPrefix", "invoicePrefix"] as const) {
    const v = opts[cle];
    if (v === undefined) continue;
    if (v === null || !/^[A-Za-z0-9]{1,8}$/.test(v)) return echec("MISSING_INPUT", `Préfixe « ${String(v)} » invalide : 1 à 8 lettres ou chiffres.`);
    data[cle] = v.toUpperCase();
  }
  if (opts.vatRate !== undefined && opts.vatRate !== null) {
    if (!TAUX_TVA_ADMIS.some((t) => Math.abs(t - opts.vatRate!) < 1e-9)) return echec("MISSING_INPUT", `Taux de TVA ${opts.vatRate} inconnu en Algérie (0, 0,09, 0,19).`);
    data.vatRate = new Prisma.Decimal(opts.vatRate);
  }
  if (opts.quoteValidityDays !== undefined && opts.quoteValidityDays !== null) {
    if (!Number.isInteger(opts.quoteValidityDays) || opts.quoteValidityDays < 1 || opts.quoteValidityDays > 365) return echec("MISSING_INPUT", "La validité d'un devis va de 1 à 365 jours.");
    data.quoteValidityDays = opts.quoteValidityDays;
  }
  for (const cle of ["paymentTerms", "footerNote", "signatoryName", "signatoryTitle"] as const) {
    if (opts[cle] !== undefined) data[cle] = opts[cle]?.trim() || null;
  }
  if (opts.letterheadId !== undefined) {
    if (opts.letterheadId) {
      const lh = await prisma.officeLetterhead.findUnique({ where: { id: opts.letterheadId }, select: { kind: true, isActive: true, companyId: true } });
      if (!lh || !lh.isActive) return echec("NOT_FOUND", "Ce papier en-tête n'existe plus.");
      if (lh.kind !== "word") return echec("MISSING_INPUT", "Le papier en-tête d'une pièce commerciale est un modèle Word.");
      if (lh.companyId && lh.companyId !== s.id) return echec("MISSING_PERMISSION", "Ce papier en-tête appartient à une autre société.");
    }
    data.letterheadId = opts.letterheadId || null;
  }
  if (opts.numerotation !== undefined && opts.numerotation !== null) {
    // Le motif se vérifie AVANT d'écrire : un motif sans séquence numéroterait toutes les pièces
    // pareil, et le refus nomme le jeton fautif plutôt que de laisser un « 001/FS/26 » bancal.
    for (const type of TYPES_DOCUMENT) {
      const v = opts.numerotation[type];
      if (v === undefined || v === null || v.trim() === "") continue;
      const refus = validerMotifNumero(v);
      if (refus) return echec("MISSING_INPUT", `Motif de numérotation des ${PLURIEL_TYPE[type]} refusé : ${refus}`);
    }
    const actuel = await prisma.companyDocumentProfile.findUnique({ where: { companyId: s.id }, select: { settings: true } });
    const settings = actuel?.settings && typeof actuel.settings === "object" && !Array.isArray(actuel.settings) ? { ...(actuel.settings as Record<string, unknown>) } : {};
    const numerotation: Record<string, string> = { ...lireNumerotation(actuel?.settings) };
    for (const type of TYPES_DOCUMENT) {
      const v = opts.numerotation[type];
      if (v === undefined) continue;
      if (v === null || v.trim() === "") delete numerotation[type]; else numerotation[type] = v.trim();
    }
    settings.numerotation = numerotation;
    data.settings = settings as Prisma.InputJsonValue;
  }
  if (opts.numerotationDepart !== undefined && opts.numerotationDepart !== null) {
    // Le départ se vérifie AVANT d'écrire, et NOMME ce qu'il refuse : un « 0 » ou un « 032 » mal lu ne devient pas un plancher.
    for (const type of TYPES_DOCUMENT) {
      const d = opts.numerotationDepart[type];
      if (!d || d.numero === null) continue;
      const refus = validerDepart(d.annee, d.numero);
      if (refus) return echec("MISSING_INPUT", `Départ de numérotation des ${PLURIEL_TYPE[type]} refusé : ${refus}`);
    }
    const dejaLu = (data.settings as Record<string, unknown> | undefined)
      ?? (await prisma.companyDocumentProfile.findUnique({ where: { companyId: s.id }, select: { settings: true } }))?.settings;
    const settings = dejaLu && typeof dejaLu === "object" && !Array.isArray(dejaLu) ? { ...(dejaLu as Record<string, unknown>) } : {};
    const departs: Record<string, Record<string, number>> = {};
    for (const [type, parAnnee] of Object.entries(lireNumerotationDepart(settings as Prisma.JsonValue))) departs[type] = { ...(parAnnee as Record<string, number>) };
    for (const type of TYPES_DOCUMENT) {
      const d = opts.numerotationDepart[type];
      if (!d) continue;
      const annee = String(d.annee);
      if (d.numero === null) { if (departs[type]) delete departs[type][annee]; if (departs[type] && !Object.keys(departs[type]).length) delete departs[type]; continue; }
      departs[type] = { ...(departs[type] ?? {}), [annee]: d.numero };
    }
    settings.numerotationDepart = departs;
    data.settings = settings as Prisma.InputJsonValue;
  }
  await prisma.companyDocumentProfile.upsert({
    where: { companyId: s.id },
    create: { ...(data as Omit<Prisma.CompanyDocumentProfileUncheckedCreateInput, "companyId">), companyId: s.id },
    update: data,
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Legal", entityType: "COMPANY", entityId: s.id, summary: `Profil documentaire de ${s.name} réglé : ${Object.keys(data).filter((k) => k !== "updatedById").map((k) => (k === "settings" ? "numerotation" : k)).join(", ") || "aucun changement"}` });
  const relu = await profilDocumentaire(user, s.id);
  return relu.ok ? { ok: true, profil: relu.profil } : relu;
}
