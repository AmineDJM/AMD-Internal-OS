import { prisma } from "@/lib/prisma";
import { resolveRepScope } from "@/lib/sfe";
import type { SessionUser } from "@/lib/rbac";
import { GRILLE_PAR_DEFAUT, lireGrille, type GrilleCoaching } from "./grille";
import { peutAdministrerLeCoaching, peutCoacher, type LecteurCoaching } from "./acces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CÔTÉ SERVEUR DU COACHING (§118.157) — la grille courante, le périmètre d'une personne, les
 * collaborateurs qu'elle peut coacher. Les RÈGLES vivent dans les deux modules purs (`grille`,
 * `acces`) ; ce fichier ne fait que charger ce qu'il leur faut.
 *
 * Jamais importé par un composant client : il lit la base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface VersionGrille {
  id: string;
  version: number;
  grille: GrilleCoaching;
  note: string | null;
  createdAt: Date;
  auteur: string | null;
}

const ERREUR_UNICITE = "P2002";
const estCollisionDeVersion = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === ERREUR_UNICITE;

function versVersion(row: { id: string; version: number; content: unknown; note: string | null; createdAt: Date; createdBy: { name: string } | null }): VersionGrille | null {
  const grille = lireGrille(row.content);
  if (!grille) return null;
  return { id: row.id, version: row.version, grille, note: row.note, createdAt: row.createdAt, auteur: row.createdBy?.name ?? null };
}

const SELECT_VERSION = { id: true, version: true, content: true, note: true, createdAt: true, createdBy: { select: { name: true } } } as const;

/**
 * LA GRILLE EN VIGUEUR — la version la plus haute qui se LIT.
 *
 * Aucune version en base (premier usage) : la version 1 est écrite depuis `GRILLE_PAR_DEFAUT`,
 * le classeur fourni par la Direction. La semer à la lecture plutôt que dans la migration garde
 * UNE seule source pour son contenu (la constante du module pur). Deux premières lectures
 * simultanées se disputent la version 1 : l'unicité tranche, et la perdante relit.
 *
 * Une version illisible (JSON abîmé à la main) est SAUTÉE, jamais réparée en silence : la
 * précédente reste en vigueur, et l'écran de la grille le dit.
 */
export async function grilleCourante(): Promise<VersionGrille> {
  const recentes = await prisma.coachingGrid.findMany({ orderBy: { version: "desc" }, take: 5, select: SELECT_VERSION });
  for (const r of recentes) {
    const v = versVersion(r);
    if (v) return v;
  }
  if (recentes.length === 0) {
    try {
      const cree = await prisma.coachingGrid.create({
        data: { version: 1, content: GRILLE_PAR_DEFAUT as unknown as object, note: "Grille d'origine — classeur « Fiche_Coaching.xlsx » fourni par la Direction." },
        select: SELECT_VERSION,
      });
      return versVersion(cree)!;
    } catch (e) {
      if (!estCollisionDeVersion(e)) throw e;
      return grilleCourante();
    }
  }
  // Toutes les versions récentes sont illisibles : on ne fabrique pas une grille à la place de la
  // Direction — on sert l'origine, SANS l'écrire, et l'écran de la grille dira pourquoi.
  return { id: "", version: 0, grille: GRILLE_PAR_DEFAUT, note: null, createdAt: new Date(0), auteur: null };
}

/** L'historique des versions, de la plus récente à la plus ancienne — avec leur nombre de fiches. */
export async function historiqueDesGrilles(): Promise<(VersionGrille & { fiches: number })[]> {
  const rows = await prisma.coachingGrid.findMany({
    orderBy: { version: "desc" },
    take: 50,
    select: { ...SELECT_VERSION, _count: { select: { sheets: true } } },
  });
  return rows.flatMap((r) => {
    const v = versVersion(r);
    return v ? [{ ...v, fiches: r._count.sheets }] : [];
  });
}

/**
 * PUBLIER UNE VERSION — la suivante de la plus haute. Deux enregistrements simultanés se
 * disputent le même numéro : l'unicité tranche et la perdante reprend le suivant (quelques
 * essais — au-delà, la contention n'est plus une course, c'est un défaut à dire).
 */
export async function publierVersion(grille: GrilleCoaching, note: string | null, auteurId: string): Promise<VersionGrille> {
  for (let essai = 0; essai < 5; essai++) {
    const derniere = await prisma.coachingGrid.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    try {
      const cree = await prisma.coachingGrid.create({
        data: { version: (derniere?.version ?? 0) + 1, content: grille as unknown as object, note, createdById: auteurId },
        select: SELECT_VERSION,
      });
      return versVersion(cree)!;
    } catch (e) {
      if (!estCollisionDeVersion(e)) throw e;
    }
  }
  throw new Error("Plusieurs enregistrements simultanés de la grille : réessayez dans un instant.");
}

/**
 * LE LECTEUR — administrateur ou non, et son périmètre sur la force de vente.
 *
 * Le périmètre vient de `resolveRepScope` : la MÊME réponse que la force de vente et le plan de
 * tournée à « quels KAM sont les miens ? ».
 */
export async function lecteurCoaching(user: SessionUser & { secondaryRole?: SessionUser["secondaryRole"] }): Promise<LecteurCoaching> {
  const administre = peutAdministrerLeCoaching(user);
  if (administre) return { id: user.id, administre, perimetre: "TOUT" };
  const scope = await resolveRepScope(user);
  return {
    id: user.id,
    administre,
    // Un LECTEUR de pilotage (`lectureSeule`) lit toute la force de vente, mais ne coache personne : son périmètre de
    // coaching reste le sien, comme avant que la Force de vente ne lui ouvre la lecture.
    perimetre: scope.mode === "all" && !scope.lectureSeule ? "TOUT" : { collaborateurs: scope.repIds ?? [user.id] },
  };
}

export interface Collaborateur {
  id: string;
  nom: string;
  /** « Est, Centre — Région Est — BU Oncologie » : ce que la fiche pré-remplit dans « Secteur / Région / CDR ». */
  secteur: string;
}

/** Les rôles de la force de vente terrain — ceux qu'une tournée en double évalue. */
const ROLES_TERRAIN = ["MEDICAL_DELEGATE", "NATIONAL_SALES"] as const;

/**
 * LES COLLABORATEURS QU'ON PEUT COACHER — actifs, jamais soi-même.
 *
 * Tout le périmètre : les comptes qui ont une fiche force de vente OU un rôle terrain (un KAM
 * pas encore rattaché à une BU reste coachable). Un périmètre d'équipe : les KAM de ses BU.
 */
export async function collaborateursCoachables(l: LecteurCoaching): Promise<Collaborateur[]> {
  // La fiche force de vente ne porte pas de relation vers le compte (`repId` est une simple
  // colonne) : on la lit à part, et c'est elle qui dit la BU et la région.
  const profils = await prisma.salesRepProfile.findMany({
    select: { repId: true, region: true, businessUnit: { select: { name: true } } },
  });
  const profilDe = new Map(profils.map((p) => [p.repId, p]));
  const base = { isActive: true, id: { not: l.id } };
  const where = l.perimetre === "TOUT"
    ? {
      ...base,
      OR: [
        { id: { in: profils.map((p) => p.repId) } },
        { role: { in: [...ROLES_TERRAIN] } },
        { secondaryRole: { in: [...ROLES_TERRAIN] } },
      ],
    }
    : { AND: [base, { id: { in: [...l.perimetre.collaborateurs] } }] };
  const users = await prisma.user.findMany({
    where,
    orderBy: { name: "asc" },
    take: 500,
    select: {
      id: true, name: true, region: true,
      salesSectors: { where: { sector: { isActive: true } }, select: { sector: { select: { name: true } } } },
    },
  });
  return users.map((u) => {
    const profil = profilDe.get(u.id);
    return {
      id: u.id,
      nom: u.name,
      secteur: [
        u.salesSectors.map((s) => s.sector.name).join(", "),
        profil?.region ?? u.region ?? "",
        profil?.businessUnit?.name ? `BU ${profil.businessUnit.name}` : "",
      ].filter(Boolean).join(" — "),
    };
  });
}

/**
 * CE COLLABORATEUR PEUT-IL ÊTRE COACHÉ PAR CE LECTEUR ? — la même règle que la liste, pour UN
 * compte : actif, pas soi-même, dans le périmètre ; et, pour qui voit tout, un membre de la
 * force de vente terrain (fiche force de vente ou rôle terrain). Une tournée en double évalue une
 * visite médicale : l'ouvrir à n'importe quel compte ferait de la grille une évaluation de tout
 * le personnel, ce que personne n'a demandé.
 */
export async function peutCoacherLeCollaborateur(l: LecteurCoaching, id: string): Promise<boolean> {
  if (!peutCoacher(l, id)) return false;
  const u = await prisma.user.findUnique({ where: { id }, select: { isActive: true, role: true, secondaryRole: true } });
  if (!u?.isActive) return false;
  if (l.perimetre !== "TOUT") return true;
  const terrain = (r: string | null) => r !== null && (ROLES_TERRAIN as readonly string[]).includes(r);
  if (terrain(u.role) || terrain(u.secondaryRole)) return true;
  return (await prisma.salesRepProfile.count({ where: { repId: id } })) > 0;
}

/**
 * TOUTES LES CLÉS D'AXE JAMAIS EMPLOYÉES, toutes versions confondues. Un axe AJOUTÉ reçoit une
 * clé qui n'a jamais servi : réutiliser la clé d'un axe supprimé lui ferait hériter, dans la
 * synthèse, des notes d'un critère qui n'a rien à voir.
 */
export async function clesDejaEmployees(): Promise<Set<string>> {
  const rows = await prisma.coachingGrid.findMany({ select: { content: true } });
  const cles = new Set<string>();
  for (const r of rows) {
    const axes = (r.content as { axes?: { cle?: unknown }[] } | null)?.axes;
    if (Array.isArray(axes)) for (const a of axes) if (typeof a?.cle === "string") cles.add(a.cle);
  }
  return cles;
}

/** Les rôles qui mènent une tournée en double — l'encadrement de la force de vente et la direction. */
const ROLES_MANAGERS = ["NATIONAL_SALES", "MEDICAL_PROMOTION_MANAGER", "DIRECTION", "OPERATIONS_DIRECTOR", "GENERAL_MANAGER", "SUPER_ADMIN"] as const;

/**
 * LES MANAGERS QU'ON PEUT NOMMER sur une fiche — proposés à l'administration seulement (qui
 * recopie la fiche papier d'un superviseur). L'encadrement terrain, les superviseurs de BU, et
 * `inclure` (le manager déjà porté par la fiche, même s'il a changé de rôle depuis).
 */
export async function managersPossibles(inclure: readonly string[] = []): Promise<{ id: string; nom: string }[]> {
  const superviseurs = await prisma.businessUnit.findMany({ where: { supervisorId: { not: null } }, select: { supervisorId: true } });
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { isActive: true, role: { in: [...ROLES_MANAGERS] } },
        { isActive: true, secondaryRole: { in: [...ROLES_MANAGERS] } },
        { isActive: true, id: { in: superviseurs.map((s) => s.supervisorId!).filter(Boolean) } },
        { id: { in: [...inclure] } },
      ],
    },
    orderBy: { name: "asc" },
    take: 300,
    select: { id: true, name: true },
  });
  return users.map((u) => ({ id: u.id, nom: u.name }));
}
