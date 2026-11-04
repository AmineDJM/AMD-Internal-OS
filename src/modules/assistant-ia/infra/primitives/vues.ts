import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { INSTITUTION_TYPE } from "@/lib/labels";
import { lignesProduits } from "@/lib/actions/internes/primitives/produits";
import { LIBELLE_MISSION } from "../../domaine/sous-missions";
import type { ChampVue, DeclarationVue, Ligne } from "../../domaine/primitives/vues";
import { SELECT_ETABLISSEMENT } from "../annuaire/lectures";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PRESETS DE `lire` (I3, décision 0065 → I4, décision 0067). Ce n'est plus un registre à part : `lire` lit TOUTE table
 * de l'ERP (`tables.ts`) ; un preset ne fait que nommer en français une lecture fréquente et y ajouter des champs CALCULÉS
 * par les règles de l'ERP (étape du cycle, « commercialisé », diagnostic d'une mission, retard d'une tâche).
 *
 * Deux sortes : un preset GÉNÉRIQUE (tâches, demandes) = des noms sur les colonnes d'une table, lue par la lecture
 * générique ; un preset À LECTEUR PROPRE (produits, établissements, missions) = une lecture qui calcule ce qu'aucune colonne
 * ne porte. Dans les deux cas, la PORTÉE et les DROITS sont ceux de la table (`droitDeLire`, `PORTEES`) — une seule règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un preset À LECTEUR PROPRE : des champs calculés par les règles de l'ERP qu'une colonne ne porte pas (étape du cycle, diagnostic). */
export interface VueLisible<P = unknown> extends DeclarationVue {
  /** La table dont la portée des lignes (`PORTEES`) et les droits (`droitDeLire`) s'appliquent — la même règle que la lecture générique. */
  table: string;
  /** Les lignes SOUS la portée calculée par l'exécuteur, et seulement elle (bornées). */
  lire: (u: CurrentUser, portee: P, maintenant: Date) => Promise<Ligne[]>;
}

/** Un preset GÉNÉRIQUE : des noms français sur les colonnes d'une table, et quelques champs calculés — la lecture reste celle de la table. */
export interface PresetGenerique {
  nom: string; table: string; description: string; ecran: string; droit: string;
  /** nom du champ du preset → chemin dans la table (`title`, `assignedTo.name`). */
  renomme: Readonly<Record<string, string>>;
  alias?: Readonly<Record<string, readonly string[]>>;
  calcules: readonly { champ: ChampVue; besoin: readonly string[]; calcul: (l: Ligne, maintenant: Date) => unknown }[];
  parDefaut: readonly string[];
}
export type Preset = VueLisible<never> | PresetGenerique;
export const estGenerique = (p: Preset): p is PresetGenerique => "renomme" in p;

/** Les choix d'un champ, depuis les libellés de l'écran (code → [libellé, …mots naturels]). */
const choix = (libelles: Record<string, string | { label: string }>, mots: Record<string, string[]> = {}): Record<string, string[]> =>
  Object.fromEntries(Object.entries(libelles).map(([code, l]) => [code, [typeof l === "string" ? l : l.label, ...(mots[code] ?? [])]]));
const col = (modele: string, champ: string) => ({ modele, champ });
const regle = (r: string) => ({ regle: r });
const ID = (modele: string): ChampVue => ({ nom: "id", type: "texte", description: "Identifiant de la fiche.", source: col(modele, "id") });
const LIEN = (ecran: string): ChampVue => ({ nom: "lien", type: "lien", description: `Lien de l'écran (${ecran}) — à remettre tel quel : la réponse reste cliquable.`, source: regle("lien d'écran") });

// ─── produits ────────────────────────────────────────────────────────────────────────────────

const PRODUITS: VueLisible<Prisma.ProductWhereInput> = {
  nom: "produits",
  description: "Le catalogue des produits de la société (écran Produits 360), avec l'étape du cycle de vie et l'état « commercialisé » calculés par les règles de l'ERP, et les aires thérapeutiques lues sur les dossiers.",
  ecran: "/produits",
  droit: "Produits (consultation)",
  champs: [
    ID("Product"),
    { nom: "nom", type: "texte", description: "Nom du produit.", source: col("Product", "canonicalName"), alias: ["produit", "designation"] },
    { nom: "dci", type: "texte", description: "Dénomination commune (molécule).", source: col("Product", "dci"), alias: ["molecule"] },
    { nom: "code", type: "texte", description: "Code produit.", source: col("Product", "code") },
    { nom: "forme", type: "texte", description: "Forme galénique.", source: col("Product", "form") },
    { nom: "societe", type: "texte", description: "Société titulaire.", source: col("Company", "shortName"), alias: ["laboratoire", "partenaire"] },
    {
      nom: "etape", type: "choix", source: regle("etapeCycle (fiche 360, Direction 06/10)"), alias: ["cycle", "stade", "cycle de vie"],
      description: "Étape du cycle de vie : un dossier terminé (décision obtenue ou clos) = commercialisé.",
      valeurs: { ETUDE: ["étude", "en étude"], ENREGISTREMENT: ["en enregistrement", "pipeline", "en cours d'enregistrement"], COMMERCIALISE: ["commercialisé", "sur le marché", "vendu", "marketed", "commercialises"], FIN_DE_VIE: ["fin de vie", "arrêté", "retiré"] },
    },
    { nom: "commercialise", type: "booleen", description: "Le produit est dans l'onglet « Commercialisés » de l'écran (un dossier terminé visible).", source: regle("clauseCommercialises (onglet Commercialisés)") },
    { nom: "aires", type: "liste", description: "Aires thérapeutiques des dossiers (ex. Infectiologie, Cardiologie) — c'est ici que se lit l'aire, PAS dans la BU.", source: col("RegulatoryProduct", "therapeuticSegments"), alias: ["aire", "aire therapeutique", "segment", "segments", "therapeutique"] },
    { nom: "classes", type: "liste", description: "Classes thérapeutiques des dossiers (ex. Carbapénème, Anti-infectieux).", source: col("RegulatoryProduct", "therapeuticClass"), alias: ["classe", "classe therapeutique"] },
    { nom: "marques", type: "liste", description: "Noms de marque des dossiers.", source: col("RegulatoryProduct", "brandName"), alias: ["marque"] },
    { nom: "dossiers", type: "liste", description: "Références des dossiers réglementaires visibles.", source: col("RegulatoryProduct", "reference") },
    { nom: "bu", type: "liste", description: "Business units qui promeuvent le produit — un faux ami de l'aire thérapeutique (une BU « Infectiologie / Hématologie » porte un anticoagulant).", source: col("BusinessUnit", "name") },
    { nom: "actif", type: "booleen", description: "Produit actif.", source: col("Product", "isActive") },
    LIEN("/produits/<id>"),
  ],
  parDefaut: ["nom", "dci", "etape", "commercialise", "aires", "classes", "societe"],
  table: "Product",
  lire: async (u, portee) => (await lignesProduits(u, portee)) as unknown as Ligne[],
};

// ─── établissements ─────────────────────────────────────────────────────────────────────────

const ETABLISSEMENTS: VueLisible<Prisma.MedicalInstitutionWhereInput> = {
  nom: "etablissements",
  description: "L'annuaire des établissements de santé (hôpitaux, cliniques, pharmacies, grossistes…), avec leur couverture terrain.",
  ecran: "/annuaires/etablissements",
  droit: "Annuaire des établissements (ou des pharmaciens), consultation",
  champs: [
    ID("MedicalInstitution"),
    { nom: "nom", type: "texte", description: "Nom de l'établissement.", source: col("MedicalInstitution", "name"), alias: ["raison sociale", "etablissement"] },
    { nom: "type", type: "choix", description: "Type d'établissement.", source: col("MedicalInstitution", "type"), valeurs: choix(INSTITUTION_TYPE, { PHARMACIE: ["officine", "pharmacies"], GROSSISTE: ["grossistes", "repartiteur"], CHU: ["hopital universitaire"], EPH: ["hopital", "hopitaux"], CLINIQUE_PRIVEE: ["clinique", "cliniques"] }) },
    { nom: "wilaya", type: "texte", description: "Wilaya.", source: col("MedicalInstitution", "wilaya"), alias: ["departement", "region"] },
    { nom: "ville", type: "texte", description: "Ville / commune.", source: col("MedicalInstitution", "city"), alias: ["commune"] },
    { nom: "adresse", type: "texte", description: "Adresse.", source: col("MedicalInstitution", "address") },
    { nom: "telephone", type: "texte", description: "Téléphone (un numéro : il ne s'additionne pas).", source: col("MedicalInstitution", "phone"), alias: ["tel", "numero"] },
    { nom: "email", type: "texte", description: "Adresse e-mail.", source: col("MedicalInstitution", "email"), alias: ["mail", "courriel"] },
    { nom: "actif", type: "booleen", description: "Fiche active (une fiche inactive n'est plus démarchée).", source: col("MedicalInstitution", "isActive") },
    { nom: "secteurs", type: "liste", description: "Secteurs de vente actifs qui le couvrent.", source: col("SalesSector", "name") },
    { nom: "couvertPar", type: "liste", description: "Délégués qui le couvrent.", source: col("SalesSectorRep", "rep") },
    { nom: "bu", type: "liste", description: "Business units de ses secteurs.", source: col("BusinessUnit", "name") },
    { nom: "praticiens", type: "nombre", description: "Praticiens rattachés.", source: regle("compte des médecins rattachés") },
    LIEN("/annuaires/etablissements"),
  ],
  parDefaut: ["nom", "type", "wilaya", "ville", "adresse", "telephone", "email"],
  table: "MedicalInstitution",
  lire: async (_u, portee) => {
    const es = await prisma.medicalInstitution.findMany({
      where: portee, orderBy: { name: "asc" }, take: 5_000,
      select: SELECT_ETABLISSEMENT,
    });
    return es.map((e) => ({
      id: e.id, nom: e.name, type: INSTITUTION_TYPE[e.type] ?? e.type, typeCode: e.type, wilaya: e.wilaya ?? null, ville: e.city ?? null, adresse: e.address || null,
      telephone: e.phone || null, email: e.email || null, actif: e.isActive,
      secteurs: e.sectors.map((s) => s.sector.name), couvertPar: [...new Set(e.sectors.flatMap((s) => s.sector.reps.map((r) => r.rep.name)))],
      bu: [...new Set(e.sectors.map((s) => s.sector.businessUnit.name))], praticiens: e._count.doctors,
      lien: `/annuaires/etablissements?q=${encodeURIComponent(e.name)}`,
    }));
  },
};

// ─── missions ────────────────────────────────────────────────────────────────────────────────

const MISSIONS: VueLisible<{ ownerId: string }> = {
  nom: "missions",
  description: "Les missions (travaux) confiées à Adam par la personne — celles du Centre de missions : titre, état, avancement, coût, lien cliquable.",
  ecran: "/centre-de-missions",
  droit: "Adam (l'assistant ouvert à la personne)",
  champs: [
    ID("Mission"),
    { nom: "titre", type: "texte", description: "Titre de la mission.", source: col("Mission", "title"), alias: ["nom", "mission"] },
    { nom: "objectif", type: "texte", description: "Ce qui est demandé.", source: col("Mission", "objective") },
    { nom: "etat", type: "choix", description: "État affiché au Centre de missions.", source: regle("état du moteur des travaux"), alias: ["statut"], valeurs: choix(LIBELLE_MISSION, { EN_COURS: ["active", "actives", "en cours"], TERMINE: ["finie", "terminee", "terminees"] }) },
    { nom: "etapesFaites", type: "nombre", description: "Étapes faites.", source: regle("avancement des étapes") },
    { nom: "etapesTotal", type: "nombre", description: "Étapes prévues.", source: regle("avancement des étapes") },
    { nom: "diagnostic", type: "texte", description: "Ce que le moteur constate (dernière étape, attente, blocage).", source: regle("diagnostic de la mission") },
    { nom: "coutUsd", type: "nombre", description: "Coût consommé (USD).", source: col("Mission", "costUsd") },
    { nom: "majLe", type: "date", description: "Dernière mise à jour.", source: col("Mission", "updatedAt") },
    LIEN("/missions/<id>"),
  ],
  parDefaut: ["titre", "etat", "etapesFaites", "etapesTotal", "majLe"],
  table: "Mission",
  // `missions/pilotage` est lu à l'appel : il tire le moteur des travaux, qui lit lui-même le catalogue (cycle au chargement).
  lire: async (_u, portee, maintenant) => (await (await import("../missions/pilotage")).mesMissions(portee.ownerId, { toutes: true, maintenant })).missions.map((m) => ({
    id: m.id, titre: m.titre, objectif: m.objectif.slice(0, 300), etat: m.etat, etatLibelle: m.libelle, etapesFaites: m.etapes.faites, etapesTotal: m.etapes.total,
    diagnostic: m.diagnostic.phrase ?? null, coutUsd: Math.round(m.coutUsd * 100) / 100, majLe: m.majLe.slice(0, 10), lien: `/missions/${m.id}`,
  })),
};

// ─── tâches, demandes : deux PRESETS de la lecture générique (aucune lecture écrite à la main) ─────────────────────

const OUVERTES = new Set(["REQUESTED", "TODO", "IN_PROGRESS"]);
const TACHES: PresetGenerique = {
  nom: "taches", table: "Task",
  description: "Les tâches de « Mon espace » : celles qui me sont assignées, que j'ai créées, où je suis participant ou en lecture.",
  ecran: "/mon-espace/taches", droit: "Mon espace (consultation)",
  renomme: { titre: "title", statut: "status", priorite: "priority", echeance: "dueDate", assignee: "assignedTo.name", creePar: "createdBy.name", module: "module", creeLe: "createdAt" },
  alias: { titre: ["tache", "intitule"], statut: ["etat"], echeance: ["date limite", "pour le"], assignee: ["assigne a", "responsable"], creePar: ["createur", "demandeur"] },
  calcules: [{
    champ: { nom: "enRetard", type: "booleen", description: "Ouverte et échéance passée.", source: regle("échéance passée d'une tâche ouverte"), alias: ["retard"] },
    besoin: ["status", "dueDate"],
    calcul: (l, maintenant) => OUVERTES.has(String(l.statut)) && l.echeance instanceof Date && l.echeance < maintenant,
  }],
  parDefaut: ["titre", "statut", "priorite", "echeance", "enRetard", "assignee"],
};

const DEMANDES: PresetGenerique = {
  nom: "demandes", table: "AdministrativeRequest",
  description: "Les demandes administratives que la personne voit à l'écran Demandes (les siennes, celles qu'elle suit ou valide, ou tout le périmètre selon son rôle).",
  ecran: "/demandes", droit: "Demandes administratives (consultation)",
  renomme: { reference: "reference", titre: "title", nature: "subtype", statut: "status", priorite: "priority", echeance: "deadline", demandeur: "requester.name", suivi: "assignedTo.name", creeLe: "createdAt" },
  alias: { reference: ["ref", "numero"], titre: ["objet", "demande"], nature: ["type", "sous type"], statut: ["etat"], suivi: ["assignee", "responsable"], creeLe: ["date"] },
  calcules: [],
  parDefaut: ["reference", "titre", "nature", "statut", "demandeur", "suivi", "creeLe"],
};

/** LES PRESETS — l'ordre est celui du schéma exposé au modèle. Tout le reste de l'ERP se lit par sa TABLE. */
export const VUES: readonly Preset[] = [PRODUITS, ETABLISSEMENTS, MISSIONS, TACHES, DEMANDES] as unknown as Preset[];

export const vueNommee = (nom: unknown): Preset | null => {
  const n = String(nom ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return VUES.find((v) => v.nom === n || v.nom === `${n}s` || v.nom.replace(/s$/, "") === n) ?? null;
};
