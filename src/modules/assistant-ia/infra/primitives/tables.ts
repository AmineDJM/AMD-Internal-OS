import { Prisma } from "@prisma/client";
import * as LIBELLES from "@/lib/labels";
import { identiteDonneesDe, type CurrentUser } from "@/lib/session";
import {
  scopeAdminRequests, scopeAdProOther, scopeBdProject, scopeBusinessDevelopment, scopeCongressIntl, scopeCongressNational, scopeDossiers,
  scopeMedicalInfo, scopeMedicalVisits, scopePromoMaterial, scopeRegulatory, scopeSales, scopeSponsoring, scopeSupport, regulatoryLockWhere, userCan,
} from "@/lib/rbac";
import { champSensible } from "@/modules/coffre/partage";
import { baseDuModele, baseDe, COLONNES_REFERENCE, FICHES_TABLES } from "@/modules/acces-bases/partage";
import { droitDeLireTable } from "@/modules/acces-bases/api";
import { porteeProduits } from "@/lib/actions/internes/primitives/produits";
import { familleOuverte, refusFamille, type AccesIa, type FamilleIa } from "../../domaine/acces-regles";
import { profilDuCompte } from "../../domaine/profil-acces";
import { champsDeTable, COLONNE_SECRETE, parDefautDe, plierNom, type ChampModele, type ModeleDecrit } from "../../domaine/primitives/tables";
import type { ChampVue } from "../../domaine/primitives/vues";
import { porteeMedecins, voitEtablissements } from "../annuaire/lectures";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I4 — « ADAM LIT TOUT » (décision 0067) : LES TABLES ET LEURS DROITS. Rien de spécifique à un métier.
 *
 * Le SCHÉMA vient du DMMF de Prisma (chaque modèle, ses colonnes, ses énumérations, ses relations) ; les LIBELLÉS des
 * énumérations, des libellés d'écran (`@/lib/labels`, rapprochés par leurs codes) ; le nom français et la sensibilité de
 * chaque table, du CATALOGUE DES BASES (D1). Les droits sont des INVARIANTS, ÉCHEC FERMÉ, dans cet ordre :
 *
 *   1. la BASE de la table est ouverte à la personne (modules de la base ET niveau réglé par la Direction, D2-D5) ;
 *      le coffre ne se lit jamais ; une table SECRÈTE du catalogue ne se lit que par le Super Admin ;
 *   2. les FAMILLES de la console qui couvrent la base sont ouvertes (salaires, contrats RH, budgets…) — sinon refus nommé ;
 *   3. la PORTÉE DES LIGNES : chaque table lisible par un autre compte que le Super Admin DÉCLARE sa clause, celle de son
 *      écran (`PORTEES`, importée, jamais recopiée) ; une table SANS portée déclarée n'est lisible QUE par le Super Admin ;
 *   4. les COLONNES qui ne sortent jamais : coffre (`champSensible`), mots de passe, jetons, secrets, rémunérations hors Paie.
 *
 * Une relation suivie (`institutionRef.name`) obéit aux mêmes règles : base fermée → non suivie ; table sans portée pour
 * la personne → ses seules colonnes de RÉFÉRENCE (nom, titre — décision n° 7 de la Direction), et jamais vers plusieurs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Clause = Record<string, unknown>;
type Portee = (u: CurrentUser) => Clause | null;

/** Une portée d'écran qui exige le module : sans lui, la table est FERMÉE (jamais « aucune ligne »). */
const parModule = (module: string, scope: (u: CurrentUser) => unknown): Portee => (u) => (userCan(u, module as never, "VIEW") ? (scope(u) as Clause) : null);
const ouvertSi = (voit: (u: CurrentUser) => boolean): Portee => (u) => (voit(u) ? {} : null);
const annuaire = (u: CurrentUser) => voitEtablissements(u) || userCan(u, "MEDICAL", "VIEW");

/**
 * LA PORTÉE DES LIGNES, table par table, pour qui n'est pas Super Admin — la clause de l'écran qui montre ces lignes.
 * Ajouter une table lisible par les employés = une ligne ici (et rien d'autre) ; le banc S1 la rejoue.
 */
export const PORTEES: Readonly<Partial<Record<string, Portee>>> = {
  Product: (u) => porteeProduits(u) as Clause | null,
  // L'annuaire : le PANEL du délégué (son secteur), ou tout l'annuaire ouvert par la console — la clause de l'écran.
  MedicalDoctor: (u) => (userCan(u, "MEDICAL", "VIEW") || voitEtablissements(u) ? (porteeMedecins(u) as Clause) : null),
  MedicalInstitution: ouvertSi(voitEtablissements),
  MedicalInstitutionService: ouvertSi(voitEtablissements),
  // Les référentiels partagés de l'annuaire (spécialités, wilayas, communes) : à qui voit l'annuaire.
  MedicalSpecialty: ouvertSi(annuaire), Wilaya: ouvertSi(annuaire), Commune: ouvertSi(annuaire),
  MedicalVisit: parModule("MEDICAL", scopeMedicalVisits),
  RegulatoryProduct: parModule("REGULATORY", (u) => ({ AND: [scopeRegulatory(u), regulatoryLockWhere(u)] })),
  Task: parModule("WORKSPACE", (u) => ({ OR: [{ assignedToId: u.id }, { createdById: u.id }, { participantIds: { has: u.id } }, { readerIds: { has: u.id } }] })),
  AdministrativeRequest: parModule("ADMIN_REQUESTS", scopeAdminRequests),
  Mission: (u) => ({ ownerId: u.id }),
  Sale: parModule("SALES", scopeSales),
  BusinessDevelopmentOpportunity: parModule("BUSINESS_DEVELOPMENT", scopeBusinessDevelopment),
  BdProject: parModule("BD_PROJECTS", scopeBdProject),
  CongressInternational: parModule("CONGRESS_INTERNATIONAL", scopeCongressIntl),
  CongressNational: parModule("CONGRESS_NATIONAL", scopeCongressNational),
  SponsoringRequest: parModule("SPONSORING", scopeSponsoring),
  AdProOtherRequest: parModule("AD_PRO_OTHER", scopeAdProOther),
  SupportRequest: parModule("SUPPORT", scopeSupport),
  Dossier: parModule("DOSSIERS", scopeDossiers),
  MedicalInfoDeclaration: parModule("MEDICAL_INFO", scopeMedicalInfo),
  PromoMaterial: parModule("PROMO_MATERIAL", scopePromoMaterial),
};

/**
 * LES LIGNES VIVANTES — ce que l'écran ne montre plus à PERSONNE (une fiche archivée, absorbée par une fusion). Valent pour
 * tous, Super Admin compris, sauf quand la demande filtre elle-même sur cette colonne (« les fiches archivées »).
 */
export const VIVANTES: Readonly<Partial<Record<string, Clause>>> = { MedicalDoctor: { archivedAt: null } };

/** L'écran d'une fiche, quand il existe — la colonne « lien » du jeu et du livrable. `<id>` est remplacé. */
export const ECRANS: Readonly<Record<string, string>> = {
  MedicalDoctor: "/praticiens/<id>", Product: "/produits/<id>", Mission: "/missions/<id>", AdministrativeRequest: "/demandes/<id>",
  Task: "/mon-espace/taches?tache=<id>", MedicalVisit: "/medical/rapports/<id>", MedicalInfoDeclaration: "/information-medicale/<id>",
  MedicalInstitution: "/annuaires/etablissements?q=<name>", RegulatoryProduct: "/regulatory?dossier=<id>",
};

// ─── Le schéma ─────────────────────────────────────────────────────────────────────────────

const MODELES: ReadonlyMap<string, ModeleDecrit> = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, {
  nom: m.name, cle: m.fields.find((f) => f.isId)?.name ?? "id",
  champs: m.fields.map((f): ChampModele => ({ nom: f.name, genre: f.kind as ChampModele["genre"], type: f.type, liste: f.isList, doc: f.documentation ?? null })),
}]));
const ENUMS = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
export const modeleDecrit = (nom: string): ModeleDecrit | null => MODELES.get(nom) ?? null;

/** Les libellés d'écran d'une énumération : l'export de `@/lib/labels` qui couvre le mieux ses codes (ex. `DOCTOR_TITLE`). */
const CACHE_ENUM = new Map<string, Record<string, string[]> | null>();
export function valeursEnum(nom: string): Record<string, string[]> | null {
  if (CACHE_ENUM.has(nom)) return CACHE_ENUM.get(nom)!;
  const codes = ENUMS.get(nom) ?? [];
  let meilleur: { score: number; lib: Record<string, unknown> } | null = null;
  for (const v of Object.values(LIBELLES)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const lib = v as Record<string, unknown>;
    const couverts = codes.filter((c) => typeof lib[c] === "string" || typeof (lib[c] as { label?: unknown })?.label === "string").length;
    const longueur = codes.reduce((s, c) => s + String((lib[c] as { label?: string })?.label ?? lib[c] ?? "").length, 0);
    const score = couverts * 1000 + longueur - Object.keys(lib).length;
    if (couverts >= Math.ceil(codes.length * 0.6) && (!meilleur || score > meilleur.score)) meilleur = { score, lib };
  }
  const lire = (c: string) => { const x = meilleur?.lib[c]; return typeof x === "string" ? x : typeof (x as { label?: unknown })?.label === "string" ? (x as { label: string }).label : null; };
  const r = codes.length ? Object.fromEntries(codes.map((c) => [c, [lire(c) ?? c.toLowerCase().replace(/_/g, " ")]])) : null;
  CACHE_ENUM.set(nom, r);
  return r;
}

/** Un nom de table dit naturellement : le modèle, son accesseur, un pluriel, ou son libellé français du catalogue. */
export function resoudreTable(nom: unknown): string | null {
  const p = plierNom(nom);
  if (!p) return null;
  for (const m of MODELES.keys()) if (plierNom(m) === p || `${plierNom(m)}s` === p) return m;
  for (const [m, f] of Object.entries(FICHES_TABLES)) if (plierNom(f.libelle) === p || plierNom(f.libelle.split(/[(,—-]/)[0]) === p || `${plierNom(f.libelle.split(/[(,—-]/)[0])}s` === p) return m;
  return null;
}

/** Les tables proches d'un nom inconnu — dites au modèle (jamais un « aucune »). */
export function tablesProches(nom: unknown, n = 8): string[] {
  const mots = plierNom(nom).replace(/s$/, "");
  if (mots.length < 3) return [];
  return Object.entries(FICHES_TABLES).filter(([m, f]) => plierNom(m).includes(mots) || plierNom(f.libelle).includes(mots)).slice(0, n).map(([m, f]) => `${m} (${f.libelle})`);
}

// ─── Les droits ────────────────────────────────────────────────────────────────────────────

const MOTS_DE_REMUNERATION = /(salaire|salary|remunerat|payroll|brut|netapay|nettopay|employercost|coutemployeur|iban|rib$|^rib|nationalid|passeport|passport|cnas)/i;
const BASE_PAIE = "paie";

export type DroitDeLire = { ok: true; portee: Clause; superAdmin: boolean } | { ok: false; droit: string; raison: string };

/** Les colonnes qui ne sortent jamais de cette table (coffre, secrets, rémunérations hors de la base Paie). */
export function colonneLisible(modele: string, champ: string): boolean {
  if (COLONNE_SECRETE.test(champ) || champSensible(modele, champ)) return false;
  return baseDuModele(modele) === BASE_PAIE || !MOTS_DE_REMUNERATION.test(champ);
}

const libelleTable = (modele: string) => FICHES_TABLES[modele]?.libelle ?? modele;

/** LE DROIT DE LIRE CETTE TABLE, pour cette personne, maintenant — la portée de ses lignes, ou le refus nommé. */
export function droitDeLire(u: CurrentUser, acces: AccesIa, modele: string, porteeImposee?: Portee): DroitDeLire {
  const fiche = FICHES_TABLES[modele];
  const cle = baseDuModele(modele);
  const base = cle ? baseDe(cle) : null;
  if (!fiche || !base) return { ok: false, droit: "table du catalogue des bases", raison: `La table « ${modele} » n'est pas rangée au catalogue des bases : elle ne se lit pas.` };
  if (base.cle === "coffre") return { ok: false, droit: "coffre", raison: "Le coffre des données sensibles ne se lit jamais par Adam." };
  const superAdmin = profilDuCompte(u).superAdmin;
  if (fiche.sensibilite === "secret" && !superAdmin) {
    return { ok: false, droit: "Super Admin", raison: `« ${fiche.libelle} » est une table SECRÈTE du catalogue des bases : seul le Super Admin la lit par Adam.` };
  }
  const familles = base.famillesIa.filter((f) => f !== "ECRITURES") as FamilleIa[];
  const fermee = familles.find((f) => !familleOuverte(acces, f));
  if (fermee) return { ok: false, droit: `famille « ${fermee} »`, raison: refusFamille(fermee) };
  const surBase = droitDeLireTable(identiteDonneesDe(u), modele);
  if (!surBase?.lecture) return { ok: false, droit: `base « ${base.nom} »`, raison: `La base « ${base.nom} » ne vous est pas ouverte en lecture (${surBase?.chemin ?? "hors catalogue"}) — réglé en Administration › Accès.` };
  const declaree = porteeImposee ?? PORTEES[modele];
  const portee = declaree ? declaree(u) : superAdmin ? {} : null;
  if (portee === null) {
    return declaree
      ? { ok: false, droit: `écran « ${libelleTable(modele)} »`, raison: `« ${libelleTable(modele)} » demande un droit d'écran que votre rôle n'a pas (Administration › Accès). Rien n'a été lu.` }
      : { ok: false, droit: "portée déclarée", raison: `« ${libelleTable(modele)} » n'a pas de portée de lignes déclarée pour un autre compte que le Super Admin : elle ne se lit pas par Adam. Rien n'a été lu.` };
  }
  return { ok: true, portee: superAdmin && !porteeImposee ? {} : portee, superAdmin };
}

/** Les champs lisibles d'une table POUR CETTE PERSONNE (relations jugées comme leur table). */
export function champsPour(u: CurrentUser, acces: AccesIa, modele: string): { modele: ModeleDecrit; champs: ChampVue[]; parDefaut: string[]; portees: Map<string, Clause> } | null {
  const m = modeleDecrit(modele);
  if (!m) return null;
  const portees = new Map<string, Clause>();
  const champs = champsDeTable(m, {
    modele: modeleDecrit,
    lisible: colonneLisible,
    valeursEnum,
    relation: (lie, versPlusieurs) => {
      const d = droitDeLire(u, acces, lie);
      if (d.ok) { portees.set(lie, d.portee); return { colonnes: null }; }
      // Fermée à la personne : vers UNE fiche, ses seules colonnes de RÉFÉRENCE (nom, titre — le libellé de l'écran) ; base
      // fermée ou coffre : rien ; vers plusieurs : rien (une liste de noms hors de sa portée la trahirait).
      const surBase = droitDeLireTable(identiteDonneesDe(u), lie);
      return !versPlusieurs && surBase?.lecture && baseDuModele(lie) !== "coffre" ? { colonnes: COLONNES_REFERENCE } : null;
    },
  });
  return { modele: m, champs, parDefaut: parDefautDe(m, champs), portees };
}

export { libelleTable };
