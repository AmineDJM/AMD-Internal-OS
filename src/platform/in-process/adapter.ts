import { prisma } from "@/lib/prisma";
import { observabiliteMission } from "@/platform/in-process/missions/observabilite";
import { resolveDriveAccess } from "@/lib/drive";
import { retrieve, type AccessFilter } from "@/lib/knowledge/retrieve";
import { userCan, MODULES, ACTIONS, hasGlobalView, getAccess, type Module, type Action, type SessionUser } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { findPeople } from "@/lib/directory/resolve";
import { estAmbigu, produit360 } from "@/lib/queries/product-360";
import { pch360 } from "@/lib/queries/pch-360";
import { metriquesMarche, metriquesProduit } from "@/lib/queries/metrics";
import { voisinageMarche, voisinageProduit } from "@/lib/queries/graph";
import { storyMarche, storyProduit } from "@/lib/queries/story";
import { blocMarche360, blocProduit360 } from "@/lib/queries/e360-blocks";
import { DirectoryChannel, type UserRole } from "@prisma/client";
import { subscribe as busSubscribe } from "../event-bus";
import { missionsEnCours, vueMission } from "@/lib/missions/view/workspace";
import {
  PLATFORM_CONTRACT_VERSION, type CommandOutcome, type ContactEndpoint, type DocumentView, type EventHandler,
  type PersonView, type PlatformCommand, type PlatformPort, type PlatformQuery, type PlatformQueryResult,
  type Principal, type Unsubscribe,
} from "../contract";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR EN-PROCESSUS — LE SEUL FICHIER D'ADAM QUI A LE DROIT DE CONNAÎTRE L'ERP.
 *
 * ── CE QU'IL EST ─────────────────────────────────────────────────────────────────────────
 *
 * L'implémentation du contrat par des APPELS DE FONCTION. Pas de HTTP, pas de sérialisation,
 * pas de réseau : le coût par rapport à l'existant est nul, à la nanoseconde près. C'est le
 * cœur du compromis choisi — **on sépare le code sans séparer le déploiement**, donc on gagne
 * l'indépendance sans jamais payer la latence des microservices.
 *
 * Le jour où Adam devient un service à part, ce fichier reste ici (côté ERP), un second
 * adaptateur HTTP naît côté Adam, et le reste d'Adam ne change pas d'une ligne — parce qu'il ne
 * connaît que `PlatformPort`.
 *
 * ── LA DISCIPLINE ────────────────────────────────────────────────────────────────────────
 *
 * Tout ce qui est sale est ICI, et nulle part ailleurs : Prisma, `CurrentUser`, les énumérés
 * générés, les fonctions internes. Ce fichier TRADUIT ; il ne décide de rien.
 *
 * `boundary.test.ts` échoue si un autre fichier d'Adam importe l'ERP. C'est ce test, et non
 * l'intention, qui maintient la frontière quand quinze autres lots passeront par là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ═════════════════════════════════════════════════════════════════════════════════════════════
// IDENTITÉ — traduire `CurrentUser` en `Principal`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * RÉSOUT les capacités d'une personne, UNE FOIS, au début du tour.
 *
 * Pourquoi tout aplatir d'un coup plutôt qu'interroger à la demande : Adam filtre sa liste
 * d'outils à chaque tour, ce qui représente des dizaines de vérifications. Les faire une par une
 * en asynchrone ajouterait des dizaines d'allers-retours sur le chemin critique, pour un
 * résultat identique — l'accès est déjà entièrement résolu en mémoire par `getAccess`.
 *
 * Ce que cela ne change PAS : ces capacités servent à FILTRER (montrer, proposer). Elles
 * n'autorisent rien. `authorize()` et, surtout, l'action canonique elle-même restent seules
 * juges au moment d'exécuter.
 */
/**
 * LE PRÉDICAT DES MISSIONS D'ADAM, RÉEXPORTÉ PAR LE PONT (§118.136).
 *
 * `peutPiloterMissionsAdam` vit au socle (`lib/rbac.ts`) parce que l'ERP le lit aussi — écrans,
 * menu, actions, moteur. Les outils de conversation (`business-capabilities.ts`, `watch-tools.ts`)
 * en ont besoin pour leur garde `allowed`, et un import direct de `lib/rbac` depuis Adam est un
 * franchissement que le cliquet de frontière compte : mesuré, 430 pour un plafond de 428. Le pont
 * est le seul endroit d'Adam autorisé à connaître l'ERP ; c'est donc lui qui le tend.
 */
export { peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/lib/rbac";

export function principalOf(user: CurrentUser): Principal {
  const capabilities = new Set<string>();
  for (const m of MODULES) {
    for (const a of ACTIONS) {
      if (userCan(user, m as Module, a as Action)) capabilities.add(`${m}:${a}`);
    }
  }
  if (hasGlobalView(user)) capabilities.add("platform:global-view");
  if (user.role === "SUPER_ADMIN") capabilities.add("platform:super-admin");
  // LA PORTÉE DU DRIVE, portée explicitement. `resolveDriveAccess` la consulte, et la déduire
  // de « vue globale » serait une approximation : deux notions voisines qui ne coïncident pas
  // forcément, et dont l'écart se paierait en documents indûment rendus ou indûment cachés.
  if (user.access.modules.get("DRIVE")?.scope === "ALL") capabilities.add("DRIVE:scope-all");

  return {
    id: user.id,
    displayName: user.name,
    email: user.email,
    role: String(user.role),
    capabilities,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TRADUCTIONS
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CONFIDENCE_LABEL: Record<string, string> = {
  VERIFIED_INTERNAL: "vérifiée en interne",
  VERIFIED_PROVIDER: "compte / fiche ERP",
  OBSERVED_HISTORY: "vue en correspondance",
  INFERRED: "déduite — à confirmer",
};

const channelOf = (c: DirectoryChannel): ContactEndpoint["channel"] =>
  c === DirectoryChannel.EMAIL ? "email" : c === DirectoryChannel.PHONE ? "phone" : "whatsapp";

/** `PersonMatch` (interne, riche en identifiants techniques) → `PersonView` (ce qu'Adam voit). */
function toPersonView(m: {
  key: string; name: string; jobTitle: string | null; company: string | null;
  endpoints: { channel: DirectoryChannel; value: string; label: string | null; confidence: string; isPrimary: boolean }[];
}): PersonView {
  return {
    id: m.key,
    fullName: m.name,
    jobTitle: m.jobTitle,
    department: null,
    company: m.company,
    endpoints: m.endpoints.map((e) => ({
      channel: channelOf(e.channel),
      value: e.value,
      label: e.label,
      confidence: CONFIDENCE_LABEL[e.confidence] ?? e.confidence,
      primary: e.isPrimary,
    })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LECTURES
// ═════════════════════════════════════════════════════════════════════════════════════════════

async function runQuery(principal: Principal, q: PlatformQuery): Promise<PlatformQueryResult> {
  switch (q.kind) {
    case "person.search": {
      const people = await findPeople(q.text, q.limit ?? 5);
      return { kind: "person.search", people: people.map(toPersonView), total: people.length };
    }

    case "person.list": {
      // LE REGISTRE COMPLET EST GARDÉ — chercher UNE personne est un geste d'annuaire, ouvert ;
      // extraire TOUT LE MONDE avec les coordonnées de chacun est une extraction. La porte est
      // la même qu'à l'écran, et elle est revérifiée ici, pas héritée du contexte d'appel.
      const allowed = principal.capabilities.has("RH:VIEW")
        || principal.capabilities.has("platform:global-view")
        || principal.capabilities.has("platform:super-admin");
      if (!allowed) return { kind: "person.list", people: [], total: 0 };

      const rows = await prisma.employee.findMany({
        where: {
          isActive: true,
          ...(q.department ? { department: { contains: q.department, mode: "insensitive" } } : {}),
        },
        orderBy: { fullName: "asc" },
        take: Math.min(q.limit ?? 100, 300),
        select: {
          id: true, fullName: true, position: true, department: true, email: true, phone: true,
          company: { select: { shortName: true, name: true } },
          user: { select: { email: true } },
          directoryEntry: {
            select: { endpoints: { where: { isActive: true }, select: { channel: true, value: true, label: true, confidence: true, isPrimary: true } } },
          },
        },
      });

      const people: PersonView[] = rows.map((e) => {
        const seen = new Map<string, ContactEndpoint>();
        for (const p of e.directoryEntry?.endpoints ?? []) {
          seen.set(p.value.toLowerCase(), {
            channel: channelOf(p.channel), value: p.value, label: p.label,
            confidence: CONFIDENCE_LABEL[p.confidence] ?? String(p.confidence), primary: p.isPrimary,
          });
        }
        for (const fallback of [e.email, e.user?.email]) {
          if (fallback && !seen.has(fallback.toLowerCase())) {
            seen.set(fallback.toLowerCase(), {
              channel: "email", value: fallback.toLowerCase(), label: "fiche ERP",
              confidence: CONFIDENCE_LABEL.VERIFIED_PROVIDER, primary: false,
            });
          }
        }
        if (e.phone && !seen.has(e.phone.toLowerCase())) {
          seen.set(e.phone.toLowerCase(), {
            channel: "phone", value: e.phone, label: "fiche ERP",
            confidence: CONFIDENCE_LABEL.VERIFIED_PROVIDER, primary: false,
          });
        }
        return {
          id: e.id,
          fullName: e.fullName,
          jobTitle: e.position,
          department: e.department,
          company: e.company?.shortName ?? e.company?.name ?? null,
          endpoints: [...seen.values()],
        };
      });
      return { kind: "person.list", people, total: people.length };
    }

    case "document.show":
      return showDocument(principal, q);

    case "document.search":
      return searchDocuments(principal, q.question, q.limit ?? 5);

    case "product.economics":
      return economieProduit(q.mention);

    case "pch.market-status":
      return etatMarche(q.reference);

    case "business.story":
      return histoireAffaire(q.ancre);

    case "mission.status":
      return etatMission(principal.id, q.mission);


    case "record.get":
    case "record.search":
    case "pending-decisions.list":
      // DÉCLARÉES, PAS ENCORE SERVIES — et le dire est plus honnête que rendre un tableau vide,
      // qui se lirait « il n'y a rien » au lieu de « je ne sais pas encore faire ». Ces lectures
      // passent aujourd'hui par les outils historiques ; elles migreront ici avec leur tranche.
      throw new Error(`Lecture « ${q.kind} » pas encore servie par l'adaptateur en-processus.`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// NAVIGATION — où cette personne a le droit d'aller
// ═════════════════════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════════════════════
// DOCUMENTS — ouvrir un fichier, avec les droits de son écran d'origine
// ═════════════════════════════════════════════════════════════════════════════════════════════

const extOf = (name: string): string => (name.split(".").pop() ?? "").toLowerCase();

function docKindOf(name: string, mime?: string | null): DocumentView["kind"] {
  const e = extOf(name);
  if (e === "pdf" || mime === "application/pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(e)) return "image";
  if ((mime ?? "").startsWith("image/")) return "image";
  if (["xlsx", "xlsm", "xls", "csv"].includes(e)) return "feuille";
  if (["txt", "md", "json", "log"].includes(e)) return "texte";
  return "autre";
}

/** « 2,4 Mo » plutôt que « 2 517 291 » — une taille sert à décider, pas à compter. */
function humanSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["o", "ko", "Mo", "Go"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

/**
 * LES DROITS NE BOUGENT PAS D'UN MILLIMÈTRE.
 *
 * Un fichier du Drive passe par `resolveDriveAccess` / `canViewDrive`, NŒUD PAR NŒUD : être PDG
 * n'ouvre pas un fichier privé qu'aucun partage ne lui donne. Une pièce jointe passe par
 * `canAccessEntity` sur son DOSSIER porteur — la même porte qu'à l'écran du module.
 *
 * Les imports sont PARESSEUX : le Drive traîne le stockage et l'extraction derrière lui, et
 * l'adaptateur est chargé à chaque tour d'Adam, y compris quand aucun document n'est demandé.
 */
async function showDocument(
  principal: Principal,
  q: Extract<PlatformQuery, { kind: "document.show" }>,
): Promise<Extract<PlatformQueryResult, { kind: "document.show" }>> {
  const refuse = (refusal: string) => ({ kind: "document.show" as const, document: null, refusal });

  const [{ resolveDriveAccess, canViewDrive }, { getBlob }, { readFileByKey }, { canAccessEntity }, { sheetPreview }] =
    await Promise.all([
      import("@/lib/drive"),
      import("@/lib/drive-storage"),
      import("@/lib/storage"),
      import("@/lib/entity-access"),
      import("@/lib/assistant/workspace/sheet"),
    ]);

  /**
   * ── L'IDENTITÉ SE RELIT À LA SOURCE — MAIS LA SOURCE N'EST PAS LA SESSION HTTP ─────────
   *
   * La première version appelait `getCurrentUser()`, qui lit les en-têtes de la requête. Dans
   * une CONVERSATION c'est juste ; dans une MISSION, il n'y a pas de requête — le moteur tourne
   * sur un battement, un webhook ou un processus détaché. Mesuré sur un run live : chaque étape
   * qui ouvrait un document mourait sur « `headers` was called outside a request scope », et le
   * jalon entier passait BLOCKED. Un « je ne peux pas » purement artificiel : la personne
   * existe, ses droits existent, et rien ne manquait qu'un en-tête HTTP.
   *
   * La source canonique des DROITS, c'est `getAccess` — qui les relit EN BASE, à l'instant.
   * C'est plus fort que la session, pas moins : le rôle porté par un jeton peut être périmé
   * après une promotion, celui de la base ne l'est jamais. C'est déjà le motif employé par
   * `destinationsOf` juste au-dessus, pour exactement cette raison.
   *
   * Le `Principal` ne fabrique donc AUCUN droit : il ne fournit qu'un identifiant, et tout ce
   * qui autorise est relu derrière. Chaque nœud du Drive repasse ensuite par `canViewDrive`, et
   * chaque pièce jointe par `canAccessEntity` — être PDG n'ouvre toujours pas un fichier privé
   * qu'aucun partage ne lui donne.
   */
  const acces = await getAccess(principal.id, principal.role as UserRole);
  const enBase = await prisma.user.findUnique({
    where: { id: principal.id },
    select: { id: true, name: true, email: true, role: true, secondaryRole: true, mustChangePassword: true },
  });
  if (!enBase) return refuse("Compte introuvable.");
  const user = {
    ...enBase,
    role: acces.role ?? enBase.role,
    secondaryRole: acces.secondaryRole ?? enBase.secondaryRole,
    access: acces,
  } as unknown as CurrentUser;

  let nodeId = q.driveNodeId?.trim() ?? "";
  let subtitle: string | null = null;

  if (!nodeId && !q.documentId && (q.name ?? "").trim().length >= 2) {
    const { searchDrive } = await import("@/lib/queries/drive-search");
    const found = await searchDrive(user, (q.name ?? "").trim());
    const files = found.rows.filter((r) => r.href.startsWith("/drive/"));
    if (files.length === 0) return refuse(`Aucun fichier « ${q.name} » dans le Drive qui vous est ouvert.`);
    nodeId = files[0].id;
    // PLUSIEURS CANDIDATS : on affiche le premier ET on nomme le chemin. Choisir en silence
    // entre deux contrats homonymes est le genre d'erreur qui se remarque très tard.
    if (files.length > 1) subtitle = `${files.length} fichiers correspondent — celui-ci : ${files[0].path}`;
  }

  if (nodeId) {
    if (!canViewDrive(await resolveDriveAccess(user, nodeId))) return refuse("Ce fichier du Drive ne vous est pas ouvert.");
    const node = await prisma.driveNode.findUnique({
      where: { id: nodeId },
      select: { name: true, type: true, isTrashed: true, mimeType: true },
    });
    if (!node || node.isTrashed) return refuse("Fichier introuvable dans le Drive.");
    if (node.type !== "FILE") return refuse("C'est un dossier, pas un fichier.");

    const version = await prisma.fileVersion.findFirst({
      where: { nodeId }, orderBy: { version: "desc" },
      select: { blobId: true, size: true, mimeType: true },
    });
    const kind = docKindOf(node.name, node.mimeType ?? version?.mimeType ?? null);
    let sheet = null;
    if (kind === "feuille" && version) {
      const bytes = await getBlob(version.blobId).catch(sansBloquer("adapter.showDocument.getBlob", null));
      if (bytes) sheet = await sheetPreview(node.name, Buffer.from(bytes));
    }
    return {
      kind: "document.show",
      document: {
        name: node.name, href: `/api/drive/${nodeId}/raw`, kind,
        size: humanSize(version?.size ? Number(version.size) : null),
        subtitle, sheet,
      },
    };
  }

  if (q.documentId) {
    const doc = await prisma.document.findUnique({
      where: { id: q.documentId },
      select: { name: true, fileKey: true, mimeType: true, sizeBytes: true, entityType: true, entityId: true, category: true },
    });
    if (!doc) return refuse("Pièce introuvable.");
    if (!(await canAccessEntity(user, doc.entityType, doc.entityId, "VIEW"))) {
      return refuse("Cette pièce appartient à un dossier qui ne vous est pas ouvert.");
    }
    if (!doc.fileKey) return refuse("Cette pièce n'a pas de fichier (métadonnées seules).");

    const kind = docKindOf(doc.name, doc.mimeType);
    let sheet = null;
    if (kind === "feuille") {
      const bytes = await readFileByKey(doc.fileKey).catch(sansBloquer("adapter.showDocument.readFileByKey", null));
      if (bytes) sheet = await sheetPreview(doc.name, Buffer.from(bytes));
    }
    return {
      kind: "document.show",
      document: {
        name: doc.name, href: `/api/documents/${q.documentId}`, kind,
        size: humanSize(doc.sizeBytes ? Number(doc.sizeBytes) : null),
        subtitle: doc.category ?? null, sheet,
      },
    };
  }

  return refuse("Précisez le fichier : son identifiant Drive, sa pièce jointe, ou son nom.");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// COMMANDES
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * L'EXÉCUTION DES ACTIONS RESTE À L'ERP, ENTIÈREMENT.
 *
 * L'adaptateur ne fait que passer le plat : il n'évalue aucun droit, ne contourne aucune
 * approbation, ne fabrique aucun raccourci. `performAction` conserve l'arrêt d'urgence, les
 * portes, la revalidation canonique, l'audit et l'idempotence — c'est-à-dire tout ce qui compte.
 *
 * L'import est PARESSEUX, et pas par élégance : `@/lib/assistant` est le gros module d'Adam, et
 * le charger au premier import de l'adaptateur créerait un cycle (Adam → adaptateur → Adam).
 */
async function runCommand(principal: Principal, cmd: PlatformCommand): Promise<CommandOutcome> {
  const { performAction } = await import("@/lib/assistant");
  const { getCurrentUser } = await import("@/lib/session");

  // L'IDENTITÉ EST RELUE À LA SOURCE, jamais reconstruite depuis le `Principal`. Un `Principal`
  // est une VUE, éventuellement périmée ; laisser Adam fabriquer l'utilisateur qui exécute
  // reviendrait à lui laisser fabriquer ses propres droits.
  const user = await getCurrentUser();
  if (!user || user.id !== principal.id) {
    return { ok: false, refused: true, reason: "Session absente ou différente de celle qui a demandé l'action." };
  }

  const payload = { kind: cmd.actionId, ...cmd.args, idempotencyKey: cmd.idempotencyKey } as never;
  const res = await performAction(user, payload);

  if (res.ok) {
    return { ok: true, message: res.message ?? "Fait.", link: res.link ?? null, createdId: res.createdId ?? null };
  }
  // On distingue le REFUS (la plateforme a décidé) de la PANNE (elle n'a pas pu décider). Adam
  // dit un refus tel quel ; une panne, il peut la réessayer. Les confondre produit soit des
  // relances sur un refus définitif, soit un abandon sur une erreur passagère.
  return { ok: false, refused: true, reason: res.error ?? "Action refusée." };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LE PORT
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const inProcessPlatform: PlatformPort = {
  contractVersion: PLATFORM_CONTRACT_VERSION,

  query: (principal, query) => runQuery(principal, query),
  command: (principal, command) => runCommand(principal, command),

  /**
   * LA RÉPONSE QUI FAIT FOI. Contrairement aux capacités portées par le `Principal` — un
   * instantané destiné au filtrage rapide — celle-ci est relue à l'instant.
   */
  async authorize(principal, capability) {
    const [moduleName, action] = capability.split(":");
    if (!moduleName || !action) return false;
    const { getCurrentUser } = await import("@/lib/session");
    const user = await getCurrentUser();
    if (!user || user.id !== principal.id) return false;
    if (capability === "platform:global-view") return hasGlobalView(user);
    if (capability === "platform:super-admin") return user.role === "SUPER_ADMIN";
    return userCan(user, moduleName as Module, action as Action);
  },

  subscribe(handler: EventHandler): Unsubscribe {
    return busSubscribe(handler);
  },
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CHERCHER DANS LE CONTENU — l'entonnoir de connaissance, derrière le contrat
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Au-delà, on ne résout plus les droits un par un : la latence deviendrait le sujet. */
const MAX_A_FILTRER = 40;
/** Par paquets — une résolution à la fois, quarante nœuds coûteraient une seconde. */
const PAR_PAQUET = 8;

/**
 * QUI A LE DROIT DE VOIR QUOI — à partir de la garde CANONIQUE du Drive.
 *
 * ── LA RÈGLE : CE QU'ON NE SAIT PAS VÉRIFIER, ON LE REFUSE ──────────────────────────────
 *
 * L'index accepte quinze types de source. Le Drive est le seul dont la garde de lecture soit
 * ici traduisible sans deviner. Pour les autres — une pièce RH, un courrier restreint, un
 * contrat à lecteurs nommés — laisser passer « par défaut » ferait fuir par la recherche ce
 * que l'écran protège.
 *
 * Le refus par défaut coûte une capacité : un document légitime n'est pas rendu tant que sa
 * garde n'est pas écrite ici. C'est le bon côté du compromis — une capacité manquante se voit
 * et se réclame ; une fuite ne se voit pas.
 */
/**
 * LE STRICT NÉCESSAIRE POUR INTERROGER LA GARDE DU DRIVE — l'inverse exact de `principalOf`
 * pour les trois seuls champs que `resolveDriveAccess` lit : l'identifiant, le rôle, et la
 * portée du module Drive.
 *
 * On RECONSTRUIT plutôt que de transporter un `CurrentUser` : le contrat ne fait circuler qu'un
 * `Principal`, et lui glisser un objet de session le rendrait indissociable de cette
 * implémentation-ci. La reconstruction est fidèle parce que chacun de ces trois champs est
 * explicitement encodé dans le `Principal` — aucun n'est deviné.
 */
function driveUserOf(principal: Principal): SessionUser {
  const modules = new Map<Module, { actions: Set<Action>; scope?: string }>();
  if (principal.capabilities.has("DRIVE:scope-all")) {
    modules.set("DRIVE" as Module, { actions: new Set<Action>(), scope: "ALL" });
  }
  return {
    id: principal.id,
    role: principal.role,
    access: { modules, rowGrants: [], secondaryRole: null, role: principal.role },
  } as unknown as SessionUser;
}

function accessFilterFor(principal: Principal): AccessFilter {
  return async (items) => {
    const autorises = new Set<string>();
    if (principal.capabilities.has("platform:super-admin")) {
      for (const i of items) autorises.add(i.itemId);
      return autorises;
    }
    const user = driveUserOf(principal);
    const drive = items.filter((i) => i.sourceType === "drive_file").slice(0, MAX_A_FILTRER);
    for (let i = 0; i < drive.length; i += PAR_PAQUET) {
      const paquet = drive.slice(i, i + PAR_PAQUET);
      const niveaux = await Promise.all(
        paquet.map((it) => resolveDriveAccess(user, it.sourceId).catch(sansBloquer("adapter.accessFilterFor.resolveDriveAccess", "NONE" as const))),
      );
      paquet.forEach((it, k) => { if (niveaux[k] !== "NONE") autorises.add(it.itemId); });
    }
    return autorises;
  };
}

async function searchDocuments(principal: Principal, question: string, limit: number): Promise<PlatformQueryResult> {
  const r = await retrieve(
    // `force` : la demande de fouiller les documents est EXPLICITE — c'est la lecture qu'on
    // vient de nous réclamer. Le routeur, qui sert à éviter une recherche que personne n'a
    // demandée, n'a rien à opposer ici.
    // `scopeKey` : l'identité du demandeur entre dans la clé de cache. Sans elle, la réponse
    // calculée pour quelqu'un d'autre serait resservie — filtre d'accès compris, c'est-à-dire
    // non compris. Vérifié : le Super Admin cherchait, l'employé recevait ses extraits.
    { question, force: true, limit, scopeKey: principal.id },
    accessFilterFor(principal),
  ).catch(sansBloquer("adapter.searchDocuments.retrieve", null));

  if (!r) return { kind: "document.search", extracts: [], examined: 0 };
  return {
    kind: "document.search",
    examined: r.funnel.recalled,
    extracts: r.hits.map((h) => ({
      document: h.title ?? null,
      at: h.label ?? h.locator ?? null,
      text: h.snippet.slice(0, 600),
      because: h.because,
    })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// VUES MÉTIER — l'ERP compose, Adam restitue
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * L'ÉCONOMIE D'UN PRODUIT. Tout le travail se fait ICI, côté ERP : résolution du produit,
 * lecture des traversées, calcul des métriques. Adam reçoit une vue déjà composée.
 *
 * C'est le sens de la frontière : ce qui demande de connaître le schéma reste du côté qui le
 * connaît. Câblée dans un outil d'Adam, cette seule capacité aurait franchi la frontière
 * quatre fois de plus — et le test de dette l'a signalé avant même que ce soit écrit.
 */
async function economieProduit(mention: string): Promise<PlatformQueryResult> {
  const brut = (mention ?? "").trim();
  if (brut.length < 2) {
    return { kind: "product.economics", data: null, question: "Donnez la référence, l'alias ou la DCI du produit." };
  }

  const vue = await produit360(brut);
  if (!vue) {
    return {
      kind: "product.economics", data: null,
      question: `Aucun produit « ${brut} » au catalogue canonique. Vérifier l'orthographe, ou le produit n'est pas encore rapproché.`,
    };
  }
  // L'AMBIGUÏTÉ REMONTE COMME UNE QUESTION, jamais comme un choix fait à la place de l'humain.
  if (estAmbigu(vue)) {
    const liste = vue.candidats
      .slice(0, 6)
      .map((c) => `${c.code} — ${c.nom}${c.dosage ? ` (${c.dosage})` : ""}`)
      .join(" · ");
    return {
      kind: "product.economics", data: null,
      question: `« ${brut} » désigne plusieurs produits : ${liste}. Lequel ? (préciser le dosage ou la référence)`,
    };
  }

  // LA TRAVERSÉE EN MÊME TEMPS QUE LES MÉTRIQUES : « qu'est-ce qui touche ce produit » et
  // « combien rapporte-t-il » sont deux moitiés de la même question, et les séparer en deux
  // outils ferait payer un aller-retour pour une réponse que la base rend d'un coup.
  const [mesures, graphe] = await Promise.all([
    metriquesProduit(vue.produit.id),
    voisinageProduit(vue.produit.id),
  ]);
  return {
    kind: "product.economics",
    data: {
      metriques: mesures?.metriques ?? [],
      // CE QUI EST RATTACHÉ, en une ligne par relation. Un produit à zéro vente mais douze
      // lignes de marché dit immédiatement où regarder — et `horsGraphe` dit ce que la
      // traversée NE voit pas, pour qu'une arête vide ne se lise pas « il n'y a rien ».
      graphe: graphe ? { aretes: graphe.aretes, totalVoisins: graphe.totalVoisins, horsGraphe: graphe.horsGraphe } : null,
      produit: vue.produit,
      periode: mesures?.periode ?? null,
      // Seules les affectations EN COURS : un portefeuille clos l'an dernier ne dit rien de qui
      // porte le produit aujourd'hui, et l'afficher ferait relancer la mauvaise personne.
      portefeuille: vue.portefeuille.filter((p) => p.enCours),
      marches: vue.marches,
      ventes: {
        nombre: vue.ventes.nombre,
        chiffreAffairesTotalDzd: vue.ventes.chiffreAffairesDzd,
        parStatutDeReglement: vue.ventes.parStatutDeReglement,
        premiere: vue.ventes.premiere, derniere: vue.ventes.derniere,
      },
      investissementAdPro: {
        nombreDePostes: vue.investissementAdPro.nombreDePostes,
        montantImputeDzd: vue.investissementAdPro.montantImputeDzd,
        postesSansPart: vue.investissementAdPro.postesSansPart,
      },
      terrain: vue.terrain,
      limites: [...vue.limites, ...(mesures?.limites ?? [])],
      // LA VUE 360 EST COMPOSÉE ICI, où `Produit360` est typé. Composée chez Adam, elle
      // exigerait de re-deviner chaque champ d'un objet que le contrat rend opaque à dessein.
      _blocs: [blocProduit360(vue, mesures?.metriques ?? [], mesures?.limites ?? [])],
    },
  };
}

/** L'ÉTAT D'UN MARCHÉ PCH — les cinq montants et leur exécution, en une lecture. */
async function etatMarche(reference: string): Promise<PlatformQueryResult> {
  const ref = (reference ?? "").trim();
  if (ref.length < 2) {
    return { kind: "pch.market-status", data: null, question: "Donnez la référence du marché." };
  }

  const vue = await pch360(ref);
  if (!vue) {
    return {
      kind: "pch.market-status", data: null,
      question: `Aucun marché « ${ref} » (ni par référence, ni par identifiant).`,
    };
  }

  const [mesures, graphe] = await Promise.all([
    metriquesMarche(vue.marche.id),
    voisinageMarche(vue.marche.id),
  ]);
  return {
    kind: "pch.market-status",
    data: {
      metriques: mesures?.metriques ?? [],
      graphe: graphe ? { aretes: graphe.aretes, totalVoisins: graphe.totalVoisins, horsGraphe: graphe.horsGraphe } : null,
      marche: vue.marche,
      montants: vue.montants,
      caution: vue.caution,
      execution: vue.execution,
      lignes: vue.lignes,
      // RENDUES À PART, JAMAIS ADDITIONNÉES aux bons de commande : les cumuler doublerait le
      // chiffre d'affaires du marché.
      ventesEnregistrees: vue.ventesEnregistrees,
      limites: vue.limites,
      _blocs: [blocMarche360(vue, mesures?.metriques ?? [])],
    },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « RETRACE-MOI X » — et la RÉSOLUTION qui reste du côté de l'ERP.
 *
 * L'ancre est ce que le PDG a dit : « l'AONIO 2023 », « le Nivolumab ». Deux natures d'objet
 * répondent au même verbe, et c'est ici qu'on tranche — pas chez Adam, qui ignore qu'un marché
 * porte une référence et un produit un nom canonique.
 *
 * L'ORDRE COMPTE : le marché D'ABORD, par référence ou identifiant EXACTS. Un marché s'appelle
 * « AONIO 2023 », un produit « Nivolumab » ; commencer par le produit ferait qu'une référence
 * contenant un nom de molécule ramènerait le produit, et l'histoire du marché demandé serait
 * silencieusement remplacée par une autre. L'exactitude passe donc avant l'approximation.
 *
 * L'AMBIGUÏTÉ SE POSE, ELLE NE SE TRANCHE PAS. Deux produits pour une mention ⇒ on rend la
 * question. Choisir seul mettrait une frise sous le mauvais nom, et rien à l'écran ne dirait
 * que c'est le mauvais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * L'ÉTAT D'UNE MISSION D'EXÉCUTION — lu en base, sans un seul appel de modèle (§46).
 *
 * Le filtre par propriétaire vit dans `vueMission` : c'est le cloisonnement lui-même, pas une
 * commodité. Personne ne lit la mission d'un autre, même en connaissant son identifiant.
 */
async function etatMission(userId: string, missionId?: string): Promise<PlatformQueryResult> {
  if (!missionId) {
    const liste = await missionsEnCours(userId);
    return {
      kind: "mission.status",
      data: null,
      missions: liste.map((m) => ({
        id: m.id, titre: m.titre, etat: m.etat, avancement: `${m.faites}/${m.total} ${m.unite}`,
      })),
    };
  }

  const v = await vueMission(missionId, userId);
  if (!v) return { kind: "mission.status", data: null };
  return {
    kind: "mission.status",
    data: {
      titre: v.title,
      etat: v.subtitle,
      avancement: v.avancement,
      enAttenteDeVous: v.enAttenteDeVous,
      sousMissions: v.sousMissions.length,
      bloc: v,
      observabilite: await observabiliteMission(missionId, userId).catch(sansBloquer("adapter.etatMission.observabiliteMission", null)),
    },
  };
}

async function histoireAffaire(ancre: string): Promise<PlatformQueryResult> {
  const brut = (ancre ?? "").trim();
  if (brut.length < 2) {
    return { kind: "business.story", data: null, question: "De quelle affaire — marché, produit ?" };
  }

  const marche = await storyMarche(brut);
  if (marche) return { kind: "business.story", data: marche };

  const vue = await produit360(brut);
  if (!vue) {
    return {
      kind: "business.story", data: null,
      question: `Aucun marché ni produit « ${brut} » : ni par référence, ni par nom canonique.`,
    };
  }
  if (estAmbigu(vue)) {
    const liste = vue.candidats.map((c) => `${c.nom}${c.dosage ? ` ${c.dosage}` : ""}`).join(", ");
    return {
      kind: "business.story", data: null,
      question: `« ${brut} » désigne plusieurs produits : ${liste}. Lequel ? (préciser le dosage ou la référence)`,
    };
  }

  const produit = await storyProduit(vue.produit.id);
  if (!produit) {
    return {
      kind: "business.story", data: null,
      question: `Le produit « ${vue.produit.nom} » existe, mais aucune histoire n'a pu être reconstituée.`,
    };
  }
  return { kind: "business.story", data: produit };
}
