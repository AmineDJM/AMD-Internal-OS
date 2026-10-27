import { prisma } from "@/lib/prisma";
import { hasGlobalView, userCan } from "@/lib/rbac";
import { commenterValidation, remindValidator } from "@/lib/actions/validation-actions";
import { uploadDocument } from "@/lib/actions/document-actions";
import { createCalendarEvent } from "@/lib/actions/calendar-actions";
import { sendMessage } from "@/lib/actions/messaging-actions";
import { DOCUMENT_CATEGORY } from "@/lib/labels";
import type { CurrentUser } from "@/lib/session";
import { champs, liste, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive, idsDe, resoudrePieces } from "./pieces";
import { replier } from "./annuaire-medical";
import { trouverDemande } from "./demandes-visibles";
import { dateIso } from "./adpro-prise-en-charge";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DU QUOTIDIEN — ceux que la personne a À L'ÉCRAN, et pas un de plus.
 *
 *   • RELANCER UN VALIDEUR d'une de SES demandes de validation : la Direction a le bouton de
 *     relance (`remindValidator`) ; tout autre demandeur écrit dans la DISCUSSION de la demande
 *     (`commenterValidation`), qui prévient les validateurs. La carte dit lequel des deux.
 *   • DÉPOSER UNE PIÈCE sur une demande qu'elle voit (`uploadDocument`, droit de téléversement
 *     revérifié par l'action).
 *   • CRÉER UN RENDEZ-VOUS dans son agenda, invités désignés par leur nom (`createCalendarEvent`).
 *   • RÉPONDRE À UN MESSAGE INTERNE dans une conversation dont elle est membre (`sendMessage`).
 *
 * Rien de sa propre initiative : chaque geste naît d'une demande de la personne et d'un clic.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */


export const RELANCE: OperationIA = {
  nom: "preparer_relance",
  module: "VALIDATIONS",
  libelle: "Relance préparée",
  description:
    "PRÉPARE la RELANCE du validateur d'une de TES demandes de validation en attente (désignée par sa référence ou son objet). "
    + "Pour la Direction : le bouton de relance de l'écran ; sinon : un message dans la discussion de la demande, qui prévient les validateurs.",
  schema: {
    type: "object",
    properties: {
      demande: { type: "string", description: "Référence (VAL-…) ou objet de la demande de validation." },
      message: { type: "string", description: "Le mot de relance (facultatif)." },
    },
  },
  ouverte: (u) => userCan(u, "VALIDATIONS", "VIEW"),

  async proposer(e, user): Promise<PropositionOperation> {
    const q = texte(e, "demande");
    const mes = await prisma.validationRequest.findMany({
      where: {
        requesterId: user.id,
        status: "PENDING",
        ...(q ? { OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] } : {}),
      },
      select: { id: true, reference: true, title: true, steps: { where: { status: "PENDING" }, select: { id: true, validatorId: true, validator: { select: { name: true } } }, orderBy: { order: "asc" }, take: 1 } },
      orderBy: { createdAt: "desc" },
      take: 6,
    });
    if (!mes.length) return { manque: [q ? `« ${q} » : aucune de vos demandes de validation en attente ne correspond — une autre référence` : "quelle demande de validation relancer (sa référence ou son objet)"] };
    if (mes.length > 1) return { manque: [`laquelle : ${mes.map((m) => `${m.reference} — ${m.title}`).join(" ; ")}`] };
    const d = mes[0]!;
    const etape = d.steps[0];
    if (!etape?.validatorId) return { erreur: `${d.reference} n'a pas d'étape en attente avec un validateur assigné.` };
    const direction = hasGlobalView(user);
    const mot = texte(e, "message") || `Bonjour, je me permets de vous relancer sur ${d.reference} — ${d.title}. Merci.`;
    return {
      carte: {
        title: `Relancer ${etape.validator?.name ?? "le validateur"} — ${d.reference}`,
        fields: champs([["Demande", `${d.reference} — ${d.title}`], ["Validateur", etape.validator?.name ?? null], ["Message", mot]]),
        warnings: [direction
          ? "Relance par le bouton de l'écran : le validateur reçoit une notification."
          : "Le message est écrit dans la discussion de la demande : le validateur (et les participants) sont prévenus."],
        libelleBouton: "Relancer",
      },
      args: { requestId: d.id, stepId: etape.id, note: mot, mode: direction ? "BOUTON" : "DISCUSSION" },
    };
  },

  async executer(a) {
    const fd = new FormData();
    if (a.mode === "BOUTON") {
      fd.set("stepId", a.stepId ?? "");
      if (a.note) fd.set("note", a.note);
      const r = await remindValidator(fd);
      return r.ok ? { ok: true, message: "Validateur relancé.", link: `/validations/${a.requestId}` } : { ok: false, error: r.error ?? "Relance refusée." };
    }
    fd.set("requestId", a.requestId ?? "");
    fd.set("body", a.note ?? "");
    const r = await commenterValidation(fd);
    return r.ok ? { ok: true, message: "Relance écrite dans la discussion : le validateur est prévenu.", link: `/validations/${a.requestId}` } : { ok: false, error: r.error ?? "Relance refusée." };
  },
};

const CATEGORIES = Object.entries(DOCUMENT_CATEGORY) as [string, string][];

export const DEPOT_PIECE: OperationIA = {
  nom: "preparer_depot_piece",
  module: "DOCUMENTS",
  libelle: "Dépôt de pièce préparé",
  description:
    "PRÉPARE le DÉPÔT d'une ou plusieurs pièces (fichiers du Drive ou glissés dans la conversation) sur une demande Ad & Pro que tu vois "
    + "(sponsoring, prise en charge, événement, matériel promotionnel, demande « autre »). Le droit de téléverser est revérifié par l'action de l'écran.",
  schema: {
    type: "object",
    properties: {
      demande: { type: "string", description: "Référence ou nom de la demande." },
      natureDemande: { type: "string" },
      pieces: { type: "string", description: "Noms ou identifiants des fichiers." },
      categorie: { type: "string", description: "Catégorie (ex. Lettre de demande, Facture, Devis, Autre)." },
    },
  },
  ouverte: (u) => Boolean(u.id),

  async proposer(e, user): Promise<PropositionOperation> {
    const demande = await trouverDemande(user, texte(e, "demande"), texte(e, "natureDemande"));
    const refs = liste(e, "pieces");
    const manque = ["manque" in demande ? demande.manque : null, !refs.length ? "la ou les pièces à déposer (glissez-les dans la conversation ou nommez-les)" : null]
      .filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const d = demande as Exclude<typeof demande, { manque: string }>;
    const pieces = await resoudrePieces(user, refs);
    if ("erreur" in pieces) return { erreur: pieces.erreur };
    const k = replier(texte(e, "categorie"));
    const cat = (k && CATEGORIES.find(([, l]) => replier(l).includes(k))?.[0]) || "OTHER";
    return {
      carte: {
        title: `Déposer ${pieces.length > 1 ? `${pieces.length} pièces` : "une pièce"} — ${d.libelle}`,
        fields: champs([["Demande", d.libelle], ["Pièce(s)", pieces.map((p) => p.nom).join(", ")], ["Catégorie", DOCUMENT_CATEGORY[cat] ?? "Autre"]]),
        warnings: ["Le contenu est copié dans la bibliothèque de la demande (le fichier du Drive reste intact) ; votre droit de déposer y est revérifié."],
      },
      args: { entityType: d.nature, entityId: d.id, category: cat, pieces: JSON.stringify(pieces.map((p) => p.id)), lien: d.lien },
    };
  },

  async executer(a, user) {
    const fichiers = await fichiersDepuisDrive(user, idsDe(a.pieces));
    if (!Array.isArray(fichiers)) return { ok: false, error: fichiers.erreur };
    let deposes = 0;
    for (const f of fichiers) {
      const fd = new FormData();
      fd.set("entityType", a.entityType ?? "");
      fd.set("entityId", a.entityId ?? "");
      fd.set("category", a.category ?? "OTHER");
      fd.set("file", f);
      const r = await uploadDocument(undefined, fd);
      if (!r.ok) return { ok: false, error: `${deposes ? `${deposes} pièce(s) déposée(s), puis ` : ""}« ${f.name} » refusée : ${r.error ?? "dépôt refusé"}.` };
      deposes++;
    }
    return { ok: true, message: `${deposes} pièce(s) déposée(s).`, ...(a.lien ? { link: a.lien } : {}) };
  },
};

/** « 2026-11-03 14:30 », « 03/11/2026 à 14h30 » → « AAAA-MM-JJTHH:MM » (heure d'Alger, comme l'écran). */
export function dateHeure(v: string): string | null {
  const s = v.trim();
  const m = s.match(/^(.+?)(?:[ T]+(?:à\s*)?(\d{1,2})\s*[:h]\s*(\d{2})?)?$/i);
  const jour = m ? dateIso(m[1]!.trim()) : null;
  if (!jour) return null;
  const h = m?.[2] ? m[2].padStart(2, "0") : null;
  return h ? `${jour}T${h}:${(m?.[3] ?? "00").padStart(2, "0")}` : jour;
}

export const RENDEZ_VOUS: OperationIA = {
  nom: "preparer_rendez_vous",
  module: "WORKSPACE",
  libelle: "Rendez-vous préparé",
  description: "PRÉPARE un RENDEZ-VOUS dans ton agenda (titre, début, fin, lieu, invités désignés par leur nom), par l'action de l'écran Agenda.",
  schema: {
    type: "object",
    properties: {
      titre: { type: "string" },
      debut: { type: "string", description: "AAAA-MM-JJ HH:MM (heure d'Alger)." },
      fin: { type: "string", description: "AAAA-MM-JJ HH:MM (facultatif)." },
      lieu: { type: "string" },
      invites: { type: "string", description: "Collègues invités (noms, séparés par des virgules)." },
      description: { type: "string" },
    },
  },
  ouverte: (u) => userCan(u, "WORKSPACE", "CREATE"),

  async proposer(e): Promise<PropositionOperation> {
    const debut = dateHeure(texte(e, "debut"));
    const fin = texte(e, "fin") ? dateHeure(texte(e, "fin")) : null;
    const manque = [
      !texte(e, "titre") ? "l'objet du rendez-vous" : null,
      !debut ? "le jour et l'heure de début" : null,
      texte(e, "fin") && !fin ? "une heure de fin lisible" : null,
    ].filter((x): x is string => x !== null);
    const invites: { id: string; nom: string }[] = [];
    for (const nom of liste(e, "invites")) {
      const t = await prisma.user.findMany({ where: { isActive: true, name: { contains: nom, mode: "insensitive" } }, select: { id: true, name: true }, take: 5 });
      const exact = t.filter((u) => replier(u.name) === replier(nom));
      const un = exact.length === 1 ? exact[0] : t.length === 1 ? t[0] : null;
      if (un) invites.push({ id: un.id, nom: un.name });
      else manque.push(t.length > 1 ? `quel invité pour « ${nom} » : ${t.map((u) => u.name).join(", ")}` : `« ${nom} » n'a pas de compte actif : un autre invité`);
    }
    if (manque.length) return { manque };
    return {
      carte: {
        title: `Rendez-vous — ${texte(e, "titre")}`,
        fields: champs([
          ["Objet", texte(e, "titre")], ["Début", debut!.replace("T", " à ")], ["Fin", fin ? fin.replace("T", " à ") : null],
          ["Lieu", texte(e, "lieu") || null], ["Invités", invites.length ? invites.map((i) => i.nom).join(", ") : null],
        ]),
        warnings: invites.length ? ["Les invités reçoivent l'invitation dans leur agenda."] : [],
      },
      args: {
        title: texte(e, "titre"), start: debut, end: fin, location: texte(e, "lieu") || null,
        description: texte(e, "description") || null, invites: JSON.stringify(invites.map((i) => i.id)),
        allDay: debut!.length === 10 ? "true" : null,
      },
    };
  },

  async executer(a) {
    const fd = new FormData();
    for (const cle of ["title", "start", "end", "location", "description", "allDay"]) if (a[cle]) fd.set(cle, a[cle]!);
    for (const id of idsDe(a.invites)) fd.append("inviteeIds", id);
    const r = await createCalendarEvent(undefined, fd);
    return r.ok ? { ok: true, message: "Rendez-vous ajouté à votre agenda.", link: "/calendar" } : { ok: false, error: r.error ?? "Rendez-vous refusé." };
  },
};

export const REPONSE_MESSAGE: OperationIA = {
  nom: "preparer_reponse_message",
  module: "MESSAGING",
  libelle: "Réponse préparée",
  description:
    "PRÉPARE la RÉPONSE à un message interne, dans une conversation dont tu es membre (désignée par le nom de l'interlocuteur ou du groupe). "
    + "Lis d'abord tes conversations (mes_conversations) pour savoir à quoi tu réponds.",
  schema: {
    type: "object",
    properties: {
      conversation: { type: "string", description: "Interlocuteur ou nom du groupe." },
      texte: { type: "string", description: "La réponse." },
      enFil: { type: "boolean", description: "Répondre dans le fil du dernier message reçu (par défaut : oui)." },
    },
  },
  ouverte: (u) => userCan(u, "MESSAGING", "CREATE"),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const q = texte(e, "conversation");
    const corps = texte(e, "texte");
    const manque = [!q ? "à qui (l'interlocuteur ou le groupe)" : null, !corps ? "le texte de la réponse" : null].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const convs = await convsDe(user, q);
    if (!convs.length) return { manque: [`aucune de vos conversations ne correspond à « ${q} » — un autre nom`] };
    if (convs.length > 1) return { manque: [`laquelle : ${convs.map((c) => c.libelle).join(" ; ")}`] };
    const c = convs[0]!;
    const dernier = await prisma.message.findFirst({
      where: { conversationId: c.id, deletedAt: null, senderId: { not: user.id } },
      orderBy: { createdAt: "desc" }, select: { id: true, body: true },
    });
    const enFil = e.enFil !== false && dernier;
    return {
      carte: {
        title: `Répondre — ${c.libelle}`,
        fields: champs([["Conversation", c.libelle], ["En réponse à", enFil ? dernier!.body.slice(0, 140) : null], ["Réponse", corps]]),
        warnings: [],
        libelleBouton: "Envoyer",
      },
      args: { conversationId: c.id, body: corps, parentId: enFil ? dernier!.id : null },
    };
  },

  async executer(a) {
    const fd = new FormData();
    fd.set("conversationId", a.conversationId ?? "");
    fd.set("body", a.body ?? "");
    if (a.parentId) fd.set("parentId", a.parentId);
    const r = await sendMessage(fd);
    return r.ok ? { ok: true, message: "Réponse envoyée.", link: `/messages?c=${a.conversationId}` } : { ok: false, error: r.error ?? "Envoi refusé." };
  },
};

/** Les conversations DE LA PERSONNE (membre, pas partie) dont le titre ou un membre correspond. */
export async function convsDe(user: CurrentUser, q: string): Promise<{ id: string; libelle: string }[]> {
  const mesConvs = await prisma.conversationMember.findMany({
    where: { userId: user.id, leftAt: null },
    select: { conversation: { select: { id: true, title: true, members: { where: { leftAt: null, userId: { not: user.id } }, select: { user: { select: { name: true } } }, take: 8 } } } },
    take: 200,
  });
  const k = replier(q);
  return mesConvs
    .map((m) => ({ id: m.conversation.id, libelle: m.conversation.title || m.conversation.members.map((x) => x.user.name).join(", ") || "Conversation" }))
    .filter((c) => replier(c.libelle).includes(k));
}
