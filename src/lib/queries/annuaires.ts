import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { scopeMedicalDoctors, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { companyScopedWhere, getMyCompanies, companyLabel } from "@/lib/company";
import { getAppSettings } from "@/lib/settings";
import { champSensible, masqueDepuisClair } from "@/modules/coffre/partage";
import { canonicalWilaya } from "@/lib/medical/wilaya";
import { cleCellule } from "@/lib/grille/couleurs";
import { ligneAnnuaire, type AnnuaireRow, type CustomColumnVue } from "@/lib/medical/directory-grid";
import { annuairesParSpecialite, clauseSpecialite, type AnnuaireSpecialite } from "@/lib/annuaires/par-specialite";
import { deduireEtablissement } from "@/lib/medical/etablissement-deduit";
import type { DirectoryRow, EtablissementRow, ContactRow, DirectoryPerson, EtablissementOption } from "@/lib/annuaires/types";

export type { EtablissementOption };

/**
 * ═══════════════════════════════════════════════════════════
 * LES CHARGEURS DES ANNUAIRES — une seule lecture par annuaire, pour deux écrans.
 *
 * Le module « Annuaires » (pôle Administration, décision de la Direction 09/2026) CENTRALISE ce
 * qui vivait dans trois modules : la feuille des praticiens (Promotion médicale), les
 * établissements (Promotion médicale), les partenaires et les personnes (Mon espace). Les pages
 * d'origine restent — un délégué corrige sa feuille sans passer par l'Administration — et le
 * concentrateur les redit sous un même toit.
 *
 * Deux écrans qui chargent SÉPARÉMENT le même annuaire divergent, toujours (§118.5) : la portée
 * d'un délégué, l'accès par annuaire nommé, le comptage dans la portée de la personne… chaque
 * règle recopiée est une règle qui prend du retard d'un côté. Ces chargeurs sont donc les SEULS
 * lecteurs, et les deux pages n'en font que l'affichage. Un test de point d'appel (§118.49)
 * exige que chaque page les importe.
 *
 * Ce module ne DÉCIDE aucun droit : il applique les portées canoniques (`scopeMedicalDoctors`,
 * `companyScopedWhere`, l'accès par annuaire) et c'est la page — `requireModule`, `userCan` —
 * qui ouvre ou ferme la porte.
 * ═══════════════════════════════════════════════════════════
 */

// ── LA FEUILLE DES PRATICIENS ───────────────────────────────────────────────────────────────

/**
 * QUI OUVRE UN ANNUAIRE NOMMÉ — la règle de la feuille, écrite UNE fois pour l'écran ET l'export.
 *
 * Elle vivait dans le chargeur seul, et l'EXPORT ne l'appliquait pas : la feuille cachait les
 * praticiens d'un annuaire fermé (« Infectiologues », réservé à trois personnes), le classeur
 * les sortait. Trouvé en branchant l'accès par annuaire sur cette route (§118.147) — une porte
 * gardée à côté d'une porte ouverte, et c'est la même chose qui passait (§118.71).
 */
export function ouvreAnnuaireNomme(user: SessionUser) {
  const privileged = user.role === "SUPER_ADMIN" || hasGlobalView(user.role);
  return (d: { createdById: string | null; access: { userId: string }[] }) =>
    privileged || d.access.length === 0 || d.createdById === user.id || d.access.some((a) => a.userId === user.id);
}

/** Les praticiens des annuaires NOMMÉS fermés à cette personne, en clause — l'export la lit. */
export async function clauseAnnuairesFermes(user: SessionUser): Promise<Prisma.MedicalDoctorWhereInput> {
  const annuaires = await prisma.medicalDirectory.findMany({
    select: { id: true, createdById: true, access: { select: { userId: true } } },
  });
  const ouvre = ouvreAnnuaireNomme(user);
  const fermes = annuaires.filter((d) => !ouvre(d)).map((d) => d.id);
  return fermes.length > 0 ? { OR: [{ directoryId: null }, { directoryId: { notIn: fermes } }] } : {};
}

/**
 * LES PRATICIENS QU'UNE PERSONNE VOIT DANS LA FEUILLE ENTIÈRE — la portée du module (ou l'annuaire
 * entier quand la console l'ouvre), dans l'entité, hors annuaires nommés fermés. Lue par l'EXPORT
 * et par la RECHERCHE GLOBALE : la palette ignorait les deux dernières clauses, et retrouvait les
 * praticiens des autres sociétés et ceux d'un annuaire réservé à trois personnes (§118.177).
 *
 * Les clauses se composent EN `AND` : la portée d'un délégué et l'exclusion des annuaires fermés
 * sont deux `OR`, et les étaler dans le même objet ferait écraser l'une par l'autre (§118.133).
 */
export async function clausePraticiensVisibles(
  user: SessionUser,
  opts: { entier: boolean },
): Promise<Prisma.MedicalDoctorWhereInput> {
  return {
    AND: [
      await companyScopedWhere(user.id, opts.entier ? {} : scopeMedicalDoctors(user)),
      await clauseAnnuairesFermes(user),
      // Une fiche ARCHIVÉE n'existe plus pour l'export ni la recherche (elle se restaure depuis l'annuaire).
      { archivedAt: null },
    ],
  };
}

/** Médecins = tout grade sauf PHARMACIEN ; pharmaciens = ce grade seul ; `null` = tous. */
export type FiltreGrade = "medecins" | "pharmaciens" | null;

/**
 * LES OPTIONS DE LA COLONNE « ÉTABLISSEMENT » — un référentiel, pas une portée (`page.tsx` des
 * établissements : `MedicalInstitution` n'a aucune fonction de portée, et les huit lecteurs du dépôt
 * l'interrogent sans clause). Les DÉSACTIVÉS sont rendus aussi : une fiche déjà rattachée à un
 * hôpital fermé doit pouvoir le montrer ; c'est la grille qui ne les PROPOSE plus.
 */
export async function chargerOptionsEtablissements(): Promise<EtablissementOption[]> {
  const etabs = await prisma.medicalInstitution.findMany({
    select: { id: true, name: true, wilaya: true, isActive: true, type: true, services: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  return etabs.map((e) => ({
    ...e,
    services: [...e.services].sort((a, b) => a.name.localeCompare(b.name, "fr")),
  }));
}

export interface FeuillePraticiens {
  rows: AnnuaireRow[];
  /** Les établissements que les colonnes « Établissement » et « Service » proposent. */
  etablissements: EtablissementOption[];
  couleurs: Record<string, string>;
  customColumns: CustomColumnVue[];
  specialties: string[];
  directories: DirectoryRow[];
  generalCount: number;
  openDirectoryId: string | null;
  /** Le libellé de l'annuaire ouvert, pour l'import (« « Infectiologues » », « l'annuaire général »). */
  directoryName: string;
  companies: { id: string; label: string }[];
  /** Les personnes désignables pour l'accès d'un annuaire — vides si la personne ne gère pas. */
  people: { id: string; name: string }[];
  /** UN ANNUAIRE PAR SPÉCIALITÉ : les spécialités qui comptent des praticiens dans la portée, avec leur compte. */
  annuairesSpecialite: AnnuaireSpecialite[];
  sansSpecialiteCount: number;
  /** La spécialité ouverte : un identifiant, `sans`, ou `null` (= tous). */
  specialiteOuverte: string | null;
  /** Vrai = la vue « Archivés » (les fiches archivées, restaurables). */
  archives: boolean;
  /** Combien de fiches archivées dans la portée — pour le lien « Archivés (n) ». */
  archivesCount: number;
}

export async function chargerFeuillePraticiens(
  user: SessionUser,
  opts: {
    annuaire?: string | null; grade?: FiltreGrade; canManage: boolean;
    /**
     * L'ANNUAIRE OUVERT PAR LA CONSOLE (§118.147) : il s'ouvre EN ENTIER — un référentiel, pas un
     * portefeuille. C'est la PAGE qui le dit (ce module ne décide aucun droit) ; absent = la
     * portée du module, celle d'un délégué qui ne voit que ses praticiens.
     */
    entier?: boolean;
    /** Une spécialité (identifiant ou `sans`) : « un annuaire par spécialité » pour les médecins. */
    specialite?: string | null;
    /** La vue des fiches ARCHIVÉES (suppression réversible). */
    archives?: boolean;
    /** Montrer aussi les spécialités sans médecin (pour qui gère le référentiel). */
    specialitesVides?: boolean;
  },
): Promise<FeuillePraticiens | null> {
  // L'annuaire ouvert : « general » = ceux qui ne sont rangés nulle part, un identifiant = cet
  // annuaire, absent = tous les praticiens du périmètre.
  const generalOnly = opts.annuaire === "general";
  const openDirectoryId = opts.annuaire && opts.annuaire !== "general" ? opts.annuaire : null;
  const directoryWhere = generalOnly ? { directoryId: null } : openDirectoryId ? { directoryId: openDirectoryId } : {};
  // LE GRADE : la Direction distingue médecins et pharmaciens ; c'est le même annuaire, filtré.
  const gradeWhere = opts.grade === "pharmaciens"
    ? { title: "PHARMACIEN" as const }
    : opts.grade === "medecins"
      ? { title: { not: "PHARMACIEN" as const } }
      : {};

  const scope = await companyScopedWhere(user.id, opts.entier ? {} : scopeMedicalDoctors(user));

  // L'ACCÈS PAR ANNUAIRE. Liste d'accès vide = ouvert à tout le module ; des noms = fermé à tous
  // les autres, hors vue globale. On tranche AVANT de charger les praticiens : un annuaire fermé
  // ne doit fuir ni par sa pastille, ni par ses praticiens dans la vue « Tous ».
  const allDirectories = await prisma.medicalDirectory.findMany({
    select: {
      id: true, name: true, companyId: true, createdById: true,
      company: { select: { name: true, shortName: true } },
      access: { select: { userId: true } },
    },
    orderBy: { name: "asc" },
  });
  const canOpenDirectory = ouvreAnnuaireNomme(user);
  const visibleDirectoryRows = allDirectories.filter(canOpenDirectory);
  const hiddenIds = allDirectories.filter((d) => !canOpenDirectory(d)).map((d) => d.id);
  // Ouvrir un annuaire fermé par son adresse ne marche pas plus que par sa pastille.
  if (openDirectoryId && !visibleDirectoryRows.some((d) => d.id === openDirectoryId)) return null;
  // La vue « Tous » exclut les praticiens des annuaires fermés — sans quoi la restriction ne
  // serait qu'une pastille masquée.
  const hiddenWhere = hiddenIds.length > 0 && !openDirectoryId && !generalOnly
    ? { OR: [{ directoryId: null }, { directoryId: { notIn: hiddenIds } }] }
    : {};

  // LES CLAUSES SE COMPOSENT EN `AND`, JAMAIS PAR ÉTALEMENT. La portée d'un délégué est un `OR`
  // (`{ OR: [{ delegateId }] }`) et l'exclusion des annuaires fermés en est un autre : étalées
  // dans le même objet, la seconde ÉCRASAIT la première — un délégué voyait TOUS les praticiens
  // dès qu'un annuaire fermé existait. Trouvé par le banc du chargeur avec un acteur sans vue
  // globale (§118.104) ; la page d'origine portait ce défaut depuis l'accès par annuaire.
  // ACTIVES par défaut ; la vue « Archivés » montre le reste. Un « supprimé » est un archivé.
  const archives = opts.archives === true;
  const archiveWhere = archives ? { archivedAt: { not: null } } : { archivedAt: null };
  const specialiteOuverte = opts.specialite || null;
  const specialiteWhere = clauseSpecialite(specialiteOuverte);
  const whereFeuille = { AND: [scope, directoryWhere, hiddenWhere, gradeWhere, specialiteWhere, archiveWhere] };

  const [doctors, specialtyRefs, directoryCounts, generalCount, myCompanies, colonnesSurMesure, people, etablissements, parSpecialite, archivesCount] = await Promise.all([
    prisma.medicalDoctor.findMany({
      where: whereFeuille,
      orderBy: [{ name: "asc" }],
      include: {
        specialtyRef: { select: { name: true } },
        // L'établissement et le service RATTACHÉS (§118.172) — leurs noms font foi à l'affichage.
        institutionRef: { select: { name: true } },
        serviceRef: { select: { name: true } },
        // Les couleurs de la feuille voyagent avec les lignes : une requête, pas une par cellule.
        cellStyles: { select: { field: true, color: true } },
      },
    }),
    prisma.medicalSpecialty.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Les comptes se calculent DANS LA PORTÉE de la personne : afficher « 300 » à un délégué qui
    // n'en voit que douze donnerait un chiffre faux et ferait croire à un problème d'accès.
    // Les fiches archivées ne comptent pas (elles ont leur propre compteur).
    prisma.medicalDoctor.groupBy({ by: ["directoryId"], where: { AND: [scope, gradeWhere, { archivedAt: null }, { directoryId: { not: null } }] }, _count: { _all: true } }),
    prisma.medicalDoctor.count({ where: { AND: [scope, gradeWhere, { archivedAt: null }, { directoryId: null }] } }),
    getMyCompanies(user.id),
    // LES COLONNES PROPRES à l'annuaire ouvert. Elles existaient en base sans aucun écran
    // (§118.14) : la feuille les affiche et les édite désormais, à côté du tronc commun.
    openDirectoryId
      ? prisma.medicalDirectoryColumn.findMany({
          where: { directoryId: openDirectoryId },
          orderBy: { position: "asc" },
          select: { id: true, key: true, label: true, kind: true, options: true },
        })
      : Promise.resolve([]),
    opts.canManage
      ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
    chargerOptionsEtablissements(),
    // UN ANNUAIRE PAR SPÉCIALITÉ : même portée, mêmes annuaires fermés exclus, fiches actives.
    prisma.medicalDoctor.groupBy({
      by: ["specialtyId"], where: { AND: [scope, gradeWhere, hiddenWhere, { archivedAt: null }] }, _count: { _all: true },
    }),
    prisma.medicalDoctor.count({ where: { AND: [scope, gradeWhere, hiddenWhere, { archivedAt: { not: null } }] } }),
  ]);
  const { specialites: annuairesSpecialite, sansSpecialite: sansSpecialiteCount } = annuairesParSpecialite(
    parSpecialite.map((g) => ({ specialtyId: g.specialtyId, count: g._count._all })),
    specialtyRefs,
    opts.specialitesVides === true,
  );

  const countByDirectory = new Map(directoryCounts.map((c) => [c.directoryId as string, c._count._all]));
  const directories: DirectoryRow[] = visibleDirectoryRows.map((d) => ({
    id: d.id, name: d.name, companyId: d.companyId,
    companyLabel: d.company ? d.company.shortName ?? d.company.name : null,
    doctorCount: countByDirectory.get(d.id) ?? 0,
    accessUserIds: d.access.map((a) => a.userId),
  }));

  const couleurs: Record<string, string> = {};
  for (const d of doctors) for (const s of d.cellStyles) couleurs[cleCellule(d.id, s.field)] = s.color;
  const customColumns: CustomColumnVue[] = colonnesSurMesure.map((c) => ({
    id: c.id, key: c.key, label: c.label,
    kind: (["TEXT", "NUMBER", "DATE", "CHOICE"].includes(c.kind) ? c.kind : "TEXT") as CustomColumnVue["kind"],
    options: (c.options ?? "").split("|").map((o) => o.trim()).filter(Boolean),
  }));

  // UNE seule traduction de la fiche en ligne, partagée avec l'export (`ligneAnnuaire`).
  const rows: AnnuaireRow[] = doctors.map(ligneAnnuaire);
  // L'ÉTABLISSEMENT DÉDUIT (Direction, 06/10) — la même règle que le rattachement automatique : la feuille dit, pour
  // chaque fiche sans établissement, s'il est sûr (le geste le posera) ou à trancher (candidats proposés en tête).
  for (const r of rows) {
    if (r.institutionId || r.institution?.trim()) continue; // un texte sans lien se rattache par son nom
    const d = deduireEtablissement({ wilaya: r.wilaya, specialite: r.specialty }, etablissements);
    if (d.statut === "unique") r.deduction = { statut: "unique", candidats: [d.institutionId], raison: d.raison };
    else if (d.statut === "a_trancher") r.deduction = { statut: "a_trancher", candidats: d.candidats, raison: d.raison };
  }

  // Saisie assistée de la spécialité : le référentiel structuré ET les libellés déjà employés.
  const specialties = [...new Set([
    ...specialtyRefs.map((s) => s.name),
    ...rows.map((r) => r.specialty).filter((s): s is string => Boolean(s)),
  ])].sort((a, b) => a.localeCompare(b, "fr"));

  return {
    rows, etablissements, couleurs, customColumns, specialties, directories, generalCount, openDirectoryId,
    directoryName: openDirectoryId
      ? `« ${visibleDirectoryRows.find((d) => d.id === openDirectoryId)?.name ?? "cet annuaire"} »`
      : "l'annuaire général",
    companies: myCompanies.map((c) => ({ id: c.id, label: companyLabel(c) })),
    people,
    annuairesSpecialite, sansSpecialiteCount, specialiteOuverte, archives, archivesCount,
  };
}

// ── LES ÉTABLISSEMENTS ─────────────────────────────────────────────────────────────────────

export interface FeuilleEtablissements {
  rows: EtablissementRow[];
  couleurs: Record<string, string>;
}

/**
 * `MedicalInstitution` n'a AUCUNE fonction de portée : c'est un référentiel, comme les
 * spécialités. Ce qui EST cloisonné, ce sont les PRATICIENS — le compte affiché par établissement
 * se calcule donc dans la portée de la personne (`scopeMedicalDoctors`).
 */
export async function chargerEtablissements(
  user: SessionUser,
  opts: {
    /**
     * COMPTER LES PRATICIENS EN ENTIER (§118.147). Quelqu'un à qui la console n'a ouvert que les
     * établissements n'a AUCUN praticien dans sa portée de module : compter dans cette portée lui
     * afficherait « 0 » partout — et surtout ne l'avertirait pas, au moment de supprimer un CHU,
     * que quarante praticiens y sont rattachés. Un nombre n'est pas une identité : le compte
     * entier ne lui montre aucun praticien.
     */
    compteEntier?: boolean;
  } = {},
): Promise<FeuilleEtablissements> {
  const portee = opts.compteEntier ? {} : scopeMedicalDoctors(user);
  const [institutions, doctorCounts, sectorCounts, doctorsParService, secteursParService] = await Promise.all([
    prisma.medicalInstitution.findMany({
      orderBy: [{ name: "asc" }],
      include: {
        cellStyles: { select: { field: true, color: true } },
        // SES SERVICES (§118.172) — une requête pour tout l'écran, pas une par ligne.
        services: { select: { id: true, name: true } },
      },
    }),
    prisma.medicalDoctor.groupBy({
      by: ["institutionId"],
      where: { ...portee, institutionId: { not: null } },
      _count: { _all: true },
    }),
    // DANS COMBIEN DE SECTEURS COMMERCIAUX il entre : c'est ce que la suppression ampute.
    prisma.salesSectorInstitution.groupBy({ by: ["institutionId"], _count: { _all: true } }),
    // Ce que chaque SERVICE porte : ses praticiens (même portée que l'établissement) et les
    // secteurs qui le choisissent nommément — ce que sa suppression emporte, dit avant le clic.
    prisma.medicalDoctor.groupBy({
      by: ["serviceId"],
      where: { ...portee, serviceId: { not: null } },
      _count: { _all: true },
    }),
    prisma.salesSectorInstitutionService.groupBy({ by: ["serviceId"], _count: { _all: true } }),
  ]);
  const parDoctor = new Map(doctorCounts.map((c) => [c.institutionId as string, c._count._all]));
  const parSecteur = new Map(sectorCounts.map((c) => [c.institutionId, c._count._all]));
  const doctorsDuService = new Map(doctorsParService.map((c) => [c.serviceId as string, c._count._all]));
  const secteursDuService = new Map(secteursParService.map((c) => [c.serviceId, c._count._all]));
  const couleurs: Record<string, string> = {};
  for (const i of institutions) for (const s of i.cellStyles) couleurs[cleCellule(i.id, s.field)] = s.color;
  const rows: EtablissementRow[] = institutions.map((i) => ({
    id: i.id,
    name: i.name,
    type: String(i.type),
    sector: String(i.sector),
    // Une wilaya héritée en texte libre (« ALGER ») est montrée sous son nom officiel quand il
    // se reconnaît ; sinon telle quelle — le formulaire la signale et demande de choisir.
    wilaya: i.wilaya ? canonicalWilaya(i.wilaya) ?? i.wilaya : null,
    region: i.region,
    address: i.address,
    phone: i.phone,
    email: i.email,
    notes: i.notes,
    isActive: i.isActive,
    doctorCount: parDoctor.get(i.id) ?? 0,
    sectorCount: parSecteur.get(i.id) ?? 0,
    services: i.services
      .map((s) => ({ id: s.id, name: s.name, doctorCount: doctorsDuService.get(s.id) ?? 0, sectorCount: secteursDuService.get(s.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr")),
  }));
  return { rows, couleurs };
}

// ── LES PARTENAIRES ET LES PERSONNES ───────────────────────────────────────────────────────

export interface AnnuairePartenaires {
  contacts: ContactRow[];
  companies: { id: string; label: string }[];
}

/** Les contacts EXTERNES de la société — agence, livreur, transitaire —, dans le périmètre d'entité. */
export async function chargerPartenaires(user: SessionUser, sphere: "PRIVE" | "PUBLIC" = "PRIVE"): Promise<AnnuairePartenaires> {
  const [contacts, myCompanies, reglages] = await Promise.all([
    prisma.companyContact.findMany({
      // LA SPHÈRE fait l'annuaire : « Partenaires » (prestataires) ou « Partenaires publics » (Direction, 06/10).
      where: { AND: [await companyScopedWhere(user.id, {}), { sphere }] },
      include: { company: { select: { name: true, shortName: true } } },
      orderBy: [{ name: "asc" }],
    }),
    getMyCompanies(user.id),
    getAppSettings(),
  ]);
  // LE COFFRE (refonte V2-E) : en double lecture, la liste n'emporte que le MASQUE du RIB — rien n'est lu, rien
  // n'est journalisé ; le RIB en clair se lit là où il sert (bon de commande, ordre de virement). Renvoyé tel quel
  // par la boîte d'édition, le masque garde la valeur en place (`champsNonSaisis`) ; une saisie la remplace.
  const champRib = champSensible("CompanyContact", "rib")!;
  const rib = (v: string | null) => (reglages.coffreLecture ? masqueDepuisClair(champRib, v) : v);
  return {
    contacts: contacts.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, contactName: c.contactName,
      phone: c.phone, phoneAlt: c.phoneAlt, email: c.email, website: c.website,
      address: c.address, city: c.city, wilaya: c.wilaya,
      rc: c.rc, nif: c.nif, rib: rib(c.rib), notes: c.notes,
      isActive: c.isActive, companyId: c.companyId,
      companyLabel: c.company ? c.company.shortName ?? c.company.name : null,
    })),
    companies: myCompanies.map((c) => ({ id: c.id, label: companyLabel(c) })),
  };
}

/**
 * LES PERSONNES — lues depuis le registre RH, qui reste la source de leur identité. L'annuaire
 * n'ajoute que les moyens de les joindre.
 */
export async function chargerPersonnes(): Promise<DirectoryPerson[]> {
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    orderBy: { fullName: "asc" },
    select: {
      id: true, fullName: true, position: true, department: true, userId: true,
      email: true, phone: true,
      company: { select: { name: true, shortName: true } },
      user: { select: { email: true } },
      directoryEntry: {
        select: {
          id: true, aliases: true, location: true, notes: true,
          endpoints: {
            where: { isActive: true },
            orderBy: [{ isPrimary: "desc" }, { channel: "asc" }],
            select: { id: true, channel: true, value: true, label: true, confidence: true, isPrimary: true },
          },
        },
      },
    },
  });
  return employees.map((e) => {
    const endpoints = e.directoryEntry?.endpoints ?? [];
    const inDirectory = new Set(endpoints.map((p) => p.value.toLowerCase()));
    // Les adresses des fiches ERP ne sont montrées que si l'annuaire ne les porte pas déjà :
    // afficher deux fois la même adresse ferait douter qu'il s'agisse de la même.
    const erpEmails = [e.email, e.user?.email]
      .filter((m): m is string => Boolean(m))
      .map((m) => m.toLowerCase())
      .filter((m, i, all) => all.indexOf(m) === i && !inDirectory.has(m));
    return {
      key: e.id,
      name: e.fullName,
      jobTitle: e.position,
      department: e.department,
      company: e.company?.shortName ?? e.company?.name ?? null,
      userId: e.userId,
      employeeId: e.id,
      entryId: e.directoryEntry?.id ?? null,
      aliases: e.directoryEntry?.aliases ?? [],
      location: e.directoryEntry?.location ?? null,
      notes: e.directoryEntry?.notes ?? null,
      endpoints: endpoints.map((p) => ({
        id: p.id, channel: p.channel, value: p.value, label: p.label,
        confidence: p.confidence, isPrimary: p.isPrimary,
      })),
      erpEmails,
    };
  });
}


