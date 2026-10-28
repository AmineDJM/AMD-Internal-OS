import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { ensureNodeIndexed } from "@/lib/assistant/document-discovery";
import { DOC_KIND_LABEL, type DocKind } from "@/platform/doc-kind";
import { orgTokens, rankOrgCandidates } from "@/lib/assistant/entity-normalize";
import type { PowerTool } from "@/lib/assistant/power-tools";
import { sansBloquer } from "@/lib/journal";

/**
 * INVESTIGATIONS — deux pannes réelles corrigées à la racine :
 *
 *   • « Quand est la grande journée nationale de la SAI ? » → « aucune trace » après UNE table.
 *     Un événement n'est PAS une ligne de la table Events : il laisse des traces dans le
 *     sponsoring, le calendrier, les courriers, les paiements, les réunions, les tâches, le
 *     Drive. `investigate_event` interroge TOUTES ces sources EN PARALLÈLE, résout les
 *     acronymes contre les organisations réellement rencontrées, et rend sa COUVERTURE :
 *     « aucune trace » n'est prononçable qu'après la liste complète.
 *
 *   • « Qui a uploadé le dossier Direction Générale ? Combien de BC dedans ? » → réponse sur
 *     le dossier seul, puis « veux-tu que j'explore ? ». La question IMPLIQUE l'exploration :
 *     `inspect_drive_folder` traverse récursivement (borné), agrège les DÉPOSANTS réels
 *     (FileVersion.createdById), classe les contenus (BC STRICTS ≠ assimilés) et répond à
 *     TOUT en un tour. L'ACL Drive est revérifiée nœud par nœud — jamais le contenu d'autrui.
 */

const st = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Les jetons de recherche d'une entité/description — insensibles aux accents via `mode: insensitive`. */
function searchTokens(...parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    for (const t of orgTokens(p)) {
      if (t.length < 3 && out.length) continue; // les sigles courts passent s'ils sont seuls
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out.slice(0, 6);
}

/** OR Prisma « un des jetons dans un des champs » — la brique des recherches fédérées. */
function tokensWhere(tokens: string[], fields: string[]): Record<string, unknown> {
  return {
    OR: tokens.flatMap((t) => fields.map((f) => ({ [f]: { contains: t, mode: "insensitive" } }))),
  };
}

export const INVESTIGATION_TOOLS: PowerTool[] = [
  // ───────────────────────── ÉVÉNEMENT MULTI-SOURCES ─────────────────────────
  {
    def: {
      name: "investigate_event",
      description:
        "RECONSTITUE un événement métier depuis TOUTES ses traces — « quand est la journée de X ? », « où en est le congrès Y ? ». " +
        "Un événement n'est pas qu'une ligne d'agenda : l'outil fouille EN PARALLÈLE les événements, le sponsoring, le calendrier, " +
        "les courriers, les réunions, les tâches, les paiements et le Drive, avec résolution des ACRONYMES contre les organisations " +
        "réellement rencontrées (« SAI » ↔ « Société Algérienne d'Infectiologie »). Rend la COUVERTURE des sources : ne JAMAIS " +
        "conclure « aucune trace » sans elle. Une précision (« non, la grande journée ») change la description, PAS l'organisation.",
      input_schema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Organisation / société savante / partenaire concerné (nom ou sigle)." },
          description: { type: "string", description: "Ce qu'on cherche (« journée nationale », « congrès annuel »…) — optionnel." },
        },
        required: ["entity"],
      },
    },
    allowed: (u) => userCan(u, "CHIEF_OF_STAFF", "VIEW"),
    label: "Investigation d'événement (multi-sources)",
    run: async (input, user) => {
      const entity = st(input, "entity");
      const description = st(input, "description");
      if (entity.length < 2) return "Donnez l'organisation ou le sigle de l'événement recherché.";

      // 1) RÉSOLUTION D'ACRONYME contre les organisations réellement présentes dans les données
      //    (événements + institutions + sponsoring) — générale, aucun nom en dur.
      const [evNames, instNames, sponsInst] = await Promise.all([
        prisma.event.findMany({ select: { name: true }, take: 300, orderBy: { updatedAt: "desc" } }),
        prisma.medicalInstitution.findMany({ select: { name: true }, take: 300 }).catch(sansBloquer("investigation.run.medicalInstitution", [] as { name: string }[])),
        prisma.sponsoringRequest.findMany({ select: { institution: true }, distinct: ["institution"], take: 300 }),
      ]);
      const knownOrgs = [
        ...new Set([
          ...evNames.map((e) => e.name),
          ...instNames.map((i) => i.name),
          ...sponsInst.map((s) => s.institution),
        ].filter(Boolean)),
      ];
      const ranked = rankOrgCandidates(entity, knownOrgs);
      // Les libellés à chercher : l'entité TELLE QUELLE + ses meilleures expansions.
      const aliases = [entity, ...ranked.filter((r) => r.score >= 0.6).slice(0, 3).map((r) => r.value)];
      const tokens = searchTokens(...aliases);
      if (!tokens.length) return "Entité illisible.";
      const desc = description ? searchTokens(description) : [];

      // 2) TOUTES LES SOURCES EN PARALLÈLE — chacune bornée, chacune nommée dans la couverture.
      const [events, sponsoring, calendar, mails, meetings, tasks, payments, driveNodes] = await Promise.all([
        prisma.event.findMany({
          where: tokensWhere(tokens, ["name", "description", "location", "specialty"]) as never,
          select: { id: true, name: true, type: true, status: true, startDate: true, endDate: true, location: true, city: true },
          take: 8, orderBy: { startDate: "desc" },
        }),
        prisma.sponsoringRequest.findMany({
          where: tokensWhere(tokens, ["institution", "description", "doctor", "specialty"]) as never,
          select: { id: true, reference: true, institution: true, type: true, description: true, requestDate: true, status: true },
          take: 8, orderBy: { requestDate: "desc" },
        }),
        prisma.calendarEvent.findMany({
          where: tokensWhere(tokens, ["title", "description", "location"]) as never,
          select: { id: true, title: true, startAt: true, location: true },
          take: 8, orderBy: { startAt: "desc" },
        }),
        prisma.mailEntry.findMany({
          where: tokensWhere(tokens, ["title", "sender", "recipient"]) as never,
          select: { id: true, reference: true, title: true, direction: true, sentAt: true, receivedAt: true },
          take: 8, orderBy: { createdAt: "desc" },
        }),
        prisma.meeting.findMany({
          where: tokensWhere(tokens, ["title", "description"]) as never,
          select: { id: true, title: true, status: true, createdAt: true },
          take: 6, orderBy: { createdAt: "desc" },
        }),
        prisma.task.findMany({
          where: tokensWhere(tokens, ["title", "description"]) as never,
          select: { id: true, title: true, status: true, dueDate: true },
          take: 6, orderBy: { updatedAt: "desc" },
        }),
        prisma.paymentRequest.findMany({
          where: tokensWhere(tokens, ["title", "payee"]) as never,
          select: { id: true, reference: true, title: true, status: true, amount: true },
          take: 6, orderBy: { createdAt: "desc" },
        }).catch(sansBloquer("investigation.run.paymentRequest", [])),
        prisma.driveNode.findMany({
          where: { AND: [{ isTrashed: false }, tokensWhere(tokens, ["name"]) as never] },
          select: { id: true, name: true, type: true, updatedAt: true },
          take: 8, orderBy: { updatedAt: "desc" },
        }),
      ]);

      // ACL Drive : jamais un nom de fichier d'autrui dans la réponse.
      const visibleDrive: typeof driveNodes = [];
      for (const n of driveNodes) {
        if (canViewDrive(await resolveDriveAccess(user, n.id))) visibleDrive.push(n);
      }

      const descMatch = (s: string | null | undefined) =>
        !desc.length || desc.some((d) => (s ?? "").toLowerCase().includes(d));

      const traces = {
        evenements: events.filter((e) => descMatch(`${e.name} ${e.location ?? ""}`)).map((e) => ({
          nom: e.name, type: e.type, statut: e.status, du: ymd(e.startDate), au: ymd(e.endDate),
          lieu: [e.location, e.city].filter(Boolean).join(", ") || null, lien: `/events/${e.id}`,
        })),
        sponsoring: sponsoring.map((s) => ({
          reference: s.reference, institution: s.institution, type: s.type, statut: s.status,
          demandeLe: ymd(s.requestDate), description: s.description?.slice(0, 160) ?? null,
        })),
        calendrier: calendar.map((c) => ({ titre: c.title, le: ymd(c.startAt), lieu: c.location })),
        courriers: mails.map((m) => ({ reference: m.reference, titre: m.title, sens: m.direction, le: ymd(m.sentAt ?? m.receivedAt) })),
        reunions: meetings.map((m) => ({ titre: m.title, statut: m.status, cree: ymd(m.createdAt) })),
        taches: tasks.map((t) => ({ titre: t.title, statut: t.status, echeance: ymd(t.dueDate) })),
        paiements: payments.map((p) => ({ reference: p.reference, titre: p.title, statut: p.status })),
        drive: visibleDrive.map((n) => ({ nom: n.name, type: n.type, lien: `/drive/${n.id}` })),
      };
      const total = Object.values(traces).reduce((n, arr) => n + arr.length, 0);

      return JSON.stringify({
        recherche: {
          entite: entity,
          resolutionOrganisation: ranked.slice(0, 3).map((r) => ({ nom: r.value, score: Math.round(r.score * 100) / 100, pourquoi: r.why })),
          jetons: tokens,
        },
        traces,
        couverture: {
          sourcesInterrogees: ["événements", "sponsoring", "calendrier", "courriers", "réunions", "tâches", "paiements", "Drive (noms, ACL vérifiée)"],
          sourcesNonInterrogees: ["contenu INTÉGRAL des documents Drive (utiliser find_documents pour le contenu)", "e-mails externes"],
          totalTraces: total,
        },
        ...(total === 0
          ? { reponse: "AUCUNE TRACE dans les 8 sources interrogées — le dire avec la couverture ci-dessus, et proposer find_documents (contenu des fichiers) avant toute conclusion définitive." }
          : { consigne: "Reconstituer la réponse depuis les traces (dates du calendrier/événement d'abord, sponsoring et courriers comme corroboration). Citer les sources." }),
      });
    },
  },

  // ───────────────────────── DOSSIER DRIVE RÉCURSIF ─────────────────────────
  {
    def: {
      name: "inspect_drive_folder",
      description:
        "EXPLORE un dossier du Drive RÉCURSIVEMENT en un appel — « qui a uploadé ? », « combien de BC dedans ? », « qu'est-ce qu'il y a dans X ? ». " +
        "Rend : arborescence agrégée (bornée), DÉPOSANTS réels par fichier (qui a téléversé), classification par NATURE " +
        "(BC STRICTS distingués des documents assimilés — proforma, devis, factures), tailles, dernière activité. " +
        "Répondre à TOUTES les parties de la question en un tour — ne pas demander la permission d'explorer. ACL vérifiée nœud par nœud.",
      input_schema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Nom (ou fragment) du dossier — ou son id Drive." },
        },
        required: ["folder"],
      },
    },
    allowed: (u) => userCan(u, "DRIVE", "VIEW"),
    label: "Exploration récursive d'un dossier Drive",
    run: async (input, user) => {
      const folder = st(input, "folder");
      if (folder.length < 2) return "Donnez le nom du dossier à explorer.";

      // Résoudre le dossier : id exact, sinon nom (dossiers seulement), ACL d'abord.
      const candidates = await prisma.driveNode.findMany({
        where: {
          isTrashed: false, type: "FOLDER",
          OR: [{ id: folder }, { name: { contains: folder, mode: "insensitive" } }],
        },
        select: { id: true, name: true, parentId: true },
        take: 8, orderBy: { updatedAt: "desc" },
      });
      const readable: typeof candidates = [];
      for (const c of candidates) {
        if (canViewDrive(await resolveDriveAccess(user, c.id))) readable.push(c);
      }
      if (!readable.length) return `Aucun dossier « ${folder} » accessible à votre compte dans le Drive.`;
      if (readable.length > 1 && !candidates.some((c) => c.id === folder)) {
        return JSON.stringify({
          ambigu: `${readable.length} dossiers accessibles portent ce nom — préciser (ou donner l'id).`,
          candidats: readable.map((c) => ({ nom: c.name, id: c.id, lien: `/drive/${c.id}` })),
        });
      }
      const root = candidates.find((c) => c.id === folder) ?? readable[0];

      // TRAVERSÉE BORNÉE : profondeur ≤ 6, ≤ 400 nœuds — un Drive entier ne part pas en réponse.
      const MAX_NODES = 400;
      const files: { id: string; name: string; size: number; updatedAt: Date; uploaderId: string | null; docKind: string | null; indexed: boolean }[] = [];
      const subfolders: string[] = [];
      let frontier = [root.id];
      let truncated = false;
      let visited = 0;
      for (let depth = 0; depth < 6 && frontier.length; depth++) {
        const children = await prisma.driveNode.findMany({
          where: { parentId: { in: frontier }, isTrashed: false },
          select: {
            id: true, name: true, type: true, size: true, updatedAt: true, ownerId: true,
            versions: { orderBy: { version: "desc" }, take: 1, select: { createdById: true } },
            textIndex: { select: { docKind: true } },
          },
          take: MAX_NODES,
        });
        frontier = [];
        for (const c of children) {
          visited += 1;
          if (visited > MAX_NODES) { truncated = true; break; }
          if (c.type === "FOLDER") { subfolders.push(c.name); frontier.push(c.id); continue; }
          files.push({
            id: c.id, name: c.name, size: c.size, updatedAt: c.updatedAt,
            uploaderId: c.versions[0]?.createdById ?? c.ownerId ?? null,
            docKind: c.textIndex?.docKind ?? null,
            indexed: Boolean(c.textIndex),
          });
        }
        if (truncated) break;
      }

      // CLASSIFICATION à la volée (bornée) des fichiers jamais indexés : le nom n'est qu'un
      // indice — l'indexation lit le contenu quand le blob est disponible.
      let indexedNow = 0;
      for (const f of files.filter((x) => !x.indexed).slice(0, 25)) {
        const ok = await ensureNodeIndexed(f.id).catch(sansBloquer("investigation.run.ensureNodeIndexed", false));
        if (ok) {
          indexedNow += 1;
          const row = await prisma.driveTextIndex.findUnique({ where: { nodeId: f.id }, select: { docKind: true } });
          f.docKind = row?.docKind ?? f.docKind;
        }
      }

      // DÉPOSANTS réels — noms résolus en un appel.
      const uploaderIds = [...new Set(files.map((f) => f.uploaderId).filter((x): x is string => Boolean(x)))];
      const uploaders = uploaderIds.length
        ? await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true } })
        : [];
      const nameOf = new Map(uploaders.map((u2) => [u2.id, u2.name]));
      const parDeposant: Record<string, number> = {};
      for (const f of files) {
        const n = f.uploaderId ? nameOf.get(f.uploaderId) ?? "compte inconnu" : "inconnu (import)";
        parDeposant[n] = (parDeposant[n] ?? 0) + 1;
      }

      // COMPTES PAR NATURE : BC STRICTS ≠ assimilés (§ « combien de BC ? » a trois réponses).
      const parNature: Record<string, number> = {};
      for (const f of files) {
        const label = f.docKind ? DOC_KIND_LABEL[f.docKind as DocKind] ?? f.docKind : "non classé (contenu non indexé)";
        parNature[label] = (parNature[label] ?? 0) + 1;
      }
      const bcStricts = files.filter((f) => f.docKind === "purchase_order").length;
      const assimiles = files.filter((f) => f.docKind === "quote" || f.docKind === "invoice").length;

      return JSON.stringify({
        dossier: { nom: root.name, lien: `/drive/${root.id}` },
        contenu: {
          fichiers: files.length,
          sousDossiers: subfolders.length,
          tailleTotaleOctets: files.reduce((n, f) => n + f.size, 0),
          derniereActivite: ymd(files.reduce((d, f) => (f.updatedAt > d ? f.updatedAt : d), new Date(0))) ?? null,
          ...(truncated ? { tronque: `exploration bornée à ${MAX_NODES} nœuds — le dossier en contient davantage` } : {}),
        },
        deposants: parDeposant,
        parNature,
        bonsDeCommande: {
          stricts: bcStricts,
          assimiles: { total: assimiles, definition: "devis / proformas / factures — souvent rangés comme « BC » à tort" },
          totalFonctionnel: bcStricts + assimiles,
          nonClasses: files.filter((f) => !f.docKind).length,
          methode: "classification par CONTENU quand il est indexé (le nom n'est qu'un indice) — les non-classés sont dits, pas devinés",
        },
        fichiersRecents: files
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, 12)
          .map((f) => ({
            nom: f.name,
            nature: f.docKind ? DOC_KIND_LABEL[f.docKind as DocKind] ?? f.docKind : null,
            deposePar: f.uploaderId ? nameOf.get(f.uploaderId) ?? null : null,
            le: ymd(f.updatedAt), lien: `/drive/${f.id}`,
          })),
        couverture: {
          indexesALaVolee: indexedNow,
          consigne: "Répondre à TOUTES les parties de la question depuis ces agrégats — l'exploration est FAITE, ne pas la proposer.",
        },
      });
    },
  },
];
