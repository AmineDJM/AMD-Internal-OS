/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TEACH ADAM, CÔTÉ BASE — enseigner, lister, modifier, désactiver, supprimer une règle ; et
 * composer les règles EN VIGUEUR pour une personne, à l'instant où Adam lui répond.
 *
 * ── LE PONT PORTE LES DROITS, LE DOMAINE PORTE LA LOGIQUE ───────────────────────────────
 *
 * `src/lib/teach/` classe, résout et compose sans connaître ni la base ni la session. Ici :
 * qui a le droit d'enseigner à quel périmètre, comment on retrouve les sociétés et la chaîne
 * de départements d'une personne, et l'écriture — en transaction quand une version en
 * remplace une autre.
 *
 *   PERSON  : chacun, pour lui-même. Toujours.
 *   COMPANY : le droit de CRÉER des directives (Direction, Super Admin) ET pouvoir engager la
 *             société (`canEditCompanyId`) — voir une société ne suffit pas à légiférer pour elle.
 *   GROUP   : le responsable ou l'adjoint du département, ou la Direction.
 *
 * Une règle de périmètre société est une ATTESTATION au nom de la maison : elle porte le nom
 * de la personne qui l'a dite, et l'agent des missions ne peut pas l'écrire (guard.ts, §15).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lireCanal, lireHeuresSilence } from "@/lib/missions/attention/policy";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { canEditCompanyId, getMyCompanies } from "@/lib/company";
import { getDepartmentPath } from "@/lib/departments";
import { classerEnseignement, extraireParametres, type Classement } from "@/lib/teach/classify";
import {
  DOMAINES_SUGGERES, KINDS, LIBELLE_KIND, LIBELLE_SCOPE, LIBELLE_STATUT, MAX_CITATION, MAX_REGLES_ACTIVES_PAR_SUJET, MAX_STATEMENT, MAX_TITLE,
  SCOPES, estKind, estScope, normaliserDomaine,
  type Kind, type Provenance, type Regle, type Scope, type Statut, type Sujet,
} from "@/lib/teach/model";
import { cleDe, conflitsAvecExistantes, resoudre, type Resolution } from "@/lib/teach/resolve";
import { composerBlocRegles, lignesPourPlanificateur } from "@/lib/teach/compose";
import { NIVEAUX, niveauDepuisTexte } from "@/lib/meetings/niveau";
import { sansBloquer } from "@/lib/journal";

export type { Kind, Regle, Scope, Statut } from "@/lib/teach/model";
export { DOMAINES_SUGGERES, KINDS, LIBELLE_KIND, LIBELLE_SCOPE, LIBELLE_STATUT, SCOPES } from "@/lib/teach/model";

type Echec = "NOT_FOUND" | "MISSING_PERMISSION" | "MISSING_INPUT" | "CAPABILITY_FAILURE";
export interface EchecTeach { ok: false; echec: Echec; motif: string; conflits?: RegleVue[]; candidats?: { id: string; nom: string }[] }
const echec = (e: Echec, motif: string, extra: Partial<Omit<EchecTeach, "ok" | "echec" | "motif">> = {}): EchecTeach => ({ ok: false, echec: e, motif, ...extra });

/** Une règle telle qu'on la montre : la ligne, plus des libellés lisibles. */
export interface RegleVue extends Regle {
  kindLibelle: string;
  scopeLibelle: string;
  statutLibelle: string;
  societeNom: string | null;
}

type Row = Prisma.AdamRuleGetPayload<{ include: { company: { select: { name: true } } } }>;

function versRegle(r: Row): RegleVue {
  const kind = estKind(r.kind) ? r.kind : "PREFERENCE";
  const scope = estScope(r.scope) ? r.scope : "PERSON";
  const status = (["ACTIVE", "DISABLED", "SUPERSEDED", "DELETED"] as const).includes(r.status as Statut) ? (r.status as Statut) : "ACTIVE";
  return {
    id: r.id, kind, scope, ownerId: r.ownerId, subjectUserId: r.subjectUserId, companyId: r.companyId, departmentId: r.departmentId,
    domain: r.domain, title: r.title, statement: r.statement,
    params: r.params && typeof r.params === "object" && !Array.isArray(r.params) ? (r.params as Record<string, unknown>) : null,
    priority: r.priority, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, status, version: r.version, supersedesId: r.supersedesId,
    provenance: r.provenance && typeof r.provenance === "object" && !Array.isArray(r.provenance) ? (r.provenance as Provenance) : null,
    createdAt: r.createdAt,
    kindLibelle: LIBELLE_KIND[kind], scopeLibelle: LIBELLE_SCOPE[scope], statutLibelle: LIBELLE_STATUT[status], societeNom: r.company?.name ?? null,
  };
}

const INCLURE = { company: { select: { name: true } } } as const;

// ─────────────────────────── Le sujet ───────────────────────────

/** Les sociétés et la chaîne de départements d'une personne — ce sur quoi les périmètres se résolvent. */
export async function sujetDe(userId: string, maintenant?: Date): Promise<Sujet & { departementDirect: string | null }> {
  const [societes, u] = await Promise.all([
    getMyCompanies(userId).catch(sansBloquer("teach-store.sujetDe.getMyCompanies", [])),
    prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true, employee: { select: { departmentId: true } } } }),
  ]);
  const direct = u?.employee?.departmentId ?? u?.departmentId ?? null;
  const chaine = direct ? await getDepartmentPath(direct).catch(sansBloquer("teach-store.sujetDe.getDepartmentPath", [])) : [];
  const departmentIds = [...new Set([direct, ...chaine.map((d) => d.id)].filter((x): x is string => !!x))];
  return { userId, companyIds: societes.map((c) => c.id), departmentIds, maintenant, departementDirect: direct };
}

async function candidates(sujet: Sujet): Promise<RegleVue[]> {
  const rows = await prisma.adamRule.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { scope: "PERSON", subjectUserId: sujet.userId },
        { scope: "COMPANY", OR: [{ companyId: null }, { companyId: { in: [...sujet.companyIds] } }] },
        ...(sujet.departmentIds.length ? [{ scope: "GROUP", departmentId: { in: [...sujet.departmentIds] } }] : []),
      ],
    },
    include: INCLURE,
    orderBy: [{ priority: "desc" }, { effectiveFrom: "desc" }],
    take: 2_000,
  });
  return rows.map(versRegle);
}

/** LES RÈGLES EN VIGUEUR pour une personne : applicables, puis départagées par la précédence. */
export async function reglesEnVigueurPour(userId: string, opts: { maintenant?: Date } = {}): Promise<{ sujet: Sujet; resolution: Resolution<RegleVue>; toutes: RegleVue[] }> {
  const sujet = await sujetDe(userId, opts.maintenant);
  const toutes = await candidates(sujet);
  return { sujet, resolution: resoudre(toutes, sujet), toutes };
}

/** LE BLOC pour le prompt de conversation et de voix. Vide quand rien ne s'applique. */
export async function contexteRegles(userId: string, opts: { domaine?: string | null; budgetJetons?: number } = {}): Promise<string> {
  const { resolution, toutes } = await reglesEnVigueurPour(userId);
  if (resolution.enVigueur.length === 0) return "";
  const noms = new Map(toutes.filter((r) => r.companyId && r.societeNom).map((r) => [r.companyId as string, r.societeNom as string]));
  return composerBlocRegles(resolution.enVigueur, { domaine: opts.domaine ?? null, budgetJetons: opts.budgetJetons, nomSociete: (id) => (id ? noms.get(id) ?? null : null) });
}

/** LES LIGNES pour le planificateur de missions (`ContextePlanification.politiques`). */
export async function politiquesPourMission(userId: string, domaine?: string | null): Promise<string[]> {
  const { resolution } = await reglesEnVigueurPour(userId);
  return lignesPourPlanificateur(resolution.enVigueur, domaine ?? null);
}

/** Les clés que la fabrique documentaire sait appliquer (voir `profilDocumentaire`). */
const CLES_DOCUMENTAIRES = new Set(["validiteDevis", "prefixeFacture", "prefixeDevis", "prefixeBonDeCommande", "tvaDefaut", "conditionsPaiement", "mentionPied"]);

const plierCle = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
/** Les clés de la communication omnicanale (§37) : le canal préféré et les heures de silence, lues par la porte d'attention. */
const CLES_CANAUX = ["canalPrefere", "heuresSilence"] as const;
/** Les clés que le pont sait canoniser : les standards documentaires, le niveau de brief de réunion (§32), les canaux (§37). */
const CLES_CONNUES = new Set([...CLES_DOCUMENTAIRES, "niveauReunion", ...CLES_CANAUX]);
/** Les VARIANTES que le modèle écrit pour une clé connue — mesuré au banc : `{ niveau: "CHIEF_OF_STAFF" }` pour le niveau de brief. */
const ALIAS_CLES: Record<string, string> = {
  niveau: "niveauReunion", niveaubrief: "niveauReunion", niveaudebrief: "niveauReunion", niveaubriefing: "niveauReunion", niveaureunions: "niveauReunion", briefreunion: "niveauReunion", meetinglevel: "niveauReunion", brieflevel: "niveauReunion",
  canal: "canalPrefere", canalprefere: "canalPrefere", canaldenotification: "canalPrefere", canalnotification: "canalPrefere", canalnotifications: "canalPrefere", canaldecommunication: "canalPrefere", preferredchannel: "canalPrefere", channel: "canalPrefere",
  heuressilence: "heuresSilence", heuresdesilence: "heuresSilence", heuredesilence: "heuresSilence", silence: "heuresSilence", nepasderanger: "heuresSilence", plagesilence: "heuresSilence", plagedesilence: "heuresSilence", quiethours: "heuresSilence", horairessilence: "heuresSilence",
};
const CLE_CANONIQUE = new Map([...[...CLES_CONNUES].map((c) => [plierCle(c), c] as const), ...Object.entries(ALIAS_CLES).map(([a, c]) => [plierCle(a), c] as const)]);

/**
 * NORMALISE les paramètres reçus du modèle. `cle` est repliée sur une clé connue quand elle en
 * est une variante (« validite_devis », « Validité devis » → `validiteDevis`) ; les valeurs
 * numériques attendues sont coercées (« 45 jours » → 45 ; une TVA « 19 » → 0,19). Une clé
 * inconnue alors que le TEXTE porte une clé connue : c'est le texte qui a raison. Sans
 * paramètres du modèle, l'extraction du texte fait foi.
 */
export function normaliserParams(fournis: unknown, extraits: Record<string, unknown> | null): Record<string, unknown> | null {
  const brut = fournis && typeof fournis === "object" && !Array.isArray(fournis) && Object.keys(fournis as object).length ? { ...(fournis as Record<string, unknown>) } : null;
  if (!brut) return extraits;
  let cleBrute: string;
  if (typeof brut.cle === "string") cleBrute = brut.cle;
  else {
    // LA FORME PLATE : le modèle écrit parfois `{ validiteDevis: 45, unite: "jours" }` au lieu de
    // `{ cle, valeur }`. Une seule clé documentaire connue parmi les propriétés = c'est elle.
    const connues = Object.keys(brut).filter((k) => CLE_CANONIQUE.has(plierCle(k)));
    if (connues.length !== 1) {
      // Aucune clé connue (ou plusieurs) dans la forme plate, mais le TEXTE en porte une : c'est le texte
      // qui a raison — mesuré au banc, `{ niveau: … }` sans clé aurait laissé une règle sans structure.
      if (connues.length === 0 && extraits && typeof extraits.cle === "string" && CLES_CONNUES.has(extraits.cle)) return extraits;
      return brut;
    }
    const [k] = connues;
    const valeur = brut[k];
    delete brut[k];
    cleBrute = CLE_CANONIQUE.get(plierCle(k)) as string;
    brut.cle = cleBrute;
    brut.valeur = valeur;
  }
  const canon = CLE_CANONIQUE.get(plierCle(cleBrute));
  if (!canon) {
    // Clé inconnue alors que le texte porte une clé connue : c'est le texte qui a raison.
    if (extraits && typeof extraits.cle === "string" && CLES_CONNUES.has(extraits.cle)) return extraits;
    return brut;
  }
  const cle: string = canon;
  brut.cle = cle;
  const valeur = brut.valeur;
  if (cle === "validiteDevis" && typeof valeur === "string") {
    const n = Number.parseInt(valeur, 10);
    if (Number.isFinite(n)) brut.valeur = n;
  }
  if (cle === "tvaDefaut") {
    const n = typeof valeur === "string" ? Number.parseFloat(valeur.replace(",", ".")) : Number(valeur);
    if (Number.isFinite(n)) brut.valeur = n > 1 ? n / 100 : n;
  }
  if (cle.startsWith("prefixe") && typeof valeur === "string") brut.valeur = valeur.trim().toUpperCase();
  if (cle === "niveauReunion" && typeof valeur === "string") {
    const v = valeur.trim().toUpperCase().replace(/[\s-]+/g, "_");
    brut.valeur = (NIVEAUX as readonly string[]).includes(v) ? v : niveauDepuisTexte(valeur) ?? valeur;
  }
  // LES CANAUX (§37) : « Slack », « e-mail », « slack:#direction » → canonique ; « 22h-7h » → { de: 22, a: 7 }.
  if (cle === "canalPrefere") {
    const c = lireCanal(valeur);
    if (c) brut.valeur = c.destinataire ? `${c.canal}:${c.destinataire}` : c.canal;
  }
  if (cle === "heuresSilence") {
    const h = lireHeuresSilence(valeur);
    if (h) brut.valeur = h;
  }
  return brut;
}

/** Les standards documentaires de périmètre société qu'un programme peut appliquer, par clé. */
export async function standardsDocumentaires(userId: string, companyId: string): Promise<Map<string, { valeur: unknown; regle: RegleVue }>> {
  const { resolution } = await reglesEnVigueurPour(userId);
  const out = new Map<string, { valeur: unknown; regle: RegleVue }>();
  for (const r of resolution.enVigueur) {
    // La NATURE n'est pas le critère : une règle de société classée COMPANY_RULE qui dit « devis
    // valables 45 jours » porte une clé documentaire, et c'est la clé qui compte pour la fabrique.
    if (r.scope !== "COMPANY") continue;
    if (r.companyId !== null && r.companyId !== companyId) continue;
    const cle = r.params && typeof r.params.cle === "string" ? r.params.cle : null;
    if (cle && CLES_DOCUMENTAIRES.has(cle) && r.params && "valeur" in r.params) out.set(cle, { valeur: r.params.valeur, regle: r });
  }
  return out;
}

// ─────────────────────────── Les droits ───────────────────────────

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";
const peutLegiferer = (u: CurrentUser): boolean => EXEC(u) || userCan(u, "DIRECTIVES", "CREATE");

async function peutEnseigner(user: CurrentUser, scope: Scope, cible: { companyId: string | null; departmentId: string | null }): Promise<{ ok: true } | EchecTeach> {
  if (scope === "PERSON") return { ok: true };
  if (scope === "COMPANY") {
    if (!peutLegiferer(user)) return echec("MISSING_PERMISSION", "Une règle de SOCIÉTÉ engage tout le monde : elle se pose par la Direction ou le Super Admin. Vous pouvez la garder pour vous seul (périmètre personnel).");
    if (cible.companyId === null && user.role !== "SUPER_ADMIN") return echec("MISSING_PERMISSION", "Une règle commune à TOUT LE GROUPE se pose par le Super Admin ; nommez une société.");
    if (cible.companyId && !(await canEditCompanyId(user.id, cible.companyId))) return echec("MISSING_PERMISSION", "Vous voyez cette société sans pouvoir l'engager : pas de règle en son nom.");
    return { ok: true };
  }
  if (!cible.departmentId) return echec("MISSING_INPUT", "Une règle de département exige le département.");
  if (peutLegiferer(user)) return { ok: true };
  const d = await prisma.department.findUnique({ where: { id: cible.departmentId }, select: { head: { select: { userId: true } }, deputy: { select: { userId: true } } } });
  if (d && (d.head?.userId === user.id || d.deputy?.userId === user.id)) return { ok: true };
  return echec("MISSING_PERMISSION", "Une règle de département se pose par son responsable, son adjoint ou la Direction.");
}

const plier = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

async function resoudreSociete(userId: string, societe: string | null | undefined): Promise<{ ok: true; id: string; nom: string } | EchecTeach> {
  const miennes = await getMyCompanies(userId);
  const voulu = (societe ?? "").trim();
  if (!voulu) {
    if (miennes.length === 1) return { ok: true, id: miennes[0].id, nom: miennes[0].name };
    return echec("MISSING_INPUT", `Pour quelle société ? ${miennes.map((c) => c.name).join(", ")}.`, { candidats: miennes.map((c) => ({ id: c.id, nom: c.name })) });
  }
  const p = plier(voulu);
  const exacts = miennes.filter((c) => c.id === voulu || plier(c.name) === p || (c.shortName && plier(c.shortName) === p));
  const partiels = exacts.length ? exacts : miennes.filter((c) => plier(c.name).includes(p) || (c.shortName && plier(c.shortName).includes(p)));
  if (partiels.length === 1) return { ok: true, id: partiels[0].id, nom: partiels[0].name };
  if (partiels.length > 1) return echec("MISSING_INPUT", `${partiels.length} sociétés correspondent à « ${voulu} » : laquelle ?`, { candidats: partiels.map((c) => ({ id: c.id, nom: c.name })) });
  return echec("NOT_FOUND", `Aucune société « ${voulu} » parmi les vôtres (${miennes.map((c) => c.name).join(", ")}).`);
}

async function resoudreDepartement(userId: string, departement: string | null | undefined): Promise<{ ok: true; id: string; nom: string } | EchecTeach> {
  const voulu = (departement ?? "").trim();
  if (!voulu) {
    const s = await sujetDe(userId);
    if (s.departementDirect) {
      const d = await prisma.department.findUnique({ where: { id: s.departementDirect }, select: { id: true, name: true } });
      if (d) return { ok: true, id: d.id, nom: d.name };
    }
    return echec("MISSING_INPUT", "Quel département ? Vous n'êtes rattaché à aucun.");
  }
  const miennes = await getMyCompanies(userId);
  const rows = await prisma.department.findMany({
    where: { OR: [{ id: voulu }, { code: voulu.toUpperCase() }, { name: { contains: voulu, mode: "insensitive" } }], AND: [{ OR: [{ companyId: null }, { companyId: { in: miennes.map((c) => c.id) } }] }] },
    select: { id: true, name: true, code: true }, take: 6,
  });
  const exacts = rows.filter((d) => d.id === voulu || d.code === voulu.toUpperCase() || plier(d.name) === plier(voulu));
  const retenus = exacts.length ? exacts : rows;
  if (retenus.length === 1) return { ok: true, id: retenus[0].id, nom: retenus[0].name };
  if (retenus.length > 1) return echec("MISSING_INPUT", `${retenus.length} départements correspondent à « ${voulu} » : lequel ?`, { candidats: retenus.map((d) => ({ id: d.id, nom: d.name })) });
  return echec("NOT_FOUND", `Aucun département « ${voulu} ».`);
}

// ─────────────────────────── Enseigner ───────────────────────────

export interface DemandeEnseignement {
  statement: string;
  title?: string | null;
  kind?: string | null;
  scope?: string | null;
  /** COMPANY : identifiant, raison sociale ou nom court. */
  societe?: string | null;
  /** GROUP : identifiant, code ou nom du département. */
  departement?: string | null;
  domaine?: string | null;
  params?: Record<string, unknown> | null;
  priorite?: number | null;
  /** ISO. Vide = maintenant. */
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  /** L'identifiant de la règle que celle-ci REMPLACE (nouvelle version). */
  remplaceId?: string | null;
  /** Écrire malgré un conflit de même clé (les deux coexistent ; la priorité départage). */
  forcer?: boolean;
  citation?: string | null;
  provenance?: Provenance | null;
}

export interface RegleEnseignee {
  ok: true;
  regle: RegleVue;
  classement: Classement | null;
  remplacee: string | null;
  avertissements: string[];
}

const dateIso = (v: string | null | undefined): Date | null | "INVALIDE" => {
  if (!v || !v.trim()) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00Z` : v.trim());
  return Number.isNaN(d.getTime()) ? "INVALIDE" : d;
};

const titreDepuis = (statement: string): string => {
  const mots = statement.replace(/\s+/g, " ").trim().split(" ").slice(0, 9).join(" ");
  const t = mots.replace(/[.;:,]+$/, "");
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, MAX_TITLE);
};

/** ENSEIGNE une règle : classe, borne, vérifie le droit, détecte le conflit, écrit (une version). */
/**
 * CE QUI N'EST PAS UNE RÈGLE : la charte d'une société (couleurs, polices, logo, mentions de pied,
 * signataires) et son profil documentaire sont des RÉGLAGES, tenus par le registre de marque
 * (§26) et relus par la fabrique. Enregistrés comme règle, ils ne s'appliqueraient à rien — le
 * banc l'a montré : « règle la charte d'Adventum » finissait en règle personnelle, et le devis
 * suivant partait sans la charte. Le refus NOMME l'outil qui convient ; le modèle enchaîne.
 */
const VOCABULAIRE_MARQUE = /\b(charte|charte graphique|couleur d'accent|couleur secondaire|couleur de la societe|couleurs? de la marque|logo|police des titres|police du texte|polices?|typographie|mentions? (legales?|de pied)|signataires?|signent? les (devis|factures|bons)|papier (a )?en-tete|registre de marque)\b/i;
const plierTexte = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export async function enseigner(user: CurrentUser, d: DemandeEnseignement): Promise<RegleEnseignee | EchecTeach> {
  const statement = (d.statement ?? "").replace(/\s+/g, " ").trim();
  if (!statement) return echec("MISSING_INPUT", "Rien à enseigner : donnez la règle en une phrase.");
  if (VOCABULAIRE_MARQUE.test(plierTexte(statement))) {
    return echec("MISSING_INPUT", "Ce n'est pas une règle à enseigner : c'est la CHARTE (couleurs, polices, logo, mentions de pied, signataires) ou le profil documentaire de la société. "
      + "Appelez `document_profile` avec `geste: \"definir\"`, `societe` et le champ `marque` ({ couleurAccent, policeTitres, policeTexte, mentionsLegales: [...], signataire, signatairesParType: { DEVIS: {nom, qualite} } }) : la fabrique l'appliquera d'elle-même à chaque pièce.");
  }
  if (statement.length > MAX_STATEMENT) return echec("MISSING_INPUT", `La règle fait ${statement.length} caractères (maximum ${MAX_STATEMENT}) : au-delà, c'est un document, pas une règle — le déposer et enseigner « appliquer le document X ».`);
  if (d.kind && !estKind(d.kind)) return echec("MISSING_INPUT", `Nature inconnue « ${d.kind} » (${KINDS.join(", ")}).`);
  if (d.scope && !estScope(d.scope)) return echec("MISSING_INPUT", `Périmètre inconnu « ${d.scope} » (${SCOPES.join(", ")}).`);
  const scope: Scope = estScope(d.scope) ? d.scope : "PERSON";
  const classement = estKind(d.kind) ? null : classerEnseignement(statement);
  const kind: Kind = estKind(d.kind) ? d.kind : classement!.kind;
  const domain = normaliserDomaine(d.domaine);
  const avertissements: string[] = [];
  if (classement && classement.confiance < 0.6) avertissements.push(`Classée comme « ${LIBELLE_KIND[kind]} » (confiance ${Math.round(classement.confiance * 100)} %) : dites-moi si c'est autre chose.`);
  if (!(DOMAINES_SUGGERES as readonly string[]).includes(domain)) avertissements.push(`Domaine « ${domain} » inhabituel — les domaines connus : ${DOMAINES_SUGGERES.join(", ")}.`);

  let companyId: string | null = null;
  let departmentId: string | null = null;
  if (scope === "COMPANY" && !peutLegiferer(user)) return echec("MISSING_PERMISSION", "Une règle de SOCIÉTÉ engage tout le monde : elle se pose par la Direction ou le Super Admin. Vous pouvez la garder pour vous seul (périmètre personnel).");
  if (scope === "COMPANY") { const s = await resoudreSociete(user.id, d.societe); if (!s.ok) return s; companyId = s.id; }
  if (scope === "GROUP") { const g = await resoudreDepartement(user.id, d.departement); if (!g.ok) return g; departmentId = g.id; }
  const droit = await peutEnseigner(user, scope, { companyId, departmentId });
  if (!droit.ok) return droit;

  const de = dateIso(d.effectiveFrom); const a = dateIso(d.effectiveTo);
  if (de === "INVALIDE") return echec("MISSING_INPUT", `Date d'effet « ${d.effectiveFrom} » illisible (AAAA-MM-JJ).`);
  if (a === "INVALIDE") return echec("MISSING_INPUT", `Date de fin « ${d.effectiveTo} » illisible (AAAA-MM-JJ).`);
  if (de && a && a <= de) return echec("MISSING_INPUT", "La fin de validité précède la date d'effet.");
  const priority = Math.max(-100, Math.min(100, Math.round(Number(d.priorite ?? 0)) || 0));
  // Les paramètres du MODÈLE sont normalisés avant d'être crus : il écrit « validite_devis » ou
  // « 45 jours » là où la fabrique attend `validiteDevis` et 45. Mesuré au banc des défis : la
  // règle était bien en base, et le devis sortait quand même à 30 jours. Ce que le texte dit
  // (l'extracteur) l'emporte sur une clé inconnue ; une clé connue garde sa valeur, coercée.
  const params = normaliserParams(d.params, extraireParametres(statement, kind));
  const title = (d.title ?? "").trim().slice(0, MAX_TITLE) || titreDepuis(statement);
  const subjectUserId = scope === "PERSON" ? user.id : null;
  const provenance: Provenance = { ...(d.provenance ?? {}), citation: (d.citation ?? statement).slice(0, MAX_CITATION), mode: d.provenance?.mode ?? "TAUGHT" };

  // ── LA VERSION QUI REMPLACE ─────────────────────────────────────────────────────────
  let ancienne: Row | null = null;
  if (d.remplaceId) {
    ancienne = await prisma.adamRule.findUnique({ where: { id: d.remplaceId }, include: INCLURE });
    if (!ancienne) return echec("NOT_FOUND", `La règle ${d.remplaceId} n'existe pas.`);
    if (ancienne.status !== "ACTIVE") return echec("CAPABILITY_FAILURE", `La règle ${d.remplaceId} est ${LIBELLE_STATUT[(ancienne.status as Statut) ?? "ACTIVE"] ?? ancienne.status} : on remplace une règle en vigueur.`);
    const v = versRegle(ancienne);
    const droitAncienne = await peutEnseigner(user, v.scope, { companyId: v.companyId, departmentId: v.departmentId });
    if (!droitAncienne.ok) return droitAncienne;
    if (v.scope === "PERSON" && v.subjectUserId !== user.id) return echec("MISSING_PERMISSION", "Cette règle personnelle n'est pas la vôtre.");
  }

  // ── LE CONFLIT, DIT AVANT D'ÉCRIRE ──────────────────────────────────────────────────
  const brouillon = { kind, scope, ownerId: user.id, subjectUserId, companyId, departmentId, domain, title, statement, params, priority, effectiveFrom: de ?? new Date(), effectiveTo: a, provenance };
  if (!d.forcer) {
    const existantes = (await prisma.adamRule.findMany({
      where: { status: "ACTIVE", scope, ...(scope === "PERSON" ? { subjectUserId: user.id } : scope === "COMPANY" ? { companyId } : { departmentId }) },
      include: INCLURE, take: 500,
    })).map(versRegle).filter((r) => r.id !== d.remplaceId);
    const conflits = conflitsAvecExistantes(brouillon, existantes);
    if (conflits.length > 0) {
      return echec("MISSING_INPUT", `Une règle en vigueur porte déjà sur « ${cleDe(brouillon).split(":").pop()} » : ${conflits.map((c) => `${c.id} (v${c.version}) « ${c.statement.slice(0, 80)} »`).join(" ; ")}. Remplacer (remplaceId), ou garder les deux avec une priorité (forcer).`, { conflits });
    }
  }
  const actives = await prisma.adamRule.count({ where: { status: "ACTIVE", ...(scope === "PERSON" ? { subjectUserId: user.id } : scope === "COMPANY" ? { companyId } : { departmentId }) } });
  if (actives >= MAX_REGLES_ACTIVES_PAR_SUJET && !ancienne) return echec("CAPABILITY_FAILURE", `${actives} règles actives sur ce périmètre : en désactiver avant d'en ajouter.`);

  const creee = await prisma.$transaction(async (tx) => {
    if (ancienne) await tx.adamRule.update({ where: { id: ancienne.id }, data: { status: "SUPERSEDED", updatedById: user.id } });
    return tx.adamRule.create({
      data: {
        kind, scope, ownerId: user.id, subjectUserId, companyId, departmentId, domain, title, statement,
        params: (params ?? Prisma.JsonNull) as Prisma.InputJsonValue, priority,
        effectiveFrom: de ?? new Date(), effectiveTo: a, status: "ACTIVE",
        version: ancienne ? ancienne.version + 1 : 1, supersedesId: ancienne?.id ?? null,
        provenance: provenance as unknown as Prisma.InputJsonValue, updatedById: user.id,
      },
      include: INCLURE,
    });
  });
  const regle = versRegle(creee);
  await recordAudit({
    actorId: user.id, action: ancienne ? "UPDATE" : "CREATE", module: "Assistant IA",
    summary: `Teach Adam — ${LIBELLE_SCOPE[scope]} · ${LIBELLE_KIND[kind]}${ancienne ? ` v${regle.version} (remplace ${ancienne.id})` : ""} : ${statement.slice(0, 140)}`,
  });
  return { ok: true, regle, classement, remplacee: ancienne?.id ?? null, avertissements };
}

// ─────────────────────────── Lister ───────────────────────────

export interface FiltresRegles {
  domaine?: string | null;
  kind?: string | null;
  scope?: string | null;
  texte?: string | null;
  societe?: string | null;
  /** Inclure désactivées, remplacées, supprimées — l'historique. */
  inclureHistorique?: boolean;
  /** L'historique d'UNE règle : toutes ses versions. */
  id?: string | null;
  max?: number;
}

export interface RegleListee extends RegleVue {
  /** Vrai si elle s'applique à la personne MAINTENANT et n'est écartée par aucune autre. */
  enVigueur: boolean;
  ecarteePar: { id: string; raison: string } | null;
}

/** Remonte et descend la chaîne des versions d'une règle. */
async function chaineDe(id: string): Promise<Row[]> {
  const vues = new Map<string, Row>();
  let courant = await prisma.adamRule.findUnique({ where: { id }, include: INCLURE });
  while (courant && !vues.has(courant.id)) {
    vues.set(courant.id, courant);
    courant = courant.supersedesId ? await prisma.adamRule.findUnique({ where: { id: courant.supersedesId }, include: INCLURE }) : null;
  }
  let suivante = await prisma.adamRule.findUnique({ where: { supersedesId: id }, include: INCLURE });
  while (suivante && !vues.has(suivante.id)) {
    vues.set(suivante.id, suivante);
    suivante = await prisma.adamRule.findUnique({ where: { supersedesId: suivante.id }, include: INCLURE });
  }
  return [...vues.values()].sort((x, y) => x.version - y.version);
}

/** LISTE ce que la personne a le droit de voir : ses règles, celles de ses sociétés et de ses départements. */
export async function listerRegles(user: CurrentUser, f: FiltresRegles = {}): Promise<{ ok: true; regles: RegleListee[]; enVigueur: number; total: number } | EchecTeach> {
  const sujet = await sujetDe(user.id);
  const { resolution } = await reglesEnVigueurPour(user.id);
  const gagnantes = new Set(resolution.enVigueur.map((r) => r.id));
  const ecartees = new Map(resolution.ecartees.map((e) => [e.regle.id, { id: e.par.id, raison: e.raison }]));
  const visible = (r: Row): boolean =>
    (r.scope === "PERSON" && (r.subjectUserId === user.id || r.ownerId === user.id))
    || (r.scope === "COMPANY" && (r.companyId === null || sujet.companyIds.includes(r.companyId)))
    || (r.scope === "GROUP" && !!r.departmentId && sujet.departmentIds.includes(r.departmentId))
    || (peutLegiferer(user) && r.scope !== "PERSON");

  let rows: Row[];
  if (f.id) {
    rows = (await chaineDe(f.id)).filter(visible);
    if (rows.length === 0) return echec("NOT_FOUND", `Aucune règle ${f.id} visible pour vous.`);
  } else {
    let companyId: string | null | undefined;
    if (f.societe) { const s = await resoudreSociete(user.id, f.societe); if (!s.ok) return s; companyId = s.id; }
    rows = (await prisma.adamRule.findMany({
      where: {
        ...(f.inclureHistorique ? {} : { status: "ACTIVE" }),
        ...(f.kind && estKind(f.kind) ? { kind: f.kind } : {}),
        ...(f.scope && estScope(f.scope) ? { scope: f.scope } : {}),
        ...(f.domaine ? { domain: normaliserDomaine(f.domaine) } : {}),
        ...(companyId ? { companyId } : {}),
        // Deux `OR` dans un même objet s'écraseraient : le filtre de texte et la visibilité vivent
        // chacun dans son membre d'un `AND`.
        AND: [
          ...(f.texte?.trim() ? [{ OR: [{ statement: { contains: f.texte.trim(), mode: "insensitive" as const } }, { title: { contains: f.texte.trim(), mode: "insensitive" as const } }] }] : []),
          {
            OR: [
              { scope: "PERSON", subjectUserId: user.id },
              { scope: "PERSON", ownerId: user.id },
              { scope: "COMPANY", OR: [{ companyId: null }, { companyId: { in: [...sujet.companyIds] } }] },
              ...(sujet.departmentIds.length ? [{ scope: "GROUP", departmentId: { in: [...sujet.departmentIds] } }] : []),
              ...(peutLegiferer(user) ? [{ scope: { in: ["COMPANY", "GROUP"] } }] : []),
            ],
          },
        ],
      },
      include: INCLURE,
      orderBy: [{ status: "asc" }, { scope: "desc" }, { priority: "desc" }, { updatedAt: "desc" }],
      take: Math.min(Math.max(f.max ?? 100, 1), 500),
    })).filter(visible);
  }
  const regles: RegleListee[] = rows.map(versRegle).map((r) => ({ ...r, enVigueur: gagnantes.has(r.id), ecarteePar: ecartees.get(r.id) ?? null }));
  return { ok: true, regles, enVigueur: regles.filter((r) => r.enVigueur).length, total: regles.length };
}

// ─────────────────────────── Modifier, désactiver, supprimer ───────────────────────────

async function chargerPourEcrire(user: CurrentUser, id: string): Promise<{ ok: true; row: Row; vue: RegleVue } | EchecTeach> {
  const row = await prisma.adamRule.findUnique({ where: { id }, include: INCLURE });
  if (!row) return echec("NOT_FOUND", `La règle ${id} n'existe pas.`);
  const vue = versRegle(row);
  if (vue.scope === "PERSON" && vue.subjectUserId !== user.id && vue.ownerId !== user.id) return echec("MISSING_PERMISSION", "Cette règle personnelle n'est pas la vôtre.");
  const droit = await peutEnseigner(user, vue.scope, { companyId: vue.companyId, departmentId: vue.departmentId });
  if (!droit.ok) return droit;
  return { ok: true, row, vue };
}

export interface ModificationRegle {
  id: string;
  statement?: string | null;
  title?: string | null;
  params?: Record<string, unknown> | null;
  priorite?: number | null;
  domaine?: string | null;
  effectiveTo?: string | null;
  motif?: string | null;
}

/** MODIFIE = une nouvelle version. L'ancienne reste lisible, marquée SUPERSEDED. */
export async function modifierRegle(user: CurrentUser, m: ModificationRegle): Promise<RegleEnseignee | EchecTeach> {
  const c = await chargerPourEcrire(user, m.id);
  if (!c.ok) return c;
  if (c.vue.status !== "ACTIVE") return echec("CAPABILITY_FAILURE", `La règle ${m.id} est ${c.vue.statutLibelle} : réactivez-la ou enseignez-en une nouvelle.`);
  const rien = [m.statement, m.title, m.params, m.priorite, m.domaine, m.effectiveTo].every((x) => x === undefined || x === null);
  if (rien) return echec("MISSING_INPUT", "Rien à modifier : donnez le nouveau texte, la priorité, les paramètres, le domaine ou la fin de validité.");
  return enseigner(user, {
    statement: m.statement ?? c.vue.statement, title: m.title ?? c.vue.title, kind: c.vue.kind, scope: c.vue.scope,
    societe: c.vue.companyId, departement: c.vue.departmentId, domaine: m.domaine ?? c.vue.domain,
    params: m.params ?? c.vue.params, priorite: m.priorite ?? c.vue.priority,
    effectiveFrom: null, effectiveTo: m.effectiveTo === undefined ? (c.vue.effectiveTo ? c.vue.effectiveTo.toISOString() : null) : m.effectiveTo,
    remplaceId: c.vue.id, forcer: true,
    citation: m.motif ? `${m.motif}` : null,
    provenance: { ...(c.vue.provenance ?? {}), mode: "TAUGHT" },
  });
}

/** DÉSACTIVE, RÉACTIVE ou SUPPRIME. Supprimer n'efface pas : la ligne reste, en DELETED. */
export async function changerStatutRegle(user: CurrentUser, opts: { id: string; statut: "DISABLED" | "ACTIVE" | "DELETED"; motif?: string | null }): Promise<{ ok: true; regle: RegleVue } | EchecTeach> {
  const c = await chargerPourEcrire(user, opts.id);
  if (!c.ok) return c;
  if (c.vue.status === "DELETED") return echec("CAPABILITY_FAILURE", `La règle ${opts.id} est supprimée : elle ne change plus d'état.`);
  if (c.vue.status === "SUPERSEDED") return echec("CAPABILITY_FAILURE", `La règle ${opts.id} a été remplacée par une version plus récente : agir sur celle-ci.`);
  if (c.vue.status === opts.statut) return echec("CAPABILITY_FAILURE", `La règle ${opts.id} est déjà ${LIBELLE_STATUT[opts.statut]}.`);
  const row = await prisma.adamRule.update({ where: { id: opts.id }, data: { status: opts.statut, updatedById: user.id }, include: INCLURE });
  await recordAudit({
    actorId: user.id, action: opts.statut === "DELETED" ? "DELETE" : "UPDATE", module: "Assistant IA",
    summary: `Teach Adam — règle ${opts.id} ${LIBELLE_STATUT[opts.statut]}${opts.motif ? ` (${opts.motif.slice(0, 100)})` : ""} : ${c.vue.statement.slice(0, 120)}`,
  });
  return { ok: true, regle: versRegle(row) };
}
