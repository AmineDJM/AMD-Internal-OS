import type { AssistantRoleConfig, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { getAccess, userCan } from "@/lib/rbac";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import type { Module } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { controlerLecture, journaliserLectureHorsColonne, lecteurDepuisSession, peutLire } from "@/modules/coffre/api";
import { borner, MASQUE_CONFIDENTIEL, remplacerReperes, reperesDe, type CoffretDuTour, type EntreeJeton } from "../domaine/filtre-confidentialite";
import {
  appliquerBases, estFamilleIa, familleOuverte, perimetreCouvrant, LIBELLE_FAMILLE, normaliserReglageFamilles, resoudreAccesIa, type AccesIa, type FamilleIa, type ReglageFamilles,
} from "../domaine/acces-regles";
import { famillesParBase } from "@/modules/acces-bases/api";
import { roleSuperAdmin } from "../domaine/profil-acces";
import { modeValeursSensibles, type ModeValeursSensibles } from "../domaine/consommation-regles";
import {
  contratEnVigueur, LIBELLE_ORIGINE, perimetreEnVigueur, perimetresDesAvenants, type AvenantLu, type PerimetreSensible,
} from "../domaine/perimetres";

/**
 * CONFIGURATION DE L'ASSISTANT PAR RÔLE — Jalon 4 (Décisions Q4 & Q12).
 *
 * Permet au Super Admin de personnaliser le comportement de l'assistant selon le rôle :
 * 1. Nom personnalisé et ton (ex. formel, pédagogique, direct)
 * 2. Consignes spécifiques (≤ 2 000 caractères)
 * 3. Outils autorisés — RESTRICTION SEULEMENT (le RBAC reste le plafond indépassable)
 * 4. Niveau de confirmation ("CRITIQUE" ou "TOUJOURS")
 * 5. Modèle imposé optionnel
 *
 * Toute modification est obligatoirement tracée (AssistantRoleConfigAudit).
 */

export interface SauvegarderRoleConfigEntree {
  role: UserRole;
  assistantName?: string | null;
  tone?: string | null;
  customInstructions?: string | null;
  allowedTools?: string[];
  confirmationLevel?: "CRITIQUE" | "TOUJOURS";
  enforcedModel?: string | null;
}

export interface ResultatSauvegardeConfig {
  ok: boolean;
  error?: string;
  config?: AssistantRoleConfig;
}

/**
 * Récupère la configuration personnalisée d'un rôle.
 */
export async function getRoleConfig(role: UserRole): Promise<AssistantRoleConfig | null> {
  try {
    return await prisma.assistantRoleConfig.findUnique({
      where: { role },
    });
  } catch {
    return null;
  }
}

/**
 * Sauvegarde ou met à jour la configuration d'un rôle avec traçabilité complète.
 */
export async function sauvegarderRoleConfig(
  entree: SauvegarderRoleConfigEntree,
  acteur: CurrentUser
): Promise<ResultatSauvegardeConfig> {
  // 1. Contrôle des droits : Super Admin ou droit de modification ADMIN
  if (!roleSuperAdmin(acteur) && !userCan(acteur, "ADMIN" as never, "UPDATE")) {
    return {
      ok: false,
      error: "Seul un administrateur peut modifier la configuration de l'assistant par rôle.",
    };
  }

  // 2. Validation des consignes (≤ 2 000 caractères)
  if (entree.customInstructions && entree.customInstructions.length > 2000) {
    return {
      ok: false,
      error: "Les consignes personnalisées ne doivent pas dépasser 2 000 caractères.",
    };
  }

  try {
    // 3. Récupération de l'ancienne configuration pour l'audit
    const ancienneConfig = await prisma.assistantRoleConfig.findUnique({
      where: { role: entree.role },
    });

    // 4. Upsert de la configuration
    const nouvelleConfig = await prisma.assistantRoleConfig.upsert({
      where: { role: entree.role },
      create: {
        role: entree.role,
        assistantName: entree.assistantName?.trim() || null,
        tone: entree.tone?.trim() || null,
        customInstructions: entree.customInstructions?.trim() || null,
        allowedTools: entree.allowedTools ?? [],
        confirmationLevel: entree.confirmationLevel ?? "CRITIQUE",
        enforcedModel: entree.enforcedModel?.trim() || null,
        updatedById: acteur.id,
      },
      update: {
        assistantName: entree.assistantName?.trim() || null,
        tone: entree.tone?.trim() || null,
        customInstructions: entree.customInstructions?.trim() || null,
        allowedTools: entree.allowedTools ?? [],
        confirmationLevel: entree.confirmationLevel ?? "CRITIQUE",
        enforcedModel: entree.enforcedModel?.trim() || null,
        updatedById: acteur.id,
      },
    });

    // 5. Enregistrement de l'audit (qui, quand, ancienne valeur, nouvelle valeur)
    await prisma.assistantRoleConfigAudit.create({
      data: {
        role: entree.role,
        actorId: acteur.id,
        previousData: ancienneConfig ? JSON.parse(JSON.stringify(ancienneConfig)) : undefined,
        newData: JSON.parse(JSON.stringify(nouvelleConfig)),
      },
    });

    return { ok: true, config: nouvelleConfig };
  } catch (err) {
    return {
      ok: false,
      error: `Erreur lors de l'enregistrement : ${err instanceof Error ? err.message : "inconnue"}`,
    };
  }
}

/**
 * Applique la restriction d'outils par rôle.
 *
 * Le RBAC reste le plafond : un outil interdit par le RBAC n'est JAMAIS accordé.
 * Si une restriction est définie pour le rôle, seuls les outils listés et autorisés par le RBAC sont gardés.
 */
export function filtrerOutilsParRole(
  outilsPermisParRbac: PowerTool[],
  config: { allowedTools?: string[] } | null | undefined
): PowerTool[] {
  if (!config?.allowedTools || config.allowedTools.length === 0) {
    return outilsPermisParRbac;
  }

  const autorises = new Set(config.allowedTools);
  return outilsPermisParRbac.filter((o) => autorises.has(o.def.name));
}

/**
 * Résout le texte des consignes du rôle à injecter dans le contexte.
 */
export function resoudreConsignesRole(config: AssistantRoleConfig | null | undefined): string | undefined {
  if (!config) return undefined;

  const parties: string[] = [];
  if (config.assistantName) {
    parties.push(`Ton nom d'assistant pour ce profil est : ${config.assistantName}.`);
  }
  if (config.tone) {
    parties.push(`Ton de communication attendu : ${config.tone}.`);
  }
  if (config.customInstructions) {
    parties.push(config.customInstructions);
  }

  return parties.length > 0 ? parties.join("\n") : undefined;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACCÈS DE L'ASSISTANT IA D'UNE PERSONNE (décision 0012) — relus À CHAQUE TOUR, sans cache : un
 * réglage changé dans la console vaut dès la demande suivante. Les droits applicatifs posent le défaut de
 * chaque famille (la règle est dans `acces-regles.ts`, pure) ; le réglage du rôle, puis celui de la
 * personne, ouvrent ou ferment.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function droitsApplicatifsIa(user: CurrentUser): Record<FamilleIa, boolean> {
  const voit = (...modules: string[]) => modules.some((m) => userCan(user, m as never, "VIEW"));
  return {
    SALAIRES: voitLesSalaires(user),
    CONTRATS_RH: voitLesSalaires(user),
    FICHES: voit("RH"),
    BUDGETS: voit("BUDGETS", "FINANCES"),
    DRIVE: voit("DRIVE", "DOCUMENTS"),
    REGLEMENTAIRE: voit("REGULATORY", "REGULATORY_PIPELINE"),
    AD_PRO: voit("SPONSORING", "AD_PRO_CENTRE", "EVENTS", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"),
    ECRITURES: true,
    // K2 (décision 0032) : aucun écran ne l'ouvre — payante, elle reste fermée tant que la Direction ne l'ouvre pas.
    VISUELS: false,
  };
}

/** L'accès par défaut (sans réglage lu) : droits applicatifs, familles sensibles fermées. Un tour passe toujours le réglage relu. */
export const accesParDefaut = (user: CurrentUser): AccesIa =>
  resoudreAccesIa({ superAdmin: roleSuperAdmin(user), droits: droitsApplicatifsIa(user) });

export async function accesAssistantIa(user: CurrentUser): Promise<AccesIa> {
  // S1 (décision 0048) : une identité VUE (Vue exacte) n'a pas d'assistant — et donc aucun accès (échec fermé).
  if (user.impersonatedBy || user.visualise) return { superAdmin: false, ouvertes: [], explicites: [], perimetres: [] };
  // D5 (décision 0057) : l'accès par base par-dessus les familles — sous l'application stricte seulement (sinon nul).
  const bases = famillesParBase({ userId: user.id, roles: [user.role, user.secondaryRole] });
  if (roleSuperAdmin(user)) return appliquerBases(resoudreAccesIa({ superAdmin: true, droits: droitsApplicatifsIa(user) }), bases);
  const [lignes, perimetres] = await Promise.all([
    prisma.assistantIaAcces.findMany({ where: { OR: [{ userId: user.id }, { role: user.role as UserRole }] } }),
    perimetresNominatifs(user.id),
  ]);
  const reglage = (l?: { ouvertes: string[]; fermees: string[] }) => (l ? normaliserReglageFamilles(l.ouvertes, l.fermees) : null);
  const personne = reglage(lignes.find((l) => l.userId === user.id));
  return appliquerBases(resoudreAccesIa({
    superAdmin: false,
    droits: droitsApplicatifsIa(user),
    role: reglage(lignes.find((l) => l.role === user.role && !l.userId)),
    personne,
    perimetres,
  }), bases, personne?.fermees ?? []);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** La fiche RH LIÉE au compte (jamais devinée par le nom : un lien manquant n'ouvre que moins) et ses avenants. */
export async function ficheEtAvenantsDe(userId: string) {
  const fiche = await prisma.employee.findUnique({
    where: { userId },
    select: {
      id: true, fullName: true, position: true, isActive: true, companyId: true, contractType: true, contractStart: true, contractEnd: true, hireDate: true,
      departmentRef: { select: { name: true } }, department: true, manager: { select: { fullName: true } },
      company: { select: { shortName: true, name: true } },
      avenants: { where: { revoqueLe: null }, orderBy: { effetLe: "desc" }, take: 20 },
    },
  });
  if (!fiche) return null;
  const avenants: AvenantLu[] = fiche.avenants.map((a) => ({
    id: a.id, objet: a.objet, fonction: a.fonction, famille: a.famille, companyId: a.companyId,
    effetLe: a.effetLe.toISOString(), finLe: iso(a.finLe), motif: a.motif, revoqueLe: iso(a.revoqueLe),
  }));
  return { ...fiche, avenants, contratValide: contratEnVigueur({ isActive: fiche.isActive, contractEnd: fiche.contractEnd }) };
}

/**
 * S1 : les PÉRIMÈTRES NOMINATIFS de la personne — les délégations de SES avenants (contrat en vigueur) et SES droits
 * datés de la console (famille sensible connue, non révoqués). Rien d'un rôle, rien d'une autre personne.
 */
export async function perimetresNominatifs(userId: string, maintenant = new Date()): Promise<PerimetreSensible[]> {
  const [fiche, droits] = await Promise.all([
    ficheEtAvenantsDe(userId),
    prisma.assistantIaDroitDate.findMany({ where: { userId, revoqueLe: null } }),
  ]);
  const parAvenant = fiche ? perimetresDesAvenants(fiche.avenants, fiche.contratValide, estFamilleIa, maintenant) : [];
  const parConsole: PerimetreSensible[] = droits
    .filter((d) => estFamilleIa(d.famille))
    .map((d) => ({ famille: d.famille as FamilleIa, companyId: d.companyId, du: d.du.toISOString(), au: iso(d.au), origine: "CONSOLE" as const, ref: d.id, motif: d.motif }))
    .filter((p) => perimetreEnVigueur(p, maintenant));
  return [...parAvenant, ...parConsole];
}

/**
 * CE QUE LA CONSOLE MONTRE (`/admin/ai/acces`) : les réglages par rôle, et chaque personne active (hors Super Admin)
 * avec ses droits applicatifs par famille, le réglage de son rôle et le sien — l'écran recalcule l'accès effectif
 * avec la même règle pure que le moteur (`resoudreAccesIa`).
 */
export async function chargerConsoleAccesIa(): Promise<{
  parRole: Map<UserRole, ReglageFamilles>;
  personnes: {
    id: string; nom: string; email: string; role: UserRole; droits: Record<FamilleIa, boolean>; reglageRole: ReglageFamilles; reglage: ReglageFamilles;
    /** J2 : les plafonds de dépense propres à la personne (`null` = le défaut). */
    plafonds: { travailUsd: number | null; mensuelUsd: number | null };
  }[];
  /** J2 : les plafonds par défaut des travaux. */
  plafondsGlobaux: { travailUsd: number; mensuelUsd: number };
  /** J8 : un responsable voit-il les travaux de son équipe ? (défaut : non) */
  managerVoitEquipe: boolean;
  /** J7 : durée de garde du journal des effets, en jours (défaut 180). */
  retentionEffetsJours: number;
  /** K10b (décision 0040) : la fenêtre d'annulation des envois, en secondes (défaut 120). */
  fenetreAnnulationSecondes: number;
  /** K3 (décision 0033) : « démarrer d'office les travaux sans geste », par rôle (`null` = le défaut : non). */
  dOfficeParRole: Map<UserRole, boolean | null>;
  /** Décision 0034 : les valeurs sensibles vont au modèle en clair (défaut) ou en repères. */
  valeursSensibles: ModeValeursSensibles;
}> {
  const [reglages, comptes, global] = await Promise.all([
    prisma.assistantIaAcces.findMany(),
    prisma.user.findMany({ where: { isActive: true, role: { not: "SUPER_ADMIN" } }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: "asc" } }),
    prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { plafondTravailUsd: true, plafondMensuelUsd: true, managerVoitEquipe: true, retentionEffetsJours: true, fenetreAnnulationSecondes: true, valeursSensibles: true } }),
  ]);
  const plafondsPersonne = new Map(reglages.filter((r) => r.userId).map((r) => [r.userId!, { travailUsd: r.plafondTravailUsd, mensuelUsd: r.plafondMensuelUsd }]));
  const vide: ReglageFamilles = { ouvertes: [], fermees: [] };
  const parRole = new Map(reglages.filter((r) => r.role && !r.userId).map((r) => [r.role!, normaliserReglageFamilles(r.ouvertes, r.fermees)]));
  const parPersonne = new Map(reglages.filter((r) => r.userId).map((r) => [r.userId!, normaliserReglageFamilles(r.ouvertes, r.fermees)]));
  const personnes = await Promise.all(comptes.map(async (c) => {
    const access = await getAccess(c.id, c.role);
    const session = { id: c.id, name: c.name, email: c.email, role: access.role ?? c.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    return {
      id: c.id, nom: c.name, email: c.email, role: c.role, droits: droitsApplicatifsIa(session),
      reglageRole: parRole.get(c.role) ?? vide, reglage: parPersonne.get(c.id) ?? vide,
      plafonds: plafondsPersonne.get(c.id) ?? { travailUsd: null, mensuelUsd: null },
    };
  }));
  return {
    parRole, personnes, plafondsGlobaux: { travailUsd: global?.plafondTravailUsd ?? 20, mensuelUsd: global?.plafondMensuelUsd ?? 50 },
    managerVoitEquipe: global?.managerVoitEquipe === true,
    retentionEffetsJours: global?.retentionEffetsJours ?? 180,
    fenetreAnnulationSecondes: global?.fenetreAnnulationSecondes ?? 120,
    dOfficeParRole: new Map(reglages.filter((r) => r.role && !r.userId).map((r) => [r.role!, r.travauxDOffice])),
    valeursSensibles: modeValeursSensibles(global?.valeursSensibles),
  };
}

/**
 * LA VUE DE L'ASSISTANT SUR L'APPLICATION (décision 0012, Direction 29/10/2026 : « droit applicatif OU ouverture
 * explicite console ») — la personne, avec en plus, en LECTURE, les modules des familles que la Direction lui a
 * ouvertes explicitement. Les lectures du moteur (`allowed`, requêtes des écrans) jugent sur cette vue ; les
 * ÉCRITURES, elles, s'exécutent toujours sous la vraie session (l'action de l'écran relit `requireUser`).
 * Ce qui reste au-delà : le partage nœud par nœud du Drive, l'étanchéité des sociétés.
 */
const MODULES_DE_FAMILLE: Partial<Record<FamilleIa, Module[]>> = {
  FICHES: ["RH"],
  BUDGETS: ["BUDGETS", "FINANCES"],
  DRIVE: ["DRIVE", "DOCUMENTS"],
  REGLEMENTAIRE: ["REGULATORY", "REGULATORY_PIPELINE"],
  AD_PRO: ["SPONSORING", "AD_PRO_CENTRE", "EVENTS", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"],
};

export function vueDeLAssistant(user: CurrentUser, acces: AccesIa): CurrentUser {
  if (acces.superAdmin) return user;
  const ajouts = acces.explicites.flatMap((f) => MODULES_DE_FAMILLE[f] ?? []).filter((m) => !userCan(user, m, "VIEW"));
  if (!ajouts.length) return user;
  const modules = new Map(user.access.modules);
  for (const m of ajouts) {
    const deja = modules.get(m);
    modules.set(m, deja ? { ...deja, actions: new Set([...deja.actions, "VIEW"]) } : { actions: new Set(["VIEW"]), scope: "ALL" });
  }
  return { ...user, access: { ...user.access, modules, ...(ajouts.includes("REGULATORY_PIPELINE") ? { pipelineView: true } : {}) } };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉVÉLATION — le serveur remplace les repères (`⟦S1⟧`) par les vraies valeurs, AVANT d'afficher et de stocker
 * la réponse, d'afficher une carte ou d'exécuter un geste — et seulement pour qui a le droit de les voir.
 *
 * La règle est CELLE DU COFFRE (`peutLire`, porte `@/modules/coffre/api`) : le Super Admin voit tout ; la personne
 * voit les siennes ; qui tient les RH voit salaires et identité ; qui tient les Finances, RIB et IBAN — sous la
 * famille « Salaires & paie » (fermée par défaut) pour un salaire, que l'ouverture EXPLICITE de la Direction étend
 * au-delà de la politique (tracé à l'audit). Une valeur d'une COLONNE du coffre passe par `controlerLecture`, qui
 * journalise ; une valeur HORS colonne (historique de paie, montant d'un contrat, IBAN lu dans un document) est
 * journalisée aussi (`journaliserLectureHorsColonne` : qui, quoi, quand, par quel outil). Rien n'est déchiffré : la
 * valeur est celle que l'outil a lue — `api-lecture` reste hors d'atteinte de l'assistant (`frontiere.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const GESTE_ASSISTANT = "Assistant IA — réponse à la personne";
/** Décision 0034 : la valeur part au modèle, en clair, parce que la personne a le droit de la voir — le journal le dit. */
export const GESTE_MODELE_EN_CLAIR = "Assistant IA — valeur transmise au modèle (mode en clair)";
/** K7 (décision 0037) : une valeur écrite dans un FICHIER exporté (Drive de la personne) — même juge que l'écran, journalisée. */
export const GESTE_EXPORT_FICHIER = "Assistant IA — valeur écrite dans un fichier exporté";

/** L'entité de la fiche du titulaire d'une valeur (le périmètre d'un avenant se juge par entité). `null` : inconnue. */
async function entiteDuTitulaire(e: EntreeJeton): Promise<string | null> {
  if (e.origine?.modele === "Employee") {
    return (await prisma.employee.findUnique({ where: { id: e.origine.id }, select: { companyId: true } }))?.companyId ?? null;
  }
  if (e.titulaireUserId) return (await prisma.employee.findFirst({ where: { userId: e.titulaireUserId }, select: { companyId: true } }))?.companyId ?? null;
  return null;
}

export async function peutVoirLaValeur(e: EntreeJeton, user: CurrentUser, acces: AccesIa, geste = GESTE_ASSISTANT): Promise<boolean> {
  const soi = !!e.titulaireUserId && e.titulaireUserId === user.id;
  const ferme = e.nature === "SALAIRE" && !soi && !familleOuverte(acces, "SALAIRES");
  const lecteur = lecteurDepuisSession(user);
  const politique = peutLire(lecteur, e.nature, { genre: "PERSONNE", userId: e.titulaireUserId });
  const libelleGeste = `${geste}${e.outil ? ` — outil ${e.outil}` : ""}`;
  // S1 (décision 0048) : la coordonnée bancaire ou la pièce d'identité PERSONNELLE d'autrui ne sort par l'assistant que pour
  // qui gère les RH (ou le Super Admin) — la politique du coffre l'ouvre à la finance pour ses ÉCRANS de paiement, pas ici.
  const personnelAutrui = !!e.titulaireUserId && !soi && e.nature !== "SALAIRE";
  let accorde = !ferme && politique.autorise && (!personnelAutrui || acces.superAdmin || voitLesSalaires(user));
  if (e.origine) {
    // Le contrôle du coffre journalise (interrupteur `coffreLecture` ouvert) ; fermé, il rend la colonne sans
    // juger — la politique ci-dessus reste donc la condition, toujours.
    const { lecture } = await controlerLecture({
      lecteur, modele: e.origine.modele, champs: [e.origine.champ], geste: libelleGeste,
      lignes: [{ id: e.origine.id, clair: { [e.origine.champ]: e.origine.brut } }],
    });
    accorde = accorde && lecture.get(e.origine.id)?.[e.origine.champ]?.lu === true;
  }
  // S1 (décision 0048) : au-delà de la politique du coffre, SEUL un périmètre nominatif en vigueur (avenant de délégation,
  // droit daté de la console) sur l'ENTITÉ du titulaire — jamais un réglage de rôle. Tracé à l'audit avec son origine et son motif.
  const perimetre = !accorde && !ferme && e.nature === "SALAIRE" && !acces.superAdmin
    ? perimetreCouvrant(acces, "SALAIRES", await entiteDuTitulaire(e)) : null;
  const parOuverture = !!perimetre;
  if (!e.origine) {
    await journaliserLectureHorsColonne({
      userId: user.id, nature: e.nature, geste: libelleGeste, autorise: accorde || parOuverture,
      motif: accorde ? "POLITIQUE" : parOuverture ? "OUVERTURE_DIRECTION" : ferme ? "FAMILLE_FERMEE" : "HORS_PERIMETRE",
      origineModele: e.source?.modele, origineId: e.source?.id,
    });
  }
  if (parOuverture) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA",
      summary: `Rémunération montrée par l'Assistant IA sur ${LIBELLE_ORIGINE[perimetre!.origine].toLowerCase()} (famille « ${LIBELLE_FAMILLE.SALAIRES} »`
        + `${perimetre!.ref ? `, réf. ${perimetre!.ref}` : ""} — motif : ${perimetre!.motif})`
        + `${e.origine ? ` — ${e.origine.modele}.${e.origine.champ} ${e.origine.id}` : e.source ? ` — ${e.source.modele} ${e.source.id}` : ""} · ${libelleGeste}`,
    });
  }
  return accorde || parOuverture;
}

/** Les décisions d'un tour, gardées : le même repère n'est jugé (et journalisé) qu'une fois. */
export class Revelateur {
  private readonly decisions = new Map<number, Promise<boolean>>();

  constructor(private readonly coffret: CoffretDuTour, private readonly user: CurrentUser, private readonly acces: AccesIa, private readonly geste = GESTE_ASSISTANT) {}

  autorise(n: number): Promise<boolean> {
    const e = this.coffret.entree(n);
    if (!e) return Promise.resolve(false);
    let d = this.decisions.get(n);
    if (!d) {
      d = peutVoirLaValeur(e, this.user, this.acces, this.geste).catch((err) => {
        // Le journal a échoué : rien ne sort (la règle du coffre).
        console.error("[assistant-ia] révélation refusée faute de journal", err);
        return false;
      });
      this.decisions.set(n, d);
    }
    return d;
  }

  /** Le texte, ses repères remplacés : la valeur (bornée) si la personne y a droit, « [confidentiel] » sinon. */
  async texte(texte: string): Promise<string> {
    const reperes = reperesDe(texte);
    if (!reperes.length) return texte;
    const ok = new Map(await Promise.all(reperes.map(async (n) => [n, await this.autorise(n)] as const)));
    return remplacerReperes(texte, (n) => (ok.get(n) ? borner(this.coffret.entree(n)!.valeur) : MASQUE_CONFIDENTIEL));
  }

  /**
   * MODE « EN CLAIR » (décision 0034) — la SORTIE D'UN OUTIL, avant le modèle : chaque repère devient la valeur (sans
   * bornes) si la personne a le droit de la voir — même juge, même journal que l'affichage —, « [confidentiel] » sinon.
   * Un JSON reste un JSON (la valeur est remplacée dans ses chaînes, pas dans le texte brut).
   */
  async enClair(sortie: string): Promise<string> {
    if (!reperesDe(sortie).length) return sortie;
    const remplacer = async (texte: string): Promise<string> => {
      const reperes = reperesDe(texte);
      if (!reperes.length) return texte;
      const ok = new Map(await Promise.all(reperes.map(async (n) => [n, await this.autorise(n)] as const)));
      return remplacerReperes(texte, (n) => (ok.get(n) ? this.coffret.entree(n)!.valeur : MASQUE_CONFIDENTIEL));
    };
    let objet: unknown;
    try { objet = JSON.parse(sortie); } catch { return remplacer(sortie); }
    const visiter = async (v: unknown): Promise<unknown> => {
      if (typeof v === "string") return remplacer(v);
      if (Array.isArray(v)) return Promise.all(v.map(visiter));
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = await visiter(x);
        return out;
      }
      return v;
    };
    return JSON.stringify(await visiter(objet));
  }

  /** Un objet (les blocs de l'UI générative) : chaque chaîne révélée de même. */
  async objet<T>(donnees: T): Promise<T> {
    const visiter = async (v: unknown): Promise<unknown> => {
      if (typeof v === "string") return this.texte(v);
      if (Array.isArray(v)) return Promise.all(v.map(visiter));
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = await visiter(x);
        return out;
      }
      return v;
    };
    return (await visiter(donnees)) as T;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN REPÈRE DANS UNE CARTE (décision 0012, Direction 29/10/2026 : « oui, après confirmation ») — « envoie le
 * salaire d'Assia à Karim ». Le modèle écrit `⟦S1⟧` dans l'entrée de l'outil ; le SERVEUR y met la vraie valeur
 * avant de préparer la carte, seulement si la personne a le droit de la voir — sinon la carte est refusée.
 * La valeur ne repart pas au modèle (la sortie de l'outil la rend en repère) ; elle est rejugée à l'exécution
 * (`verifierReperesAvantExecution`) ; chaque substitution est tracée (qui, quelle donnée, vers quel geste).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type ReperesSubstitues = EntreeJeton[];

export async function substituerReperes(
  entree: Record<string, unknown>, coffret: CoffretDuTour | null | undefined, user: CurrentUser, acces: AccesIa, outil: string,
): Promise<{ entree: Record<string, unknown>; substitues: { n: number; e: EntreeJeton }[] } | { refus: string }> {
  const vus = reperesDe(JSON.stringify(entree));
  if (!vus.length) return { entree, substitues: [] };
  if (!coffret) return { refus: "Une valeur confidentielle ne peut pas entrer dans ce geste ici." };
  const revelateur = new Revelateur(coffret, user, acces, `Assistant IA — carte ${outil}`);
  const substitues: { n: number; e: EntreeJeton }[] = [];
  for (const n of vus) {
    const e = coffret.entree(n);
    if (!e || !(await revelateur.autorise(n))) {
      return { refus: `La valeur ⟦S${n}⟧ ne vous est pas ouverte : elle ne peut pas entrer dans une carte. Rien n'a été préparé.` };
    }
    substitues.push({ n, e });
  }
  const remplacer = (v: unknown): unknown => {
    if (typeof v === "string") return remplacerReperes(v, (n) => coffret.entree(n)?.valeur ?? MASQUE_CONFIDENTIEL);
    if (Array.isArray(v)) return v.map(remplacer);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, remplacer(x)]));
    return v;
  };
  return { entree: remplacer(entree) as Record<string, unknown>, substitues };
}

/** La carte garde ses valeurs substituées (sans les montrer au modèle) : la confirmation les rejuge. */
export async function ajouterReperesAIntention(intentId: string, reperes: ReperesSubstitues): Promise<void> {
  const i = await prisma.assistantActionIntent.findUnique({ where: { id: intentId }, select: { payload: true } });
  const payload = (i?.payload && typeof i.payload === "object" ? i.payload : {}) as Record<string, unknown>;
  await prisma.assistantActionIntent.update({ where: { id: intentId }, data: { payload: { ...payload, reperesSubstitues: reperes } as never } });
}

/** La trace d'une substitution : qui, quelle donnée, vers quel geste et quel destinataire (le titre et les champs de la carte). */
export async function tracerSubstitutions(user: CurrentUser, substitues: { e: EntreeJeton }[], carte: { titre: string; champs?: { label: string; value: string }[] }, moment: "carte" | "exécution"): Promise<void> {
  const vers = (carte.champs ?? []).filter((c) => /destinataire|^à$|pour|invit|assign|responsable/i.test(c.label)).map((c) => `${c.label} : ${c.value}`).join(" ; ");
  for (const { e } of substitues) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA",
      summary: `Valeur confidentielle (${e.nature}${e.origine ? ` — ${e.origine.modele}.${e.origine.champ} ${e.origine.id}` : e.source ? ` — ${e.source.modele} ${e.source.id}` : ""}) `
        + `${moment === "carte" ? "insérée dans la carte" : "utilisée à l'exécution de"} « ${carte.titre} »${vers ? ` → ${vers}` : ""}`,
    });
  }
}

/**
 * À LA CONFIRMATION : les valeurs substituées sont rejugées pour la personne qui confirme, avec ses accès DU MOMENT
 * (la Direction a pu fermer la famille entre-temps). Une seule refusée → rien ne s'exécute.
 */
export async function verifierReperesAvantExecution(user: CurrentUser, reperes: ReperesSubstitues, titre: string): Promise<string | null> {
  const acces = await accesAssistantIa(user);
  for (const e of reperes) {
    if (!(await peutVoirLaValeur(e, user, acces, `Assistant IA — exécution « ${titre} »`))) {
      return "Cette carte porte une valeur confidentielle que vous n'avez plus le droit de voir : rien n'a été exécuté.";
    }
  }
  await tracerSubstitutions(user, reperes.map((e) => ({ e })), { titre }, "exécution");
  return null;
}
