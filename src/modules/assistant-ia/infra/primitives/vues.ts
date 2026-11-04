import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
// La portée de l'écran Demandes est `scopeAdminRequests` (`lib/rbac/portees.ts`), lue par le socle RBAC.
import { scopeAdminRequests as scopeDemandes, userCan } from "@/lib/rbac";
import { ADMIN_REQUEST_STATUS, INSTITUTION_TYPE, PRIORITY, TASK_STATUS } from "@/lib/labels";
import { lignesProduits, porteeProduits } from "@/lib/actions/internes/primitives/produits";
import { LIBELLE_MISSION } from "../../domaine/sous-missions";
import type { ChampVue, DeclarationVue, Ligne } from "../../domaine/primitives/vues";
import { SELECT_ETABLISSEMENT, voitEtablissements } from "../annuaire/lectures";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — LE REGISTRE DES VUES DE `lire` (décision 0065, audit AU2 §6.1 (a), étape M0) : cinq vues.
 *
 * Une vue = une DÉCLARATION (champs, champs calculés par les règles de l'ERP, lien d'écran, droit) + une PORTÉE + une
 * lecture. LA PORTÉE EST OBLIGATOIRE PAR TYPE (`VueLisible.portee`) : c'est la fonction `where` de l'écran qui montre
 * ces lignes (la même, importée, jamais recopiée) ; `null` = la vue est FERMÉE à cette personne — l'outil reste offert et
 * REFUSE en nommant le droit (masquer un outil fait mentir l'assistant : « aucun produit » au lieu de « fermé »).
 * La lecture ne reçoit QUE la portée calculée par l'exécuteur (`executerVue`) : elle ne peut pas lire hors d'elle.
 *
 * Ajouter une vue = une entrée ici ; `primitives.test.ts` vérifie chaque déclaration (aucune colonne du coffre, droit dit,
 * lien d'écran) et rejoue les attaques S1 sous l'espion de Prisma.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface VueLisible<P = unknown> extends DeclarationVue {
  /** LA PORTÉE de l'écran pour cette personne ; `null` : fermée (le droit n'y est pas). */
  portee: (u: CurrentUser) => P | null;
  /** Les lignes SOUS cette portée, et seulement elle (bornées). */
  lire: (u: CurrentUser, portee: P, maintenant: Date) => Promise<Ligne[]>;
}

/** Les choix d'un champ, depuis les libellés de l'écran (code → [libellé, …mots naturels]). */
const choix = (libelles: Record<string, string | { label: string }>, mots: Record<string, string[]> = {}): Record<string, string[]> =>
  Object.fromEntries(Object.entries(libelles).map(([code, l]) => [code, [typeof l === "string" ? l : l.label, ...(mots[code] ?? [])]]));
const col = (modele: string, champ: string) => ({ modele, champ });
const regle = (r: string) => ({ regle: r });
const ID = (modele: string): ChampVue => ({ nom: "id", type: "texte", description: "Identifiant de la fiche.", source: col(modele, "id") });
const LIEN = (ecran: string): ChampVue => ({ nom: "lien", type: "lien", description: `Lien de l'écran (${ecran}) — à remettre tel quel : la réponse reste cliquable.`, source: regle("lien d'écran") });
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

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
  portee: porteeProduits,
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
  portee: (u) => (voitEtablissements(u) ? {} : null),
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
  portee: (u) => ({ ownerId: u.id }),
  // `missions/pilotage` est lu à l'appel : il tire le moteur des travaux, qui lit lui-même le catalogue (cycle au chargement).
  lire: async (_u, portee, maintenant) => (await (await import("../missions/pilotage")).mesMissions(portee.ownerId, { toutes: true, maintenant })).missions.map((m) => ({
    id: m.id, titre: m.titre, objectif: m.objectif.slice(0, 300), etat: m.etat, etatLibelle: m.libelle, etapesFaites: m.etapes.faites, etapesTotal: m.etapes.total,
    diagnostic: m.diagnostic.phrase ?? null, coutUsd: Math.round(m.coutUsd * 100) / 100, majLe: m.majLe.slice(0, 10), lien: `/missions/${m.id}`,
  })),
};

// ─── tâches ──────────────────────────────────────────────────────────────────────────────────

const OUVERTES = new Set(["REQUESTED", "TODO", "IN_PROGRESS"]);
const TACHES: VueLisible<Prisma.TaskWhereInput> = {
  nom: "taches",
  description: "Les tâches de « Mon espace » : celles qui me sont assignées, que j'ai créées, où je suis participant ou en lecture.",
  ecran: "/mon-espace/taches",
  droit: "Mon espace (consultation)",
  champs: [
    ID("Task"),
    { nom: "titre", type: "texte", description: "Intitulé.", source: col("Task", "title"), alias: ["tache", "intitule"] },
    { nom: "statut", type: "choix", description: "Statut.", source: col("Task", "status"), alias: ["etat"], valeurs: choix(TASK_STATUS, { TODO: ["a faire", "todo", "ouverte"], DONE: ["faite", "terminee", "finie"] }) },
    { nom: "priorite", type: "choix", description: "Priorité.", source: col("Task", "priority"), valeurs: choix(PRIORITY, { HIGH: ["urgente", "importante"], CRITICAL: ["urgentissime"] }) },
    { nom: "echeance", type: "date", description: "Échéance.", source: col("Task", "dueDate"), alias: ["date limite", "pour le"] },
    { nom: "enRetard", type: "booleen", description: "Ouverte et échéance passée.", source: regle("échéance passée d'une tâche ouverte"), alias: ["retard"] },
    { nom: "assignee", type: "texte", description: "Personne à qui elle est assignée.", source: col("User", "name"), alias: ["assigne a", "responsable"] },
    { nom: "creePar", type: "texte", description: "Personne qui l'a créée.", source: col("User", "name"), alias: ["createur", "demandeur"] },
    { nom: "module", type: "texte", description: "Module concerné.", source: col("Task", "module") },
    { nom: "creeLe", type: "date", description: "Date de création.", source: col("Task", "createdAt") },
    LIEN("/mon-espace/taches?tache=<id>"),
  ],
  parDefaut: ["titre", "statut", "priorite", "echeance", "enRetard", "assignee"],
  portee: (u) => (userCan(u, "WORKSPACE", "VIEW")
    ? { OR: [{ assignedToId: u.id }, { createdById: u.id }, { participantIds: { has: u.id } }, { readerIds: { has: u.id } }] }
    : null),
  lire: async (_u, portee, maintenant) => (await prisma.task.findMany({
    where: portee, orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }], take: 2_000,
    select: { id: true, title: true, status: true, priority: true, dueDate: true, module: true, createdAt: true, assignedTo: { select: { name: true } }, createdBy: { select: { name: true } } },
  })).map((t) => ({
    id: t.id, titre: t.title, statut: t.status, priorite: t.priority, echeance: ymd(t.dueDate),
    enRetard: OUVERTES.has(t.status) && !!t.dueDate && t.dueDate < maintenant,
    assignee: t.assignedTo?.name ?? null, creePar: t.createdBy?.name ?? null, module: t.module, creeLe: ymd(t.createdAt), lien: `/mon-espace/taches?tache=${t.id}`,
  })),
};

// ─── demandes ────────────────────────────────────────────────────────────────────────────────

const DEMANDES: VueLisible<Prisma.AdministrativeRequestWhereInput> = {
  nom: "demandes",
  description: "Les demandes administratives que la personne voit à l'écran Demandes (les siennes, celles qu'elle suit ou valide, ou tout le périmètre selon son rôle).",
  ecran: "/demandes",
  droit: "Demandes administratives (consultation)",
  champs: [
    ID("AdministrativeRequest"),
    { nom: "reference", type: "texte", description: "Référence.", source: col("AdministrativeRequest", "reference"), alias: ["ref", "numero"] },
    { nom: "titre", type: "texte", description: "Objet de la demande.", source: col("AdministrativeRequest", "title"), alias: ["objet", "demande"] },
    { nom: "nature", type: "texte", description: "Nature (sous-type) de la demande.", source: col("AdministrativeRequest", "subtype"), alias: ["type", "sous type"] },
    { nom: "statut", type: "choix", description: "Statut.", source: col("AdministrativeRequest", "status"), alias: ["etat"], valeurs: choix(ADMIN_REQUEST_STATUS, { NEW: ["nouvelle", "nouvelles"], DONE: ["traitee", "terminee", "faite"], CANCELLED: ["annulee"] }) },
    { nom: "priorite", type: "choix", description: "Priorité.", source: col("AdministrativeRequest", "priority"), valeurs: choix(PRIORITY, { HIGH: ["urgente"] }) },
    { nom: "echeance", type: "date", description: "Date limite.", source: col("AdministrativeRequest", "deadline") },
    { nom: "demandeur", type: "texte", description: "Qui l'a faite.", source: col("User", "name") },
    { nom: "suivi", type: "texte", description: "Qui la traite.", source: col("User", "name"), alias: ["assignee", "responsable"] },
    { nom: "creeLe", type: "date", description: "Date de la demande.", source: col("AdministrativeRequest", "createdAt"), alias: ["date"] },
    LIEN("/demandes/<id>"),
  ],
  parDefaut: ["reference", "titre", "nature", "statut", "demandeur", "suivi", "creeLe"],
  portee: (u) => (userCan(u, "ADMIN_REQUESTS", "VIEW") ? scopeDemandes(u) : null),
  lire: async (_u, portee) => (await prisma.administrativeRequest.findMany({
    where: portee, orderBy: { createdAt: "desc" }, take: 2_000,
    select: { id: true, reference: true, title: true, subtype: true, status: true, priority: true, deadline: true, createdAt: true, requester: { select: { name: true } }, assignedTo: { select: { name: true } } },
  })).map((r) => ({
    id: r.id, reference: r.reference, titre: r.title, nature: r.subtype, statut: r.status, priorite: r.priority, echeance: ymd(r.deadline),
    demandeur: r.requester?.name ?? null, suivi: r.assignedTo?.name ?? null, creeLe: ymd(r.createdAt), lien: `/demandes/${r.id}`,
  })),
};

/** LE REGISTRE — l'ordre est celui du schéma exposé au modèle. */
export const VUES: readonly VueLisible<never>[] = [PRODUITS, ETABLISSEMENTS, MISSIONS, TACHES, DEMANDES] as unknown as VueLisible<never>[];

export const vueNommee = (nom: unknown): VueLisible<never> | null => {
  const n = String(nom ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return VUES.find((v) => v.nom === n || v.nom === `${n}s` || v.nom.replace(/s$/, "") === n) ?? null;
};
