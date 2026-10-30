import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { geste, retardJours, retardLabel } from "@/platform/ia/workspace/emit";
import {
  REG_STEPS, hasWorkflowState, regProgress, workflowAsSteps, type RegWorkflowState,
} from "@/lib/regulatory-workflow";

/**
 * LE POINT DE PASSAGE UNIQUE vers le circuit ANPP — ce fichier franchit DÉJÀ la frontière
 * Adam ↔ ERP pour lire `regulatory-workflow` ; les autres lecteurs d'Adam (inspect_record…)
 * passent par lui plutôt que d'ouvrir chacun un franchissement de plus. Le cliquet de
 * `src/platform/boundary.test.ts` compte les ARÊTES : une seule ici, zéro ailleurs.
 */
export { REG_STEPS, hasWorkflowState, regProgress, workflowAsSteps };
export type { RegWorkflowState };
import { REGULATORY_STATUS } from "@/lib/labels";
import { resolveOrg, coreTokens } from "@/platform/ia/lectures/entity-normalize";
import type { PowerTool, UtilisateurOutil as CurrentUser } from "@/platform/ia/outil";
import { regulatoryKnowledgeDigest } from "@/lib/regulatory/anpp-knowledge";
import { sansBloquer } from "@/lib/journal";

/**
 * LECTURES REGULATORY CANONIQUES DU CHIEF OF STAFF — la réponse à la panne réelle :
 * « Combien de dossiers Amel gère ? » → « 141 » (tous les produits ACCESSIBLES).
 *
 * GÉRER ≠ POUVOIR VOIR. La colonne « Chargé du dossier » de l'écran (responsibleId) est LA
 * définition de l'assignation directe ; `assignedUsers` n'est qu'un droit de lecture ligne à
 * ligne, et le pipeline entier n'est le portefeuille de personne. Ces outils comptent donc,
 * SÉPARÉMENT et en le disant :
 *   • dossiers dont la personne est RESPONSABLE (elle les « gère ») ;
 *   • dossiers où elle ASSISTE (assistantId) ;
 *   • dossiers auxquels elle a simplement ACCÈS (à ne JAMAIS présenter comme gérés).
 *
 * Le périmètre est CELUI DE L'ÉCRAN (`regulatoryVisibleWhere`) : le Chief ne contredit pas le
 * tableau Regulatory, il lit la même clause. La fraîcheur est dite (données relues à l'instant).
 */

const st = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const statusLabel = (s: string): string => REGULATORY_STATUS[s]?.label ?? s;

/**
 * LA CHARGE RÉGLEMENTAIRE D'UNE PERSONNE — lue pour la fiche, pas pour la réponse.
 *
 * Deux comptes rapides dans le périmètre VISIBLE de celui qui demande : le cloisonnement de
 * l'écran Regulatory s'applique tel quel, donc la fiche ne peut pas révéler l'existence de
 * dossiers que cette personne n'aurait pas le droit de voir.
 *
 * POURQUOI ICI ET PAS DANS L'ANNUAIRE. C'est une lecture REGULATORY : elle appartient au
 * module qui lit déjà la clause de visibilité de cet écran. L'annuaire l'appelle. Le mettre
 * là-bas aurait fait traverser la frontière Adam ↔ ERP une fois de plus, pour une clause que
 * ce fichier-ci connaît déjà — le cliquet de `src/platform/boundary.test.ts` l'a signalé.
 */
export async function personRegulatoryLoad(
  name: string,
  user: CurrentUser,
): Promise<{ total: number; enRetard: number; actif: boolean; href: string | null } | null> {
  const account = await prisma.user.findFirst({
    where: { name: { contains: name, mode: "insensitive" }, isActive: true },
    select: { id: true, isActive: true },
  }).catch(sansBloquer("regulatory-read.personRegulatoryLoad.user", null));
  if (!account) return null;
  if (!userCan(user, "REGULATORY", "VIEW")) return { total: 0, enRetard: 0, actif: account.isActive, href: null };

  const visible = await regulatoryVisibleWhere(user);
  const now = new Date();
  const [total, enRetard] = await Promise.all([
    prisma.regulatoryProduct.count({ where: { AND: [visible as never, { responsibleId: account.id }] } }),
    prisma.regulatoryProduct.count({
      where: {
        AND: [
          visible as never,
          { responsibleId: account.id },
          { status: { notIn: ["CLOSED", "DECISION_OBTAINED"] } },
          { OR: [{ targetDate: { lt: now } }, { AND: [{ targetDate: null }, { targetSubmissionDate: { lt: now } }] }] },
        ],
      },
    }),
  ]).catch(sansBloquer("regulatory-read.personRegulatoryLoad.regulatoryProduct", [0, 0]));
  return { total, enRetard, actif: account.isActive, href: null };
}

/** L'étape LOGIQUE d'un dossier depuis son workflow JSON — « TERMINÉ » quand tout est fait. */
export function dossierStageLabel(workflow: unknown): { etape: string; avancement: string } {
  const p = regProgress((workflow ?? null) as RegWorkflowState | null);
  return {
    etape: p.current ? `${p.current.n}. ${p.current.label}` : (p.done === p.total ? "TERMINÉ (processus complet)" : "—"),
    avancement: `${p.done}/${p.total}`,
  };
}

export interface AssigneeLoad {
  total: number;
  parStatut: Record<string, number>;
  enRetardCible: number;
  liste: {
    id: string;
    reference: string; produit: string; statut: string; etape: string;
    avancement: string; responsableDepuis?: string | null; cible: string | null;
    /** Jours de retard sur la cible, `null` si à l'heure ou dossier clos. */
    retardJours: number | null;
    lien: string;
  }[];
}

/**
 * LA CHARGE DIRECTE d'une personne — le décompte partagé par `employee_360` et
 * `regulatory_workload` (une seule définition, jamais deux). `where` = périmètre écran de
 * l'APPELANT : on ne révèle pas à quelqu'un plus que son propre tableau.
 */
export async function assigneeRegulatoryLoad(
  responsibleId: string,
  visibleWhere: Record<string, unknown>,
  cap = 15,
): Promise<AssigneeLoad> {
  const now = new Date();
  const rows = await prisma.regulatoryProduct.findMany({
    where: { AND: [visibleWhere, { responsibleId }] },
    select: {
      id: true,
      reference: true, dci: true, brandName: true, status: true, workflow: true,
      targetDate: true, targetSubmissionDate: true, updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  const parStatut: Record<string, number> = {};
  let late = 0;
  for (const r of rows) {
    const label = statusLabel(r.status);
    parStatut[label] = (parStatut[label] ?? 0) + 1;
    const target = r.targetDate ?? r.targetSubmissionDate;
    if (target && target < now && r.status !== "DECISION_OBTAINED" && r.status !== "CLOSED") late += 1;
  }
  return {
    total: rows.length,
    parStatut,
    enRetardCible: late,
    liste: rows.slice(0, cap).map((r) => {
      const stage = dossierStageLabel(r.workflow);
      const cible = r.targetDate ?? r.targetSubmissionDate;
      const clos = r.status === "DECISION_OBTAINED" || r.status === "CLOSED";
      return {
        id: r.id,
        reference: r.reference,
        produit: r.brandName ? `${r.dci} (${r.brandName})` : r.dci,
        statut: statusLabel(r.status),
        etape: stage.etape,
        avancement: stage.avancement,
        cible: cible?.toISOString().slice(0, 10) ?? null,
        // LE RETARD EN JOURS, pas la date cible : « 4 jours » se lit, « 22/08/2025 » se calcule.
        retardJours: clos ? null : retardJours(cible ?? null, now),
        lien: `/regulatory/${r.id}`,
      };
    }),
  };
}

/** Résout un nom de personne vers des comptes (User) — candidats explicites si ambigu. */
async function resolveUserByName(name: string): Promise<{ id: string; name: string }[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true, name: { contains: name, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 6,
  });
  if (users.length) return users;
  // Le registre RH connaît parfois un nom que le compte n'affiche pas (nom complet vs abrégé).
  const emps = await prisma.employee.findMany({
    where: { fullName: { contains: name, mode: "insensitive" }, user: { isNot: null } },
    select: { user: { select: { id: true, name: true } } },
    take: 6,
  });
  return emps.flatMap((e) => (e.user ? [{ id: e.user.id, name: e.user.name }] : []));
}

/**
 * LE CADRE RÉGLEMENTAIRE SE LIT, IL NE SE RÉCITE PAS.
 *
 * Le digest ANPP (droits, délais, CTD, modifications, décision, refus) partait dans CHAQUE prompt
 * système d'un lecteur Regulatory — 3 000 jetons payés à chaque tour, y compris pour « bonjour ».
 * C'est de la CONNAISSANCE : elle vit dans les données (le même texte est ingéré au corpus) et se
 * sert à la demande, par section. Le prompt ne garde que la règle : le lire avant de citer.
 */
const SECTIONS_CONNAISSANCE: Record<string, RegExp> = {
  droits: /^DROITS D'ENREGISTREMENT/m,
  delais: /^PARCOURS ET DÉLAIS LÉGAUX/m,
  ctd: /^DOSSIER AU FORMAT CTD/m,
  presoumission: /^PRÉ-SOUMISSION/m,
  modifications: /^MODIFICATIONS POST-ENREGISTREMENT/m,
  decision: /^DÉCISION D'ENREGISTREMENT/m,
  refus: /^MOTIFS DE REFUS/m,
};

export function extraireConnaissanceReglementaire(sujet: string | null | undefined): string {
  const digest = regulatoryKnowledgeDigest();
  const cle = (sujet ?? "").trim().toLowerCase();
  if (!cle || cle === "tout" || !(cle in SECTIONS_CONNAISSANCE)) return digest;
  // Une section va de son titre au prochain titre EN MAJUSCULES suivi de deux-points (ou à la fin).
  const lignes = digest.split("\n");
  const debut = lignes.findIndex((l) => SECTIONS_CONNAISSANCE[cle].test(l));
  if (debut < 0) return digest;
  const fin = lignes.findIndex((l, i) => i > debut && /^[A-ZÉÈÀÂÎÔÛÇ' ()/-]{8,}:/.test(l) && !/^ /.test(l));
  const entete = lignes.slice(0, 3).join("\n");
  return `${entete}\n\n${lignes.slice(debut, fin < 0 ? undefined : fin).join("\n").trim()}`;
}

export const REGULATORY_READ_TOOLS: PowerTool[] = [
  {
    def: {
      name: "regulatory_knowledge",
      description:
        "LE CADRE RÉGLEMENTAIRE ALGÉRIEN (ANPP) — droits d'enregistrement (bordereaux 25 % / 75 %, autres droits), parcours et " +
        "délais légaux, modules CTD et règles de forme, pré-soumission, modifications post-enregistrement, décision et motifs de refus, " +
        "avec les textes (décret 20-325, arrêtés 2021, loi 18-11). À LIRE avant de citer un article, un délai ou un montant : " +
        "ne jamais les réciter de mémoire. `sujet` cible une section (droits, delais, ctd, presoumission, modifications, decision, refus) ; sans lui, tout le cadre.",
      input_schema: {
        type: "object",
        properties: {
          sujet: { type: "string", description: "droits | delais | ctd | presoumission | modifications | decision | refus | tout" },
        },
      },
    },
    allowed: (u) => userCan(u, "REGULATORY", "VIEW"),
    label: "Cadre réglementaire consulté",
    run: async (input) => extraireConnaissanceReglementaire(typeof input.sujet === "string" ? input.sujet : null),
  },

  // ───────────────────────── CHARGE PAR PERSONNE (assignation DIRECTE) ─────────────────────────
  {
    def: {
      name: "regulatory_workload",
      description:
        "CHARGE REGULATORY par personne — répond à « combien de dossiers gère X ? » et « qui porte quoi ? » avec la SEULE " +
        "définition correcte : les dossiers dont la personne est RESPONSABLE DÉSIGNÉE (colonne « Chargé du dossier » de l'écran). " +
        "Sépare explicitement : gérés (responsable) / assiste (assistante) / simple ACCÈS (jamais comptés comme gérés). " +
        "Sans `person` : la répartition de TOUTE l'équipe (dossiers directs par personne + non assignés) — la matière de " +
        "« est-ce que Regulatory est surchargé ? ». Périmètre = votre écran Regulatory, relu à l'instant.",
      input_schema: {
        type: "object",
        properties: {
          person: { type: "string", description: "Nom (ou fragment) de la personne. Omettre pour la vue d'équipe." },
        },
      },
    },
    allowed: (u) => userCan(u, "REGULATORY", "VIEW"),
    label: "Charge Regulatory (assignations directes)",
    run: async (input, user) => {
      const visible = await regulatoryVisibleWhere(user);
      const person = st(input, "person");
      const now = new Date().toISOString();

      if (!person) {
        // VUE D'ÉQUIPE : répartition des dossiers par RESPONSABLE désigné, dans le périmètre.
        const grouped = await prisma.regulatoryProduct.groupBy({
          by: ["responsibleId"],
          where: visible as never,
          _count: { _all: true },
        });
        const ids = grouped.map((g) => g.responsibleId).filter((x): x is string => Boolean(x));
        const users = ids.length
          ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          : [];
        const nameOf = new Map(users.map((u2) => [u2.id, u2.name]));
        const open = await prisma.regulatoryProduct.groupBy({
          by: ["responsibleId"],
          where: { AND: [visible as never, { status: { notIn: ["DECISION_OBTAINED", "CLOSED"] } }] },
          _count: { _all: true },
        });
        const openOf = new Map(open.map((g) => [g.responsibleId ?? "∅", g._count._all]));
        const rows = grouped
          .map((g) => ({
            personne: g.responsibleId ? nameOf.get(g.responsibleId) ?? "compte inconnu" : "NON ASSIGNÉ",
            dossiersGeres: g._count._all,
            dontOuverts: openOf.get(g.responsibleId ?? "∅") ?? 0,
          }))
          .sort((a, b) => b.dossiersGeres - a.dossiersGeres);
        return JSON.stringify({
          definition: "dossiers GÉRÉS = responsable DÉSIGNÉ du dossier (colonne « Chargé du dossier ») — jamais le simple accès",
          repartition: rows,
          fraicheur: { source: "table Regulatory (périmètre de votre écran)", luLe: now },
        });
      }

      /**
       * UNE SEULE FORME (§118.20) : cet outil rendait une PHRASE sur une personne inconnue,
       * `{ambigu, candidats}` sur une homonymie, et un grand objet quand il trouvait. Un plan
       * qui écrit `{{charge.dossiersGeresDirectement.total}}` mourait sur l'homonymie ; un plan
       * qui écrit `{{charge.candidats}}` mourait quand la recherche réussissait. Les clés ne
       * changent plus, `retenu` porte la personne sur qui AGIR (§118.34) — un élément quand
       * c'est certain, liste VIDE sinon —, et `precision` dit toujours ce qui s'est passé.
       */
      const repondrePersonne = (r: Partial<Record<string, unknown>> & { precision: string }): string =>
        JSON.stringify({
          personne: null, retenu: [], candidats: [],
          dossiersGeresDirectement: null, assistantSur: null, accesSansResponsabilite: null,
          fraicheur: { source: "table Regulatory (périmètre de votre écran)", luLe: now },
          ...r,
        });

      const candidates = await resolveUserByName(person);
      if (!candidates.length) {
        return repondrePersonne({
          precision: `Aucune personne active « ${person} » (comptes et registre RH consultés). `
            + "La charge est vide parce que la PERSONNE est introuvable, pas parce qu'elle n'a aucun dossier.",
        });
      }
      if (candidates.length > 1 && new Set(candidates.map((c) => c.id)).size > 1) {
        // Plusieurs homonymes : on les NOMME et `retenu` reste vide — désigner à la place d'un
        // humain est exactement ce que §118.34 interdit.
        return repondrePersonne({
          candidats: candidates.map((c) => c.name),
          precision: `${candidates.length} personnes correspondent à « ${person} » — préciser le nom. Aucune n'est retenue.`,
        });
      }

      const target = candidates[0];
      const [load, assistantOn, accessOnly] = await Promise.all([
        assigneeRegulatoryLoad(target.id, visible as Record<string, unknown>),
        prisma.regulatoryProduct.count({ where: { AND: [visible as never, { assistantId: target.id }] } }),
        prisma.regulatoryProduct.count({
          where: {
            AND: [
              visible as never,
              { assignedUsers: { some: { id: target.id } } },
              // « not » Prisma exclut les NULL : un dossier SANS responsable est bien un accès
              // sans responsabilité — l'OR avec null les garde.
              { OR: [{ responsibleId: null }, { responsibleId: { not: target.id } }] },
              { OR: [{ assistantId: null }, { assistantId: { not: target.id } }] },
            ],
          },
        }),
      ]);

      /**
       * LE TABLEAU DE SES DOSSIERS — avec, sur chaque ligne, la sortie qui va avec.
       *
       * Quand la question portait sur les RETARDS, le tableau ne montre que ceux-là : afficher
       * les douze dossiers quand on en a demandé trois oblige à chercher dans la réponse.
       */
      const veutRetards = /retard|en r[ée]tard|bloqu|urgent/i.test(person + " " + st(input, "focus"));
      const lignes = load.liste.filter((d) => (veutRetards ? d.retardJours !== null : true));
      const bloc = lignes.length >= 1
        ? {
            kind: "table",
            title: veutRetards ? `Dossiers en retard — ${target.name}` : `Dossiers de ${target.name}`,
            columns: [
              { key: "reference", label: "Dossier" },
              { key: "produit", label: "Produit" },
              { key: "retard", label: "Retard", badge: true },
              { key: "etape", label: "Étape actuelle" },
            ],
            rows: lignes.map((d) => ({
              cells: {
                reference: d.reference, produit: d.produit,
                retard: d.retardJours ? retardLabel(d.retardJours) : "à l'heure",
                etape: d.etape,
              },
              tons: d.retardJours ? { retard: "alerte" } : { retard: "succes" },
              href: d.lien,
              actions: [geste("Ouvrir", `Ouvre ${d.reference}`)],
            })),
            total: lignes.length,
            ...(veutRetards && load.total > lignes.length
              ? { actions: [geste(`Voir tous ses dossiers (${load.total})`, `Montre tous les dossiers de ${target.name}, dans un tableau`)] }
              : {}),
          }
        : null;

      return repondrePersonne({
        personne: target.name,
        retenu: [{ nom: target.name, id: target.id }],
        precision: `Charge Regulatory de ${target.name} : dossiers dont elle est RESPONSABLE DÉSIGNÉE, `
          + "assistanat et accès sans responsabilité comptés séparément — un accès n'est pas une charge.",
        dossiersGeresDirectement: {
          definition: "dossiers dont elle est RESPONSABLE DÉSIGNÉE (colonne « Chargé du dossier » de l'écran)",
          total: load.total,
          parStatut: load.parStatut,
          enRetardSurCible: load.enRetardCible,
          liste: load.liste,
        },
        ...(bloc ? { _blocs: [bloc] } : {}),
        assisteSur: assistantOn,
        accesSansResponsabilite: {
          total: accessOnly,
          regle: "ACCÈS ≠ GESTION — ne JAMAIS présenter ces dossiers comme « gérés » par la personne",
        },
        fraicheur: { source: "table Regulatory (périmètre de votre écran)", luLe: new Date().toISOString() },
      });
    },
  },

  // ───────────────────────── PORTEFEUILLE PAR PARTENAIRE ─────────────────────────
  {
    def: {
      name: "regulatory_portfolio",
      description:
        "PORTEFEUILLE REGULATORY d'un PARTENAIRE / laboratoire — « les produits Kwality et leurs statuts », « et SD ? ». " +
        "Résout le nom contre les partenaires RÉELS de la base (graphies, acronymes : « SD » ↔ « S.D. Pharmaceuticals ») " +
        "avec un score — en cas d'ambiguïté réelle, les candidats sont listés au lieu d'un choix silencieux. " +
        "Renvoie les dossiers du partenaire (statut, étape, avancement, responsable) dans le périmètre de votre écran.",
      input_schema: {
        type: "object",
        properties: {
          partner: { type: "string", description: "Nom du partenaire / laboratoire (même approximatif ou en sigle)." },
        },
        required: ["partner"],
      },
    },
    allowed: (u) => userCan(u, "REGULATORY", "VIEW"),
    label: "Portefeuille Regulatory par partenaire",
    run: async (input, user) => {
      const partner = st(input, "partner");
      if (partner.length < 2) return "Donnez le nom du partenaire.";
      const visible = await regulatoryVisibleWhere(user);

      // Les partenaires RÉELS du périmètre — la résolution se fait contre EUX, pas dans le vide.
      const distinct = await prisma.regulatoryProduct.findMany({
        where: { AND: [visible as never, { partnerLab: { not: null } }] },
        select: { partnerLab: true },
        distinct: ["partnerLab"],
        take: 400,
      });
      const values = distinct.map((d) => d.partnerLab).filter((x): x is string => Boolean(x && x.trim()));
      if (!values.length) {
        return JSON.stringify({
          reponse: "Aucun partenaire renseigné sur les dossiers de votre périmètre.",
          couverture: { source: "champ « Laboratoire partenaire » de la table Regulatory", luLe: new Date().toISOString() },
        });
      }

      const resolution = resolveOrg(partner, values);
      if (resolution.kind === "none") {
        return JSON.stringify({
          reponse: `Aucun partenaire ne correspond à « ${partner} » dans votre périmètre.`,
          partenairesExistants: values.slice(0, 12).sort(),
          consigne: "Vérifier l'orthographe ou choisir dans la liste — ne pas conclure « aucune trace » au-delà de ce champ sans chercher ailleurs (search_everything, find_documents).",
        });
      }
      if (resolution.kind === "ambiguous") {
        return JSON.stringify({
          ambigu: `Plusieurs partenaires plausibles pour « ${partner} » — préciser.`,
          candidats: resolution.candidates.map((c) => ({ nom: c.value, score: Math.round(c.score * 100) / 100, pourquoi: c.why })),
        });
      }

      // DECISIVE : toutes les graphies du MÊME partenaire (même cœur de nom) sont incluses.
      const best = resolution.best!;
      const core = coreTokens(best.value).join(" ");
      const matched = values.filter((v) => coreTokens(v).join(" ") === core);
      const rows = await prisma.regulatoryProduct.findMany({
        where: { AND: [visible as never, { partnerLab: { in: matched } }] },
        select: {
          id: true, reference: true, dci: true, brandName: true, dosage: true, dosageUnit: true,
          pharmaceuticalForm: true, status: true, workflow: true, targetDate: true,
          company: { select: { shortName: true, name: true } },
          responsible: { select: { name: true } },
        },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        take: 60,
      });
      const parStatut: Record<string, number> = {};
      for (const r of rows) parStatut[statusLabel(r.status)] = (parStatut[statusLabel(r.status)] ?? 0) + 1;

      return JSON.stringify({
        partenaire: {
          demande: partner,
          resolu: best.value,
          graphiesIncluses: matched,
          confiance: { score: Math.round(best.score * 100) / 100, pourquoi: best.why },
        },
        total: rows.length,
        parStatut,
        dossiers: rows.slice(0, 40).map((r) => {
          const stage = dossierStageLabel(r.workflow);
          return {
            reference: r.reference,
            produit: r.brandName ? `${r.dci} (${r.brandName})` : r.dci,
            dosage: r.dosage ? `${r.dosage}${r.dosageUnit ? ` ${r.dosageUnit}` : ""}` : null,
            forme: r.pharmaceuticalForm,
            entite: r.company?.shortName ?? r.company?.name ?? null,
            statut: statusLabel(r.status),
            etape: stage.etape,
            avancement: stage.avancement,
            responsable: r.responsible?.name ?? "non assigné",
            cible: r.targetDate?.toISOString().slice(0, 10) ?? null,
            lien: `/regulatory/${r.id}`,
          };
        }),
        fraicheur: { source: "table Regulatory (périmètre de votre écran)", luLe: new Date().toISOString() },
      });
    },
  },
];
